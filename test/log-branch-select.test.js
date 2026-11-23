// 히스토리(커밋 목록)에서 브랜치 이름을 눌러 브랜치를 고른다.
//
// 예전에는 줄 어디를 눌러도 그 커밋만 골랐다. 이제 줄에 그려진 브랜치 이름 위를 누르면 커밋과 함께 그
// 브랜치를 왼쪽 목록에서 누른 것처럼 고르고(접혀 있으면 펼쳐 드러낸다), Ctrl 로 더하고 빼며, 우클릭하면
// 왼쪽 목록과 같은 브랜치 메뉴가 뜬다. "develop@origin" 처럼 묶인 토큰은 앞 이름이 로컬, "@origin" 이
// 리모트 추적 브랜치다. 판정은 실제로 그린 화면에서 이름이 놓인 칸을 찾아 그 칸을 누르는 식으로 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const menus = [];
const COLS = 160, ROWS = 40;
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}), set_mouse_shape: async () => ({}) },
  initialState: { cols: COLS, rows: ROWS }, on: () => {},
  menu: { show: async opts => { menus.push(opts); return {}; } },
  scroll: {
    region: async p => ({ scrollbar_cols: 1, scrollbar_rows: p.content_cols > p.width - 1 ? 1 : 0 }),
    set: async () => ({}),
    remove: async () => ({}),
  },
};
const { state, ui, localRefKey, remoteRefKey } = require('../state');
const refresh = require('../refresh');
refresh.updateLogDetail = () => {};
refresh.refreshLog = () => {};
const { render } = require('../render');
const { handleMouseData, handleContextMenuRequest } = require('../input');
const branchSelection = require('../branch-selection');
const scroll = require('../scroll');
const { isWide } = require('../text');
const { colors } = require('../ansi');
scroll.init({});

// ── 아주 작은 터미널: 커서 이동(CSI r;c H)·글자만 해석한다. OSC·DCS(sixel)는 건너뛴다.
function paint(out) {
  const screen = new Map();
  let row = 1, col = 1, i = 0;
  while (i < out.length) {
    if (out.charCodeAt(i) === 0x1b) {
      const n = out[i + 1];
      if (n === '[') {
        let j = i + 2;
        while (j < out.length && !/[@-~]/.test(out[j])) j++;
        if (out[j] === 'H') { const [r, c] = out.substring(i + 2, j).split(';').map(Number); row = r || 1; col = c || 1; }
        i = j + 1; continue;
      }
      if (n === ']') { const j = out.indexOf('\x07', i); i = j < 0 ? out.length : j + 1; continue; }
      if (n === 'P') { const j = out.indexOf('\x1b\\', i); i = j < 0 ? out.length : j + 2; continue; }
      i += 2; continue;
    }
    const cp = out.codePointAt(i);
    if (cp === 10 || cp === 13) { i++; continue; }
    if (!screen.has(row)) screen.set(row, new Map());
    screen.get(row).set(col, String.fromCodePoint(cp));
    col += isWide(cp) ? 2 : 1;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return screen;
}
// 입력 처리가 그리는 프레임은 삼킨다 — node --test 는 결과를 stdout 으로 보낸다.
async function quiet(fn) {
  let out = '';
  const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { await fn(); await settle(); } finally { process.stdout.write = old; }
  return out;
}
function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 30));
function geometry() {
  const L = ui.lastLayout;
  return { bodyTop: L.startRow + L.titleRows + 1, rightStart: L.startCol + L.leftW + L.divider1W, width: L.startCol + L.width };
}
// 목록 i 번째 줄에서 text 가 그려진 화면 칸(1 기반) — 그 줄의 글자를 화면에서 읽어 찾는다.
function screenColOf(i, text, nth = 0) {
  const g = geometry();
  const row = paint(frame()).get(g.bodyTop + i) || new Map();
  let line = '';
  for (let c = g.rightStart; c < g.width; c++) line += row.get(c) || ' ';
  let at = -1;
  for (let k = 0; k <= nth; k++) at = line.indexOf(text, at + 1);
  assert.ok(at >= 0, `줄 ${i} 에 "${text}" 가 보여야 한다: ${line}`);
  return { col: g.rightStart + at, row: g.bodyTop + i };
}
const press = ({ col, row }, mod = 0) => quiet(() => handleMouseData(`\x1b[<${mod};${col};${row}M\x1b[<${mod};${col};${row}m`));
const hover = ({ col, row }) => quiet(() => handleMouseData(`\x1b[<35;${col};${row}M`));
const rightClick = ({ col, row }) => quiet(() => handleContextMenuRequest(col, row));
const at = (pos, dx) => ({ col: pos.col + dx, row: pos.row });
const selected = () => [...ui.selectedBranchRefs].sort();

