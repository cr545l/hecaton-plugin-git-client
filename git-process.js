// Long Git operations must not occupy process.exec's synchronous host RPC.
// spawn returns immediately; output and completion arrive through host events.
const perms = require('./permissions');
const { t } = require('./i18n');

const NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
const jobs = new Map();
const starting = new Set();
let subscribed = false;

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
        if (/^(?:remote:\s*)?(?:error:|fatal:)/i.test(line)) {
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
    return perms.execGit(params);
  }
  if (!subscribed) {
    hecaton.on('process_output', event => receive('output', event));
    hecaton.on('process_exited', event => receive('exit', event));
    subscribed = true;
  }
  const early = new Map();
  starting.add(early);
  let spawned;
  try {
    // Enforce the operation deadline here, rather than the host's exec ceiling.
    const { timeout_ms, ...spawnParams } = params;
    spawned = await perms.spawnGit(spawnParams);
  } finally {
    starting.delete(early);
  }
  if (!spawned || !spawned.ok || spawned.error || spawned.error_code || spawned.__rpcError) return spawned;
  if (spawned.process_id === undefined || spawned.process_id === null) {
    return { ok: false, error: t('git.processMissingId') };
  }
  const id = spawned.process_id;
  const output = early.get(id) || record();
  return new Promise(resolve => {
    let deadline, cleanupDeadline, timedOut = false, settled = false;
    const finish = event => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      jobs.delete(id);
      const code = event.exit_code;
      resolve({
        ...event,
        timed_out: timedOut || !!event.timed_out,
        timeout_ms: timedOut ? params.timeout_ms : event.timeout_ms,
        ok: event.ok !== false && !timedOut && !event.timed_out && !event.cancelled && typeof code === 'number',
        error: timedOut ? t('git.processDeadline', { seconds: params.timeout_ms / 1000 })
          : event.error || (event.timed_out ? t('git.processTimedOut')
            : event.cancelled ? t('git.processCancelled')
              : typeof code !== 'number' ? t('git.processMissingExit') : undefined),
        stdout: output.stdout.text(), stderr: output.stderr.text(),
      });
    };
    jobs.set(id, { output, finish });
    if (output.exit) { finish(output.exit); return; }
    deadline = setTimeout(() => {
      timedOut = true;
      // Kill only this job through the host (including its child processes).
      // Keep waiting for the exit notification; a lost notification must not
      // leave the spinner or network coordination record stuck forever.
      cleanupDeadline = setTimeout(() => finish({}), 10000);
      Promise.resolve().then(() => hecaton.process.kill({ process_id: id }))
        .catch(() => {});
    }, params.timeout_ms);
  });
}

module.exports = { run, NETWORK_TIMEOUT_MS };
