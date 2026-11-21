// 목록 내용이 바뀌어도 보던 줄이 그 자리에 남는지(scroll-anchor.js) — 브랜치 패널.
//
// 배경(2026-11-19, Com2uX prompt-p1): 브랜치 패널을 스크롤해 둔 채 보고 있으면 가끔 내용이 한 줄 튀었다.
// 창 기록에 브랜치 패널 줄 수가 열린 창 모두에서 같은 초에 하나씩 늘어 있었고(11:20:22·11:24:20·
// 11:27:29), 그 1~4초 전에 자동 fetch 가 팀원의 원격 브랜치를 하나씩 받아 왔다. 원격 브랜치는 이름순으로
// 끼어드는데 스크롤 위치는 줄 번호라, 보던 위치보다 위에 끼면 화면이 통째로 한 줄 밀렸다.
const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
const calls = [];
const COLS = 160, ROWS = 40;
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: COLS, rows: ROWS }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => { calls.push(['region', p.id]); return { scrollbar_cols: 1, scrollbar_rows: 0 }; },
    set: async p => { calls.push(['set', p.id, p.top_row]); return {}; },
    remove: async () => ({}),
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const scroll = require('../scroll');
const { lineKeys, anchorOffset } = require('../scroll-anchor');
// 그리기는 테스트가 frame() 으로 직접 한다.
scroll.init({});

function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 30));

function setup() {
  state.loading = false; state.isGitRepo = true; state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, hash: 'a' }];
  for (let i = 0; i < 40; i++) state.branches.push({ name: 'feature/topic-' + String(i).padStart(2, '0'), hash: 'b' + i });
  state.remotes = ['origin'];
  state.remoteBranches = [];
  for (let i = 0; i < 40; i++) state.remoteBranches.push('origin/feature/r' + String(i).padStart(2, '0'));
  for (let i = 0; i < 40; i++) state.remoteBranches.push('origin/release-' + String(i).padStart(2, '0'));
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  for (let i = 0; i < 6; i++) state.worktrees.push({ path: 'C:/wt/w' + i, branch: 'feature/topic-0' + i });
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.selectedFiles = new Set();
  state.mode = 'normal'; state.commitMsg = ''; state.refreshing = state.spinnerActive = false; state.error = null;
  state.rightView = 'log'; state.diffWrap = false;
  state.logItems = [{ type: 'commit', hash: '1234567', ref: '1234567', subject: 's', decoration: '', naturalWidth: 1, chars: ['*'], charColors: [0] }];
  state.logSelectables = [0]; state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1234567'];
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.collapsedDetailFiles = new Set(); ui.hoveredLeftPanelRow = -1; ui.hoveredLogRow = -1;
}

const visible = () => ui.leftPanelClickMap.map(e => (e ? e.action + ':' + (e.branch || e.group || e.section || e.path || '') : null));

// 호스트가 그 위치로 스크롤한 상태를 만든다.
async function scrolledTo(top) {
  setup();
  frame(); await settle(); frame(); await settle();
  handlers.get('scroll.update')({ id: 'left', top_row: top, left_col: 0 });
  frame(); await settle();
  assert.equal(ui.leftPanelScrollOffset, top);
  calls.length = 0;
}

test('보던 위치보다 위에 원격 브랜치가 들어오면 위치를 그만큼 옮겨 같은 줄을 보인다', async () => {
  await scrolledTo(100);
  const before = visible();
  assert.ok(before.some(k => k && k.includes('origin/release-')), '원격 브랜치 구간을 보고 있어야 한다');
  // fetch 가 팀원 브랜치를 받아 왔다 — 이름순으로 보던 위치보다 위에 낀다.
  state.remoteBranches.push('origin/feature/a-new');
  frame(); await settle();
  assert.equal(ui.leftPanelScrollOffset, 101);
  assert.deepEqual(visible(), before, '보이는 줄이 그대로여야 한다');
  assert.ok(calls.some(c => c[0] === 'set' && c[1] === 'left' && c[2] === 101), '호스트 스크롤 위치도 옮긴다');

  // 지워지면(fetch --prune) 반대로 옮긴다.
  calls.length = 0;
  state.remoteBranches = state.remoteBranches.filter(b => b !== 'origin/feature/a-new' && b !== 'origin/feature/r00');
  frame(); await settle();
  assert.equal(ui.leftPanelScrollOffset, 99);
  assert.deepEqual(visible(), before);
  assert.ok(calls.some(c => c[0] === 'set' && c[1] === 'left' && c[2] === 99));
});

test('보던 위치보다 아래에서 바뀌면 위치를 그대로 둔다', async () => {
  await scrolledTo(20);
  const before = visible();
  // 원격 브랜치 목록 끝 — 화면(20번 줄부터 한 화면)보다 한참 아래다.
  state.remoteBranches.push('origin/release-zz');
  frame(); await settle();
  assert.equal(ui.leftPanelScrollOffset, 20);
  assert.deepEqual(visible(), before);
  // 줄 수가 바뀌어 영역을 다시 등록하면 scroll.js 가 지금 위치를 다시 알린다 — 같은 위치여야 한다.
  assert.ok(!calls.some(c => c[0] === 'set' && c[1] === 'left' && c[2] !== 20), '호스트 위치를 다른 곳으로 옮기지 않는다');
});

test('맨 위에 있으면 그대로 둔다 — 새로 들어온 줄을 보인다', async () => {
  setup();
  frame(); await settle();
  assert.equal(ui.leftPanelScrollOffset, 0);
  state.branches.splice(1, 0, { name: 'aaa-new', hash: 'n' });
  frame(); await settle();
  assert.equal(ui.leftPanelScrollOffset, 0);
});

test('anchorOffset: 맨 윗줄이 사라지면 그 아래 줄에 맞추고, 같은 키는 차례로 가른다', () => {
  const keys = list => lineKeys(list, x => x);
  const prev = keys(['h', 'a', 'b', 'c', 'd', 'e']);
  // 위치 2(b)를 보던 중 a 앞에 x 가 들어왔다.
  assert.equal(anchorOffset(prev, keys(['h', 'x', 'a', 'b', 'c', 'd', 'e']), 2, 3), 3);
  // b 가 지워졌다 — 그 아래 c 가 같은 화면 줄(둘째 줄)에 남게 한다.
  assert.equal(anchorOffset(prev, keys(['h', 'a', 'c', 'd', 'e']), 2, 3), 1);
  // 같은 이름이 두 번 나오면(Pinned 와 Branches) 둘째 것은 따로 센다.
  assert.deepEqual(keys(['main', 'x', 'main']), ['main', 'x', 'main#1']);
  // 키가 없는 줄(null)은 건너뛰고, 아무 것도 못 찾으면 위치를 그대로 둔다.
  assert.equal(anchorOffset(prev, keys(['q', 'r', 's', 't', 'u', 'v']), 2, 3), 2);
  assert.equal(anchorOffset(prev, prev.slice(), 2, 3), 2);
});