function commit(i, extra = {}) {
  const hash = String(1000000 + i);
  return {
    type: 'commit', hash, ref: hash, subject: 'subject ' + i, decoration: '',
    naturalWidth: 1, chars: ['*'], charColors: [0], ...extra,
  };
}
function items() {
  return [
    commit(0, { decoration: ' (HEAD -> main)' }),
    commit(1, { decoration: ' (origin/develop, develop, tag: v1.0)' }),
    commit(2, { decoration: ' (origin/feature/only-remote)' }),
    commit(3, { decoration: ' (feature/login)' }),
    ...Array.from({ length: 20 }, (_, k) => commit(4 + k)),
  ];
}
function setup(list = items()) {
  state.cwd = 'C:/log-branch-select';
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true }, { name: 'develop' }, { name: 'feature/login' }];
  state.remotes = ['origin']; state.remoteBranches = ['origin/develop', 'origin/feature/only-remote'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/log-branch-select', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.selectedFiles = new Set();
  state.mode = 'normal'; state.commitMsg = ''; state.refreshing = state.spinnerActive = false; state.error = null;
  state.rightView = 'log'; state.diffWrap = false; state.focusPanel = 'status';
  state.diffScrollOffset = 0; state.diffScrollX = 0; state.logScrollX = 0;
  state.logItems = list;
  state.logSelectables = list.map((_, i) => i);
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1000000'];
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.pinnedBranches = []; ui.filteredRefs = []; ui.hiddenRefs = [];
  ui.collapsedDetailFiles = new Set(); ui.hoveredLogRow = -1; ui.hoveredLogBranch = null; ui.logScrollPin = undefined;
  ui.leftPanelCollapsed = false; ui.rightBottomCollapsed = false; ui.logListRatio = 0.5;
  ui.dragging = null; ui.branchDragCandidate = null; ui.leftPanelActiveBranch = null;
  branchSelection.reset();
  menus.length = 0;
}
async function ready(list) {
  setup(list);
  frame(); await settle(); frame(); await settle();
}
// 왼쪽 목록에서 그 브랜치 줄이 보이고 선택 배경으로 그려졌는가.
function leftRowHighlighted(refKey) {
  frame();
  const idx = ui.leftPanelClickMap.findIndex(e => e && !e.reveal && e.refKey === refKey);
  if (idx < 0) return false;
  const lines = require('../render').buildLeftPanel(ui.lastLayout.leftW, ui.lastLayout.bodyH);
  return lines[idx].includes(colors.cursorBg);
}

test('상단 detached HEAD를 클릭하면 히스토리에서 HEAD 커밋을 선택한다', async () => {
  await ready([
    commit(0, { decoration: ' (origin/HEAD, tag: HEAD)' }),
    commit(1, { decoration: ' (HEAD, tag: v1.0)' }),
  ]);
  state.branch = require('../i18n').t('git.headDetached');
  state.branches[0].isCurrent = false;
  state.rightView = 'diff';
  frame();

  await press({ col: ui.lastLayout.startCol + 1, row: geometry().bodyTop });

  assert.equal(state.rightView, 'log');
  assert.equal(state.logCursor, 1);
  assert.equal(state.diffScrollOffset, 0);
  assert.deepEqual(selected(), []);
});

