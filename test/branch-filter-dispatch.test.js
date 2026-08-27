// 브랜치 Filter / Hide 의 실행 경로 검증 — 메뉴 항목을 만들어 놓고 핸들러를 빠뜨리면
// 눌러도 아무 일이 안 일어난다. 여기서는 handleContextMenuAction 을 실제로 태워
// 지정이 바뀌고 히스토리 목록까지 다시 그려지는지 본다.
//
// 지정은 순수 UI 상태라 git 을 다시 부르면 안 된다 — 커밋을 새로 읽는 대신 캐시된
// 목록으로 그래프만 다시 만들어야 한다(exec 호출 수로 확인).
const test = require('node:test');
const assert = require('node:assert/strict');

let execCalls = [];

global.hecaton = {
  terminal: {},
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  process: {
    exec: async (opts) => { execCalls.push(opts); return { ok: true, exit_code: 0, stdout: '', stderr: '' }; },
  },
  fs: { stat: async () => ({ exists: false }), read_dir: async () => ({ ok: false }), read_file: async () => ({ content: '' }) },
  window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({ ok: true }), set: async () => ({}), remove: async () => ({}) },
  clipboard: { write: async () => ({ ok: true }), read: async () => ({ text: '' }) },
  dialog: { show: () => Promise.resolve({}) },
  menu: { show: () => Promise.resolve({}) },
};

const { state, ui, localRefKey, remoteRefKey } = require('../state');
const { buildLogGraphRows } = require('../refresh');
const { handleContextMenuAction } = require('../context-menu');
const { render } = require('../render');
const { stripAnsi } = require('../text');

const H = n => String(n).padStart(40, '0');

function sampleCommits() {
  return [
    { hash: H(1), parents: [H(2)], refs: 'HEAD -> main, origin/main', subject: 'main tip' },
    { hash: H(5), parents: [H(2)], refs: 'feature/login', subject: 'feature tip' },
    { hash: H(4), parents: [H(3)], refs: 'develop, origin/develop', subject: 'develop tip' },
    { hash: H(2), parents: [H(3)], refs: '', subject: 'shared B' },
    { hash: H(3), parents: [], refs: '', subject: 'base' },
  ];
}

// 실행 경로에는 render() 가 들어 있다. 상세 로드가 비동기로 한 번 더 그리므로 그
// 태스크까지 흡수한 뒤 다음 검증으로 넘어간다.
//
// 화면 출력은 stdout 을 막아 지우지 않는다 — 러너는 테스트 결과를 같은 stdout 으로
// TAP 으로 내보내므로, 잠깐이라도 삼키면 그 사이의 테스트가 통째로 사라진다.
// 대신 최소화 상태로 그려 출력을 한 줄로 줄인다(목록 갱신은 그대로 일어난다).
async function dispatch(actionId) {
  await handleContextMenuAction(actionId);
  await new Promise(resolve => setImmediate(resolve));
}

const subjects = () => state.logItems.filter(r => r.type === 'commit').map(r => r.subject);

function setup() {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.indexLocked = false;
  state.spinnerActive = false;
  state.settlingWrite = false;
  state.operationState = null;
  state.minimized = true;   // 화면 출력을 한 줄로 줄인다 — 목록 갱신은 그대로 일어난다
  state.error = null;
  state.conflictView = null;
  state.mode = 'normal';
  state.refreshing = false;
  state.logLoading = false;
  state.logLoadingMore = false;
  state.freshTimeWindowMode = false;
  state.cwd = 'C:/repo';
  state.branch = 'main';
  state.branches = [
    { name: 'main', isCurrent: true, upstream: 'origin/main' },
    { name: 'develop', isCurrent: false, upstream: 'origin/develop' },
    { name: 'feature/login', isCurrent: false, upstream: '' },
  ];
  state.remoteBranches = ['origin/main', 'origin/develop'];
  state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false;
  state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'log';
  state.logDetailLines = [];
  state.logCursor = 0;
  state.logScrollOffset = 0;
  state.recoveryRefs = {};

  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.filteredRefs = []; ui.hiddenRefs = []; ui.pinnedBranches = [];
  ui.logSortMode = 'date'; ui.logShowRecovery = true;
  ui.stashMap = new Map();
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.hoveredLeftPanelRow = -1;
  ui.hoveredLogRow = -1; ui.hoveredTitleZoneIndex = -1;
  ui.contextMenuBranch = null;
  ui.contextMenuRemoteBranch = null;

  // 로그를 한 번 읽어 둔 상태를 만든다 — 이후 토글은 이 캐시로만 다시 그려야 한다.
  const rows = buildLogGraphRows(sampleCommits(), new Set());
  state.logItems = rows;
  state.logSelectables = rows.map((_, i) => i);
  execCalls = [];
}

test('Hide 를 누르면 그 브랜치 전용 커밋이 목록에서 빠진다', async () => {
  setup();
  ui.contextMenuBranch = 'feature/login';
  await dispatch('branch_hide');

  assert.deepEqual(ui.hiddenRefs, [localRefKey('feature/login')]);
  assert.deepEqual(subjects(), ['main tip', 'develop tip', 'shared B', 'base']);
});

test('다시 누르면 되돌아온다', async () => {
  setup();
  ui.contextMenuBranch = 'feature/login';
  await dispatch('branch_hide');
  await dispatch('branch_hide');

  assert.deepEqual(ui.hiddenRefs, []);
  assert.deepEqual(subjects(), ['main tip', 'feature tip', 'develop tip', 'shared B', 'base']);
});

