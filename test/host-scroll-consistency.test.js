// 호스트가 한 줄 스크롤할 때 내용이 튀지 않는지 — 호스트 버퍼를 흉내 내 검증한다.
//
// 호스트는 한 줄 스크롤하면 직전 프레임의 영역 내용을 한 줄 밀고, 드러나는 줄은 bank(화면 밖 여분
// 줄)에서 채운 뒤, 새 프레임이 오면 그것으로 바꾼다. 같은 내용 줄이 직전 프레임(밀린 것·bank)과 새
// 프레임에서 다르게 그려지면 그 순간 그 줄이 바뀌어 "튄다". 2026-11-18 에 실제로 겪은 두 경우:
//   - 히스토리 목록: 그래프 열 폭을 보이는 줄만 보고 정해, 갈래가 많은 구간이 들어오면 목록 전체가
//     옆으로 밀렸다(Com2uX 4,453줄을 내리는 동안 39번).
//   - 커밋 상세: 파일 이름 고정 줄을 영역 첫 줄에 겹쳐 그려, 한 줄 밀 때마다 맨 윗줄이 튀었다.
// 영역 위치·bank 위치는 플러그인이 보낸 scroll.region 파라미터(호스트가 아는 것)를 그대로 쓴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
const regions = new Map();
const COLS = 160, ROWS = 40;
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: COLS, rows: ROWS }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => { regions.set(p.id, p); return { scrollbar_cols: 1, scrollbar_rows: p.content_cols > p.width - 1 ? 1 : 0 }; },
    set: async () => ({}), remove: async () => ({}),
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const scroll = require('../scroll');
const { isWide } = require('../text');
scroll.init({});

// ── 아주 작은 터미널: 커서 이동(CSI r;c H)·SGR·글자만 해석한다. OSC·DCS(sixel)는 건너뛴다.
function paint(out) {
  const screen = new Map();
  let row = 1, col = 1, sgr = '', i = 0;
  while (i < out.length) {
    if (out.charCodeAt(i) === 0x1b) {
      const n = out[i + 1];
      if (n === '[') {
        let j = i + 2;
        while (j < out.length && !/[@-~]/.test(out[j])) j++;
        const body = out.substring(i + 2, j);
        if (out[j] === 'H') { const [r, c] = body.split(';').map(Number); row = r || 1; col = c || 1; }
        else if (out[j] === 'm') sgr = (body === '0' || body === '') ? '' : sgr + ';' + body;
        i = j + 1; continue;
      }
      if (n === ']') { const j = out.indexOf('\x07', i); i = j < 0 ? out.length : j + 1; continue; }
      if (n === 'P') { const j = out.indexOf('\x1b\\', i); i = j < 0 ? out.length : j + 2; continue; }
      i += 2; continue;
    }
    const cp = out.codePointAt(i);
    if (cp === 10 || cp === 13) { i++; continue; }
    if (!screen.has(row)) screen.set(row, new Map());
    screen.get(row).set(col, String.fromCodePoint(cp) + (sgr ? '{' + sgr + '}' : ''));
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
// 내용 줄 번호 → 그 프레임에서 그려진 모습(보이는 줄 + bank).
function strip(screen, p, base) {
  const viewH = p.height - (p.content_cols > p.width - 1 ? 1 : 0);
  const w = p.width - 1;
  const m = new Map();
  for (let i = 0; i < viewH; i++) m.set(base + i, readRow(screen, p.row + 1 + i, p.col + 1, w));
  for (let i = 0; i < p.overscan_before; i++) m.set(base - p.overscan_before + i, readRow(screen, p.overscan_row + 1 + i, p.col + 1, w));
  for (let i = 0; i < p.overscan_after; i++) m.set(base + viewH + i, readRow(screen, p.overscan_row + 1 + p.overscan_before + i, p.col + 1, w));
  return m;
}
function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 30));