test('브랜치 이름을 누르면 그 커밋과 함께 브랜치를 고른다 — 로컬 이름과 @리모트를 따로 고른다', async () => {
  await ready();
  const develop = screenColOf(1, 'develop@origin');
  await press(develop);
  assert.equal(state.logCursor, 1, '누른 줄의 커밋도 고른다');
  assert.deepEqual(selected(), [localRefKey('develop')]);
  assert.equal(ui.leftPanelActiveBranch, 'develop');
  assert.ok(leftRowHighlighted(localRefKey('develop')), '왼쪽 목록의 그 줄이 선택으로 그려진다');

  // "@origin" 의 '@' 와 리모트 이름은 리모트 추적 브랜치다.
  await press(at(develop, 'develop'.length));
  assert.deepEqual(selected(), [remoteRefKey('origin/develop')]);
  await press(at(develop, 'develop@origin'.length - 1));
  assert.deepEqual(selected(), [remoteRefKey('origin/develop')]);
  assert.ok(leftRowHighlighted(remoteRefKey('origin/develop')));

  // 현재 브랜치(HEAD -> main)도 브랜치다.
  await press(screenColOf(0, 'main'));
  assert.equal(state.logCursor, 0);
  assert.deepEqual(selected(), [localRefKey('main')]);
});

test('브랜치 이름이 아닌 칸은 예전처럼 커밋만 고른다 — 제목·태그·구분자', async () => {
  await ready();
  await press(screenColOf(1, 'develop@origin'));
  assert.deepEqual(selected(), [localRefKey('develop')]);
  await press(screenColOf(3, 'subject 3'));
  assert.equal(state.logCursor, 3);
  assert.deepEqual(selected(), [localRefKey('develop')], '제목을 누르면 브랜치 선택은 그대로다');
  await press(screenColOf(1, 'v1.0'));
  assert.equal(state.logCursor, 1);
  assert.deepEqual(selected(), [localRefKey('develop')], '태그는 고를 브랜치가 아니다');
  await press(at(screenColOf(1, 'develop@origin'), 'develop@origin'.length));  // 뒤의 ','
  assert.deepEqual(selected(), [localRefKey('develop')]);
});

test('접힌 그룹·섹션에 있는 브랜치는 펼쳐서 왼쪽 목록에 드러낸다', async () => {
  await ready();
  ui.collapsedGroups['b:feature'] = true;
  ui.collapsedSections.remotes = true;
  await press(screenColOf(3, 'feature/login'));
  assert.deepEqual(selected(), [localRefKey('feature/login')]);
  assert.equal(ui.collapsedGroups['b:feature'], false);
  assert.ok(leftRowHighlighted(localRefKey('feature/login')), '펼친 뒤 그 줄이 보이고 선택으로 그려진다');

  ui.collapsedSections.remotes = true;
  ui.collapsedGroups['r:origin'] = true;
  ui.collapsedGroups['r:origin/feature'] = true;
  await press(screenColOf(2, 'origin/feature/only-remote'));
  assert.deepEqual(selected(), [remoteRefKey('origin/feature/only-remote')]);
  assert.equal(ui.collapsedSections.remotes, false);
  assert.equal(ui.collapsedGroups['r:origin'], false);
  assert.equal(ui.collapsedGroups['r:origin/feature'], false);
  assert.ok(leftRowHighlighted(remoteRefKey('origin/feature/only-remote')));
  assert.equal(ui.leftRevealBranch, null, '드러낸 뒤에는 요청이 소모된다');
});

test('Ctrl+클릭으로 더하고 빼며, 커밋 커서는 옮기지 않는다', async () => {
  await ready();
  await press(screenColOf(1, 'develop@origin'));
  await press(screenColOf(3, 'feature/login'), 16);
  assert.deepEqual(selected(), [localRefKey('develop'), localRefKey('feature/login')].sort());
  assert.equal(state.logCursor, 1);
  await press(screenColOf(1, 'develop@origin'), 16);
  assert.deepEqual(selected(), [localRefKey('feature/login')]);
});

