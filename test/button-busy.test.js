require('./helpers/git-mutation-host');
// 작업을 시키는 버튼이 자기 작업 동안 눌린 모양으로 스피너를 돌리는지 검증.
// 상단 Fetch/Pull/Push/Stash·Abort/Skip, 커밋 버튼, 파일 목록 헤더의 Stage/Unstage, diff 의
// hunk 버튼, 충돌 해결 적용, committer 편집·초기화, 저장소 설정 화면의 Init/Clone.
//
// 배경: 처리상태(스피너 + 작업 이름)는 창 타이틀에만 나왔다. 세로 탭으로 쓰면 타이틀이 눈에
// 들어오지 않아, 지금 Fetch 가 도는지 화면만 보고는 알 수 없었다.
// → 버튼이 작업 내내(뒷정리 갱신 포함) 반전된 채 스피너를 돌린다.
//
// 여기서 볼 것:
//   1. 버튼으로 시작한 작업이면 그 버튼만 눌리고, 뒷정리가 끝나야 풀린다
//   2. 버튼과 무관한 작업(우클릭 메뉴 등)은 버튼을 누르지 않는다
//   3. 스피너 틱은 화면 전체가 아니라 스피너 칸만 다시 쓴다(큰 저장소에서 입력이 밀리지 않게)
//   4. 그 칸은 실제로 내보낸 화면에서 스피너 글자가 놓인 자리다 — 패널 안 버튼도
const test = require('node:test');
const assert = require('node:assert/strict');

// git 명령은 테스트가 직접 끝낸다 — 작업이 도는 중간의 화면을 보기 위해서다.
let pendingExec = [];
global.hecaton = {
  initialState: { cols: 160, rows: 40 }, terminal: {}, on() {}, fs: {},
  window: { set_title: async () => ({ ok: true }) },
  process: { exec: params => new Promise(resolve => pendingExec.push({ params, resolve })) },
  dialog: { show: () => Promise.resolve({ ok: true }) },
  menu: { show: () => Promise.resolve({ ok: true }) },
};

// 화면 출력은 모아 두고 테스트 리포터 출력만 흘려보낸다.
let screen = [];
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('\x1b[')) { screen.push(chunk); return true; }
  return _origWrite(chunk, ...rest);
};

const { state, ui } = require('../state');
const spinner = require('../spinner');
const refresh = require('../refresh');
const rendering = require('../render');
const coordinate = require('../coordinate');
const { colors, ansi, CSI } = require('../ansi');
const { BRAILLE_FRAMES } = require('../title');
const { isWide } = require('../text');
const { SCOPE, hunkButtonId } = require('../actions');

// 뒷정리 갱신은 실제 refresh 대신 settle 구간만 흉내 낸다 — 버튼 표시가 그 구간까지 이어지는지가
// 관심사이고, 실제 갱신은 수십 개의 git 호출을 낸다. input.js 가 구조 분해로 가져가므로 먼저 바꾼다.
let settles = [];
refresh.refreshInBackground = (options, followup = {}) => {
  const op = followup.settle ? spinner.startSettleOp(followup.message, followup.scopes, followup.button) : null;
  settles.push({ followup, finish() { if (op) spinner.endSettleOp(op); rendering.render(); } });
  return Promise.resolve();
};
refresh.refreshTouchedInBackground = () => Promise.resolve();

const { handleMouseData, handleKey } = require('../input');
const { handleContextMenuAction, handleDialogResult } = require('../context-menu');

const PRESSED = colors.yellow + ansi.bold + ansi.inverse;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function captureRender() {
  screen = [];
  rendering.render();
  return screen.join('');
}

