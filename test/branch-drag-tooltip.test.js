// 끌기 툴팁이 호스트 API(window.set_tooltip)로 나가는지 검증.
//
// 툴팁은 창이 그린다 — 터미널 격자에 얹으면 아래 내용을 지우고 화면 끝에서 잘리지만,
// 호스트에 맡기면 겹쳐 그려지고 마우스를 알아서 따라간다. 그래서 플러그인은 글자만 정한다.
//
// 여기서 지키는 것:
//   - 끌기 시작/놓을 자리 변경마다 그 자리의 결과 이름이 나간다.
//   - 같은 자리 안에서 마우스만 움직이면 RPC 를 다시 쏘지 않는다(IPC 폭주 방지).
//   - 손을 떼면 지운다 — 툴팁은 창 전역 상태라 남으면 플러그인이 사라진 뒤에도 떠 있다.
//   - 호스트가 띄워 주므로 프레임에는 툴팁을 그리지 않는다(폴백은 별도 파일에서 검증).
const test = require('node:test');
const assert = require('node:assert/strict');

const tips = [];
const dialogs = [];
global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: {
    set_title: () => Promise.resolve(),
    set_tooltip: ({ text }) => { tips.push(text); return Promise.resolve({}); },
  },
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
const tooltip = require('../tooltip');
const { stripAnsi } = require('../text');

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const frame = [];
  process.stdout.write = (s) => { frame.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = _origWrite; }
  return frame.join('');
}

function setup() {
  tips.length = 0; dialogs.length = 0;
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.mode = 'normal'; state.spinnerActive = false;
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.cwd = 'C:/repo'; state.branch = 'main';
  state.branches = [
    { name: 'main', isCurrent: true },
    { name: 'feature/branch1' },
    { name: 'feature/branch2' },
    { name: 'bugfix/hotfix' },
  ];
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set(); state.rightView = 'log';
  state.logItems = []; state.logSelectables = []; state.logCursor = 0;
  state.logScrollOffset = 0; state.logDetailLines = [];
  state.pendingDialogAction = null; state.pendingDialogTarget = null;
  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.pinnedBranches = [];
  ui.leftPanelScrollOffset = 0; ui.hoveredLeftPanelRow = -1;
  ui.hoveredLogRow = -1; ui.hoveredTitleZoneIndex = -1;
  ui.leftPanelCollapsed = false; ui.middlePanelCollapsed = false;
  ui.rightPanelCollapsed = false; ui.leftPanelActiveBranch = null;
  ui.dragging = null;
  ui.branchDragSource = null; ui.branchDropTarget = null;
  ui.branchDragCursor = null; ui.branchDragCandidate = null;
  captureRender();
  tips.length = 0;  // 준비 단계의 초기화 호출은 세지 않는다
}

function screenRowOf(match) {
  const idx = ui.leftPanelClickMap.findIndex(match);
  assert.ok(idx >= 0, '찾는 줄이 좌패널에 있어야 한다');
  const L = ui.lastLayout;
  return L.startRow + (L.titleRows || 2) + 1 + idx;
}

const COL = 5;
const press = (row, col = COL) => `\x1b[<0;${col};${row}M`;
const move = (row, col = COL) => `\x1b[<32;${col};${row}M`;
const release = (row, col = COL) => `\x1b[<0;${col};${row}m`;

test('호스트 툴팁이 있으면 그쪽으로 나간다', async () => {
  setup();
  assert.ok(tooltip.isSupported(), '이 하네스는 set_tooltip 을 제공한다');
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');

  await handleMouseData(press(from));
  assert.deepEqual(tips, [], '누르기만 해서는 아직 끌기가 아니다');

  await handleMouseData(move(to));
  assert.deepEqual(tips, ['feature/branch1 → bugfix/branch1']);

  // 호스트가 마우스를 따라 그려 주므로 프레임에는 얹지 않는다.
  const frame = stripAnsi(captureRender());
  const titleAndBody = frame.split('\n');
  assert.ok(!titleAndBody.some(l => l.includes('feature/branch1 → bugfix/branch1')
    && !l.includes('release to open')), '툴팁을 화면에 겹쳐 그리면 아래 내용이 지워진다');

  await handleMouseData(release(to));
  assert.deepEqual(tips, ['feature/branch1 → bugfix/branch1', ''], '떼면 지워야 한다');
});

test('같은 자리 안에서 움직이는 동안에는 다시 쏘지 않는다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');

  await handleMouseData(press(from));
  await handleMouseData(move(to));
  assert.equal(tips.length, 1);

  // 같은 줄에서 열만 옮긴다 — 놓을 자리도 결과 이름도 그대로다.
  await handleMouseData(move(to, COL + 3));
  await handleMouseData(move(to, COL + 6));
  assert.equal(tips.length, 1, '마우스 이동마다 RPC 를 쏘면 IPC 가 폭주한다');
  assert.deepEqual(ui.branchDragCursor, { row: to, col: COL + 6 }, '자리 자체는 따라간다');

  // 다른 그룹으로 넘어가면 그때 새 이름이 나간다.
  const root = screenRowOf(e => e && e.action === 'toggle-section' && e.section === 'branches');
  await handleMouseData(move(root));
  assert.deepEqual(tips, ['feature/branch1 → bugfix/branch1', 'feature/branch1 → branch1']);
});

test('놓을 수 없는 자리에서는 끌고 있는 이름만 띄운다', async () => {
  setup();
  const from = screenRowOf(e => e && e.action === 'goto-branch' && e.branch === 'feature/branch1');
  const to = screenRowOf(e => e && e.action === 'toggle-group' && e.group === 'b:bugfix');

  await handleMouseData(press(from));
  await handleMouseData(move(to));
  // 좌패널 밖 — 놓을 자리가 없다.
  const L = ui.lastLayout;
  await handleMouseData(move(to, L.startCol + L.leftW + 5));
  assert.deepEqual(tips, ['feature/branch1 → bugfix/branch1', 'feature/branch1']);
});
