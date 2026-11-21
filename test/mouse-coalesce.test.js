// 마우스 이동(호버)이 몰려와도 그리기가 쌓이지 않는지, 호스트 스크롤 갱신은 곧바로 그리는지 검증한다.
//
// 배경(2026-11-18 Com2uX 실측): 브랜치 64·원격 221·워크트리 31 인 저장소의 히스토리 화면에서
// 마우스 반응이 1초가량 늦었고, 같은 동작이 작은 저장소에서는 괜찮았다. 호버 이벤트마다 화면 전체를
// 곧바로 그렸기 때문에, 한 번 그리는 시간이 이벤트 간격보다 길면 밀린 이벤트가 각자 또 그리느라
// 지연이 움직인 시간만큼 불어났다(JIT 없는 Node 재현: 3ms 간격 100개에 89프레임, 마지막 이벤트
// 뒤 405ms). 이제 한 프레임 안의 요청은 한 번만 그리고, 그릴 때의 최신 상태를 그린다.
// 호스트 스크롤 갱신은 같은 방식으로 묶었다가 스크롤 중 내용이 튀어 되돌렸다 — 호스트는 받아 둔
// 여분 줄로 버티며 곧바로 올 프레임을 기다린다.
const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}), set_mouse_shape: async () => ({}) },
  initialState: { cols: 140, rows: 32 }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => ({ scrollbar_cols: 1, scrollbar_rows: p.content_cols > p.width - 1 ? 1 : 0 }),
    set: async () => ({}), remove: async () => ({}),
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const { handleMouseData } = require('../input');
const scroll = require('../scroll');
scroll.init({ render });

function setup() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'log'; state.mode = 'normal'; state.commitMsg = '';
  state.refreshing = state.spinnerActive = false; state.error = null;
  state.logItems = Array.from({ length: 60 }, (_, i) => ({
    type: 'commit', hash: String(1000000 + i), subject: 'commit ' + i, graph: '*', decoration: '',
  }));
  state.logSelectables = state.logItems.map((_, i) => i);
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1000000'];
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  ui.termCols = 140; ui.termRows = 32; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.hoveredLogRow = -1;
}

// 화면 출력(프레임)을 센다. 프레임은 ESC 로 시작한다. 그 밖의 출력은 그대로 내보낸다 — node --test 는
// 자식 프로세스의 stdout 으로 결과를 보내므로, 기다리는 동안 그것까지 삼키면 테스트 결과가 사라진다.
function countFrames() {
  const counter = { frames: 0, last: '' };
  const old = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.charCodeAt(0) === 0x1b) { counter.frames++; counter.last = chunk; return true; }
    return old.call(this, chunk, ...rest);
  };
  counter.restore = () => { process.stdout.write = old; };
  return counter;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 첫 화면을 그리고 호스트가 스크롤 영역을 확인할 때까지 기다린다 — 확인 응답도 한 번씩 그리므로
// 그것까지 끝난 뒤부터 센다.
async function settled() {
  const c = countFrames();
  try { render(); await sleep(40); render(); await sleep(40); } finally { c.restore(); }
}
const hover = (col, row) => `\x1b[<35;${col};${row}M`;

function firstLogRow() {
  const L = ui.lastLayout;
  const bodyTop = L.startRow + (L.titleRows || 2) + 1;
  const rightStart = L.startCol + L.leftW + L.divider1W;
  return { col: rightStart + 10, row: bodyTop };
}

test('몰려온 호버는 상태는 곧바로 바꾸고 그리기는 한 번만 한다', async () => {
  setup();
  await settled();
  const { col, row } = firstLogRow();
  const counter = countFrames();
  try {
    for (let k = 0; k < 20; k++) await handleMouseData(hover(col, row + (k % 10)));
    assert.equal(counter.frames, 0, '이벤트마다 그리면 밀린 이벤트가 그리기를 쌓는다');
    assert.equal(ui.hoveredLogRow, 9, '호버 상태는 마지막 이벤트 그대로여야 한다');
    await sleep(60);
    assert.equal(counter.frames, 1, '한 프레임 안의 요청은 한 번만 그린다');
  } finally { counter.restore(); }
});

test('그 사이 다른 곳에서 그리면 미뤄 둔 그리기는 버린다', async () => {
  setup();
  await settled();
  const { col, row } = firstLogRow();
  const counter = countFrames();
  try {
    await handleMouseData(hover(col, row + 3));
    render();
    assert.equal(counter.frames, 1);
    await sleep(60);
    assert.equal(counter.frames, 1, '최신 상태를 이미 그렸으니 다시 그릴 것이 없다');
  } finally { counter.restore(); }
});

test('호스트 스크롤 갱신은 미루지 않고 곧바로 그 위치를 그려 알린다', async () => {
  setup();
  await settled();
  const update = handlers.get('scroll.update');
  assert.ok(update, 'scroll.update 구독');
  const counter = countFrames();
  try {
    for (let top = 1; top <= 5; top++) {
      update({ id: 'logList', top_row: top, left_col: 0 });
      assert.equal(counter.frames, top, 'top ' + top + ': 갱신마다 곧바로 그려야 한다');
      assert.ok(counter.last.includes('\x1b]7741;logList;' + top + ';0\x07'), 'top ' + top + ': 그린 위치를 알린다');
    }
    await sleep(60);
    assert.equal(counter.frames, 5, '뒤늦게 한 번 더 그리지 않는다');
  } finally { counter.restore(); }
});