// 라벨 바로 앞의 SGR 묶음 — 버튼이 어떤 스타일로 그려졌는지 본다.
function styleBefore(out, label) {
  const idx = out.indexOf(label);
  if (idx < 0) return null;
  const m = out.substring(0, idx).match(/(?:\x1b\[[0-9;]*m)+$/);
  return m ? m[0] : '';
}

function glyph() {
  return BRAILLE_FRAMES[state.spinnerFrame % BRAILLE_FRAMES.length];
}

// 상단 버튼은 ' Fetch ' 꼴이다.
function pressedLabel(name) {
  return ' ' + glyph() + ' ' + name + ' ';
}

function isPressed(out, name) {
  return isPressedLabel(out, ' ' + name + ' ');
}

// 라벨의 눌린 모양 — 양옆을 비워 둔 라벨(' Abort ')은 여백 안쪽에, 아니면 라벨 앞에 스피너가 붙는다.
function pressedText(label) {
  return label.startsWith(' ') ? ' ' + glyph() + label : glyph() + ' ' + label;
}

function isPressedLabel(out, label) {
  const style = styleBefore(out, pressedText(label));
  return style !== null && style.endsWith(PRESSED);
}

// 내보낸 출력을 화면 격자에 칠한다 — 터미널이 실제로 어느 칸에 무엇을 그리는지 본다.
function paint(out, grid = new Map()) {
  let row = 1, col = 1;
  const re = /\x1b\[([0-9;?]*)([@-~])|\x1b[P\]_][\s\S]*?(?:\x07|\x1b\\)|\x1b.|([\s\S])/gu;
  for (const m of out.matchAll(re)) {
    if (m[2] === 'H' || m[2] === 'f') {
      const [r, c] = m[1].split(';');
      row = Number(r) || 1; col = Number(c) || 1;
    } else if (m[3] !== undefined) {
      grid.set(row + ',' + col, m[3]);
      col += isWide(m[3].codePointAt(0)) ? 2 : 1;
    }
  }
  return grid;
}

// 적어 둔 스피너 칸이 전부 실제 화면의 스피너 글자 위에 있고, 표식은 밖으로 새지 않는다.
function assertSpinnerCellsOnGlyphs(out, expectedCount) {
  assert.equal(out.includes('\x1b[9999;'), false, '스피너 표식이 터미널로 새면 안 된다');
  assert.equal(ui.buttonSpinnerCells.length, expectedCount, '눌린 버튼마다 스피너 칸이 하나씩');
  const grid = paint(out);
  for (const cell of ui.buttonSpinnerCells) {
    assert.equal(grid.get(cell.row + ',' + cell.col), glyph(),
      '스피너 칸(' + cell.row + ',' + cell.col + ')이 실제 스피너 글자 자리가 아니다');
  }
  // 다음 틱에 그 칸만 다음 글자로 바뀌어야 한다.
  state.spinnerFrame++;
  screen = [];
  rendering.repaintButtonSpinners();
  const after = paint(screen.join(''), paint(out));
  for (const cell of ui.buttonSpinnerCells) assert.equal(after.get(cell.row + ',' + cell.col), glyph());
  state.spinnerFrame--;
}

function bodyTop() {
  return ui.lastLayout.startRow + ui.lastLayout.titleRows + 1;
}

function assertIdle(out, name) {
  assert.ok(out.includes(' ' + name + ' '), name + ' 버튼이 평소 모양으로 있어야 한다');
  assert.equal(isPressed(out, name), false, name + ' 가 시키지 않은 작업으로 눌려 있다');
}

async function clickTitle(action) {
  captureRender();
  const zone = ui.titleClickZones.find(z => z.action === action);
  assert.ok(zone, action + ' 버튼이 화면에 없다');
  await handleMouseData(`\x1b[<0;${zone.colStart};${zone.row}M`);
  await tick();   // 네트워크 명령은 작업 조율(runNetworkOp)을 거친 뒤에 나간다
}

function finishGit(result = { ok: true, exit_code: 0, stdout: '', stderr: '' }) {
  const calls = pendingExec;
  pendingExec = [];
  for (const call of calls) call.resolve(result);
}

function resetState() {
  spinner.resetOps();
  coordinate.configure('', '');
  pendingExec = []; settles = []; screen = [];
  Object.assign(state, {
    cwd: 'C:/repo', loading: false, isGitRepo: true, gitNotFound: false, minimized: false,
    operationState: null, conflictView: null, indexLocked: false, spinnerActive: false, error: null,
    settlingWrite: false, refreshing: false, refreshMessage: '', spinnerFrame: 0,
    branch: 'main', branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }],
    remoteBranches: ['origin/main'], remotes: ['origin'], stashes: [],
    worktrees: [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }],
    isLinkedWorktree: false, ahead: 0, behind: 0,
    staged: [{ file: 'a.js', status: 'M' }], unstaged: [{ file: 'b.js', status: 'M' }],
    untracked: [], ignored: [], selectedFiles: new Set(), cursor: 0, scrollOffset: 0,
    rightView: 'diff', diffView: 'unified', currentDiffFile: 'b.js', diffLines: [],
    diffScrollOffset: 0, diffScrollX: 0, mode: 'normal', commitMsg: '', commitCursor: 0,
    commitAmend: false, logLoading: false, logLoadingMore: false, diffLoading: false,
    logDetailLoading: false, freshDetailLoading: false, logItems: [], logSelectables: [],
    logCursor: 0, freshItems: [], freshCursor: 0, focusPanel: 'status',
    pendingDialogAction: null, pendingDialogTarget: null, pendingStash: false,
    committerName: '', committerEmail: '', committerNameIsLocal: false, committerEmailIsLocal: false,
    // 앞 테스트의 실패 알림이 남으면 힌트바가 committer 대신 그 알림을 보여 준다.
    operationError: null,
  });
  Object.assign(ui, {
    termCols: 160, termRows: 40, cellW: 8, cellH: 16, leftPanelCollapsed: false,
    middlePanelCollapsed: false, hoveredTitleZoneIndex: -1, hoveredFileHeaderIdx: -1,
    hoveredDiffHunkIdx: -1, hoveredCommitButton: false, hoveredMergeApplyButton: false,
    hoveredCommitterAction: null, hoveredRepoSetupAction: null, mergeChunkSelections: {},
  });
}

