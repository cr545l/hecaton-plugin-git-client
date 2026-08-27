// 브랜치 Filter / Hide 지정의 영속화 검증 — 핀과 마찬가지로 리포별 settings.json 에
// 실려 다음 세션에 되살아나야 하고, 다른 리포로 옮겨 가면 그 리포의 지정을 따라야 한다.
//
// 저장은 hecaton.fs 를 거치므로 파일시스템을 메모리로 대체하고, 모듈 캐시를 비워
// "새 세션에서 다시 읽기"를 흉내 낸다.
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO = 'C:/repo/sample';
const OTHER = 'C:/repo/other';
let storedFile = null;

global.hecaton = {
  initialState: { cols: 120, rows: 40 },
  window: {}, terminal: {}, process: {}, on: () => {},
  env: {
    get: async ({ name }) => (name === 'HECA_PLUGIN_LOCAL_DATA_DIR' ? { value: '/data' } : {}),
    get_home: async () => ({}),
  },
  fs: {
    read_file: async () => (storedFile === null ? { ok: false } : { ok: true, content: storedFile }),
    write_file: async ({ content }) => { storedFile = content; return { ok: true }; },
    mkdir: async () => ({ ok: true }),
  },
};

function newSession() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](state|persist)\.js$/.test(key)) delete require.cache[key];
  }
  return { state: require('../state'), persist: require('../persist') };
}

function repoEntry(name) {
  const parsed = JSON.parse(storedFile);
  const key = Object.keys(parsed.repos).find(k => k.includes(name));
  assert.ok(key, name + ' 리포 항목이 저장돼야 한다');
  return parsed.repos[key];
}

test('지정한 ref 가 settings.json 에 실린다', async () => {
  storedFile = null;
  const { state: st, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);

  assert.deepEqual(st.ui.filteredRefs, [], '기본값은 지정 없음');
  assert.deepEqual(st.ui.hiddenRefs, []);

  st.toggleFilteredRef(st.localRefKey('develop'));
  st.toggleHiddenRef(st.remoteRefKey('origin/legacy'));
  await persist.flushNow();

  const entry = repoEntry('sample');
  assert.deepEqual(entry.filteredRefs, ['refs/heads/develop']);
  assert.deepEqual(entry.hiddenRefs, ['refs/remotes/origin/legacy']);
});

test('다음 세션에서 지정이 되살아난다', async () => {
  const { state: st, persist } = newSession();
  assert.deepEqual(st.ui.filteredRefs, [], '새 인스턴스는 빈 상태에서 시작한다');

  await persist.load();
  persist.attachRepo(REPO);
  assert.deepEqual(st.ui.filteredRefs, ['refs/heads/develop']);
  assert.deepEqual(st.ui.hiddenRefs, ['refs/remotes/origin/legacy']);

  st.clearFilteredRefs();
  await persist.flushNow();
  assert.deepEqual(repoEntry('sample').filteredRefs, [], '해제도 저장돼야 한다');
});

test('리포마다 따로 기억한다', async () => {
  const { state: st, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);
  assert.deepEqual(st.ui.hiddenRefs, ['refs/remotes/origin/legacy']);

  persist.attachRepo(OTHER);
  assert.deepEqual(st.ui.hiddenRefs, [], '다른 리포의 지정이 새어 오면 안 된다');
  st.toggleHiddenRef(st.localRefKey('wip'));
  await persist.flushNow();

  persist.attachRepo(REPO);
  assert.deepEqual(st.ui.hiddenRefs, ['refs/remotes/origin/legacy'], '돌아오면 제 지정을 되찾아야 한다');
  assert.deepEqual(repoEntry('other').hiddenRefs, ['refs/heads/wip']);
});

test('풀 refname 이 아닌 값은 버린다', async () => {
  // 손상된 파일이나 예전 형식이 들어와도 어떤 ref 와도 안 맞는 지정이 남지 않아야 한다.
  storedFile = JSON.stringify({
    version: 1,
    global: {},
    repos: {
      'c:/repo/sample': {
        filteredRefs: ['develop', 'refs/heads/keep', '', 42],
        hiddenRefs: ['refs/remotes/origin/x', 'origin/y'],
      },
    },
  });
  const { state: st, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);
  assert.deepEqual(st.ui.filteredRefs, ['refs/heads/keep']);
  assert.deepEqual(st.ui.hiddenRefs, ['refs/remotes/origin/x']);
});

test('저장값이 없으면 빈 지정으로 시작한다', async () => {
  storedFile = null;
  const { state: st, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);
  assert.deepEqual(st.ui.filteredRefs, []);
  assert.deepEqual(st.ui.hiddenRefs, []);
  await persist.flushNow();
});
