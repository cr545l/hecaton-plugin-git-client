// 히스토리(커밋 목록)의 가로 스크롤.
//
// 예전에는 줄을 패널 폭에 맞춰 잘라, 제목이 긴 커밋은 브랜치 장식이 "…"로 끊긴 채 볼 방법이 없었고
// 가로 스크롤바도 생기지 않았다. 이제 그래프·제목·장식은 자르지 않고 옆으로 넘겨 보게 호스트에 가로
// 스크롤 영역으로 맡긴다(diff 패널과 같은 방식). 해시는 넘기는 동안에도 보이는 칸의 오른쪽 끝에 붙는다.
// 넘겨 볼 폭과 스크롤바는 지금 목록 칸에 든 줄로 정한다 — 보이는 줄이 다 들어가면 스크롤바도 없다.
const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
const regions = new Map();
const sets = [];
let regionCalls = 0;
const COLS = 160, ROWS = 40;
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}), set_mouse_shape: async () => ({}) },
  initialState: { cols: COLS, rows: ROWS }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => { regionCalls++; regions.set(p.id, p); return { scrollbar_cols: 1, scrollbar_rows: p.content_cols > p.width - 1 ? 1 : 0 }; },
    set: async p => { sets.push(p); return {}; },
    remove: async () => ({}),
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const { handleMouseData } = require('../input');
const scroll = require('../scroll');
const { isWide, stripAnsi } = require('../text');
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
function readRow(screen, row1, col1, width) {
  const r = screen.get(row1);
  let s = '';
  for (let c = col1; c < col1 + width; c++) s += (r && r.get(c)) || ' ';
  return s;
}
function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 30));
// 목록의 i 번째 보이는 줄(호스트가 아는 영역 위치 기준). 오른쪽 세로 스크롤바 칸은 뺀다.
function visibleRow(out, i) {
  const p = regions.get('logList');
  return readRow(paint(out), p.row + 1 + i, p.col + 1, p.width - 1);
}
const logRegion = () => ui.hostScrollRegions.find(x => x.id === 'logList');
// 호스트가 이 프레임에서 여분 줄(bank)을 받았는가 — 영역 확인이 살아 있어야 쓴다.
const wroteBank = out => out.includes('\x1b[' + (scroll.bankRow('logList') + 1) + ';');

const LONG_BRANCH = 'feature/long-branch-name-' + 'x'.repeat(60) + '-END';
const LONG_SUBJECT = 'long subject '.repeat(8).trim();
function commit(i, extra = {}) {
  const hash = String(1000000 + i);
  const chars = extra.graphWidth ? ['*'].concat(Array(extra.graphWidth - 1).fill('|')) : ['*'];
  return {
    type: 'commit', hash, ref: hash, subject: 'commit subject ' + i, decoration: '',
    naturalWidth: chars.length, chars, charColors: chars.map(() => 0), ...extra,
  };
}

function setup(items) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main'; state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.selectedFiles = new Set();
  state.mode = 'normal'; state.commitMsg = ''; state.refreshing = state.spinnerActive = false; state.error = null;
  state.rightView = 'log'; state.diffWrap = false; state.focusPanel = 'status';
  state.diffScrollOffset = 0; state.diffScrollX = 0; state.logScrollX = 0;
  state.logItems = items;
  state.logSelectables = items.map((_, i) => i);
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1000000'];
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.collapsedDetailFiles = new Set(); ui.hoveredLogRow = -1; ui.logScrollPin = undefined;
}

// longAt 번째 커밋만 제목이 길고 브랜치 장식이 붙어 패널 폭을 넘는다. 나머지는 다 들어간다.
function longRowList(n = 80, graphWidth, longAt = 1) {
  return Array.from({ length: n }, (_, i) => commit(i, {
    ...(graphWidth ? { graphWidth, naturalWidth: graphWidth, chars: ['*'].concat(Array(graphWidth - 1).fill('|')), charColors: Array(graphWidth).fill(0) } : {}),
    ...(i === longAt ? { subject: LONG_SUBJECT, decoration: ' (origin/dev, ' + LONG_BRANCH + ')' } : {}),
  }));
}
// 해시 앞까지(앞부분)의 보이는 글자 — 오른쪽 끝 8칸(공백 + 해시 7자)을 뗀다.
const headOf = row => row.slice(0, -8);