test.beforeEach(resetState);
test.afterEach(() => {
  finishGit({ ok: true, exit_code: 1, stdout: '', stderr: 'test teardown' });
  spinner.resetOps();
  while (spinner.isSpinning()) spinner.releaseSpinner();
});

test('Fetch 버튼을 누르면 작업과 뒷정리가 끝날 때까지 그 버튼만 눌려 있다', async () => {
  await clickTitle('git-fetch');
  assert.equal(pendingExec.length, 1, 'fetch 가 시작돼야 한다');
  assert.deepEqual(pendingExec[0].params.args.slice(0, 1), ['fetch']);

  let out = captureRender();
  assert.equal(isPressed(out, 'Fetch'), true, 'fetch 가 도는 동안 Fetch 버튼이 눌려 있어야 한다');
  for (const name of ['Pull', 'Push', 'Stash']) assertIdle(out, name);

  // git 명령은 끝났지만 목록을 다시 읽는 뒷정리가 남았다 — 타이틀도 아직 "Fetching..."이다.
  finishGit();
  await tick();
  assert.equal(settles.length, 1);
  assert.equal(settles[0].followup.button, 'git-fetch', '뒷정리 갱신이 버튼을 이어 받아야 한다');
  out = captureRender();
  assert.equal(isPressed(out, 'Fetch'), true, '뒷정리 중에 버튼이 먼저 풀리면 작업이 끝난 것처럼 보인다');

  settles[0].finish();
  out = captureRender();
  assertIdle(out, 'Fetch');
  assert.deepEqual(ui.buttonSpinnerCells, [], '작업이 끝나면 스피너 칸도 비어야 한다');
});

test('Pull·Push 버튼도 자기 버튼만 누른다', async () => {
  await clickTitle('git-pull');
  let out = captureRender();
  assert.equal(isPressed(out, 'Pull'), true);
  assertIdle(out, 'Push');
  finishGit();
  await tick();
  assert.equal(settles[0].followup.button, 'git-pull');
  settles[0].finish();

  resetState();
  await clickTitle('git-push');
  out = captureRender();
  assert.equal(isPressed(out, 'Push'), true);
  assertIdle(out, 'Pull');
});

