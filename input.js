const { ESC, CSI, ansi } = require('./ansi');
const { state, ui } = require('./state');
const hostScroll = require('./scroll');
const { gitStageAll, gitUnstageAll, gitStashSave, gitUnsetConfigLocal,
  gitCommitAsync, gitCommitAmendAsync, gitCommitMessage, gitFetchAsync, gitPullAsync, gitPushAsync, gitPushToRemoteAsync,
  splitUpstreamRef,
  gitRebaseAsync, gitRebaseContinueAsync, gitRebaseAbortAsync, gitRebaseSkipAsync,
  gitMergeAbort, gitCherryPickAbort, gitCherryPickSkip, gitRevertAbort, gitRevertSkip,
  gitStageAsync, gitStageMultiple, gitUnstageMultiple,
  gitWriteRebaseMessage, gitCheckRebaseConflicts, gitWriteConflictResolution,
  buildHunkPatchText, gitApplyPatchText,
} = require('./git');
const { startSpinner, updateSpinner, stopSpinner, showToast } = require('./spinner');
// 동작 가능 여부는 actions.js 한 곳에서 판정한다 — 화면의 딤 처리와 여기의 차단이
// 같은 규칙을 봐야 "보이는데 안 눌린다"가 생기지 않는다.
const { guardAction, runOrQueue, isEnabled, disabledReason, stageableTargets, unstageableTargets, SCOPE } = require('./actions');
// 이 작업이 무엇을 붙잡는지 startSpinner 에 함께 넘긴다 — 넘기지 않으면 예전처럼
// 전부 붙잡은 것으로 보고 모든 쓰기를 막는다(보수적 기본값).
const { INDEX, WORKTREE, REFS, REMOTE, STASH, CONFIG } = SCOPE;
// 자주 쓰는 묶음 — 뜻은 context-menu.js 의 같은 이름 주석 참고.
const CHECKOUT_SCOPES = [INDEX, WORKTREE, REFS];
const WORKTREE_SCOPES = [INDEX, WORKTREE];
const COMMIT_SCOPES = [INDEX, REFS];
const PULL_SCOPES = [INDEX, WORKTREE, REFS, REMOTE];
const { buildFileList, selectedItem, sectionRangeAt, setFileTreeView, toggleFileDir, selectedLogRef, refreshAsync, refreshLog, loadMoreLog, rebuildLogGraphRows, logCacheHasRecovery, updateLogDetail, updateDiff, FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail, refreshInBackground, applyStageToState, applyUnstageToState, touchUserRefreshTime, invalidateCommitterCache } = require('./refresh');
const { render, revealBranch } = require('./render');
const { buildHistoryContextMenuItems, buildStashContextMenuItems, buildFileContextMenuItems, buildDirContextMenuItems, buildRemotesContextMenuItems, buildPushRemoteMenuItems, buildRemoteBranchContextMenuItems, buildBranchContextMenuItems, buildTabContextMenuItems, buildWorktreeContextMenuItems, handleContextMenuAction, runCreateBranch } = require('./context-menu');
const { takeCommitDraft } = require('./persist');

let currentMouseShape = 'default';
function setMouseShape(shape) {
  if (shape !== currentMouseShape) {
    currentMouseShape = shape;
    process.stdout.write(ansi.mouseShape(shape));
  }
}

function actionToKey(action) {
  switch (action) {
    case 'stage':    return 's';
    case 'unstage':  return 'u';
    case 'all':      return 'a';
    case 'commit':   return 'c';
    case 'log':      return 'l';
    case 'rebase':   return 'b';
    case 'refresh':  return 'r';
    case 'tab':      return '\t';
    case 'quit':     return 'q';
    default:         return '';
  }
}

const COMMITTER_ACTIONS = new Set([
  'committer-name', 'committer-email', 'reset-committer-name', 'reset-committer-email',
]);