test('넘치는 줄이 보이면 가로 스크롤 영역으로 등록하고 맨 아랫줄을 스크롤바에 내준다', async () => {
  setup(longRowList());
  frame(); await settle(); frame(); await settle();
  const r = logRegion();
  assert.ok(r.contentCols > r.width, '캔버스가 패널보다 넓어야 한다');
  const p = regions.get('logList');
  assert.equal(p.content_cols, r.contentCols);
  assert.equal(p.height, r.height + 1, '가로 스크롤바 줄을 영역에 얹는다');
  assert.equal(r.height, ui.lastLogListH - 1, '커밋 줄은 스크롤바 줄 위까지다');
  assert.equal(ui.lastLogListRows, r.height);
  // 넘겨 볼 폭은 가장 넓은 줄의 앞부분(' ' + 그래프 + ' ' + 제목 + ' ' + 장식)이 끝까지 보이는 만큼이다.
  const deco = LONG_BRANCH + ', origin/dev';
  assert.equal(r.contentCols - r.width, (1 + 1 + 1 + LONG_SUBJECT.length + 1 + deco.length) - (r.width - 8));
});

test('스크롤하기 전에도 해시는 오른쪽 끝에 있고 넘치는 앞부분은 말줄임표 없이 잘린다', async () => {
  setup(longRowList());
  frame(); await settle();
  const out = frame();
  const row0 = visibleRow(out, 0);
  assert.ok(row0.includes('commit subject 0'));
  assert.ok(row0.endsWith(' 1000000'), '해시가 오른쪽 끝: ' + JSON.stringify(row0.slice(-20)));
  const row1 = visibleRow(out, 1);
  assert.ok(row1.endsWith(' 1000001'), '넘치는 줄도 해시가 오른쪽 끝: ' + JSON.stringify(row1));
  assert.ok(!row1.includes('-END'), '스크롤하기 전에는 넘치는 부분이 보이지 않는다');
  assert.ok(!row1.includes('\u2026'), '말줄임표로 자르지 않는다');
});

test('목록 칸의 줄이 다 들어가면 가로 스크롤 영역을 만들지 않고 줄 수도 그대로다', async () => {
  setup(Array.from({ length: 80 }, (_, i) => commit(i)));
  frame(); await settle();
  const out = frame();
  const r = logRegion();
  assert.equal(r.contentCols, r.width);
  assert.equal(r.height, ui.lastLogListH, '스크롤바 줄을 내주지 않는다');
  assert.equal(regions.get('logList').height, r.height);
  assert.ok(visibleRow(out, 3).endsWith(' 1000003'));
});

test('끝까지 넘기면 브랜치 이름 끝이 해시 바로 앞에 보이고, 짧은 줄도 해시는 오른쪽 끝에 남는다', async () => {
  setup(longRowList());
  frame(); await settle(); frame(); await settle();
  const r = logRegion();
  const maxLeft = r.contentCols - r.width;
  handlers.get('scroll.update')({ id: 'logList', top_row: 0, left_col: maxLeft });
  assert.equal(state.logScrollX, maxLeft);
  const out = frame();
  assert.ok(out.includes('\x1b]7741;logList;0;' + maxLeft + '\x07'), '그린 가로 위치를 알린다');
  const row1 = visibleRow(out, 1);
  assert.ok(row1.endsWith(LONG_BRANCH + ', origin/dev 1000001'), '넘긴 끝: ' + JSON.stringify(row1));
  const row0 = visibleRow(out, 0);
  assert.ok(row0.endsWith(' 1000000'), '짧은 줄의 해시도 그대로: ' + JSON.stringify(row0));
  assert.equal(headOf(row0).trim(), '', '짧은 줄의 앞부분은 왼쪽으로 넘어갔다');
  // 호스트가 가로 스크롤 중 드러낼 여분 칸(bank 열)도 같은 줄에서 쓴다.
  assert.ok(out.includes(';' + (scroll.bankCol('logList') + 1) + 'H'));
});

test('조금 넘기면 앞부분만 옆으로 밀리고 해시는 제자리다', async () => {
  setup(longRowList());
  frame(); await settle();
  const before = visibleRow(frame(), 1);
  handlers.get('scroll.update')({ id: 'logList', top_row: 0, left_col: 5 });
  const after = visibleRow(frame(), 1);
  assert.equal(headOf(after).slice(0, -5), headOf(before).slice(5), '앞부분이 5칸 밀린다');
  assert.equal(after.slice(-8), before.slice(-8), '해시 칸은 그대로');
});

