const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');

// 인메모리 파일시스템 목. 공유 파일은 .git 아래 평범한 파일이라 이걸로 충분하다.
const files = new Map();
const dirs = new Set();
let failWrites = false;
let failReads = false;

global.hecaton = {
  fs: {
    async mkdir({ path }) { dirs.add(path); return { ok: true }; },
    async read_file({ path }) {
      if (failReads) throw new Error('read failed');
      if (!files.has(path)) return { ok: false };
      return { ok: true, content: files.get(path) };
    },
    async write_file({ path, content }) {
      if (failWrites) throw new Error('write failed');
      files.set(path, content);
      return { ok: true };
    },
    async stat({ path }) { return { exists: files.has(path) }; },
  },
  process: {},
  window: {},
  initialState: {},
};

const coordinate = require('../coordinate');

const COMMON_DIR = ['C:', 'repo', '.git'].join(nodePath.sep);
const WT_A = ['C:', 'repo'].join(nodePath.sep);
const WT_B = ['C:', 'repo-wt2'].join(nodePath.sep);

function reset() {
  files.clear();
  dirs.clear();
  failWrites = false;
  failReads = false;
  coordinate.configure(COMMON_DIR, WT_A);
}

// 공유 파일을 다른 인스턴스가 쓴 것처럼 직접 만든다.
function writeRaw(name, value) {
  files.set(nodePath.join(COMMON_DIR, 'hecaton-git-client', name), JSON.stringify(value));
}
function readRaw(name) {
  const raw = files.get(nodePath.join(COMMON_DIR, 'hecaton-git-client', name));
  return raw ? JSON.parse(raw) : null;
}

test('방금 올라온 공유 스냅샷은 그대로 재사용한다', async () => {
  reset();
  await coordinate.publishSharedSnapshot('worktree', 'SNAP-1');
  const hit = await coordinate.readSharedSnapshot('worktree', 5000);
  assert.ok(hit, '신선한 스냅샷은 히트해야 한다');
  assert.equal(hit.value, 'SNAP-1');
});

test('유효 기간을 넘긴 스냅샷은 쓰지 않는다 — 각자 git을 돌려야 한다', async () => {
  reset();
  await coordinate.publishSharedSnapshot('worktree', 'STALE');
  // 폴링을 돌리던 인스턴스가 멈춰 갱신이 끊긴 상황.
  for (const [name, raw] of [...files]) {
    if (!name.includes('worktree-')) continue;
    const rec = JSON.parse(raw);
    rec.publishedAt -= 10000;
    files.set(name, JSON.stringify(rec));
  }
  const miss = await coordinate.readSharedSnapshot('worktree', 2500);
  assert.equal(miss, null);
});

test('시계가 뒤로 간 기록은 신선한 것으로 오인하지 않는다', async () => {
  reset();
  const key = await (async () => {
    await coordinate.publishSharedSnapshot('worktree', 'X');
    // publish가 만든 파일명을 그대로 찾아 미래 시각으로 덮는다.
    for (const name of files.keys()) if (name.includes('worktree-')) return name;
    return '';
  })();
  files.set(key, JSON.stringify({ publishedAt: Date.now() + 60000, owner: 'other', value: 'FUTURE' }));
  const miss = await coordinate.readSharedSnapshot('worktree', 5000);
  assert.equal(miss, null);
});

test('깨진 JSON은 미스로 처리해 폴링을 계속 돌린다', async () => {
  reset();
  await coordinate.publishSharedSnapshot('worktree', 'GOOD');
  for (const name of [...files.keys()]) if (name.includes('worktree-')) files.set(name, '{"publishedAt":');
  const miss = await coordinate.readSharedSnapshot('worktree', 5000);
  assert.equal(miss, null);
});

test('워크트리가 다르면 스냅샷을 공유하지 않는다', async () => {
  reset();
  await coordinate.publishSharedSnapshot('worktree', 'FROM-A');
  coordinate.configure(COMMON_DIR, WT_B);
  const miss = await coordinate.readSharedSnapshot('worktree', 5000);
  assert.equal(miss, null, '다른 워크트리의 스냅샷을 읽으면 파일 상태를 잘못 판단한다');
});

