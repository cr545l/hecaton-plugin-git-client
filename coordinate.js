// 같은 저장소를 여러 인스턴스가 동시에 열었을 때 중복 git 실행을 없애는 공유 계층.
//
// 인스턴스마다 2~3초 주기로 폴링을 돌리면 git 프로세스 스폰(Windows에서 60ms 남짓)과
// .git 락 경합이 인스턴스 수만큼 곱해진다. 폴링 결과와 네트워크 작업 진행 상태를
// .git 아래 공유 파일로 주고받아, 실제 git 실행은 한 인스턴스만 하고 나머지는 그
// 결과를 읽는다.
//
// 모든 동작은 best-effort다. 공유 파일을 못 읽거나 못 쓰면 각 인스턴스가 종전대로
// 자기 git을 돌린다 — 느려질 뿐 결과가 틀리지는 않는다.
//
// 그래서 폴링 스냅샷 쪽에는 락도 선점도 두지 않았다. 폴링 타이머가 겹쳐 두 인스턴스가
// 같은 틱에 실행해봐야 최적화 이전과 같을 뿐이고, 다음 틱부터는 먼저 publish한 쪽으로
// 자연히 수렴한다. 반면 네트워크 작업은 겹치면 실제로 서로를 느리게 만들기 때문에
// 진행 상태를 명시적으로 기록해 조율한다.

const nodePath = require('path');

const SHARE_DIR_NAME = 'hecaton-git-client';

// 이 프로세스를 식별한다. pid만으로는 재사용된 pid와 충돌할 수 있어 난수를 덧붙인다.
const INSTANCE_ID = (function () {
  const pid = (typeof process !== 'undefined' && process.pid) ? process.pid : 0;
  return String(pid) + '-' + Math.random().toString(36).slice(2, 8);
})();

let _shareDir = '';       // 공유 파일 디렉터리 (빈 문자열이면 조율 비활성)
let _cwdKey = '';         // 워크트리 구분용 키 — 같은 저장소라도 워크트리가 다르면 스냅샷은 공유 불가
let _dirReady = false;    // mkdir 완료 여부

// 로컬 인스턴스가 네트워크 작업 중인지. 공유 파일을 읽지 않고도 판정할 수 있는
// 빠른 경로 — 자기 자신이 fetch/pull/push 중이면 폴링을 돌릴 이유가 없다.
let _localNetworkOp = null;

function hashKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// gitCommonDir 기준이라 linked worktree들도 같은 디렉터리를 공유한다. 네트워크 작업은
// 저장소 전체에 영향을 주므로 이 단위가 맞고, 워크트리별로 갈라야 하는 스냅샷은
// _cwdKey를 파일명에 섞어 분리한다.
function configure(gitCommonDir, cwd) {
  const common = String(gitCommonDir || '').trim();
  if (!common) { _shareDir = ''; _dirReady = false; return; }
  const next = nodePath.join(common, SHARE_DIR_NAME);
  if (next !== _shareDir) _dirReady = false;
  _shareDir = next;
  _cwdKey = hashKey(normalizePath(cwd));
}

function isEnabled() {
  return !!_shareDir && !!hecaton && !!hecaton.fs;
}

async function ensureDir() {
  if (_dirReady || !isEnabled()) return _dirReady;
  try {
    await hecaton.fs.mkdir({ path: _shareDir, recursive: true });
    _dirReady = true;
  } catch { _dirReady = false; }
  return _dirReady;
}

// kind는 파일명이 되므로 호출부가 넘기는 짧은 식별자만 허용한다.
function sharedPath(kind, perWorktree) {
  const name = perWorktree ? (kind + '-' + _cwdKey + '.json') : (kind + '.json');
  return nodePath.join(_shareDir, name);
}

async function readJson(path) {
  try {
    const res = await hecaton.fs.read_file({ path });
    const content = typeof res === 'string' ? res : (res && res.content) ? res.content : '';
    if (!content) return null;
    // 다른 인스턴스가 쓰는 도중이면 잘린 JSON을 읽을 수 있다. 파싱 실패는 그냥 미스로 친다.
    return JSON.parse(content);
  } catch { return null; }
}

async function writeJson(path, value) {
  try {
    await hecaton.fs.write_file({ path, content: JSON.stringify(value) });
    return true;
  } catch { return false; }
}

// 다른 인스턴스가 maxAgeMs 안에 올려둔 폴링 결과가 있으면 그대로 쓴다.
// 반환값이 null이면 호출부가 직접 git을 돌려야 한다는 뜻이다.
async function readSharedSnapshot(kind, maxAgeMs) {
  if (!isEnabled() || !await ensureDir()) return null;
  const data = await readJson(sharedPath(kind, true));
  if (!data || typeof data.publishedAt !== 'number') return null;
  const age = Date.now() - data.publishedAt;
  // 시계 역행이나 남의 저장소에서 복사된 파일 같은 이상값은 신선한 것으로 오인하지 않는다.
  if (age < 0 || age > maxAgeMs) return null;
  if (data.value === undefined) return null;
  return { value: data.value, ageMs: age, owner: data.owner || '' };
}

