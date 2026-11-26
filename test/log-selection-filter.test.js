// 히스토리 헤더의 "선택 필터" 토글.
//
// 우클릭 메뉴의 Filter 는 브랜치마다 따로 걸고 풀어야 한다. 줄바꿈 옆 토글을 켜 두면 지금 고른
// 브랜치(왼쪽 목록·히스토리에서 고른 것)가 곧 Filter 가 되어, 브랜치를 누를 때마다 히스토리가 그
// 브랜치만으로 바뀌어야 한다. 우클릭 Filter 와 달리 그 브랜치를 머지한 위쪽 히스토리(팁의 자손)도
// 함께 보인다. 고른 것이 없으면 평소 Filter/Hide 로 돌아가고, 끄면 선택과 상관없이
// 예전과 같아야 한다. 걸러 내기는 그리기 단계에서만 한다 — git 을 다시 부르지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');

const COLS = 200, ROWS = 40;
global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: async () => ({}), set_mouse_shape: async () => ({}) },
  initialState: { cols: COLS, rows: ROWS }, on: () => {},
  menu: { show: async () => ({}) },
  scroll: {
    region: async () => ({ ok: true }),
    set: async () => ({}),
    remove: async () => ({}),
  },
};

const { state, ui, localRefKey, remoteRefKey } = require('../state');
const refresh = require('../refresh');
let logReads = 0;
refresh.updateLogDetail = () => {};
refresh.refreshLog = () => { logReads++; };
const { render } = require('../render');
const { handleMouseData, handleKey } = require('../input');
const branchSelection = require('../branch-selection');
const { stripAnsi } = require('../text');
require('../scroll').init({});

const H = n => String(n).padStart(40, '0');

//   main tip(1)   feature tip(5)     develop tip(4)
//        \            /                    |
//         shared B(2)                      |
//               \                          |
//                +--------- base(3) -------+
function sampleCommits() {
  return [
    { hash: H(1), parents: [H(2)], refs: 'HEAD -> main, origin/main', subject: 'main tip' },
    { hash: H(5), parents: [H(2)], refs: 'feature/login', subject: 'feature tip' },
    { hash: H(4), parents: [H(3)], refs: 'develop, origin/develop', subject: 'develop tip' },
    { hash: H(2), parents: [H(3)], refs: '', subject: 'shared B' },
    { hash: H(3), parents: [], refs: '', subject: 'base' },
  ];
}
const ALL = ['main tip', 'feature tip', 'develop tip', 'shared B', 'base'];

