// 충돌 해결 화면이 "어느 쪽을 고를 수 있다"를 실제로 드러내는지 본다.
//
// 예전 화면은 충돌 청크만 좌우로 쪼개 놓고 선택 수단은 하단 힌트의 [1]/[2] 뿐이었다 —
// 로직은 있는데 화면에 어포던스가 없으니 기능이 없는 것과 같았고, 충돌 파일에서는
// 상단 Diff 토글(side/unified)도 통째로 무시됐다. 그 세 가지를 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 200, rows: 40 },
  on: () => {},
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { stripAnsi } = require('../text');
const { buildResolvedConflictContent, handleKey } = require('../input');

const COLS = 200, ROWS = 40;
const FILE = 'src/App.tsx';

// context / conflict / context / conflict / context — 충돌 사이의 문맥이 화면에 남는지도 본다.
const CHUNKS = [
  { type: 'context', lines: ['const environment = {};', 'const characters = [];'] },
  { type: 'conflict', ours: ['const attrValue = raw;'], theirs: ['const display = pretty;', 'const extra = 1;'] },
  { type: 'context', lines: ['function middle() {}'] },
  { type: 'conflict', ours: ['const badge = oldBadge;'], theirs: ['const badge = newBadge;'] },
  { type: 'context', lines: ['export default App;'] },
];

function setup(diffView, selections, cols) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false;
  state.operationState = { type: 'merge', incomingName: 'feature/x' };
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin']; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [];
  state.unstaged = [{ file: FILE, status: 'U' }];
  state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'diff'; state.diffView = diffView;
  state.currentDiffFile = FILE;
  state.diffLines = [];
  state.conflictView = { file: FILE, chunks: CHUNKS, hasTrailingNewline: true };
  state.cursor = 0; state.scrollOffset = 0;
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = '';
  state.spinnerActive = false; state.error = null;
  state.refreshing = false; state.logLoadingMore = false;
  ui.termCols = cols || COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.mergeConflictFile = FILE;
  ui.mergeChunkCursor = 1;
  ui.mergeChunkSelections = selections || {};
  ui.hoveredMergeZoneIndex = -1;
}

const origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = origWrite; }
  // 프레임은 한 줄로 이어져 나오고 행 이동(CSI row;col H)이 줄바꿈 노릇을 한다 —
  // 실제 개행을 넣어 두지 않으면 "같은 줄에 있는가"를 정규식으로 물을 수 없다.
  return out.join('').split(/\x1b\[\d+;\d+H/).map(stripAnsi).join('\n');
}

// ── 선택 어포던스 ──

for (const view of ['side', 'unified']) {
  test(`${view} 충돌 화면에 세 가지 선택 버튼이 보인다`, () => {
    setup(view);
    const frame = captureRender();

    assert.ok(frame.includes('Use Ours'), 'Ours 선택 버튼이 있어야 한다');
    assert.ok(frame.includes('Use Theirs'), 'Theirs 선택 버튼이 있어야 한다');
    assert.ok(frame.includes('Keep both'), 'Both 선택 버튼이 있어야 한다');
  });

  test(`${view} 충돌 화면은 충돌 사이의 문맥도 함께 보여 준다`, () => {
    setup(view);
    const frame = captureRender();

    // 충돌 부분만 떼어 보여 주면 어디를 고치는지 알 수 없다.
    assert.ok(frame.includes('const environment'), '앞쪽 문맥이 보여야 한다');
    assert.ok(frame.includes('function middle()'), '충돌 사이 문맥이 보여야 한다');
    assert.ok(frame.includes('export default App'), '뒤쪽 문맥이 보여야 한다');
  });

  test(`${view} 충돌 화면은 진행 상황과 이동 버튼을 낸다`, () => {
    setup(view, { 1: 'ours' });
    const frame = captureRender();

    assert.ok(frame.includes('1/2 resolved'), '몇 개가 남았는지 보여야 한다');
    assert.ok(frame.includes('[‹]') && frame.includes('[›]'), '충돌 사이 이동 버튼이 있어야 한다');
  });
}

// ── Diff 모드 전환 ──

test('충돌 파일에서도 side 토글이 좌우 정렬로 그려진다', () => {
  setup('side');
  const frame = captureRender();

  assert.ok(frame.includes('Ours') && frame.includes('Theirs'), '좌우 헤더가 있어야 한다');
  // 좌우로 나뉘면 ours 와 theirs 가 같은 줄에 놓인다.
  assert.ok(/const attrValue = raw;.*const display = pretty;/.test(frame),
    'side 에서는 양쪽 코드가 한 줄에 나란히 놓여야 한다');
  assert.ok(!frame.includes('<<<<<<<'), 'side 에서는 충돌 마커를 쓰지 않는다');
});