async function publishSharedSnapshot(kind, value) {
  if (!isEnabled() || !await ensureDir()) return false;
  return await writeJson(sharedPath(kind, true), {
    publishedAt: Date.now(),
    owner: INSTANCE_ID,
    value,
  });
}

// ── 네트워크 작업(fetch/pull/push) 조율 ──────────────────────────────────────
//
// 같은 저장소에 두 인스턴스가 동시에 fetch를 걸면 .git 락을 서로 기다리느라 둘 다
// 느려진다. 진행 중인 작업이 있으면 새로 걸지 않고 그 결과를 기다린 뒤 화면만
// 갱신하는 편이 빠르다.

const NETOP_KIND = 'netop';
// 인스턴스가 비정상 종료하면 finishedAt이 영영 안 찍힌다. 이 시간을 넘긴 inflight는
// 죽은 것으로 보고 무시한다 — git 쪽 타임아웃(30초)보다 넉넉하게 잡는다.
const NETOP_STALE_MS = 45000;

async function readNetOp() {
  if (!isEnabled() || !await ensureDir()) return null;
  return await readJson(sharedPath(NETOP_KIND, false));
}

// 다른 인스턴스가 지금 네트워크 작업 중인지. 기다릴 대상이 있는지 판정한다.
// 내 기록은 제외해야 한다 — 내 대기 플래그까지 세면 자기 자신을 기다리다 타임아웃한다.
async function isRemoteNetworkOpInFlight() {
  const data = await readNetOp();
  if (!data || typeof data.startedAt !== 'number') return false;
  if (data.owner === INSTANCE_ID) return false;
  if (data.finishedAt && data.finishedAt >= data.startedAt) return false;
  return (Date.now() - data.startedAt) < NETOP_STALE_MS;
}

// 이 저장소에서 네트워크 작업이 도는 중인지. 폴링 억제 판단에 쓴다.
// 남의 작업뿐 아니라 내가 실행/대기 중인 경우도 폴링을 멈춰야 하므로 로컬 플래그를 함께 본다.
async function isNetworkOpInFlight() {
  if (_localNetworkOp) return true;
  return await isRemoteNetworkOpInFlight();
}

// 네트워크 작업을 시작해도 되는지 판정한다.
//   'run'      — 내가 실행한다 (시작을 공유 파일에 기록)
//   'inflight' — 다른 인스턴스가 같은 작업을 하는 중이다. 기다렸다 새로고침만 하면 된다.
//   'reuse'    — 방금 다른 인스턴스가 끝냈다. 다시 돌릴 필요가 없다.
// reuseWindowMs를 0으로 주면 'reuse' 판정을 하지 않는다(pull/push처럼 결과를 남이
// 대신 내줄 수 없는 작업용).
async function beginNetworkOp(op, reuseWindowMs) {
  _localNetworkOp = op;
  if (!isEnabled() || !await ensureDir()) return 'run';
  const data = await readNetOp();
  const now = Date.now();
  if (data && typeof data.startedAt === 'number') {
    const running = (!data.finishedAt || data.finishedAt < data.startedAt)
      && (now - data.startedAt) < NETOP_STALE_MS
      && data.owner !== INSTANCE_ID;
    if (running) return 'inflight';
    const reusable = reuseWindowMs > 0
      && data.op === op
      && data.ok === true
      && typeof data.finishedAt === 'number'
      && (now - data.finishedAt) >= 0
      && (now - data.finishedAt) < reuseWindowMs;
    if (reusable) return 'reuse';
  }
  await writeJson(sharedPath(NETOP_KIND, false), {
    op, owner: INSTANCE_ID, startedAt: now, finishedAt: 0, ok: false,
  });
  return 'run';
}

// 남의 진행 기록을 밀어내고 내 작업으로 표시한다. 기다려도 끝나지 않아 직접
// 실행하기로 한 경우에만 쓴다 — 그냥 실행하면 내 작업이 아무 기록 없이 돌아가고,
// 다른 인스턴스는 그 사이 같은 작업을 또 걸게 된다.
async function claimNetworkOp(op) {
  _localNetworkOp = op;
  if (!isEnabled() || !await ensureDir()) return;
  await writeJson(sharedPath(NETOP_KIND, false), {
    op, owner: INSTANCE_ID, startedAt: Date.now(), finishedAt: 0, ok: false,
  });
}

async function endNetworkOp(op, ok) {
  _localNetworkOp = null;
  if (!isEnabled() || !_dirReady) return;
  const data = await readNetOp();
  // 내가 시작한 기록일 때만 닫는다. 남의 작업 기록을 덮으면 그쪽이 inflight 판정을 잃는다.
  if (!data || data.owner !== INSTANCE_ID) return;
  data.op = op;
  data.finishedAt = Date.now();
  data.ok = !!ok;
  await writeJson(sharedPath(NETOP_KIND, false), data);
}

// 진행 중인 남의 작업이 끝날 때까지 기다린다. 끝났으면 true.
async function waitForNetworkOp(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    if (!await isRemoteNetworkOpInFlight()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

module.exports = {
  INSTANCE_ID,
  configure,
  isEnabled,
  readSharedSnapshot,
  publishSharedSnapshot,
  beginNetworkOp,
  claimNetworkOp,
  endNetworkOp,
  isNetworkOpInFlight,
  waitForNetworkOp,
};
