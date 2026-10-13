const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
const calls = [];
let spawn, kill, exec, nextId = 1;
const emit = (name, event) => handlers.get(name)(event);
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
global.hecaton = {
  on: (name, handler) => handlers.set(name, handler),
  process: {
    spawn: params => { calls.push(params); return spawn(params); },
    kill: params => kill(params),
    exec: params => exec(params),
  },
};
const perms = require('../permissions');
const runner = require('../git-process');
const git = require('../git');
const coordinate = require('../coordinate');
require('../spinner').showToast = () => {};
const params = () => ({ program: 'git', args: ['push'], cwd: 'C:/repo', timeout_ms: runner.NETWORK_TIMEOUT_MS });

test.beforeEach(() => {
  calls.length = 0;
  perms.reset();
  delete hecaton.permissions;
  coordinate.configure('', '');
  spawn = async () => ({ ok: true, process_id: nextId++ });
  kill = async ({ process_id }) => {
    emit('process_exited', { process_id, exit_code: 1, cancelled: true });
    return { ok: true };
  };
  exec = () => { throw new Error('long operation must not use process.exec'); };
});

test('captures output and exit delivered before spawn response', async () => {
  spawn = async () => {
    emit('process_output', { process_id: 42, stream: 'stderr', data: 'remote: error: rejected\n' });
    emit('process_exited', { process_id: 42, exit_code: 1 });
    return { ok: true, process_id: 42 };
  };
  const result = await runner.run(params());
  assert.equal(result.exit_code, 1);
  assert.match(result.stderr, /rejected/);
  assert.equal(calls[0].timeout_ms, undefined);
});

test('Git push uses streaming and waits past both 60 and 120 seconds for exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = nextId;
  let settled = false;
  const pending = git.gitPushAsync('C:/repo').then(value => { settled = true; return value; });
  await flush();
  t.mock.timers.tick(121000);
  await flush();
  assert.equal(settled, false);
  assert.equal(await coordinate.isNetworkOpInFlight(), true);
  emit('process_output', { process_id: id, stream: 'stderr', data: 'remote: error: hook rejected the push\n' });
  emit('process_exited', { process_id: id, exit_code: 1 });
  assert.match(await pending, /hook rejected the push/);
  assert.equal(await coordinate.isNetworkOpInFlight(), false);
});

