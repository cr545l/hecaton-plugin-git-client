// Long Git operations must not occupy process.exec's synchronous host RPC.
// spawn returns immediately; output and completion arrive through host events.
const perms = require('./permissions');
const timing = require('./timing');
const { t } = require('./i18n');

const jobs = new Map();
const starting = new Set();
let subscribed = false;
// 끝난 쓰기 명령의 수. 이보다 먼저 시작한 status 결과는 그 쓰기 이전의 저장소일 수 있다 —
// refresh.js 는 그런 결과를 적용하지 않고 다시 조회한다.
let completedWrites = 0;

// Git 은 commit·fetch·pull·merge·rebase·cherry-pick 끝에 자동 정리(maintenance run
// --auto, 옛 git 은 gc --auto)를 붙인다. 정리가 필요하다고 판단되면 Windows 의 git 은
// 이를 떼어 내지 못하고, 원래 명령이 정리가 끝날 때까지 돌아오지 않는다(관측: 로컬
// 원격으로의 push 가 받는 쪽 정리 77초를 기다렸고, 정리가 밀린 저장소 사본에서 커밋
// 한 번이 139초였다 — 같은 상태의 다른 사본에서는 정리가 돌지 않아 0.2초였다). 그동안
// 이 작업은 인덱스와 ref 를 쥐고 있어 스테이징·푸시까지 막는다. 사용자 동작 안에서는
// 정리를 돌리지 않는다. 쓰기 명령 경로에만 붙인다 — 읽기 명령은 자동 정리를 부르지 않는다.
const NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

function withoutAutoMaintenance(params) {
  if (!params || params.program !== 'git' || !Array.isArray(params.args)) return params;
  return { ...params, args: [...NO_AUTO_MAINTENANCE, ...params.args] };
}

function collector() {
  let head = '', tail = '', reasons = '', partial = '';
  return {
    append(value) {
      const text = String(value || '');
      head = (head + text).slice(0, 16384);
      tail = (tail + text).slice(-65536);
      const lines = (partial + text).split(/\r\n?|\n/);
      partial = lines.pop().slice(-4096);
      for (const line of lines) {
        if (/^(?:remote:\s*)?(?:error:|fatal:)/i.test(line)
          || /^warning:.*\b(?:filename|file name|path|pathname) (?:is )?too long\b/i.test(line)) {
          reasons = (reasons + line + '\n').slice(0, 16384);
        }
      }
    },
    text() {
      return head.length < 16384 ? head : reasons + head + '\n…\n' + tail;
    },
  };
}

// 읽기 명령의 stdout 은 그 자체가 결과다(log 6000건이 900KB 가까이 된다). 앞뒤만 남기는
// collector 로 받으면 가운데가 잘려 나가므로 전부 모은다. stderr 는 진단용이라 그대로 묶는다.
function fullCollector() {
  const parts = [];
  return {
    append(value) { parts.push(String(value || '')); },
    text() { return parts.join(''); },
  };
}

function record(full) {
  return { stdout: full ? fullCollector() : collector(), stderr: collector(), exit: null };
}

function receive(kind, event) {
  if (!event || event.process_id === undefined) return;
  const id = event.process_id;
  const job = jobs.get(id);
  if (job) {
    apply(job.output, kind, event);
    if (kind === 'exit') job.finish(event);
    return;
  }
  // A very short process can exit before the spawn response is delivered.
  // Keep only bounded output, only while a spawn response is outstanding.
  for (const early of starting) {
    if (!early.has(id) && early.size >= 32) continue;
    if (!early.has(id)) early.set(id, record(early.full));
    apply(early.get(id), kind, event);
  }
}

function canStream() {
  return typeof hecaton.process.spawn === 'function' && typeof hecaton.on === 'function';
}

function apply(output, kind, event) {
  if (kind === 'exit') output.exit = event;
  else (event.stream === 'stderr' ? output.stderr : output.stdout).append(event.data);
}

