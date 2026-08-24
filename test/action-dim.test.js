// 지금 불가능한 버튼이 실제로 흐리게(딤) 그려지는지 검증.
//
// 배경: 차단은 실행 직전에만 일어나서, 커밋이 도는 동안에도 Stage/Unstage/Fetch 버튼이
// 평소와 똑같이 보였다. 눌러야만 무시됐다는 걸 알 수 있으니 "왜 안 되지"가 반복됐다.
// 판정은 actions.js 가 하고 화면은 그 결과를 그대로 따른다 — 여기서는 판정이 화면까지
// 도달하는지, 그리고 활성 버튼이 딤과 구분되는지를 본다.
//
// 터미널 배경색을 알 수 없으므로 딤은 절대 색상이 아니라 SGR 2(기본 전경색을 흐리게)로
// 표현한다. 그래서 활성 버튼은 기본 전경색(colors.value)이어야 대비가 생긴다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 160, rows: 40 },
  on: () => {},
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { colors, ansi } = require('../ansi');

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const out = [];
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = _origWrite; }
  return out.join('');
}

// 라벨 바로 앞에 붙은 SGR 시퀀스들 — 버튼이 어떤 스타일로 그려졌는지 본다.
function styleBefore(out, label) {
  const idx = out.indexOf(label);
  if (idx < 0) return null;
  const head = out.substring(0, idx);
  const m = head.match(/(?:\x1b\[[0-9;]*m)+$/);
  return m ? m[0] : '';
}

// 앞 버튼의 reset 이 함께 잡히므로 마지막 SGR 만 본다 — 그게 이 라벨에 실제로 적용된 색이다.
const isDimmed = (out, label) => {
  const style = styleBefore(out, label);
  assert.notEqual(style, null, label + ' 버튼이 화면에 없다');
  return style.endsWith(colors.disabled);
};

function resetState() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.indexLocked = false; state.spinnerActive = false; state.error = null;
  state.settlingWrite = false; state.refreshing = false; state.refreshMessage = '';
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin']; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [{ file: 'a.js', status: 'M' }];
  state.unstaged = [{ file: 'b.js', status: 'M' }];
  state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.cursor = 0; state.scrollOffset = 0;
  state.rightView = 'diff'; state.diffView = 'unified';
  state.currentDiffFile = 'b.js'; state.diffLines = [];
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = ''; state.commitAmend = false;
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.diffLoading = false; state.logDetailLoading = false; state.freshDetailLoading = false;
  state.logItems = []; state.logSelectables = []; state.logCursor = 0;
  state.freshItems = []; state.freshCursor = 0;
  state.focusPanel = 'status';
  ui.termCols = 160; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelCollapsed = false; ui.middlePanelCollapsed = false;
  ui.leftPanelScrollOffset = 0; ui.leftRevealBranch = null;
  ui.leftPanelActiveBranch = null; ui.hoveredLeftPanelRow = -1;
  ui.hoveredFileRow = -1; ui.hoveredLogRow = -1; ui.hoveredFreshRow = -1;
  ui.hoveredTitleZoneIndex = -1; ui.hoveredFileHeaderIdx = -1;
  ui.hoveredCommitButton = false; ui.hoveredCommitAmend = false;
  ui.hoveredAction = null;
  ui.collapsedDetailFiles.clear();
}

test('평범한 상태에서는 버튼이 딤이 아니다', () => {
  resetState();
  const out = captureRender();
  for (const label of [' Fetch ', ' Push ', 'Stage All', 'Unstage All']) {
    assert.equal(isDimmed(out, label), false, label + ' 가 이유 없이 흐리면 안 된다');
  }
});

test('쓰기 작업 중에는 스테이징·네트워크 버튼이 모두 딤 처리된다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Committing...';
  const out = captureRender();
  for (const label of [' Fetch ', ' Pull ', ' Push ', ' Stash ', 'Stage All', 'Unstage All']) {
    assert.equal(isDimmed(out, label), true, label + ' 가 쓰기 작업 중에도 활성으로 보인다');
  }
  state.spinnerActive = false; state.error = null;
});

test('커밋이 끝나도 뒷정리 갱신 중에는 Unstage 가 여전히 딤이다', () => {
  // 창 타이틀이 "Committing..."을 계속 보여 주는 구간 — 화면도 같은 말을 해야 한다.
  resetState();
  state.spinnerActive = false;
  state.settlingWrite = true;
  state.refreshing = true;
  state.refreshMessage = 'Committing...';
  const out = captureRender();
  for (const label of ['Unstage All', 'Stage All', 'Commit']) {
    assert.equal(isDimmed(out, label), true, label + ' 가 뒷정리 중에도 눌릴 것처럼 보인다');
  }
  state.settlingWrite = false; state.refreshing = false; state.refreshMessage = '';
});

test('리모트가 없으면 네트워크 버튼만 딤이고 스테이징은 그대로다', () => {
  resetState();
  state.remotes = []; state.remoteBranches = [];
  state.branches = [{ name: 'main', isCurrent: true, upstream: '' }];
  const out = captureRender();
  assert.equal(isDimmed(out, ' Fetch '), true);
  assert.equal(isDimmed(out, ' Pull '), true);
  assert.equal(isDimmed(out, ' Push '), true);
  assert.equal(isDimmed(out, 'Stage All'), false, '로컬 작업까지 막으면 안 된다');
});

