// ── 동작 활성/비활성 판정의 단일 출처 ──
//
// 배경: 차단 장치는 실행 직전의 guardWriteOp 하나뿐이었다. 그래서 커밋이 도는 동안에도
// Stage/Unstage/Checkout 버튼과 메뉴 항목이 평소와 똑같이 보였고, 눌러 봐야 "무시됐다"를
// 알 수 있었다. 게다가 기준이 "다른 쓰기 작업 중" 하나여서, rebase 진행 중 체크아웃처럼
// 논리적으로 성립하지 않는 조합은 그대로 통과해 git 이 뱉는 fatal 로만 드러났다.
//
// 여기서는 모든 동작을 한 표에 모아 "지금 가능한가 / 아니면 왜 안 되는가"를 한 곳에서
// 판정한다. 그 결과를 세 곳이 같이 쓴다:
//   1. render      — 버튼을 흐리게 그리고 hover 강조를 끈다 (actions.isEnabled)
//   2. menu 빌더    — 항목에 enabled:false 를 실어 호스트가 딤 처리하게 한다 (decorateMenuItems)
//   3. dispatch    — 실행 직전에 다시 막고 사유를 알린다 (guardAction)
// 화면 표시와 실제 차단이 같은 규칙을 보므로 "보이는데 안 된다"가 생길 수 없다.
//
// 규칙을 더할 때의 원칙:
//   - 기본은 차단이다. 여기 등록되지 않은 id 는 쓰기로 보고 공통 전제를 적용한다.
//     읽기 동작을 빠뜨리면 잠깐 과하게 막힐 뿐이지만, 쓰기를 통과시키면 작업이 겹친다.
//   - 단, 판단 근거가 불확실하면 열어 둔다(fail open). 예를 들어 refs 조회가 실패해
//     브랜치 목록이 비어 있는 상태를 detached 로 단정하면 멀쩡한 push 까지 막힌다.
const { state, ui } = require('./state');

// ── 사유 문자열 ──
// 힌트바/토스트에 그대로 나가므로 UI 언어(영문)에 맞추고 한 줄로 유지한다.
const REASON = {
  LOADING: 'Loading repository...',
  BUSY: 'Another operation is running',
  NO_REPO: 'Not a git repository',
  INDEX_LOCKED: 'Git index is locked — Unlock first',
  CONFLICTS: 'Resolve conflicts first',
  NO_OPERATION: 'No operation in progress',
  DETACHED: 'Detached HEAD — no current branch',
  NO_REMOTE: 'No remote configured',
  NO_UPSTREAM: 'No upstream configured',
  NO_STAGED: 'Nothing staged',
  NO_STAGEABLE: 'Nothing to stage',
  NO_UNSTAGEABLE: 'Nothing to unstage',
  NO_CHANGES: 'No local changes',
  NO_UNTRACKED: 'No untracked files',
  NO_STASH: 'No stashes',
  NO_COMMIT: 'Select a commit in the history first',
  NO_MESSAGE: 'Commit message is empty',
  NO_FILE: 'No file selected',
  NOT_LOCKED: 'Index is not locked',
  PARTIAL_CONFLICT: 'Select every conflict to apply',
};

function operationLabel(type) {
  switch (type) {
    case 'rebase-merge':
    case 'rebase-apply':
      return 'Rebase';
    case 'merge': return 'Merge';
    case 'cherry-pick': return 'Cherry-pick';
    case 'revert': return 'Revert';
    default: return 'Operation';
  }
}

