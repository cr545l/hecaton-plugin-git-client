// 폴링용으로 스폰한 git 프로세스가 부모가 사라진 뒤에도 남는 경우가 있다.
// 하나하나는 유휴 상태지만 며칠 단위로 쌓이면 핸들과 메모리를 계속 물고 있고,
// .git 을 열어둔 채 남으면 뒤따르는 git 명령과 경합한다.
//
// 호스트에 프로세스 종료 API는 없지만 exec로 taskkill을 부를 수 있다
// (process-monitor 플러그인이 쓰는 방식과 같다).
//
// 남의 프로세스를 죽이는 일이라 판별을 좁게 잡는다:
//   1. 우리가 폴링에서만 쓰는 인자 조합과 명령줄 전체가 일치할 것
//   2. 정상 폴링이라면 이미 끝났을 만큼 오래됐을 것 (exec 타임아웃은 5초다)
//   3. 생성 시각을 못 읽으면 건드리지 않을 것 — 나이를 모르면 판단도 없다
// 조건 하나라도 못 맞추면 그냥 두고 넘어간다. 정리는 어디까지나 덤이고,
// 살아 있는 남의 git을 죽이는 쪽이 훨씬 비싼 실수다.

// 정상 폴링은 exec 타임아웃(5초) 안에 끝난다. 이 나이를 넘겼다면 회수되지 못한 것이다.
const MIN_AGE_MS = 5 * 60 * 1000;
// 한 번에 정리할 상한. 판별이 잘못됐을 때 피해를 제한한다.
const MAX_KILLS = 50;
// 여러 인스턴스가 같이 뜰 때 매번 PowerShell을 스폰하지 않도록 하는 간격.
const REAP_INTERVAL_MS = 30 * 60 * 1000;

// main.js의 buildWorktreeSnapshot이 스폰하는 두 명령. 인자 전체로 판별해,
// 다른 git 클라이언트가 우연히 같은 명령줄을 쓸 여지를 없앤다.
// (참고: `status --porcelain=v2` 같은 명령은 이 플러그인이 쓰지 않는다 —
//  같은 이름이어도 남의 프로세스이므로 대상에 넣지 않는다.)
const POLL_COMMAND_PATTERNS = [
  /--no-optional-locks\s+diff-files\s+--name-only\s+-z\s*$/,
  /--no-optional-locks\s+ls-files\s+--others\s+--directory\s+--no-empty-directory\s+-z\s+--exclude-standard\s*$/,
];

const LIST_SCRIPT =
  "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | " +
  "Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";

function isWindows() {
  return typeof process !== 'undefined' && process.platform === 'win32';
}

function looksLikePollCommand(commandLine) {
  const line = String(commandLine || '').trim();
  if (!line) return false;
  return POLL_COMMAND_PATTERNS.some(re => re.test(line));
}

// CIM이 주는 생성 시각은 환경에 따라 ISO 문자열로도, /Date(…)/ 형태로도 온다.
// 어느 쪽으로도 못 읽으면 null을 돌려 호출부가 건너뛰게 한다.
function parseCreationDate(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const text = String(value);
  const epoch = text.match(/\/Date\((\d+)\)\//);
  if (epoch) {
    const ms = parseInt(epoch[1], 10);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function toArray(parsed) {
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

// 목록에서 정리 대상 PID만 추린다. 판별 로직을 순수 함수로 떼어 테스트한다.
function selectOrphans(entries, nowMs) {
  const targets = [];
  for (const entry of toArray(entries)) {
    if (!entry) continue;
    const pid = Number(entry.ProcessId);
    // pid 0/4는 시스템 프로세스다. git.exe로 잡힐 리 없지만 방어해 둔다.
    if (!Number.isInteger(pid) || pid <= 4) continue;
    if (!looksLikePollCommand(entry.CommandLine)) continue;
    const created = parseCreationDate(entry.CreationDate);
    if (created === null) continue;
    const age = nowMs - created;
    // 미래 시각(시계 역행)도 나이를 신뢰할 수 없는 경우로 본다.
    if (age < MIN_AGE_MS) continue;
    targets.push(pid);
    if (targets.length >= MAX_KILLS) break;
  }
  return targets;
}

// 회수되지 못한 폴링 프로세스를 정리한다. 정리한 개수를 돌려준다.
// 어떤 단계가 실패하든 조용히 0을 반환한다 — 실패해도 잃는 게 없는 작업이다.
async function reapOrphanedPollProcesses(coordinate) {
  if (!isWindows()) return 0;

  // 같은 머신의 다른 인스턴스가 최근에 돌렸으면 건너뛴다. PowerShell 스폰이
  // 인스턴스 수만큼 겹치는 것을 막는 정도의 의미다.
  if (coordinate) {
    try {
      const recent = await coordinate.readSharedSnapshot('reap', REAP_INTERVAL_MS);
      if (recent) return 0;
      await coordinate.publishSharedSnapshot('reap', 1);
    } catch { /* 조율 실패는 무시하고 그냥 진행한다 */ }
  }

  let listed;
  try {
    listed = await hecaton.process.exec({
      program: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT],
      timeout_ms: 15000,
    });
  } catch { return 0; }
  if (!listed || !listed.ok || !listed.stdout) return 0;

  let parsed;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch { return 0; }

  const targets = selectOrphans(parsed, Date.now());
  if (targets.length === 0) return 0;

  // taskkill은 /PID를 여러 번 받는다. 한 번의 스폰으로 끝낸다.
  const args = [];
  for (const pid of targets) args.push('/PID', String(pid));
  args.push('/F');
  try {
    await hecaton.process.exec({ program: 'taskkill', args, timeout_ms: 10000 });
  } catch { return 0; }

  console.log('[git-client] reaped ' + targets.length + ' orphaned poll process(es)');
  return targets.length;
}

module.exports = {
  reapOrphanedPollProcesses,
  // 테스트용 노출
  selectOrphans,
  looksLikePollCommand,
  parseCreationDate,
  MIN_AGE_MS,
  MAX_KILLS,
};
