// Commits → Local 전환 시 브랜치 그래프 sixel 잔상 검증.
//
// host-scroll이 붙으면 그래프 sixel은 화면 밖 overscan bank 행에 그려두고 호스트가 그걸
// region 안으로 합성한다. 레이아웃 전환 프레임의 CSI 2J는 "보이는 화면"만 지우므로 bank의
// 원본 픽셀은 그대로 남고, region 해제(scroll.remove)는 프레임과 순서가 보장되지 않는
// 비동기 RPC라 그 사이 호스트가 한 번 더 합성하면 새 화면 위에 그래프가 덮인다.
// → 전환 프레임이 bank 행에 지우개 sixel을 쏘는지 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');

const regionCalls = [];
const removeCalls = [];
global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  scroll: {
    region: (p) => { regionCalls.push(p); return Promise.resolve({ ok: true }); },
    set: () => Promise.resolve({}),
    remove: (p) => { removeCalls.push(p); return Promise.resolve({}); },
  },
};

const { state, ui } = require('../state');
const { render } = require('../render');
const hostScroll = require('../scroll');

const CLEAR_SIXEL_INTRO = '\x1bP0;0;0q'; // encodeSixelClear가 여는 시퀀스
const TERM_ROWS = 40;

// render()의 출력을 가로채 프레임 문자열로 모은다.
let _frame = [];
const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  _frame = [];
  process.stdout.write = (s) => { _frame.push(String(s)); return true; };
  try {
    render();
  } finally {
    process.stdout.write = _origWrite;
  }
  return _frame.join('');
}

function resetState() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logItems = [
    { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'first', author: 'x', email: 'x@y', date: '2026-01-01', parents: [], refs: '' },
    { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'second', author: 'x', email: 'x@y', date: '2026-01-02', parents: ['a'.repeat(40)], refs: '' },
  ];
  ui.termCols = 120; ui.termRows = TERM_ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.leftPanelActiveBranch = null; ui.hoveredLeftPanelRow = -1;
}

// 호스트가 region 등록을 확인해야(isReady) 그래프가 bank에 앵커된다. 확인은 RPC 응답
// 이후이므로 한 번 그리고 → 마이크로태스크를 흘려보내고 → 다시 그려야 bank 앵커가 된다.
async function renderCommitsUntilBankAnchored() {
  resetState();
  state.rightView = 'log';
  captureRender();
  await new Promise(r => setTimeout(r, 0));
  captureRender();
}

test('그래프 sixel은 화면 밖 bank 행에 앵커된다', async () => {
  await renderCommitsUntilBankAnchored();
  assert.ok(hostScroll.isReady('logList'), '호스트가 logList region을 확인해야 한다');
  const r = ui.logSixelRegion;
  assert.ok(r, '그래프 영역이 기록돼야 한다');
  assert.equal(r.anchorBank, true, 'bank 앵커여야 한다');
  assert.ok(r.screenRow > TERM_ROWS, 'bank 행은 보이는 화면(' + TERM_ROWS + '행) 밖이어야 한다: ' + r.screenRow);
});

test('Commits → Local 전환 프레임은 bank 행에 지우개 sixel을 쏜다', async () => {
  await renderCommitsUntilBankAnchored();
  const bankRow = ui.logSixelRegion.screenRow;
  const bankCol = ui.logSixelRegion.screenCol;

  state.rightView = 'diff';
  const frame = captureRender();

  assert.ok(frame.includes('\x1b[2J'), '레이아웃 전환이므로 화면 erase가 있어야 한다');
  // 2J는 보이는 화면만 지운다 — bank 행의 원본 픽셀은 지우개 sixel로만 없앨 수 있다.
  const clearIdx = frame.indexOf(CLEAR_SIXEL_INTRO);
  assert.ok(clearIdx > 0, '지우개 sixel이 있어야 한다');
  const moveTo = '\x1b[' + bankRow + ';' + bankCol + 'H';
  const moveIdx = frame.lastIndexOf(moveTo, clearIdx);
  assert.ok(moveIdx >= 0 && moveIdx < clearIdx, '지우개는 bank 행(' + bankRow + ',' + bankCol + ')에 찍혀야 한다');
  assert.equal(ui.logSixelRegion, null, '지운 뒤에는 영역 기록을 비운다');
});

test('Commits → Files 전환에서도 같은 지우개가 나간다', async () => {
  await renderCommitsUntilBankAnchored();
  state.rightView = 'fresh';
  const frame = captureRender();
  assert.ok(frame.includes(CLEAR_SIXEL_INTRO), '지우개 sixel이 있어야 한다');
  assert.equal(ui.logSixelRegion, null);
});

test('사라진 region은 호스트에서 제거된다', async () => {
  await renderCommitsUntilBankAnchored();
  removeCalls.length = 0;
  state.rightView = 'diff';
  captureRender();
  assert.ok(removeCalls.some(r => r.id === 'logList'), 'logList region이 제거돼야 한다');
});

test('Commits 안에서 계속 그릴 때는 지우개를 쏘지 않는다', async () => {
  await renderCommitsUntilBankAnchored();
  // 같은 레이아웃 · 같은 지오메트리 — 새 sixel이 이전 영역을 덮으므로 지우개는 낭비다
  // (프레임마다 지우개→텍스트→sixel을 반복하면 그래프가 깜빡인다).
  const frame = captureRender();
  assert.equal(frame.includes(CLEAR_SIXEL_INTRO), false, '깜빡임 방지를 위해 지우개가 없어야 한다');
});