test('충돌 파일에서 unified 토글은 충돌 마커 뷰로 바뀐다', () => {
  setup('unified');
  const frame = captureRender();

  assert.ok(frame.includes('<<<<<<< Ours'), 'unified 에서는 충돌 마커가 보여야 한다');
  assert.ok(frame.includes('>>>>>>> Theirs'));
  assert.ok(!/const attrValue = raw;.*const display = pretty;/.test(frame),
    'unified 에서는 양쪽이 같은 줄에 놓이면 안 된다');
});

test('폭이 좁으면 side 토글이어도 unified 로 떨어진다', () => {
  // 좌우로 쪼개면 코드가 읽히지 않는 폭에서는 토글보다 가독성이 앞선다.
  setup('side', {}, 90);
  const frame = captureRender();

  assert.ok(frame.includes('<<<<<<<'), '좁은 화면에서는 충돌 마커 뷰로 떨어져야 한다');
});

// ── 고정 머리말 ──

function withLongPrefix() {
  const filler = [];
  for (let i = 0; i < 60; i++) filler.push('const filler' + i + ' = ' + i + ';');
  state.conflictView.chunks = [{ type: 'context', lines: filler }].concat(CHUNKS);
}

for (const view of ['side', 'unified']) {
  test(`${view} 는 스크롤해도 머리말이 화면에 남는다`, () => {
    // 함께 스크롤되면 파일을 조금만 내려도 남은 충돌 수와 이동 버튼, 어느 쪽이
    // 어느 브랜치인지가 화면 밖으로 밀려난다.
    setup(view);
    withLongPrefix();
    captureRender();
    assert.ok(ui.diffMaxScroll > 0, '스크롤이 걸리는 길이여야 검증이 성립한다');

    state.diffScrollOffset = ui.diffMaxScroll;
    const frame = captureRender();

    assert.ok(frame.includes('0/2 resolved'), '진행 상황이 남아야 한다');
    assert.ok(frame.includes('[‹]') && frame.includes('[›]'), '이동 버튼이 남아야 한다');
    assert.ok(frame.includes('Ours · main'), 'Ours 가 어느 브랜치인지 남아야 한다');
    assert.ok(frame.includes('Theirs · feature/x'), 'Theirs 가 어느 브랜치인지 남아야 한다');
    assert.ok(!frame.includes('const filler0 ='), '본문은 실제로 스크롤되어야 한다');
  });
}

test('스크롤 끝에서 파일의 마지막 줄까지 닿는다', () => {
  // 스크롤 한계를 머리말까지 포함한 높이로 잡으면, 끝까지 내려도 마지막 줄이
  // 머리말 줄 수만큼 가려진 채 멈춘다.
  setup('side');
  withLongPrefix();
  captureRender();
  state.diffScrollOffset = ui.diffMaxScroll;
  const frame = captureRender();

  assert.ok(ui.conflictBodyH > 0 && ui.conflictBodyH < ui.rightDiffH,
    '스크롤되는 높이는 머리말을 뺀 만큼이어야 한다');
  assert.ok(frame.includes('export default App'), '스크롤 끝에서 마지막 줄이 보여야 한다');
});

test('merge 중에는 양쪽 브랜치 이름을 적는다', () => {
  setup('side');
  const frame = captureRender();

  assert.ok(frame.includes('Ours · main'), '현재 브랜치가 Ours 다');
  assert.ok(frame.includes('Theirs · feature/x'), '들어오는 브랜치가 Theirs 다');
});

test('rebase 중에는 onto 와 얹히는 브랜치를 구분해 적는다', () => {
  // rebase 는 onto 위에 커밋을 얹는 중이라 ours 가 리베이스 대상, theirs 가 내 커밋이다.
  setup('side');
  state.operationState = { type: 'rebase-merge', step: 1, total: 3, headName: 'feature/x', ontoHash: 'a1b2c3d' };
  const frame = captureRender();

  assert.ok(frame.includes('HEAD · onto a1b2c3d'), 'ours 쪽이 무엇 위에 얹는 중인지 보여야 한다');
  assert.ok(frame.includes('Incoming · feature/x'), 'theirs 쪽이 어느 브랜치인지 보여야 한다');
  // 브랜치 이름이 길어도 버튼이 화면을 넘기면 안 되므로 버튼 라벨은 짧게 유지한다.
  assert.ok(frame.includes('Use Incoming'), '버튼 라벨에는 브랜치명을 넣지 않는다');
});

// ── 키로 고르기 ──

async function pressKey(key) {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { await handleKey(key); } finally { process.stdout.write = origWrite; }
}

test('1/2/3 키가 각각 ours/theirs/both 를 고른다', async () => {
  setup('side');
  ui.mergeChunkCursor = 1;

  await pressKey('1');
  assert.equal(ui.mergeChunkSelections[1], 'ours');
  await pressKey('2');
  assert.equal(ui.mergeChunkSelections[1], 'theirs');
  await pressKey('3');
  assert.equal(ui.mergeChunkSelections[1], 'both');
});