async function handleCommitterAction(action) {
  // 이 함수는 "내가 처리했는가"를 돌려주므로, 내 소관이 아닌 액션은 게이트도 태우지 않는다.
  if (!COMMITTER_ACTIONS.has(action)) return false;
  // committer 설정 변경은 git config 를 고친다 — 쓰기 작업 중에는 미룬다.
  if (!guardAction(action)) return true;
  if (action === 'reset-committer-name' || action === 'reset-committer-email') {
    const key = action === 'reset-committer-name' ? 'user.name' : 'user.email';
    // git config 는 .git/config.lock 을 잡는다 — 같은 CONFIG 를 쓰는 다른 작업
    // (브랜치 추적 설정, 리모트 편집)과 겹치면 "could not lock config file"로 실패한다.
    // 판정표에는 [CONFIG]로 적어 두고 실행이 신고하지 않으면 그 판정이 헛돈다.
    const resetOp = startSpinner('Resetting committer...', [CONFIG]);
    const err = await gitUnsetConfigLocal(state.cwd, key);
    if (err) {
      stopSpinner(resetOp);
      showErrorDialog(err);
      render();
    } else {
      // 방금 내가 바꾼 값이다 — TTL 을 기다리지 않고 다음 refresh 가 바로 다시 읽게 한다.
      invalidateCommitterCache();
      refreshInBackground({}, { message: 'Resetting committer...', settle: true, scopes: resetOp.scopes });
      stopSpinner(resetOp);
    }
    return true;
  }

  if (action === 'committer-name' || action === 'committer-email') {
    const isName = action === 'committer-name';
    state.pendingCommitterEdit = isName ? 'name' : 'email';
    hecaton.dialog.show({
      type: 'input',
      title: isName ? 'Committer Name' : 'Committer Email',
      message: isName ? 'Enter name for local git commits:' : 'Enter email for local git commits:',
      defaultValue: isName ? (state.committerName || '') : (state.committerEmail || ''),
      buttons: [
        { id: 'ok', label: 'OK', default: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    return true;
  }

  return false;
}

function showErrorDialog(msg) {
  // 쓰기 작업 진행 중에는 힌트바의 진행 메시지를 유지한다.
  if (!state.spinnerActive) state.error = null;
  hecaton.dialog.show({
    type: 'message',
    title: 'Error',
    message: msg,
    buttons: [{ id: 'ok', label: 'OK', default: true }],
  });
}

// Detect a branch whose upstream carries a different name, which is what a
// rename leaves behind: `git branch -m` keeps branch.<name>.merge pointing at
// the old remote branch, and a bare `git push` then aborts under the default
// push.default=simple. Returns the parts needed to offer both targets.
function getUpstreamNameMismatch(branch) {
  if (!branch || !branch.upstream) return null;
  const parts = splitUpstreamRef(branch.upstream, state.remotes);
  if (!parts.remote || !parts.branch || parts.branch === branch.name) return null;
  return { remote: parts.remote, local: branch.name, upstream: branch.upstream, upstreamBranch: parts.branch };
}

function shortRefLabel(name) {
  return name.length > 24 ? name.substring(0, 23) + '…' : name;
}

function showPushNameMismatchDialog(info) {
  hecaton.dialog.show({
    type: 'message',
    title: 'Push',
    message: "Local branch '" + info.local + "' tracks '" + info.upstream + "', which has a different name.\n\n"
      + "Push as '" + info.local + "': updates '" + info.remote + '/' + info.local + "' and retargets the upstream.\n"
      + "Push to '" + info.upstreamBranch + "': updates the tracked branch and keeps the current upstream.",
    buttons: [
      { id: 'push_local', label: "Push as '" + shortRefLabel(info.local) + "'", default: true },
      { id: 'push_upstream', label: "Push to '" + shortRefLabel(info.upstreamBranch) + "'" },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  state.pendingDialogAction = 'push-name-mismatch';
  state.pendingDialogTarget = info;
}

// Push current branch. With multiple remotes, let the user pick one via a
// context menu (handled by 'push_to_remote:' in context-menu.js); otherwise
// push directly to the tracked/sole remote.
//
// 게이트는 호출부(requestPush)가 맡는다 — 예약되어 나중에 실행될 때는 대기열이 이미
// 판정을 마친 뒤라, 여기서 또 보면 같은 검사를 두 번 하게 된다.
function pushCurrentBranch() {
  if (state.remotes.length > 1) {
    hecaton.menu.show({ items: buildPushRemoteMenuItems() }).catch(() => null);
    return;
  }
  const currentBranch = state.branches.find(b => b.isCurrent) || state.branches.find(b => b.name === state.branch);
  const mismatch = getUpstreamNameMismatch(currentBranch);
  if (mismatch) {
    showPushNameMismatchDialog(mismatch);
    return;
  }
  const pushOp = startSpinner('Pushing...', [REMOTE]);
  const pushPromise = currentBranch && !currentBranch.upstream
    ? (state.remotes.length > 0
        ? gitPushToRemoteAsync(state.cwd, state.remotes[0], currentBranch.name)
        : Promise.resolve('No remote configured for push'))
    : gitPushAsync(state.cwd);
  pushPromise.then(async err => {
    if (err) {
      stopSpinner(pushOp);
      showErrorDialog(err);
      render();
    } else {
      // 후속 갱신까지가 "Push" 한 동작이다 — 라벨을 이어 주고, 스피너를 넘겨준 뒤 내린다
      // (afterGitOp과 같은 이유: 사이에 참조가 0이 되면 제목이 한 번 깜빡인다).
      refreshInBackground({ metadataOnly: true, forceMeta: true }, { refreshLog: true, refreshFresh: true, message: 'Pushing...', settle: true, scopes: pushOp.scopes });
      stopSpinner(pushOp);
    }
  });
}

// ── 리모트 동작의 진입점 ──
// 셋 다 화면에서 대상을 고르지 않는다(무엇을 올리고 받을지는 실행 순간의 HEAD 와
// 업스트림 설정이 정한다). 그래서 지금 막혀 있으면 버리지 않고 예약해 두었다가,
// 붙잡고 있던 작업이 끝날 때 그대로 실행한다 — 커밋을 걸고 곧바로 Push 를 누르는
// 흐름이 이 셋이다. 예약 조건과 그 전제는 actions.QUEUEABLE_ACTIONS 에 있다.
function requestPush() {
  runOrQueue('git-push', pushCurrentBranch);
}

function runFetch() {
  const fetchOp = startSpinner('Fetching...', [REMOTE]);
  gitFetchAsync(state.cwd).then(async err => {
    if (err) {
      stopSpinner(fetchOp);
      showErrorDialog(err);
      render();
    } else {
      refreshInBackground({ metadataOnly: true }, { refreshLog: true, refreshFresh: true, message: 'Fetching...', settle: true, scopes: fetchOp.scopes });
      stopSpinner(fetchOp);
    }
  });
}

function requestFetch() {
  runOrQueue('git-fetch', runFetch);
}

function runPull() {
  const pullOp = startSpinner('Pulling...', PULL_SCOPES);
  gitPullAsync(state.cwd).then(async err => {
    if (err) {
      stopSpinner(pullOp);
      showErrorDialog(err);
      render();
    } else {
      refreshInBackground({}, { refreshLog: true, refreshFresh: true, message: 'Pulling...', settle: true, scopes: pullOp.scopes });
      stopSpinner(pullOp);
    }
  });
}

function requestPull() {
  runOrQueue('git-pull', runPull);
}

function maybeLoadMoreLog() {
  if (state.rightView !== 'log' || !state.logHasMore || state.logLoadingMore) return;
  const cursorRemaining = state.logSelectables.length > 0
    ? state.logSelectables.length - 1 - state.logCursor
    : Infinity;
  const scrollRemaining = state.logItems.length - (state.logScrollOffset + (ui.lastLogListH || 0));
  if (cursorRemaining <= 50 || scrollRemaining <= 50) loadMoreLog();
}

function isStaleRebaseError(err) {
  return err && (err.includes('rebase-merge') || err.includes('rebase-apply'));
}

function isRebaseConflictError(err) {
  return err && (err.includes('could not apply') || err.includes('Resolve all conflicts') || err.includes('CONFLICT') || err.includes('fix conflicts') || err.includes('needs merge'));
}

function switchToDiffViewForConflict() {
  if (state.rightView !== 'diff') {
    state.rightView = 'diff';
    updateDiff();
  }
}

function getConflictChunkIndices() {
  if (!state.conflictView) return [];
  return state.conflictView.chunks
    .map((chunk, idx) => chunk.type === 'conflict' ? idx : -1)
    .filter(idx => idx >= 0);
}

function moveConflictChunkCursor(delta) {
  const conflictIndices = getConflictChunkIndices();
  if (conflictIndices.length === 0) return false;
  const currentPos = Math.max(0, conflictIndices.indexOf(ui.mergeChunkCursor));
  const nextPos = Math.max(0, Math.min(conflictIndices.length - 1, currentPos + delta));
  ui.mergeChunkCursor = conflictIndices[nextPos];
  ensureConflictCursorVisible();
  return true;
}

function ensureConflictCursorVisible() {
  const range = ui.mergeChunkLineMap ? ui.mergeChunkLineMap[ui.mergeChunkCursor] : null;
  // 머리말은 고정이라 스크롤되는 건 그 아래뿐이다 — 전체 높이로 계산하면 커서 청크가
  // 머리말 뒤에 숨은 채로 "보인다"고 판단한다.
  const viewport = Math.max(1, ui.conflictBodyH || ui.rightDiffH || 1);
  if (!range) return;
  if (range.start < state.diffScrollOffset) {
    state.diffScrollOffset = range.start;
  } else if (range.end >= state.diffScrollOffset + viewport) {
    state.diffScrollOffset = Math.max(0, range.end - viewport + 1);
  }
}

// 이미 고른 쪽을 다시 누르면 고르기 전으로 돌아간다 — 잘못 누른 선택을 물릴 방법이
// 없으면 화면을 떠났다 오는 것 말고는 되돌릴 수가 없다.
function setConflictSelection(chunkIndex, pick) {
  if (ui.mergeChunkSelections[chunkIndex] === pick) delete ui.mergeChunkSelections[chunkIndex];
  else ui.mergeChunkSelections[chunkIndex] = pick;
}

function buildResolvedConflictContent() {
  if (!state.conflictView) return { ok: false, message: 'No conflict view is active' };
  const outLines = [];
  for (let i = 0; i < state.conflictView.chunks.length; i++) {
    const chunk = state.conflictView.chunks[i];
    if (chunk.type === 'context') {
      outLines.push(...chunk.lines);
      continue;
    }
    const selection = ui.mergeChunkSelections[i];
    if (selection !== 'ours' && selection !== 'theirs' && selection !== 'both') {
      return { ok: false, message: 'Select a side for every conflict chunk before applying' };
    }
    // both 는 화면에 놓인 순서대로 — 왼쪽(ours) 다음 오른쪽(theirs)이다.
    if (selection === 'both') outLines.push(...chunk.ours, ...chunk.theirs);
    else outLines.push(...(selection === 'ours' ? chunk.ours : chunk.theirs));
  }

  let content = outLines.join('\n');
  if (state.conflictView.hasTrailingNewline) content += '\n';
  return { ok: true, content };
}

// commit 모드 amend 토글. 켜는 시점에 메시지가 비어 있으면 HEAD 메시지를 채워 넣는다.
function toggleCommitAmend() {
  if (state.operationState) return;
  state.commitAmend = !state.commitAmend;
  if (state.commitAmend && state.commitMsg.trim() === '') {
    gitCommitMessage(state.cwd, 'HEAD').then(msg => {
      if (state.mode === 'commit' && state.commitAmend && state.commitMsg.trim() === '' && msg) {
        state.commitMsg = msg;
        state.commitCursor = msg.length;
        render();
      }
    }).catch(() => null);
  }
  render();
}

// 일반 commit 모드 진입 ('c' 키 / 커밋 버튼 / 입력행 클릭 공용).
// rebase 중이면 rebase 메시지를, 아니면 이전 세션에서 복구된 드래프트를 채운다.
function enterCommitMode() {
  state.mode = 'commit';
  state.commitAmend = false;
  if (state.operationState && state.rebaseMessage) {
    state.commitMsg = state.rebaseMessage;
  } else {
    state.commitMsg = takeCommitDraft() || '';
  }
  state.commitCursor = state.commitMsg.length;
  render();
}

// amend를 켠 상태로 commit 모드 진입 (staged 없어도 메시지 수정 가능)
function enterAmendCommitMode() {
  if (state.operationState) return;
  state.mode = 'commit';
  state.commitAmend = true;
  state.commitMsg = '';
  state.commitCursor = 0;
  render();
  gitCommitMessage(state.cwd, 'HEAD').then(msg => {
    if (state.mode === 'commit' && state.commitAmend && state.commitMsg === '' && msg) {
      state.commitMsg = msg;
      state.commitCursor = msg.length;
      render();
    }
  }).catch(() => null);
}

// ── 스테이징 실행부 ──
// [s]/[u] 키, 파일 목록 헤더의 Stage/Unstage 버튼이 같은 코드를 쓴다. 대상 계산도
// 활성 여부 판정과 같은 함수(actions.stageableTargets)를 쓰므로, 버튼이 살아 있는데
// 눌러도 아무 일이 없는 어긋남이 생기지 않는다.
// 대상은 부르는 쪽이 정해서 넘긴다 — 예약을 거쳐 나중에 실행될 때 화면의 선택을 다시
// 읽으면 그때는 이미 다른 파일이 골라져 있다(requestStageSelection 참고).
async function runStageSelection(isStage, files) {
  if (!files || files.length === 0) return;
  const op = startSpinner(isStage ? 'Staging...' : 'Unstaging...', [INDEX]);
  const err = isStage
    ? await gitStageMultiple(state.cwd, files)
    : await gitUnstageMultiple(state.cwd, files);
  finishStageOp(isStage, files, err, op);
}

// ── 스테이징 요청 ──
// git add 는 프로세스를 새로 띄우는 일이라, 그 사이에 고른 다음 파일이 예전에는 통째로
// 버려졌다("busy, action ignored"). 이제는 지금 고른 대상을 확정해 예약에 실어 보낸다.
// 연달아 누르면 대상이 한 예약으로 합쳐져(merge:'union') git 도 한 번만 부른다.
//
// 대상 계산은 활성 여부 판정과 같은 함수(actions.stageableTargets)를 쓴다 — 버튼이
// 살아 있는데 눌러도 아무 일이 없는 어긋남이 생기지 않는다.
function requestStageFiles(isStage, files) {
  const id = isStage ? 'stageSelected' : 'unstageSelected';
  // 고를 것이 없으면 판정에 맡긴다 — 사유(Nothing to stage 등)는 그쪽이 안다.
  if (!files || files.length === 0) { guardAction(id); return; }
  runOrQueue(id, list => runStageSelection(isStage, list), { payload: files });
}

function requestStageSelection(isStage) {
  const files = (isStage ? stageableTargets() : unstageableTargets()).map(t => t.file);
  if (files.length === 0) { guardAction(isStage ? 'stageSelected' : 'unstageSelected'); return; }
  state.selectedFiles.clear();
  requestStageFiles(isStage, files);
}

async function runStageAll(isStage) {
  // 트리 모드에서는 폴더 줄도 목록에 있다 — 경로가 없으므로 파일 줄만 센다.
  const files = buildFileList()
    .filter(item => item.kind !== 'dir')
    .filter(item => (isStage ? item.type !== 'staged' && item.type !== 'ignored' : item.type === 'staged'))
    .map(item => item.file);
  if (files.length === 0) return;
  state.selectedFiles.clear();
  const op = startSpinner(isStage ? 'Staging all...' : 'Unstaging all...', [INDEX]);
  const err = isStage ? await gitStageAll(state.cwd) : await gitUnstageAll(state.cwd);
  finishStageOp(isStage, files, err, op);
}

// 전부 담기/내리기는 대상이 "그때의 전부"라 들고 갈 목록이 없다 — 실행하는 순간의
// 화면을 기준으로 삼는 것이 오히려 사용자가 뜻한 바다.
function requestStageAll(isStage) {
  runOrQueue(isStage ? 'stageAll' : 'unstageAll', () => runStageAll(isStage));
}

// op 은 startSpinner 가 돌려준 작업 표다 — 인덱스만 붙잡는 스테이징은 fetch 같은 다른
// 작업과 겹쳐 돌 수 있으므로, 끝낼 때 자기 것을 지목해야 상대를 대신 끝내지 않는다.
function finishStageOp(isStage, files, err, op) {
  stopSpinner(op);
  if (err) {
    showErrorDialog(err);
    render();
    return;
  }
  if (isStage) applyStageToState(files);
  else applyUnstageToState(files);
  refreshInBackground({ statusOnly: true });
}

// diff 패널의 [Stage hunk]/[Unstage hunk] 버튼 동작
async function applyHunkAction(hunkIdx) {
  if (!guardAction('hunk-apply')) return;
  const item = selectedItem();
  if (!item || (item.type !== 'staged' && item.type !== 'unstaged')) return;
  const patch = buildHunkPatchText(state.diffLines, hunkIdx);
  if (!patch) {
    showErrorDialog('Failed to build hunk patch');
    render();
    return;
  }
  const isStagedView = item.type === 'staged';
  const hunkOp = startSpinner(isStagedView ? 'Unstaging hunk...' : 'Staging hunk...', [INDEX]);
  const err = await gitApplyPatchText(state.cwd, patch, { cached: true, reverse: isStagedView });
  if (err) {
    stopSpinner(hunkOp);
    showErrorDialog((isStagedView ? 'Unstage hunk' : 'Stage hunk') + ' failed:\n' + err);
    render();
    return;
  }
  await refreshAsync({ statusOnly: true });
  stopSpinner(hunkOp);
  ui.hoveredDiffHunkIdx = -1;
  updateDiff();
  render();
}

async function applyConflictSelections() {
  if (!guardAction('conflict-apply')) return;
  const sel = selectedItem();
  const resolved = buildResolvedConflictContent();
  if (!resolved.ok) {
    showErrorDialog(resolved.message);
    render();
    return;
  }

  const resolveOp = startSpinner('Applying resolution...', WORKTREE_SCOPES);
  const writeErr = await gitWriteConflictResolution(state.cwd, sel.file, resolved.content);
  if (writeErr) {
    stopSpinner(resolveOp);
    showErrorDialog(writeErr);
    render();
    return;
  }

  const stageErr = await gitStageAsync(state.cwd, sel.file);
  if (stageErr) {
    stopSpinner(resolveOp);
    showErrorDialog(stageErr);
    render();
    return;
  }

  await refreshAsync();
  stopSpinner(resolveOp);
  updateDiff();
  render();
}

// 진행 중인 작업(rebase/merge/cherry-pick/revert)의 Continue/Abort/Skip 메뉴를 띄운다.
// 키보드 'b' 단축키용. (상단 title 행의 Abort/Skip 버튼은 개별 클릭으로 직접 처리)
function openOperationMenu() {
  if (!state.operationState) return;
  const op = state.operationState;
  const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
  const typeLabel = isRebase ? 'Rebase' : op.type === 'merge' ? 'Merge' : op.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
  const buttons = [
    { id: 'continue', label: 'Continue', default: true },
    { id: 'abort', label: 'Abort' },
  ];
  if (op.type !== 'merge') buttons.push({ id: 'skip', label: 'Skip' });
  buttons.push({ id: 'cancel', label: 'Cancel' });
  hecaton.dialog.show({
    type: 'message',
    title: typeLabel,
    message: 'Choose action:',
    buttons,
  });
  state.pendingRebaseMenu = true;
}

async function handleKey(key) {
  // Fresh time window mode intercept
  if (state.freshTimeWindowMode) {
    if (key === CSI + 'D' || key === 'h') { // Left
      state.freshTimeWindow = Math.max(0, state.freshTimeWindow - 1);
      render();
    } else if (key === CSI + 'C' || key === 'l') { // Right
      state.freshTimeWindow = Math.min(FRESH_TIME_WINDOWS.length - 1, state.freshTimeWindow + 1);
      render();
    } else if (key === '\r' || key === '\n') { // Enter
      state.freshTimeWindowMode = false;
      refreshFresh();
      state.diffScrollOffset = 0;
      updateFreshDetail();
      render();
    } else if (key === ESC || key === '\x1b') { // Esc
      state.freshTimeWindowMode = false;
      render();
    }
    return;
  }
  if (state.mode === 'commit') {
    handleCommitInput(key);
    return;
  }

  // 저장소 밖에서 연 첫 화면의 설정 단축키. 일반 저장소에서는 기존 키 의미를 유지한다.
  if (!state.loading && !state.isGitRepo) {
    const setupAction = key === 'i' || key === 'I' ? 'tab_init'
      : key === 'o' || key === 'O' ? 'tab_change_repo'
      : key === 'c' || key === 'C' ? 'tab_clone'
      : null;
    if (setupAction) {
      await handleContextMenuAction(setupAction);
      return;
    }
  }

  // Ctrl+Shift+P / Cmd+Shift+P: push
  if (key === CSI + '112;6u' || key === CSI + '112;10u') {
    requestPush();
    return;
  }

  // Arrow keys (VT sequences)
  if (key === CSI + 'A' || key === 'k') { // Up
    if (state.rightView === 'diff' && state.focusPanel === 'diff' && state.conflictView) {
      if (moveConflictChunkCursor(-1)) render();
      return;
    }
    if (state.focusPanel === 'status') {
      if (state.rightView === 'fresh') {
        if (state.freshItems.length > 0) {
          state.freshCursor = Math.max(0, state.freshCursor - 1);
          state.diffScrollOffset = 0;
          updateFreshDetail();
        }
      } else if (state.rightView === 'log') {
        if (state.logSelectables.length > 0) {
          state.logCursor = Math.max(0, state.logCursor - 1);
          state.diffScrollOffset = 0;
          updateLogDetail();
        }
      } else {
        const list = buildFileList();
        if (list.length > 0) {
          state.cursor = Math.max(0, state.cursor - 1);
          updateDiff();
        }
      }
    } else {
      state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 1);
    }
    render();
    return;
  }
  if (key === CSI + 'B' || key === 'j') { // Down
    if (state.rightView === 'diff' && state.focusPanel === 'diff' && state.conflictView) {
      if (moveConflictChunkCursor(1)) render();
      return;
    }
    if (state.focusPanel === 'status') {
      if (state.rightView === 'fresh') {
        if (state.freshItems.length > 0) {
          state.freshCursor = Math.min(state.freshItems.length - 1, state.freshCursor + 1);
          state.diffScrollOffset = 0;
          updateFreshDetail();
        }
      } else if (state.rightView === 'log') {
        if (state.logSelectables.length > 0) {
          state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 1);
          state.diffScrollOffset = 0;
          updateLogDetail();
          maybeLoadMoreLog();
        }
      } else {
        const list = buildFileList();
        if (list.length > 0) {
          state.cursor = Math.min(list.length - 1, state.cursor + 1);
          updateDiff();
        }
      }
    } else {
      state.diffScrollOffset++;
    }
    render();
    return;
  }

  // Left/Right: horizontal scroll
  if (key === CSI + 'C') { // Right
    if (state.focusPanel === 'diff') {
      const maxX = state.rightView === 'log' ? (ui.logDetailMaxScrollX || 0)
        : state.rightView === 'fresh' ? (ui.freshDetailMaxScrollX || 0)
        : (ui.diffMaxScrollX || 0);
      state.diffScrollX = Math.min(maxX, state.diffScrollX + 2);
    } else {
      state.filesScrollX = Math.min((ui.filesMaxScrollX || 0), state.filesScrollX + 2);
    }
    render();
    return;
  }
  if (key === CSI + 'D') { // Left
    if (state.focusPanel === 'diff') {
      state.diffScrollX = Math.max(0, state.diffScrollX - 2);
    } else {
      state.filesScrollX = Math.max(0, state.filesScrollX - 2);
    }
    render();
    return;
  }

  // Ctrl+A / Cmd+A: select all / deselect all in cursor's group (diff view only)
  if ((key === '\x01' || key === CSI + '97;9u') && state.rightView !== 'log' && state.rightView !== 'fresh') {
    const list = buildFileList();
    if (list.length > 0) {
      const [groupStart, groupEnd] = sectionRangeAt(list, Math.min(state.cursor, list.length - 1));
      const groupSize = groupEnd - groupStart;
      // Check if all in this group are already selected
      let allSelected = groupSize > 0;
      for (let i = groupStart; i < groupEnd; i++) {
        if (!state.selectedFiles.has(i)) { allSelected = false; break; }
      }
      state.selectedFiles.clear();
      if (!allSelected) {
        for (let i = groupStart; i < groupEnd; i++) state.selectedFiles.add(i);
      }
    }
    render();
    return;
  }

  switch (key) {
    case 'v':
    case 'V': {
      if (state.rightView !== 'diff') break;
      const sel = selectedItem();
      if (!sel || (sel.type !== 'staged' && sel.type !== 'unstaged')) break;
      state.diffView = state.diffView === 'side' ? 'unified' : 'side';
      state.diffScrollOffset = 0;
      state.diffScrollX = 0;
      render();
      break;
    }
    case 's': {
      if (state.rightView === 'log') break;
      requestStageSelection(true);
      break;
    }
    case 'u': {
      if (state.rightView === 'log') break;
      requestStageSelection(false);
      break;
    }
    case 'c': {
      if (!guardAction('commit-enter')) break;
      enterCommitMode();
      break;
    }
    case 'A': {
      if (!guardAction('commit-amend')) break;
      enterAmendCommitMode();
      break;
    }
    case 'l':
    case 'L': {
      if (state.rightView === 'diff') {
        state.rightView = 'log';
        refreshLog();
        state.logCursor = 0;
        state.logScrollOffset = 0;
        state.diffScrollOffset = 0;
        updateLogDetail();
      } else if (state.rightView === 'log') {
        state.rightView = 'fresh';
        refreshFresh();
        state.freshCursor = 0;
        state.freshScrollOffset = 0;
        state.diffScrollOffset = 0;
        updateFreshDetail();

      } else {
        state.rightView = 'diff';
        refreshInBackground({ statusOnly: true });
        updateDiff();

      }
      state.focusPanel = 'status';
      render();
      break;
    }
    case '1':
    case '2':
    case '3': {
      if (state.rightView !== 'diff' || !state.conflictView) break;
      const sel = selectedItem();
      if (!sel || sel.status !== 'U') break;
      if (key === '1') setConflictSelection(ui.mergeChunkCursor, 'ours');
      if (key === '2') setConflictSelection(ui.mergeChunkCursor, 'theirs');
      if (key === '3') setConflictSelection(ui.mergeChunkCursor, 'both');
      ensureConflictCursorVisible();
      render();
      break;
    }
    case 'm': {
      if (state.rightView !== 'diff' || !state.conflictView) break;
      await applyConflictSelections();
      break;
    }
    case 'b': {
      // 진행 중인 작업이 있으면 Continue/Abort/Skip 메뉴, 없으면 고른 커밋으로 rebase.
      // 둘은 전제가 다르므로 서로 다른 id 로 판정한다.
      if (state.operationState) {
        if (!guardAction('op-menu')) break;
        openOperationMenu();
      } else {
        if (!guardAction('rebase')) break;
        const logItem = selectedLogRef();
        if (!logItem || !logItem.ref) {
          showErrorDialog('Select a commit in log view to rebase onto');
          render();
          break;
        }
        if (state.staged.length > 0 || state.unstaged.length > 0) {
          state.pendingRebaseRef = logItem.ref;
          hecaton.dialog.show({
            type: 'message',
            title: 'Rebase',
            message: 'You have uncommitted local changes.\nWould you like to stash them, rebase, and then reapply?',
            buttons: [
              { id: 'stash_rebase', label: 'Stash & Rebase', default: true },
              { id: 'cancel', label: 'Cancel' },
            ],
          });
        } else {
          // Pre-check for conflicts before rebasing
          const logRebaseOp = startSpinner('Checking rebase...', CHECKOUT_SCOPES);
          const conflictCheck = await gitCheckRebaseConflicts(state.cwd, logItem.ref);
          if (conflictCheck.willConflict) {
            stopSpinner(logRebaseOp);
            const fileList = conflictCheck.files.length > 0
              ? '\n\nConflicting files:\n' + conflictCheck.files.slice(0, 10).join('\n')
              : '';
            state.pendingRebaseRef = logItem.ref;
            hecaton.dialog.show({
              type: 'message',
              title: 'Rebase',
              message: '\u26A0 Rebase will cause conflicts.' + fileList + '\n\nDo you want to continue?',
              buttons: [
                { id: 'rebase_proceed', label: 'Rebase', default: true },
                { id: 'cancel', label: 'Cancel' },
              ],
            });
            render();
            break;
          }
          updateSpinner('Rebasing...', logRebaseOp);
          gitRebaseAsync(state.cwd, logItem.ref).then(async err => {
            await refreshAsync();
            stopSpinner(logRebaseOp);
            if (state.rightView === 'log') refreshLog();
            if (err && isStaleRebaseError(err)) {
              state.pendingRebaseRef = logItem.ref;
              hecaton.dialog.show({
                type: 'message',
                title: 'Rebase',
                message: 'A stale rebase state was found.\nAbort the previous rebase and retry?',
                buttons: [
                  { id: 'abort_retry_rebase', label: 'Abort & Retry', default: true },
                  { id: 'cancel', label: 'Cancel' },
                ],
              });
            } else if (err && isRebaseConflictError(err)) {
              switchToDiffViewForConflict();
              render();
            } else if (err) {
              showErrorDialog(err);
              render();
            } else {
              render();
            }
          });
        }
      }
      break;
    }
    case 'w': {
      if (state.rightView === 'fresh') {
        state.freshTimeWindowMode = true;
        render();
      }
      break;
    }
    case 'r':
    case 'R': {
      refreshAsync().then(() => {
        // 사용자가 직접 누른 새로고침은 캐시를 건너뛴다 — 화면이 이상해 보여서 눌렀을 때
        // 지문이 같다는 이유로 아무것도 다시 읽지 않으면 손쓸 방법이 없어진다.
        if (state.rightView === 'log') refreshLog({ force: true });
        if (state.rightView === 'fresh') {
          refreshFresh();
          updateFreshDetail();
        }
        render();
      });
      break;
    }
    case '\t': { // Tab
      state.focusPanel = state.focusPanel === 'status' ? 'diff' : 'status';
      render();
      break;
    }
    case 't':
    case 'T': {
      if (state.rightView !== 'diff') break;
      setFileTreeView(!ui.fileTreeView);
      render();
      break;
    }
    case '\r':
    case '\n': {
      // 폴더 줄에서만 뜻이 있다. 파일 줄의 Enter 는 예전처럼 아무것도 하지 않는다 —
      // 커서가 파일에 있을 때 무언가 실행되면 목록을 훑다가 사고가 난다.
      if (state.rightView !== 'diff' || state.focusPanel !== 'status') break;
      const dirSel = selectedItem();
      if (!dirSel || dirSel.kind !== 'dir') break;
      toggleFileDir(dirSel, state.cursor);
      render();
      break;
    }
    case 'q':
    case 'Q': {
      cleanup();
      hecaton.window.close().catch(() => null);
      break;
    }
  }
}

function prevCharIndex(str, idx) {
  if (idx <= 0) return 0;
  if (idx >= 2) {
    const lo = str.charCodeAt(idx - 1);
    const hi = str.charCodeAt(idx - 2);
    if (lo >= 0xDC00 && lo <= 0xDFFF && hi >= 0xD800 && hi <= 0xDBFF) return idx - 2;
  }
  return idx - 1;
}

function nextCharIndex(str, idx) {
  if (idx >= str.length) return str.length;
  const hi = str.charCodeAt(idx);
  if (hi >= 0xD800 && hi <= 0xDBFF && idx + 1 < str.length) return idx + 2;
  return idx + 1;
}

function handleCommitInput(key) {
  // Ctrl+V / Cmd+V — Paste from clipboard
  if (key === '\x16' || key === CSI + '118;9u') {
    (async () => {
      const result = await hecaton.clipboard.read().catch(() => null);
      if (result && result.text) {
        const clean = result.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + clean + state.commitMsg.substring(state.commitCursor);
        state.commitCursor += clean.length;
        render();
      }
    })();
    return;
  }
  // IME 입력과 이스케이프 시퀀스가 하나의 청크로 합쳐진 경우 분리 처리
  // (예: "최적화\x1b[13;5u" → "최적화" + "\x1b[13;5u")
  const escIdx = key.indexOf('\x1b');
  if (escIdx > 0) {
    handleCommitInput(key.substring(0, escIdx));
    if (state.mode === 'commit') {
      handleCommitInput(key.substring(escIdx));
    }
    return;
  }
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    state.commitMsg = '';
    state.commitCursor = 0;
    state.commitAmend = false;
    render();
    return;
  }
  // Ctrl+A / Cmd+A → toggle amend
  if (key === '\x01' || key === CSI + '97;9u') {
    if (!guardAction('commit-amend')) return;
    toggleCommitAmend();
    return;
  }
  // Ctrl+Enter (13;5u) / Cmd+Enter (13;9u, macOS) → submit commit or continue rebase
  if (key === CSI + '13;5u' || key === CSI + '13;9u') {
    // 제출 조건은 [Commit] 버튼의 딤 처리와 같은 판정을 쓴다 — 초록으로 보이는데
    // 제출이 거부되거나, 흐린데 눌리는 어긋남이 생기지 않는다. 막혀도 모드와 메시지는
    // 그대로 남아 조건이 갖춰지면 다시 제출할 수 있다.
    if (!guardAction('commit-submit')) return;
    const isAmendCommit = state.commitAmend && !state.operationState;
    const isRebaseOp = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    state.mode = 'normal';
    if (isRebaseOp) {
      // Fork-style: write message to rebase message file, then rebase --continue
      const contOp = startSpinner('Rebase continue...', CHECKOUT_SCOPES);
      (async () => {
        try {
          const writeErr = await gitWriteRebaseMessage(state.cwd, state.commitMsg, state.operationState.type);
          if (writeErr) {
            stopSpinner(contOp);
            showErrorDialog('Failed to write rebase message:\n' + writeErr);
            render();
            return;
          }
          const err = await gitRebaseContinueAsync(state.cwd);
          if (!err) {
            state.commitMsg = '';
            state.commitCursor = 0;
          }
          await refreshAsync();
          if (state.rightView === 'log') refreshLog();
          stopSpinner(contOp);
          if (err && isRebaseConflictError(err)) {
            switchToDiffViewForConflict();
            render();
          } else if (err) {
            showErrorDialog(err);
          } else {
            render();
          }
        } catch (e) {
          stopSpinner(contOp);
          showErrorDialog(e.message || 'Rebase continue failed');
          render();
        }
      })();
    } else {
      const commitOp = startSpinner(isAmendCommit ? 'Amending...' : 'Committing...', COMMIT_SCOPES);
      const commitPromise = isAmendCommit
        ? gitCommitAmendAsync(state.cwd, state.commitMsg)
        : gitCommitAsync(state.cwd, state.commitMsg);
      commitPromise.then(async err => {
        if (err) {
          stopSpinner(commitOp);
          showErrorDialog(err);
          render();
          return;
        }
        state.commitMsg = '';
        state.commitCursor = 0;
        state.commitAmend = false;
        // settle: 커밋은 끝났지만 목록은 아직 커밋 직전 상태다. 이 갱신이 끝날 때까지
        // 새 쓰기를 받으면 이미 커밋된 파일을 상대로 Unstage 를 쏘게 된다.
        refreshInBackground({}, {
          refreshLog: true, refreshFresh: true,
          message: isAmendCommit ? 'Amending...' : 'Committing...',
          settle: true, scopes: commitOp.scopes,
        });
        stopSpinner(commitOp);
      });
    }
    return;
  }
  // Enter → insert newline
  if (key === '\r' || key === '\n') {
    state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + '\n' + state.commitMsg.substring(state.commitCursor);
    state.commitCursor += 1;
    render();
    return;
  }
  // Up arrow → move to previous line
  if (key === CSI + 'A') {
    const before = state.commitMsg.substring(0, state.commitCursor);
    const lastNL = before.lastIndexOf('\n');
    if (lastNL === -1) { render(); return; }
    const col = state.commitCursor - lastNL - 1;
    const prevLineStart = before.lastIndexOf('\n', lastNL - 1) + 1;
    const prevLineLen = lastNL - prevLineStart;
    state.commitCursor = prevLineStart + Math.min(col, prevLineLen);
    render();
    return;
  }
  // Down arrow → move to next line
  if (key === CSI + 'B') {
    const after = state.commitMsg.substring(state.commitCursor);
    const nextNL = after.indexOf('\n');
    if (nextNL === -1) { render(); return; }
    const lineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
    const col = state.commitCursor - lineStart;
    const nextLineStart = state.commitCursor + nextNL + 1;
    const nextNL2 = state.commitMsg.indexOf('\n', nextLineStart);
    const nextLineLen = nextNL2 === -1 ? state.commitMsg.length - nextLineStart : nextNL2 - nextLineStart;
    state.commitCursor = nextLineStart + Math.min(col, nextLineLen);
    render();
    return;
  }
  // Left arrow
  if (key === CSI + 'D') {
    if (state.commitCursor > 0) {
      state.commitCursor = prevCharIndex(state.commitMsg, state.commitCursor);
    }
    render();
    return;
  }
  // Right arrow
  if (key === CSI + 'C') {
    if (state.commitCursor < state.commitMsg.length) {
      state.commitCursor = nextCharIndex(state.commitMsg, state.commitCursor);
    }
    render();
    return;
  }
  // Home → start of current line
  if (key === CSI + 'H' || key === CSI + '1~') {
    const lineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
    state.commitCursor = lineStart;
    render();
    return;
  }
  // End → end of current line
  if (key === CSI + 'F' || key === CSI + '4~') {
    const nextNL = state.commitMsg.indexOf('\n', state.commitCursor);
    state.commitCursor = nextNL === -1 ? state.commitMsg.length : nextNL;
    render();
    return;
  }
  // Backspace – delete character before cursor
  if (key === '\x7f' || key === '\b') {
    if (state.commitCursor > 0) {
      const prev = prevCharIndex(state.commitMsg, state.commitCursor);
      state.commitMsg = state.commitMsg.substring(0, prev) + state.commitMsg.substring(state.commitCursor);
      state.commitCursor = prev;
    }
    render();
    return;
  }
  // Delete key – delete character after cursor
  if (key === CSI + '3~') {
    if (state.commitCursor < state.commitMsg.length) {
      const next = nextCharIndex(state.commitMsg, state.commitCursor);
      state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + state.commitMsg.substring(next);
    }
    render();
    return;
  }
  // Regular character
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + key + state.commitMsg.substring(state.commitCursor);
    state.commitCursor += key.length;
    render();
    return;
  }
  // Multi-byte character (IME input / paste)
  if (key.length > 1 && !key.startsWith('\x1b')) {
    const clean = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (clean.length === 0) return;
    state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + clean + state.commitMsg.substring(state.commitCursor);
    state.commitCursor += clean.length;
    render();
    return;
  }
}

function handleRebaseMenuInput(key) {
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    render();
    return;
  }
  if (key === 'c') {
    state.mode = 'normal';
    const menuContOp = startSpinner('Rebase continue...', CHECKOUT_SCOPES);
    gitRebaseContinueAsync(state.cwd).then(async err => {
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      stopSpinner(menuContOp);
      if (err) showErrorDialog(err);
      render();
    });
    return;
  }
  if (key === 'a') {
    state.mode = 'normal';
    const menuAbortOp = startSpinner('Aborting rebase...', CHECKOUT_SCOPES);
    gitRebaseAbortAsync(state.cwd).then(async err => {
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      stopSpinner(menuAbortOp);
      if (err) showErrorDialog(err);
      render();
    });
    return;
  }
  if (key === 's') {
    state.mode = 'normal';
    const menuSkipOp = startSpinner('Rebase skip...', CHECKOUT_SCOPES);
    gitRebaseSkipAsync(state.cwd).then(async err => {
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      stopSpinner(menuSkipOp);
      if (err) showErrorDialog(err);
      render();
    });
    return;
  }
}

async function handleNameInput(key) {
  // Ctrl+V / Cmd+V — Paste from clipboard
  if (key === '\x16' || key === CSI + '118;9u') {
    (async () => {
      const result = await hecaton.clipboard.read().catch(() => null);
      if (result && result.text) {
        state.inputBuffer += result.text.replace(/[\r\n]/g, '');
        render();
      }
    })();
    return;
  }
  // IME 입력과 이스케이프 시퀀스가 하나의 청크로 합쳐진 경우 분리 처리
  const escIdx = key.indexOf('\x1b');
  if (escIdx > 0) {
    handleNameInput(key.substring(0, escIdx));
    if (state.mode === 'new-branch' || state.mode === 'new-tag' || state.mode === 'rename-stash' || state.mode === 'new-remote' || state.mode === 'new-remote-url') {
      handleNameInput(key.substring(escIdx));
    }
    return;
  }
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    state.inputBuffer = '';
    state.inputTarget = '';
    render();
    return;
  }
  if (key === '\r' || key === '\n') {
    const name = state.inputBuffer.trim();
    if (name.length === 0) {
      showErrorDialog('Name cannot be empty');
      render();
      return;
    }
    // 브랜치 생성은 로컬 변경에 막힐 수 있어 stash 재시도 제안까지 공통 경로에서 처리한다.
    if (state.mode === 'new-branch') {
      const startPoint = state.inputTarget;
      state.mode = 'normal';
      state.inputBuffer = '';
      state.inputTarget = '';
      const branchOp = startSpinner('Branch...', CHECKOUT_SCOPES);
      await runCreateBranch(name, startPoint, 'Branch', branchOp);
      return;
    }
    let err;
    if (state.mode === 'rename-stash') {
      err = await gitStashRename(state.cwd, state.inputTarget, name);
    } else if (state.mode === 'new-remote') {
      state.mode = 'new-remote-url';
      state.inputTarget = name;
      state.inputBuffer = '';
      render();
      return;
    } else if (state.mode === 'new-remote-url') {
      err = await gitRemoteAdd(state.cwd, state.inputTarget, name);
    } else {
      err = await gitCreateTag(state.cwd, name, state.inputTarget);
    }
    const opName = state.mode === 'rename-stash'
      ? 'Rename stash'
      : state.mode === 'new-remote-url'
        ? 'Remote'
        : 'Tag';
    state.mode = 'normal';
    state.inputBuffer = '';
    state.inputTarget = '';
    if (err) {
      showErrorDialog(opName + ' failed:\n' + err);
      render();
    } else {
      refreshAsync().then(() => {
        if (state.rightView === 'log') refreshLog();
        render();
      });
    }
    return;
  }
  if (key === '\x7f' || key === '\b' || key === CSI + '3~') {
    state.inputBuffer = state.inputBuffer.slice(0, -1);
    render();
    return;
  }
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.inputBuffer += key;
    render();
    return;
  }
  if (key.length > 1 && !key.startsWith('\x1b')) {
    state.inputBuffer += key;
    render();
    return;
  }
}