test('옮길 파일이 없는 쪽 버튼만 딤 처리된다', () => {
  resetState();
  state.staged = [];             // Unstage 대상 없음
  state.cursor = 0;              // 커서는 unstaged 파일
  const out = captureRender();
  assert.equal(isDimmed(out, 'Stage All'), false);
  assert.equal(isDimmed(out, 'Unstage All'), true, '되돌릴 것이 없는데 활성으로 보인다');
});

test('rebase 진행 중에는 Stash 가 딤이고 Abort 는 살아 있다', () => {
  resetState();
  state.operationState = { type: 'rebase-merge', step: 1, total: 3 };
  const out = captureRender();
  // 진행 중에는 Fetch/Pull/Push/Stash 자리 대신 진행 라벨 + Abort/Skip 이 나온다.
  assert.equal(isDimmed(out, ' Abort '), false, '빠져나올 길은 항상 열려 있어야 한다');
  assert.equal(isDimmed(out, ' Skip '), false);
  // 충돌 해결에 쓰는 스테이징도 그대로 열려 있어야 한다.
  assert.equal(isDimmed(out, 'Stage All'), false);
  state.operationState = null;
});

test('스테이지가 없으면 Commit 버튼이 딤, 있으면 활성이다', () => {
  resetState();
  state.staged = [];
  assert.equal(isDimmed(captureRender(), 'Commit'), true);
  resetState();
  assert.equal(isDimmed(captureRender(), 'Commit'), false);
});

test('커밋 모드에서 메시지가 비면 Commit 이 딤이다', () => {
  resetState();
  state.mode = 'commit';
  state.commitMsg = '';
  assert.equal(isDimmed(captureRender(), 'Commit'), true);
  state.commitMsg = 'a real message';
  state.commitCursor = state.commitMsg.length;
  assert.equal(isDimmed(captureRender(), 'Commit'), false);
  state.mode = 'normal'; state.commitMsg = '';
});

test('index.lock 이 있으면 스테이징은 딤이고 Unlock 은 활성이다', () => {
  resetState();
  state.indexLocked = true;
  const out = captureRender();
  assert.equal(isDimmed(out, 'Stage All'), true);
  assert.equal(isDimmed(out, 'Unlock'), false, '락을 풀 길까지 막으면 빠져나올 수 없다');
  state.indexLocked = false;
});

test('committer 이름/이메일도 쓰기 작업 중에는 딤 처리된다', () => {
  // git config 를 고치는 쓰기 동작인데 힌트바 구석에 있어 예전에는 게이트에서 빠져 있었다.
  resetState();
  state.committerName = 'tester';
  state.committerEmail = 'test@example.com';
  state.committerNameIsLocal = true;
  // 리포 로컬 설정이면 '[L] ' 태그가 라벨 앞에 붙는다 — 스타일은 그 앞에 온다.
  const LABEL = '[L] tester';
  const idleOut = captureRender();
  assert.equal(isDimmed(idleOut, LABEL), false);

  state.spinnerActive = true;
  state.error = 'Committing...';
  const busyOut = captureRender();
  assert.equal(isDimmed(busyOut, LABEL), true, '커밋 중에 눌릴 것처럼 보이면 안 된다');
  const zone = ui.committerClickZones.find(z => z.action === 'committer-name');
  assert.ok(zone, 'committer 클릭 존이 있어야 한다');
  assert.equal(zone.enabled, false, 'zone 에도 판정이 실려야 한다');

  state.spinnerActive = false; state.error = null;
  state.committerNameIsLocal = false;
});

test('딤드 버튼에 마우스를 올리면 hover 강조 대신 사유가 힌트바에 뜬다', () => {
  resetState();
  state.remotes = []; state.remoteBranches = [];
  // 타이틀 행 첫 액션 버튼(Fetch)의 zone 인덱스를 찾아 hover 로 지정한다.
  captureRender();
  const fetchIdx = ui.titleClickZones.findIndex(z => z.action === 'git-fetch');
  assert.ok(fetchIdx >= 0, 'Fetch 버튼 zone 이 있어야 한다');
  assert.equal(ui.titleClickZones[fetchIdx].enabled, false, 'zone 에도 판정이 실려야 한다');

  ui.hoveredTitleZoneIndex = fetchIdx;
  ui.hoveredAction = 'git-fetch';
  const out = captureRender();
  assert.equal(isDimmed(out, ' Fetch '), true, '막힌 버튼은 hover 해도 강조되지 않는다');
  assert.ok(out.includes('No remote configured'), '왜 막혔는지 힌트바에 나와야 한다');

  ui.hoveredTitleZoneIndex = -1; ui.hoveredAction = null;
});

test('활성 버튼은 hover 하면 강조된다', () => {
  resetState();
  captureRender();
  const fetchIdx = ui.titleClickZones.findIndex(z => z.action === 'git-fetch');
  ui.hoveredTitleZoneIndex = fetchIdx;
  ui.hoveredAction = 'git-fetch';
  const out = captureRender();
  const style = styleBefore(out, ' Fetch ');
  assert.ok(style.includes(ansi.bold), 'hover 하면 굵게 강조되어야 한다: ' + JSON.stringify(style));
  ui.hoveredTitleZoneIndex = -1; ui.hoveredAction = null;
});
