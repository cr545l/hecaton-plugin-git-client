// diff 파일 헤더를 화면에서 걷어내는 동작 검증.
//
// git은 파일마다 `diff --git a/x b/x` / `index ..` / `--- a/x` / `+++ b/x` 를 앞에 붙인다.
// a/ b/ 는 실제 경로가 아니라 "변경 전/후"를 뜻하는 git의 관례적 접두사인데, 원본 출력을
// 그대로 뿌리면 없는 경로가 붙은 것처럼 보이고 매 파일 diff 상단 4줄을 잡아먹는다.
// → 화면에서만 걷어내고, hunk 패치를 만드는 원본(state.diffLines)은 손대지 않는지 본다.
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
const { stripAnsi, isDiffFileHeaderLine, stripDiffFileHeaders } = require('../text');
const { buildHunkPatchText } = require('../git');

const COLS = 160, ROWS = 32;
const FILE = 'spinner.js';

const DIFF = [
  'diff --git a/spinner.js b/spinner.js',
  'index 5eaa2c5..f2bd03a 100644',
  '--- a/spinner.js',
  '+++ b/spinner.js',
  '@@ -1,4 +1,4 @@',
  " const { state } = require('./state');",
  "-const { formatWindowTitle } = require('./title');",
  "+const { formatWindowTitle, BRAILLE_FRAMES } = require('./title');",
  ' ',
  ' let spinnerTimer = null;',
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
  state.spinnerActive = false; state.error = null;
  state.refreshing = false; state.logLoadingMore = false;
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
}

const origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = origWrite; }
  return stripAnsi(out.join(''));
}

// ── 판별 헬퍼 ──

test('isDiffFileHeaderLine은 git 파일 헤더 네 종류만 잡는다', () => {
  assert.ok(isDiffFileHeaderLine('diff --git a/x.js b/x.js'));
  assert.ok(isDiffFileHeaderLine('index 5eaa2c5..f2bd03a 100644'));
  assert.ok(isDiffFileHeaderLine('--- a/x.js'));
  assert.ok(isDiffFileHeaderLine('+++ b/x.js'));
  assert.ok(isDiffFileHeaderLine('--- /dev/null'));

  // 정보가 있는 줄은 남겨야 한다.
  assert.ok(!isDiffFileHeaderLine('new file mode 100644'));
  assert.ok(!isDiffFileHeaderLine('deleted file mode 100644'));
  assert.ok(!isDiffFileHeaderLine('rename from old.js'));
  assert.ok(!isDiffFileHeaderLine('similarity index 95%'));
  assert.ok(!isDiffFileHeaderLine('Binary files a/x.png and b/x.png differ'));
  assert.ok(!isDiffFileHeaderLine('@@ -1,4 +1,4 @@'));
  assert.ok(!isDiffFileHeaderLine('-removed line'));
  assert.ok(!isDiffFileHeaderLine('+added line'));
});

test('stripDiffFileHeaders는 hunk 본문의 --- 삭제줄을 지우지 않는다', () => {
  // 내용이 '--'로 시작하는 줄을 지우면 diff 줄이 '--- ...' 로 보인다 — 파일 헤더와
  // 글자만으로는 구분되지 않으므로 위치(@@ 이후인지)로 갈라야 본문을 잃지 않는다.
  const lines = [
    'diff --git a/a.sql b/a.sql',
    'index 111..222 100644',
    '--- a/a.sql',
    '+++ b/a.sql',
    '@@ -1,2 +1,2 @@',
    '--- old sql comment',
    '+++ new sql comment',
    ' SELECT 1;',
  ];
  const out = stripDiffFileHeaders(lines);

  assert.deepEqual(out, [
    '@@ -1,2 +1,2 @@',
    '--- old sql comment',
    '+++ new sql comment',
    ' SELECT 1;',
  ]);
});

test('stripDiffFileHeaders는 멀티 파일 diff에서 파일마다 헤더를 걷어낸다', () => {
  const out = stripDiffFileHeaders([
    'diff --git a/a.js b/a.js',
    'index 111..222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1 +1 @@',
    '-a',
    '+A',
    'diff --git a/b.js b/b.js',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/b.js',
    '@@ -0,0 +1 @@',
    '+b',
  ]);

  assert.deepEqual(out, [
    '@@ -1 +1 @@', '-a', '+A',
    'new file mode 100644',   // 새 파일이라는 정보는 남는다
    '@@ -0,0 +1 @@', '+b',
  ]);
});

// ── 실제 렌더 ──

for (const view of ['side', 'unified']) {
  test(`${view} diff 화면에 a/ b/ 파일 헤더가 나오지 않는다`, () => {
    setup(view);
    const frame = captureRender();

    assert.ok(!frame.includes('diff --git'), 'diff --git 줄이 남았다');
    assert.ok(!frame.includes('a/spinner.js'), '없는 경로 a/ 가 남았다');
    assert.ok(!frame.includes('b/spinner.js'), '없는 경로 b/ 가 남았다');
    assert.ok(!frame.includes('5eaa2c5'), 'index blob 해시가 남았다');
  });

  // side 뷰는 컬럼 폭에 맞춰 줄 끝을 자르므로(가로 스크롤로 본다) 짧은 토큰으로 확인한다.
  test(`${view} diff의 본문과 hunk 헤더는 그대로 보인다`, () => {
    setup(view);
    const frame = captureRender();

    assert.ok(frame.includes('@@ -1,4 +1,4 @@'), 'hunk 헤더는 남아야 한다');
    assert.ok(frame.includes('formatWindowTitle'), '변경된 줄이 보여야 한다');
    assert.ok(frame.includes('spinnerTimer'), '문맥 줄이 보여야 한다');
  });
}

test('렌더는 원본 diffLines를 건드리지 않는다 — hunk 패치가 헤더를 쓴다', () => {
  setup('side');
  captureRender();

  assert.deepEqual(state.diffLines, DIFF, '화면에서만 걷어내야 한다');

  // 헤더가 살아 있어야 적용 가능한 패치가 나온다.
  const patch = buildHunkPatchText(state.diffLines, 0);
  assert.ok(patch.startsWith('diff --git a/spinner.js b/spinner.js'), '패치에 파일 헤더가 있어야 한다');
  assert.ok(patch.includes('--- a/spinner.js'), 'git apply -p1 이 기대하는 접두사가 있어야 한다');
  assert.ok(patch.includes('+++ b/spinner.js'));
  assert.ok(patch.includes('@@ -1,4 +1,4 @@'));
});

test('헤더를 걷어낸 만큼 세로 스크롤 한계도 줄어든다', () => {
  // 스크롤 한계를 원본 길이로 잡으면 걷어낸 4줄만큼 끝을 지나 빈 화면까지 내려간다.
  setup('unified');
  // 뷰포트보다 긴 diff를 만들어 스크롤이 실제로 걸리게 한다.
  const body = [];
  for (let i = 0; i < 200; i++) body.push('+line ' + i);
  state.diffLines = DIFF.slice(0, 5).concat(body);   // 헤더 4줄 + @@ + 본문
  captureRender();

  const STRIPPED = 4;   // diff --git / index / --- / +++
  assert.ok(ui.diffMaxScroll > 0, '스크롤이 걸리는 길이여야 검증이 성립한다');
  assert.equal(
    ui.diffMaxScroll,
    Math.max(0, (state.diffLines.length - STRIPPED) - ui.rightDiffH),
    '스크롤 한계는 원본이 아니라 실제로 그려지는 줄 수를 따라야 한다'
  );
});
