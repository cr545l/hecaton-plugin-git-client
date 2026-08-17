// 탭 들여쓰기 파일의 diff에서 줄이 깨지던 버그 검증.
//
// 터미널에서 탭은 공백 출력이 아니라 커서 이동이라 지나간 칸의 이전 내용이 남고,
// visLen/sliceByWidth는 탭을 1칸으로 세므로 계산 폭과 실제 폭이 어긋난다. 그래서
// side-by-side 셀이 옆 칸을 침범하고 앞 프레임 잔상이 겹쳐 보였다.
// → 표시 직전에 탭을 공백으로 펴되, hunk 패치 생성에 쓰는 원본은 그대로 두는지 본다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 160, rows: 32 },
  on: () => {},
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { visLen, expandTabs, stripAnsi } = require('../text');

const COLS = 160, ROWS = 32;
const FILE = 'src/session-room.ts';

// 탭 들여쓰기 + 한글 주석(wide char)이 섞인 diff — 폭 계산이 가장 잘 깨지는 조합이다.
const DIFF = [
  'diff --git a/src/session-room.ts b/src/session-room.ts',
  'index 1111111..2222222 100644',
  '--- a/src/session-room.ts',
  '+++ b/src/session-room.ts',
  '@@ -10,4 +10,7 @@ export class SessionRoom {',
  ' \tconstructor(ctx: Ctx, env: Env) {',
  '-\t\tsuper(ctx, env);',
  '+\t\tsuper(ctx, env);',
  '+\t\t// 상대 합류 전에 도착한 프레임은 순서대로 flush 한다',
  '+\t\tthis.pending = new Map();',
  ' \t}',
  '',
];

function setup(diffView) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin']; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [{ file: FILE, status: 'M' }];
  state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'diff'; state.diffView = diffView;
  state.currentDiffFile = FILE;
  state.diffLines = DIFF.slice();
  state.cursor = 0; state.scrollOffset = 0;
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = '';
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
}

const origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = origWrite; }
  return out.join('');
}

// 프레임을 moveTo 세그먼트로 쪼개 각 세그먼트가 끝나는 열을 센다.
function overflowingSegments(frame) {
  const parts = frame.split(/\x1b\[(\d+);(\d+)H/);
  const over = [];
  for (let i = 1; i < parts.length; i += 3) {
    const col = parseInt(parts[i + 1], 10);
    const text = parts[i + 2] || '';
    if (text.includes('\x1bP')) continue; // sixel 페이로드는 셀 폭이 아니다
    const w = visLen(text.replace(/\x1b\][^\x07]*\x07/g, ''));
    if (col + w - 1 > COLS) over.push({ row: parseInt(parts[i], 10), col, width: w });
  }
  return over;
}

test('expandTabs는 tab stop까지만 채운다', () => {
  assert.equal(expandTabs('\tx', 4), '    x');
  assert.equal(expandTabs('a\tx', 4), 'a   x');
  assert.equal(expandTabs('abc\tx', 4), 'abc x');
  assert.equal(expandTabs('abcd\tx', 4), 'abcd    x');
  assert.equal(expandTabs('탭\tx', 4), '탭  x', '한글은 두 칸으로 세야 한다');
  assert.equal(expandTabs('no tabs', 4), 'no tabs');
});

for (const view of ['side', 'unified']) {
  test(`${view} diff 프레임에는 탭이 남지 않는다`, () => {
    setup(view);
    const frame = captureRender();
    assert.equal(frame.includes('\t'), false, '탭이 그대로 나가면 커서가 tab stop으로 튀어 잔상이 남는다');
  });

  test(`${view} diff의 탭 줄도 패널 폭을 넘지 않는다`, () => {
    setup(view);
    const over = overflowingSegments(captureRender());
    assert.deepEqual(over, [], '패널 폭을 넘는 세그먼트가 있으면 옆 칸을 침범한다');
  });
}

test('side diff는 탭 줄에서도 셀 구분선이 한 열에 정렬된다', () => {
  setup('side');
  const frame = captureRender();
  // diff 패널 행에서 구분선이 나타나는 화면 열을 모은다(세그먼트 시작 열 + 표시 폭).
  const parts = frame.split(/\x1b\[(\d+);(\d+)H/);
  const cols = new Set();
  for (let i = 1; i < parts.length; i += 3) {
    const startCol = parseInt(parts[i + 1], 10);
    const plain = stripAnsi(parts[i + 2] || '');
    const idx = plain.indexOf('\u2502');
    if (idx < 0) continue;
    cols.add(startCol + visLen(plain.slice(0, idx)));
  }
  // 세로 구분선은 패널 경계 + side 컬럼 경계뿐이다 — 탭이 폭을 밀면 열이 흩어진다.
  assert.ok(cols.size <= 4, '구분선 열이 흩어졌다: ' + [...cols].join(','));
});

test('원본 diffLines의 탭은 그대로 남는다 (hunk 패치용)', () => {
  setup('side');
  captureRender();
  assert.deepEqual(state.diffLines, DIFF, '렌더가 원본을 바꾸면 git apply가 컨텍스트를 못 맞춘다');
});