function applyScrollbarOffset(target, offset) {
  hostScroll.applyOffset(target, offset);
  if (target === 'logList') maybeLoadMoreLog();
}

async function handleMouseData(data) {
  const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let mouseMatch;
  let hadMouse = false;
  while ((mouseMatch = mouseRegex.exec(data)) !== null) {
    hadMouse = true;
    const cb = parseInt(mouseMatch[1], 10);
    const cx = parseInt(mouseMatch[2], 10);
    const cy = parseInt(mouseMatch[3], 10);
    const isRelease = mouseMatch[4] === 'm';

    const L = ui.lastLayout;
    const titleH = (L.titleRows || 2) + 1; // title rows + separator
    const bodyTop = L.startRow + titleH;
    const midStart = L.startCol + L.leftW + L.divider1W;
    const rightStart = midStart + L.middleW + L.divider2W;
    const div1Col = L.startCol + L.leftW;
    const div2Col = midStart + L.middleW;

    // Motion events (cb bit 5 set) -> drag resize / hover
    if ((cb & 32) !== 0) {
      if (ui.dragging === 'vertical') {
        ui.verticalDividerRatio = Math.max(1 / L.width, Math.min(0.5, (cx - L.startCol) / L.width));
        render();
        continue;
      }
      if (ui.dragging === 'vertical2') {
        const remaining = L.width - L.leftW - L.divider1W;
        const relX = cx - midStart;
        ui.filesDividerRatio = Math.max(0.15, Math.min(0.7, relX / remaining));
        render();
        continue;
      }
      if (ui.dragging === 'horizontal') {
        const contentH = Math.max(1, L.bodyH - 2);
        const relY = cy - bodyTop;
        ui.logListRatio = Math.max(0.1, Math.min(0.9, relY / contentH));
        render();
        continue;
      }
      if (ui.dragging === 'scrollbar') {
        const info = ui.scrollbarDragInfo;
        const relY = cy - info.trackTop;
        const ratio = Math.max(0, Math.min(1, relY / Math.max(1, info.trackH - 1)));
        applyScrollbarOffset(info.target, Math.round(ratio * info.maxScroll));
        render();
        continue;
      }
      if (ui.dragging === 'hscrollbar') {
        const info = ui.hScrollbarDragInfo;
        const relX = cx - info.colStart;
        const ratio = Math.max(0, Math.min(1, relX / Math.max(1, info.trackCols - 1)));
        const newScrollX = Math.round(ratio * info.maxScrollX);
        if (info.target === 'diff') {
          state.diffScrollX = newScrollX;
        } else if (info.target === 'files') {
          state.filesScrollX = newScrollX;
        } else {
          // logDetail, freshDetail share diffScrollX
          state.diffScrollX = newScrollX;
        }
        render();
        continue;
      }

      let newHover = -1;
      for (let i = 0; i < ui.clickableAreas.length; i++) {
        const area = ui.clickableAreas[i];
        if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
          newHover = i;
          break;
        }
      }
      let newCommitterHover = null;
      for (const zone of ui.committerClickZones) {
        if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
          newCommitterHover = zone.action;
          break;
        }
      }
      let newRepoSetupHover = null;
      for (const zone of ui.repoSetupClickZones) {
        if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
          newRepoSetupHover = zone.action;
          break;
        }
      }
      let newTitleHover = -1;
      if (cy >= L.startRow && cy < bodyTop) {
        for (let i = 0; i < ui.titleClickZones.length; i++) {
          const zone = ui.titleClickZones[i];
          if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
            newTitleHover = i;
            break;
          }
        }
      }
      let newDivHover = null;
      const inBody = cy >= bodyTop && cy < bodyTop + L.bodyH;
      if (!ui.leftPanelCollapsed && inBody) {
        if (cx === div1Col) {
          newDivHover = 'vertical';
        }
      }
      if (L.middleW > 0 && inBody && cx === div2Col) {
        newDivHover = 'vertical2';
      }
      if ((state.rightView === 'log' || state.rightView === 'fresh') && inBody) {
        const hListH = state.rightView === 'fresh' ? ui.lastFreshListH : ui.lastLogListH;
        if (hListH > 0) {
          const hDivRow = bodyTop + hListH;
          if (cy === hDivRow && cx >= rightStart) {
            newDivHover = 'horizontal';
          }
        }
      }
      // Hover: file header buttons ([Stage] / [Unstage])
      let newFileHeaderHover = -1;
      if (state.rightView !== 'log' && state.rightView !== 'fresh' && inBody) {
        const bodyRowIdx = cy - (bodyTop);
        for (let i = 0; i < ui.fileHeaderZones.length; i++) {
          const zone = ui.fileHeaderZones[i];
          const visibleLineIdx = zone.lineIdx - state.scrollOffset;
          if (visibleLineIdx === bodyRowIdx) {
            const btnScreenColStart = midStart + zone.btnColStart;
            const btnScreenColEnd = midStart + zone.btnColEnd;
            if (cx >= btnScreenColStart && cx <= btnScreenColEnd) {
              newFileHeaderHover = i;
              break;
            }
          }
        }
      }

      // Hover: left panel clickable rows
      let newLeftPanelHover = -1;
      if (!ui.leftPanelCollapsed && inBody) {
        const inLeft = cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.leftPanelClickMap.length && ui.leftPanelClickMap[bodyRowIdx]) {
            newLeftPanelHover = bodyRowIdx;
          }
        }
      }

      // Hover: file list (middle panel)
      let newFileRowHover = -1;
      if (state.rightView !== 'log' && state.rightView !== 'fresh' && L.middleW > 0 && inBody) {
        const inMiddle = cx >= midStart && cx < midStart + L.middleW;
        if (inMiddle) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
            newFileRowHover = bodyRowIdx;
          }
        }
      }

      // Hover: log list (right panel)
      let newLogRowHover = -1;
      if (state.rightView === 'log' && inBody) {
        const inRight = cx >= rightStart && cx < L.startCol + L.width;
        if (inRight) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.lastLogListH) {
            newLogRowHover = bodyRowIdx;
          }
        }
      }

      // Hover: fresh list (right panel)
      let newFreshRowHover = -1;
      if (state.rightView === 'fresh' && inBody) {
        const inRight = cx >= rightStart && cx < L.startCol + L.width;
        if (inRight) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.freshFileLineMap.length && ui.freshFileLineMap[bodyRowIdx] >= 0) {
            newFreshRowHover = bodyRowIdx;
          }
        }
      }

      // Context menu: stash items in left panel
      // Hover: fresh window button
      let newFreshWindowHover = false;
      if (state.rightView === 'fresh' && inBody && ui.freshWindowZone) {
        const bodyRowIdx = cy - bodyTop;
        if (bodyRowIdx === ui.freshWindowZone.lineIdx) {
          const relCol = cx - rightStart;
          if (relCol >= ui.freshWindowZone.colStart && relCol <= ui.freshWindowZone.colEnd) {
            newFreshWindowHover = true;
          }
        }
      }

      // Hover: scrollbar
      let newScrollbarHover = null;
      for (const sb of ui.scrollbarOverlays) {
        if (cx === sb.screenCol && cy >= sb.screenRow && cy < sb.screenRow + sb.viewportRows) {
          newScrollbarHover = sb.target;
          break;
        }
      }

      // Hover: horizontal scrollbar
      let newHScrollbarHover = null;
      for (const hsb of ui.hScrollbarZones) {
        if (cy === hsb.screenRow && cx >= hsb.colStart && cx <= hsb.colEnd) {
          newHScrollbarHover = hsb.target;
          break;
        }
      }

      // Hover: detail copy zones (log detail metadata)
      let newDetailCopyZone = null;
      if (state.rightView === 'log' && inBody && ui.detailCopyZones && ui.detailCopyZones.length > 0) {
        const inRight = cx >= rightStart && cx < L.startCol + L.width;
        if (inRight) {
          const bodyRowIdx = cy - bodyTop;
          const relCol = cx - rightStart;
          for (const zone of ui.detailCopyZones) {
            if (bodyRowIdx === zone.lineIdx && relCol >= zone.colStart && relCol <= zone.colEnd) {
              newDetailCopyZone = zone;
              break;
            }
          }
        }
      }
      // Hover: detail Collapse All button
      let newCollapseAllHover = false;
      if (state.rightView === 'log' && inBody && ui.detailCollapseAllZone) {
        const bodyRowIdx = cy - bodyTop;
        if (bodyRowIdx === ui.detailCollapseAllZone.lineIdx) {
          const relCol = cx - rightStart;
          if (relCol >= ui.detailCollapseAllZone.colStart && relCol <= ui.detailCollapseAllZone.colEnd) {
            newCollapseAllHover = true;
          }
        }
      }

      // Hover: commit button
      let newCommitButtonHover = false;
      if (ui.commitButtonZone && state.rightView !== 'log' && state.rightView !== 'fresh') {
        if (cy === ui.commitButtonZone.row && cx >= ui.commitButtonZone.colStart && cx <= ui.commitButtonZone.colEnd) {
          newCommitButtonHover = true;
        }
      }

      let newMergeApplyHover = false;
      if (ui.mergeApplyZone && state.rightView === 'diff') {
        if (cy === ui.mergeApplyZone.row && cx >= ui.mergeApplyZone.colStart && cx <= ui.mergeApplyZone.colEnd) {
          newMergeApplyHover = true;
        }
      }

      let newMergeZoneHover = -1;
      if (ui.mergeClickZones && ui.mergeClickZones.length > 0 && state.rightView === 'diff' && inBody) {
        const rpStartCol = L.startCol + L.leftW + L.divider1W + L.middleW + L.divider2W;
        for (let i = 0; i < ui.mergeClickZones.length; i++) {
          const zone = ui.mergeClickZones[i];
          const zoneRow = bodyTop + zone.lineIdx;
          const zoneColStart = rpStartCol + zone.colStart;
          const zoneColEnd = rpStartCol + zone.colEnd;
          if (cy === zoneRow && cx >= zoneColStart && cx <= zoneColEnd) {
            newMergeZoneHover = i;
            break;
          }
        }
      }

      // Hover: diff hunk stage/unstage buttons
      let newDiffHunkHover = -1;
      if (ui.diffHunkZones && ui.diffHunkZones.length > 0 && state.rightView === 'diff' && inBody) {
        const rpStartCol = L.startCol + L.leftW + L.divider1W + L.middleW + L.divider2W;
        for (const zone of ui.diffHunkZones) {
          if (cy === bodyTop + zone.lineIdx && cx >= rpStartCol + zone.colStart && cx <= rpStartCol + zone.colEnd) {
            newDiffHunkHover = zone.hunkIdx;
            break;
          }
        }
      }

      // Hover: amend 토글 (Commit 버튼 오른쪽, 커밋/일반 모드 모두)
      let newCommitAmendHover = false;
      if (ui.commitAmendZone && cy === ui.commitAmendZone.row && cx >= ui.commitAmendZone.colStart && cx <= ui.commitAmendZone.colEnd) {
        newCommitAmendHover = true;
      }

      // Hover: 메시지 지우기 버튼 (커밋 메시지 첫 줄 오른쪽)
      let newCommitClearHover = false;
      if (ui.commitClearZone && cy === ui.commitClearZone.row && cx >= ui.commitClearZone.colStart && cx <= ui.commitClearZone.colEnd) {
        newCommitClearHover = true;
      }

      // 마우스가 올라간 버튼의 동작 id. 막혀 있으면 힌트바에 사유를 띄우고 커서를
      // 금지 모양으로 바꾼다 — 흐린 색만으로는 "지금은 안 된다"는 알아도 "왜"는 모른다.
      // 사유 문자열이 아니라 id 를 들고 있어야, 상황이 바뀌면 렌더가 알아서 다시 판정한다.
      let newHoveredAction = null;
      if (newRepoSetupHover) {
        newHoveredAction = newRepoSetupHover;
      } else if (newTitleHover >= 0 && ui.titleClickZones[newTitleHover]) {
        newHoveredAction = ui.titleClickZones[newTitleHover].action;
      } else if (newFileHeaderHover >= 0 && ui.fileHeaderZones[newFileHeaderHover]) {
        newHoveredAction = ui.fileHeaderZones[newFileHeaderHover].action;
      } else if (newCommitButtonHover) {
        newHoveredAction = state.mode === 'commit' ? 'commit-submit' : 'commit-enter';
      } else if (newMergeApplyHover) {
        newHoveredAction = 'merge-apply';
      } else if (newDiffHunkHover >= 0) {
        newHoveredAction = 'hunk-apply';
      } else if (newCommitAmendHover) {
        newHoveredAction = 'commit-amend';
      } else if (newCommitterHover) {
        newHoveredAction = newCommitterHover;
      }
      const newDisabledReason = newHoveredAction ? disabledReason(newHoveredAction) : null;

      if (newHoveredAction !== ui.hoveredAction
        || newHover !== ui.hoveredAreaIndex || newCommitterHover !== ui.hoveredCommitterAction || newRepoSetupHover !== ui.hoveredRepoSetupAction || newTitleHover !== ui.hoveredTitleZoneIndex || newDivHover !== ui.hoveredDivider || newFileHeaderHover !== ui.hoveredFileHeaderIdx || newLeftPanelHover !== ui.hoveredLeftPanelRow || newFileRowHover !== ui.hoveredFileRow || newLogRowHover !== ui.hoveredLogRow || newFreshRowHover !== ui.hoveredFreshRow || newFreshWindowHover !== ui.hoveredFreshWindow || newScrollbarHover !== ui.hoveredScrollbarTarget || newCommitButtonHover !== ui.hoveredCommitButton || newHScrollbarHover !== ui.hoveredHScrollbarTarget || newMergeApplyHover !== ui.hoveredMergeApplyButton || newMergeZoneHover !== ui.hoveredMergeZoneIndex || newDetailCopyZone !== ui.hoveredDetailCopyZone || newCollapseAllHover !== ui.hoveredCollapseAllButton || newDiffHunkHover !== ui.hoveredDiffHunkIdx || newCommitAmendHover !== ui.hoveredCommitAmend || newCommitClearHover !== ui.hoveredCommitClear) {
        ui.hoveredAreaIndex = newHover;
        ui.hoveredCommitterAction = newCommitterHover;
        ui.hoveredRepoSetupAction = newRepoSetupHover;
        ui.hoveredTitleZoneIndex = newTitleHover;
        ui.hoveredDivider = newDivHover;
        ui.hoveredFileHeaderIdx = newFileHeaderHover;
        ui.hoveredLeftPanelRow = newLeftPanelHover;
        ui.hoveredFileRow = newFileRowHover;
        ui.hoveredLogRow = newLogRowHover;
        ui.hoveredFreshRow = newFreshRowHover;
        ui.hoveredFreshWindow = newFreshWindowHover;
        ui.hoveredScrollbarTarget = newScrollbarHover;
        ui.hoveredCommitButton = newCommitButtonHover;
        ui.hoveredHScrollbarTarget = newHScrollbarHover;
        ui.hoveredMergeApplyButton = newMergeApplyHover;
        ui.hoveredMergeZoneIndex = newMergeZoneHover;
        ui.hoveredDetailCopyZone = newDetailCopyZone;
        ui.hoveredCollapseAllButton = newCollapseAllHover;
        ui.hoveredDiffHunkIdx = newDiffHunkHover;
        ui.hoveredCommitAmend = newCommitAmendHover;
        ui.hoveredCommitClear = newCommitClearHover;
        ui.hoveredAction = newHoveredAction;
        // Update mouse cursor shape
        // 호버 시 밑줄이 그어지는 요소(= 클릭 가능한 버튼/메뉴)는 모두 손가락 커서로 맞춘다.
        // Status 패널의 브랜치명·섹션 헤더·브랜치/워크트리/스태시 줄(leftPanelClickMap)도 포함된다.
        // 지금 막혀 있는 버튼은 손가락 대신 금지 커서로 바꿔, 누르기 전에 알 수 있게 한다.
        if (!ui.dragging) {
          if (newDivHover === 'vertical' || newDivHover === 'vertical2') {
            setMouseShape('ew-resize');
          } else if (newDivHover === 'horizontal') {
            setMouseShape('ns-resize');
          } else if (newDisabledReason) {
            setMouseShape('not-allowed');
          } else if (newRepoSetupHover || newTitleHover >= 0 || newFileHeaderHover >= 0 || newLeftPanelHover >= 0 || newCommitButtonHover || newMergeApplyHover || newMergeZoneHover >= 0 || newFreshWindowHover || newHover >= 0 || newCommitterHover || newDetailCopyZone || newCollapseAllHover || newDiffHunkHover >= 0 || newCommitAmendHover || newCommitClearHover) {
            setMouseShape('pointer');
          } else {
            setMouseShape('default');
          }
        }
        render();
      }
      continue;
    }

    if (isRelease) {
      if (ui.dragging !== null) {
        ui.dragging = null;
        setMouseShape('default');
      }
      continue;
    }

    // Ctrl+Left click: toggle file selection (same group only)
    if (cb === 16) {
      const bodyRowIdx = cy - (bodyTop);
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      if (state.rightView !== 'log' && inMiddle && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
        const fileIdx = ui.fileLineMap[bodyRowIdx];
        const list = buildFileList();
        const clickedSection = list[fileIdx] && list[fileIdx].section;
        // Enforce same-group constraint
        if (state.selectedFiles.size > 0) {
          const firstSel = state.selectedFiles.values().next().value;
          const firstSection = list[firstSel] && list[firstSel].section;
          if (firstSection !== clickedSection) state.selectedFiles.clear();
        }
        if (state.selectedFiles.has(fileIdx)) {
          state.selectedFiles.delete(fileIdx);
        } else {
          state.selectedFiles.add(fileIdx);
        }
        state.focusPanel = 'status';
        render();
      }
      continue;
    }

    // Shift+Left click: range selection (same group only)
    if (cb === 4) {
      const bodyRowIdx = cy - (bodyTop);
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      if (state.rightView !== 'log' && inMiddle && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
        const fileIdx = ui.fileLineMap[bodyRowIdx];
        const [groupStart, groupEnd] = sectionRangeAt(buildFileList(), fileIdx);
        const anchor = Math.max(groupStart, Math.min(groupEnd - 1, state.cursor));
        const from = Math.max(groupStart, Math.min(anchor, fileIdx));
        const to = Math.min(groupEnd - 1, Math.max(anchor, fileIdx));
        state.selectedFiles.clear();
        for (let i = from; i <= to; i++) state.selectedFiles.add(i);
        state.focusPanel = 'status';
        render();
      }
      continue;
    }

    // Scroll wheel (native horizontal wheel or Shift+wheel = horizontal scroll)
    const isWheel = !isRelease && (cb & 64) !== 0;
    if (isWheel) {
      const wheelStep = (cb & 1) !== 0 ? 3 : -3;
      const wheelBtn = cb & 3; // 0/1: vertical up/down, 2/3: horizontal left/right
      const isHorizontalWheel = wheelBtn === 2 || wheelBtn === 3;
      const isShiftWheel = (cb & 4) !== 0;
      const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      const inRight = cx >= rightStart && cx < L.startCol + L.width;
      const inBody = cy >= bodyTop && cy < bodyTop + L.bodyH;
      if (isHorizontalWheel || isShiftWheel) {
        let changed = false;
        if (inBody && inMiddle) {
          const prev = state.filesScrollX;
          state.filesScrollX = Math.max(0, Math.min((ui.filesMaxScrollX || 0), state.filesScrollX + wheelStep));
          if (state.filesScrollX !== prev) changed = true;
          state.focusPanel = 'status';
        } else if (inBody && inRight) {
          const prev = state.diffScrollX;
          const maxX = state.rightView === 'log' ? (ui.logDetailMaxScrollX || 0)
            : state.rightView === 'fresh' ? (ui.freshDetailMaxScrollX || 0)
            : (ui.diffMaxScrollX || 0);
          state.diffScrollX = Math.max(0, Math.min(maxX, state.diffScrollX + wheelStep));
          if (state.diffScrollX !== prev) changed = true;
          state.focusPanel = 'diff';
        }
        if (changed) render();
        continue;
      }
      if (inBody && inLeft) {
        const prev = ui.leftPanelScrollOffset;
        ui.leftPanelScrollOffset = Math.max(0, Math.min(ui.leftMaxScroll || 0, ui.leftPanelScrollOffset + wheelStep));
        if (ui.leftPanelScrollOffset !== prev) render();
      } else if (inBody && inMiddle) {
        // Middle panel (diff mode only): file list viewport scroll
        const maxScroll = ui.filesMaxScroll || 0;
        if (maxScroll > 0) {
          const prev = state.scrollOffset;
          if (cb === 64) state.scrollOffset = Math.max(0, state.scrollOffset - 3);
          else state.scrollOffset = Math.min(maxScroll, state.scrollOffset + 3);
          if (state.scrollOffset !== prev) {
            ui.filesScrollPin = state.cursor;
            render();
          }
        }
      } else if (inRight && (inBody || state.rightView === 'diff')) {
        let changed = false;
        if (state.rightView === 'fresh') {
          // Fresh mode: top = file list scroll, bottom = detail scroll
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx < ui.lastFreshListH) {
            const maxScroll = ui.freshListMaxScroll || 0;
            if (maxScroll > 0) {
              const prev = state.freshScrollOffset;
              if (cb === 64) state.freshScrollOffset = Math.max(0, state.freshScrollOffset - 3);
              else state.freshScrollOffset = Math.min(maxScroll, state.freshScrollOffset + 3);
              if (state.freshScrollOffset !== prev) {
                ui.freshScrollPin = state.freshCursor;
                changed = true;
              }
            }
            state.focusPanel = 'status';
          } else {
            const prev = state.diffScrollOffset;
            const maxDiff = Math.max(0, state.freshDetailLines.length - Math.max(1, Math.floor((L.bodyH - 2) * (1 - ui.logListRatio)) - 1));
            state.diffScrollOffset = Math.max(0, Math.min(maxDiff, state.diffScrollOffset + wheelStep));
            if (state.diffScrollOffset !== prev) changed = true;
            state.focusPanel = 'diff';
          }
        } else if (state.rightView === 'log') {
          // Log mode: top = log scroll, bottom = detail scroll
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx < ui.lastLogListH) {
            const maxScroll = ui.logListMaxScroll || 0;
            if (maxScroll > 0) {
              const prev = state.logScrollOffset;
              if (cb === 64) state.logScrollOffset = Math.max(0, state.logScrollOffset - 3);
              else state.logScrollOffset = Math.min(maxScroll, state.logScrollOffset + 3);
              if (state.logScrollOffset !== prev) {
                ui.logScrollPin = state.logCursor;
                changed = true;
                maybeLoadMoreLog();
              }
            }
            if (cb !== 64) maybeLoadMoreLog();
            state.focusPanel = 'status';
          } else {
            const prev = state.diffScrollOffset;
            const maxDiff = Math.max(0, (ui.filteredDetailCount || state.logDetailLines.length) - (ui.lastDetailContentH || 1));
            state.diffScrollOffset = Math.max(0, Math.min(maxDiff, state.diffScrollOffset + wheelStep));
            if (state.diffScrollOffset !== prev) changed = true;
            state.focusPanel = 'diff';
          }
        } else {
          // Diff mode: diff scroll
          const prev = state.diffScrollOffset;
          const maxDiff = Math.max(0, (ui.diffMaxScroll || 0));
          state.diffScrollOffset = Math.max(0, Math.min(maxDiff, state.diffScrollOffset + wheelStep));
          if (state.diffScrollOffset !== prev) changed = true;
          state.focusPanel = 'diff';
        }
        if (changed) render();
      }
      continue;
    }

    // Left click
    if (cb === 0) {
      // Title rows click
      if (cy >= L.startRow && cy < bodyTop) {
        let handled = false;
        for (const zone of ui.titleClickZones) {
          if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
            // 딤드로 그린 버튼은 여기서 끝낸다 — 렌더가 판정한 그대로 막고 사유만 알린다.
            if (zone.enabled === false) {
              handled = true;
              guardAction(zone.action);
              break;
            }
            if (zone.action === 'toggleStatus') {
              ui.leftPanelCollapsed = !ui.leftPanelCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleHistory') {
              ui.rightTopCollapsed = !ui.rightTopCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleLogSort') {
              ui.logSortMode = ui.logSortMode === 'date' ? 'branch' : 'date';
              if (!rebuildLogGraphRows()) refreshLog();
              updateLogDetail();
              render();
              handled = true;
            } else if (zone.action === 'toggleLogRecovery') {
              ui.logShowRecovery = !ui.logShowRecovery;
              // 끌 때는 그리기 단계에서 걸러 내면 되지만, 켤 때는 유실 커밋이 캐시에 없을
              // 수 있다 — 꺼져 있는 동안에는 reflog 를 아예 조회하지 않기 때문이다.
              // 그때만 다시 읽는다.
              if (ui.logShowRecovery && !logCacheHasRecovery()) refreshLog({ force: true });
              else if (!rebuildLogGraphRows()) refreshLog();
              updateLogDetail();
              render();
              handled = true;
            } else if (zone.action === 'toggleDetail') {
              ui.rightBottomCollapsed = !ui.rightBottomCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleFiles') {
              ui.middlePanelCollapsed = !ui.middlePanelCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleFileTree') {
              setFileTreeView(!ui.fileTreeView);
              render();
              handled = true;
            } else if (zone.action === 'toggleDiff') {
              state.diffView = state.diffView === 'side' ? 'unified' : 'side';
              state.diffScrollOffset = 0;
              state.diffScrollX = 0;
              render();
              handled = true;
            } else if (zone.action === 'tab-local') {
              ui.leftPanelActiveBranch = null;
              state.rightView = 'diff';
              refreshInBackground({ statusOnly: true });
              updateDiff();
      
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'tab-commits') {
              state.rightView = 'log';
              refreshLog();
              state.logCursor = 0;
              state.logScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateLogDetail();
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'tab-fresh') {
              state.rightView = 'fresh';
              refreshFresh();
              state.freshCursor = 0;
              state.freshScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateFreshDetail();
      
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'git-fetch') {
              handled = true;
              requestFetch();
            } else if (zone.action === 'git-pull') {
              handled = true;
              requestPull();
            } else if (zone.action === 'git-push') {
              handled = true;
              requestPush();
            } else if (zone.action === 'git-stash') {
              handled = true;
              if (!guardAction('git-stash')) break;
              state.pendingStash = true;
              hecaton.dialog.show({
                type: 'message',
                title: 'Stash',
                message: 'Stash changes?',
                buttons: [
                  { id: 'stash_confirm', label: 'Stash', default: true },
                  { id: 'cancel', label: 'Cancel' },
                ],
              });
              handled = true;
            } else if (zone.action === 'op-abort') {
              handled = true;
              if (!guardAction('op-abort')) break;
              const opType = state.operationState ? state.operationState.type : null;
              const opLabel = opType === 'merge' ? 'merge' : opType === 'cherry-pick' ? 'cherry-pick' : opType === 'revert' ? 'revert' : 'rebase';
              const abortFn = opType === 'merge' ? () => gitMergeAbort(state.cwd)
                : opType === 'cherry-pick' ? () => gitCherryPickAbort(state.cwd)
                : opType === 'revert' ? () => gitRevertAbort(state.cwd)
                : () => gitRebaseAbortAsync(state.cwd);
              const abortOp = startSpinner('Aborting ' + opLabel + '...', CHECKOUT_SCOPES);
              Promise.resolve(abortFn()).then(async err => {
                await refreshAsync();
                if (state.rightView === 'log') refreshLog();
                stopSpinner(abortOp);
                if (err) showErrorDialog(err);
                render();
              });
              handled = true;
            } else if (zone.action === 'op-skip') {
              handled = true;
              if (!guardAction('op-skip')) break;
              const opType = state.operationState ? state.operationState.type : null;
              const skipFn = opType === 'cherry-pick' ? () => gitCherryPickSkip(state.cwd)
                : opType === 'revert' ? () => gitRevertSkip(state.cwd)
                : () => gitRebaseSkipAsync(state.cwd);
              const skipOp = startSpinner('Skipping...', CHECKOUT_SCOPES);
              Promise.resolve(skipFn()).then(async err => {
                await refreshAsync();
                if (state.rightView === 'log') refreshLog();
                stopSpinner(skipOp);
                if (err && isRebaseConflictError(err)) {
                  switchToDiffViewForConflict();
                }
                if (err) showErrorDialog(err);
                render();
              });
              handled = true;
            } else if (zone.action === 'tab_init' || zone.action === 'tab_change_repo' || zone.action === 'tab_clone') {
              handled = true;
              await handleContextMenuAction(zone.action);
            }
            break;
          }
        }
        if (handled) continue;
      }

      // 비저장소 첫 화면의 본문 설정 버튼
      let setupHandled = false;
      for (const zone of ui.repoSetupClickZones) {
        if (cy !== zone.row || cx < zone.colStart || cx > zone.colEnd) continue;
        setupHandled = true;
        if (zone.enabled === false) guardAction(zone.action);
        else await handleContextMenuAction(zone.action);
        break;
      }
      if (setupHandled) continue;

      // Divider drag start: first vertical divider
      if (!ui.leftPanelCollapsed) {
        if (cx === div1Col && cy >= bodyTop && cy < bodyTop + L.bodyH) {
          ui.dragging = 'vertical';
          setMouseShape('ew-resize');
          continue;
        }
      }
      // Divider drag start: second vertical divider (diff mode only)
      if (L.middleW > 0 && cx === div2Col && cy >= bodyTop && cy < bodyTop + L.bodyH) {
        ui.dragging = 'vertical2';
        setMouseShape('ew-resize');
        continue;
      }
      // Horizontal divider drag start (log/fresh mode)
      if (state.rightView === 'log' || state.rightView === 'fresh') {
        const hListH = state.rightView === 'fresh' ? ui.lastFreshListH : ui.lastLogListH;
        if (hListH > 0) {
          const hDivRow = bodyTop + hListH;
          if (cy === hDivRow && cx >= rightStart) {
            ui.dragging = 'horizontal';
            setMouseShape('ns-resize');
            continue;
          }
        }
      }

      // Scrollbar drag start
      {
        let sbHandled = false;
        for (const sb of ui.scrollbarOverlays) {
          if (cx === sb.screenCol && cy >= sb.screenRow && cy < sb.screenRow + sb.viewportRows) {
            ui.dragging = 'scrollbar';
            ui.scrollbarDragInfo = {
              target: sb.target,
              trackTop: sb.screenRow,
              trackH: sb.viewportRows,
              maxScroll: sb.maxScroll
            };
            const relY = cy - sb.screenRow;
            const ratio = Math.max(0, Math.min(1, relY / Math.max(1, sb.viewportRows - 1)));
            applyScrollbarOffset(sb.target, Math.round(ratio * sb.maxScroll));
            render();
            sbHandled = true;
            break;
          }
        }
        if (sbHandled) continue;
      }

      // Horizontal scrollbar drag start
      {
        let hsbHandled = false;
        for (const hsb of ui.hScrollbarZones) {
          if (cy === hsb.screenRow && cx >= hsb.colStart && cx <= hsb.colEnd) {
            ui.dragging = 'hscrollbar';
            ui.hScrollbarDragInfo = {
              target: hsb.target,
              colStart: hsb.colStart,
              trackCols: hsb.trackCols,
              maxScrollX: hsb.maxScrollX,
            };
            const relX = cx - hsb.colStart;
            const ratio = Math.max(0, Math.min(1, relX / Math.max(1, hsb.trackCols - 1)));
            const newScrollX = Math.round(ratio * hsb.maxScrollX);
            if (hsb.target === 'diff') {
              state.diffScrollX = newScrollX;
            } else if (hsb.target === 'files') {
              state.filesScrollX = newScrollX;
            } else {
              state.diffScrollX = newScrollX;
            }
            render();
            hsbHandled = true;
            break;
          }
        }
        if (hsbHandled) continue;
      }

      // Click on committer controls at the right edge of the hint bar
      let committerHandled = false;
      for (const zone of ui.committerClickZones) {
        if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
          committerHandled = await handleCommitterAction(zone.action);
          break;
        }
      }
      if (committerHandled) continue;

      // Click on hint bar buttons
      for (const area of ui.clickableAreas) {
        if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
          handleKey(actionToKey(area.action));
          break;
        }
      }

      // Click on left panel (clickMap-based)
      {
        const bodyRowIdx2 = cy - (bodyTop);
        const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft && bodyRowIdx2 >= 0 && bodyRowIdx2 < ui.leftPanelClickMap.length) {
          const entry = ui.leftPanelClickMap[bodyRowIdx2];
          if (entry) {
            let leftHandled = true;
            if (entry.action === 'tab-local') {
              ui.leftPanelActiveBranch = null;
              state.rightView = 'diff';
              updateDiff();
      
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'tab-commits') {
              state.rightView = 'log';
              refreshLog();
              state.logCursor = 0;
              state.logScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateLogDetail();
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'tab-fresh') {
              state.rightView = 'fresh';
              refreshFresh();
              state.freshCursor = 0;
              state.freshScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateFreshDetail();
      
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'toggle-section') {
              ui.collapsedSections[entry.section] = !ui.collapsedSections[entry.section];
              render();
            } else if (entry.action === 'toggle-group') {
              ui.collapsedGroups[entry.group] = !ui.collapsedGroups[entry.group];
              render();
            } else if (entry.action === 'goto-branch') {
              if (state.remoteBranches.includes(entry.branch)) {
                ui.remoteRecentBranchUsage[entry.branch] = Date.now();
              }
              ui.leftPanelActiveBranch = entry.branch;
              // 상단 브랜치명 줄 클릭 — 목록의 그 줄까지 상위 토글을 펼치고 스크롤한다.
              if (entry.reveal) revealBranch(entry.branch);
              if (state.rightView !== 'log') {
                state.rightView = 'log';
                refreshLog();
                state.logCursor = 0;
                state.logScrollOffset = 0;
                state.diffScrollOffset = 0;
                updateLogDetail();
              }
              const targetBranch = entry.branch;
              let foundIdx = -1;
              // Check if target is the current branch (may be detached HEAD)
              const isCurrentBranch = state.branches.some(b => b.isCurrent && b.name === targetBranch);
              for (let si = 0; si < state.logItems.length; si++) {
                const item = state.logItems[si];
                if (item.type !== 'commit' || !item.decoration) continue;
                const refs = item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '').split(', ');
                for (const ref of refs) {
                  const trimmed = ref.trim();
                  const cleaned = trimmed.startsWith('HEAD -> ') ? trimmed.substring(8) : trimmed;
                  if (cleaned === targetBranch) { foundIdx = si; break; }
                  // Detached HEAD: decoration is bare "HEAD", match if clicking current branch
                  if (isCurrentBranch && trimmed === 'HEAD') { foundIdx = si; break; }
                }
                if (foundIdx >= 0) break;
              }
              if (foundIdx >= 0) {
                const selectIdx = state.logSelectables.indexOf(foundIdx);
                if (selectIdx >= 0) {
                  state.logCursor = selectIdx;
                  state.diffScrollOffset = 0;
                  updateLogDetail();
                }
              }
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'goto-stash') {
              const now = Date.now();
              // 더블클릭 Apply는 쓰기 작업 — 지금 불가능하면 선택 동작으로만 처리한다.
              if (ui.lastClickStashRef === entry.ref && now - ui.lastClickStashTime < 400 && guardAction('stash_apply')) {
                // Double-click: show Apply Stash dialog
                ui.lastClickStashRef = null;
                ui.lastClickStashTime = 0;
                const stashEntry = state.stashes.find(s => s.ref === entry.ref);
                const stashMessage = stashEntry ? stashEntry.message : '';
                const displayRef = entry.ref + (stashMessage ? '  ' + stashMessage : '');
                hecaton.dialog.show({
                  type: 'message',
                  title: 'Apply Stash',
                  message: 'Apply changes of the stash to your working directory.\n\nStash to Apply:  ' + displayRef,
                  checkboxes: [{ id: 'delete_after', label: 'Delete stash after applying\nStash will not be deleted if a conflict occurs', checked: false }],
                  buttons: [
                    { id: 'apply', label: 'Apply', default: true },
                    { id: 'cancel', label: 'Cancel' },
                  ],
                });
                state.pendingDialogAction = 'stash-apply-confirm';
                state.pendingDialogTarget = entry.ref;
              } else {
                ui.lastClickStashRef = entry.ref;
                ui.lastClickStashTime = now;
              }
              ui.leftPanelActiveBranch = 'stash:' + entry.shortHash;
              if (state.rightView !== 'log') {
                state.rightView = 'log';
                refreshLog();
                state.logCursor = 0;
                state.logScrollOffset = 0;
                state.diffScrollOffset = 0;
                updateLogDetail();
              }
              const targetHash = entry.shortHash;
              let foundIdx = -1;
              for (let si = 0; si < state.logItems.length; si++) {
                const item = state.logItems[si];
                if (item.type === 'commit' && item.ref === targetHash) { foundIdx = si; break; }
              }
              if (foundIdx >= 0) {
                const selectIdx = state.logSelectables.indexOf(foundIdx);
                if (selectIdx >= 0) {
                  state.logCursor = selectIdx;
                  state.diffScrollOffset = 0;
                  updateLogDetail();
                }
              }
              state.focusPanel = 'status';
              render();
            } else {
              leftHandled = false;
            }
            if (leftHandled) continue;
          }
        }
      }

      // Click on merge conflict UI zones
      if (ui.mergeClickZones && ui.mergeClickZones.length > 0 && state.rightView === 'diff') {
        const rpStartCol = L.startCol + L.leftW + L.divider1W + L.middleW + L.divider2W;
        let mergeHandled = false;
        for (const zone of ui.mergeClickZones) {
          const zoneRow = bodyTop + zone.lineIdx;
          const zoneColStart = rpStartCol + zone.colStart;
          const zoneColEnd = rpStartCol + zone.colEnd;
          if (cy === zoneRow && cx >= zoneColStart && cx <= zoneColEnd) {
            // 버튼(btn-*)과 코드 영역(select-*)은 강조 대상만 다르고 고르는 결과는 같다.
            const pick = zone.action === 'select-ours' || zone.action === 'btn-ours' ? 'ours'
              : zone.action === 'select-theirs' || zone.action === 'btn-theirs' ? 'theirs'
              : zone.action === 'btn-both' ? 'both'
              : null;
            if (pick) {
              ui.mergeChunkCursor = zone.chunkIndex;
              setConflictSelection(zone.chunkIndex, pick);
              ensureConflictCursorVisible();
              render();
              mergeHandled = true;
            } else if (zone.action === 'prev-conflict' || zone.action === 'next-conflict') {
              if (moveConflictChunkCursor(zone.action === 'prev-conflict' ? -1 : 1)) render();
              mergeHandled = true;
            } else if (zone.action === 'focus-chunk') {
              ui.mergeChunkCursor = zone.chunkIndex;
              ensureConflictCursorVisible();
              render();
              mergeHandled = true;
            } else if (zone.action === 'apply-merge') {
              await applyConflictSelections();
              mergeHandled = true;
            }
            break;
          }
        }
        if (mergeHandled) continue;
      }

      if (ui.mergeApplyZone && cy === ui.mergeApplyZone.row && cx >= ui.mergeApplyZone.colStart && cx <= ui.mergeApplyZone.colEnd) {
        await applyConflictSelections();
        continue;
      }

      // Click on diff hunk stage/unstage buttons
      if (ui.diffHunkZones && ui.diffHunkZones.length > 0 && state.rightView === 'diff') {
        const rpStartCol = L.startCol + L.leftW + L.divider1W + L.middleW + L.divider2W;
        let hunkHandled = false;
        for (const zone of ui.diffHunkZones) {
          if (cy === bodyTop + zone.lineIdx && cx >= rpStartCol + zone.colStart && cx <= rpStartCol + zone.colEnd) {
            await applyHunkAction(zone.hunkIdx);
            hunkHandled = true;
            break;
          }
        }
        if (hunkHandled) continue;
      }

      // Click on 메시지 지우기 버튼 — 커서 이동보다 먼저 본다(메시지 줄 위에 얹혀 있다).
      if (ui.commitClearZone && cy === ui.commitClearZone.row && cx >= ui.commitClearZone.colStart && cx <= ui.commitClearZone.colEnd) {
        if (state.mode === 'commit' && state.commitMsg.length > 0) {
          state.commitMsg = '';
          state.commitCursor = 0;
          render();
        }
        continue;
      }

      // Click on amend 토글 (Commit 버튼 오른쪽)
      if (ui.commitAmendZone && cy === ui.commitAmendZone.row && cx >= ui.commitAmendZone.colStart && cx <= ui.commitAmendZone.colEnd) {
        // 커밋 모드에서는 amend on/off 토글, 일반 모드에서는 amend 커밋 모드로 진입
        if (!guardAction('commit-amend')) continue;
        if (state.mode === 'commit') {
          toggleCommitAmend();
        } else {
          enterAmendCommitMode();
        }
        continue;
      }

      // Click on commit button zone
      if (ui.commitButtonZone && cy === ui.commitButtonZone.row && cx >= ui.commitButtonZone.colStart && cx <= ui.commitButtonZone.colEnd) {
        // 커밋 모드면 제출, 아니면 커밋 모드 진입 — 버튼 색을 정한 판정과 같은 id 를 쓴다.
        if (state.mode === 'commit') {
          if (guardAction('commit-submit')) handleCommitInput(CSI + '13;5u');
        } else if (guardAction('commit-enter')) {
          enterCommitMode();
        }
        continue;
      }

      // Click on commit input row -> enter commit mode
      // 버튼이 아니라 입력 영역이라 막혔을 때 사유를 띄우지 않는다 — 지나가는 클릭까지
      // 안내가 뜨면 잔소리가 된다. 왜 안 되는지는 바로 아래 [Commit] 버튼이 알려 준다.
      if (ui.commitInputRow > 0 && cy === ui.commitInputRow && cx >= rightStart && cx < L.startCol + L.width) {
        if (state.mode !== 'commit' && isEnabled('commit-enter')) {
          enterCommitMode();
        }
        continue;
      }

      const bodyRowIdx = cy - (bodyTop);
      const inMiddle = cx >= midStart && cx < midStart + L.middleW;
      const inRight = cx >= rightStart && cx < L.startCol + L.width;

      // Click on middle panel
      if (inMiddle && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
        if (state.rightView === 'log') {
          // Log list click
          const itemIdx = state.logScrollOffset + bodyRowIdx;
          const selectIdx = state.logSelectables.indexOf(itemIdx);
          if (selectIdx >= 0) {
            state.logCursor = selectIdx;
            state.diffScrollOffset = 0;
            updateLogDetail();
          }
        } else {
          // File header button click ([Stage] / [Unstage])
          let headerHandled = false;
          for (const zone of ui.fileHeaderZones) {
            const visibleLineIdx = zone.lineIdx - state.scrollOffset;
            if (visibleLineIdx === bodyRowIdx) {
              const btnScreenColStart = midStart + zone.btnColStart;
              const btnScreenColEnd = midStart + zone.btnColEnd;
              if (cx >= btnScreenColStart && cx <= btnScreenColEnd) {
                if (zone.action === 'toggleIgnored') {
                  const opening = ui.collapsedSections.ignored !== false;
                  ui.collapsedSections.ignored = opening ? false : true;
                  if (opening && !state.ignoredLoaded) {
                    state.ignoredLoading = true;
                    render();
                    refreshAsync({ statusOnly: true, includeIgnored: true }).then(() => render());
                  } else {
                    render();
                  }
                  headerHandled = true;
                  break;
                }
                headerHandled = true;
                // 딤드로 그린 버튼은 렌더가 판정한 그대로 막고 사유만 알린다.
                if (zone.enabled === false) {
                  guardAction(zone.action);
                  break;
                }
                if (zone.action === 'unlockIndex') {
                  // 쓰기 작업이 도는 동안 락 삭제를 허용하면 그 작업의 index.lock을
                  // 지울 수 있다 — 반드시 작업 종료 후에만.
                  if (!guardAction('unlockIndex')) break;
                  hecaton.dialog.show({
                    type: 'message',
                    title: 'Unlock Git Index',
                    message: 'Delete index.lock?\n\nOnly continue after confirming no Git command is still running. Deleting an active lock can damage the Git index.',
                    buttons: [
                      { id: 'unlock', label: 'Delete Lock', style: 'danger' },
                      { id: 'cancel', label: 'Cancel', default: true },
                    ],
                  });
                  state.pendingDialogAction = 'unlock-index-confirm';
                  break;
                }
                if (zone.action === 'stageAll' || zone.action === 'unstageAll') {
                  requestStageAll(zone.action === 'stageAll');
                  break;
                }
                requestStageSelection(zone.action === 'stageSelected');
                break;
              }
            }
          }
          if (headerHandled) { continue; }
          // File list click
          if (bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
            state.selectedFiles.clear();
            const fileIdx = ui.fileLineMap[bodyRowIdx];
            const clicked = buildFileList()[fileIdx];
            const now = Date.now();

            if (clicked && clicked.kind === 'dir') {
              // 트리에서 제일 잦은 동작이라 더블클릭 뒤에 숨기지 않는다. 접고 펴면
              // 아래 줄이 통째로 밀리므로 커서는 인덱스가 아니라 그 폴더를 다시 찾아 옮긴다.
              toggleFileDir(clicked, fileIdx);
              ui.lastClickFileIdx = -1;
              ui.lastClickTime = 0;
            } else if (fileIdx === ui.lastClickFileIdx && now - ui.lastClickTime < 400) {
              // Double-click: stage/unstage toggle — 막혀 있으면 예약해 둔다. 파일을
              // 연달아 더블클릭하는 흐름이라, 앞의 git 이 도는 사이 누른 것이 버려지면
              // 눌렀는지 아닌지를 목록으로 되짚어야 한다. 대상이 파일 하나로 분명하므로
              // 그대로 실어 보내면 된다.
              const item = buildFileList()[fileIdx];
              const isUnstage = item && item.type === 'staged';
              if (item && item.type !== 'ignored') {
                requestStageFiles(!isUnstage, [item.file]);
              }
              ui.lastClickFileIdx = -1;
              ui.lastClickTime = 0;
            } else {
              state.cursor = fileIdx;
              ui.lastClickFileIdx = fileIdx;
              ui.lastClickTime = now;
            }
            updateDiff();
          }
        }
        state.focusPanel = 'status';
        render();
      }

      // Click on right panel
      if (inRight && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
        if (state.rightView === 'fresh') {
          // Fresh mode: check window button click first
          if (ui.freshWindowZone && bodyRowIdx === ui.freshWindowZone.lineIdx) {
            const relCol = cx - rightStart;
            if (relCol >= ui.freshWindowZone.colStart && relCol <= ui.freshWindowZone.colEnd) {
              state.freshTimeWindow = (state.freshTimeWindow + 1) % FRESH_TIME_WINDOWS.length;
              refreshFresh();
              state.diffScrollOffset = 0;
              updateFreshDetail();
              render();
              continue;
            }
          }
          // Fresh mode: top = file list, bottom = detail
          if (bodyRowIdx < ui.lastFreshListH) {
            const mapIdx = bodyRowIdx;
            if (mapIdx >= 0 && mapIdx < ui.freshFileLineMap.length && ui.freshFileLineMap[mapIdx] >= 0) {
              state.freshCursor = ui.freshFileLineMap[mapIdx];
              state.diffScrollOffset = 0;
              updateFreshDetail();
            }
            state.focusPanel = 'status';
          } else {
            state.focusPanel = 'diff';
          }
        } else if (state.rightView === 'log') {
          // Log mode: top = log list, bottom = detail
          if (bodyRowIdx < ui.lastLogListH) {
            const itemIdx = state.logScrollOffset + bodyRowIdx;
            const selectIdx = state.logSelectables.indexOf(itemIdx);
            if (selectIdx >= 0) {
              state.logCursor = selectIdx;
              state.diffScrollOffset = 0;
              updateLogDetail();
            }
            state.focusPanel = 'status';
          } else {
            // Detail area: check for copy zone click
            let copyHandled = false;
            if (ui.detailCopyZones && ui.detailCopyZones.length > 0) {
              const relCol = cx - rightStart;
              for (const zone of ui.detailCopyZones) {
                if (bodyRowIdx === zone.lineIdx && relCol >= zone.colStart && relCol <= zone.colEnd) {
                  hecaton.clipboard.write({ text: zone.text }).catch(() => null);
                  // 복사는 쓰기 작업이 아니다 — spinner 대신 비차단 토스트로 알린다.
                  showToast('Copied: ' + zone.text);
                  state.focusPanel = 'diff';
                  copyHandled = true;
                  break;
                }
              }
            }
            if (copyHandled) { render(); continue; }
            // Check for Collapse/Expand All button on refs line
            const refsRowIdx = ui.lastLogListH + 1; // separator + refs line
            if (bodyRowIdx === refsRowIdx && ui.detailCollapseAllZone) {
              const relCol = cx - rightStart;
              if (relCol >= ui.detailCollapseAllZone.colStart && relCol <= ui.detailCollapseAllZone.colEnd) {
                // Toggle all detail files
                const allFiles = [];
                for (const entry of (state.logDetailLines || [])) {
                  const m = entry.match && entry.match(/^diff --git a\/.+ b\/(.+)/);
                  if (m) allFiles.push(m[1]);
                }
                // Also check from detailFileHeaderMap
                for (const f of ui.detailFileHeaderMap) {
                  if (f && !allFiles.includes(f)) allFiles.push(f);
                }
                const allCollapsed = allFiles.length > 0 && allFiles.every(f => ui.collapsedDetailFiles.has(f));
                if (allCollapsed) {
                  ui.collapsedDetailFiles.clear();
                } else {
                  for (const f of allFiles) ui.collapsedDetailFiles.add(f);
                }
                state.focusPanel = 'diff';
                render();
                continue;
              }
            }
            // Check for file header toggle click
            const detailRowIdx = bodyRowIdx - ui.lastLogListH - 1 - 1; // -separator -refs line
            if (detailRowIdx >= 0 && detailRowIdx < ui.detailFileHeaderMap.length) {
              const file = ui.detailFileHeaderMap[detailRowIdx];
              if (file) {
                if (ui.collapsedDetailFiles.has(file)) {
                  ui.collapsedDetailFiles.delete(file);
                } else {
                  ui.collapsedDetailFiles.add(file);
                }
              }
            }
            state.focusPanel = 'diff';
          }
        } else {
          state.focusPanel = 'diff';
        }
        render();
      }
    }

  }
  return hadMouse;
}

