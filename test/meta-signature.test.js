// .git 메타 지문을 서비스가 저장소 단위로 계산해 창들에 나눠 준다.
//
// 배경: 창마다 2초 주기로 stat 8번 + refs 트리 훑기(디렉터리 수만큼 read_dir)를 따로 했다.
// 창 열 개면 2초마다 호스트 호출이 260건쯤이고, 그 호출은 git 실행과 같은 워커를 지난다.
// 지문의 대부분은 저장소 전체에 공통이라, 한 주기에 공용 부분은 저장소당 한 번, 워크트리
// 부분은 워크트리당 한 번만 읽으면 된다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMetaReader, computeRefsTreeSignature } = require('../meta-signature');
const { createPollingService } = require('../polling-service');
const { createPollingClient } = require('../polling-client');

const SEP = process.platform === 'win32' ? '\\' : '/';
const COMMON = path.resolve('meta-sig-repo', '.git');
const LINKED = COMMON + SEP + 'worktrees' + SEP + 'topic';

function host() {
  const calls = { stat: [], read_dir: [] };
  const mtimes = new Map();
  const tree = {
    [COMMON + SEP + 'refs']: [{ name: 'heads', is_dir: true }, { name: 'remotes', is_dir: true }],
    [COMMON + SEP + 'refs' + SEP + 'heads']: [{ name: 'main', is_dir: false, mtime_ms: 100, size_bytes: 41 }],
    [COMMON + SEP + 'refs' + SEP + 'remotes']: [],
  };
  return {
    calls, mtimes, tree,
    api: { fs: {
      stat: async ({ path: target }) => { calls.stat.push(target); return { exists: true, mtime_ms: mtimes.get(target) || 1 }; },
      read_dir: async ({ path: target }) => {
        calls.read_dir.push(target);
        return tree[target] ? { ok: true, entries: tree[target] } : { ok: false };
      },
    } },
  };
}

test('ten windows on ten worktrees scan the shared part of the repository once per cycle', async () => {
  const h = host();
  let time = 1000;
  const reader = createMetaReader(h.api, { ttlMs: 1500, now: () => time });
  const worktrees = Array.from({ length: 10 }, (_, i) => COMMON + SEP + 'worktrees' + SEP + 'wt' + i);
  const results = await Promise.all(worktrees.map(gitDir => reader.read({ gitDir, commonDir: COMMON })));
  assert.equal(h.calls.read_dir.length, 3, 'one refs tree walk for the repository');
  assert.equal(h.calls.stat.length, 4 + 10 * 4, 'four shared files once, four files per worktree');
  assert.equal(new Set(results.map(r => r.sig)).size, 1);
  assert.ok(results.every(r => r.shareable));

  // 같은 주기 안의 재요청은 호스트를 다시 부르지 않는다.
  time = 2400;
  await reader.read({ gitDir: worktrees[0], commonDir: COMMON });
  assert.equal(h.calls.read_dir.length, 3);
  assert.equal(h.calls.stat.length, 44);
  // 다음 주기에는 새로 읽는다.
  time = 2600;
  await reader.read({ gitDir: worktrees[0], commonDir: COMMON });
  assert.equal(h.calls.read_dir.length, 6);
});

test('the signature moves with the index of one worktree and with a ref shared by all', async () => {
  const h = host();
  const reader = createMetaReader(h.api);
  const read = gitDir => reader.read({ gitDir, commonDir: COMMON }).then(r => r.sig);
  const [main0, linked0] = [await read(COMMON), await read(LINKED)];

  // 한 워크트리의 index — 그 워크트리의 지문만 달라지고, 달라지는 것은 첫 칸뿐이다.
  h.mtimes.set(LINKED + SEP + 'index', 500);
  const [main1, linked1] = [await read(COMMON), await read(LINKED)];
  assert.equal(main1, main0);
  assert.notEqual(linked1, linked0);
  const times = sig => sig.split('\x1e')[0].split('|');
  assert.equal(times(linked1).length, 8);
  assert.notEqual(times(linked1)[0], times(linked0)[0]);
  assert.deepEqual(times(linked1).slice(1), times(linked0).slice(1));

  // 브랜치가 움직였다 — 모든 워크트리의 지문이 달라진다.
  h.tree[COMMON + SEP + 'refs' + SEP + 'heads'] = [{ name: 'main', is_dir: false, mtime_ms: 200, size_bytes: 41 }];
  assert.notEqual(await read(COMMON), main1);
  assert.notEqual(await read(LINKED), linked1);
});