test('우클릭하면 브랜치 이름 위에서는 브랜치 메뉴, 그 밖에서는 커밋 메뉴를 띄운다', async () => {
  await ready();
  await rightClick(screenColOf(1, 'develop@origin'));
  assert.equal(state.logCursor, 1);
  assert.deepEqual(selected(), [localRefKey('develop')]);
  assert.equal(menus.at(-1).items[0].id, 'branch_checkout');

  await rightClick(at(screenColOf(1, 'develop@origin'), 'develop@'.length));
  assert.deepEqual(selected(), [remoteRefKey('origin/develop')]);
  assert.match(menus.at(-1).items[0].id, /^remotebranch_checkout/);

  // 고른 브랜치들 위에서 우클릭하면 그 선택 전체가 메뉴 대상이다(왼쪽 목록과 같다).
  await press(screenColOf(1, 'develop@origin'));
  await press(screenColOf(3, 'feature/login'), 16);
  await rightClick(screenColOf(3, 'feature/login'));
  assert.equal(ui.contextMenuBranches.refs.length, 2);

  await rightClick(screenColOf(1, 'subject 1'));
  assert.ok(menus.at(-1).items.some(i => i.id === 'copy_sha'), '제목 위는 커밋 메뉴다');
});

test('브랜치 이름 위에 올리면 그 이름에만 밑줄을 긋고 손가락 커서로 바꾼다', async () => {
  await ready();
  const develop = screenColOf(1, 'develop@origin');
  const out = await hover(develop);
  assert.deepEqual(ui.hoveredLogBranch, { itemIdx: 1, refKey: localRefKey('develop') });
  assert.ok(out.includes('\x1b]22;pointer\x07'), '손가락 커서');
  const drawn = frame();
  assert.ok(drawn.includes('\x1b[4mdevelop\x1b[24m'), '로컬 이름에 밑줄');
  assert.ok(!drawn.includes('\x1b[4m@origin'), '묶인 리모트에는 긋지 않는다');

  await hover(at(develop, 'develop@'.length));
  assert.deepEqual(ui.hoveredLogBranch, { itemIdx: 1, refKey: remoteRefKey('origin/develop') });
  assert.ok(frame().includes('\x1b[4m@origin\x1b[24m'));

  const off = await hover(screenColOf(1, 'subject 1'));
  assert.equal(ui.hoveredLogBranch, null);
  assert.ok(off.includes('\x1b]22;default\x07'));
  assert.ok(!frame().includes('\x1b[4mdevelop'));
});

test('가로로 넘겨 둔 위치에서도 보이는 이름을 누르면 그 브랜치다', async () => {
  const LONG = 'long subject '.repeat(14).trim();
  const list = items();
  list[1] = commit(1, { subject: LONG, decoration: ' (origin/develop, develop, tag: v1.0)' });
  await ready(list);
  assert.ok(ui.logRowGeom.canHScroll, '가로 스크롤로 그린다');
  // 맨 앞에서는 장식이 보이는 칸 밖에 있다 — 장식 바로 앞까지 넘긴다(' ' + 그래프 1칸 + ' ' + 제목 + ' ').
  assert.ok(LONG.length + 4 > ui.logRowGeom.viewW, '장식이 처음에는 화면 밖이어야 뜻이 있다');
  state.logScrollX = 3 + LONG.length + 1 - 5;
  frame(); await settle();
  const develop = screenColOf(1, 'develop@origin');
  await press(develop);
  assert.deepEqual(selected(), [localRefKey('develop')]);
  await press(at(develop, 'develop@'.length));
  assert.deepEqual(selected(), [remoteRefKey('origin/develop')]);
  // 오른쪽 끝 해시 칸은 장식이 아니다.
  await press(screenColOf(1, '1000001'));
  assert.deepEqual(selected(), [remoteRefKey('origin/develop')]);
});

test('가로 스크롤 없이 잘라 그린 줄은 보이는 글자까지만 누를 수 있다', async () => {
  const list = items();
  list[0] = commit(0, { subject: 'x'.repeat(400), decoration: ' (develop, feature/login)' });
  setup(list);
  // 목록 칸이 한 줄이면 가로 스크롤바 줄을 낼 수 없어 예전처럼 잘라 그린다.
  ui.logListRatio = 0;
  frame(); await settle(); frame();
  assert.equal(ui.logRowGeom.canHScroll, false);
  const deco = screenColOf(0, 'de\u2026');
  await press(deco);
  assert.deepEqual(selected(), [localRefKey('develop')]);
  branchSelection.reset();
  await press(at(deco, 2));  // '…'
  assert.deepEqual(selected(), []);
});