// ── 읽기 전용 동작 ──
// 저장소를 바꾸지 않으므로 어떤 상황에서도 막지 않는다(복사/열기/보기 전환/페이지 넘기기).
// 허용 목록이라 여기 없는 id 는 전부 쓰기로 본다 — 새 읽기 동작을 빠뜨리면 쓰기 작업 중
// 잠깐 과하게 막힐 뿐이지만, 쓰기를 잘못 통과시키면 작업이 겹친다.
// 서브메뉴를 여는 부모 항목도 여기 둔다. 부모 자체는 아무것도 실행하지 않고,
// 자식이 전부 막히면 decorateMenuItems 가 부모까지 함께 막아 준다.
const READ_ONLY_ACTIONS = new Set([
  // 새로고침/보기 전환
  'tab_refresh', 'stash_compare',
  // 클립보드 복사
  'copy_sha', 'copy_info', 'save_patch',
  'stash_copy_sha', 'stash_copy_info',
  'branch_copy_name', 'remotebranch_copy_name', 'remote_copy_url',
  'file_copy_path', 'file_copy_full_path', 'file_save_patch',
  'file_external_diff_head', 'file_external_diff_index',
  'file_blame', 'file_history',
  'worktree_copy_path',
  // 파일/탐색기 열기 (현재 저장소를 바꾸지 않음)
  'file_open', 'file_open_explorer', 'file_show_in_explorer',
  'worktree_open_explorer', 'worktree_show_in_explorer',
  // UI 상태만 바꾸는 것들
  'branch_pin',
  'remote_sort_alpha', 'remote_sort_alpha_desc', 'remote_sort_recent',
  'remote_sort_title', 'push_remote_title',
  // 페이지네이션/서브메뉴 열기
  'history_branch_open', 'branch_tracking_open',
  'branches_submenu', 'branch_tracking', 'interactive_rebase',
  'file_external_diff', 'file_ignore', 'file_remove',
  'branch_tracking_title', 'history_branch_title',
  // 화면 전환/패널 토글 (타이틀 행 버튼)
  'tab-local', 'tab-commits', 'tab-fresh',
  'toggleStatus', 'toggleHistory', 'toggleDetail', 'toggleFiles',
  'toggleDiff', 'toggleLogSort', 'toggleLogRecovery', 'toggleIgnored',
  // 커밋 입력 편집 — 저장소가 아니라 입력창만 건드린다
  'commit-clear',
]);

const READ_ONLY_PREFIXES = [
  'history_branch_page:', 'branch_tracking_page:', 'tag_menu:',
];

function isReadOnlyAction(id) {
  if (!id) return true;
  if (READ_ONLY_ACTIONS.has(id)) return true;
  return READ_ONLY_PREFIXES.some(p => id.startsWith(p));
}

// ── 상황 스냅샷 ──
// 한 번 계산해 여러 판정이 나눠 쓴다. render 는 프레임마다 여러 버튼을 물어보므로
// 같은 프레임 안에서 같은 스냅샷을 재사용하는 편이 낫다(context() 참고).
function snapshot() {
  const op = state.operationState ? state.operationState.type : null;
  const branchesKnown = state.branches.length > 0;
  const current = state.branches.find(b => b.isCurrent) || null;
  const isUnmerged = (f) => f && f.status === 'U';
  return {
    loading: !!state.loading,
    // git 명령이 도는 동안(spinnerActive)만이 아니라, 그 결과를 다시 읽어오는 뒷정리
    // 갱신이 끝날 때까지(settlingWrite) 한 동작으로 본다. 창 타이틀도 그동안 계속
    // "Committing..."을 보여 주므로, 여기서 풀어 버리면 "끝났다는 말이 없는데 버튼은
    // 살아 있는" 상태가 되고, 실제로도 커밋 직전의 낡은 목록에 대고 명령을 쏘게 된다.
    busy: !!state.spinnerActive || !!state.settlingWrite,
    repo: !!state.isGitRepo,
    locked: !!state.indexLocked,
    op,
    opReason: op ? operationLabel(op) + ' in progress' : null,
    conflicts: state.unstaged.some(isUnmerged) || state.staged.some(isUnmerged),
    staged: state.staged.length,
    unstaged: state.unstaged.length,
    untracked: state.untracked.length,
    stashes: state.stashes.length,
    remotes: state.remotes.length,
    upstream: current ? current.upstream : '',
    // detached 는 브랜치 목록을 실제로 읽어 왔을 때만 단정한다. refs 조회 실패로 목록이
    // 비어 있는 상태(커밋이 하나도 없는 저장소 포함)를 detached 로 오해하면 안 된다.
    detached: branchesKnown && !current,
  };
}