function setup() {
  state.cwd = 'C:/selection-filter';
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [
    { name: 'main', isCurrent: true },
    { name: 'develop', isCurrent: false },
    { name: 'feature/login', isCurrent: false },
  ];
  state.remotes = ['origin']; state.remoteBranches = ['origin/main', 'origin/develop'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/selection-filter', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.selectedFiles = new Set();
  state.mode = 'normal'; state.commitMsg = ''; state.refreshing = state.spinnerActive = false; state.error = null;
  state.rightView = 'log'; state.diffWrap = false; state.focusPanel = 'status';
  state.logLoading = false; state.logLoadingMore = false; state.logLoadFailed = false; state.logLoadCancelled = false;
  state.freshTimeWindowMode = false;
  state.diffScrollOffset = 0; state.diffScrollX = 0; state.logScrollX = 0;
  state.logCursor = 0; state.logScrollOffset = 0; state.logDetailLines = [];
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.pinnedBranches = []; ui.filteredRefs = []; ui.hiddenRefs = [];
  ui.logSortMode = 'date'; ui.logShowRecovery = true; ui.logHighlight = false; ui.stashMap = new Map();
  ui.collapsedDetailFiles = new Set(); ui.hoveredLogRow = -1; ui.hoveredLogBranch = null; ui.logScrollPin = undefined;
  ui.hoveredTitleZoneIndex = -1;
  ui.leftPanelCollapsed = false; ui.rightBottomCollapsed = false; ui.logListRatio = 0.5;
  ui.dragging = null; ui.branchDragCandidate = null; ui.leftPanelActiveBranch = null;
  ui.logSelectionFilter = false;
  branchSelection.reset();
  // 캐시를 채우고(로그를 한 번 읽은 상태) 화면 목록에 반영한다.
  refresh.buildLogGraphRows(sampleCommits(), new Set());
  refresh.rebuildLogGraphRows();
  logReads = 0;
}

const shown = () => state.logItems.filter(r => r.type === 'commit').map(r => r.subject);
const pick = (...refs) => {
  branchSelection.sync();
  ui.selectedBranchRefs = new Set(refs);
};
const build = () => refresh.buildLogGraphRows(sampleCommits(), new Set()).map(r => r.subject);

function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 30));
// 입력 처리가 그리는 프레임만 삼킨다. 기다리는 동안 stdout 을 통째로 막으면 node --test 의 자식이
// 부모에게 보내는 앞 테스트 결과까지 버려져 집계에서 빠진다 — 터미널 제어 문자가 든 문자열만 버린다.
async function quiet(fn) {
  const old = process.stdout.write;
  process.stdout.write = function (s, ...rest) {
    if (typeof s === 'string' && s.includes('\x1b')) return true;
    return old.call(this, s, ...rest);
  };
  try { await fn(); await settle(); } finally { process.stdout.write = old; }
}
const press = ({ col, row }) => quiet(() => handleMouseData(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`));
function titleLine() {
  return stripAnsi(frame()).split('\n').find(l => l.includes('Sort:')) || '';
}
function toggleZone() {
  frame();
  return ui.titleClickZones.find(z => z.action === 'toggleLogSelectionFilter');
}
// 왼쪽 목록에서 그 브랜치 줄을 누른다.
async function clickLeftBranch(refKey) {
  frame();
  const idx = ui.leftPanelClickMap.findIndex(e => e && !e.reveal && e.action === 'goto-branch' && e.refKey === refKey);
  assert.ok(idx >= 0, refKey + ' 줄이 왼쪽 목록에 보여야 한다');
  const L = ui.lastLayout;
  await press({ col: L.startCol + 2, row: L.startRow + L.titleRows + 1 + idx });
}

// ── 그래프 ──

test('꺼져 있으면 브랜치를 골라도 히스토리를 거르지 않는다', () => {
  setup();
  pick(localRefKey('develop'));
  assert.deepEqual(build(), ALL);
});

test('켜면 고른 브랜치에서 닿는 커밋만 남긴다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('develop'));
  assert.deepEqual(build(), ['develop tip', 'base']);
  pick(localRefKey('main'));
  assert.deepEqual(build(), ['main tip', 'shared B', 'base'], 'HEAD -> main 도 main 으로 본다');
  pick(remoteRefKey('origin/develop'));
  assert.deepEqual(build(), ['develop tip', 'base'], '리모트 추적 브랜치도 고를 수 있다');
});

test('여럿 고르면 합집합이다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('develop'), localRefKey('feature/login'));
  assert.deepEqual(build(), ['feature tip', 'develop tip', 'shared B', 'base']);
});

test('고른 것이 없으면 우클릭으로 건 Filter/Hide 가 그대로 적용된다', () => {
  setup();
  ui.logSelectionFilter = true;
  ui.filteredRefs = [localRefKey('develop')];
  assert.deepEqual(build(), ['develop tip', 'base']);
  ui.filteredRefs = [];
  ui.hiddenRefs = [localRefKey('feature/login')];
  assert.deepEqual(build(), ['main tip', 'develop tip', 'shared B', 'base']);
});

test('고른 것이 있으면 우클릭 Filter 를 대신하고, 고른 브랜치는 Hide 로 사라지지 않는다', () => {
  setup();
  ui.logSelectionFilter = true;
  ui.filteredRefs = [localRefKey('develop')];
  ui.hiddenRefs = [localRefKey('feature/login')];
  pick(localRefKey('feature/login'));
  assert.deepEqual(build(), ['feature tip', 'shared B', 'base']);
  assert.deepEqual(ui.filteredRefs, [localRefKey('develop')], '우클릭 지정은 건드리지 않는다');
  assert.deepEqual(ui.hiddenRefs, [localRefKey('feature/login')]);
});

test('다른 저장소의 선택은 걸지 않는다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('develop'));
  state.cwd = 'C:/other-repo';
  assert.deepEqual(build(), ALL);
});

test('선택이 그래프에 건 것과 같으면 다시 그리지 않는다', () => {
  setup();
  assert.equal(refresh.syncLogSelectionFilter(), false, '꺼져 있으면 언제나 그대로');
  pick(localRefKey('develop'));
  assert.equal(refresh.syncLogSelectionFilter(), false, '꺼져 있으면 선택이 바뀌어도 그대로');
  ui.logSelectionFilter = true;
  assert.equal(refresh.syncLogSelectionFilter(), true);
  assert.deepEqual(shown(), ['develop tip', 'base']);
  assert.equal(refresh.syncLogSelectionFilter(), false, '같은 선택이면 다시 그리지 않는다');
  pick(localRefKey('develop'), localRefKey('main'));
  assert.equal(refresh.syncLogSelectionFilter(), true);
  assert.deepEqual(shown(), ['main tip', 'develop tip', 'shared B', 'base']);
  assert.equal(logReads, 0, 'git 을 다시 읽지 않는다');
});

// ── 고른 브랜치를 머지한 위쪽 히스토리 ──
//
//   main tip(10)
//        |
//   merge feature(11) ← 첫 부모 main before(12), 둘째 부모 feature tip(13)
//        |        \
//        |         \              other tip(14) — 머지 전 main 에서 딴 남의 브랜치
//   main before(12) feature tip(13)   /
//        |              |            /
//        |         feature work(16) /
//        |  _______/   ____________/
//        | /          /
//       base(15) ----'           (other 는 main before(12)에서 갈라졌다)
function mergedCommits() {
  return [
    { hash: H(10), parents: [H(11)], refs: 'HEAD -> main', subject: 'main tip' },
    { hash: H(11), parents: [H(12), H(13)], refs: '', subject: 'merge feature' },
    { hash: H(14), parents: [H(12)], refs: 'develop', subject: 'other tip' },
    { hash: H(13), parents: [H(16)], refs: 'feature/login', subject: 'feature tip' },
    { hash: H(12), parents: [H(15)], refs: '', subject: 'main before' },
    { hash: H(16), parents: [H(15)], refs: '', subject: 'feature work' },
    { hash: H(15), parents: [], refs: '', subject: 'base' },
  ];
}
const buildMerged = () => refresh.buildLogGraphRows(mergedCommits(), new Set());

test('고른 브랜치를 머지한 커밋과 그 위 히스토리도 보인다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('feature/login'));
  assert.deepEqual(buildMerged().map(r => r.subject),
    ['main tip', 'merge feature', 'feature tip', 'feature work', 'base']);
});

test('위로는 팁에서만 올라간다 — 조상에서 갈라진 남의 브랜치와 머지 받은 쪽의 이전 히스토리는 빠진다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('feature/login'));
  const subjects = buildMerged().map(r => r.subject);
  assert.ok(!subjects.includes('other tip'), 'base 에서 갈라진 남의 브랜치가 딸려 오면 안 된다');
  assert.ok(!subjects.includes('main before'), '머지 받은 쪽의 머지 전 커밋은 고른 브랜치와 상관없다');

  pick(localRefKey('develop'));
  assert.deepEqual(buildMerged().map(r => r.subject), ['other tip', 'main before', 'base'],
    '팁 위로 아무것도 없으면 예전처럼 조상만 남는다');
});

test('걸러 낸 부모는 떼어 내 머지 커밋에서 끊긴 레인이 바닥까지 늘어지지 않는다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('feature/login'));
  const rows = buildMerged();
  const merge = rows.find(r => r.subject === 'merge feature');
  assert.deepEqual(merge.parents, [H(13)], '목록에 없는 첫 부모(main before)는 뗀다');
  // 위아래가 한 줄로 이어지는 사슬이라 레인은 하나뿐이어야 한다.
  for (const r of rows) assert.equal(r.chars.join('').trim().length, 1, r.subject + ': ' + r.chars.join(''));
  assert.deepEqual(mergedCommits()[1].parents, [H(12), H(13)], '원본 캐시는 건드리지 않는다');
});

test('로그 밖(max-count 너머) 부모는 떼지 않는다 — 아래로 더 있다는 표시다', () => {
  setup();
  ui.logSelectionFilter = true;
  pick(localRefKey('feature/login'));
  const commits = mergedCommits().filter(c => c.hash !== H(15));
  const rows = refresh.buildLogGraphRows(commits, new Set());
  assert.deepEqual(rows.find(r => r.subject === 'feature work').parents, [H(15)]);
});

test('우클릭 Filter 는 예전처럼 조상만 남긴다', () => {
  setup();
  ui.filteredRefs = [localRefKey('feature/login')];
  assert.deepEqual(buildMerged().map(r => r.subject), ['feature tip', 'feature work', 'base']);
});

// ── 헤더 버튼 ──

test('히스토리 헤더의 줄바꿈 바로 오른쪽에 토글이 있고 상태를 보인다', () => {
  setup();
  assert.match(titleLine(), /Wrap: off\s*Selected only: off/);
  const zone = toggleZone();
  assert.ok(zone && zone.colEnd > zone.colStart, '클릭 영역이 등록돼야 한다');
  const wrap = ui.titleClickZones.find(z => z.action === 'toggleDiffWrap');
  assert.equal(zone.colStart, wrap.colEnd + 1, '줄바꿈 바로 옆이어야 한다');
  ui.logSelectionFilter = true;
  assert.match(titleLine(), /Selected only: on/);
});

test('히스토리가 아닌 탭에는 토글을 내지 않는다', () => {
  setup();
  for (const view of ['diff', 'fresh']) {
    state.rightView = view;
    frame();
    assert.ok(!ui.titleClickZones.some(z => z.action === 'toggleLogSelectionFilter'), view + ' 탭에 새면 안 된다');
  }
});

test('토글을 누르면 고른 브랜치만 남고, 다시 누르면 되돌아온다', async () => {
  setup();
  pick(localRefKey('develop'));
  const zone = toggleZone();
  await press({ col: zone.colStart + 1, row: zone.row });
  assert.equal(ui.logSelectionFilter, true);
  assert.deepEqual(shown(), ['develop tip', 'base']);
  await press({ col: toggleZone().colStart + 1, row: zone.row });
  assert.equal(ui.logSelectionFilter, false);
  assert.deepEqual(shown(), ALL);
  assert.equal(logReads, 0, '토글은 git 을 다시 읽지 않는다');
});

// ── 선택을 바꾸는 자리 ──

test('켜 둔 채 왼쪽 목록에서 브랜치를 누르면 히스토리가 그 브랜치만으로 바뀌고 팁을 고른다', async () => {
  setup();
  ui.logSelectionFilter = true;
  await clickLeftBranch(localRefKey('develop'));
  assert.deepEqual([...ui.selectedBranchRefs], [localRefKey('develop')]);
  assert.deepEqual(shown(), ['develop tip', 'base']);
  assert.equal(state.logItems[state.logSelectables[state.logCursor]].subject, 'develop tip');

  await clickLeftBranch(localRefKey('feature/login'));
  assert.deepEqual(shown(), ['feature tip', 'shared B', 'base']);
  assert.equal(state.logItems[state.logSelectables[state.logCursor]].subject, 'feature tip');
});

test('Esc 로 선택을 풀면 평소 히스토리로 돌아온다', async () => {
  setup();
  ui.logSelectionFilter = true;
  await clickLeftBranch(localRefKey('develop'));
  assert.deepEqual(shown(), ['develop tip', 'base']);
  await quiet(() => handleKey('\x1b'));
  assert.equal(ui.selectedBranchRefs.size, 0);
  assert.deepEqual(shown(), ALL);
  assert.equal(state.logItems[state.logSelectables[state.logCursor]].subject, 'develop tip', '보던 커밋은 그대로 고른다');
});

test('선택 필터로 비면 선택 필터를 푸는 길을 적는다', () => {
  setup();
  ui.logSelectionFilter = true;
  // 고른 브랜치의 팁이 읽어 둔 범위 밖이라 그릴 커밋이 없다.
  state.branches.push({ name: 'old', isCurrent: false });
  pick(localRefKey('old'));
  refresh.syncLogSelectionFilter();
  assert.deepEqual(shown(), []);
  const text = stripAnsi(frame());
  assert.ok(text.includes('No commits match the branch filter'));
  assert.ok(text.includes("Turn off 'Selected only'"), '선택 필터를 끄는 길을 적어야 한다');
  assert.ok(!text.includes('Clear All Filters'), '우클릭 메뉴로는 풀리지 않는다');
});
