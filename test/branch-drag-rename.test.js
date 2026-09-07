// Status 패널 브랜치 트리의 끌어 놓기 검증.
//
// 트리는 브랜치 이름의 첫 '/' 앞을 폴더처럼 묶어 보여 준다. 그래서 폴더를 옮기듯
// 브랜치를 다른 그룹에 끌어다 놓으면 그 폴더로 옮긴 이름이 된다(feature/x → bugfix/x).
// 다만 놓는 즉시 바꾸지는 않는다 — 손이 미끄러진 것과 옮기려던 것을 가를 수 없으므로
// 새 이름을 채운 리네임 창을 띄워 확인을 받는다.
//
// 여기서 지키는 것:
//   - 제자리 클릭은 그대로 클릭이다(끌기로 올라가지 않는다).
//   - 리모트 추적 브랜치는 잡히지 않는다(로컬에서 이름을 바꿀 대상이 아니다).
//   - 놓은 자리가 자기 폴더면 창을 띄우지 않는다(바꿀 게 없다).
//   - 창은 뜨기만 하고, 실제 실행은 사용자가 리네임 버튼을 누른 뒤다.
const test = require('node:test');
const assert = require('node:assert/strict');

const dialogs = [];
global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  dialog: { show: (opts) => { dialogs.push(opts); return Promise.resolve({}); } },
  scroll: {
    region: () => Promise.resolve({ ok: true }),
    set: () => Promise.resolve({}),
    remove: () => Promise.resolve({}),
  },
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { handleMouseData } = require('../input');
const { stripAnsi } = require('../text');

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const frame = [];
  process.stdout.write = (s) => { frame.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = _origWrite; }
  return frame.join('');
}

function setup() {
  dialogs.length = 0;
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.mode = 'normal';
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.spinnerActive = false;
  state.cwd = 'C:/repo'; state.branch = 'main';
  state.branches = [
    { name: 'main', isCurrent: true },
    { name: 'feature/branch1' },
    { name: 'feature/branch2' },
    { name: 'bugfix/hotfix' },
  ];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'log';
  state.logItems = []; state.logSelectables = []; state.logCursor = 0;
  state.logScrollOffset = 0; state.logDetailLines = [];
  state.pendingDialogAction = null; state.pendingDialogTarget = null;
  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.pinnedBranches = [];
  ui.leftPanelScrollOffset = 0; ui.hoveredLeftPanelRow = -1;
  ui.hoveredLogRow = -1; ui.hoveredTitleZoneIndex = -1;
  ui.leftPanelCollapsed = false; ui.middlePanelCollapsed = false;
  ui.rightPanelCollapsed = false;
  ui.leftPanelActiveBranch = null;
  ui.dragging = null;
  ui.branchDragSource = null; ui.branchDropTarget = null; ui.branchDragCandidate = null;
  captureRender();  // lastLayout / leftPanelClickMap 확보
}

// 좌패널의 이 줄이 화면 몇 행인지 — clickMap 은 본문 첫 줄부터 0 이다.
function screenRowOf(match) {
  const idx = ui.leftPanelClickMap.findIndex(match);
  assert.ok(idx >= 0, '찾는 줄이 좌패널에 있어야 한다');
  const L = ui.lastLayout;
  return L.startRow + (L.titleRows || 2) + 1 + idx;
}

const PANEL_COL = 5;  // 좌패널 안쪽 아무 열
const press = (row) => `\x1b[<0;${PANEL_COL};${row}M`;
const move = (row) => `\x1b[<32;${PANEL_COL};${row}M`;
const release = (row) => `\x1b[<0;${PANEL_COL};${row}m`;