// ── 진행 중인 작업(rebase/merge/cherry-pick/revert)과 겹치면 안 되는 동작 ──
// 충돌 해결에 필요한 stage/unstage/hunk/commit(continue)/abort/skip 은 여기 없다 —
// 그것들을 막으면 진행 중인 작업에서 빠져나올 방법이 사라진다.
const BLOCKED_DURING_OPERATION = new Set([
  // 워킹트리를 통째로 갈아엎는 것들
  'branch_checkout', 'checkout', 'remotebranch_checkout_local', 'remotebranch_checkout_tracking',
  'worktree_open', 'worktree_new', 'worktree_remove', 'worktree_prune', 'tab_change_repo',
  // 새 통합 작업 — 이미 하나가 돌고 있다
  'merge', 'rebase', 'reset', 'cherry_pick', 'revert',
  'branch_merge_into', 'branch_rebase_onto', 'branch_ff', 'branch_pull', 'branch_pull_rebase',
  'git-pull',
  // 히스토리 재작성
  'amend_commit', 'reword_commit', 'squash_commit', 'fixup_commit', 'edit_commit', 'drop_commit',
  'commit-amend',
  // 브랜치/태그 생성·삭제 (생성은 checkout -b 로 이어진다)
  'new_branch', 'new_tag', 'branch_new_branch', 'branch_new_tag', 'remotebranch_new_branch',
  'branch_rename', 'branch_delete', 'branch_delete_remote', 'remotebranch_delete_remote',
  // 푸시 — 진행 중에는 HEAD 가 detached 라 무엇을 올리는지 사용자 의도와 어긋난다
  'git-push', 'branch_push', 'branch_push_pr', 'branch_force_push', 'remote_push_tags',
  // 스태시 — 적용은 워킹트리를 덮고, 저장은 해결 중인 충돌을 걷어간다
  'git-stash', 'stash_apply', 'file_stash_one',
  // 일괄 되돌리기 — 해결 중인 충돌까지 날린다
  'tab_discard_all', 'tab_clean',
]);

const BLOCKED_DURING_OPERATION_PREFIXES = [
  'checkout_branch:', 'push_to_remote:', 'tag_push:', 'tag_delete:', 'tag_delete_remote:',
];

// 진행 중인 작업이 있어야만 의미가 있는 동작
const REQUIRES_OPERATION = new Set(['op-abort', 'op-skip', 'op-menu']);

// 리모트가 하나도 없으면 성립하지 않는 동작
const REQUIRES_REMOTE = new Set([
  'git-fetch', 'git-pull', 'git-push',
  'branch_push', 'branch_push_pr', 'branch_force_push', 'branch_delete_remote',
  'remotebranch_delete_remote', 'remote_push_tags', 'remote_prune',
]);
const REQUIRES_REMOTE_PREFIXES = ['push_to_remote:', 'tag_push:', 'tag_delete_remote:'];

// 현재 브랜치의 업스트림이 있어야 성립하는 동작
const REQUIRES_UPSTREAM = new Set(['git-pull']);

// detached HEAD 에서는 성립하지 않는 동작
const REQUIRES_CURRENT_BRANCH = new Set(['git-pull', 'git-push']);
const REQUIRES_CURRENT_BRANCH_PREFIXES = ['push_to_remote:'];

// 로그에서 커밋 하나를 고른 상태여야 하는 동작
const REQUIRES_COMMIT_SELECTION = new Set([
  'merge', 'rebase', 'reset', 'checkout', 'cherry_pick', 'revert',
  'amend_commit', 'reword_commit', 'squash_commit', 'fixup_commit', 'edit_commit', 'drop_commit',
]);

// 저장소가 없어도 되는 동작 — 저장소를 새로 만들거나 다른 곳을 여는 길이다.
// 이걸 빠뜨리면 "Not a git repository" 상태에서 Init/Clone 까지 같이 막혀 빠져나갈 수 없다.
const REPO_FREE_ACTIONS = new Set(['tab_init', 'tab_clone', 'tab_change_repo']);