test('fetch 가 실패해도 버튼이 풀린다', async () => {
  await clickTitle('git-fetch');
  finishGit({ ok: true, exit_code: 1, stdout: '', stderr: 'could not read from remote' });
  await tick();
  assert.equal(settles.length, 0, '실패는 뒷정리 경로로 가지 않는다');
  assertIdle(captureRender(), 'Fetch');
});

test('리모트 선택 메뉴에서 고른 푸시도 Push 버튼을 누른다', async () => {
  // 리모트가 여럿이면 Push 버튼이 메뉴를 띄우고, 고른 항목이 push_to_remote:<remote> 로 온다.
  await handleContextMenuAction('push_to_remote:origin');
  assert.equal(spinner.isButtonBusy('git-push'), true);
  assert.equal(isPressed(captureRender(), 'Push'), true);
  await tick();   // push 명령은 네트워크 작업 조율(runNetworkOp)을 거친 뒤에 나간다
  assert.equal(pendingExec.length, 1, 'push 가 시작돼야 한다');
  finishGit();
  await tick();
  assert.equal(settles.length, 1);
  assert.equal(settles[0].followup.button, 'git-push', 'afterGitOp 뒷정리도 버튼을 이어 받는다');
});

test('Stash 확인 뒤 스태시가 도는 동안 Stash 버튼이 눌려 있다', async () => {
  state.pendingStash = true;
  await handleDialogResult({ button_id: 'stash_confirm' });
  assert.equal(isPressed(captureRender(), 'Stash'), true);
  finishGit({ ok: true, exit_code: 1, stdout: '', stderr: 'stash failed' });
  await tick();
  assertIdle(captureRender(), 'Stash');
});

test('버튼과 무관한 작업은 버튼을 누르지 않는다', () => {
  // 브랜치 우클릭 메뉴의 Push 등 — 같은 git 명령이라도 상단 버튼이 시킨 것이 아니다.
  spinner.startSpinner('Pushing...', [SCOPE.REMOTE]);
  const out = captureRender();
  for (const name of ['Fetch', 'Pull', 'Push', 'Stash']) assert.equal(isPressed(out, name), false, name);
  assert.deepEqual(ui.buttonSpinnerCells, []);
});

test('스피너 틱은 스피너 칸만 다음 글자로 덮어 쓴다', () => {
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  const zone = ui.titleClickZones.find(z => z.action === 'git-fetch');
  assert.deepEqual(ui.buttonSpinnerCells, [{ row: zone.row, col: zone.colStart + 1, style: PRESSED }],
    '라벨 앞 공백 다음 칸이 스피너 자리다');

  state.spinnerFrame = 3;
  screen = [];
  rendering.repaintButtonSpinners();
  assert.deepEqual(screen, [ansi.moveTo(zone.row, zone.colStart + 1) + PRESSED + BRAILLE_FRAMES[3] + ansi.reset]);
});

test('스피너 타이머가 도는 동안 화면 전체를 다시 그리지 않는다', async () => {
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  screen = [];
  await new Promise(resolve => setTimeout(resolve, 260));   // 80ms 틱이 세 번 남짓
  assert.ok(screen.length >= 2, '스피너가 돌아야 한다');
  for (const chunk of screen) {
    assert.equal(chunk.includes(ansi.hideCursor), false, '틱마다 전체 프레임을 그리고 있다');
    assert.ok(chunk.length < 64, '스피너 칸만 쓰는 짧은 출력이어야 한다: ' + JSON.stringify(chunk));
  }
});

test('커밋 메시지를 쓰는 중이면 덮어 쓴 뒤 커서를 입력 자리로 돌려놓는다', () => {
  state.mode = 'commit';
  state.commitMsg = 'wip';
  state.commitCursor = 3;
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  assert.ok(ui.imeCursor, '커밋 입력 중의 커서 자리를 적어 둬야 한다');
  screen = [];
  rendering.repaintButtonSpinners();
  assert.ok(screen.join('').endsWith(ansi.moveTo(ui.imeCursor.row, ui.imeCursor.col)),
    'IME 조합 위치가 스피너 칸으로 끌려가면 안 된다');
});