// 쓰기와 읽기가 같은 스트리밍 경로를 쓴다. 둘 다 벽시계 마감이 없다 — 끝은 실제 종료
// 이벤트뿐이다. 다른 점은 셋이다:
//   쓰기  자동 정리를 끄고, 끝나면 completedWrites 를 올리고, 중단 수단을 내주지 않는다
//         (인덱스·워크트리 갱신 도중에 죽이면 반쯤 쓰인 상태가 남는다).
//   읽기  stdout 을 전부 모으고, cancel() 로 중단할 수 있다. 읽기는 죽여도 남는 것이 없다.
function start(params, opts) {
  const write = !opts || opts.write !== false;
  const full = !!(opts && opts.full);
  const via = write ? 'spawn' : 'spawn-read';
  const startedAt = Date.now();
  const cmd = timing.gitCommandOf(params && params.args);
  let processId = null;
  let cancelled = false;
  let settle = null;

  const kill = () => {
    if (processId === null || typeof hecaton.process.kill !== 'function') return;
    try {
      Promise.resolve(hecaton.process.kill({ process_id: processId })).catch(() => null);
    } catch { /* 종료 요청 실패는 무시한다 — 프로세스는 제 속도로 끝난다 */ }
  };

  const promise = (async () => {
    if (!canStream()) {
      // Never fall back to exec: older hosts cap its wait and kill the process,
      // potentially interrupting an index/worktree update halfway through.
      return { ok: false, error: t('git.streamingRequired') };
    }
    if (!subscribed) {
      hecaton.on('process_output', event => receive('output', event));
      hecaton.on('process_exited', event => receive('exit', event));
      subscribed = true;
    }
    const early = new Map();
    early.full = full;
    starting.add(early);
    let spawned;
    try {
      // No wall-clock deadline. Even silent filters/hooks can be doing useful
      // work; only a real exit event releases the caller's write gate.
      const { timeout_ms, ...spawnParams } = params;
      spawned = await perms.spawnGit(write ? withoutAutoMaintenance(spawnParams) : spawnParams);
    } finally {
      starting.delete(early);
    }
    const spawnMs = Date.now() - startedAt;
    if (!spawned || !spawned.ok || spawned.error || spawned.error_code || spawned.__rpcError) {
      timing.record('git', { via, cmd, spawnMs, ms: spawnMs, failed: 'spawn' });
      return spawned;
    }
    if (spawned.process_id === undefined || spawned.process_id === null) {
      return { ok: false, error: t('git.processMissingId') };
    }
    const id = spawned.process_id;
    processId = id;
    const output = early.get(id) || record(full);
    return new Promise(resolve => {
      let settled = false;
      const finish = event => {
        // 중단된 읽기는 이미 호출자에게 돌려줬다. 뒤늦게 온 종료 이벤트는 등록만 지운다.
        jobs.delete(id);
        if (settled) return;
        settled = true;
        if (write) completedWrites++;
        const code = event.exit_code;
        const wasCancelled = cancelled || !!event.cancelled;
        timing.record('git', {
          via, cmd, spawnMs, ms: Date.now() - startedAt, exit: code,
          ...(wasCancelled ? { cancelled: true } : {}),
        });
        resolve({
          ...event,
          timed_out: !!event.timed_out,
          cancelled: wasCancelled,
          ok: event.ok !== false && !event.timed_out && !wasCancelled && typeof code === 'number',
          error: event.error || (event.timed_out ? t('git.processTimedOut')
              : wasCancelled ? t('git.processCancelled')
                : typeof code !== 'number' ? t('git.processMissingExit') : undefined),
          stdout: output.stdout.text(), stderr: output.stderr.text(),
        });
      };
      // 읽기 중단은 종료 이벤트를 기다리지 않고 곧바로 돌려준다 — 죽이는 요청이 늦거나
      // 이벤트가 오지 않아도 화면이 "불러오는 중"에 묶이지 않는다.
      settle = () => {
        if (settled) return;
        settled = true;
        timing.record('git', { via, cmd, spawnMs, ms: Date.now() - startedAt, exit: null, cancelled: true });
        resolve({
          ok: false, cancelled: true, timed_out: false, exit_code: null,
          error: t('git.processCancelled'), stdout: '', stderr: output.stderr.text(),
        });
      };
      jobs.set(id, { output, finish });
      if (output.exit) { finish(output.exit); return; }
      // spawn 응답을 기다리는 사이에 중단이 들어왔다.
      if (cancelled) { kill(); settle(); }
    });
  })();

  return {
    promise,
    startedAt,
    cancel() {
      if (write || cancelled) return;
      cancelled = true;
      kill();
      if (settle) settle();
    },
  };
}

function run(params) {
  return start(params, { write: true }).promise;
}

// 마감 없는 읽기. { promise, cancel, startedAt } 를 돌려준다 — promise 는 exec 와 같은
// 모양의 결과로 풀리고, 중단되면 { ok: false, cancelled: true } 다.
function startRead(params) {
  return start(params, { write: false, full: true });
}

