// 상태 탭 타이틀의 "차이" 접기 버튼과, 접었을 때 커밋 메시지 영역이 스테이지 아래로 옮겨 가는 것.
//
// 차이 패널을 접으면 그 아래에 붙어 있던 커밋 메시지 영역도 함께 사라져 커밋을 쓸 수 없었다. 이제
// 차이를 접으면 커밋 영역을 스테이지(파일 목록) 패널 아래에 그린다. 입력 줄·Commit 버튼·amend 토글·
// IME 커서는 모두 커밋 영역이 실제로 그려진 자리를 따라야 하므로, 판정은 그린 화면에서 글자를 찾아
// 그 칸을 누르는 식으로 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const COLS = 140, ROWS = 36;
// 헤더 버튼([모두 언스테이지] 등)이 눌렸는지는 git 이 실행되려 했는지로 본다.
const gitCalls = [];
const gitResult = { ok: true, exit_code: 0, stdout: '', stderr: '' };
global.hecaton = {
  fs: {}, terminal: {}, window: { set_title: async () => ({}), set_mouse_shape: async () => ({}) },
  process: {
    exec: async (p) => { gitCalls.push(p); return gitResult; },
    spawn: async (p) => { gitCalls.push(p); return { ok: false }; },
  },
  initialState: { cols: COLS, rows: ROWS }, on: () => {},
  menu: { show: async () => ({}) },
  dialog: { show: async () => ({}) },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const { handleMouseData } = require('../input');
const { isWide } = require('../text');
const { t } = require('../i18n');

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
function rowText(screen, row, from = 1, to = COLS) {
  const cells = screen.get(row) || new Map();
  let s = '';
  for (let c = from; c <= to; c++) s += cells.has(c) ? cells.get(c) : (s.length && isWide(s.codePointAt(s.length - 1)) ? '' : ' ');
  return s;
}
// 화면에서 text 가 처음 나오는 칸. 본문 행만 훑는다 — 타이틀 행의 "커밋" 탭이나 맨 아래
// 힌트 줄의 단축키 안내를 커밋 버튼으로 잘못 잡지 않게.
function find(screen, text, from = 1, to = COLS) {
  for (let r = 3; r <= ROWS - 2; r++) {
    const cells = screen.get(r) || new Map();
    let line = '', cols = [];
    for (let c = from; c <= to; c++) if (cells.has(c)) { line += cells.get(c); cols.push(c); }
    const idx = line.indexOf(text);
    if (idx >= 0) return { row: r, col: cols[idx] };
  }
  return null;
}
function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
// 입력 처리가 그리는 프레임(ESC 로 시작)만 버린다. 기다리는 동안 테스트 러너가 쓰는 보고까지
// 삼키면 결과가 사라진다.
async function quiet(fn) {
  const old = process.stdout.write;
  process.stdout.write = function (s, ...rest) {
    if (typeof s === 'string' && s.charCodeAt(0) === 0x1b) return true;
    return old.call(process.stdout, s, ...rest);
  };
  try { await fn(); await new Promise(r => setTimeout(r, 20)); } finally { process.stdout.write = old; }
}
const press = ({ col, row }) => quiet(() => handleMouseData(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`));

function reset() {
  Object.assign(state, {
    loading: false, isGitRepo: true, gitNotFound: false, minimized: false, error: null,
    operationState: null, conflictView: null, indexLocked: false, rebaseMessage: '',
    branch: 'main', branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }],
    remoteBranches: ['origin/main'], remotes: ['origin'], stashes: [],
    worktrees: [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }],
    isLinkedWorktree: false, ahead: 0, behind: 0,
    staged: [{ file: 'staged.txt', status: 'M' }],
    unstaged: [{ file: 'changed.txt', status: 'M' }], untracked: [], ignored: [],
    selectedFiles: new Set(), cursor: 0, scrollOffset: 0, filesScrollX: 0,
    rightView: 'diff', diffView: 'unified', currentDiffFile: 'changed.txt', diffLines: [],
    diffScrollOffset: 0, diffScrollX: 0, diffLoading: false,
    mode: 'normal', commitMsg: '', commitCursor: 0, commitAmend: false,
  });
  Object.assign(ui, {
    termCols: COLS, termRows: ROWS, cellW: 8, cellH: 16,
    collapsedSections: {}, collapsedGroups: {}, collapsedFileDirs: {}, fileTreeView: false,
    leftPanelCollapsed: false, middlePanelCollapsed: false, rightPanelCollapsed: false,
    leftPanelScrollOffset: 0, hoveredTitleZoneIndex: -1, hoveredFileHeaderIdx: -1, hoveredFileRow: -1,
    hoveredCommitButton: false, hoveredCommitAmend: false, hoveredCommitClear: false,
  });
}

// 렌더가 잡은 패널 경계(열). 스테이지 = middle, 차이 = right.
function panels() {
  const L = ui.lastLayout;
  const midStart = L.startCol + L.leftW + L.divider1W;
  const rightStart = midStart + L.middleW + L.divider2W;
  return { midStart, midEnd: midStart + L.middleW - 1, rightStart, rightEnd: L.startCol + L.width - 1 };
}

const COMMIT_LABEL = t('ui.commit2');
const NO_STAGED = t('ui.noFilesStaged');
const STAGED_INFO = t('ui.fileSStaged');

// 타이틀 행(1행)에 text 가 있는지.
const inTitle = (screen, text) => rowText(screen, 1).includes(text);

test('상태 탭 타이틀에 차이 접기 버튼이 스테이지 다음에 있다', () => {
  reset();
  frame();
  const actions = ui.titleClickZones.map(z => z.action);
  const at = actions.indexOf('toggleDiffPanel');
  assert.ok(at >= 0, '차이 접기 버튼이 없다');
  assert.equal(actions[at - 1], 'toggleFiles', '스테이지 접기 바로 다음이어야 한다');
  const screen = paint(frame());
  assert.ok(inTitle(screen, '- ' + t('ui.diffPanel')), '펼친 상태는 "- 차이" 로 그린다');
});

test('히스토리 탭에는 차이 접기 버튼이 없다', () => {
  reset();
  state.rightView = 'log';
  frame();
  assert.equal(ui.titleClickZones.some(z => z.action === 'toggleDiffPanel'), false);
});

test('차이 접기 버튼을 누르면 차이 패널이 접히고, 다시 누르면 펼쳐진다', async () => {
  reset();
  let screen = paint(frame());
  const btn = ui.titleClickZones.find(z => z.action === 'toggleDiffPanel');
  await press({ col: btn.colStart, row: btn.row });
  assert.equal(ui.rightPanelCollapsed, true);
  screen = paint(frame());
  assert.equal(ui.lastLayout.rightW, 0, '차이 패널이 접혀야 한다');
  assert.ok(inTitle(screen, '+ ' + t('ui.diffPanel')), '접힌 상태는 "+ 차이" 로 그린다');
  const again = ui.titleClickZones.find(z => z.action === 'toggleDiffPanel');
  await press({ col: again.colStart, row: again.row });
  assert.equal(ui.rightPanelCollapsed, false);
  frame();
  assert.ok(ui.lastLayout.rightW > 0);
});

test('펼쳐 있으면 커밋 영역은 지금처럼 차이 패널 아래에 있다', () => {
  reset();
  const screen = paint(frame());
  const p = panels();
  const btn = find(screen, COMMIT_LABEL, p.rightStart, p.rightEnd);
  assert.ok(btn, 'Commit 버튼이 차이 패널에 있어야 한다');
  assert.equal(find(screen, COMMIT_LABEL, p.midStart, p.midEnd), null, '스테이지 쪽에 또 그리면 안 된다');
  assert.equal(ui.commitButtonZone.row, btn.row);
  assert.equal(ui.commitButtonZone.colStart, btn.col);
  assert.equal(ui.commitInputColStart, p.rightStart);
});

test('차이를 접으면 커밋 영역을 스테이지 패널 바닥에 그리고 존도 그 자리를 가리킨다', () => {
  reset();
  ui.rightPanelCollapsed = true;
  const screen = paint(frame());
  const p = panels();
  const btn = find(screen, COMMIT_LABEL, p.midStart, p.midEnd);
  assert.ok(btn, 'Commit 버튼이 스테이지 패널 아래에 있어야 한다');
  // 바닥 고정: 본문 마지막 줄(구분선·힌트 줄 위)이 Commit 버튼 줄이다.
  const L = ui.lastLayout;
  const lastBodyRow = L.startRow + L.titleRows + 1 + (L.bodyH - 2) - 1;
  assert.equal(btn.row, lastBodyRow, '커밋 영역은 스테이지 패널 맨 아래에 붙어야 한다');
  assert.deepEqual({ row: ui.commitButtonZone.row, col: ui.commitButtonZone.colStart }, { row: btn.row, col: btn.col });
  // 안내 줄(= 입력 줄)과 그 위 구분선
  const info = find(screen, '1' + STAGED_INFO, p.midStart, p.midEnd);
  assert.ok(info, '스테이지된 파일 수 안내가 있어야 한다');
  assert.equal(ui.commitInputRow, info.row);
  assert.equal(ui.commitInputColStart, p.midStart);
  assert.equal(ui.commitInputColEnd, p.midEnd);
  assert.match(rowText(screen, info.row - 1, p.midStart, p.midEnd), /^─+$/, '커밋 영역 위에 구분선이 있어야 한다');
  // amend 토글도 같은 줄, 그린 칸을 가리킨다
  const amend = find(screen, t('ui.amendLastCommit').trim(), p.midStart, p.midEnd);
  assert.ok(amend);
  assert.equal(ui.commitAmendZone.row, amend.row);
  assert.ok(ui.commitAmendZone.colStart <= amend.col && amend.col <= ui.commitAmendZone.colEnd);
});

test('목록이 짧아도 길어도 커밋 영역은 같은 줄에 있다 — 파일 수에 따라 오르내리지 않는다', () => {
  reset();
  ui.rightPanelCollapsed = true;
  frame();
  const shortRow = ui.commitButtonZone.row;
  state.unstaged = Array.from({ length: 80 }, (_, i) => ({ file: 'file' + i + '.txt', status: 'M' }));
  frame();
  assert.equal(ui.commitButtonZone.row, shortRow);
  // 긴 목록은 커밋 영역 구분선 바로 위에서 끝나야 한다 — 파일 줄이 입력란을 덮으면 안 된다.
  const separatorRel = ui.commitInputRow - 1 - (ui.lastLayout.startRow + ui.lastLayout.titleRows + 1);
  assert.equal(ui.fileLineMap.length, separatorRel, `파일 줄(${ui.fileLineMap.length})은 구분선(${separatorRel}) 위까지만`);
  assert.ok(ui.filesMaxScroll > 0, '줄어든 높이로 스크롤 범위를 잡아야 한다');
});

test('차이를 접은 채 입력 줄을 누르면 커밋 모드로 들어가고 IME 커서가 스테이지 아래 입력 줄에 선다', async () => {
  reset();
  ui.rightPanelCollapsed = true;
  let screen = paint(frame());
  const p = panels();
  const info = find(screen, '1' + STAGED_INFO, p.midStart, p.midEnd);
  await press(info);
  assert.equal(state.mode, 'commit', '스테이지 아래 입력 줄을 눌러 커밋 모드로 들어가야 한다');
  state.commitMsg = 'hello';
  state.commitCursor = 5;
  screen = paint(frame());
  const msg = find(screen, 'hello', p.midStart, p.midEnd);
  assert.ok(msg, '메시지가 스테이지 아래에 그려져야 한다');
  assert.deepEqual(ui.imeCursor, { row: msg.row, col: msg.col + 5 }, 'IME 커서는 입력한 글자 바로 뒤');
});

test('차이를 접은 채 Commit 버튼과 amend 토글을 누르면 그 동작이 일어난다', async () => {
  reset();
  ui.rightPanelCollapsed = true;
  let screen = paint(frame());
  const p = panels();
  await press(find(screen, COMMIT_LABEL, p.midStart, p.midEnd));
  assert.equal(state.mode, 'commit', 'Commit 버튼은 커밋 모드로 들어간다');
  screen = paint(frame());
  await press(find(screen, t('ui.amendLastCommit').trim(), p.midStart, p.midEnd));
  assert.equal(state.commitAmend, true, 'amend 토글이 켜져야 한다');
});

test('스테이지가 없을 때도 차이를 접으면 안내 줄과 Commit 버튼이 스테이지 아래에 있다', () => {
  reset();
  state.staged = [];
  ui.rightPanelCollapsed = true;
  const screen = paint(frame());
  const p = panels();
  assert.ok(find(screen, NO_STAGED, p.midStart, p.midEnd));
  assert.ok(find(screen, COMMIT_LABEL, p.midStart, p.midEnd));
});

test('스테이지와 차이를 모두 접으면 커밋 영역을 그릴 곳이 없고 존도 남지 않는다', () => {
  reset();
  frame();
  ui.middlePanelCollapsed = true;
  ui.rightPanelCollapsed = true;
  const screen = paint(frame());
  assert.equal(find(screen, COMMIT_LABEL), null);
  assert.equal(ui.commitButtonZone, null, '지난 프레임의 Commit 존이 남으면 빈 자리를 눌러 커밋 모드로 들어간다');
  assert.equal(ui.commitInputRow, -1);
  assert.equal(ui.commitAmendZone, null);
});

// 대조군: 판정 방법(git 호출 기록)이 실제로 헤더 버튼 클릭을 잡는지 먼저 확인한다.
test('보이는 [모두 언스테이지] 를 누르면 git 이 실행된다 (판정 방법 확인)', async () => {
  reset();
  ui.rightPanelCollapsed = true;
  const screen = paint(frame());
  const p = panels();
  // 한국어에서는 두 헤더의 전체 버튼 라벨이 똑같이 "모두"다 — 글자로 찾지 말고 Staged 헤더의 존을
  // 쓰되, 그 칸에 그 라벨이 그려져 있는지 확인한다.
  const zone = ui.fileHeaderZones.find(z => z.action === 'unstageAll');
  const bodyTop = ui.lastLayout.startRow + ui.lastLayout.titleRows + 1;
  const cell = { col: p.midStart + zone.btnColStart, row: bodyTop + zone.lineIdx - state.scrollOffset };
  assert.ok(rowText(screen, cell.row, cell.col).startsWith('*' + t('ui.unstageAll')), 'Staged 헤더의 [*모두] 칸이어야 한다');
  gitCalls.length = 0;
  await press(cell);
  assert.ok(gitCalls.length > 0, '헤더 버튼 클릭이 git 호출로 드러나야 아래 테스트가 의미가 있다');
});

test('뷰포트 아래로 밀려난 스테이지 헤더 버튼이 커밋 영역 클릭을 가로채지 않는다', async () => {
  reset();
  ui.rightPanelCollapsed = true;
  // 변경 파일이 많아 Staged 헤더가 뷰포트 아래로 밀려난다.
  state.unstaged = Array.from({ length: 80 }, (_, i) => ({ file: 'file' + i + '.txt', status: 'M' }));
  frame();
  const bodyTop = ui.lastLayout.startRow + ui.lastLayout.titleRows + 1;
  // 커밋 영역 맨 위 구분선 줄 — 여기에는 커밋 존이 없어 클릭이 스테이지 패널 처리로 내려간다.
  const separatorRow = ui.commitInputRow - 1;
  const lineIdx = ui.fileHeaderZones.find(z => z.action === 'unstageAll').lineIdx;
  // 숨은 Staged 헤더가 계산상 그 구분선 줄에 오도록 스크롤을 맞춘다.
  state.scrollOffset = lineIdx - (separatorRow - bodyTop);
  ui.filesScrollPin = state.cursor;      // 커서를 따라 스크롤이 되돌아가지 않게 고정
  frame();
  const zone = ui.fileHeaderZones.find(z => z.action === 'unstageAll');
  assert.equal(bodyTop + zone.lineIdx - state.scrollOffset, separatorRow, '헤더가 계산상 구분선 줄에 와야 한다');
  assert.ok(zone.lineIdx - state.scrollOffset >= ui.fileLineMap.length, '헤더 자체는 화면 밖이어야 한다');
  gitCalls.length = 0;
  await press({ col: panels().midStart + zone.btnColStart, row: separatorRow });
  assert.deepEqual(gitCalls, [], '보이지 않는 [모두 언스테이지] 가 눌리면 안 된다');
});