test('a host that cannot list directories falls back to the file times alone', async () => {
  const h = host();
  delete h.api.fs.read_dir;
  const reader = createMetaReader(h.api);
  const first = await reader.read({ gitDir: COMMON, commonDir: COMMON });
  assert.equal(await computeRefsTreeSignature(h.api, COMMON), '');
  assert.ok(first.sig.endsWith(''), 'no refs tree part');
  assert.equal(first.shareable, true);
  // 그래도 packed-refs 같은 파일 시각의 변화는 잡는다.
  h.mtimes.set(COMMON + SEP + 'packed-refs', 900);
  assert.notEqual((await reader.read({ gitDir: COMMON, commonDir: COMMON })).sig, first.sig);
});

test('the service answers meta.signature and rejects malformed requests', async () => {
  const h = host();
  const reader = createMetaReader(h.api, { ttlMs: 1500 });
  const service = createPollingService({ buildSnapshot: async () => 'x', readMeta: reader.read });
  const direct = await createMetaReader(h.api).read({ gitDir: LINKED, commonDir: COMMON });
  assert.deepEqual(await service.request(1, 'meta.signature', { gitDir: LINKED, commonDir: COMMON }), direct);
  // commonDir 을 주지 않으면 git dir 이 곧 공용 dir 이다.
  assert.deepEqual(await service.request(1, 'meta.signature', { gitDir: COMMON }),
    await createMetaReader(h.api).read({ gitDir: COMMON, commonDir: COMMON }));
  await assert.rejects(service.request(1, 'meta.signature', { gitDir: 'relative' }), /Invalid/);
  await assert.rejects(service.request(1, 'meta.signature', { gitDir: COMMON, commonDir: 'relative' }), /Invalid/);
  await assert.rejects(service.request(1, 'meta.signature', null), /Invalid/);
  // 지문 계산을 받지 못한 서비스(이전 구성)는 거절한다 — 창이 직접 계산으로 넘어간다.
  const bare = createPollingService({ buildSnapshot: async () => 'x' });
  await assert.rejects(bare.request(1, 'meta.signature', { gitDir: COMMON }), /Invalid/);
});

test('the client asks the service and computes locally whenever the service cannot answer', async () => {
  const fallback = async () => ({ sig: 'local', shareable: true });
  // 서비스가 없는 호스트
  assert.deepEqual(await createPollingClient({}).metaSignature(COMMON, COMMON, fallback),
    { sig: 'local', shareable: true, viaService: false });

  const requests = [];
  let answer = async () => ({ sig: 'shared', shareable: true });
  const client = createPollingClient({ serviceChannel: () => ({
    connect: async () => {},
    request: async (method, params) => {
      requests.push(method);
      if (method === 'meta.signature') return answer(params);
      return { snapshot: 's', startedAt: 1 };
    },
    close: async () => {},
  }) });
  // 스냅샷 쪽이 연결을 열기 전에는 직접 계산한다.
  assert.equal((await client.metaSignature(COMMON, COMMON, fallback)).viaService, false);
  await client.read(COMMON, async () => assert.fail('local Git'));
  assert.deepEqual(await client.metaSignature(COMMON, COMMON, fallback), { sig: 'shared', shareable: true, viaService: true });

  // 한 번 답하지 못한 것으로는 서비스를 버리지 않는다.
  answer = async () => { throw new Error('timeout'); };
  assert.equal((await client.metaSignature(COMMON, COMMON, fallback)).sig, 'local');
  answer = async () => ({ sig: 'shared', shareable: false });
  assert.deepEqual(await client.metaSignature(COMMON, COMMON, fallback), { sig: 'shared', shareable: false, viaService: true });

  // 이전 버전 서비스는 이 메서드를 모른다 — 그 뒤로는 묻지 않는다.
  answer = async () => { throw new Error('Invalid polling request'); };
  assert.equal((await client.metaSignature(COMMON, COMMON, fallback)).viaService, false);
  const asked = requests.filter(m => m === 'meta.signature').length;
  await client.metaSignature(COMMON, COMMON, fallback);
  assert.equal(requests.filter(m => m === 'meta.signature').length, asked);

  await client.close();
  assert.equal(await client.metaSignature(COMMON, COMMON, fallback), null);
});
