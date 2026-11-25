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

// 대기 구간에는 직전 결과를 다시 내준다. 받는 창이 자기 목록보다 새것인지 가릴 수 있도록
// 그 결과를 만든 조회가 시작된 시각을 함께 준다.
test('snapshot2 reports when the query that produced the snapshot started', async () => {
  let time = 1000, calls = 0;
  const service = createPollingService({ now: () => time, buildSnapshot: async () => { calls++; time += 200; return 'v' + calls; } });
  assert.deepEqual(await service.request(1, 'worktree.snapshot2', { cwd }), { snapshot: 'v1', startedAt: 1000 });
  time = 2500;
  // 대기 구간: 같은 결과, 같은 시작 시각 — "방금 받았다"가 "방금 읽었다"는 아니다.
  assert.deepEqual(await service.request(2, 'worktree.snapshot2', { cwd }), { snapshot: 'v1', startedAt: 1000 });
  assert.equal(await service.request(3, 'worktree.snapshot', { cwd }), 'v1');
  time = 5000;
  assert.deepEqual(await service.request(2, 'worktree.snapshot2', { cwd }), { snapshot: 'v2', startedAt: 5000 });
  assert.equal(calls, 2);
});

test('client reads the start time from the service and falls back to the old method on an older service', async () => {
  const service = createPollingService({ now: () => 7000, buildSnapshot: async () => 'shared' });
  const client = createPollingClient({ serviceChannel: () => ({
    connect: async () => {}, request: (method, params) => service.request(1, method, params), close: async () => {},
  }) });
  assert.deepEqual(await client.read(cwd, () => assert.fail('local Git')), { snapshot: 'shared', startedAt: 7000, viaService: true });

  // 이 창보다 먼저 떠 있던 이전 버전 서비스는 새 메서드를 거절한다.
  const methods = [];
  const older = createPollingClient({ serviceChannel: () => ({
    connect: async () => {},
    request: async (method) => {
      methods.push(method);
      if (method !== 'worktree.snapshot') throw new Error('Invalid polling request');
      return 'legacy';
    },
    close: async () => {},
  }) });
  assert.deepEqual(await older.read(cwd, () => assert.fail('local Git')), { snapshot: 'legacy', startedAt: 0, viaService: true });
  await older.read(cwd, () => assert.fail('local Git'));
  assert.deepEqual(methods, ['worktree.snapshot2', 'worktree.snapshot', 'worktree.snapshot'], 'the new method is tried once');

  // 서비스가 없는 호스트: 이 창이 직접 읽고, 시작 시각은 읽기 직전이다.
  const before = Date.now();
  const local = await createPollingClient({}).read(cwd, async () => 'local');
  assert.equal(local.snapshot, 'local');
  assert.equal(local.viaService, false);
  assert.ok(local.startedAt >= before && local.startedAt <= Date.now());
});

// ── status 를 띄울지의 판단(변화 감지, 유휴 간격, 동시 실행 상한) ──
const gitDir = path.join(cwd, '.git');
function gatedService(overrides = {}) {
  const s = { time: 0, calls: 0, own: 'a', dirtySame: true, probes: 0, output: 'snap' };
  s.service = createPollingService({
    now: () => s.time,
    buildSnapshot: async () => { s.calls++; return s.output; },
    readOwn: async () => s.own,
    dirtyUnchanged: async () => { s.probes++; return s.dirtySame; },
    ...overrides,
  });
  s.ask = (idleMs, link = 1) => s.service.request(link, 'worktree.snapshot2', { cwd, gitDir, idleMs });
  return s;
}

test('a window with recent input keeps the 3 second status cadence', async () => {
  const s = gatedService();
  await s.ask(0);
  s.time = 3000; await s.ask(1000);
  s.time = 6000; await s.ask(29999 - 6000 + 6000 - 1); // 마지막 입력이 30초 안쪽이다
  assert.equal(s.calls, 3);
  assert.equal(s.probes, 0);
});

test('an idle worktree is checked without Git and status backs off while nothing changes', async () => {
  const s = gatedService();
  const idle = () => s.ask(600000);
  await idle();                       // 첫 조회는 늘 돈다
  assert.equal(s.calls, 1);
  const ran = [];
  for (s.time = 3000; s.time <= 180000; s.time += 3000) {
    const before = s.calls;
    await idle();
    if (s.calls !== before) ran.push(s.time);
  }
  // 간격이 3 → 6 → 12 → 30 → 60초로 늘어난다(각 간격은 직전 status 기준).
  assert.deepEqual(ran, [3000, 9000, 21000, 51000, 111000, 171000]);
  assert.ok(s.probes > 40, 'the ticks in between only re-stat');
});