test('넘겨 볼 폭은 지금 보이는 줄로 정한다 — 긴 줄이 들어오면 생기고 나가면 없어진다', async () => {
  // 30 번째 커밋만 길다. 목록 칸에 들 때만 가로 스크롤바가 있어야 한다.
  setup(longRowList(200, 0, 30));
  frame(); await settle(); frame(); await settle();
  const listH = ui.lastLogListH;
  const seen = [];
  sets.length = 0;
  for (let top = 0; top <= 50; top++) {
    handlers.get('scroll.update')({ id: 'logList', top_row: top, left_col: 0 });
    const out = frame();
    const r = logRegion();
    const longInView = 30 >= top && 30 < top + listH;
    assert.equal(r.contentCols > r.width, longInView, 'top ' + top);
    assert.equal(regions.get('logList').content_cols, r.contentCols, 'top ' + top + ': 호스트에 알린 폭');
    assert.equal(regions.get('logList').height, listH, 'top ' + top + ': 영역 전체 높이는 그대로');
    assert.equal(ui.lastLogListRows, longInView ? listH - 1 : listH);
    // 폭만 바뀐 재등록은 호스트 확인을 버리지 않는다 — 여분 줄을 끊김 없이 계속 쓴다.
    assert.ok(wroteBank(out), 'top ' + top + ': 여분 줄을 썼다');
    seen.push(r.contentCols);
  }
  assert.ok(new Set(seen).size === 2, '폭은 두 가지(긴 줄이 보일 때와 아닐 때)');
  assert.ok(!sets.some(s => 'top_row' in s), '호스트가 옮기는 세로 위치를 되돌리지 않는다: ' + JSON.stringify(sets));
});

test('넘겨 둔 채 세로로 내려도 가로 위치를 당기지 않는다 — 폭은 왼쪽으로 되넘길 때 줄어든다', async () => {
  // 예전에는 짧은 줄 구간에 들어서면 가로 위치를 새 폭으로 당겼다. 호스트는 그 소식을 받기 전까지 예전
  // 가로 위치로 새 프레임을 밀어 그려, 빠르게 내리는 동안 해시 줄이 옆으로 어긋났다(2026-11-20 실제 창).
  setup(longRowList(200, 0, 30));
  handlers.get('scroll.update')({ id: 'logList', top_row: 20, left_col: 0 });
  frame(); await settle(); frame(); await settle();
  const maxLeft = logRegion().contentCols - logRegion().width;
  assert.ok(maxLeft > 0);
  handlers.get('scroll.update')({ id: 'logList', top_row: 20, left_col: maxLeft });
  frame();
  sets.length = 0;
  for (let top = 21; top <= 60; top++) {
    handlers.get('scroll.update')({ id: 'logList', top_row: top, left_col: maxLeft });
    const out = frame();
    assert.equal(state.logScrollX, maxLeft, 'top ' + top);
    const r = logRegion();
    assert.ok(r.contentCols - r.width >= maxLeft, 'top ' + top + ': 지금 위치를 담는 폭');
    assert.equal(ui.lastLogListRows, ui.lastLogListH - 1, 'top ' + top + ': 넘겨 둔 동안 스크롤바는 남는다');
    assert.ok(visibleRow(out, 0).endsWith(' ' + String(1000000 + top)), 'top ' + top + ': ' + JSON.stringify(visibleRow(out, 0)));
  }
  assert.deepEqual(sets, [], '세로로 내리는 동안 호스트 위치를 하나도 바꾸지 않는다');

  // 왼쪽으로 되넘기면 폭이 따라 줄고, 끝까지 돌아오면 스크롤바가 없어진다.
  handlers.get('scroll.update')({ id: 'logList', top_row: 60, left_col: 3 });
  frame();
  assert.equal(logRegion().contentCols - logRegion().width, 3);
  handlers.get('scroll.update')({ id: 'logList', top_row: 60, left_col: 0 });
  const out = frame();
  assert.equal(logRegion().contentCols, logRegion().width);
  assert.equal(ui.lastLogListRows, ui.lastLogListH);
  assert.ok(visibleRow(out, 0).startsWith('   commit subject 60'), JSON.stringify(visibleRow(out, 0)));
  assert.deepEqual(sets, []);
});

