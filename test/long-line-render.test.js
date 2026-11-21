// 아주 긴 한 줄이 diff 에 걸려도 그리기 비용이 그 줄 길이에 비례하지 않는지 검증한다.
//
// 배경(2026-11-18 Com2uX 실측): frontend/src/app/admin/adminScreenMessages.json 은 한 줄에 55만 자인
// 생성 파일이고 397개 커밋이 건드렸다. 그 커밋을 히스토리에서 고르거나 작업 트리 diff 로 열면
// 가로 캔버스가 55만 칸이 되어, 그리기마다 보이는 줄을 모두 그 폭까지 공백으로 채우고(side-by-side
// 는 양쪽 칸 모두), sliceLine 이 줄 전체를 글자 단위 배열로 쪼갰다. JIT 없는 Node 로 한 프레임
// 200~1,100ms — QuickJS 에서는 더 느려 입력에 화면이 한참 늦게 따라왔다.
const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 160, rows: 32 }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => ({ scrollbar_cols: 1, scrollbar_rows: p.content_cols > p.width - 1 ? 1 : 0 }),
    set: async () => ({}), remove: async () => ({}),
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const scroll = require('../scroll');
const { stripAnsi, visLen } = require('../text');
scroll.init({});

const COLS = 160;
const FILE = 'frontend/src/app/admin/adminScreenMessages.json';
const LONG = '{"k":"' + 'x'.repeat(200000) + '"}END';
const DIFF = ['diff --git a/' + FILE + ' b/' + FILE, '--- a/' + FILE, '+++ b/' + FILE, '@@ -1 +1 @@',
  '-' + LONG.replace('END', 'OLD'), '+' + LONG,
  'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,2 +1,2 @@',
  ' const a = 1;', '-const b = 2;', '+const b = 3;'];
const DETAIL = ['commit 1234567', 'Author: someone <s@example.com>  2026-11-18 12:00', '\u2500'.repeat(40),
  'merge dev', '\u2500'.repeat(40), ...DIFF];

function setup(view) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = [{ file: FILE, status: 'M' }]; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'diff'; state.diffView = view === 'side' ? 'side' : 'unified';
  state.sideDiffWrap = false; state.diffWrap = false;
  state.currentDiffFile = FILE;
  state.diffLines = DIFF.slice();
  state.cursor = 0; state.scrollOffset = 0;
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = '';
  state.refreshing = state.spinnerActive = false; state.error = null;
  ui.termCols = COLS; ui.termRows = 32; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  if (view === 'log') {
    state.rightView = 'log';
    state.logItems = [{ type: 'commit', hash: '1234567', subject: 'merge dev', graph: '*', decoration: '' }];
    state.logSelectables = [0]; state.logCursor = 0; state.logDetailLines = DETAIL.slice();
  }
  if (view === 'fresh') {
    state.rightView = 'fresh';
    state.freshItems = [{ file: FILE, status: 'M', author: 'author', date: '2026-11-18' }];
    state.freshDetailLines = DIFF.slice();
  }
}

function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setImmediate(r));
const REGION = { unified: 'diff', side: 'diff', log: 'logDetail', fresh: 'freshDetail' };

for (const view of ['unified', 'side', 'log', 'fresh']) {
  test(view + ': 줄은 보일 수 있는 폭까지만 만들고 스크롤 범위는 줄 끝까지다', async () => {
    setup(view);
    frame(); await settle();
    const out = frame();
    const r = ui.hostScrollRegions.find(x => x.id === REGION[view]);
    assert.ok(r, REGION[view]);
    assert.ok(r.contentCols > 200000, '가로 스크롤 범위는 긴 줄 끝까지여야 한다');
    // 보이는 줄과 bank 줄 모두, 스크롤 위치 + 패널 폭 + 가로 여분을 넘는 칸을 만들지 않는다.
    const bound = state.diffScrollX + r.width + scroll.depthOf(r.id).after;
    for (let i = 0; i < r.contentRows; i++) {
      const line = r.getLine(i) || '';
      assert.ok(visLen(line) <= bound, `row ${i}: ${visLen(line)} cols > ${bound}`);
    }
    // 프레임 전체도 그 줄 길이에 비례하지 않는다(예전에는 줄마다 20만 칸이 넘었다).
    assert.ok(out.length < 100000, 'frame bytes ' + out.length);
  });

  test(view + ': 끝까지 가로 스크롤하면 긴 줄의 끝이 보인다', async () => {
    setup(view);
    frame(); await settle(); frame();
    scroll.moveHorizontal(REGION[view], 1e9);
    const out = stripAnsi(frame());
    assert.ok(out.includes('END'), '스크롤 끝에서 줄 끝이 그려져야 한다');
  });
}

test('긴 줄을 자르는 비용은 줄 길이가 아니라 보이는 범위에 비례한다', () => {
  const line = '\x1b[32m' + 'x'.repeat(2000000) + '\x1b[0m';
  const started = Date.now();
  let out = '';
  for (let i = 0; i < 200; i++) out = scroll.sliceLine(line, 10, 80);
  // 예전 구현은 호출마다 200만 개짜리 토큰 배열을 만들어 이 반복에 수십 초가 걸렸다.
  assert.ok(Date.now() - started < 2000, 'elapsed ' + (Date.now() - started) + 'ms');
  assert.equal(stripAnsi(out), 'x'.repeat(80));
  assert.ok(out.startsWith('\x1b[32m'), '앞선 색 지정은 남긴다');
});

test('sliceLine 은 넓은 글자가 경계에 걸리면 공백으로 채우고 홀로 선 ESC 는 칸을 차지하지 않는다', () => {
  assert.equal(stripAnsi(scroll.sliceLine('a한b', 1, 1)), ' ');
  assert.equal(stripAnsi(scroll.sliceLine('a한b', 2, 2)), ' b');
  // 홀로 선 ESC 는 그대로 담기만 하고 칸으로 세지 않는다 — 'a', 'b' 두 칸이 다 들어온다.
  assert.equal(stripAnsi(scroll.sliceLine('a\x1bb', 0, 2)), 'a\x1bb');
  assert.equal(scroll.sliceLine('ab', 0, 4), 'ab  \x1b[0m');
});