test('an index change or an edit to an already dirty file runs status at once and resets the backoff', async () => {
  const s = gatedService();
  const idle = () => s.ask(600000);
  await idle();
  s.time = 3000; await idle();        // 결과가 같다 — 다음 status 는 6초 뒤
  assert.equal(s.calls, 2);
  s.time = 6000; s.own = 'b'; await idle();
  assert.equal(s.calls, 3, 'index/HEAD moved');
  s.time = 9000; s.dirtySame = false; s.output = 'snap2';
  const changed = await idle();
  assert.equal(s.calls, 4, 'a dirty file was edited again');
  assert.deepEqual(changed, { snapshot: 'snap2', startedAt: 9000 });
  s.dirtySame = true;
  s.time = 12000; await idle();
  assert.equal(s.calls, 5, 'a changed result restarts at the shortest interval');
});

test('windows on the same idle worktree share one check; input from any of them wakes it', async () => {
  const s = gatedService();
  await s.ask(600000, 1);
  s.time = 3000; await s.ask(600000, 1);
  s.time = 6000;
  await Promise.all([s.ask(600000, 1), s.ask(600000, 2), s.ask(600000, 3)]);
  assert.equal(s.probes, 1);
  assert.equal(s.calls, 2);
  s.time = 7000; await s.ask(600000, 2);
  assert.equal(s.probes, 1, 'the check itself is rate limited');
  s.time = 9000; await s.ask(500, 3);
  assert.equal(s.calls, 3);
});

test('older windows that send no hints, and a failed check, fall back to running status', async () => {
  const s = gatedService();
  await s.service.request(1, 'worktree.snapshot2', { cwd });
  s.time = 3000; await s.service.request(1, 'worktree.snapshot2', { cwd });
  assert.equal(s.calls, 2);
  const broken = gatedService({ dirtyUnchanged: async () => { throw new Error('stat failed'); } });
  await broken.ask(600000);
  broken.time = 3000; await broken.ask(600000);
  broken.time = 6000; await broken.ask(600000);
  assert.equal(broken.calls, 3);
});

test('at most two status processes run at once; a window with input goes first', async () => {
  const gates = new Map();
  const started = [];
  let time = 0;
  const service = createPollingService({
    now: () => time,
    buildSnapshot: dir => { started.push(path.basename(dir)); const g = deferred(); gates.set(path.basename(dir), g); return g.promise; },
    readOwn: async () => 'a', dirtyUnchanged: async () => true,
  });
  const ask = (name, idleMs) => service.request(name, 'worktree.snapshot2', { cwd: path.join(cwd, name), gitDir: path.join(cwd, name, '.git'), idleMs });
  // 첫 조회는 모두 status 가 필요하다. 유휴 창 셋이 먼저 줄을 서고, 입력이 있던 창이 뒤에 온다.
  time = 40000;
  const all = [ask('a', 40000), ask('b', 40000), ask('c', 40000), ask('d', 0)];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b']);
  gates.get('a').resolve('A');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b', 'd'], 'the active window jumps the queue');
  gates.get('b').resolve('B');
  await new Promise(resolve => setImmediate(resolve));
  gates.get('d').resolve('D');
  gates.get('c').resolve('C');
  assert.deepEqual((await Promise.all(all)).map(r => r.snapshot), ['A', 'B', 'C', 'D']);
});

test('re-statting the dirty files of a snapshot detects another edit without Git', async () => {
  const { dirtyFilesUnchanged } = require('../worktree-snapshot');
  let mtime = 1, execs = 0;
  const api = { fs: { stat: async () => ({ exists: true, mtime_ms: mtime, size: 4 }) } };
  const exec = async () => { execs++; return { ok: true, exit_code: 0, stdout: ' M dirty\0?? new\0' }; };
  const snapshot = await buildWorktreeSnapshot(cwd, api, exec);
  assert.equal(await dirtyFilesUnchanged(cwd, api, snapshot), true);
  mtime = 2;
  assert.equal(await dirtyFilesUnchanged(cwd, api, snapshot), false);
  assert.equal(await dirtyFilesUnchanged(cwd, api, null), false);
  assert.equal(execs, 1);
  // 변경이 없는 워크트리의 스냅샷도 그대로 견준다.
  const clean = await buildWorktreeSnapshot(cwd, api, async () => ({ ok: true, exit_code: 0, stdout: '' }));
  assert.equal(await dirtyFilesUnchanged(cwd, api, clean), true);
});

test('the client sends the hints with each snapshot request', async () => {
  const sent = [];
  const client = createPollingClient({ serviceChannel: () => ({
    connect: async () => {}, request: async (method, params) => { sent.push(params); return { snapshot: 's', startedAt: 1 }; }, close: async () => {},
  }) });
  let idleMs = 5;
  await client.read(cwd, () => assert.fail('local Git'), () => ({ gitDir, idleMs }));
  idleMs = 9;
  await client.read(cwd, () => assert.fail('local Git'), () => ({ gitDir, idleMs, cwd: 'ignored' }));
  await client.read(cwd, () => assert.fail('local Git'));
  assert.deepEqual(sent, [{ gitDir, idleMs: 5, cwd }, { gitDir, idleMs: 9, cwd }, { cwd }]);
});