test('버튼이 화면 밖으로 밀려나면 스피너 칸을 적지 않는다', () => {
  // autowrap 이 꺼져 있어 오른쪽 끝 너머에 쓰면 마지막 열을 덮어 쓴다.
  ui.termCols = 20;
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  assert.deepEqual(ui.buttonSpinnerCells, []);
});

test('최소화된 동안에는 스피너 칸을 덮어 쓰지 않는다', () => {
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  state.minimized = true;
  captureRender();
  screen = [];
  rendering.repaintButtonSpinners();
  assert.deepEqual(screen, []);
});

test('진행 중인 rebase 로 버튼 자리가 바뀌면 스피너 칸도 사라진다', () => {
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  assert.equal(ui.buttonSpinnerCells.length, 1);
  state.operationState = { type: 'rebase-merge', step: 1, total: 3 };
  captureRender();
  assert.deepEqual(ui.buttonSpinnerCells, []);
});

test('눌린 버튼 위에 마우스를 올리면 반전은 그대로 두고 밑줄만 얹는다', () => {
  spinner.startSpinner('Fetching...', [SCOPE.REMOTE], 'git-fetch');
  captureRender();
  const idx = ui.titleClickZones.findIndex(z => z.action === 'git-fetch');
  ui.hoveredTitleZoneIndex = idx;
  const out = captureRender();
  // Fetch 는 도는 중에 다시 누르면 한 번 더 예약되므로 클릭을 받는다.
  assert.equal(ui.titleClickZones[idx].enabled, true);
  assert.ok(styleBefore(out, pressedLabel('Fetch')).endsWith(PRESSED + CSI + '4m'));
});

// ── 패널 안의 버튼 ──
// 아래부터는 화면 좌표를 그 자리에서 모르는 버튼들이다(패널 기준 문자열로 만들어져 나중에 놓인다).
// 스피너 칸은 내보낸 프레임에서 읽어 내므로, 칸이 실제 글자 자리인지까지 본다.

const HUNK_DIFF = [
  'diff --git a/b.js b/b.js', 'index 1111111..2222222 100644', '--- a/b.js', '+++ b/b.js',
  '@@ -1,2 +1,2 @@', '-one', '+uno', ' keep',
  '@@ -10,2 +10,2 @@', '-ten', '+diez', ' keep',
];

test('Stage All 이 도는 동안 파일 목록 헤더의 그 버튼만 눌린다', () => {
  spinner.startSpinner('Staging all...', [SCOPE.INDEX], 'stageAll');
  const out = captureRender();
  assert.equal(isPressedLabel(out, '*Stage All'), true);
  // 라벨 앞 기호(* 모두, ✓ 고른 것)부터 버튼 끝(reset)까지 맞춰 본다 — 한 라벨이 다른 라벨의
  // 앞부분이면 엉뚱한 버튼의 눌림을 보게 된다.
  for (const label of ['✓Stage', '*Unstage All', '✓Unstage']) {
    assert.equal(isPressedLabel(out, label + ansi.reset), false, label + ' 는 눌리지 않아야 한다');
  }
  assertSpinnerCellsOnGlyphs(out, 1);
  // 넓어진 라벨만큼 앞의 빈칸이 줄어 헤더 줄이 패널 폭 안에 머문다.
  const middleW = ui.lastLayout.middleW;
  for (const zone of ui.fileHeaderZones) assert.ok(zone.btnColEnd < middleW, zone.action + ' 가 패널 밖으로 밀렸다');
});