// ── 읽기 실행의 단일 창구 ──
//
// 예전에는 읽기마다 process.exec + timeout_ms(기본 5초)였다. 그 마감은 느린 조회를 빠르게
// 하지 못하고 한 일을 버리기만 했다(2026-11-10 실측: git 호출의 48%가 마감에 죽었고, 죽은
// 조회는 다음 갱신 때 처음부터 다시 돌았다). 마감은 호스트 큐에서 기다린 시간까지 셌다.
// 여기서는 끝날 때까지 두고, 대신 세 가지로 쌓임과 답답함을 막는다:
//   합치기  같은 저장소·같은 인자의 조회가 이미 돌고 있으면 그 결과를 함께 쓴다. 폴링이
//           아무리 겹쳐도 같은 git 이 두 개 뜨지 않는다. 단, 그 조회가 시작된 뒤 쓰기가
//           끝났으면 합치지 않는다 — 쓰기 이전의 저장소를 읽었을 수 있다.
//   보이기  inflightReads() 로 가장 오래된 조회의 시작 시각을 내준다(타이틀의 경과 시간).
//   끊기    cancelReads() 로 실제 프로세스를 끝낸다. 끊긴 조회는 { ok:false, cancelled:true }.
// 스트리밍을 못 쓰는 호스트에서는 종전의 exec(호출부가 준 timeout_ms)로 내려간다 — 읽기는
// 도중에 끊겨도 남는 것이 없어 쓰기와 달리 폴백이 안전하다.
const reads = new Map();
// 스트리밍 출력은 조각으로 온다. 호스트가 멀티바이트 문자를 조각 경계에서 자른다면 U+FFFD 가
// 섞여 들어온다. 그 문자가 보이면 exec 로 한 번 더 읽어 견준다: 같으면 원래 파일에 있던
// 문자다(몇 번 확인되면 더 견주지 않는다). 다르면 스트리밍이 글자를 깨뜨린 것이므로 이
// 세션의 읽기를 exec 로 되돌린다 — 깨진 커밋 제목을 보여 주느니 예전 방식이 낫다.
let streamReads = true;
let replacementCharChecks = 3;

function readKey(params) {
  return String(params.cwd || '') + '\u0000' + (Array.isArray(params.args) ? params.args.join('\u0000') : '');
}

async function verifyStreamed(params, result) {
  if (replacementCharChecks <= 0 || !result || !result.ok
      || typeof result.stdout !== 'string' || !result.stdout.includes('�')) return result;
  let viaExec = null;
  try {
    viaExec = await perms.execGit({ ...params, timeout_ms: Math.max(params.timeout_ms || 0, 120000) });
  } catch { return result; }
  if (!viaExec || !viaExec.ok || typeof viaExec.stdout !== 'string') return result;
  if (viaExec.stdout === result.stdout) {
    replacementCharChecks--;
    return result;
  }
  streamReads = false;
  timing.record('read-stream-disabled', { cmd: timing.gitCommandOf(params.args) });
  return viaExec;
}

function readJob(params) {
  if (!streamReads || !canStream()) {
    return { promise: perms.execGit(params), cancel() {}, startedAt: Date.now() };
  }
  const key = readKey(params);
  const existing = reads.get(key);
  if (existing && existing.writesAt === completedWrites) return existing;
  const job = start(params, { write: false, full: true });
  const entry = { startedAt: job.startedAt, cancel: job.cancel, writesAt: completedWrites };
  entry.promise = job.promise.then(result => {
    // spawn 자체가 실패했으면(호스트 오류) 조회를 포기하지 않고 exec 로 한 번 읽는다.
    // 권한 거부는 다시 물어도 같으므로 그대로 돌려준다.
    const spawnFailed = result && !result.cancelled && result.exit_code === undefined
      && result.error_code !== 'access_denied' && (result.ok === false || result.__rpcError);
    return spawnFailed ? perms.execGit(params) : verifyStreamed(params, result);
  }).finally(() => {
    if (reads.get(key) === entry) reads.delete(key);
  });
  reads.set(key, entry);
  return entry;
}

// exec 와 같은 모양의 결과로 풀리는 마감 없는 읽기.
function read(params) {
  return readJob(params).promise;
}

function inflightReads() {
  let oldest = 0;
  for (const entry of reads.values()) {
    if (!oldest || entry.startedAt < oldest) oldest = entry.startedAt;
  }
  return { count: reads.size, oldestStartedAt: oldest };
}

// minAgeMs 보다 오래 돌고 있는 읽기를 끝낸다. 끝낸 개수를 돌려준다.
function cancelReads(minAgeMs) {
  const now = Date.now();
  let cancelled = 0;
  for (const entry of Array.from(reads.values())) {
    if (now - entry.startedAt < (minAgeMs || 0)) continue;
    entry.cancel();
    cancelled++;
  }
  return cancelled;
}

module.exports = {
  run, startRead, read, readJob, inflightReads, cancelReads, canStream,
  NO_AUTO_MAINTENANCE, completedWrites: () => completedWrites,
};