// 한 줄씩 내리며, 같은 내용 줄이 직전 프레임과 다르게 그려진 것을 모은다.
async function jumpsWhileScrolling(id, steps) {
  frame(); await settle(); frame(); await settle();
  const update = handlers.get('scroll.update');
  const p = regions.get(id);
  assert.ok(p, id + ' region');
  const found = [];
  let prev = null;
  for (let top = 0; top <= steps; top++) {
    // 호스트가 위치를 알리면 플러그인은 그 위치로 다시 그린다(main 에서는 scroll.init 의 render 가 한다).
    update({ id, top_row: top, left_col: 0 });
    const out = frame();
    assert.equal(regions.get(id), p, 'top ' + top + ': 스크롤 도중 영역을 다시 등록하면 안 된다');
    assert.ok(out.includes('\x1b]7741;' + id + ';' + top + ';'), 'top ' + top + ': 그 위치로 그렸다고 알려야 한다');
    const now = strip(paint(out), p, top);
    if (prev) {
      for (const [ci, a] of prev) {
        const b = now.get(ci);
        if (b !== undefined && a !== b) found.push({ top, content: ci, before: a.trimEnd().slice(0, 60), after: b.trimEnd().slice(0, 60) });
      }
    }
    prev = now;
  }
  return found;
}

function baseState() {
  state.loading = false; state.isGitRepo = true; state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main'; state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.selectedFiles = new Set();
  state.mode = 'normal'; state.commitMsg = ''; state.refreshing = state.spinnerActive = false; state.error = null;
  state.rightView = 'log'; state.diffWrap = false;
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.collapsedDetailFiles = new Set(); ui.hoveredLogRow = -1;
}

// 구간마다 그래프 폭이 다른 목록 — 갈래가 많은 구간(폭 12)과 적은 구간(폭 2)이 번갈아 나온다.
function commits(n) {
  return Array.from({ length: n }, (_, i) => {
    const width = Math.floor(i / 25) % 2 === 0 ? 2 : 12;
    const chars = ['*'].concat(Array(width - 1).fill('|'));
    return { type: 'commit', hash: String(1000000 + i), subject: 'commit subject ' + i, decoration: '',
      naturalWidth: width, chars, charColors: chars.map(() => 0) };
  });
}
function fileDiff(name, n) {
  const out = ['diff --git a/' + name + ' b/' + name, '--- a/' + name, '+++ b/' + name, '@@ -1,' + n + ' +1,' + n + ' @@'];
  for (let i = 0; i < n; i++) out.push(' ' + name + ' line ' + i);
  return out;
}

test('히스토리 목록: 갈래가 많은 구간을 지나도 목록이 옆으로 밀리지 않는다', async () => {
  baseState();
  state.logItems = commits(200);
  state.logSelectables = state.logItems.map((_, i) => i);
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1000000'];
  const jumps = await jumpsWhileScrolling('logList', 120);
  assert.deepEqual(jumps.slice(0, 3), [], jumps.length + '줄이 스크롤 중 바뀌었다');
});

test('히스토리 목록: 포인터를 목록 위에 둔 채 스크롤해도 호버 강조 줄이 튀지 않는다', async () => {
  baseState();
  state.logItems = commits(200);
  state.logSelectables = state.logItems.map((_, i) => i);
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1000000'];
  ui.hoveredLogRow = 4; // 휠을 굴리는 동안 포인터는 목록 다섯째 줄 위에 있다
  const first = frame();
  assert.ok(/48;2;[0-9;]+m +commit subject 4\b/.test(first) || first.includes('commit subject 4'), '호버 줄이 그려진다');
  const jumps = await jumpsWhileScrolling('logList', 60);
  // 스크롤이 시작되는 순간 호버가 한 번 걷히는 것만 허용한다. 그 뒤로 강조 줄이 따라다니면 매 줄 튄다.
  assert.deepEqual(jumps.filter(j => j.top > 1).slice(0, 3), [], jumps.filter(j => j.top > 1).length + '줄이 스크롤 중 바뀌었다');
  assert.equal(ui.hoveredLogRow, -1, '스크롤하는 동안에는 호버를 걷는다');
});

test('커밋 상세: 파일 경계를 지나며 끝까지 스크롤해도 맨 윗줄이 튀지 않는다', async () => {
  baseState();
  state.logItems = commits(3);
  state.logSelectables = [0, 1, 2]; state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = ['commit 1000000', 'Author: a <a@example.com>  2026-11-18 12:00', '\u2500'.repeat(40),
    'subject', '\u2500'.repeat(40),
    ...fileDiff('src/a.js', 30), ...fileDiff('src/b.js', 3), ...fileDiff('src/c.js', 40), ...fileDiff('src/d.js', 20)];
  frame();
  const r = ui.hostScrollRegions.find(x => x.id === 'logDetail');
  const jumps = await jumpsWhileScrolling('logDetail', r.contentRows - r.height);
  assert.deepEqual(jumps.slice(0, 3), [], jumps.length + '줄이 스크롤 중 바뀌었다');
});
