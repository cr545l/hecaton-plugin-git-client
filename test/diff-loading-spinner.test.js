// diff/상세가 늦게 도착하는 구간의 로딩 표시 검증.
//
// 파일이나 커밋을 골라도 git 호출이 끝나야 diff가 나온다. 그 사이를 빈 화면이나
// "Select a file to view diff" 안내로 두면 고른 게 먹히지 않은 것처럼 보인다.
// → 기다리는 동안 점자 스피너로 대기 중임을 알리되, 대부분의 로드처럼 금방 끝나면
//   한 프레임 번쩍이지 않도록 유예 시간 전에는 아무것도 그리지 않는지 본다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { stripAnsi } = require('../text');
const { BRAILLE_FRAMES } = require('../title');
const { beginPanelLoading, endPanelLoading, panelLoadingLabel } = require('../spinner');

const SELECT_HINT = 'Select a file to view diff';
const LOADING = 'Loading diff...';
const LONG_AGO = 10000;   // 유예 시간을 확실히 넘긴 시작 시각
const SPINNER_FRAME_MS = 80;  // spinner.js 의 스피너 타이머 주기

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = _origWrite; }
  return stripAnsi(out.join(''));
}

function resetState() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = ['origin']; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [{ file: 'a.js', status: 'M' }];
  state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.cursor = 0; state.scrollOffset = 0;
  state.rightView = 'diff'; state.diffView = 'unified';
  state.currentDiffFile = 'a.js';
  state.diffLines = [];
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = '';
  state.spinnerActive = false; state.error = null;
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.spinnerFrame = 0;
  state.logItems = []; state.logSelectables = []; state.logCursor = 0;
  state.logScrollOffset = 0; state.logDetailLines = [];
  state.freshItems = []; state.freshCursor = 0; state.freshDetailLines = [];
  state.diffLoading = false; state.diffLoadingSince = 0;
  state.logDetailLoading = false; state.logDetailLoadingSince = 0;
  state.freshDetailLoading = false; state.freshDetailLoadingSince = 0;
  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.leftRevealBranch = null;
  ui.leftPanelActiveBranch = null; ui.hoveredLeftPanelRow = -1;
  ui.collapsedDetailFiles.clear();
}

// ── Local(diff) 패널 ──

test('로딩 중이 아니면 기존 안내가 그대로 나온다', () => {
  resetState();
  const frame = captureRender();
  assert.ok(frame.includes(SELECT_HINT));
  assert.ok(!frame.includes(LOADING));
});

test('로딩 중에는 파일을 고르라는 안내가 사라진다', () => {
  resetState();
  state.diffLoading = true;
  state.diffLoadingSince = Date.now();   // 아직 유예 시간 안
  const frame = captureRender();
  assert.ok(!frame.includes(SELECT_HINT), '고른 파일이 있는데 고르라고 하면 안 된다');
  assert.ok(!frame.includes(LOADING), '금방 끝날 로드에서 한 프레임 번쩍이면 안 된다');
});

test('로딩이 길어지면 점자 스피너로 대기 중임을 알린다', () => {
  resetState();
  state.diffLoading = true;
  state.diffLoadingSince = Date.now() - LONG_AGO;
  const frame = captureRender();
  assert.ok(frame.includes(BRAILLE_FRAMES[0] + ' ' + LOADING), '스피너 프레임 + 안내가 나와야 한다');
  assert.ok(!frame.includes(SELECT_HINT));
});

test('스피너 프레임이 한 번 도는 사이에 스피너가 나온다', () => {
  // 유예가 스피너 타이머(80ms)보다 길면 빈 화면이 한 프레임 더 보인다.
  resetState();
  state.diffLoading = true;
  state.diffLoadingSince = Date.now() - SPINNER_FRAME_MS;
  assert.ok(captureRender().includes(LOADING), '첫 스피너 프레임에서 이미 보여야 한다');
});

test('스피너는 프레임을 따라 돈다', () => {
  resetState();
  state.diffLoading = true;
  state.diffLoadingSince = Date.now() - LONG_AGO;
  state.spinnerFrame = 3;
  assert.ok(captureRender().includes(BRAILLE_FRAMES[3] + ' ' + LOADING));
});

// ── Commits 상세 ──

test('커밋 상세는 헤더가 나온 뒤에도 패치를 기다리는 동안 스피너를 붙인다', () => {
  resetState();
  state.rightView = 'log';
  state.logItems = [{
    type: 'commit', hash: '0'.repeat(40), shortHash: '0000000', ref: '0000000',
    subject: 'first', decoration: '', author: 'x', email: 'x@y', date: '2026-01-01',
    parents: [], refs: '', chars: ['\u25cf'], charColors: [0], charColorsH: [-1],
    charStyles: [0], naturalWidth: 1,
  }];
  state.logSelectables = [0];
  // updateLogDetail이 먼저 그려 두는 헤더 — 본문/패치는 아직 없다.
  state.logDetailLines = ['commit ' + '0'.repeat(40), '\u2500'.repeat(40)];
  state.logDetailLoading = true;
  state.logDetailLoadingSince = Date.now() - LONG_AGO;
  const frame = captureRender();
  assert.ok(frame.includes(BRAILLE_FRAMES[0] + ' ' + LOADING));
});

// ── Files(fresh) 상세 ──

test('Files 상세도 기다리는 동안 스피너를 보여준다', () => {
  resetState();
  state.rightView = 'fresh';
  state.freshItems = [{
    file: 'a.js', status: 'M', author: '', date: new Date().toISOString(),
    commitHash: '', commitMsg: '', isPending: true, isDeleted: false,
  }];
  state.freshDetailLoading = true;
  state.freshDetailLoadingSince = Date.now() - LONG_AGO;
  const frame = captureRender();
  assert.ok(frame.includes(BRAILLE_FRAMES[0] + ' ' + LOADING));
  assert.ok(!frame.includes(SELECT_HINT));
});

// ── 시작/종료 짝 ──

test('같은 로드를 다시 시작해도 기다린 시간은 이어진다', () => {
  resetState();
  state.diffLoading = true;
  state.diffLoadingSince = Date.now() - LONG_AGO;
  beginPanelLoading('diff');   // 커서를 빠르게 옮겨 다시 시작한 경우
  assert.ok(Date.now() - state.diffLoadingSince >= LONG_AGO, '시작 시각을 새로 잡으면 스피너가 다시 늦어진다');
  endPanelLoading('diff');
  assert.equal(state.diffLoading, false);
  assert.equal(panelLoadingLabel('diff', LOADING), null);
});

test('로드가 끝나면 스피너 대신 원래 안내가 돌아온다', () => {
  resetState();
  beginPanelLoading('diff');
  assert.equal(state.diffLoading, true);
  endPanelLoading('diff');
  assert.ok(captureRender().includes(SELECT_HINT));
});