test('concurrent jobs keep their own output and early exit', async () => {
  let respond;
  spawn = () => new Promise(resolve => { respond = resolve; });
  const first = runner.run(params());
  await flush();
  emit('process_output', { process_id: 'a', stream: 'stdout', data: 'first' });
  const respondFirst = respond;
  const second = runner.run(params());
  await flush();
  emit('process_output', { process_id: 'b', stream: 'stderr', data: 'second' });
  emit('process_exited', { process_id: 'b', exit_code: 0 });
  respond({ ok: true, process_id: 'b' });
  respondFirst({ ok: true, process_id: 'a' });
  await flush();
  emit('process_exited', { process_id: 'a', exit_code: 0 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.stdout, 'first');
  assert.equal(a.stderr, '');
  assert.equal(b.stdout, '');
  assert.equal(b.stderr, 'second');
});

test('deadline kills only the owned process, waits for exit, and reports actual time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = nextId;
  let killed;
  kill = async p => { killed = p; return { ok: true }; };
  let settled = false;
  const pending = runner.run({ ...params(), timeout_ms: 125000 }).then(r => { settled = true; return r; });
  await flush();
  t.mock.timers.tick(125000);
  await flush();
  assert.deepEqual(killed, { process_id: id });
  assert.equal(settled, false);
  emit('process_exited', { process_id: id, exit_code: 1, cancelled: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.timeout_ms, 125000);
});

test('missing exit event after deadline releases the caller even when kill rejects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  kill = async () => { throw new Error('RPC disconnected'); };
  const pending = runner.run({ ...params(), timeout_ms: 125000 });
  await flush();
  t.mock.timers.tick(125000);
  await flush();
  t.mock.timers.tick(10000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
});

test('bounded logs retain server errors split across output chunks', async () => {
  spawn = async () => {
    const id = nextId++;
    for (const data of ['writing\r'.repeat(30000), 'remote: er', 'ror: FirebaseCppApp.bundle exceeds limit\n', 'log\n'.repeat(30000)]) {
      emit('process_output', { process_id: id, stream: 'stderr', data });
    }
    emit('process_exited', { process_id: id, exit_code: 1 });
    return { ok: true, process_id: id };
  };
  const result = await runner.run(params());
  assert.match(result.stderr, /FirebaseCppApp.bundle exceeds limit/);
  assert.ok(result.stderr.length < 100000);
});

for (const event of [{ cancelled: true, exit_code: 0 }, { timed_out: true, exit_code: 0 }, {}, { ok: false, exit_code: 0 }]) {
  test('abnormal completion is never success: ' + JSON.stringify(event), async () => {
    spawn = async () => {
      const process_id = nextId++;
      emit('process_exited', { process_id, ...event });
      return { ok: true, process_id };
    };
    assert.equal((await runner.run(params())).ok, false);
  });
}

test('spawn failure is surfaced without retrying a possibly started Git command', async () => {
  spawn = async () => ({ ok: false, error: 'host unavailable' });
  assert.match(await git.gitPushAsync('C:/repo'), /host unavailable/);
  assert.equal(calls.length, 1);
  spawn = async () => { throw new Error('RPC disconnected'); };
  assert.match(await git.gitPushAsync('C:/repo'), /RPC disconnected/);
});

test('denied Git permission prevents spawning', async () => {
  hecaton.permissions = { query: async () => ({ ok: true, state: 'denied' }) };
  const result = await runner.run(params());
  assert.equal(result.error_code, 'access_denied');
  assert.equal(calls.length, 0);
});

test('legacy exec timeout reports the host 60-second limit, not the requested deadline', async () => {
  const saved = hecaton.process.spawn;
  delete hecaton.process.spawn;
  try {
    exec = async () => ({ ok: false, error: 'Process timed out after 60000ms' });
    const error = await git.gitPushAsync('C:/repo');
    assert.match(error, /exceeded 60 seconds/);
    assert.doesNotMatch(error, /exceeded (120|1800) seconds/);
  } finally { hecaton.process.spawn = saved; }
});

test('real Git push retains a rejecting hook result after 65 seconds', {
  skip: !process.env.HECATON_LONG_PROCESS_TEST, timeout: 90000,
}, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hecaton-long-push-'));
  const remote = path.join(root, 'remote.git'), local = path.join(root, 'local');
  const runGit = (args, cwd) => cp.execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    runGit(['init', '--bare', remote]);
    runGit(['init', '-b', 'main', local]);
    runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'test'], local);
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 65\necho "remote hook rejection after 65 seconds" >&2\nexit 1\n', { mode: 0o755 });
    spawn = async p => {
      const process_id = nextId++;
      const child = cp.spawn(p.program, p.args, { cwd: p.cwd, windowsHide: true });
      child.stdout.on('data', data => emit('process_output', { process_id, stream: 'stdout', data: data.toString() }));
      child.stderr.on('data', data => emit('process_output', { process_id, stream: 'stderr', data: data.toString() }));
      child.on('close', exit_code => emit('process_exited', { process_id, exit_code }));
      return { ok: true, process_id };
    };
    const started = Date.now();
    const error = await git.gitPushToRemoteAsync(local, remote, 'main');
    assert.ok(Date.now() - started >= 65000);
    assert.match(error, /remote hook rejection after 65 seconds/);
    assert.match(error, /pre-receive hook declined/);
    assert.equal(runGit(['for-each-ref', '--format=%(refname)'], remote).toString(), '');
  } finally {
    // Only remove the exact temporary directory created for this test.
    assert.equal(path.dirname(root), path.resolve(require('node:os').tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
