const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPollingService } = require('../polling-service');
const { createPollingClient } = require('../polling-client');
const { buildWorktreeSnapshot } = require('../worktree-snapshot');
const cwd = path.resolve('poll-test');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('57 windows share one running query and cached snapshot', async () => {
  let calls = 0, time = 1000;
  const gate = deferred();
  const service = createPollingService({ now: () => time, buildSnapshot: () => { calls++; return gate.promise; } });
  const requests = Array.from({ length: 57 }, (_, i) => service.request(i, 'worktree.snapshot', { cwd }));
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve('snapshot');
  assert.deepEqual(await Promise.all(requests), Array(57).fill('snapshot'));
  time = 3999;
  assert.equal(await service.request(58, 'worktree.snapshot', { cwd }), 'snapshot');
  assert.equal(calls, 1);
  time = 4000;
  await service.request(1, 'worktree.snapshot', { cwd });
  assert.equal(calls, 2);
});

test('slow queries share adaptive cooldown; different worktrees stay independent', async () => {
  let calls = 0, time = 0;
  const service = createPollingService({ now: () => time, buildSnapshot: async () => { calls++; time += 7000; return String(calls); } });
  await service.request(1, 'worktree.snapshot', { cwd });
  time = 27000;
  await service.request(2, 'worktree.snapshot', { cwd });
  assert.equal(calls, 1);
  await service.request(2, 'worktree.snapshot', { cwd: path.join(cwd, 'other') });
  assert.equal(calls, 2);
  await service.request(2, 'worktree.snapshot', { cwd });
  assert.equal(calls, 3);
});

test('disconnect retains running work until completion and removes unused cache', async () => {
  const gate = deferred();
  let calls = 0;
  const service = createPollingService({ buildSnapshot: () => { calls++; return gate.promise; } });
  const first = service.request(1, 'worktree.snapshot', { cwd });
  service.disconnect(1);
  const second = service.request(2, 'worktree.snapshot', { cwd });
  gate.resolve('done');
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  service.disconnect(2);
  await service.request(3, 'worktree.snapshot', { cwd });
  assert.equal(calls, 2);
});

test('failed query returns no snapshot and backs off before retrying', async () => {
  let time = 0, calls = 0;
  const service = createPollingService({ now: () => time, buildSnapshot: async () => { calls++; throw new Error('offline'); } });
  assert.equal(await service.request(1, 'worktree.snapshot', { cwd }), null);
  await service.request(2, 'worktree.snapshot', { cwd });
  assert.equal(calls, 1);
  time = 3000;
  await service.request(2, 'worktree.snapshot', { cwd });
  assert.equal(calls, 2);
  await assert.rejects(service.request(1, 'execute', { cwd }), /Invalid/);
  await assert.rejects(service.request(1, 'worktree.snapshot', { cwd: 'relative' }), /Invalid/);
});

test('Windows path casing and trailing separator share a query', async () => {
  let calls = 0;
  const service = createPollingService({ platform: 'win32', buildSnapshot: async () => ++calls });
  await service.request(1, 'worktree.snapshot', { cwd });
  await service.request(2, 'worktree.snapshot', { cwd: cwd.toUpperCase() + path.sep });
  assert.equal(calls, 1);
});

test('older hosts and explicit service denial use local fallback', async () => {
  let calls = 0;
  const fallback = async () => { calls++; return 'local'; };
  const old = createPollingClient({});
  assert.equal(await old.snapshot(cwd, fallback), 'local');
  const denied = createPollingClient({ serviceChannel: () => ({ connect: async () => { throw Object.assign(new Error(), { code: 'permission_denied' }); }, close: async () => {} }) });
  assert.equal(await denied.snapshot(cwd, fallback), 'local');
  assert.equal(calls, 2);
});

test('uncertain service failure never starts a second local Git; shutdown closes connection', async () => {
  let local = 0, closes = 0;
  const client = createPollingClient({ serviceChannel: () => ({
    connect: async () => {}, request: async () => { throw new Error('timeout'); }, close: async () => { closes++; },
  }) });
  assert.equal(await client.snapshot(cwd, () => { local++; }), null);
  assert.equal(await client.snapshot(cwd, () => { local++; }), null);
  await client.close();
  await client.snapshot(cwd, () => { local++; });
  assert.equal(local, 0);
  assert.equal(closes, 1);
});

test('successful client requests pass through the shared service; closing during connect starts no query', async () => {
  let calls = 0;
  const service = createPollingService({ buildSnapshot: async () => { calls++; return 'shared'; } });
  const clients = Array.from({ length: 10 }, (_, link) => createPollingClient({ serviceChannel: () => ({
    connect: async () => {},
    request: (method, params) => service.request(link, method, params),
    close: async () => service.disconnect(link),
  }) }));
  assert.deepEqual(await Promise.all(clients.map(client => client.snapshot(cwd, () => assert.fail('local Git')))), Array(10).fill('shared'));
  assert.equal(calls, 1);
  await Promise.all(clients.map(client => client.close()));
  const gate = deferred();
  const closing = createPollingClient({ serviceChannel: () => ({
    connect: () => gate.promise, request: () => assert.fail('query after close'), close: async () => {},
  }) });
  const pending = closing.snapshot(cwd, () => assert.fail('fallback after close'));
  await closing.close();
  gate.resolve();
  assert.equal(await pending, null);
});

test('snapshot detects repeated edits and handles NUL rename records', async () => {
  let mtime = 1;
  const stats = [];
  const api = { fs: { stat: async ({ path: file }) => { stats.push(file); return { exists: true, mtime_ms: mtime, size: 4 }; } } };
  const exec = async () => ({ ok: true, exit_code: 0, stdout: ' M dirty\0RM new\0old\0M  staged\0' });
  const first = await buildWorktreeSnapshot(cwd, api, exec);
  mtime++;
  const second = await buildWorktreeSnapshot(cwd, api, exec);
  assert.notEqual(first, second);
  assert.deepEqual(stats.slice(0, 2), [path.join(cwd, 'dirty'), path.join(cwd, 'new')]);
  assert.equal(stats.length, 4);
  assert.equal(await buildWorktreeSnapshot(cwd, api, async () => ({ ok: true, exit_code: 128, stdout: '' })), null);
});

test('real Git: 57 clients execute one status and later edits produce a new snapshot', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync, spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hecaton-polling-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    const file = path.join(root, 'dirty.txt');
    fs.writeFileSync(file, 'first');
    let calls = 0, time = 0;
    const api = { fs: { stat: async ({ path: filename }) => {
      const stat = fs.statSync(filename);
      return { exists: true, is_dir: stat.isDirectory(), size: stat.size, mtime_ms: stat.mtimeMs };
    } } };
    const service = createPollingService({ now: () => time, buildSnapshot: directory => buildWorktreeSnapshot(directory, api, async params => {
      calls++;
      const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...params.args], { cwd: params.cwd, encoding: 'utf8' });
      return { ok: !result.error, exit_code: result.status, stdout: result.stdout };
    }) });
    const snapshots = await Promise.all(Array.from({ length: 57 }, (_, link) => service.request(link, 'worktree.snapshot', { cwd: root })));
    assert.equal(calls, 1);
    assert.match(snapshots[0], /dirty.txt/);
    assert.ok(snapshots.every(value => value === snapshots[0]));
    fs.writeFileSync(file, 'second edit');
    time = 3000;
    const changed = await service.request(0, 'worktree.snapshot', { cwd: root });
    assert.equal(calls, 2);
    assert.notEqual(changed, snapshots[0]);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hecaton-polling-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