test('Filter 를 누르면 그 브랜치 줄기만 남는다', async () => {
  setup();
  ui.contextMenuBranch = 'develop';
  await dispatch('branch_filter');

  assert.deepEqual(ui.filteredRefs, [localRefKey('develop')]);
  assert.deepEqual(subjects(), ['develop tip', 'base']);
});

test('지정을 바꿔도 커밋 목록을 다시 읽지 않는다', async () => {
  setup();
  ui.contextMenuBranch = 'develop';
  await dispatch('branch_filter');
  // 고른 커밋이 바뀌면 상세는 다시 읽어야 하지만(정렬/Recovery 토글도 마찬가지),
  // 목록 자체는 캐시로 다시 만들어야 한다 — 지정을 켰다 껐다 할 때마다 git log 를
  // 새로 돌리면 큰 저장소에서 그때마다 멈춘다.
  const logCalls = execCalls.filter(c => (c.args || []).includes('log'));
  assert.deepEqual(logCalls, [], 'git log 를 다시 돌리면 안 된다');
});

test('전체 해제로 한 번에 되돌린다', async () => {
  setup();
  ui.contextMenuBranch = 'develop';
  await dispatch('branch_filter');
  ui.contextMenuBranch = 'feature/login';
  await dispatch('branch_hide');
  assert.equal(ui.filteredRefs.length, 1);
  assert.equal(ui.hiddenRefs.length, 1);

  await dispatch('branch_clear_filters');
  assert.deepEqual(ui.filteredRefs, []);
  assert.deepEqual(ui.hiddenRefs, [localRefKey('feature/login')], '숨김은 그대로여야 한다');

  await dispatch('branch_show_all');
  assert.deepEqual(ui.hiddenRefs, []);
  assert.deepEqual(subjects(), ['main tip', 'feature tip', 'develop tip', 'shared B', 'base']);
});

test('리모트 브랜치 메뉴의 지정은 리모트 ref 로 걸린다', async () => {
  setup();
  ui.contextMenuRemoteBranch = 'origin/develop';
  await dispatch('remotebranch_hide');
  assert.deepEqual(ui.hiddenRefs, [remoteRefKey('origin/develop')]);
  assert.deepEqual(
    subjects(),
    ['main tip', 'feature tip', 'develop tip', 'shared B', 'base'],
    '로컬 develop 이 아직 루트라 그 줄기는 남는다',
  );

  ui.contextMenuBranch = 'develop';
  await dispatch('branch_hide');
  assert.deepEqual(subjects(), ['main tip', 'feature tip', 'shared B', 'base']);
});

test('한 ref 에 Filter 와 Hide 를 잇달아 걸면 나중 것만 남는다', async () => {
  setup();
  ui.contextMenuBranch = 'develop';
  await dispatch('branch_hide');
  await dispatch('branch_filter');
  assert.deepEqual(ui.hiddenRefs, []);
  assert.deepEqual(ui.filteredRefs, [localRefKey('develop')]);
  assert.deepEqual(subjects(), ['develop tip', 'base']);
});

test('다른 쓰기 작업이 도는 중에도 실행된다', async () => {
  setup();
  state.spinnerActive = true;
  ui.contextMenuBranch = 'develop';
  await dispatch('branch_filter');
  state.spinnerActive = false;
  assert.deepEqual(ui.filteredRefs, [localRefKey('develop')], '저장소를 건드리지 않으므로 게이트가 막지 않는다');
});

// ── 필터로 목록이 비었을 때 ──
//
// 이 상태는 실수로 만들기 쉽다: 로그 한도(max-count) 밖으로 밀려난 오래된 브랜치를
// Filter 하면 남는 커밋이 하나도 없다. 그때 "No commits yet" 이 뜨면 저장소가 텅 빈
// 것처럼 보이고, 지정을 걸어 둔 사실을 잊었으면 되돌릴 실마리가 없다.
const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const frame = [];
  process.stdout.write = (s) => { frame.push(String(s)); return true; };
  try {
    render();
  } finally {
    process.stdout.write = _origWrite;
  }
  return stripAnsi(frame.join(''));
}

test('필터로 목록이 비면 이유와 되돌리는 길을 알려 준다', async () => {
  setup();
  state.minimized = false;
  ui.contextMenuBranch = 'develop';
  await dispatch('branch_filter');
  // develop 을 남기고, 그 줄기가 통째로 사라지도록 캐시를 갈아 끼운다.
  ui.filteredRefs = [localRefKey('gone')];
  const { rebuildLogGraphRows } = require('../refresh');
  rebuildLogGraphRows();
  assert.equal(state.logItems.length, 0, '남는 커밋이 없어야 하는 상황이다');

  const frame = captureRender();
  assert.ok(!frame.includes('No commits yet'), '저장소가 빈 것처럼 보이면 안 된다');
  assert.match(frame, /No commits match the branch filter/);
  assert.match(frame, /Clear All Filters/, '되돌리는 길이 화면에 있어야 한다');
});

test('지정이 없을 때의 빈 목록 문구는 그대로다', () => {
  setup();
  state.minimized = false;
  state.logItems = [];
  state.logSelectables = [];
  ui.filteredRefs = [];
  ui.hiddenRefs = [];
  const frame = captureRender();
  assert.match(frame, /No commits yet/);
});
