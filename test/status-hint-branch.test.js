// Status(왼쪽) 패널 호버 → 힌트바 검증.
//
// 패널은 폭이 좁아 추적 리모트·밀린 커밋 수·워크트리 경로를 접어두거나 색으로만 구분한다.
// 그 줄에 마우스를 올렸을 때 힌트바가 접힌 정보를 풀어주는지 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 140, rows: 40 },
  on: () => {},
  scroll: {
    region: () => Promise.resolve({ ok: true }),
    set: () => Promise.resolve({}),
    remove: () => Promise.resolve({}),
  },
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { stripAnsi } = require('../text');

const TERM_ROWS = 40;

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const frame = [];
  process.stdout.write = (s) => { frame.push(String(s)); return true; };
  try {
    render();
  } finally {
    process.stdout.write = _origWrite;
  }
  return frame.join('');
}

function hintLine(frame) {
  const marker = '\x1b[' + TERM_ROWS + ';1H';
  const idx = frame.lastIndexOf(marker);
  assert.ok(idx >= 0, '힌트바 행이 그려져야 한다');
  const rest = frame.substring(idx + marker.length);
  const next = rest.search(/\x1b\[\d+;\d+H/);
  return stripAnsi(next >= 0 ? rest.substring(0, next) : rest);
}

function setupStatus(over) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.mode = 'normal';
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.freshTimeWindowMode = false;
  state.rightView = 'diff';
  state.branch = 'main';
  state.branches = [
    { name: 'main', isCurrent: true, upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false },
    { name: 'develop', isCurrent: false, upstream: 'origin/develop', ahead: 3, behind: 4, upstreamGone: false },
    { name: 'scratch', isCurrent: false, upstream: '', ahead: 0, behind: 0, upstreamGone: false },
    { name: 'orphan', isCurrent: false, upstream: 'origin/orphan', ahead: 0, behind: 0, upstreamGone: true },
  ];
  state.remoteBranches = ['origin/main', 'origin/develop'];
  state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.diffLines = []; state.currentDiffFile = null;
  ui.termCols = 140; ui.termRows = TERM_ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.leftPanelActiveBranch = null;
  ui.leftPanelCollapsed = false; ui.pinnedBranches = [];
  ui.hoveredLeftPanelRow = -1; ui.hoveredLogRow = -1;
  Object.assign(state, over || {});
}

// 첫 렌더로 클릭맵을 얻고, 원하는 줄을 호버한 상태로 다시 그린다.
function hintForRow(match) {
  captureRender();
  const row = ui.leftPanelClickMap.findIndex(e => e && match(e));
  assert.ok(row >= 0, '대상 줄을 찾지 못했다');
  ui.hoveredLeftPanelRow = row;
  return hintLine(captureRender());
}

test('브랜치 호버 → 이름 / 추적 리모트 / push·pull 대기 순으로 보여준다', () => {
  setupStatus();
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'develop');

  const nameAt = hint.indexOf('develop');
  const upAt = hint.indexOf('origin/develop');
  const pushAt = hint.indexOf('push');
  const pullAt = hint.indexOf('pull');

  assert.ok(nameAt >= 0 && upAt > nameAt, '추적 리모트는 이름 뒤여야 한다');
  assert.ok(pushAt > upAt, 'push 대기 수는 리모트 뒤여야 한다');
  assert.match(hint, /push ↑3/, '밀 커밋 수가 보여야 한다');
  assert.match(hint, /pull ↓4/, '받을 커밋 수가 보여야 한다');
  assert.ok(pullAt > pushAt, 'push 다음에 pull이어야 한다');
});

test('리모트와 같으면 up to date로 알린다', () => {
  setupStatus();
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'main');

  assert.match(hint, /origin\/main/);
  assert.match(hint, /up to date/);
  assert.doesNotMatch(hint, /push|pull/);
});

test('현재 브랜치는 state의 ahead/behind를 따른다', () => {
  setupStatus({ ahead: 5, behind: 0 });
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'main');

  assert.match(hint, /push ↑5/, 'push 직후 갱신되는 state 값이 우선이어야 한다');
});

test('upstream이 없으면 local only로 알린다', () => {
  setupStatus();
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'scratch');

  assert.match(hint, /scratch/);
  assert.match(hint, /local only/);
  assert.doesNotMatch(hint, /→/, '추적 대상이 없으면 화살표도 없어야 한다');
});

test('upstream이 사라졌으면 [gone]으로 알린다', () => {
  setupStatus();
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'orphan');

  assert.match(hint, /origin\/orphan/);
  assert.match(hint, /\[gone\]/);
});

test('상단 브랜치명 줄도 같은 정보를 보여준다', () => {
  setupStatus({ ahead: 2, behind: 1 });
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'main');

  assert.match(hint, /main/);
  assert.match(hint, /push ↑2/);
  assert.match(hint, /pull ↓1/);
});

test('리모트 브랜치는 추적하는 로컬 브랜치를 함께 보여준다', () => {
  setupStatus();
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'origin/develop');

  assert.match(hint, /origin\/develop/);
  assert.match(hint, /← develop/, '이 리모트를 따라가는 로컬 브랜치를 짚어야 한다');
});

test('워크트리 호버 → 패널이 감춘 절대경로를 보여준다', () => {
  setupStatus();
  state.worktrees = [
    { path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true },
    { path: 'C:/work/repo-feature', branch: 'develop', isMain: false, isCurrent: false },
  ];
  const hint = hintForRow(e => e.action === 'goto-worktree' && e.path === 'C:/work/repo-feature');

  assert.match(hint, /develop/);
  assert.match(hint, /C:\/work\/repo-feature/, '경로가 보여야 한다');
});

test('다른 워크트리가 쓰는 브랜치면 어디서 쓰는지 알린다', () => {
  setupStatus();
  state.worktrees = [
    { path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true },
    { path: 'C:/work/repo-feature', branch: 'develop', isMain: false, isCurrent: false },
  ];
  const hint = hintForRow(e => e.action === 'goto-branch' && e.branch === 'develop');

  assert.match(hint, /worktree: C:\/work\/repo-feature/);
});

test('스태시 호버 → 해시 / ref / 메시지를 보여준다', () => {
  setupStatus();
  state.stashes = [{ hash: 'f'.repeat(40), shortHash: 'fff1234', ref: 'stash@{0}', message: 'WIP on main' }];
  const hint = hintForRow(e => e.action === 'goto-stash');

  const hashAt = hint.indexOf('fff1234');
  assert.ok(hashAt >= 0, '해시가 있어야 한다');
  assert.ok(hint.indexOf('stash@{0}') > hashAt);
  assert.match(hint, /WIP on main/);
});

test('섹션 헤더에는 힌트를 만들지 않는다', () => {
  setupStatus();
  const hint = hintForRow(e => e.action === 'toggle-section' && e.section === 'branches');

  assert.doesNotMatch(hint, /up to date|push|pull|local only/, '브랜치 정보가 새면 안 된다');
});

test('호버가 없으면 Status 힌트를 쓰지 않는다', () => {
  setupStatus();
  const hint = hintLine(captureRender());

  assert.doesNotMatch(hint, /up to date/);
});
