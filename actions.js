// ── 동작 활성/비활성 판정의 단일 출처 ──
//
// 배경: 차단 장치는 실행 직전의 guardWriteOp 하나뿐이었다. 그래서 커밋이 도는 동안에도
// Stage/Unstage/Checkout 버튼과 메뉴 항목이 평소와 똑같이 보였고, 눌러 봐야 "무시됐다"를
// 알 수 있었다. 게다가 기준이 "다른 쓰기 작업 중" 하나여서, rebase 진행 중 체크아웃처럼
// 논리적으로 성립하지 않는 조합은 그대로 통과해 git 이 뱉는 fatal 로만 드러났다.
//
// 여기서는 모든 동작을 한 표에 모아 "지금 가능한가 / 아니면 왜 안 되는가"를 한 곳에서
// 판정한다. 그 결과를 네 곳이 같이 쓴다:
//   1. render      — 버튼을 흐리게 그리고 hover 강조를 끈다 (actions.isEnabled)
//   2. menu 빌더    — 항목에 enabled:false 를 실어 호스트가 딤 처리하게 한다 (decorateMenuItems)
//   3. dispatch    — 실행 직전에 다시 막고 사유를 알린다 (guardAction)
//   4. 확인창의 실행 버튼 — 창이 떠 있는 사이 상황이 바뀌었는지 다시 본다
//                          (guardDeferredAction, 판정 범위는 startBlockedReason 참고)
// 화면 표시와 실제 차단이 같은 규칙을 보므로 "보이는데 안 된다"가 생길 수 없다.
//
// "다른 작업이 도는 중"의 판정은 자원 단위다. 예전에는 불리언 하나였고, 그래서
// 브랜치 리네임처럼 ref 만 옮기는 작업이 도는 동안에도 스테이징까지 함께 막혔다.
// 지금은 작업이 붙잡는 자원과 동작이 필요로 하는 자원이 겹칠 때만 막는다(SCOPE 참고).
//
// 규칙을 더할 때의 원칙:
//   - 기본은 차단이다. 여기 등록되지 않은 id 는 쓰기로 보고 공통 전제를 적용한다.
//     읽기 동작을 빠뜨리면 잠깐 과하게 막힐 뿐이지만, 쓰기를 통과시키면 작업이 겹친다.
//   - 자원도 마찬가지다. ACTION_SCOPES 에 적지 않은 동작은 전부를 필요로 한다고 본다.
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

// ── 자원 축 ──
// "무언가 돌고 있으니 전부 막는다"가 아니라 "겹치는 것만 막는다"로 판정하기 위한 축이다.
// 진행 중인 작업은 자기가 붙잡는 자원을(spinner.startSpinner 의 scopes),
// 동작은 자기가 필요로 하는 자원을(아래 ACTION_SCOPES) 밝히고, 둘이 겹칠 때만 막는다.
//
// 겹치지 않으면 git 도 서로를 방해하지 않는다 — `branch -m`/`fetch`/`push`/`config` 는
// .git/index.lock 을 잡지 않고, 상태 조회는 --no-optional-locks 로 돌린다.
const SCOPE = {
  INDEX: 'index',        // .git/index — 스테이징 영역
  WORKTREE: 'worktree',  // 작업 디렉터리의 파일 내용
  REFS: 'refs',          // 로컬 ref(HEAD 포함)와 reflog
  REMOTE: 'remote',      // 리모트, remote-tracking ref
  STASH: 'stash',        // refs/stash
  CONFIG: 'config',      // .git/config
};
const ALL_SCOPES = Object.freeze(Object.values(SCOPE));
const { INDEX, WORKTREE, REFS, REMOTE, STASH, CONFIG } = SCOPE;

// 자주 되풀이되는 묶음. 실행부(startSpinner 의 scopes)도 같은 이름으로 갈라 두었으므로
// 둘을 나란히 읽으면 동작과 작업이 같은 자원을 보고 있는지 바로 확인된다.
//   WORKTREE_IO  워킹트리 파일을 고치되 HEAD 는 그대로 (discard·clean·rm·패치 적용)
//   STASH_IO     워킹트리와 스태시 사이를 오간다 (stash push/pop/apply)
//   REWRITE      워킹트리를 갈아엎고 HEAD/ref 를 옮긴다 (체크아웃·머지·리셋·커밋·재작성)
//   PULL         REWRITE 에 리모트까지 (pull·fast-forward)
const WORKTREE_IO = [INDEX, WORKTREE];
const STASH_IO = [INDEX, WORKTREE, STASH];
const REWRITE = [INDEX, WORKTREE, REFS];
const REWRITE_WITH_STASH = [INDEX, WORKTREE, REFS, STASH];
const PULL = [INDEX, WORKTREE, REFS, REMOTE];

