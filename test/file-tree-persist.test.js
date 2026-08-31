// 파일 목록 트리 보기의 영속화 검증 — 보기 방식과 접어 둔 폴더가 리포별 settings.json 에
// 실려 다음 세션에 되살아나야 한다. 트리로 보겠다는 선택은 저장소마다 다르고(폴더가
// 깊은 저장소에서만 쓸모가 있다), 매번 다시 켜야 하면 켜 둘 이유가 없다.
//
// 저장은 hecaton.fs 를 거치므로 파일시스템을 메모리로 대체하고, 모듈 캐시를 비워
// "새 세션에서 다시 읽기"를 흉내 낸다.
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO = 'C:/repo/tree-sample';
const OTHER = 'C:/repo/other-sample';
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
  const stateMod = require('../state');
  const persist = require('../persist');
  return { ...stateMod, persist };
}

function repoEntry(name) {
  const parsed = JSON.parse(storedFile);
  const key = Object.keys(parsed.repos).find(k => k.includes(name));
  assert.ok(key, name + ' 리포 항목이 저장돼야 한다');
  return parsed.repos[key];
}

test('트리 보기와 접어 둔 폴더가 settings.json 에 실린다', async () => {
  storedFile = null;
  const { ui, toggleCollapsedFileDir, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);

  assert.equal(ui.fileTreeView, false, '기본값은 평면 목록');
  ui.fileTreeView = true;
  toggleCollapsedFileDir('unstaged', 'src/util');
  await persist.flushNow();

  const entry = repoEntry('tree-sample');
  assert.equal(entry.fileTreeView, true);
  assert.deepEqual(entry.collapsedFileDirs, { 'unstaged\u0000src/util': true });
});

test('다음 세션에서 트리 보기와 접힘이 그대로 되살아난다', async () => {
  const { ui, isCollapsedFileDir, persist } = newSession();
  assert.equal(ui.fileTreeView, false, '새 인스턴스는 기본값에서 시작한다');

  await persist.load();
  persist.attachRepo(REPO);
  assert.equal(ui.fileTreeView, true);
  assert.equal(isCollapsedFileDir('unstaged', 'src/util'), true);
});

test('펼치면 키가 사라져 저장이 무한정 커지지 않는다', async () => {
  const { toggleCollapsedFileDir, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);

  toggleCollapsedFileDir('unstaged', 'src/util'); // 펼치기
  await persist.flushNow();
  assert.deepEqual(repoEntry('tree-sample').collapsedFileDirs, {});
});

// 레이아웃 값은 리포별로 저장되지만, 저장된 적 없는 리포는 지금 값을 물려받는다
// (persist.applyLayout 의 기존 계약 — 새 폴더를 열 때마다 배치가 초기화되지 않게 한다).
// 여기서 지켜야 하는 것은 "한 번 정한 리포는 자기 값을 지킨다"이다.
test('리포마다 정한 보기 방식을 각자 지킨다', async () => {
  const { ui, persist } = newSession();
  await persist.load();

  persist.attachRepo(REPO);
  assert.equal(ui.fileTreeView, true);

  // 다른 저장소에서 평면으로 되돌리고 저장한다.
  persist.attachRepo(OTHER);
  ui.fileTreeView = false;
  await persist.flushNow();
  assert.equal(repoEntry('other-sample').fileTreeView, false);

  persist.attachRepo(REPO);
  assert.equal(ui.fileTreeView, true, '트리로 정해 둔 저장소는 그대로여야 한다');

  persist.attachRepo(OTHER);
  assert.equal(ui.fileTreeView, false, '평면으로 정해 둔 저장소도 그대로여야 한다');
});
