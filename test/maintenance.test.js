// 유휴 시간의 저장소 정리.
//
// 배경: 이 플러그인의 쓰기 명령은 자동 정리를 끄고 도는데(사용자 동작이 정리를 기다리지 않게),
// 대신 돌려 주는 곳이 없어 플러그인으로만 쓰는 저장소는 정리가 영영 돌지 않았다(실측: loose
// object 57,155개). 서비스가 저장소가 조용할 때 돌리고, 입력이 들어오면 곧바로 멈춘다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMaintenance } = require('../maintenance');
const { createPollingService } = require('../polling-service');
const { createPollingClient } = require('../polling-client');

const repoA = { cwd: path.resolve('maint-a'), commonDir: path.resolve('maint-a', '.git') };
const repoB = { cwd: path.resolve('maint-b'), commonDir: path.resolve('maint-b', '.git') };
const MIN = 60 * 1000;
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(overrides = {}) {
  const env = { time: 1000000, runs: [], cancels: 0, marks: new Map(), written: [] };
  env.maintenance = createMaintenance({
    now: () => env.time,
    idleMs: 3 * MIN, minIntervalMs: 360 * MIN, retryMs: 15 * MIN,
    run: cwd => {
      let finish;
      const promise = new Promise(resolve => { finish = resolve; });
      const job = { cwd, finish, cancelled: false };
      env.runs.push(job);
      return { promise, cancel() { job.cancelled = true; env.cancels++; finish({ ok: false }); } };
    },
    readMark: async commonDir => env.marks.get(commonDir) || null,
    writeMark: async (commonDir, mark) => { env.written.push({ commonDir, mark }); env.marks.set(commonDir, mark); },
    ...overrides,
  });
  return env;
}

test('nothing runs while the repository is in use; it starts once every window has been quiet', async () => {
  const env = setup();
  env.maintenance.activity(1, repoA);
  env.time += 2 * MIN;
  env.maintenance.activity(2, repoA); // 같은 저장소의 다른 창에서 입력
  env.time += 2 * MIN;
  assert.equal(await env.maintenance.tick(), null, 'a window was used two minutes ago');
  env.time += 1 * MIN;
  assert.equal(await env.maintenance.tick(), repoA.commonDir);
  assert.deepEqual(env.runs.map(job => job.cwd), [repoA.cwd]);

  // 끝까지 돌았으면 시각을 저장소에 남기고, 한동안 다시 돌리지 않는다.
  env.time += 1 * MIN;
  env.runs[0].finish({ ok: true });
  await flush();
  assert.equal(env.maintenance.isRunning(), false);
  assert.deepEqual(env.written.map(w => w.commonDir), [repoA.commonDir]);
  assert.equal(env.written[0].mark.ms, 1 * MIN);
  env.time += 300 * MIN;
  assert.equal(await env.maintenance.tick(), null);
  env.time += 60 * MIN;
  assert.equal(await env.maintenance.tick(), repoA.commonDir);
});

test('input while it runs stops it at once; the retry waits for quiet and a pause', async () => {
  const env = setup();
  env.maintenance.activity(1, repoA);
  env.time += 3 * MIN;
  await env.maintenance.tick();
  assert.equal(env.maintenance.isRunning(), true);

  env.maintenance.activity(1, repoA);
  assert.equal(env.runs[0].cancelled, true);
  await flush();
  assert.equal(env.maintenance.isRunning(), false);
  assert.equal(env.written.length, 0, 'an interrupted run is not recorded as done');

  // 다시 조용해져도 곧바로 재시도하지 않는다.
  env.time += 5 * MIN;
  assert.equal(await env.maintenance.tick(), null);
  env.time += 10 * MIN;
  assert.equal(await env.maintenance.tick(), repoA.commonDir);
  assert.equal(env.runs.length, 2);
});

test('one repository at a time, longest quiet first; a failed run is not repeated soon', async () => {
  const env = setup();
  env.maintenance.activity(1, repoA);
  env.time += 1 * MIN;
  env.maintenance.activity(2, repoB);
  env.time += 5 * MIN;
  assert.equal(await env.maintenance.tick(), repoA.commonDir);
  assert.equal(await env.maintenance.tick(), null, 'the second repository waits');
  env.runs[0].finish({ ok: false }); // git 이 실패로 끝났다
  await flush();
  assert.equal(env.written.length, 0);
  assert.equal(await env.maintenance.tick(), repoB.commonDir);
  env.runs[1].finish({ ok: true });
  await flush();
  env.time += 30 * MIN;
  assert.equal(await env.maintenance.tick(), null, 'neither the failed nor the finished one runs again yet');
});

test('the last run recorded in the repository is honoured after the service restarts', async () => {
  const env = setup();
  env.marks.set(repoA.commonDir, { at: env.time - 60 * MIN });
  env.maintenance.activity(1, repoA);
  env.time += 3 * MIN;
  assert.equal(await env.maintenance.tick(), null);
  env.time += 296 * MIN;
  assert.equal(await env.maintenance.tick(), null);
  env.time += 2 * MIN;
  assert.equal(await env.maintenance.tick(), repoA.commonDir);

  // 표시를 못 읽어도(깨진 파일) 정리는 돈다.
  const broken = setup({ readMark: async () => { throw new Error('bad json'); } });
  broken.maintenance.activity(1, repoA);
  broken.time += 3 * MIN;
  assert.equal(await broken.maintenance.tick(), repoA.commonDir);
});

test('a repository nobody has open is forgotten, and a run in progress is stopped', async () => {
  const env = setup();
  env.maintenance.activity(1, repoA);
  env.maintenance.activity(2, repoA);
  env.time += 3 * MIN;
  await env.maintenance.tick();
  env.maintenance.disconnect(1);
  assert.equal(env.runs[0].cancelled, false, 'another window still has it open');
  env.maintenance.disconnect(2);
  assert.equal(env.runs[0].cancelled, true);
  assert.equal(env.maintenance.repoCount(), 0);
  await flush();
  assert.equal(await env.maintenance.tick(), null);
  // 잘못된 알림은 무시한다.
  assert.equal(env.maintenance.activity(3, { cwd: 'relative', commonDir: repoA.commonDir }), false);
  assert.equal(env.maintenance.activity(3, null), false);
  assert.equal(env.maintenance.repoCount(), 0);
});

test('window notifications reach the maintenance through the service; no connection is opened just to notify', async () => {
  const env = setup();
  const service = createPollingService({ buildSnapshot: async () => 'snap', maintenance: env.maintenance });
  let connected = 0;
  const client = createPollingClient({ serviceChannel: () => ({
    connect: async () => { connected++; },
    request: (method, params) => service.request(7, method, params),
    notify: async (method, params) => service.notify(7, method, params),
    close: async () => service.disconnect(7),
  }) });
  client.activity(repoA.cwd, repoA.commonDir);
  assert.equal(connected, 0);
  assert.equal(env.maintenance.repoCount(), 0);

  await client.read(repoA.cwd, async () => assert.fail('local Git'));
  client.activity(repoA.cwd, repoA.commonDir);
  await flush();
  assert.equal(env.maintenance.repoCount(), 1);
  await client.close();
  assert.equal(env.maintenance.repoCount(), 0);
  // 알림을 모르는 채널(이전 호스트)에서도 예외 없이 지나간다.
  const old = createPollingClient({ serviceChannel: () => ({ connect: async () => {}, request: async () => ({ snapshot: 's', startedAt: 1 }), close: async () => {} }) });
  await old.read(repoA.cwd, async () => 'x');
  old.activity(repoA.cwd, repoA.commonDir);
});