// ── 동작이 필요로 하는 자원 ──
// 여기 없는 id 는 전부 필요한 것으로 본다(ALL_SCOPES). 빠뜨리면 예전처럼 조금 과하게
// 막힐 뿐이지만, 실제보다 좁게 적으면 겹치는 작업이 함께 돌아 index.lock 을 다툰다.
//
// 대상 선정에 쓰는 자원도 포함해야 한다. 예를 들어 Unstage 는 인덱스만 고치지만,
// 무엇을 unstage 할지는 화면의 Staged 목록에서 고른다 — 커밋이 그 목록을 갈아엎는
// 동안 눌리면 이미 사라진 대상에 명령을 쏘게 되므로 커밋과 같은 INDEX 를 문다.
//
// ★ 여기에 좁게 적어도 되는 것은 "그 동작이 시작하는 작업도 같은 자원으로 등록될 때"
//    뿐이다(startSpinner 의 scopes). 동작만 좁고 작업이 전부를 붙잡으면, 좁은 판정을
//    통과해 시작된 전면 점유 작업이 이미 돌던 작업과 겹치고 — 그러면 끝낼 때 서로를
//    잘못 끝낸다.
//
//    한동안 커밋·체크아웃·머지·리베이스가 여기 없었던 것은 그 조건 때문이었다. 실행부가
//    scopes 를 넘기지 않았고 stopSpinner 도 인자 없이 불려, 겹치는 순간 서로의 작업을
//    끝냈다. 지금은 그 짝이 전부 맞춰져 있으므로(각 실행부가 startSpinner 의 반환값을
//    stopSpinner/updateSpinner/afterGitOp 에 그대로 넘긴다) 좁게 적을 수 있다.
//    새 동작을 좁게 적을 때도 같은 순서를 지켜야 한다: 실행부가 자원을 밝히고 op 을
//    끝까지 들고 다니는 것이 먼저, 표를 좁히는 것이 그다음이다.
//
//    반대 방향(동작이 작업보다 넓게 요구하는 것)은 안전하다 — 판정만 보수적이 된다.
//    push 가 그렇다: 동작은 [REMOTE, REFS]로 커밋과 겹치게 두고, 작업은 [REMOTE]만
//    붙잡아 push 가 도는 동안 커밋을 막지 않는다.
const ACTION_SCOPES = {
  // 인덱스만 — 워킹트리의 파일 내용은 그대로다
  stageAll: [INDEX], stageSelected: [INDEX],
  unstageAll: [INDEX], unstageSelected: [INDEX],
  file_stage: [INDEX], file_unstage: [INDEX], file_stage_all: [INDEX],
  'hunk-apply': [INDEX],
  // unlockIndex 는 여기 없다 — 삭제하려는 index.lock 은 인덱스를 만지는 명령이라면
  // 무엇이든 잡을 수 있다(checkout·merge·rebase·commit·discard). 자기 자원만 보고
  // 판정하면 워킹트리 작업이 도는 동안 그 작업의 락을 지우게 된다. 전부 붙잡은 것으로
  // 보고, 어떤 작업이든 끝난 뒤에만 연다.

  // 워킹트리의 파일을 고쳐 인덱스에 반영
  file_accept_ours: [INDEX, WORKTREE], file_accept_theirs: [INDEX, WORKTREE],
  // .gitignore 파일만 고친다
  file_ignore_name: [WORKTREE], file_ignore_ext: [WORKTREE], file_ignore_path: [WORKTREE],

  // 리모트만 — 로컬 인덱스·워킹트리를 건드리지 않는다
  'git-fetch': [REMOTE],
  // push 는 REMOTE 만 쓰는 것처럼 보이지만 무엇을 올릴지는 로컬 ref 를 읽어 정한다.
  // REFS 를 함께 적어야 커밋·리베이스·체크아웃(전부 REFS 를 옮긴다)이 도는 동안 막힌다 —
  // 그러지 않으면 커밋이 끝나기 전에 push 가 나가 방금 만든 커밋이 빠진 채로 올라간다.
  // 이 구조는 작업 큐가 아니라 즉시 실행이라, 순서는 자원 겹침으로만 표현할 수 있다.
  // (작업 쪽 scopes 는 [REMOTE] 그대로다 — push 가 도는 동안 커밋을 막을 이유는 없다.
  //  동작이 작업보다 넓게 요구하는 것은 안전한 방향이다: 판정만 보수적이 된다.)
  'git-push': [REMOTE, REFS], branch_push: [REMOTE, REFS], branch_push_pr: [REMOTE, REFS],
  branch_force_push: [REMOTE, REFS],
  remote_push_tags: [REMOTE, REFS],
  // 리모트 쪽 ref 만 지운다 — 올릴 로컬 ref 를 읽지 않는다
  branch_delete_remote: [REMOTE], remotebranch_delete_remote: [REMOTE],
  remote_prune: [REMOTE, REFS],

  // 로컬 ref 만
  branch_rename: [REFS, CONFIG],
  branch_delete: [REFS],
  new_tag: [REFS], branch_new_tag: [REFS],

  // 설정만
  branch_track: [CONFIG], branch_untrack: [CONFIG],
  'committer-name': [CONFIG], 'committer-email': [CONFIG],
  'reset-committer-name': [CONFIG], 'reset-committer-email': [CONFIG],
  remote_add: [CONFIG], remote_remove: [CONFIG], remote_set_url: [CONFIG],
  remote_rename: [CONFIG, REMOTE],

  // 스태시 목록만 — 저장/적용은 워킹트리를 오가므로 아래 STASH_IO 쪽이다
  stash_drop: [STASH], stash_rename: [STASH],

  // ── 워킹트리를 고치되 HEAD 는 그대로 ──
  // 인덱스를 읽어 잠그는 명령이 섞여 있어(`git checkout -- <path>`, `git rm`) INDEX 도 함께.
  file_discard: WORKTREE_IO,
  file_remove_keep: WORKTREE_IO, file_remove_delete: WORKTREE_IO,
  tab_discard_all: WORKTREE_IO, tab_clean: WORKTREE_IO,
  tab_apply_patch: WORKTREE_IO,
  cherry_pick_stage: WORKTREE_IO,
  // 충돌 해결 결과를 파일에 쓰고 인덱스에 얹는다
  'conflict-apply': WORKTREE_IO, 'merge-apply': WORKTREE_IO,

  // ── 워킹트리와 스태시 사이 ──
  'git-stash': STASH_IO, stash_apply: STASH_IO, file_stash_one: STASH_IO,

  // ── 커밋 ──
  // 인덱스를 트리로 굳히고 HEAD 를 옮긴다 — 워킹트리 파일은 그대로다. 그래서 커밋이
  // 도는 동안에도 fetch(리모트만 쓴다)는 열려 있다. WORKTREE 가 함께 있는 것은
  // 같은 [Commit] 버튼이 rebase 진행 중에는 `rebase --continue` 로 갈라지기 때문이다 —
  // 그쪽은 워킹트리까지 옮기므로, 두 갈래 중 넓은 쪽에 맞춰야 판정하지 않은 자원을
  // 점유하는 일이 없다.
  'commit-submit': REWRITE, 'commit-enter': REWRITE, 'commit-amend': REWRITE,
  amend_commit: REWRITE,

  // ── 진행 중인 작업에서 빠져나오기 ──
  // 인덱스·워킹트리·ref 를 되돌린다. 리모트는 건드리지 않으므로 fetch 와는 겹치지 않는다.
  'op-abort': REWRITE, 'op-skip': REWRITE, 'op-menu': REWRITE,

  // ── 워킹트리를 갈아엎고 HEAD 를 옮기는 것들 ──
  checkout: REWRITE, branch_checkout: REWRITE,
  remotebranch_checkout_local: REWRITE, remotebranch_checkout_tracking: REWRITE,
  merge: REWRITE, branch_merge_into: REWRITE,
  reset: REWRITE,
  cherry_pick: REWRITE, revert: REWRITE,
  reword_commit: REWRITE, squash_commit: REWRITE, fixup_commit: REWRITE,
  edit_commit: REWRITE, drop_commit: REWRITE,

  // 로컬 변경에 막히면 stash 로 비우고 다시 시도하는 길이 딸려 있다 — 그 재시도가
  // 스태시까지 건드리므로 여기서 미리 함께 요구한다(재시도는 새 작업으로 등록된다).
  new_branch: REWRITE_WITH_STASH,
  branch_new_branch: REWRITE_WITH_STASH, remotebranch_new_branch: REWRITE_WITH_STASH,
  rebase: REWRITE_WITH_STASH, branch_rebase_onto: REWRITE_WITH_STASH,

  // ── 리모트를 거쳐 워킹트리까지 옮긴다 ──
  'git-pull': PULL, branch_pull: PULL, branch_pull_rebase: PULL, branch_ff: PULL,

  // ── 별도 워크트리 ──
  // 다른 디렉터리를 만들고 지운다 — 지금 저장소의 인덱스도 워킹트리도 건드리지 않는다.
  worktree_new: [REFS, CONFIG], worktree_remove: [REFS, CONFIG],
  worktree_prune: [REFS],
};

