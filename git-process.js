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

function record() {
  return { stdout: collector(), stderr: collector(), exit: null };
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
    if (!early.has(id)) early.set(id, record());
    apply(early.get(id), kind, event);
  }
}

function apply(output, kind, event) {
  if (kind === 'exit') output.exit = event;
  else (event.stream === 'stderr' ? output.stderr : output.stdout).append(event.data);
}

async function run(params) {
  if (typeof hecaton.process.spawn !== 'function' || typeof hecaton.on !== 'function') {
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
  starting.add(early);
  const startedAt = Date.now();
  const cmd = timing.gitCommandOf(params && params.args);
  let spawned;
  try {
    // Mutations have no wall-clock deadline. Even silent filters/hooks can be
    // doing useful work; only a real exit event releases the caller's write gate.
    const { timeout_ms, ...spawnParams } = params;
    spawned = await perms.spawnGit(withoutAutoMaintenance(spawnParams));
  } finally {
    starting.delete(early);
  }
  const spawnMs = Date.now() - startedAt;
  if (!spawned || !spawned.ok || spawned.error || spawned.error_code || spawned.__rpcError) {
    timing.record('git', { via: 'spawn', cmd, spawnMs, ms: spawnMs, failed: 'spawn' });
    return spawned;
  }
  if (spawned.process_id === undefined || spawned.process_id === null) {
    return { ok: false, error: t('git.processMissingId') };
  }
  const id = spawned.process_id;
  const output = early.get(id) || record();
  return new Promise(resolve => {
    let settled = false;
    const finish = event => {
      if (settled) return;
      settled = true;
      jobs.delete(id);
      completedWrites++;
      const code = event.exit_code;
      timing.record('git', { via: 'spawn', cmd, spawnMs, ms: Date.now() - startedAt, exit: code });
      resolve({
        ...event,
        timed_out: !!event.timed_out,
        ok: event.ok !== false && !event.timed_out && !event.cancelled && typeof code === 'number',
        error: event.error || (event.timed_out ? t('git.processTimedOut')
            : event.cancelled ? t('git.processCancelled')
              : typeof code !== 'number' ? t('git.processMissingExit') : undefined),
        stdout: output.stdout.text(), stderr: output.stderr.text(),
      });
    };
    jobs.set(id, { output, finish });
    if (output.exit) { finish(output.exit); return; }
  });
}

module.exports = { run, NO_AUTO_MAINTENANCE, completedWrites: () => completedWrites };