test('공유 디렉터리가 없으면 조율은 조용히 비활성된다', async () => {
  reset();
  coordinate.configure('', WT_A);
  assert.equal(coordinate.isEnabled(), false);
  assert.equal(await coordinate.readSharedSnapshot('worktree', 5000), null);
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'run', '조율 불가면 평소대로 실행해야 한다');
});

test('쓰기가 막혀도 판단은 계속 동작한다', async () => {
  reset();
  failWrites = true;
  assert.equal(await coordinate.publishSharedSnapshot('worktree', 'X'), false);
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'run');
});

test('아무도 없으면 네트워크 작업은 내가 실행한다', async () => {
  reset();
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'run');
  const rec = readRaw('netop.json');
  assert.equal(rec.op, 'fetch');
  assert.equal(rec.owner, coordinate.INSTANCE_ID);
  assert.equal(rec.finishedAt, 0);
  await coordinate.endNetworkOp('fetch', true);
  assert.equal(readRaw('netop.json').ok, true);
});

test('다른 인스턴스가 진행 중이면 기다린다', async () => {
  reset();
  writeRaw('netop.json', { op: 'fetch', owner: 'other-instance', startedAt: Date.now(), finishedAt: 0, ok: false });
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'inflight');
  await coordinate.endNetworkOp('fetch', true);
});

// 아래에서 "오래된" 기록을 흉내낼 때 쓰는 나이. coordinate 의 NETOP_STALE_MS(150초)를
// 확실히 넘겨야 죽은 것으로 판정된다 — 그 미만이면 진행 중으로 보고 기다리는 것이 옳은
// 동작이라 이 테스트들의 대상이 아니다.
test('멈춘 지 오래된 진행 기록은 무시하고 직접 실행한다', async () => {
  reset();
  writeRaw('netop.json', { op: 'fetch', owner: 'dead-instance', startedAt: Date.now() - 300000, finishedAt: 0, ok: false });
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'run');
  await coordinate.endNetworkOp('fetch', true);
});

test('방금 끝난 남의 fetch는 다시 돌리지 않는다', async () => {
  reset();
  const now = Date.now();
  writeRaw('netop.json', { op: 'fetch', owner: 'other', startedAt: now - 2000, finishedAt: now - 100, ok: true });
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'reuse');
  await coordinate.endNetworkOp('fetch', true);
});

test('실패로 끝난 fetch는 재사용하지 않는다', async () => {
  reset();
  const now = Date.now();
  writeRaw('netop.json', { op: 'fetch', owner: 'other', startedAt: now - 2000, finishedAt: now - 100, ok: false });
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'run');
  await coordinate.endNetworkOp('fetch', true);
});

test('reuse 창이 0인 작업(pull/push)은 남의 결과를 쓰지 않는다', async () => {
  reset();
  const now = Date.now();
  writeRaw('netop.json', { op: 'pull', owner: 'other', startedAt: now - 2000, finishedAt: now - 100, ok: true });
  assert.equal(await coordinate.beginNetworkOp('pull', 0), 'run');
  await coordinate.endNetworkOp('pull', true);
});

test('다른 종류의 작업이 끝난 기록은 재사용하지 않는다', async () => {
  reset();
  const now = Date.now();
  writeRaw('netop.json', { op: 'push', owner: 'other', startedAt: now - 2000, finishedAt: now - 100, ok: true });
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'run');
  await coordinate.endNetworkOp('fetch', true);
});

test('남이 시작한 작업 기록을 내가 닫아버리지 않는다', async () => {
  reset();
  const started = Date.now();
  writeRaw('netop.json', { op: 'fetch', owner: 'other', startedAt: started, finishedAt: 0, ok: false });
  assert.equal(await coordinate.beginNetworkOp('fetch', 3000), 'inflight');
  await coordinate.endNetworkOp('fetch', true);
  const rec = readRaw('netop.json');
  assert.equal(rec.owner, 'other');
  assert.equal(rec.finishedAt, 0, '남의 진행 기록이 닫히면 그쪽이 inflight 판정을 잃는다');
});