const ACTION_SCOPE_PREFIXES = [
  // 올릴 대상을 로컬 ref 에서 읽는다 — 'git-push' 주석 참고
  ['push_to_remote:', [REMOTE, REFS]],
  ['tag_push:', [REMOTE, REFS]],
  ['tag_delete_remote:', [REMOTE]],
  ['tag_delete:', [REFS]],
  ['branch_track:', [CONFIG]],
];

function scopesOf(id) {
  const known = ACTION_SCOPES[id];
  if (known) return known;
  for (const [prefix, scopes] of ACTION_SCOPE_PREFIXES) {
    if (id.startsWith(prefix)) return scopes;
  }
  return ALL_SCOPES;
}

// 지금 이 동작과 자원이 겹치는 작업 — 없으면 null.
function busyBlocker(id, s) {
  if (s.ops.length === 0) return null;
  const need = scopesOf(id);
  return s.ops.find(op => (op.scopes || ALL_SCOPES).some(sc => need.includes(sc))) || null;
}

// 진행 중인 작업 목록. 자원을 밝히지 않은 채 진행 표시만 켜진 경로(스코프를 아직
// 지정하지 않은 호출부, 상태를 직접 세팅하는 테스트)는 무엇을 붙잡고 있는지 알 수
// 없으므로 전부 붙잡고 있다고 본다 — 판단이 불확실할 때는 막는 쪽이 안전하다.
const UNSCOPED_OP = Object.freeze({ label: '', scopes: ALL_SCOPES });
function activeOps() {
  const ops = Array.isArray(state.activeOps) ? state.activeOps : [];
  if (ops.length > 0) return ops;
  if (state.spinnerActive || state.settlingWrite) return [UNSCOPED_OP];
  return [];
}

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
  // 히스토리 Filter/Hide — 그리기 단계에서만 걸러 낸다. 저장소를 건드리지 않으므로
  // 다른 작업이 도는 중에도 열어 둔다(오히려 그때 그래프를 좁혀 보고 싶을 수 있다).
  'branch_filter', 'branch_hide', 'branch_clear_filters', 'branch_show_all',
  'remotebranch_filter', 'remotebranch_hide', 'remotebranch_clear_filters', 'remotebranch_show_all',
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
    // 진행 중인 작업 목록. git 명령이 도는 동안(running)만이 아니라, 그 결과를 다시
    // 읽어오는 뒷정리 갱신이 끝날 때까지(settling) 한 동작으로 남는다. 창 타이틀도
    // 그동안 계속 "Committing..."을 보여 주므로, 여기서 풀어 버리면 "끝났다는 말이
    // 없는데 버튼은 살아 있는" 상태가 되고, 실제로도 커밋 직전의 낡은 목록에 대고
    // 명령을 쏘게 된다. 다만 막는 대상은 그 작업과 자원이 겹치는 동작뿐이다 —
    // 리네임(ref)이 도는 동안 스테이징(index)까지 세울 이유는 없다.
    ops: activeOps(),
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
//
// 예전에는 수기 목록이었고, 그래서 나중에 추가된 동작이 줄줄이 빠져 있었다 —
// push, 태그 만들기·지우기, 원격 브랜치 삭제, 스태시 정리는 인덱스와 아무 상관이
// 없는데도 락이 걸린 동안 함께 막혔다. 자원 표에 이미 답이 있으므로 거기서 유도한다.
// 목록이 하나 줄고, 앞으로 자원을 적어 두기만 하면 여기는 저절로 맞는다.
//
// 예외 둘:
//   - unlockIndex 는 락을 지우는 자신이다. 자원상 INDEX 를 요구하지만 락이 있을 때만
//     의미가 있으므로 여기서 통과시켜야 빠져나올 수 있다.
//   - 저장소를 바꾸는 길은 지금 저장소의 락과 무관하다. 이걸 막으면 락이 걸린 저장소에
//     갇힌다.
const REPO_SWITCH_ACTIONS = new Set(['tab_change_repo', 'tab_clone', 'worktree_open']);