// index.lock 과 무관한 쓰기 동작 — 인덱스를 건드리지 않으므로 락이 있어도 막지 않는다.
// (락 해제 버튼 자신도 여기 있어야 한다. 아니면 락이 걸린 순간 빠져나올 수 없다.)
const INDEX_FREE_ACTIONS = new Set([
  'unlockIndex', 'git-fetch',
  'branch_pin', 'branch_track', 'branch_untrack', 'branch_rename',
  'remote_add', 'remote_remove', 'remote_rename', 'remote_set_url', 'remote_prune',
  'committer-name', 'committer-email', 'reset-committer-name', 'reset-committer-email',
  'tab_change_repo', 'tab_clone', 'worktree_open',
]);
const INDEX_FREE_PREFIXES = ['branch_track:'];

function isIndexFree(id) {
  if (INDEX_FREE_ACTIONS.has(id)) return true;
  return INDEX_FREE_PREFIXES.some(p => id.startsWith(p));
}

// ── 동작별 개별 전제 ──
// 공통 전제를 통과한 뒤 마지막으로 보는 조건. null 이면 통과.
const EXTRA_RULES = {
  // 스테이징 — 실제로 옮길 대상이 있어야 버튼이 산다
  stageAll: (s) => (s.unstaged + s.untracked > 0 ? null : REASON.NO_STAGEABLE),
  unstageAll: (s) => (s.staged > 0 ? null : REASON.NO_UNSTAGEABLE),
  stageSelected: () => (stageableTargets().length > 0 ? null : REASON.NO_STAGEABLE),
  unstageSelected: () => (unstageableTargets().length > 0 ? null : REASON.NO_UNSTAGEABLE),
  file_stage: (s, extra) => (targetsOf(extra).some(t => t && t.type !== 'staged' && t.type !== 'ignored') ? null : REASON.NO_STAGEABLE),
  file_unstage: (s, extra) => (targetsOf(extra).some(t => t && t.type === 'staged') ? null : REASON.NO_UNSTAGEABLE),
  file_stage_all: (s) => (s.unstaged + s.untracked > 0 ? null : REASON.NO_STAGEABLE),

  // 커밋 제출 — 화면의 [Commit] 버튼과 Ctrl+Enter 가 같은 판정을 본다.
  // 진행 중인 작업(merge/rebase)에서 빠져나오는 길이므로 BLOCKED_DURING_OPERATION 에 넣지 않는다.
  'commit-submit': (s) => {
    if (s.conflicts) return REASON.CONFLICTS;
    if (state.commitMsg.trim().length === 0) return REASON.NO_MESSAGE;
    const isAmend = state.commitAmend && !s.op;
    if (s.staged === 0 && !isAmend) return REASON.NO_STAGED;
    return null;
  },
  // 커밋 모드 진입 ('c' 키 / 일반 모드에서 버튼·입력줄 클릭)
  'commit-enter': (s) => {
    if (s.conflicts) return REASON.CONFLICTS;
    return s.staged > 0 ? null : REASON.NO_STAGED;
  },

  // 파일 단위 동작 — 우클릭 메뉴가 대상을 함께 넘긴다
  file_discard: (s, extra) => (targetsOf(extra).length > 0 ? null : REASON.NO_FILE),
  file_remove_keep: (s, extra) => (targetsOf(extra).some(t => t && t.type !== 'untracked') ? null : REASON.NO_FILE),
  file_remove_delete: (s, extra) => (targetsOf(extra).some(t => t && t.type !== 'untracked') ? null : REASON.NO_FILE),
  file_accept_ours: (s, extra) => (targetsOf(extra).some(t => t && t.status === 'U') ? null : REASON.NO_FILE),
  file_accept_theirs: (s, extra) => (targetsOf(extra).some(t => t && t.status === 'U') ? null : REASON.NO_FILE),

  // 되돌리기/청소 — 되돌릴 것이 있어야 한다
  tab_discard_all: (s) => (s.staged + s.unstaged + s.untracked > 0 ? null : REASON.NO_CHANGES),
  tab_clean: (s) => (s.untracked > 0 ? null : REASON.NO_UNTRACKED),
  'git-stash': (s) => (s.staged + s.unstaged + s.untracked > 0 ? null : REASON.NO_CHANGES),

  // 스태시 — 목록이 비면 대상이 없다
  stash_apply: (s) => (s.stashes > 0 ? null : REASON.NO_STASH),
  stash_drop: (s) => (s.stashes > 0 ? null : REASON.NO_STASH),
  stash_rename: (s) => (s.stashes > 0 ? null : REASON.NO_STASH),

  // 인덱스 잠금 해제 — 잠겨 있을 때만
  unlockIndex: (s) => (s.locked ? null : REASON.NOT_LOCKED),

  // 충돌 해결 적용 — 모든 충돌 덩어리를 고른 뒤에만
  'merge-apply': () => (allConflictChunksSelected() ? null : REASON.PARTIAL_CONFLICT),

  // 충돌 해결 결과를 인덱스에 반영 ('m' 키) — 고른 파일이 충돌 파일이어야 한다
  'conflict-apply': () => (isConflictSelection() && state.conflictView ? null : REASON.NO_FILE),
};

