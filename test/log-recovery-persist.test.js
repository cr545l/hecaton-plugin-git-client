// Recovery 토글의 영속화 검증 — 리포별 settings.json 에 실려 다음 세션에 되살아나야 한다.
//
// 저장은 hecaton.fs 를 거치므로 파일시스템을 메모리로 대체하고, 모듈 캐시를 비워
// "새 세션에서 다시 읽기"를 흉내 낸다.
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO = 'C:/repo/sample';
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

// state/persist 를 새 인스턴스로 다시 물려 세션 재시작을 흉내 낸다.
function newSession() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](state|persist)\.js$/.test(key)) delete require.cache[key];
  }
  const { ui } = require('../state');
  const persist = require('../persist');
  return { ui, persist };
}

function repoEntry() {
  const parsed = JSON.parse(storedFile);
  const key = Object.keys(parsed.repos).find(k => k.includes('sample'));
  assert.ok(key, '리포 항목이 저장돼야 한다');
  return parsed.repos[key];
}

test('토글을 끄면 settings.json 에 실린다', async () => {
  storedFile = null;
  const { ui, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);

  assert.equal(ui.logShowRecovery, true, '기본값은 보이기');
  ui.logShowRecovery = false;
  await persist.flushNow();

  assert.equal(repoEntry().logShowRecovery, false);
});

test('다음 세션에서 꺼진 상태로 되살아난다', async () => {
  const { ui, persist } = newSession();
  assert.equal(ui.logShowRecovery, true, '새 인스턴스는 기본값에서 시작한다');

  await persist.load();
  persist.attachRepo(REPO);
  assert.equal(ui.logShowRecovery, false, '저장된 값이 적용돼야 한다');

  ui.logShowRecovery = true;
  await persist.flushNow();
  assert.equal(repoEntry().logShowRecovery, true, '다시 켠 것도 저장돼야 한다');
});

test('저장값이 없으면 기본값을 지킨다', async () => {
  storedFile = null;
  const { ui, persist } = newSession();
  await persist.load();
  persist.attachRepo(REPO);
  assert.equal(ui.logShowRecovery, true);
  await persist.flushNow();
});