test('같은 쪽을 다시 고르면 선택이 풀린다', async () => {
  // 물릴 방법이 없으면 잘못 누른 선택을 안고 Apply 까지 가게 된다.
  setup('side');
  ui.mergeChunkCursor = 1;

  await pressKey('1');
  assert.equal(ui.mergeChunkSelections[1], 'ours');
  await pressKey('1');
  assert.equal(ui.mergeChunkSelections[1], undefined, '다시 누르면 고르기 전으로 돌아가야 한다');
});

// ── 클릭 영역 ──

test('스크롤한 화면에서도 클릭 영역이 화면 줄 위에 놓인다', () => {
  // zone 의 줄 번호를 파일 기준 절대값으로 넘기면, 스크롤한 만큼 어긋난 자리를 누르게 된다.
  // 충돌이 화면 아래로 밀린 긴 파일에서 "선택이 안 먹는" 것처럼 보이던 원인이다.
  setup('side');
  const long = [];
  for (let i = 0; i < 80; i++) long.push('const filler' + i + ' = ' + i + ';');
  state.conflictView.chunks = [
    { type: 'context', lines: long },
    { type: 'conflict', ours: ['const a = 1;'], theirs: ['const a = 2;'] },
  ];
  captureRender();
  assert.ok(ui.diffMaxScroll > 0, '스크롤이 걸리는 길이여야 검증이 성립한다');

  state.diffScrollOffset = ui.diffMaxScroll;
  captureRender();

  assert.ok(ui.mergeClickZones.length > 0, '스크롤 끝의 충돌에도 클릭 영역이 있어야 한다');
  for (const zone of ui.mergeClickZones) {
    assert.ok(zone.lineIdx >= 0 && zone.lineIdx < ui.rightDiffH,
      `클릭 영역이 뷰포트 밖(${zone.lineIdx}/${ui.rightDiffH})을 가리킨다`);
  }
});

test('화면 밖으로 밀린 충돌의 클릭 영역은 남기지 않는다', () => {
  // 남겨 두면 엉뚱한 위치의 클릭이 보이지도 않는 충돌을 고르게 된다.
  setup('side');
  const long = [];
  for (let i = 0; i < 80; i++) long.push('const filler' + i + ' = ' + i + ';');
  state.conflictView.chunks = [
    { type: 'conflict', ours: ['const a = 1;'], theirs: ['const a = 2;'] },
    { type: 'context', lines: long },
    { type: 'conflict', ours: ['const b = 1;'], theirs: ['const b = 2;'] },
  ];
  state.diffScrollOffset = 0;
  captureRender();

  const chunks = new Set(ui.mergeClickZones.map(z => z.chunkIndex));
  assert.ok(chunks.has(0), '화면 안의 첫 충돌은 클릭할 수 있어야 한다');
  assert.ok(!chunks.has(2), '화면 밖의 충돌은 클릭 영역이 남으면 안 된다');
});

// ── 고른 결과가 파일에 어떻게 쓰이는가 ──

test('한쪽만 고르면 그 쪽 줄만 남는다', () => {
  setup('side', { 1: 'theirs', 3: 'ours' });
  const resolved = buildResolvedConflictContent();

  assert.ok(resolved.ok, resolved.message);
  assert.equal(resolved.content, [
    'const environment = {};',
    'const characters = [];',
    'const display = pretty;',
    'const extra = 1;',
    'function middle() {}',
    'const badge = oldBadge;',
    'export default App;',
  ].join('\n') + '\n');
});

test('both 는 화면에 놓인 순서대로 ours 다음 theirs 를 남긴다', () => {
  setup('side', { 1: 'both', 3: 'both' });
  const resolved = buildResolvedConflictContent();

  assert.ok(resolved.ok, resolved.message);
  assert.equal(resolved.content, [
    'const environment = {};',
    'const characters = [];',
    'const attrValue = raw;',      // 왼쪽이 먼저
    'const display = pretty;',
    'const extra = 1;',
    'function middle() {}',
    'const badge = oldBadge;',
    'const badge = newBadge;',
    'export default App;',
  ].join('\n') + '\n');
});

test('고르지 않은 충돌이 하나라도 남으면 적용을 막는다', () => {
  setup('side', { 1: 'ours' });
  const resolved = buildResolvedConflictContent();

  assert.ok(!resolved.ok, '미해결 충돌이 있으면 파일을 쓰면 안 된다');
});

test('끝 개행이 없던 파일은 그대로 개행 없이 쓴다', () => {
  setup('side', { 1: 'ours', 3: 'ours' });
  state.conflictView.hasTrailingNewline = false;
  const resolved = buildResolvedConflictContent();

  assert.ok(resolved.ok, resolved.message);
  assert.ok(!resolved.content.endsWith('\n'), '없던 개행을 만들어 내면 diff 가 지저분해진다');
});