// ── 대상 계산 도우미 ──
// refresh 는 state/git 만 참조하므로 여기서 불러도 순환이 생기지 않는다.
function fileList() {
  return require('./refresh').buildFileList();
}

// 커서/다중 선택이 가리키는 파일들 — 's'/'u' 키와 헤더 버튼이 쓰는 대상과 같다.
function selectedTargets() {
  const list = fileList();
  const indices = state.selectedFiles.size > 0
    ? Array.from(state.selectedFiles).sort((a, b) => a - b)
    : (list.length > 0 ? [Math.min(state.cursor, list.length - 1)] : []);
  return indices.map(i => list[i]).filter(Boolean);
}

// ignored 파일은 git add 가 거부하므로 스테이징 대상에서 뺀다.
function stageableTargets() {
  return selectedTargets().filter(t => t.type !== 'staged' && t.type !== 'ignored');
}

function unstageableTargets() {
  return selectedTargets().filter(t => t.type === 'staged');
}

function targetsOf(extra) {
  if (extra && Array.isArray(extra.targets)) return extra.targets;
  return selectedTargets();
}

function isConflictSelection() {
  const sel = require('./refresh').selectedItem();
  return !!(sel && sel.status === 'U');
}

function allConflictChunksSelected() {
  if (!state.conflictView) return false;
  const conflictIndices = state.conflictView.chunks
    .map((chunk, idx) => (chunk.type === 'conflict' ? idx : -1))
    .filter(idx => idx >= 0);
  if (conflictIndices.length === 0) return false;
  return conflictIndices.every(idx => ui.mergeChunkSelections[idx]);
}

function hasCommitSelection() {
  const item = require('./refresh').selectedLogRef();
  return !!(item && item.ref);
}

// ── 판정 ──

// 어떤 쓰기 동작이든 먼저 통과해야 하는 공통 전제.
function baseReason(id, s) {
  if (s.loading) return REASON.LOADING;
  if (s.busy) return REASON.BUSY;
  if (!s.repo && !REPO_FREE_ACTIONS.has(id)) return REASON.NO_REPO;
  if (s.locked && !isIndexFree(id)) return REASON.INDEX_LOCKED;
  return null;
}

function matchesPrefix(id, prefixes) {
  return prefixes.some(p => id.startsWith(p));
}

