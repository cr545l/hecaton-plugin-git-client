// 포커스가 diff/detail 쪽으로 옮겨가도 목록의 선택 표시가 남는지 검증.
//
// 상세 영역을 클릭하면 focusPanel 이 'diff' 가 된다. 예전에는 그때 목록의 선택 줄 배경을
// 통째로 지워서, 고른 대상이 그대로인데도 선택이 풀린 것처럼 보였다.
// → 선택은 유지하고 배경만 흐린 색(cursorBgInactive)으로 바뀌는지 본다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 160, rows: 40 },
  on: () => {},
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { colors } = require('../ansi');

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = _origWrite; }
  return out.join('');
}

function resetState() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = ['origin']; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [{ file: 'a.js', status: 'M' }, { file: 'b.js', status: 'M' }];
  state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.cursor = 0; state.scrollOffset = 0;
  state.rightView = 'diff'; state.diffView = 'unified';
  state.currentDiffFile = 'a.js'; state.diffLines = [];
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = '';
  state.spinnerActive = false; state.error = null;
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.diffLoading = false; state.logDetailLoading = false; state.freshDetailLoading = false;
  state.logItems = [{
    type: 'commit', hash: '0'.repeat(40), shortHash: '0000000', ref: '0000000',
    subject: 'first', decoration: '', author: 'x', email: 'x@y', date: '2026-01-01',
    parents: [], refs: '', chars: ['\u25cf'], charColors: [0], charColorsH: [-1],
    charStyles: [0], naturalWidth: 1,
  }];
  state.logSelectables = [0]; state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit ' + '0'.repeat(40)];
  state.freshItems = [{
    file: 'a.js', status: 'M', author: '', date: new Date().toISOString(),
    commitHash: '', commitMsg: '', isPending: true, isDeleted: false,
  }];
  state.freshCursor = 0; state.freshScrollOffset = 0; state.freshDetailLines = [];
  state.focusPanel = 'status';
  ui.termCols = 160; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.leftRevealBranch = null;
  ui.leftPanelActiveBranch = null; ui.hoveredLeftPanelRow = -1;
  ui.hoveredFileRow = -1; ui.hoveredLogRow = -1; ui.hoveredFreshRow = -1;
  ui.collapsedDetailFiles.clear();
}

// 포커스만 바꿔 가며 두 프레임을 얻는다.
function framesForView(rightView) {
  resetState();
  state.rightView = rightView;
  const focusedFrame = captureRender();
  state.focusPanel = 'diff';
  const blurredFrame = captureRender();
  return { focusedFrame, blurredFrame };
}

for (const [label, view] of [['Files(diff) 파일 목록', 'diff'], ['Commits 목록', 'log'], ['Files 목록', 'fresh']]) {
  test(label + '의 선택은 포커스가 옮겨가도 남는다', () => {
    const { focusedFrame, blurredFrame } = framesForView(view);
    assert.ok(focusedFrame.includes(colors.cursorBg), '포커스가 있을 때는 진한 선택 배경');
    assert.ok(!focusedFrame.includes(colors.cursorBgInactive), '포커스가 있는데 흐린 배경을 쓰면 안 된다');
    assert.ok(blurredFrame.includes(colors.cursorBgInactive), '포커스를 잃어도 선택 줄은 남아야 한다');
  });
}

test('두 배경색은 서로 다른 값이어야 구분된다', () => {
  assert.notEqual(colors.cursorBg, colors.cursorBgInactive);
});