test('브랜치를 다른 그룹으로 끌어 놓으면 새 이름이 담긴 리네임 창이 뜬다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');

  await handleMouseData(press(from));
  assert.equal(ui.dragging, null, '누르기만 해서는 끌기가 아니다');
  assert.equal(ui.branchDragCandidate.branch, 'feature/branch1');

  await handleMouseData(move(to));
  assert.equal(ui.dragging, 'branch', '다른 줄로 넘어가면 끌기가 된다');
  assert.equal(ui.branchDragSource, 'feature/branch1');
  assert.deepEqual(ui.branchDropTarget, { prefix: 'bugfix' });

  // 끌고 있는 동안 놓을 자리와 결과 이름이 화면에 드러난다.
  const frame = stripAnsi(captureRender());
  assert.ok(frame.includes('feature/branch1 → bugfix/branch1'), '힌트바에 새 이름이 보여야 한다');

  await handleMouseData(release(to));
  assert.equal(ui.dragging, null);
  assert.equal(ui.branchDragSource, null, '끌기 상태가 남으면 다음 클릭까지 하이라이트가 붙는다');
  assert.equal(dialogs.length, 1, '놓으면 리네임 창이 떠야 한다');
  assert.equal(dialogs[0].type, 'input');
  assert.equal(dialogs[0].defaultValue, 'bugfix/branch1', '새 이름이 채워져 있어야 한다');
  // 실제 실행은 메뉴의 리네임과 같은 길(rename-branch)로 간다 — 놓는 것만으로는 바뀌지 않는다.
  assert.equal(state.pendingDialogAction, 'rename-branch');
  assert.equal(state.pendingDialogTarget, 'feature/branch1');
});

test('끌고 있는 동안 마우스 옆에 툴팁이 따라붙는다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');

  await handleMouseData(press(from));
  await handleMouseData(move(to));
  assert.deepEqual(ui.branchDragCursor, { row: to, col: PANEL_COL });

  // 커서 바로 아래 줄, 커서 셀은 비운 자리에 결과 이름이 찍힌다.
  const frame = captureRender();
  const marker = `\x1b[${to + 1};${PANEL_COL + 2}H`;
  const at = frame.lastIndexOf(marker);
  assert.ok(at >= 0, '커서 아래에 툴팁이 붙어야 한다');
  const tip = stripAnsi(frame.slice(at + marker.length));
  assert.ok(tip.startsWith(' feature/branch1 → bugfix/branch1 '), '툴팁에 결과 이름이 보여야 한다: ' + JSON.stringify(tip.slice(0, 40)));

  // 마우스를 옮기면 툴팁도 따라간다.
  const other = screenRowOf(e => e && e.action === 'toggle-section' && e.section === 'branches');
  await handleMouseData(move(other));
  assert.deepEqual(ui.branchDragCursor, { row: other, col: PANEL_COL });

  await handleMouseData(release(other));
  assert.equal(ui.branchDragCursor, null, '끌기가 끝나면 툴팁 자리도 지워야 한다');
  assert.ok(!captureRender().includes(marker), '떼고 나서도 툴팁이 남으면 안 된다');
});

test('Branches 헤더에 놓으면 그룹 밖으로 뺀다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-section' && e.section === 'branches');

  await handleMouseData(press(from));
  await handleMouseData(move(to));
  assert.deepEqual(ui.branchDropTarget, { prefix: '' });
  await handleMouseData(release(to));
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].defaultValue, 'branch1');
});

test('같은 그룹 안에 놓으면 바꿀 게 없으므로 창을 띄우지 않는다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch2');

  await handleMouseData(press(from));
  await handleMouseData(move(to));
  assert.deepEqual(ui.branchDropTarget, { prefix: 'feature' });
  await handleMouseData(release(to));
  assert.equal(dialogs.length, 0, '이름이 그대로면 확인을 물을 이유가 없다');
});

test('제자리에서 떼면 평범한 클릭이다', async () => {
  setup();
  const row = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  await handleMouseData(press(row));
  await handleMouseData(release(row));
  assert.equal(ui.dragging, null);
  assert.equal(ui.branchDragCandidate, null, '후보가 남으면 다음 마우스 이동이 끌기로 올라간다');
  assert.equal(dialogs.length, 0);
});

test('리모트 추적 브랜치는 끌리지 않는다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'origin/main');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');
  await handleMouseData(press(from));
  assert.equal(ui.branchDragCandidate, null, '로컬에서 이름을 바꿀 대상이 아니다');
  await handleMouseData(move(to));
  assert.equal(ui.dragging, null);
  await handleMouseData(release(to));
  assert.equal(dialogs.length, 0);
});

test('버튼을 뗀 채 지나가는 것(hover)은 끌기가 아니다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');
  await handleMouseData(press(from));
  // cb=35 — 버튼 없이 움직이는 motion.
  await handleMouseData(`\x1b[<35;${PANEL_COL};${to}M`);
  assert.equal(ui.dragging, null, '마우스만 스쳐도 끌리면 클릭이 불가능해진다');
});