function isIndexFree(id) {
  if (id === 'unlockIndex' || REPO_SWITCH_ACTIONS.has(id)) return true;
  return !scopesOf(id).includes(INDEX);
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
  if (busyBlocker(id, s)) return REASON.BUSY;
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
    if (busyBlocker(id, s)) return REASON.BUSY;
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

// ── 확인창을 거쳐 미뤄진 동작의 재검사 ──
// 확인 다이얼로그를 여는 시점에 이미 전체 판정을 통과했고, 무엇에 대고 실행할지도
// 그때 정해져 화면과 무관하게 pending 상태로 보관된다. 확인 버튼을 누르기까지 사이에
// 달라질 수 있는 것은 "지금 시작해도 되는 상황인가"뿐이다 — 로딩, 인덱스 잠금,
// 진행 중인 작업, 자원 겹침. 그래서 그 축만 다시 본다.
//
// 대상 조건(EXTRA_RULES, 커밋 선택)까지 다시 보면 안 된다. 다이얼로그가 들고 있는
// 대상이 아니라 지금 화면의 선택을 보게 되어, 멀쩡히 확정된 작업이 "선택된 파일이
// 없다"로 막힌다.
// opts.allowDuringOperation: 진행 중인 작업을 스스로 걷어내고 다시 시도하는 길
// (중단된 rebase 를 abort 하고 재시도)에는 그 작업을 이유로 막으면 안 된다 —
// 막으면 빠져나올 방법이 사라진다. 자원 겹침과 나머지 전제는 그대로 본다.
function startBlockedReason(id, snap, opts) {
  if (!id) return null;
  const s = snap || snapshot();

  if (REQUIRES_OPERATION.has(id)) {
    if (!s.op) return REASON.NO_OPERATION;
    if (busyBlocker(id, s)) return REASON.BUSY;
    return null;
  }

  if (isReadOnlyAction(id)) {
    return s.loading ? REASON.LOADING : null;
  }

  const base = baseReason(id, s);
  if (base) return base;

  const allowOp = !!(opts && opts.allowDuringOperation);
  if (!allowOp && s.op && (BLOCKED_DURING_OPERATION.has(id) || matchesPrefix(id, BLOCKED_DURING_OPERATION_PREFIXES))) {
    return s.opReason;
  }

  return null;
}

// ── 실행 직전 게이트 ──
// 막힌 동작이면 사유를 알리고 false 를 돌려준다. 호출부는 false 면 그냥 돌아가면 된다.
//   - 다른 쓰기 작업이 도는 중이라면 창 타이틀의 진행 표시 옆에 잠깐 덧붙인다
//     (진행 메시지를 덮지 않기 위해서다)
//   - 그 밖의 사유는 힌트바에 토스트로 띄운다
function reportBlocked(reason) {
  const spinner = require('./spinner');
  if (state.spinnerActive) spinner.flashBusy();
  else spinner.showToast(reason, 1600);
  return false;
}

function guardAction(id, extra) {
  const reason = disabledReason(id, extra);
  if (reason === null) return true;
  return reportBlocked(reason);
}

// 확인창의 실행 버튼을 눌렀을 때의 게이트 — 판정 범위는 startBlockedReason 참고.
function guardDeferredAction(id, opts) {
  const reason = startBlockedReason(id, null, opts);
  if (reason === null) return true;
  return reportBlocked(reason);
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
  SCOPE,
  ALL_SCOPES,
  ACTION_SCOPES,
  scopesOf,
  isReadOnlyAction,
  snapshot,
  context,
  isEnabled,
  disabledReason,
  startBlockedReason,
  guardAction,
  guardDeferredAction,
  decorateMenuItems,
  selectedTargets,
  stageableTargets,
  unstageableTargets,
  allConflictChunksSelected,
  operationLabel,
};