test('커서를 따라 내려가도 스크롤바가 프레임마다 생겼다 없어졌다 하지 않는다', async () => {
  // 긴 줄이 맨 윗줄에 걸리고 커서가 맨 아랫줄에 오는 자리 — 스크롤바를 두면 커서가 가려지고, 한 줄
  // 내리면 넘치는 줄이 사라진다. 어느 쪽으로 정하든 다음 프레임에서 같은 답이 나와야 한다.
  setup(longRowList(200, 0, 30));
  frame(); await settle();
  const listH = ui.lastLogListH;
  for (let c = 25; c < 30 + listH + 2; c++) {
    state.logCursor = c;
    ui.logScrollPin = undefined;
    frame();
    const a = { off: state.logScrollOffset, rows: ui.lastLogListRows, cols: logRegion().contentCols };
    frame();
    const b = { off: state.logScrollOffset, rows: ui.lastLogListRows, cols: logRegion().contentCols };
    assert.deepEqual(b, a, 'cursor ' + c);
    assert.ok(c >= a.off && c < a.off + a.rows, 'cursor ' + c + ' 가 보여야 한다: ' + JSON.stringify(a));
  }
});

test('그래프는 가로 스크롤 위치에서 보이는 칸만 잘라 패널 안에 그린다', async () => {
  setup(longRowList(80, 6));
  frame(); await settle(); frame(); await settle();
  const p = regions.get('logList');
  const panelCol1 = p.col + 1; // 1-based 패널 첫 칸
  assert.equal(ui.logSixelRegion.screenCol, panelCol1 + 1, '스크롤하지 않으면 맨 앞 공백 다음 칸');
  assert.equal(ui.logSixelRegion.pixelW, 6 * ui.cellW);

  handlers.get('scroll.update')({ id: 'logList', top_row: 0, left_col: 3 });
  frame();
  // 그래프 칸 1..6 중 3..6 이 보인다 — 패널 첫 칸부터 4칸.
  assert.equal(ui.logSixelRegion.screenCol, panelCol1);
  assert.equal(ui.logSixelRegion.pixelW, 4 * ui.cellW);

  handlers.get('scroll.update')({ id: 'logList', top_row: 0, left_col: 7 });
  const out = frame();
  assert.equal(ui.logSixelRegion, null, '그래프를 다 넘기면 sixel 을 그리지 않는다');
  assert.ok(out.includes('\x1bP0;0;0q'), '남아 있던 그래프는 지운다');
});

test('좌우 화살표·moveHorizontal 은 목록 영역을 옮긴다', async () => {
  setup(longRowList());
  frame(); await settle(); frame(); await settle();
  sets.length = 0;
  scroll.moveHorizontal('logList', 5);
  assert.equal(state.logScrollX, 5);
  assert.equal(sets.at(-1).id, 'logList');
  assert.equal(sets.at(-1).left_col, 5);
  scroll.moveHorizontal('logList', 100000);
  const r = logRegion();
  assert.equal(state.logScrollX, r.contentCols - r.width);
});

test('가로 스크롤바 줄을 눌러도 커밋을 고르지 않는다', async () => {
  setup(longRowList());
  frame(); await settle(); frame(); await settle();
  const L = ui.lastLayout;
  const bodyTop = L.startRow + L.titleRows + 1;
  const col = L.startCol + L.leftW + L.divider1W + 10;
  state.logCursor = 0;
  const sbRow = bodyTop + ui.lastLogListRows; // 커밋 줄 바로 아래 = 스크롤바 줄
  // 입력 처리가 그리는 프레임은 삼킨다 — node --test 는 결과를 stdout 으로 보낸다. 묶어 그리기
  // (requestRender, 16ms)가 늦게 그리는 것까지 기다린다.
  const click = async (row) => {
    const old = process.stdout.write;
    process.stdout.write = () => true;
    try {
      await handleMouseData(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`);
      await settle();
    } finally { process.stdout.write = old; }
  };
  await click(sbRow);
  assert.equal(state.logCursor, 0, '스크롤바 줄은 커밋 줄이 아니다');
  await click(bodyTop + 2);
  assert.equal(state.logCursor, 2, '커밋 줄은 그대로 고를 수 있다');
});
