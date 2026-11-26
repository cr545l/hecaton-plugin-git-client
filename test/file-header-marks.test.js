// 파일 목록 헤더의 [모두]·[스테이지] 버튼 앞 기호.
//
// 한국어 라벨은 "모두" "스테이지" 두 단어라, 버튼 둘이 나란히 있으면 "모두 스테이지" 라는 버튼
// 하나처럼 읽혔다. 전부를 옮기는 버튼에는 *, 고른 파일만 옮기는 버튼에는 ✓(목록에서 다중 선택한
// 파일에 붙는 표시와 같은 기호)를 붙여 가른다. 기호는 라벨의 일부라 누를 수 있는 자리에도 든다.
const test = require('node:test');
const assert = require('node:assert/strict');
const COLS = 140, ROWS = 30;
const gitCalls = [];
global.hecaton = {
  fs: {}, terminal: {}, window: { set_title: async () => ({}), set_mouse_shape: async () => ({}) },
  process: {
    exec: async (p) => { gitCalls.push(p); return { ok: true, exit_code: 0, stdout: '', stderr: '' }; },
    spawn: async (p) => { gitCalls.push(p); return { ok: false }; },
  },
  initialState: { cols: COLS, rows: ROWS }, on: () => {},
  menu: { show: async () => ({}) },
  dialog: { show: async () => ({}) },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const { handleMouseData } = require('../input');
const { isWide, visLen } = require('../text');
const { t, setLocale } = require('../i18n');

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
// from..to 칸에 그려진 글자. 넓은 글자가 차지한 둘째 칸은 건너뛴다.
function cellsText(screen, row, from, to) {
  const cells = screen.get(row) || new Map();
  let s = '';
  for (let c = from; c <= to; c++) if (cells.has(c)) s += cells.get(c);
  return s;
}
function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
// 입력 처리가 그리는 프레임(ESC 로 시작)만 버린다 — 테스트 러너의 보고는 흘려보낸다.
async function quiet(fn) {
  const old = process.stdout.write;
  process.stdout.write = function (s, ...rest) {
    if (typeof s === 'string' && s.charCodeAt(0) === 0x1b) return true;
    return old.call(process.stdout, s, ...rest);
  };
  try { await fn(); await new Promise(r => setTimeout(r, 20)); } finally { process.stdout.write = old; }
}

function reset() {
  Object.assign(state, {
    loading: false, isGitRepo: true, gitNotFound: false, minimized: false, error: null,
    operationState: null, conflictView: null, indexLocked: false,
    branch: 'main', branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }],
    remoteBranches: ['origin/main'], remotes: ['origin'], stashes: [],
    worktrees: [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }],
    isLinkedWorktree: false, ahead: 0, behind: 0,
    staged: [{ file: 'staged.txt', status: 'M' }],
    unstaged: [{ file: 'changed.txt', status: 'M' }], untracked: [], ignored: [],
    selectedFiles: new Set(), cursor: 0, scrollOffset: 0, filesScrollX: 0,
    rightView: 'diff', diffView: 'unified', currentDiffFile: 'changed.txt', diffLines: [],
    diffScrollOffset: 0, diffScrollX: 0, diffLoading: false, mode: 'normal', commitMsg: '',
  });
  Object.assign(ui, {
    termCols: COLS, termRows: ROWS, cellW: 8, cellH: 16,
    collapsedSections: {}, collapsedGroups: {}, collapsedFileDirs: {}, fileTreeView: false,
    leftPanelCollapsed: false, middlePanelCollapsed: false, rightPanelCollapsed: false,
    hoveredFileHeaderIdx: -1, hoveredFileRow: -1, hoveredTitleZoneIndex: -1,
  });
}

// 헤더 버튼 존 → 화면 칸. 존은 패널 기준 열·목록 줄 번호로 적혀 있다.
function zoneCells(action) {
  const zone = ui.fileHeaderZones.find(z => z.action === action);
  assert.ok(zone, action + ' 버튼이 없다');
  const L = ui.lastLayout;
  const midStart = L.startCol + L.leftW + L.divider1W;
  const row = L.startRow + L.titleRows + 1 + zone.lineIdx - state.scrollOffset;
  return { row, from: midStart + zone.btnColStart, to: midStart + zone.btnColEnd };
}

for (const locale of ['ko', 'en']) {
  test(`${locale}: 헤더 버튼마다 기호가 붙는다 — 전부는 *, 고른 것은 ✓`, () => {
    setLocale(locale);
    reset();
    const screen = paint(frame());
    const expected = {
      stageAll: '*' + t('ui.stageAllBtn'),
      stageSelected: '✓' + t('menu.stage'),
      unstageAll: '*' + t('ui.unstageAll'),
      unstageSelected: '✓' + t('menu.unstage'),
    };
    for (const [action, label] of Object.entries(expected)) {
      const c = zoneCells(action);
      // 누를 수 있는 자리 = 그려진 라벨(기호 포함) 그대로여야 한다. 기호만 존 밖에 있으면 기호를 눌러도
      // 아무 일이 없다.
      assert.equal(cellsText(screen, c.row, c.from, c.to), label, action + ' 버튼의 그려진 모양과 존이 다르다');
      assert.equal(c.to - c.from + 1, visLen(label));
    }
    // 두 버튼 사이는 한 칸 띄운다 — 기호가 앞 단어에 붙지 않고 뒤 단어에 붙어야 덩어리가 갈린다.
    const all = zoneCells('stageAll'), sel = zoneCells('stageSelected');
    assert.equal(sel.from, all.to + 2);
    assert.equal(cellsText(screen, all.row, all.from, sel.to), expected.stageAll + ' ' + expected.stageSelected);
    setLocale('en');
  });
}

test('기호 칸을 눌러도 그 버튼이 눌린다', async () => {
  setLocale('ko');
  reset();
  frame();
  const c = zoneCells('stageAll');
  gitCalls.length = 0;
  await quiet(() => handleMouseData(`\x1b[<0;${c.from};${c.row}M\x1b[<0;${c.from};${c.row}m`));
  assert.ok(gitCalls.length > 0, '[*모두] 의 * 를 누르면 모두 스테이지가 돌아야 한다');
  setLocale('en');
});

test('좁은 스테이지 패널에서도 헤더 버튼이 패널 안에 머문다', () => {
  setLocale('ko');
  reset();
  ui.termCols = 90;
  frame();
  const middleW = ui.lastLayout.middleW;
  for (const zone of ui.fileHeaderZones) {
    assert.ok(zone.btnColEnd < middleW, `${zone.action} 가 패널 밖으로 밀렸다 (${zone.btnColEnd} / ${middleW})`);
  }
  setLocale('en');
});