test('헤더의 Stage 버튼을 누르면 git add 가 도는 동안 눌려 있다', async () => {
  state.cursor = 0;   // b.js (Unstaged)
  captureRender();
  const zone = ui.fileHeaderZones.find(z => z.action === 'stageSelected');
  const midStart = ui.lastLayout.startCol + ui.lastLayout.leftW + ui.lastLayout.divider1W;
  await handleMouseData(`\x1b[<0;${midStart + zone.btnColStart};${bodyTop() + zone.lineIdx}M`);
  await tick();
  assert.equal(pendingExec.length, 1, 'git add 가 시작돼야 한다');
  const out = captureRender();
  assert.equal(isPressedLabel(out, '✓Stage' + ansi.reset), true);
  assert.equal(isPressedLabel(out, '*Stage All'), false);
  assertSpinnerCellsOnGlyphs(out, 1);
});

test('우클릭 메뉴의 Stage 도 헤더의 Stage 버튼을 누른다', async () => {
  // 같은 일을 하는 다른 문 — 무엇이 도는지는 버튼이 알려 준다.
  state.cursor = 0;
  captureRender();
  ui.contextMenuFileItem = { kind: 'file', section: 'unstaged', type: 'unstaged', file: 'b.js' };
  ui.contextMenuFileItems = null;
  // git add 가 끝나기를 기다리는 동작이라 기다리지 않고 도는 중을 본다.
  const done = handleContextMenuAction('file_stage');
  await tick();
  assert.equal(spinner.isButtonBusy('stageSelected'), true);
  finishGit({ ok: true, exit_code: 1, stdout: '', stderr: 'stop' });
  await done;
  ui.contextMenuFileItem = null;
});

test('누른 hunk 의 버튼만 눌리고 hunk 버튼들의 오른쪽 끝은 맞춰진다', () => {
  state.diffLines = HUNK_DIFF.slice();
  captureRender();
  const item = { type: 'unstaged', file: 'b.js' };
  const idleZones = ui.diffHunkZones.map(z => ({ ...z }));
  assert.equal(idleZones.length, 2, 'hunk 버튼이 둘 있어야 한다');

  spinner.startSpinner('Staging hunk...', [SCOPE.INDEX], hunkButtonId(item, 1));
  const out = captureRender();
  assert.equal(out.split(pressedText('[Stage hunk]')).length - 1, 1, '누른 hunk 하나만 눌려야 한다');
  assertSpinnerCellsOnGlyphs(out, 1);
  const zones = ui.diffHunkZones;
  assert.equal(zones[0].colEnd, zones[1].colEnd, '눌린 버튼과 나머지의 오른쪽 끝이 같아야 한다');
  assert.equal(zones[1].colEnd, idleZones[1].colEnd, '오른쪽 끝은 평소 자리 그대로다');

  // 다른 파일의 같은 번호 hunk 는 눌리지 않는다.
  spinner.resetOps();
  spinner.startSpinner('Staging hunk...', [SCOPE.INDEX], hunkButtonId({ type: 'unstaged', file: 'other.js' }, 1));
  assert.equal(captureRender().includes(pressedText('[Stage hunk]')), false);
});

test('hunk 버튼을 누르면 그 hunk 의 작업으로 등록된다', async () => {
  state.diffLines = HUNK_DIFF.slice();
  captureRender();
  const zone = ui.diffHunkZones[0];
  const rpStart = ui.lastLayout.startCol + ui.lastLayout.leftW + ui.lastLayout.divider1W
    + ui.lastLayout.middleW + ui.lastLayout.divider2W;
  // 클릭 처리가 git apply 가 끝나기를 기다리므로 기다리지 않고 도는 중을 본다.
  const done = handleMouseData(`\x1b[<0;${rpStart + zone.colStart};${bodyTop() + zone.lineIdx}M`);
  await tick();
  assert.equal(spinner.isButtonBusy(hunkButtonId({ type: 'unstaged', file: 'b.js' }, 0)), true);
  assert.equal(spinner.isButtonBusy(hunkButtonId({ type: 'unstaged', file: 'b.js' }, 1)), false);
  finishGit({ ok: true, exit_code: 1, stdout: '', stderr: 'stop' });
  await done;
});