function cleanup() {
  process.stdout.write(ansi.mouseShape('default') + CSI + '?7h' + ansi.showCursor + ansi.reset + ansi.clear);
}

function joinPath(...parts) { return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/'); }

function handleContextMenuRequest(col, row) {
  const L = ui.lastLayout;
  if (!L) return;

  const titleH = (L.titleRows || 2) + 1;
  const bodyTop = L.startRow + titleH;
  const midStart = L.startCol + L.leftW + L.divider1W;
  const cx = col;
  const cy = row;

  // Title bar: tab context menu
  if (cy >= L.startRow && cy < bodyTop) {
    for (let i = 0; i < ui.titleClickZones.length; i++) {
      const zone = ui.titleClickZones[i];
      if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
        const act = zone.action;
        if (act === 'tab-local' || act === 'tab-commits' || act === 'tab-fresh') {
          ui.contextMenuTab = true;
          ui.contextMenuStashRef = null;
          ui.contextMenuFileItem = null;
          ui.contextMenuFileItems = [];
          ui.contextMenuFilePath = '';
          hecaton.menu.show({ items: buildTabContextMenuItems() }).catch(() => null);
          render();
          return;
        }
      }
    }
  }

  // Left panel
  if (!ui.leftPanelCollapsed) {
    const bodyRowIdx = cy - bodyTop;
    const inLeft = cx >= L.startCol && cx < L.startCol + L.leftW;
    if (inLeft && bodyRowIdx >= 0 && bodyRowIdx < ui.leftPanelClickMap.length) {
      const entry = ui.leftPanelClickMap[bodyRowIdx];
      if (entry && entry.action === 'goto-branch' && state.remoteBranches.includes(entry.branch)) {
        ui.leftPanelActiveBranch = entry.branch;
        ui.contextMenuRemoteBranch = entry.branch;
        hecaton.menu.show({ items: buildRemoteBranchContextMenuItems(entry.branch) }).catch(() => null);
        render();
        return;
      }
      if (entry && (entry.action === 'goto-worktree' || (entry.action === 'toggle-section' && entry.section === 'worktrees'))) {
        ui.contextMenuWorktree = entry.action === 'goto-worktree' ? entry.path : null;
        hecaton.menu.show({ items: buildWorktreeContextMenuItems(ui.contextMenuWorktree) }).catch(() => null);
        render();
        return;
      }
      if (isRemoteMenuTarget(entry)) {
        ui.contextMenuStashRef = null;
        ui.contextMenuFileItem = null;
        ui.contextMenuFileItems = [];
        ui.contextMenuFilePath = '';
        // remote 그룹 행이면 remote 이름 추출 → remote 관리 항목 노출
        let remoteName = null;
        if (entry.action === 'toggle-group' && typeof entry.group === 'string' && entry.group.startsWith('r:')) {
          remoteName = entry.group.substring(2).split('/')[0];
        }
        ui.contextMenuRemote = remoteName && state.remotes.includes(remoteName) ? remoteName : null;
        hecaton.menu.show({ items: buildRemotesContextMenuItems(ui.contextMenuRemote) }).catch(() => null);
        render();
        return;
      }
      if (entry && entry.action === 'goto-stash' && entry.ref) {
        ui.leftPanelActiveBranch = 'stash:' + entry.shortHash;
        ui.contextMenuStashRef = entry.ref;
        const stashEntry = state.stashes.find(s => s.ref === entry.ref);
        const stashMessage = stashEntry ? stashEntry.message : '';
        hecaton.menu.show({ items: buildStashContextMenuItems(entry.ref, stashMessage) }).catch(() => null);
        render();
        return;
      }
      if (entry && entry.action === 'goto-branch' && !state.remoteBranches.includes(entry.branch)) {
        ui.leftPanelActiveBranch = entry.branch;
        ui.contextMenuBranch = entry.branch;
        ui.contextMenuWorktree = null;  // 브랜치 메뉴의 New Worktree는 대상 워크트리가 없다
        hecaton.menu.show({ items: buildBranchContextMenuItems(entry.branch) }).catch(() => null);
        render();
        return;
      }
    }
  }

  // Right panel: log view
  if (state.rightView === 'log') {
    const bodyRowIdx = cy - bodyTop;
    const rightStart2 = midStart + L.middleW + L.divider2W;
    const inRight2 = cx >= rightStart2 && cx < L.startCol + L.width;
    if (inRight2 && bodyRowIdx >= 0 && bodyRowIdx < ui.lastLogListH) {
      const itemIdx = state.logScrollOffset + bodyRowIdx;
      const selectIdx = state.logSelectables.indexOf(itemIdx);
      if (selectIdx >= 0) {
        state.logCursor = selectIdx;
        state.diffScrollOffset = 0;
        updateLogDetail();
        state.focusPanel = 'status';
      }
    }
    // stash 커밋이면 stash 전용 컨텍스트 메뉴 표시
    const logItem = selectedLogRef();
    const stashRef = logItem ? ui.stashMap.get(logItem.ref) : null;
    if (stashRef) {
      ui.contextMenuStashRef = stashRef;
      const stashEntry = state.stashes.find(s => s.ref === stashRef);
      const stashMessage = stashEntry ? stashEntry.message : '';
      hecaton.menu.show({ items: buildStashContextMenuItems(stashRef, stashMessage) }).catch(() => null);
    } else {
      hecaton.menu.show({ items: buildHistoryContextMenuItems() }).catch(() => null);
    }
    render();
    return;
  }

  // Middle panel: file list (diff mode)
  {
    const bodyRowIdx = cy - bodyTop;
    const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
    if (inMiddle && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
      const fileIdx = ui.fileLineMap[bodyRowIdx];
      const fileList = buildFileList();
      const item = fileList[fileIdx];
      state.cursor = fileIdx;
      updateDiff();
      state.focusPanel = 'status';
      if (item) {
        if (!state.selectedFiles.has(fileIdx)) {
          state.selectedFiles.clear();
          state.selectedFiles.add(fileIdx);
        }
        const targets = Array.from(state.selectedFiles)
          .sort((a, b) => a - b)
          .map((idx) => fileList[idx])
          .filter(Boolean);
        ui.contextMenuStashRef = null;
        ui.contextMenuFileItem = item;
        ui.contextMenuFileItems = targets;
        ui.contextMenuFilePath = joinPath(state.cwd, item.kind === 'dir' ? item.dir : item.file);
        const menuItems = item.kind === 'dir'
          ? buildDirContextMenuItems(item, targets)
          : buildFileContextMenuItems(item, targets);
        hecaton.menu.show({ items: menuItems }).catch(() => null);
      }
      render();
      return;
    }
  }
}

function isRemoteMenuTarget(entry) {
  if (!entry) return false;
  if (entry.action === 'toggle-section' && entry.section === 'remotes') return true;
  if (entry.action === 'toggle-group' && typeof entry.group === 'string' && entry.group.startsWith('r:')) return true;
  if (entry.action === 'goto-branch' && state.remoteBranches.includes(entry.branch)) return true;
  return false;
}

module.exports = { handleKey, handleMouseData, actionToKey, cleanup, handleContextMenuRequest, maybeLoadMoreLog, buildResolvedConflictContent };