test('내 작업이 도는 동안에는 폴링이 억제된다', async () => {
  reset();
  assert.equal(await coordinate.isNetworkOpInFlight(), false);
  await coordinate.beginNetworkOp('fetch', 3000);
  assert.equal(await coordinate.isNetworkOpInFlight(), true);
  await coordinate.endNetworkOp('fetch', true);
  assert.equal(await coordinate.isNetworkOpInFlight(), false);
});

test('응답이 돌아오지 않은 내 작업이 폴링을 영구히 막지 않는다', async () => {
  reset();
  // exec 응답이 끝내 오지 않아 endNetworkOp가 불리지 못한 상태를 만든다.
  await coordinate.beginNetworkOp('fetch', 3000);
  assert.equal(await coordinate.isNetworkOpInFlight(), true, '작업 직후에는 억제가 맞다');

  // 진행 기록도 함께 낡게 만든다(같은 인스턴스가 멈춘 상황).
  const rec = readRaw('netop.json');
  rec.startedAt = Date.now() - 300000;
  writeRaw('netop.json', rec);
  coordinate.__setLocalNetworkOpStartedAt(Date.now() - 300000);

  assert.equal(await coordinate.isNetworkOpInFlight(), false,
    '억제가 안 풀리면 이 인스턴스의 폴링이 영영 멈춘다');
});

test('만료된 로컬 작업은 새 작업 판정을 막지 않는다', async () => {
  reset();
  await coordinate.beginNetworkOp('fetch', 3000);
  coordinate.__setLocalNetworkOpStartedAt(Date.now() - 300000);
  await coordinate.isNetworkOpInFlight();   // 여기서 만료 처리
  assert.equal(await coordinate.isNetworkOpInFlight(), false);
});

test('남의 작업이 도는 동안에도 폴링이 억제된다', async () => {
  reset();
  writeRaw('netop.json', { op: 'push', owner: 'other', startedAt: Date.now(), finishedAt: 0, ok: false });
  assert.equal(await coordinate.isNetworkOpInFlight(), true);
});

test('끝난 작업은 폴링을 막지 않는다', async () => {
  reset();
  const now = Date.now();
  writeRaw('netop.json', { op: 'push', owner: 'other', startedAt: now - 1000, finishedAt: now - 10, ok: true });
  assert.equal(await coordinate.isNetworkOpInFlight(), false);
});

test('waitForNetworkOp는 남의 작업이 끝나면 즉시 돌아온다', async () => {
  reset();
  const now = Date.now();
  writeRaw('netop.json', { op: 'fetch', owner: 'other', startedAt: now, finishedAt: 0, ok: false });
  setTimeout(() => {
    writeRaw('netop.json', { op: 'fetch', owner: 'other', startedAt: now, finishedAt: Date.now(), ok: true });
  }, 300);
  assert.equal(await coordinate.waitForNetworkOp(5000), true);
});

test('기다림을 포기하고 직접 실행하면 진행 기록을 넘겨받는다', async () => {
  reset();
  writeRaw('netop.json', { op: 'fetch', owner: 'stuck', startedAt: Date.now(), finishedAt: 0, ok: false });
  await coordinate.claimNetworkOp('fetch');
  const rec = readRaw('netop.json');
  assert.equal(rec.owner, coordinate.INSTANCE_ID, '기록이 남의 것으로 남으면 내 작업이 추적되지 않는다');
  assert.equal(rec.finishedAt, 0);
  // 넘겨받았으니 이제 내가 닫을 수 있어야 한다.
  await coordinate.endNetworkOp('fetch', true);
  assert.equal(readRaw('netop.json').ok, true);
});

test('waitForNetworkOp는 상한을 넘기면 포기한다', async () => {
  reset();
  writeRaw('netop.json', { op: 'fetch', owner: 'other', startedAt: Date.now(), finishedAt: 0, ok: false });
  assert.equal(await coordinate.waitForNetworkOp(600), false);
});