test('커밋은 git commit 과 뒷정리 갱신이 끝날 때까지 Commit 버튼이 눌려 있다', async () => {
  state.mode = 'commit';
  state.commitMsg = 'msg';
  state.commitCursor = 3;
  await handleKey(CSI + '13;5u');
  await tick();
  assert.deepEqual(pendingExec.map(c => c.params.args.slice(0, 1)), [['commit']]);
  let out = captureRender();
  // 제출하는 순간 커밋 모드를 벗어나므로 일반 모드의 Commit 버튼이 눌린다.
  assert.equal(isPressedLabel(out, 'Commit'), true);
  assertSpinnerCellsOnGlyphs(out, 1);

  finishGit();
  await tick();
  assert.equal(settles[0].followup.button, 'commit-submit');
  assert.equal(isPressedLabel(captureRender(), 'Commit'), true, '뒷정리 중에 풀리면 커밋이 끝난 것처럼 보인다');
  settles[0].finish();
  out = captureRender();
  assert.equal(isPressedLabel(out, 'Commit'), false);
  assert.deepEqual(ui.buttonSpinnerCells, []);
});

test('committer 초기화(×)를 누르면 그 자리가 눌린 채 돈다', async () => {
  state.committerName = 'tester';
  state.committerEmail = 'test@example.com';
  state.committerNameIsLocal = true;
  captureRender();
  const zone = ui.committerClickZones.find(z => z.action === 'reset-committer-name');
  assert.ok(zone, '초기화 버튼이 있어야 한다');
  // 클릭 처리가 git config 가 끝나기를 기다리므로 기다리지 않고 도는 중을 본다.
  const done = handleMouseData(`\x1b[<0;${zone.colStart};${zone.row}M`);
  await tick();
  assert.equal(spinner.isButtonBusy('reset-committer-name'), true);
  const out = captureRender();
  assert.equal(isPressedLabel(out, '×'), true);
  assertSpinnerCellsOnGlyphs(out, 1);
  finishGit({ ok: true, exit_code: 1, stdout: '', stderr: 'stop' });
  await done;
});

test('Abort 가 도는 동안 상단 Abort 버튼이 눌려 있다', () => {
  state.operationState = { type: 'merge' };
  spinner.startSpinner('Aborting merge...', [SCOPE.INDEX, SCOPE.WORKTREE, SCOPE.REFS], 'op-abort');
  const out = captureRender();
  assert.equal(isPressedLabel(out, ' Abort '), true);
  assertSpinnerCellsOnGlyphs(out, 1);
});

test('충돌 해결을 적용하는 동안 Apply resolution 이 눌려 있다', () => {
  state.operationState = { type: 'merge' };
  state.unstaged = [{ file: 'b.js', status: 'U' }];
  state.staged = [];
  state.conflictView = { file: 'b.js', chunks: [
    { type: 'context', lines: ['a'] },
    { type: 'conflict', ours: ['b'], theirs: ['c'] },
  ], hasTrailingNewline: true };
  ui.mergeConflictFile = 'b.js';
  ui.mergeChunkCursor = 1;
  ui.mergeChunkSelections = { 1: 'ours' };
  spinner.startSpinner('Applying resolution...', [SCOPE.INDEX, SCOPE.WORKTREE], 'merge-apply');
  const out = captureRender();
  assert.equal(isPressedLabel(out, ' Apply resolution '), true);
  assertSpinnerCellsOnGlyphs(out, 1);
});

test('저장소 설정 화면의 Clone 은 상단과 본문 버튼이 함께 눌린다', () => {
  state.isGitRepo = false;
  state.branch = '';
  spinner.startSpinner('Cloning repo...', undefined, 'tab_clone');
  const out = captureRender();
  assert.equal(isPressedLabel(out, ' Clone Repository... '), true, '상단 버튼');
  assert.equal(isPressedLabel(out, '[C] Clone Repository...'), true, '본문 버튼');
  assertSpinnerCellsOnGlyphs(out, 2);
  assert.equal(isPressedLabel(out, ' Initialize Here '), false);
});
