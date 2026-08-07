// 커밋 메시지 폼 오른쪽의 지우기 버튼([X]) 검증.
//
// 버튼은 메시지 첫 줄 위에 얹히므로 두 가지가 어긋나기 쉽다.
//  1) 메시지 본문이 버튼 자리까지 밀고 들어와 겹치는 것
//  2) IME 조합 커서 — 렌더가 쓴 폭과 커서 계산의 폭(rightW - 2)이 달라 커서가 딴 데 찍히는 것
// 아래 테스트가 그 둘을 고정한다.
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

// staged 파일이 있는 diff 뷰의 커밋 모드 — 커밋 영역이 그려지는 상태.
function setupCommitMode(msg) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.commitAmend = false;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [{ file: 'a.txt', status: 'M' }];
  state.unstaged = []; state.untracked = []; state.ignored = [];
  state.diffLines = []; state.currentDiffFile = 'a.txt';
  state.rightView = 'diff';
  state.mode = 'commit';
  state.commitMsg = msg;
  state.commitCursor = msg.length;
  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.hoveredCommitClear = false;
}

test('메시지가 있으면 지우기 버튼과 클릭 존이 생긴다', () => {
  setupCommitMode('fix: 오타 수정');
  const frame = captureRender();

  assert.match(frame, /\[X\]/, '버튼이 그려져야 한다');
  assert.ok(ui.commitClearZone, '클릭 존이 있어야 한다');
  assert.equal(ui.commitClearZone.colEnd - ui.commitClearZone.colStart + 1, 3, '[X] 3칸이어야 한다');
});

test('메시지가 비면 버튼이 사라진다', () => {
  setupCommitMode('');
  const frame = captureRender();

  assert.equal(ui.commitClearZone, null, '지울 게 없으면 존도 없어야 한다');
  assert.doesNotMatch(frame, /\[X\]/);
});

test('커밋 모드가 아니면 버튼이 없다', () => {
  setupCommitMode('fix: 오타 수정');
  state.mode = 'normal';
  captureRender();

  assert.equal(ui.commitClearZone, null);
});

// 본문이 길어도 버튼 자리를 침범하면 안 된다.
test('긴 메시지가 버튼을 덮지 않는다', () => {
  setupCommitMode('x'.repeat(400));
  const frame = captureRender();

  assert.ok(ui.commitClearZone, '존이 있어야 한다');
  assert.match(frame, /\[X\]/, '버튼이 잘리지 않아야 한다');
  // 버튼 시작 컬럼이 본문 끝보다 뒤여야 겹치지 않는다.
  const bodyEnd = 1 + ui.commitMsgCursorMaxW;
  assert.ok(ui.commitClearBtnOffset >= bodyEnd,
    '버튼(' + ui.commitClearBtnOffset + ')이 본문 끝(' + bodyEnd + ') 뒤여야 한다');
});

// 폭이 어긋나면 조합 중인 한글이 엉뚱한 칸에 찍힌다.
test('커서 폭은 버튼이 양보받은 폭과 같다', () => {
  setupCommitMode('한글 입력 중');
  captureRender();
  const withBtn = ui.commitMsgCursorMaxW;

  setupCommitMode('');
  captureRender();
  const withoutBtn = ui.commitMsgCursorMaxW;

  assert.ok(withBtn > 0 && withoutBtn > 0, '두 경우 모두 폭이 기록돼야 한다');
  assert.equal(withoutBtn - withBtn, 4, '버튼([X]=3) + 간격(1) 만큼만 좁아야 한다');
});

// 버튼은 첫 줄에만 얹힌다 — 아래 줄까지 좁히면 글자가 이유 없이 잘린다.
test('두 번째 줄부터는 폭을 양보하지 않는다', () => {
  setupCommitMode('first line\nsecond line');
  state.commitCursor = state.commitMsg.length;   // 커서를 둘째 줄에 둔다
  captureRender();
  const secondLineW = ui.commitMsgCursorMaxW;

  setupCommitMode('only line');
  captureRender();
  const firstLineW = ui.commitMsgCursorMaxW;

  assert.equal(secondLineW - firstLineW, 4, '둘째 줄은 버튼 자리를 비워둘 이유가 없다');
});

test('호버하면 버튼 색이 바뀐다', () => {
  setupCommitMode('fix: 오타 수정');
  const plain = captureRender();
  ui.hoveredCommitClear = true;
  const hovered = captureRender();

  assert.notEqual(plain, hovered, '호버 상태가 렌더에 반영돼야 한다');
  const idx = hovered.indexOf('[X]');
  assert.ok(idx > 0);
  assert.match(hovered.substring(Math.max(0, idx - 20), idx), /\x1b\[4m/, '호버 시 밑줄이 그어져야 한다');
});
