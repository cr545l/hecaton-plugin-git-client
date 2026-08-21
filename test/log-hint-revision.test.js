// 히스토리 힌트바 검증.
//
// 로그 리스트의 리비전에 마우스를 올리면 하단 힌트바가 그 리비전을 미리 보여주고,
// 올리지 않은 동안에는 현재 선택된 리비전을 보여준다.
// 표시 순서(해시 → 커밋일시 → 커미터)와 두 소스(hover/selection)의 전환을 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  scroll: {
    region: () => Promise.resolve({ ok: true }),
    set: () => Promise.resolve({}),
    remove: () => Promise.resolve({}),
  },
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { formatDateTime } = require('../refresh');
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

// 프레임에서 힌트바(마지막 행) 텍스트만 뽑는다 — 다음 커서 이동 전까지가 그 행이다.
function hintLine(frame) {
  const marker = '\x1b[' + TERM_ROWS + ';1H';
  const idx = frame.lastIndexOf(marker);
  assert.ok(idx >= 0, '힌트바 행이 그려져야 한다');
  const rest = frame.substring(idx + marker.length);
  const next = rest.search(/\x1b\[\d+;\d+H/);
  return stripAnsi(next >= 0 ? rest.substring(0, next) : rest);
}

function commitRow(n, over) {
  return Object.assign({
    type: 'commit',
    hash: n.repeat(40),
    ref: n.repeat(7),
    parents: [],
    subject: 'subject ' + n,
    decoration: '',
    chars: ['\u25cf'], charColors: [0], charColorsH: [-1], charStyles: [0],
    commitLane: 0, naturalWidth: 1,
    authorName: 'author-' + n, authorEmail: 'author@x.dev', authorDate: '2026-01-01T00:00:00+09:00',
    committerName: 'committer-' + n, committerEmail: n + '@example.com',
    committerDate: '2026-0' + (n === 'a' ? '3' : '4') + '-0' + (n === 'a' ? '1' : '2') + 'T11:22:33+09:00',
    isRecovery: false, recoveryRef: null,
  }, over || {});
}

// 커밋 두 개 + 그래프 전용 행 하나짜리 히스토리.
function setupLogView() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.mode = 'normal';
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.freshTimeWindowMode = false;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'log';
  state.logItems = [
    commitRow('a'),
    { type: 'graph', chars: ['\u2502'], charColors: [0], charColorsH: [-1], charStyles: [0], naturalWidth: 1 },
    commitRow('b'),
  ];
  state.logSelectables = [0, 2];
  state.logCursor = 0;
  state.logScrollOffset = 0;
  state.logDetailLines = [];
  ui.termCols = 120; ui.termRows = TERM_ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.hoveredLeftPanelRow = -1;
  ui.hoveredLogRow = -1;
}

test('호버가 없으면 선택된 리비전을 보여준다', () => {
  setupLogView();
  const hint = hintLine(captureRender());

  assert.match(hint, /aaaaaaa/, '선택된 커밋의 해시가 있어야 한다');
  assert.match(hint, /committer-a/, '커미터 이름이 있어야 한다');
  assert.match(hint, /a@example\.com/, '커미터 이메일이 있어야 한다');
  assert.ok(hint.includes(formatDateTime(state.logItems[0].committerDate)), '커밋일시가 있어야 한다');
});

test('해시 → 커밋일시 → 커미터 순으로 놓인다', () => {
  setupLogView();
  const hint = hintLine(captureRender());
  const date = formatDateTime(state.logItems[0].committerDate);

  const hashAt = hint.indexOf('aaaaaaa');
  const dateAt = hint.indexOf(date);
  const nameAt = hint.indexOf('committer-a');

  assert.ok(hashAt >= 0 && dateAt > hashAt, '커밋일시는 해시 뒤여야 한다');
  assert.ok(nameAt > dateAt, '커미터는 커밋일시 뒤여야 한다');
  assert.equal(hint.trimStart().indexOf('aaaaaaa'), 0, '해시가 맨 왼쪽이어야 한다');
});

test('리비전에 호버하면 그 리비전으로 바뀐다', () => {
  setupLogView();
  ui.hoveredLogRow = 2;   // 화면 3번째 행 = logItems[2] (커밋 b)
  const hint = hintLine(captureRender());

  assert.match(hint, /bbbbbbb/, '호버한 커밋의 해시여야 한다');
  assert.match(hint, /committer-b/);
  assert.doesNotMatch(hint, /aaaaaaa/, '선택된 커밋 정보는 물러나야 한다');
});

test('커밋이 아닌 그래프 행에 호버하면 선택된 리비전을 유지한다', () => {
  setupLogView();
  ui.hoveredLogRow = 1;   // 그래프 전용 행
  const hint = hintLine(captureRender());

  assert.match(hint, /aaaaaaa/, '선택된 커밋이 그대로 보여야 한다');
});

test('스크롤된 상태에서도 호버 행이 실제 리비전과 맞는다', () => {
  setupLogView();
  // 스크롤이 실제로 걸리도록 목록을 화면보다 길게 채운다.
  for (let i = 0; i < 80; i++) {
    state.logSelectables.push(state.logItems.length);
    state.logItems.push(commitRow('c'));
  }
  state.logScrollOffset = 2;
  state.logCursor = 0;      // 선택은 커밋 a로 두고 화면 첫 행에는 커밋 b가 오게 한다
  ui.logScrollPin = state.logCursor;   // 커서 추적으로 오프셋이 되돌려지지 않게 고정
  ui.hoveredLogRow = 0;     // 화면 첫 행 = logItems[2]
  const hint = hintLine(captureRender());

  assert.match(hint, /bbbbbbb/, '스크롤 오프셋을 더한 항목이어야 한다');
});

test('히스토리 뷰가 아니면 리비전 힌트를 쓰지 않는다', () => {
  setupLogView();
  state.rightView = 'diff';
  const hint = hintLine(captureRender());

  assert.doesNotMatch(hint, /aaaaaaa/, '다른 뷰의 힌트바를 건드리면 안 된다');
});

test('에러/토스트 메시지가 리비전 힌트보다 우선한다', () => {
  setupLogView();
  state.error = 'Pushing...';
  const hint = hintLine(captureRender());

  assert.match(hint, /Pushing/, '메시지가 보여야 한다');
  assert.doesNotMatch(hint, /aaaaaaa/);
});

test('쓰기 작업 진행 메시지는 힌트바를 차지하지 않는다 — 타이틀이 맡는다', () => {
  setupLogView();
  state.spinnerActive = true;
  state.error = 'Pushing...';
  const hint = hintLine(captureRender());
  state.spinnerActive = false;
  state.error = null;

  assert.doesNotMatch(hint, /Pushing/, '진행 메시지는 창 타이틀로 옮겨졌다');
  assert.match(hint, /aaaaaaa/, '작업 중에도 리비전 힌트가 그대로 보여야 한다');
});

// 좁은 터미널에서는 committer 영역과 겹치지 않게 뒤쪽부터 접혀야 한다.
test('폭이 좁으면 이메일부터 접힌다', () => {
  setupLogView();
  state.committerName = 'me'; state.committerEmail = 'me@example.com';
  ui.termCols = 60;
  const hint = hintLine(captureRender());

  assert.match(hint, /aaaaaaa/, '해시는 남아야 한다');
  assert.doesNotMatch(hint, /a@example\.com/, '이메일은 접혀야 한다');
  assert.ok(stripAnsi(hint).length <= 60, '힌트바가 터미널 폭을 넘으면 안 된다');
});