// 지금 이 동작이 막혀 있다면 그 사유를, 가능하면 null 을 돌려준다.
// snap 을 넘기면 그 스냅샷을 재사용한다(같은 프레임 안의 여러 판정용).
function disabledReason(id, extra, snap) {
  if (!id) return null;
  const s = snap || snapshot();

  // 진행 중인 작업에서 빠져나오는 길은 항상 열려 있어야 한다 —
  // 다른 어떤 규칙보다 먼저 본다.
  if (REQUIRES_OPERATION.has(id)) {
    if (!s.op) return REASON.NO_OPERATION;
    if (s.busy) return REASON.BUSY;
    return null;
  }

  // 읽기 동작은 다른 작업이 도는 중에도, 저장소가 아니어도 그대로 통과시킨다 —
  // 복사/열기/보기 전환을 막을 이유가 없다. 첫 스캔이 끝나기 전에는 보여 줄 대상
  // 자체가 없으므로 그때만 막는다.
  if (isReadOnlyAction(id)) {
    return s.loading ? REASON.LOADING : null;
  }

  const base = baseReason(id, s);
  if (base) return base;

  if (s.op && (BLOCKED_DURING_OPERATION.has(id) || matchesPrefix(id, BLOCKED_DURING_OPERATION_PREFIXES))) {
    return s.opReason;
  }

  if (s.remotes === 0 && (REQUIRES_REMOTE.has(id) || matchesPrefix(id, REQUIRES_REMOTE_PREFIXES))) {
    return REASON.NO_REMOTE;
  }

  if (s.detached && (REQUIRES_CURRENT_BRANCH.has(id) || matchesPrefix(id, REQUIRES_CURRENT_BRANCH_PREFIXES))) {
    return REASON.DETACHED;
  }

  if (!s.upstream && REQUIRES_UPSTREAM.has(id)) return REASON.NO_UPSTREAM;

  if (REQUIRES_COMMIT_SELECTION.has(id) && !hasCommitSelection()) return REASON.NO_COMMIT;

  const rule = EXTRA_RULES[id];
  if (rule) return rule(s, extra);

  return null;
}

function isEnabled(id, extra, snap) {
  return disabledReason(id, extra, snap) === null;
}

// ── 같은 프레임 안에서 스냅샷 재사용 ──
// render 는 한 번 그릴 때 열 개 남짓한 버튼을 물어본다. 매번 새로 계산할 이유가 없다.
function context() {
  const s = snapshot();
  return {
    snapshot: s,
    isEnabled: (id, extra) => isEnabled(id, extra, s),
    disabledReason: (id, extra) => disabledReason(id, extra, s),
  };
}

// ── 실행 직전 게이트 ──
// 막힌 동작이면 사유를 알리고 false 를 돌려준다. 호출부는 false 면 그냥 돌아가면 된다.
//   - 다른 쓰기 작업이 도는 중이라면 창 타이틀의 진행 표시 옆에 잠깐 덧붙인다
//     (진행 메시지를 덮지 않기 위해서다)
//   - 그 밖의 사유는 힌트바에 토스트로 띄운다
function guardAction(id, extra) {
  const reason = disabledReason(id, extra);
  if (reason === null) return true;
  const spinner = require('./spinner');
  if (state.spinnerActive) spinner.flashBusy();
  else spinner.showToast(reason, 1600);
  return false;
}

// ── 메뉴 항목에 판정 결과 싣기 ──
// 호스트 menu.show 는 enabled:false 인 항목을 딤 처리하고 클릭을 무시한다.
// 호출부가 이미 enabled:false 로 잠근 항목은 건드리지 않는다.
// 자식이 전부 막힌 서브메뉴는 부모도 함께 막아, 열어 봐야 소용없는 메뉴를 남기지 않는다.
function decorateMenuItems(items, snap) {
  if (!Array.isArray(items)) return items;
  const s = snap || snapshot();
  for (const item of items) {
    if (!item || item.type === 'separator') continue;
    if (item.children) {
      decorateMenuItems(item.children, s);
      const actionable = item.children.filter(c => c && c.type !== 'separator' && c.id);
      if (item.enabled !== false && actionable.length > 0 && actionable.every(c => c.enabled === false)) {
        item.enabled = false;
        continue;
      }
    }
    if (item.enabled === false || !item.id) continue;
    if (disabledReason(item.id, null, s) !== null) item.enabled = false;
  }
  return items;
}

module.exports = {
  REASON,
  isReadOnlyAction,
  snapshot,
  context,
  isEnabled,
  disabledReason,
  guardAction,
  decorateMenuItems,
  selectedTargets,
  stageableTargets,
  unstageableTargets,
  allConflictChunksSelected,
  operationLabel,
};
