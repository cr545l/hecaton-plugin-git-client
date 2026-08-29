const {
  state, ui, isPinnedBranch, togglePinnedBranch, unpinBranch, renamePinnedBranch,
  localRefKey, remoteRefKey, isFilteredRef, isHiddenRef, toggleFilteredRef, toggleHiddenRef,
  clearFilteredRefs, clearHiddenRefs, forgetRef, renameRef,
} = require('./state');
function baseName(p) { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return s.substring(s.lastIndexOf('/') + 1); }
function extName(p) { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.substring(i); }
function joinPath(...parts) { return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/'); }
const {
  gitCherryPick, gitRevert, gitCheckoutRef,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitMergeContinue, gitMergeAbort, gitCherryPickContinue, gitCherryPickAbort, gitCherryPickSkip,
  gitRevertContinue, gitRevertAbort, gitRevertSkip,
  gitStashApply, gitStashDrop, gitStashSave, gitStashPop, gitStashRename,
  gitStageAll, gitDiscardFile, gitRemoveFromRepo,
  gitStashFile, gitStashFiles, gitIgnorePattern, gitFileHistory, gitBlameFile, gitFilePatch,
  gitSetConfig, gitCreateBranch, gitCreateTag, gitRemoteAdd,
  gitRenameBranch, gitDeleteBranch, gitSetUpstream, gitUnsetUpstream, gitGetRemoteUrl,
  gitMergeAsync, gitRebaseAsync, gitResetAsync, gitCheckoutRefAsync,
  gitCherryPickAsync, gitCherryPickNoCommitAsync, gitRevertAsync, gitStashSaveAsync, gitStashPopAsync,
  gitStageAsync, gitUnstageAsync, gitStageMultiple, gitUnstageMultiple,
  gitMergeFastForwardAsync, gitPushToRemoteAsync, gitPushHeadToBranchAsync, gitPullFromRemoteAsync, gitFetchIntoBranchAsync,
  gitCheckRebaseConflicts, gitIsRebaseNoop,
  gitCheckoutOurs, gitCheckoutTheirs, gitCommitMessage,
  gitExec, gitResetModeAsync, gitRewordCommitAsync, gitSquashIntoParentAsync,
  gitDropCommitAsync, gitEditCommitAsync,
  gitPullRebaseAsync, gitForcePushAsync, gitPushDeleteBranchAsync,
  gitPushTagsAsync, gitPushTagAsync, gitPushDeleteTagAsync,
  gitRemoteRemove, gitRemoteRename, gitRemoteSetUrl, gitRemotePruneAsync,
  gitDeleteTag, gitCreateTagAnnotated, gitApplyPatchFromText,
  gitWorktreeAdd, gitWorktreeRemove, gitWorktreePruneAsync, gitBranchExists,
  gitInit, gitCloneAsync, gitCleanUntrackedAsync, gitDiscardAllChangesAsync,
  resolveWorkTreeRoot, splitUpstreamRef,
} = require('./git');
const { refreshAsync, refreshLog, rebuildLogGraphRows, selectedLogRef, updateLogDetail, refreshFresh, updateFreshDetail, updateDiff, refreshInBackground, applyStageToState, applyUnstageToState, removeIndexLock, invalidateCommitterCache } = require('./refresh');
const { render } = require('./render');
const { startSpinner, updateSpinner, stopSpinner } = require('./spinner');
// read/write 분류와 상황별 가능 여부 판정은 actions.js 한 곳에 모여 있다.
// 메뉴를 만들 때(decorateMenuItems)와 실행할 때(guardAction)가 같은 표를 보므로,
// "메뉴에선 살아 있는데 눌러도 안 되는" 어긋남이 생기지 않는다.
const { guardAction, guardDeferredAction, decorateMenuItems, operationLabel, SCOPE } = require('./actions');
// 이 작업이 무엇을 붙잡는지 startSpinner 에 함께 넘긴다 — 넘기지 않으면 예전처럼
// 전부 붙잡은 것으로 보고 모든 쓰기를 막는다(보수적 기본값).
const { INDEX, WORKTREE, REFS, REMOTE, STASH, CONFIG } = SCOPE;

// ── 자주 쓰는 자원 묶음 ──
// 같은 성격의 작업이 같은 값을 보게 묶어 둔다. 한 곳만 고쳐도 전부 따라오고,
// 어떤 작업이 무엇을 붙잡는지 이름으로 읽힌다.
//
// CHECKOUT_SCOPES: 워킹트리를 갈아엎고 HEAD/ref 를 옮기는 것들 — 체크아웃, 머지,
//   리베이스, 리셋, cherry-pick, revert, 히스토리 재작성. 인덱스도 함께 다시 쓰인다.
// WORKTREE_SCOPES: 워킹트리의 파일만 되돌리거나 지운다 — discard, clean, rm.
//   `git checkout -- <path>` 계열은 인덱스를 읽어 잠그므로 INDEX 도 함께 잡는다.
// STASH_SCOPES: 워킹트리와 스태시 사이를 오간다 — stash push/pop/apply.
// PULL_SCOPES: 위에 더해 리모트까지 — pull 은 fetch 와 merge/rebase 를 한 번에 한다.
const CHECKOUT_SCOPES = [INDEX, WORKTREE, REFS];
const WORKTREE_SCOPES = [INDEX, WORKTREE];
const STASH_SCOPES = [INDEX, WORKTREE, STASH];
const PULL_SCOPES = [INDEX, WORKTREE, REFS, REMOTE];
// stash 로 워킹트리를 비우고 → 옮기고 → 되돌리는 다단계 작업. 세 단계가 차례로
// 네 자원을 건드리므로 처음부터 넷 다 붙잡은 채로 간다.
const STASH_REWRITE_SCOPES = [INDEX, WORKTREE, REFS, STASH];

// 커밋 하나에 달린 태그 수만큼 서브메뉴가 늘어나므로 상한을 둔다.
// 배경은 REF_INLINE_MAX 주석과 test/menu-payload.test.js 참고.
const HISTORY_TAG_MAX = 3;

function historyBranchEntries() {
  return state.branches
    .filter(b => !b.isCurrent)
    .map(b => ({ id: 'checkout_branch:' + b.name, label: b.name }));
}

function buildHistoryContextMenuItems() {
  const branch = state.branch || 'HEAD';

  // Branch submenu — 브랜치가 적을 때만 자식으로 붙인다. 많으면 별도 메뉴로 넘겨
  // payload가 저장소 크기를 따라 커지지 않게 한다(예전 slice(0, 20)은 21번째부터
  // 아예 닿을 수 없었다).
  const branchChildren = historyBranchEntries();

  const items = [];

  if (branchChildren.length > REF_INLINE_MAX) {
    items.push({ id: 'history_branch_open', label: branch, icon: 'git-branch' });
  } else if (branchChildren.length > 0) {
    items.push({
      id: 'branches_submenu',
      label: branch,
      icon: 'git-branch',
      children: branchChildren,
    });
  }

  items.push(
    { type: 'separator' },
    { id: 'new_branch', label: 'New Branch...', icon: 'add' },
    { id: 'new_tag', label: 'New Tag...', icon: 'add' },
    { type: 'separator' },
    { id: 'merge', label: "Merge into '" + branch + "'..." },
    { id: 'rebase', label: "Rebase '" + branch + "' to Here..." },
    { id: 'reset', label: "Reset '" + branch + "' to Here...", icon: 'warning' },
    { type: 'separator' },
    { id: 'checkout', label: 'Checkout Commit...' },
    { id: 'cherry_pick', label: 'Cherry-pick Commit...' },
    { id: 'revert', label: 'Revert Commit...' },
    { id: 'save_patch', label: 'Save as Patch...', icon: 'save' },
    { type: 'separator' },
    { id: 'amend_commit', label: 'Amend Last Commit...' },
    {
      id: 'interactive_rebase',
      label: 'Interactive Rebase',
      children: [
        { id: 'reword_commit', label: 'Edit Message...' },
        { id: 'squash_commit', label: 'Squash into Parent...' },
        { id: 'fixup_commit', label: 'Fixup into Parent...' },
        { id: 'edit_commit', label: 'Edit Commit (Stop Here)...' },
        { id: 'drop_commit', label: 'Drop Commit...', icon: 'warning' },
      ],
    },
    { type: 'separator' },
  );

  // 선택한 커밋에 태그가 달려 있으면 태그 관리 서브메뉴 노출
  const selectedItem = selectedLogRef();
  const tagRemote = state.remotes[0] || 'origin';
  if (selectedItem && selectedItem.decoration) {
    const tagRe = /tag: ([^,)]+)/g;
    let tagMatch;
    let tagCount = 0;
    while ((tagMatch = tagRe.exec(selectedItem.decoration))) {
      // 한 커밋에 태그가 몰려 있어도 메뉴 뒤쪽(Copy Commit SHA 등)을 밀어내면 안 된다.
      if (++tagCount > HISTORY_TAG_MAX) break;
      const tagName = tagMatch[1].trim();
      items.push({
        id: 'tag_menu:' + tagName,
        label: "Tag '" + tagName + "'",
        icon: 'tag',
        children: [
          { id: 'tag_push:' + tagName, label: "Push to '" + tagRemote + "'" },
          { id: 'tag_delete:' + tagName, label: 'Delete...', icon: 'warning' },
          { id: 'tag_delete_remote:' + tagName, label: "Delete on '" + tagRemote + "'...", icon: 'warning' },
        ],
      });
    }
  }

  items.push(
    { id: 'copy_sha', label: 'Copy Commit SHA', icon: 'copy', shortcut: 'Ctrl+C' },
    { id: 'copy_info', label: 'Copy Commit Info', icon: 'copy', shortcut: 'Ctrl+Shift+C' },
  );

  return decorateMenuItems(items);
}

function buildStashContextMenuItems(stashRef, stashMessage) {
  const label = stashMessage ? "'" + stashMessage + "'" : stashRef;
  const items = [
    { id: 'stash_apply', label: 'Apply ' + label + '...', icon: 'add' },
    { id: 'stash_rename', label: 'Rename ' + label + '...' },
    { id: 'stash_drop', label: 'Delete ' + label + '...', icon: 'warning', shortcut: 'Delete' },
    { type: 'separator' },
    { id: 'stash_compare', label: 'Compare to Local Changes' },
    { type: 'separator' },
    { id: 'stash_copy_sha', label: 'Copy Commit SHA', icon: 'copy', shortcut: 'Ctrl+C' },
    { id: 'stash_copy_info', label: 'Copy Commit Info', icon: 'copy', shortcut: 'Ctrl+Shift+C' },
  ];
  return decorateMenuItems(items);
}

function isConflictFile(item) {
  return item && item.status === 'U';
}

function buildFileContextMenuItems(fileItem, fileItems) {
  if (!fileItem || !fileItem.file) return [];

  const targets = Array.isArray(fileItems) && fileItems.length > 0 ? fileItems : [fileItem];
  const canStage = targets.some((item) => item && item.type !== 'staged');
  const canUnstage = targets.some((item) => item && item.type === 'staged');
  // untracked 파일은 추적 대상이 아니므로 버전관리 제외 불가
  const canRemoveFromRepo = targets.some((item) => item && item.type !== 'untracked');

  const items = [
    { id: 'file_open', label: 'Open' },
    {
      id: 'file_external_diff',
      label: 'External Diff',
      children: [
        { id: 'file_external_diff_head', label: 'Compare with HEAD' },
        { id: 'file_external_diff_index', label: 'Compare with Index' },
      ],
    },
    { id: 'file_show_in_explorer', label: 'Show in Explorer' },
    { type: 'separator' },
    { id: 'file_blame', label: 'Blame/Timeline...' },
    { id: 'file_history', label: 'History...' },
    { type: 'separator' },
    { id: 'file_stage', label: 'Stage', enabled: canStage },
    { id: 'file_unstage', label: 'Unstage', enabled: canUnstage },
    { id: 'file_discard', label: 'Discard changes...', icon: 'warning' },
    {
      id: 'file_remove',
      label: 'Remove from Version Control',
      enabled: canRemoveFromRepo,
      children: [
        { id: 'file_remove_keep', label: 'Keep Local File...' },
        { id: 'file_remove_delete', label: 'Delete Local File...', icon: 'warning' },
      ],
    },
    ...(isConflictFile(fileItem) ? [
      { type: 'separator' },
      { id: 'file_accept_ours', label: 'Accept Ours (HEAD)' },
      { id: 'file_accept_theirs', label: 'Accept Theirs (Incoming)' },
    ] : []),
    { id: 'file_stage_all', label: 'Stage All' },
    {
      id: 'file_ignore',
      label: 'Ignore',
      children: [
        { id: 'file_ignore_name', label: 'Ignore by Name' },
        { id: 'file_ignore_ext', label: 'Ignore by Extension' },
        { id: 'file_ignore_path', label: 'Ignore by Path' },
      ],
    },
    { id: 'file_stash_one', label: 'Stash ' + targets.length + ' File' + (targets.length > 1 ? 's' : '') + '...' },
    { id: 'file_save_patch', label: 'Save as Patch...', icon: 'save' },
    { type: 'separator' },
    { id: 'file_copy_path', label: 'Copy Path', icon: 'copy' },
    { id: 'file_copy_full_path', label: 'Copy Full Path', icon: 'copy' },
    { type: 'separator' },
    { id: 'file_open_explorer', label: 'Open in File Explorer', icon: 'folder-opened' },
  ];

  return decorateMenuItems(items);
}

function buildTabContextMenuItems() {
  const hasLocalChanges = state.staged.length > 0 || state.unstaged.length > 0 || state.untracked.length > 0;
  const items = [
    { id: 'tab_refresh', label: 'Refresh' },
    { type: 'separator' },
    { id: 'tab_apply_patch', label: 'Apply Patch from Clipboard...' },
    { id: 'tab_discard_all', label: 'Discard All Changes...', icon: 'warning', enabled: hasLocalChanges },
    { id: 'tab_clean', label: 'Remove All Untracked Files...', icon: 'warning' },
    { type: 'separator' },
    { id: 'tab_change_repo', label: 'Change Repository...' },
    { id: 'tab_clone', label: 'Clone Repository...' },
  ];
  if (!state.isGitRepo) {
    items.push({ id: 'tab_init', label: 'Init Repository Here' });
  }
  return decorateMenuItems(items);
}

function buildWorktreeContextMenuItems(wtPath) {
  const wt = wtPath ? state.worktrees.find(w => w.path === wtPath) : null;
  const items = [];
  if (wt && !wt.isCurrent) {
    items.push({ id: 'worktree_open', label: 'Open in This Window' });
  }
  items.push({ id: 'worktree_new', label: 'New Worktree...', icon: 'add' });
  items.push({ type: 'separator' });
  if (wt && !wt.isCurrent && !wt.isBare) {
    items.push({ id: 'worktree_remove', label: "Remove '" + baseName(wt.path) + "'...", icon: 'warning' });
  }
  items.push({ id: 'worktree_prune', label: 'Prune Worktrees' });
  if (wt) {
    // 목록에 절대경로를 표시하지 않으므로 경로 확인/이동은 여기서 한다.
    items.push({ type: 'separator' });
    items.push({ id: 'worktree_show_in_explorer', label: 'Show in Explorer' });
    items.push({ id: 'worktree_open_explorer', label: 'Open in File Explorer', icon: 'folder-opened' });
    items.push({ id: 'worktree_copy_path', label: 'Copy Path', icon: 'copy' });
  }
  return decorateMenuItems(items);
}

// 호스트 menu.show는 한 번에 받을 수 있는 항목 수에 한계가 있고, 넘치면 뒤쪽 항목을
// 조용히 버린다 — 에러도 없고 잘렸다는 표시도 없다. 그래서 저장소 크기를 따라 커지는
// 목록(리모트 추적 브랜치 등)을 그대로 실으면, 그 뒤에 오는 항목이 통째로 사라진다.
//
// 실제로 리모트 추적 브랜치 45개짜리 저장소에서 브랜치 메뉴가 Tracking에서 정확히 끊겨
// Pin / Copy Branch Name이 나오지 않았다. 창을 키워도, 클릭 위치를 바꿔도 같았다
// (메뉴 아래에 빈 공간이 남는데도 끊겼다 — 높이 때문이 아니다). 리모트가 2개인 저장소는
// 같은 메뉴가 끝까지 나온다. 평탄화 22항목/1.2KB는 정상, 59항목/4.5KB에서 잘렸다.
//
// 따라서 규칙은 하나다: 한 번의 menu.show payload가 저장소 크기를 따라 커지면 안 된다.
// history 메뉴의 브랜치 서브메뉴도 같은 이유로 slice(0, 20)을 쓰고 있었지만, 자르는
// 방식은 21번째부터 아예 닿을 수 없어 아래 페이지 방식으로 바꿨다.
const REF_INLINE_MAX = 8;   // 서브메뉴로 직접 붙일 수 있는 최대 항목 수
const REF_PAGE_SIZE = 15;   // 별도 메뉴로 넘길 때 한 페이지에 싣는 항목 수

// 저장소 크기를 따라 커지는 목록을 별도 메뉴로 낼 때 쓴다. 한 페이지 항목 수를 고정하고
// 나머지는 Previous/More로 넘겨, 목록이 아무리 길어도 payload가 일정하게 유지된다.
// (예전처럼 slice로 잘라 버리면 뒤쪽 항목에는 아예 닿을 수 없다.)
function buildPagedRefMenu({ titleId, title, entries, page, pagePrefix, tail }) {
  const lastPage = Math.max(0, Math.ceil(entries.length / REF_PAGE_SIZE) - 1);
  const pageIdx = Math.min(Math.max(page || 0, 0), lastPage);
  const start = pageIdx * REF_PAGE_SIZE;
  const slice = entries.slice(start, start + REF_PAGE_SIZE);
  const paged = entries.length > REF_PAGE_SIZE;

  const items = [{
    id: titleId,
    label: title + (paged ? '  (' + (start + 1) + '-' + (start + slice.length) + ' / ' + entries.length + ')' : ''),
    enabled: false,
  }];
  for (const entry of slice) items.push(entry);

  if (paged) {
    items.push({ type: 'separator' });
    if (pageIdx > 0) items.push({ id: pagePrefix + (pageIdx - 1), label: 'Previous...' });
    if (start + slice.length < entries.length) items.push({ id: pagePrefix + (pageIdx + 1), label: 'More...' });
  }
  for (const item of (tail || [])) items.push(item);
  return decorateMenuItems(items);
}

// 업스트림 후보를 쓸모 있는 순서로 놓는다 — 지금 업스트림, 같은 이름의 리모트 브랜치,
// 나머지 순. 목록을 페이지로 나눠야 하므로 정작 필요한 항목이 뒤로 밀리면 안 된다.
function orderedTrackingRefs(branchName, upstream) {
  const sameName = [];
  const rest = [];
  let current = null;
  for (const rb of state.remoteBranches) {
    if (rb === upstream) { current = rb; continue; }
    const slashIdx = rb.indexOf('/');
    const shortName = slashIdx >= 0 ? rb.substring(slashIdx + 1) : rb;
    if (shortName === branchName) sameName.push(rb);
    else rest.push(rb);
  }
  return (current ? [current] : []).concat(sameName, rest);
}

function trackingEntry(rb, upstream) {
  return { id: 'branch_track:' + rb, label: rb + (rb === upstream ? ' (current)' : '') };
}

// 리모트가 많을 때 브랜치 메뉴 대신 따로 여는 Tracking 메뉴.
function buildBranchTrackingMenuItems(branchName, page) {
  const branch = state.branches.find(b => b.name === branchName);
  if (!branch) return [];
  const upstream = branch.upstream;
  return buildPagedRefMenu({
    titleId: 'branch_tracking_title',
    title: "Set upstream of '" + branchName + "' to:",
    entries: orderedTrackingRefs(branchName, upstream).map(rb => trackingEntry(rb, upstream)),
    page,
    pagePrefix: 'branch_tracking_page:',
    tail: upstream ? [{ type: 'separator' }, { id: 'branch_untrack', label: 'Unset Upstream' }] : [],
  });
}

// 브랜치가 많을 때 history 메뉴의 브랜치 서브메뉴 대신 따로 여는 체크아웃 메뉴.
function buildHistoryBranchMenuItems(page) {
  return buildPagedRefMenu({
    titleId: 'history_branch_title',
    title: 'Checkout branch:',
    entries: historyBranchEntries(),
    page,
    pagePrefix: 'history_branch_page:',
  });
}

// 히스토리 Filter/Hide 묶음 — 로컬/리모트 브랜치 메뉴가 같은 모양으로 쓴다.
// idPrefix 만 다르다(핸들러가 actionId 앞머리로 대상을 가른다).
//
// 전체 해제 항목은 지정이 하나라도 있을 때만 낸다. 이 기능의 상태는 좌측 목록의 색으로만
// 드러나는데, 필터를 걸어 둔 브랜치가 접힌 그룹 안에 있으면 그마저 안 보인다 — 아무
// 브랜치나 우클릭해서 빠져나올 길이 항상 있어야 한다.
// allowHide=false 면 Hide 를 빼고 낸다(현재 브랜치. 지금 체크아웃한 것을 감추는 건
// 의미가 없고, 그래프에서 HEAD 가 사라져 어디에 있는지 알 수 없게 된다).
function buildRefFilterMenuItems(idPrefix, refKey, label, allowHide) {
  const items = [{ type: 'separator' }];
  items.push(isFilteredRef(refKey)
    ? { id: idPrefix + 'filter', label: "Unfilter '" + label + "'" }
    : { id: idPrefix + 'filter', label: "Filter '" + label + "'" });
  if (allowHide) {
    items.push(isHiddenRef(refKey)
      ? { id: idPrefix + 'hide', label: "Unhide '" + label + "'" }
      : { id: idPrefix + 'hide', label: "Hide '" + label + "'" });
  }
  if (ui.filteredRefs.length > 0) {
    items.push({ id: idPrefix + 'clear_filters', label: 'Clear All Filters (' + ui.filteredRefs.length + ')' });
  }
  if (ui.hiddenRefs.length > 0) {
    items.push({ id: idPrefix + 'show_all', label: 'Show All Branches (' + ui.hiddenRefs.length + ')' });
  }
  return items;
}

function buildBranchContextMenuItems(branchName) {
  const branch = state.branches.find(b => b.name === branchName);
  if (!branch) return [];

  const upstream = branch.upstream;
  const remote = upstream ? upstream.split('/')[0] : (state.remotes[0] || 'origin');
  const items = [];

  if (!branch.isCurrent) {
    items.push({ id: 'branch_checkout', label: "Checkout '" + branchName + "'" });
    items.push({ id: 'branch_rebase_onto', label: "Rebase current onto '" + branchName + "'" });
    items.push({ id: 'branch_merge_into', label: "Merge '" + branchName + "' into current" });
  }

  // 받아오기 계열은 결과가 HEAD에 들어간다 — merge도 pull도 "어디로"를 고를 수 없다.
  // 그래서 체크아웃하지 않은 브랜치에 Pull을 그대로 실행하면 엉뚱하게 현재 브랜치를
  // 건드리고, 현재 브랜치가 이미 그 커밋들을 담고 있으면 'Already up to date'로 종료 코드
  // 0을 돌려줘 "눌러도 아무 일도 안 일어난다"로 보인다.
  // 항목은 그대로 두되(의도는 "그 브랜치를 최신으로"가 맞다), 실행 시 어떤 명령으로
  // 대신할지 고르게 한다 — showPullOtherBranchDialog 참고.
  if (upstream) {
    items.push(
      { id: 'branch_ff', label: "Fast-Forward to '" + upstream + "'" },
      { id: 'branch_pull', label: "Pull '" + upstream + "'..." },
      { id: 'branch_pull_rebase', label: "Pull '" + upstream + "' with Rebase..." },
    );
  }

  if (remote) {
    items.push(
      { id: 'branch_push', label: "Push '" + branchName + "' to '" + remote + "'..." },
      { id: 'branch_push_pr', label: "Push and Create Pull Request on '" + remote + "'..." },
      { id: 'branch_force_push', label: "Force Push '" + branchName + "' to '" + remote + "'...", icon: 'warning' },
    );
  }
  // 이름 바꾸기/삭제는 push 묶음 바로 아래에 둔다. 호스트 menu.show는 위치·스크롤 옵션이
  // 없어 창보다 긴 메뉴는 아래가 잘려 나간다 — 맨 끝에 두면 작은 창에서 아예 닿지 못한다.
  // 삭제 둘은 붙여 두되 로컬을 먼저 둬서, 위에서부터 만나는 첫 "Delete '...'"가 항상
  // 로컬이 되게 한다(원격 push --delete를 로컬 삭제로 오인하는 사고 방지).
  items.push({ type: 'separator' });
  items.push({ id: 'branch_rename', label: "Rename '" + branchName + "'...", shortcut: 'F2' });
  if (!branch.isCurrent) {
    items.push({ id: 'branch_delete', label: "Delete '" + branchName + "' (local)...", shortcut: 'Delete' });
  }
  if (upstream) {
    items.push({ id: 'branch_delete_remote', label: "Delete on Remote: '" + upstream + "'...", icon: 'warning' });
  }

  items.push({ type: 'separator' });
  items.push(
    { id: 'branch_new_branch', label: 'New Branch...', shortcut: 'Ctrl+Shift+B' },
    { id: 'branch_new_tag', label: 'New Tag...', shortcut: 'Ctrl+Shift+T' },
  );
  // Worktrees 노드는 linked worktree가 있을 때만 보이므로, 첫 워크트리를 만들 진입점을
  // 브랜치 메뉴에도 둔다. worktree_new는 대상 경로를 쓰지 않아 여기서도 안전하다.
  items.push({ id: 'worktree_new', label: 'New Worktree...' });

  // 리모트가 적을 때만 서브메뉴로 붙인다. 많으면 별도 메뉴로 넘겨 payload가 저장소
  // 크기를 따라 커지지 않게 한다 — 그러지 않으면 아래 Pin / Copy Branch Name이 잘린다.
  const trackingChildren = orderedTrackingRefs(branchName, upstream).map(rb => trackingEntry(rb, upstream));
  if (upstream) {
    trackingChildren.push({ type: 'separator' });
    trackingChildren.push({ id: 'branch_untrack', label: 'Unset Upstream' });
  }
  if (trackingChildren.length > REF_INLINE_MAX) {
    items.push({ id: 'branch_tracking_open', label: 'Tracking...' });
  } else if (trackingChildren.length > 0) {
    items.push({ id: 'branch_tracking', label: 'Tracking', children: trackingChildren });
  }

  items.push({ type: 'separator' });
  items.push(isPinnedBranch(branchName)
    ? { id: 'branch_pin', label: "Unpin '" + branchName + "'", icon: 'pinned' }
    : { id: 'branch_pin', label: "Pin '" + branchName + "'", icon: 'pin' });

  for (const item of buildRefFilterMenuItems('branch_', localRefKey(branchName), branchName, !branch.isCurrent)) {
    items.push(item);
  }

  items.push({ type: 'separator' });
  items.push({ id: 'branch_copy_name', label: 'Copy Branch Name' });

  return decorateMenuItems(items);
}

function buildPullRequestUrl(remoteUrl, branch) {
  if (!remoteUrl) return null;
  let match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (match) return 'https://github.com/' + match[1] + '/pull/new/' + encodeURIComponent(branch);
  match = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
  if (match) return 'https://gitlab.com/' + match[1] + '/-/merge_requests/new?merge_request[source_branch]=' + encodeURIComponent(branch);
  match = remoteUrl.match(/bitbucket\.org[:/](.+?)(?:\.git)?$/);
  if (match) return 'https://bitbucket.org/' + match[1] + '/pull-requests/new?source=' + encodeURIComponent(branch);
  return null;
}

function buildRemotesContextMenuItems(remoteName) {
  const mode = ui.remoteSortMode || 'alpha';
  const items = [
    { id: 'remote_add', label: 'Add New Remote...' },
  ];
  if (remoteName) {
    items.push(
      { type: 'separator' },
      { id: 'remote_prune', label: "Prune '" + remoteName + "'" },
      { id: 'remote_push_tags', label: "Push All Tags to '" + remoteName + "'..." },
      { id: 'remote_rename', label: "Rename '" + remoteName + "'..." },
      { id: 'remote_set_url', label: "Change URL of '" + remoteName + "'..." },
      { id: 'remote_copy_url', label: 'Copy URL', icon: 'copy' },
      { id: 'remote_remove', label: "Remove '" + remoteName + "'...", icon: 'warning' },
    );
  }
  items.push(
    { type: 'separator' },
    { id: 'remote_sort_title', label: 'Sort Branches:', enabled: false },
    { id: 'remote_sort_alpha', label: 'Alphabetically', checked: mode === 'alpha' },
    { id: 'remote_sort_alpha_desc', label: 'Alphabetically backward', checked: mode === 'alpha_desc' },
    { id: 'remote_sort_recent', label: 'Recently used', checked: mode === 'recent' },
  );
  return decorateMenuItems(items);
}

function buildPushRemoteMenuItems() {
  const currentBranch = state.branches.find(b => b.isCurrent) || state.branches.find(b => b.name === state.branch);
  const upstream = currentBranch ? currentBranch.upstream : '';
  const upstreamRemote = upstream ? upstream.split('/')[0] : '';
  const branchLabel = currentBranch ? currentBranch.name : (state.branch || 'HEAD');
  const items = [
    { id: 'push_remote_title', label: "Push '" + branchLabel + "' to:", enabled: false },
  ];
  for (const r of state.remotes) {
    items.push({
      id: 'push_to_remote:' + r,
      label: r,
      checked: r === upstreamRemote,
    });
  }
  return decorateMenuItems(items);
}

function buildRemoteBranchContextMenuItems(remoteBranchName) {
  // Extract local branch name from remote branch (e.g. "origin/feature" -> "feature")
  const slashIdx = remoteBranchName.indexOf('/');
  const localName = slashIdx >= 0 ? remoteBranchName.substring(slashIdx + 1) : remoteBranchName;
  const localExists = state.branches.some(b => b.name === localName);

  const items = [];
  if (localExists) {
    items.push({ id: 'remotebranch_checkout_local', label: "Checkout '" + localName + "'" });
  } else {
    items.push({ id: 'remotebranch_checkout_tracking', label: "Checkout as '" + localName + "'" });
  }
  items.push(
    { id: 'remotebranch_new_branch', label: 'New Branch from Here...' },
    { type: 'separator' },
    { id: 'remotebranch_delete_remote', label: "Delete '" + remoteBranchName + "' on Remote...", icon: 'warning' },
  );

  // 리모트 추적 브랜치는 동명 로컬 브랜치와 따로 지정한다. 핀은 일부러 둘을 묶어 두지만,
  // 히스토리에서는 origin/foo 만 있고 로컬 foo 는 없는(또는 그 반대인) 커밋 줄기가 흔해
  // 각각 걸 수 있어야 쓸모가 있다.
  for (const item of buildRefFilterMenuItems('remotebranch_', remoteRefKey(remoteBranchName), remoteBranchName, true)) {
    items.push(item);
  }

  items.push(
    { type: 'separator' },
    { id: 'remotebranch_copy_name', label: 'Copy Branch Name', icon: 'copy' },
  );

  return decorateMenuItems(items);
}

async function handleContextMenuAction(actionId) {
  // menu_activated는 stdin 게이트를 거치지 않는다 — 지금 불가능한 액션은 여기서
  // 직접 막아야 중첩 실행(커밋 중 discard, rebase 중 checkout 등)이 안 생긴다.
  // 메뉴에서 이미 딤 처리된 항목이라도 호스트가 흘려보낼 수 있으니 한 번 더 본다.
  // 복사/열기 같은 읽기 액션은 어떤 상황에서도 그대로 통과한다.
  if (!guardAction(actionId)) return;

  // Tab context menu actions
  if (actionId === 'tab_refresh') {
    refreshAsync().then(() => {
      if (state.rightView === 'log') {
        refreshLog();
        updateLogDetail();
      }
      if (state.rightView === 'fresh') {
        refreshFresh();
        updateFreshDetail();
      }
      render();
    });
    return;
  }

  if (actionId === 'tab_apply_patch') {
    const clip = await hecaton.clipboard.read().catch(() => null);
    const patchText = clip && clip.text ? clip.text : '';
    if (!patchText.trim() || !/^(diff --git |From [0-9a-f]{40} |--- )/m.test(patchText)) {
      showError('Clipboard does not contain a patch.\nCopy a patch (git diff / format-patch output) first.');
      return;
    }
    const patchOp = startSpinner('Applying patch...', WORKTREE_SCOPES);
    const err = await gitApplyPatchFromText(state.cwd, patchText);
    await afterGitOp(err, 'Apply patch', {}, patchOp);
    return;
  }

  if (actionId === 'tab_change_repo') {
    // 기존 워처 정지 (폴링 RPC가 pick_folder 중 큐를 채우는 것 방지)
    if (ui.stopGitWatcher) ui.stopGitWatcher();
    const result = await hecaton.picker.folder({ title: 'Select Git Repository', default_path: state.cwd || '' });
    if (result && result.path) {
      await openRepositoryAt(result.path);
    } else {
      // 취소 시 워처 복원
      if (ui.setupGitWatcher) ui.setupGitWatcher();
    }
    return;
  }

  if (actionId === 'tab_clean') {
    const untrackedCount = state.untracked.length;
    hecaton.dialog.show({
      type: 'message',
      title: 'Clean Untracked Files',
      message: 'Remove ' + (untrackedCount > 0 ? untrackedCount + ' untracked file(s)/folder(s)' : 'all untracked files and folders') + '?\n\nIgnored files are kept. This cannot be undone.',
      buttons: [
        { id: 'clean', label: 'Remove', default: true, style: 'danger' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    state.pendingDialogAction = 'clean-confirm';
    return;
  }

  if (actionId === 'tab_discard_all') {
    const stagedCount = state.staged.length;
    const unstagedCount = state.unstaged.length;
    const untrackedCount = state.untracked.length;
    const summary = [
      stagedCount + ' staged',
      unstagedCount + ' unstaged',
      untrackedCount + ' untracked',
    ].join(', ');
    hecaton.dialog.show({
      type: 'message',
      title: 'Discard All Changes',
      message: 'Discard all local changes (' + summary + ')?\n\nTracked files and submodules will be restored to HEAD. Untracked files/folders, including nested Git repositories, will be removed. Ignored files are kept after the first commit; in a repository with no commits, they are removed too. This cannot be undone.',
      buttons: [
        { id: 'discard_all', label: 'Discard All', default: true, style: 'danger' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    state.pendingDialogAction = 'discard-all-confirm';
    return;
  }

  if (actionId === 'tab_init') {
    const initOp = startSpinner('Initializing repository...');
    const err = await gitInit(state.cwd);
    if (err) {
      stopSpinner(initOp);
      showError('Init failed:\n' + err);
      return;
    }
    stopSpinner(initOp);
    await openRepositoryAt(state.cwd);
    return;
  }

  if (actionId === 'tab_clone') {
    hecaton.dialog.show({
      type: 'input',
      title: 'Clone Repository',
      message: 'Enter repository URL:',
      defaultValue: '',
      buttons: [{ id: 'ok', label: 'Next', default: true }, { id: 'cancel', label: 'Cancel' }],
    });
    state.pendingDialogAction = 'clone-url';
    return;
  }

  // Push-to-remote selection (shown when multiple remotes exist)
  if (actionId.startsWith('push_to_remote:')) {
    const remote = actionId.substring('push_to_remote:'.length);
    const currentBranch = state.branches.find(b => b.isCurrent) || state.branches.find(b => b.name === state.branch);
    const branchName = currentBranch ? currentBranch.name : state.branch;
    if (!branchName) {
      showError('No branch to push');
      return;
    }
    const pushOp = startSpinner('Pushing to ' + remote + '...', [REMOTE]);
    gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => {
      await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true }, pushOp);
    });
    return;
  }

  // Remotes context menu actions
  if (actionId.startsWith('remote_')) {
    const targetRemote = ui.contextMenuRemote || '';
    switch (actionId) {
      case 'remote_add':
        hecaton.dialog.show({
          type: 'input',
          title: 'Add Remote',
          message: 'Enter remote name:',
          defaultValue: 'origin',
          buttons: [{ id: 'ok', label: 'Next', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-remote-name';
        break;
      case 'remote_prune': {
        if (!targetRemote) break;
        const pruneOp = startSpinner('Pruning...', [REMOTE, REFS]);
        gitRemotePruneAsync(state.cwd, targetRemote).then(async err => { await afterGitOp(err, 'Prune', { metadataOnly: true }, pruneOp); });
        break;
      }
      case 'remote_push_tags': {
        if (!targetRemote) break;
        hecaton.dialog.show({
          type: 'message',
          title: 'Push Tags',
          message: "Push all local tags to '" + targetRemote + "'?",
          buttons: [{ id: 'proceed', label: 'Push Tags', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'push-tags-confirm';
        state.pendingDialogTarget = targetRemote;
        break;
      }
      case 'remote_rename': {
        if (!targetRemote) break;
        hecaton.dialog.show({
          type: 'input',
          title: 'Rename Remote',
          message: "Enter new name for '" + targetRemote + "':",
          defaultValue: targetRemote,
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'rename-remote';
        state.pendingDialogTarget = targetRemote;
        break;
      }
      case 'remote_set_url': {
        if (!targetRemote) break;
        const currentUrl = await gitGetRemoteUrl(state.cwd, targetRemote);
        hecaton.dialog.show({
          type: 'input',
          title: 'Change Remote URL',
          message: "Enter new URL for '" + targetRemote + "':",
          defaultValue: currentUrl,
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'set-remote-url';
        state.pendingDialogTarget = targetRemote;
        break;
      }
      case 'remote_copy_url': {
        if (!targetRemote) break;
        const url = await gitGetRemoteUrl(state.cwd, targetRemote);
        if (url) {
          copyToClipboard(url);
        } else {
          showError("No URL set for remote '" + targetRemote + "'");
        }
        break;
      }
      case 'remote_remove': {
        if (!targetRemote) break;
        hecaton.dialog.show({
          type: 'message',
          title: 'Remove Remote',
          message: "Remove remote '" + targetRemote + "'?\n\nAll remote-tracking branches for it will be deleted locally.",
          buttons: [{ id: 'remove', label: 'Remove', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'remove-remote-confirm';
        state.pendingDialogTarget = targetRemote;
        break;
      }
      case 'remote_sort_alpha':
        ui.remoteSortMode = 'alpha';
        render();
        hecaton.menu.show({ items: buildRemotesContextMenuItems(ui.contextMenuRemote) }).catch(() => null);
        break;
      case 'remote_sort_alpha_desc':
        ui.remoteSortMode = 'alpha_desc';
        render();
        hecaton.menu.show({ items: buildRemotesContextMenuItems(ui.contextMenuRemote) }).catch(() => null);
        break;
      case 'remote_sort_recent':
        ui.remoteSortMode = 'recent';
        render();
        hecaton.menu.show({ items: buildRemotesContextMenuItems(ui.contextMenuRemote) }).catch(() => null);
        break;
    }
    return;
  }

  // Worktree context menu actions
  if (actionId.startsWith('worktree_')) {
    const wtPath = ui.contextMenuWorktree || '';
    switch (actionId) {
      case 'worktree_open':
        if (wtPath) await openRepositoryAt(wtPath);
        break;
      case 'worktree_new':
        hecaton.dialog.show({
          type: 'input',
          title: 'New Worktree',
          message: 'Enter path for the new worktree:',
          defaultValue: state.cwd ? state.cwd + '-wt' : '',
          buttons: [{ id: 'ok', label: 'Next', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-worktree-path';
        break;
      case 'worktree_remove':
        if (!wtPath) break;
        hecaton.dialog.show({
          type: 'message',
          title: 'Remove Worktree',
          message: "Remove worktree '" + wtPath + "'?\n\nForce Remove discards uncommitted changes in that worktree.",
          buttons: [
            { id: 'remove', label: 'Remove', default: true, style: 'danger' },
            { id: 'force', label: 'Force Remove', style: 'danger' },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        state.pendingDialogAction = 'remove-worktree-confirm';
        state.pendingDialogTarget = wtPath;
        break;
      case 'worktree_prune': {
        const wtPruneOp = startSpinner('Pruning worktrees...', [REFS]);
        const err = await gitWorktreePruneAsync(state.cwd);
        await afterGitOp(err, 'Worktree prune', { metadataOnly: true }, wtPruneOp);
        break;
      }
      case 'worktree_show_in_explorer':
        if (wtPath) {
          showInExplorer(wtPath).then(err => {
            if (err) showError('Show in Explorer failed:\n' + err);
          });
        }
        break;
      case 'worktree_open_explorer':
        // 워크트리 경로는 파일이 아니라 디렉터리이므로 그대로 연다.
        if (wtPath) hecaton.overlay.open({ plugin_id: 'dev.hecaton.explorer', params: { path: wtPath } }).catch(() => null);
        break;
      case 'worktree_copy_path':
        if (wtPath) copyToClipboard(wtPath);
        break;
    }
    return;
  }

  // Tag context menu actions (history view tag submenu)
  if (actionId.startsWith('tag_push:') || actionId.startsWith('tag_delete:') || actionId.startsWith('tag_delete_remote:')) {
    const tagName = actionId.substring(actionId.indexOf(':') + 1);
    const tagRemote = state.remotes[0] || 'origin';
    if (!tagName) return;
    if (actionId.startsWith('tag_push:')) {
      const tagPushOp = startSpinner('Pushing tag...', [REMOTE]);
      gitPushTagAsync(state.cwd, tagRemote, tagName).then(async err => { await afterGitOp(err, 'Push tag', { metadataOnly: true }, tagPushOp); });
      return;
    }
    if (actionId.startsWith('tag_delete_remote:')) {
      hecaton.dialog.show({
        type: 'message',
        title: 'Delete Remote Tag',
        message: "Delete tag '" + tagName + "' on '" + tagRemote + "'?",
        buttons: [{ id: 'delete', label: 'Delete', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
      });
      state.pendingDialogAction = 'delete-remote-tag-confirm';
      state.pendingDialogTarget = { remote: tagRemote, tag: tagName };
      return;
    }
    hecaton.dialog.show({
      type: 'message',
      title: 'Delete Tag',
      message: "Delete local tag '" + tagName + "'?",
      buttons: [{ id: 'delete', label: 'Delete', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
    });
    state.pendingDialogAction = 'delete-tag-confirm';
    state.pendingDialogTarget = tagName;
    return;
  }

  // File context menu actions
  if (actionId.startsWith('file_')) {
    const fileItem = ui.contextMenuFileItem;
    const fullPath = ui.contextMenuFilePath;
    const fileItems = Array.isArray(ui.contextMenuFileItems) && ui.contextMenuFileItems.length > 0
      ? ui.contextMenuFileItems
      : (fileItem ? [fileItem] : []);
    if (!fileItem || !fileItem.file) return;

    switch (actionId) {
      case 'file_open': {
        const err = await openExternal(fullPath);
        if (err) showError('Open failed:\n' + err);
        break;
      }
      case 'file_external_diff_head': {
        const raw = await gitFilePatch(state.cwd, { ...fileItem, type: 'unstaged' });
        if (raw) {
          copyToClipboard(raw);
          showError('Patch copied to clipboard');
        } else {
          showError('No diff with HEAD');
        }
        break;
      }
      case 'file_external_diff_index': {
        const raw = await gitFilePatch(state.cwd, { ...fileItem, type: 'staged' });
        if (raw) {
          copyToClipboard(raw);
          showError('Index diff copied to clipboard');
        } else {
          showError('No diff with index');
        }
        break;
      }
      case 'file_show_in_explorer': {
        showInExplorer(fullPath).then(err => {
          if (err) showError('Show in Explorer failed:\n' + err);
        });
        break;
      }
      case 'file_blame': {
        const raw = await gitBlameFile(state.cwd, fileItem.file);
        if (raw) {
          copyToClipboard(raw);
          showError('Blame copied to clipboard');
        } else {
          showError('Blame not available for this file');
        }
        break;
      }
      case 'file_history': {
        const raw = await gitFileHistory(state.cwd, fileItem.file);
        if (raw) {
          copyToClipboard(raw);
          showError('History copied to clipboard');
        } else {
          showError('No history for this file');
        }
        break;
      }
      case 'file_stage':
        if (fileItems.length > 0) {
          const files = fileItems.filter(item => item && item.type !== 'staged').map(item => item.file);
          if (files.length > 0) {
            const stageOp = startSpinner('Staging...', [INDEX]);
            const err = await gitStageMultiple(state.cwd, files);
            if (err) {
              stopSpinner(stageOp);
              showError(err);
              render();
            } else {
              stopSpinner(stageOp);
              applyStageToState(files);
              refreshInBackground({ statusOnly: true });
            }
          }
        }
        break;
      case 'file_unstage':
        if (fileItems.length > 0) {
          const files = fileItems.filter(item => item && item.type === 'staged').map(item => item.file);
          if (files.length > 0) {
            const unstageOp = startSpinner('Unstaging...', [INDEX]);
            const err = await gitUnstageMultiple(state.cwd, files);
            if (err) {
              stopSpinner(unstageOp);
              showError(err);
              render();
            } else {
              stopSpinner(unstageOp);
              applyUnstageToState(files);
              refreshInBackground({ statusOnly: true });
            }
          }
        }
        break;
      case 'file_discard': {
        const count = fileItems.length;
        hecaton.dialog.show({
          type: 'message',
          title: 'Discard Changes',
          message: 'Discard changes in ' + count + ' file(s)?\n\nThis cannot be undone.',
          buttons: [
            { id: 'discard', label: 'Discard', default: true, style: 'danger' },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        state.pendingDialogAction = 'discard-confirm';
        state.pendingDiscardFiles = [...fileItems];
        break;
      }
      case 'file_remove_keep':
      case 'file_remove_delete': {
        const keepLocal = actionId === 'file_remove_keep';
        const removeTargets = fileItems.filter(item => item && item.type !== 'untracked');
        if (removeTargets.length === 0) {
          showError('No tracked file to remove');
          break;
        }
        const count = removeTargets.length;
        hecaton.dialog.show({
          type: 'message',
          title: keepLocal ? 'Remove from Version Control' : 'Delete from Version Control',
          message: keepLocal
            ? 'Stop tracking ' + count + ' file(s)?\n\nThe local file(s) will be kept but removed from version control.'
            : 'Delete ' + count + ' file(s) and remove from version control?\n\nThe local file(s) will be deleted. This cannot be undone.',
          buttons: [
            { id: 'remove', label: keepLocal ? 'Remove' : 'Delete', default: true, style: 'danger' },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        state.pendingDialogAction = 'remove-from-repo-confirm';
        state.pendingRemoveFiles = removeTargets.map(item => item.file);
        state.pendingRemoveKeepLocal = keepLocal;
        break;
      }
      case 'file_accept_ours': {
        const oursOp = startSpinner('Accepting ours...', [INDEX, WORKTREE]);
        (async () => {
          const files = fileItems.filter(item => item && item.status === 'U').map(item => item.file);
          for (const f of files) {
            const err = await gitCheckoutOurs(state.cwd, f);
            if (err) { stopSpinner(oursOp); showError(err); render(); return; }
            const stageErr = await gitStageAsync(state.cwd, f);
            if (stageErr) { stopSpinner(oursOp); showError(stageErr); render(); return; }
          }
          await afterGitOp(null, 'Accept ours', {}, oursOp);
        })();
        break;
      }
      case 'file_accept_theirs': {
        const theirsOp = startSpinner('Accepting theirs...', [INDEX, WORKTREE]);
        (async () => {
          const files = fileItems.filter(item => item && item.status === 'U').map(item => item.file);
          for (const f of files) {
            const err = await gitCheckoutTheirs(state.cwd, f);
            if (err) { stopSpinner(theirsOp); showError(err); render(); return; }
            const stageErr = await gitStageAsync(state.cwd, f);
            if (stageErr) { stopSpinner(theirsOp); showError(stageErr); render(); return; }
          }
          await afterGitOp(null, 'Accept theirs', {}, theirsOp);
        })();
        break;
      }
      case 'file_stage_all': {
        const allFiles = [...state.unstaged.map(f => f.file), ...state.untracked.map(f => f.file)];
        if (allFiles.length === 0) break;
        const stageAllOp = startSpinner('Staging all...', [INDEX]);
        const err = await gitStageAll(state.cwd);
        if (err) {
          stopSpinner(stageAllOp);
          showError(err);
          render();
        } else {
          stopSpinner(stageAllOp);
          applyStageToState(allFiles);
          refreshInBackground({ statusOnly: true });
        }
        break;
      }
      case 'file_ignore_name': {
        const ignoreNameOp = startSpinner('Ignoring...', [WORKTREE]);
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const pattern = baseName(item.file);
          const oneErr = await gitIgnorePattern(state.cwd, pattern);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore', {}, ignoreNameOp);
        break;
      }
      case 'file_ignore_ext': {
        const exts = new Set();
        for (const item of fileItems) {
          if (!item) continue;
          const ext = extName(item.file);
          if (ext) exts.add(ext);
        }
        if (exts.size === 0) {
          showError('No extension to ignore');
          break;
        }
        const ignoreExtOp = startSpinner('Ignoring...', [WORKTREE]);
        let err = null;
        for (const ext of exts) {
          const oneErr = await gitIgnorePattern(state.cwd, '*' + ext);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore', {}, ignoreExtOp);
        break;
      }
      case 'file_ignore_path': {
        const ignorePathOp = startSpinner('Ignoring...', [WORKTREE]);
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const relPath = item.file.replace(/\\/g, '/').replace(/^\/+/, '');
          const oneErr = await gitIgnorePattern(state.cwd, '/' + relPath);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore', {}, ignorePathOp);
        break;
      }
      case 'file_stash_one': {
        const stashOneOp = startSpinner('Stashing...', STASH_SCOPES);
        const files = fileItems.filter(item => item && item.file).map(item => item.file);
        let err;
        if (files.length === 1) {
          err = await gitStashFile(state.cwd, files[0]);
        } else if (files.length > 1) {
          err = await gitStashFiles(state.cwd, files);
        } else {
          err = 'No files selected';
        }
        await afterGitOp(err, 'Stash file', {}, stashOneOp);
        break;
      }
      case 'file_save_patch': {
        const patches = [];
        for (const item of fileItems) {
          if (!item) continue;
          const patch = await gitFilePatch(state.cwd, item);
          if (patch) patches.push(patch);
        }
        if (patches.length > 0) {
          copyToClipboard(patches.join('\n\n'));
          showError('Patch copied to clipboard');
        } else {
          showError('No patch for this file');
        }
        break;
      }
      case 'file_copy_path': {
        const paths = fileItems
          .filter(Boolean)
          .map((item) => item.file.replace(/\\/g, '/'));
        copyToClipboard(paths.join('\n'));
        break;
      }
      case 'file_copy_full_path': {
        const paths = fileItems
          .filter(Boolean)
          .map((item) => joinPath(state.cwd, item.file));
        copyToClipboard(paths.join('\n'));
        break;
      }
      case 'file_open_explorer': {
        const dir = fullPath.substring(0, fullPath.replace(/\\/g, '/').lastIndexOf('/')) || state.cwd;
        hecaton.overlay.open({ plugin_id: 'dev.hecaton.explorer', params: { path: dir } }).catch(() => null);
        break;
      }
    }
    return;
  }

  // Remote branch context menu actions
  if (actionId.startsWith('remotebranch_')) {
    const remoteBranchName = ui.contextMenuRemoteBranch;
    if (!remoteBranchName) return;
    const slashIdx = remoteBranchName.indexOf('/');
    const localName = slashIdx >= 0 ? remoteBranchName.substring(slashIdx + 1) : remoteBranchName;

    switch (actionId) {
      case 'remotebranch_checkout_local': {
        const rbCoOp = startSpinner('Checking out...', CHECKOUT_SCOPES);
        gitCheckoutRefAsync(state.cwd, localName).then(async err => { await afterGitOp(err, 'Checkout', {}, rbCoOp); });
        break;
      }
      case 'remotebranch_checkout_tracking': {
        const trackCoOp = startSpinner('Checking out...', CHECKOUT_SCOPES);
        await runCreateBranch(localName, remoteBranchName, 'Checkout', trackCoOp);
        break;
      }
      case 'remotebranch_new_branch':
        hecaton.dialog.show({
          type: 'input',
          title: 'New Branch',
          message: 'Enter branch name:',
          defaultValue: localName,
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-branch';
        state.pendingDialogTarget = remoteBranchName;
        break;
      case 'remotebranch_delete_remote': {
        const remoteName = slashIdx >= 0 ? remoteBranchName.substring(0, slashIdx) : (state.remotes[0] || 'origin');
        hecaton.dialog.show({
          type: 'message',
          title: 'Delete Remote Branch',
          message: "Delete '" + remoteBranchName + "' on the remote?\n\nThis pushes a deletion to '" + remoteName + "'. The local branch is not touched.\nThis cannot be undone from this client.",
          buttons: [{ id: 'delete', label: 'Delete on Remote', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'delete-remote-branch-confirm';
        state.pendingDialogTarget = { remote: remoteName, branch: localName };
        break;
      }
      case 'remotebranch_filter':
        toggleFilteredRef(remoteRefKey(remoteBranchName));
        applyRefFilterChange();
        break;
      case 'remotebranch_hide':
        toggleHiddenRef(remoteRefKey(remoteBranchName));
        applyRefFilterChange();
        break;
      case 'remotebranch_clear_filters':
        clearFilteredRefs();
        applyRefFilterChange();
        break;
      case 'remotebranch_show_all':
        clearHiddenRefs();
        applyRefFilterChange();
        break;
      case 'remotebranch_copy_name':
        copyToClipboard(remoteBranchName);
        break;
    }
    return;
  }

  // Branch context menu actions
  if (actionId.startsWith('branch_')) {
    const branchName = ui.contextMenuBranch;
    if (!branchName) return;
    const branch = state.branches.find(b => b.name === branchName);
    const upstream = branch ? branch.upstream : '';
    const remote = upstream ? upstream.split('/')[0] : (state.remotes[0] || 'origin');

    if (actionId.startsWith('branch_track:')) {
      const remoteBranch = actionId.substring('branch_track:'.length);
      const upstreamOp = startSpinner('Setting upstream...', [CONFIG]);
      const err = await gitSetUpstream(state.cwd, branchName, remoteBranch);
      await afterGitOp(err, 'Set upstream', {}, upstreamOp);
      return;
    }

    // 리모트가 많은 저장소의 Tracking — 서브메뉴 대신 페이지로 나눈 별도 메뉴로 연다.
    if (actionId === 'branch_tracking_open' || actionId.startsWith('branch_tracking_page:')) {
      const page = actionId === 'branch_tracking_open'
        ? 0
        : parseInt(actionId.substring('branch_tracking_page:'.length), 10) || 0;
      hecaton.menu.show({ items: buildBranchTrackingMenuItems(branchName, page) }).catch(() => null);
      return;
    }

    switch (actionId) {
      case 'branch_checkout': {
        const brCoOp = startSpinner('Checking out...', CHECKOUT_SCOPES);
        gitCheckoutRefAsync(state.cwd, branchName).then(async err => { await afterGitOp(err, 'Checkout', {}, brCoOp); });
        break;
      }
      case 'branch_ff': {
        // 현재 브랜치면 워킹트리까지 옮기고, 아니면 refspec fetch 로 ref 만 옮긴다 —
        // 어느 쪽이든 리모트를 거치므로 REMOTE 도 함께 붙잡는다.
        const ffOp = startSpinner('Fast-forwarding...', PULL_SCOPES);
        // 현재 브랜치는 merge --ff-only로 작업 트리까지 함께 옮긴다. 다른 브랜치는
        // 체크아웃돼 있지 않으므로 refspec fetch로 ref만 옮긴다 — merge를 쓰면 엉뚱하게
        // HEAD가 갱신된다.
        const ffPromise = branch && branch.isCurrent
          ? gitMergeFastForwardAsync(state.cwd, upstream)
          : gitFetchIntoBranchAsync(state.cwd, remote, splitUpstreamRef(upstream, state.remotes).branch, branchName);
        ffPromise.then(async err => { await afterGitOp(err, 'Fast-forward', {}, ffOp); });
        break;
      }
      case 'branch_pull':
        // 체크아웃하지 않은 브랜치면 pull이 HEAD로 들어가 버린다 — 대신할 명령을 고르게 한다.
        if (!branch || !branch.isCurrent) { showPullOtherBranchDialog(branchName, upstream, false); break; }
        const brPullOp = startSpinner('Pulling...', PULL_SCOPES);
        gitPullFromRemoteAsync(state.cwd, remote, branchName).then(async err => { await afterGitOp(err, 'Pull', {}, brPullOp); });
        break;
      case 'branch_pull_rebase':
        if (!branch || !branch.isCurrent) { showPullOtherBranchDialog(branchName, upstream, true); break; }
        const brPullRebaseOp = startSpinner('Pulling with rebase...', PULL_SCOPES);
        gitPullRebaseAsync(state.cwd, remote, branchName).then(async err => {
          if (err && isRebaseConflictError(err)) {
            await refreshAsync();
            stopSpinner(brPullRebaseOp);
            if (state.rightView === 'log') refreshLog();
            if (state.rightView !== 'diff') {
              state.rightView = 'diff';
              updateDiff();
            }
            render();
            return;
          }
          await afterGitOp(err, 'Pull (rebase)', {}, brPullRebaseOp);
        });
        break;
      case 'branch_force_push':
        hecaton.dialog.show({
          type: 'message',
          title: 'Force Push',
          message: "Force push '" + branchName + "' to '" + remote + "'?\n\nUses --force-with-lease: fails if the remote has commits you haven't fetched.",
          buttons: [{ id: 'force_push', label: 'Force Push', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'force-push-confirm';
        state.pendingDialogTarget = { remote, branch: branchName };
        break;
      case 'branch_delete_remote': {
        if (!upstream) break;
        const remoteBranchPart = upstream.substring(remote.length + 1);
        hecaton.dialog.show({
          type: 'message',
          title: 'Delete Remote Branch',
          message: "Delete '" + upstream + "' on the remote?\n\nThis pushes a deletion to '" + remote + "'. The local branch '" + branchName + "' is not touched.\nThis cannot be undone from this client.",
          buttons: [{ id: 'delete', label: 'Delete on Remote', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'delete-remote-branch-confirm';
        state.pendingDialogTarget = { remote, branch: remoteBranchPart };
        break;
      }
      case 'branch_push': {
        const branchPushOp = startSpinner('Pushing...', [REMOTE]);
        gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => { await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true }, branchPushOp); });
        break;
      }
      case 'branch_push_pr': {
        const prPushOp = startSpinner('Pushing...', [REMOTE]);
        gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => {
          if (err) { await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true }, prPushOp); return; }
          const remoteUrl = await gitGetRemoteUrl(state.cwd, remote);
          const prUrl = buildPullRequestUrl(remoteUrl, branchName);
          if (prUrl) await openExternal(prUrl);
          await afterGitOp(null, 'Push', { metadataOnly: true, forceMeta: true }, prPushOp);
        });
        break;
      }
      case 'branch_new_branch':
        hecaton.dialog.show({
          type: 'input',
          title: 'New Branch',
          message: 'Enter branch name:',
          defaultValue: '',
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-branch';
        state.pendingDialogTarget = branchName;
        break;
      case 'branch_new_tag':
        hecaton.dialog.show({
          type: 'input',
          title: 'New Tag',
          message: 'Enter tag name:',
          defaultValue: '',
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-tag';
        state.pendingDialogTarget = branchName;
        break;
      case 'branch_rename':
        hecaton.dialog.show({
          type: 'input',
          title: 'Rename Branch',
          message: 'Enter new name:',
          defaultValue: branchName,
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'rename-branch';
        state.pendingDialogTarget = branchName;
        break;
      case 'branch_delete':
        hecaton.dialog.show({
          type: 'message',
          title: 'Delete Branch',
          message: "Delete branch '" + branchName + "'?",
          buttons: [{ id: 'delete', label: 'Delete', default: true, style: 'danger' }, { id: 'force', label: 'Force Delete', style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'delete-branch';
        state.pendingDialogTarget = branchName;
        break;
      case 'branch_untrack': {
        // 시작 표시 없이 afterGitOp 만 부르면, 끝낼 작업이 없어 겹쳐 돌던 다른 작업을
        // 대신 끝내게 된다(예전에는 스피너 참조만 하나 깎여 티가 나지 않았다).
        const untrackOp = startSpinner('Unsetting upstream...', [CONFIG]);
        const err = await gitUnsetUpstream(state.cwd, branchName);
        await afterGitOp(err, 'Unset upstream', {}, untrackOp);
        break;
      }
      case 'branch_pin':
        // 핀은 순수 UI 상태다 — git 호출 없이 토글하고 render()로 다시 그리며 저장까지 맡긴다.
        togglePinnedBranch(branchName);
        render();
        break;
      case 'branch_filter':
        toggleFilteredRef(localRefKey(branchName));
        applyRefFilterChange();
        break;
      case 'branch_hide':
        toggleHiddenRef(localRefKey(branchName));
        applyRefFilterChange();
        break;
      case 'branch_clear_filters':
        clearFilteredRefs();
        applyRefFilterChange();
        break;
      case 'branch_show_all':
        clearHiddenRefs();
        applyRefFilterChange();
        break;
      case 'branch_copy_name':
        copyToClipboard(branchName);
        break;
      case 'branch_rebase_onto': {
        const brRebaseOp = startSpinner('Checking rebase...', CHECKOUT_SCOPES);
        // 옮길 커밋이 없으면(대상이 이미 조상) git 은 조용히 끝난다 — 먼저 안내한다.
        if (await gitIsRebaseNoop(state.cwd, branchName)) {
          stopSpinner(brRebaseOp);
          showRebaseNoopDialog(branchName);
          break;
        }
        // Pre-check for conflicts
        const conflictCheck = await gitCheckRebaseConflicts(state.cwd, branchName);
        if (conflictCheck.willConflict) {
          stopSpinner(brRebaseOp);
          const fileList = conflictCheck.files.length > 0
            ? '\n\nConflicting files:\n' + conflictCheck.files.slice(0, 10).join('\n')
            : '';
          state.pendingRebaseRef = branchName;
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
        updateSpinner('Rebasing...', brRebaseOp);
        gitRebaseAsync(state.cwd, branchName).then(async err => {
          await refreshAsync();
          stopSpinner(brRebaseOp);
          if (state.rightView === 'log') refreshLog();
          if (err && isRebaseConflictError(err)) {
            if (state.rightView !== 'diff') {
              state.rightView = 'diff';
              updateDiff();
            }
            render();
          } else if (err) {
            showError(err);
          } else {
            render();
          }
        });
        break;
      }
      case 'branch_merge_into': {
        const brMergeOp = startSpinner('Merging...', CHECKOUT_SCOPES);
        gitMergeAsync(state.cwd, branchName).then(async err => {
          await afterGitOp(err, 'Merge', {}, brMergeOp);
        });
        break;
      }
    }
    return;
  }

  // Stash context menu actions
  if (actionId.startsWith('stash_')) {
    const ref = ui.contextMenuStashRef;
    if (!ref) return;
    const stashEntry = state.stashes.find(s => s.ref === ref);
    const stashHash = stashEntry ? stashEntry.hash : '';
    const stashMessage = stashEntry ? stashEntry.message : '';
    switch (actionId) {
      case 'stash_apply': {
        const displayRef = ref + (stashMessage ? '  ' + stashMessage : '');
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
        state.pendingDialogTarget = ref;
        break;
      }
      case 'stash_drop': {
        hecaton.dialog.show({
          type: 'message',
          title: 'Delete Stash',
          message: 'Delete ' + ref + (stashMessage ? ' (' + stashMessage + ')' : '') + '?\n\nThis cannot be undone.',
          buttons: [
            { id: 'drop', label: 'Delete', default: true, style: 'danger' },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        state.pendingDialogAction = 'stash-drop-confirm';
        state.pendingDialogTarget = ref;
        break;
      }
      case 'stash_rename':
        hecaton.dialog.show({
          type: 'input',
          title: 'Rename Stash',
          message: 'Enter new name for stash:',
          defaultValue: stashMessage,
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'rename-stash';
        state.pendingDialogTarget = ref;
        break;
      case 'stash_compare': {
        // stash를 선택하고 로그 뷰로 이동하여 diff 표시
        ui.leftPanelActiveBranch = 'stash:' + (stashEntry ? stashEntry.shortHash : '');
        state.rightView = 'log';
        refreshLog();
        // stash 커밋 찾기
        const targetHash = stashEntry ? stashEntry.shortHash : '';
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
        render();
        break;
      }
      case 'stash_copy_sha':
        if (stashHash) copyToClipboard(stashHash);
        break;
      case 'stash_copy_info': {
        if (stashHash) {
          const raw = await gitCommitInfo(state.cwd, stashHash);
          if (raw) {
            copyToClipboard(raw);
          } else {
            copyToClipboard(stashHash + ' ' + stashMessage);
          }
        }
        break;
      }
    }
    return;
  }

  // 브랜치가 많은 저장소의 체크아웃 목록 — 서브메뉴 대신 페이지로 나눈 별도 메뉴로 연다.
  // 선택한 커밋과 무관하므로 logItem 확인보다 앞에 둔다.
  if (actionId === 'history_branch_open' || actionId.startsWith('history_branch_page:')) {
    const page = actionId === 'history_branch_open'
      ? 0
      : parseInt(actionId.substring('history_branch_page:'.length), 10) || 0;
    hecaton.menu.show({ items: buildHistoryBranchMenuItems(page) }).catch(() => null);
    return;
  }

  const logItem = selectedLogRef();
  if (!logItem) return;

  const hash = logItem.hash || logItem.ref;

  // Branch checkout from submenu
  if (actionId.startsWith('checkout_branch:')) {
    const branchName = actionId.substring('checkout_branch:'.length);
    // 진행 표시 없이 afterGitOp 만 부르면 끝낼 작업이 없어 다른 작업을 대신 끝낸다.
    const coOp = startSpinner('Checking out...', CHECKOUT_SCOPES);
    const err = await gitCheckoutRef(state.cwd, branchName);
    await afterGitOp(err, 'Checkout', {}, coOp);
    return;
  }

  switch (actionId) {
    case 'new_branch':
      hecaton.dialog.show({
        type: 'input',
        title: 'New Branch',
        message: 'Enter branch name:',
        defaultValue: '',
        buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
      });
      state.pendingDialogAction = 'new-branch';
      state.pendingDialogTarget = hash;
      break;
    case 'new_tag':
      hecaton.dialog.show({
        type: 'input',
        title: 'New Tag',
        message: 'Enter tag name:',
        defaultValue: '',
        buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
      });
      state.pendingDialogAction = 'new-tag';
      state.pendingDialogTarget = hash;
      break;
    case 'merge': {
      const mergeOp = startSpinner('Merging...', CHECKOUT_SCOPES);
      gitMergeAsync(state.cwd, hash).then(async err => { await afterGitOp(err, 'Merge', {}, mergeOp); });
      break;
    }
    case 'rebase': {
      const rebaseOp = startSpinner('Checking rebase...', CHECKOUT_SCOPES);
      // 옮길 커밋이 없으면(대상이 이미 조상) git 은 조용히 끝난다 — 먼저 안내한다.
      if (await gitIsRebaseNoop(state.cwd, hash)) {
        stopSpinner(rebaseOp);
        showRebaseNoopDialog(hash);
        break;
      }
      if (state.staged.length > 0 || state.unstaged.length > 0) {
        stopSpinner(rebaseOp);
        state.pendingRebaseRef = hash;
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
        // Pre-check for conflicts
        const conflictCheck = await gitCheckRebaseConflicts(state.cwd, hash);
        if (conflictCheck.willConflict) {
          stopSpinner(rebaseOp);
          const fileList = conflictCheck.files.length > 0
            ? '\n\nConflicting files:\n' + conflictCheck.files.slice(0, 10).join('\n')
            : '';
          state.pendingRebaseRef = hash;
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
        updateSpinner('Rebasing...', rebaseOp);
        gitRebaseAsync(state.cwd, hash).then(async err => {
          await refreshAsync();
          stopSpinner(rebaseOp);
          if (state.rightView === 'log') refreshLog();
          if (err && isStaleRebaseError(err)) {
            state.pendingRebaseRef = hash;
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
            if (state.rightView !== 'diff') {
              state.rightView = 'diff';
              updateDiff();
            }
            render();
          } else if (err) {
            showError(err);
          } else {
            render();
          }
        });
      }
      break;
    }
    case 'reset': {
      hecaton.dialog.show({
        type: 'message',
        title: 'Reset',
        message: "Reset '" + (state.branch || 'HEAD') + "' to " + hash.substring(0, 8) + "?\n\n"
          + 'Soft: keep changes staged\n'
          + 'Mixed: keep changes in working tree\n'
          + 'Hard: discard all changes (cannot be undone)',
        buttons: [
          { id: 'reset_soft', label: 'Soft' },
          { id: 'reset_mixed', label: 'Mixed', default: true },
          { id: 'reset_hard', label: 'Hard', style: 'danger' },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      state.pendingDialogAction = 'reset-confirm';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'checkout': {
      hecaton.dialog.show({
        type: 'message',
        title: 'Checkout Commit',
        message: 'Checkout ' + hash.substring(0, 8) + "?\n\nThis will put you in 'detached HEAD' state.",
        buttons: [
          { id: 'checkout', label: 'Checkout', default: true },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      state.pendingDialogAction = 'checkout-commit-confirm';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'cherry_pick': {
      hecaton.dialog.show({
        type: 'message',
        title: 'Cherry-pick Commit',
        message: 'Cherry-pick ' + hash.substring(0, 8) + ' into ' + (state.branch || 'HEAD') + '?\n\nChoose how to apply it:',
        buttons: [
          { id: 'cherry_pick_commit', label: 'Cherry-pick & Commit', default: true },
          { id: 'cherry_pick_stage', label: 'Stage Only' },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      state.pendingDialogAction = 'cherry-pick-confirm';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'revert': {
      const revertOp = startSpinner('Reverting...', CHECKOUT_SCOPES);
      gitRevertAsync(state.cwd, hash).then(async err => { await afterGitOp(err, 'Revert', {}, revertOp); });
      break;
    }
    case 'amend_commit': {
      const headHash = (await gitExec(['rev-parse', 'HEAD'], state.cwd)).trim();
      const fullHash = (await gitExec(['rev-parse', hash], state.cwd)).trim();
      if (!headHash || headHash !== fullHash) {
        showError('Only the last commit (HEAD) can be amended.\nUse Interactive Rebase > Edit Commit for older commits.');
        break;
      }
      const message = await gitCommitMessage(state.cwd, 'HEAD');
      state.rightView = 'diff';
      state.mode = 'commit';
      state.commitAmend = true;
      state.commitMsg = message;
      state.commitCursor = message.length;
      updateDiff();
      render();
      break;
    }
    case 'reword_commit': {
      const message = await gitCommitMessage(state.cwd, hash);
      hecaton.dialog.show({
        type: 'input',
        title: 'Edit Commit Message',
        message: 'Edit message for ' + hash.substring(0, 8) + ':',
        defaultValue: message,
        buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
      });
      state.pendingDialogAction = 'reword-commit';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'squash_commit':
    case 'fixup_commit': {
      if (hasLocalChanges()) {
        showError('Cannot rewrite history with uncommitted changes.\nCommit or stash them first.');
        break;
      }
      const isFixup = actionId === 'fixup_commit';
      hecaton.dialog.show({
        type: 'message',
        title: isFixup ? 'Fixup' : 'Squash',
        message: (isFixup ? 'Fixup ' : 'Squash ') + hash.substring(0, 8) + ' into its parent?\n\n'
          + (isFixup ? 'The commit message will be discarded.' : 'The commit messages will be combined.'),
        buttons: [
          { id: 'proceed', label: isFixup ? 'Fixup' : 'Squash', default: true },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      state.pendingDialogAction = isFixup ? 'fixup-commit' : 'squash-commit';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'edit_commit': {
      if (hasLocalChanges()) {
        showError('Cannot rewrite history with uncommitted changes.\nCommit or stash them first.');
        break;
      }
      hecaton.dialog.show({
        type: 'message',
        title: 'Edit Commit',
        message: 'Rebase will stop at ' + hash.substring(0, 8) + ' so you can amend it.\n\n'
          + 'Stage your changes, amend, then continue the rebase from the [b] menu.',
        buttons: [
          { id: 'proceed', label: 'Start', default: true },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      state.pendingDialogAction = 'edit-commit';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'drop_commit': {
      if (hasLocalChanges()) {
        showError('Cannot rewrite history with uncommitted changes.\nCommit or stash them first.');
        break;
      }
      hecaton.dialog.show({
        type: 'message',
        title: 'Drop Commit',
        message: 'Drop ' + hash.substring(0, 8) + (logItem.subject ? ' (' + logItem.subject + ')' : '') + ' from history?\n\nDescendant commits will be rebased on top of its parent.',
        buttons: [
          { id: 'drop', label: 'Drop', default: true, style: 'danger' },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      state.pendingDialogAction = 'drop-commit';
      state.pendingDialogTarget = hash;
      break;
    }
    case 'save_patch': {
      const patch = await gitFormatPatch(state.cwd, hash);
      if (patch) {
        copyToClipboard(patch);
        showError('Patch copied to clipboard');
      } else {
        showError('Failed to generate patch');
      }
      break;
    }
    case 'copy_sha':
      copyToClipboard(hash);
      break;
    case 'copy_info': {
      const raw = await gitCommitInfo(state.cwd, hash);
      if (raw) {
        copyToClipboard(raw);
      } else {
        copyToClipboard(hash + ' ' + (logItem.subject || ''));
      }
      break;
    }
  }
}

// ── 확인창이 실제로 실행할 동작 ──
// 다이얼로그를 열 때 통과한 판정을 확인 버튼 시점에 한 번 더 보기 위한 대응표다.
// 여는 쪽(handleContextMenuAction 의 guardAction)과 같은 id 를 가리켜야 두 검사가
// 같은 규칙을 본다. 여기 없는 pending 은 재검사 없이 지나간다 — 새 확인창을 만들면
// 함께 등록해야 그 사이 시작된 작업과 겹치지 않는다.
const DIALOG_ACTION_IDS = {
  'unlock-index-confirm': 'unlockIndex',
  'delete-branch': 'branch_delete',
  'delete-remote-branch-confirm': 'branch_delete_remote',
  'delete-tag-confirm': 'tag_delete:',
  'delete-remote-tag-confirm': 'tag_delete_remote:',
  'discard-confirm': 'file_discard',
  'discard-all-confirm': 'tab_discard_all',
  'clean-confirm': 'tab_clean',
  'remove-from-repo-confirm': 'file_remove_keep',
  'checkout-commit-confirm': 'checkout',
  'cherry-pick-confirm': 'cherry_pick',
  'reset-confirm': 'reset',
  'reword-commit': 'reword_commit',
  'edit-commit': 'edit_commit',
  'drop-commit': 'drop_commit',
  'squash-commit': 'squash_commit',
  'fixup-commit': 'fixup_commit',
  'force-push-confirm': 'branch_force_push',
  'push-name-mismatch': 'git-push',
  'push-tags-confirm': 'remote_push_tags',
  'stash-apply-confirm': 'stash_apply',
  'stash-drop-confirm': 'stash_drop',
  'rename-stash': 'stash_rename',
  'rename-branch': 'branch_rename',
  'rename-remote': 'remote_rename',
  'set-remote-url': 'remote_set_url',
  'remove-remote-confirm': 'remote_remove',
  'new-remote-name': 'remote_add',
  'new-remote-url': 'remote_add',
  'new-branch': 'new_branch',
  'new-tag': 'new_tag',
  'new-tag-message': 'new_tag',
  'new-worktree-branch': 'worktree_new',
  'new-worktree-path': 'worktree_new',
  'remove-worktree-confirm': 'worktree_remove',
  'clone-url': 'tab_clone',
  // 체크아웃하지 않은 브랜치의 Pull — 고른 대체 명령(ff / checkout & pull)을 실행한다
  'pull-other-branch': 'branch_pull',
  'pull-other-branch-rebase': 'branch_pull_rebase',
};

// 재검사에 걸려 실행하지 않을 때, 확인창이 들고 있던 대상까지 함께 버린다.
// 남겨 두면 다음 확인창이 엉뚱한 대상을 물려받는다.
function clearPendingTargets() {
  state.pendingDiscardFiles = null;
  state.pendingRemoveFiles = null;
  state.pendingRemoveKeepLocal = false;
  state.pendingRebaseRef = null;
  state.pendingStash = false;
  state.pendingStashCreateBranch = null;
}

async function handleDialogResult(params) {
  const buttonId = params && params.button_id;

  // Name input dialog results (new-branch, new-tag, rename-stash, rename-branch, new-remote, delete-branch)
  if (state.pendingDialogAction) {
    const action = state.pendingDialogAction;
    const target = state.pendingDialogTarget || '';
    state.pendingDialogAction = null;
    state.pendingDialogTarget = null;

    // 확인창이 떠 있는 동안 상황이 바뀔 수 있다 — 다른 작업이 시작되거나, 인덱스가
    // 잠기거나, rebase 가 걸린다. 열 때의 판정만 믿으면 그 사이에 시작된 작업과
    // 겹친 채로 실행된다. 취소는 아무것도 실행하지 않으므로 그대로 통과시킨다.
    const deferredId = DIALOG_ACTION_IDS[action];
    if (deferredId && buttonId && buttonId !== 'cancel' && !guardDeferredAction(deferredId)) {
      clearPendingTargets();
      render();
      return;
    }

    if (action === 'unlock-index-confirm') {
      if (buttonId === 'unlock') {
        const unlockOp = startSpinner('Unlocking...', [INDEX]);
        const err = await removeIndexLock();
        stopSpinner(unlockOp);
        if (err) {
          showError(err);
          render();
        } else {
          refreshInBackground({ statusOnly: true });
        }
      }
      return;
    }

    // 체크아웃하지 않은 브랜치의 Pull — 고른 대체 명령을 실행한다.
    if (action === 'pull-other-branch' || action === 'pull-other-branch-rebase') {
      if (!target || (buttonId !== 'ff' && buttonId !== 'checkout_pull')) return;
      const rebase = action === 'pull-other-branch-rebase';
      const entry = state.branches.find(b => b.name === target);
      const parts = splitUpstreamRef(entry ? entry.upstream : '', state.remotes);
      const remote = parts.remote || state.remotes[0] || 'origin';
      const remoteBranch = parts.branch || target;

      if (buttonId === 'ff') {
        const otherFfOp = startSpinner('Fast-forwarding...', PULL_SCOPES);
        const err = await gitFetchIntoBranchAsync(state.cwd, remote, remoteBranch, target);
        await afterGitOp(err, 'Fast-forward', {}, otherFfOp);
        return;
      }
      // Checkout & Pull — 체크아웃부터 실패하면(로컬 수정 등) pull은 시도하지 않는다.
      // 두 명령이 한 동작이므로 두 번째는 startSpinner 가 아니라 updateSpinner 다.
      // 다시 start 하면 진행 중인 작업이 하나 더 등록되는데 끝내는 쪽은 afterGitOp 의
      // stopSpinner 하나뿐이라, 끝나지 않는 작업이 남아 이후 쓰기가 전부 막힌다.
      const coPullOp = startSpinner('Checking out...', PULL_SCOPES);
      const coErr = await gitCheckoutRefAsync(state.cwd, target);
      if (coErr) { await afterGitOp(coErr, 'Checkout', {}, coPullOp); return; }
      updateSpinner(rebase ? 'Pulling with rebase...' : 'Pulling...', coPullOp);
      const pullErr = rebase
        ? await gitPullRebaseAsync(state.cwd, remote, remoteBranch)
        : await gitPullFromRemoteAsync(state.cwd, remote, remoteBranch);
      await afterGitOp(pullErr, rebase ? 'Pull (rebase)' : 'Pull', {}, coPullOp);
      return;
    }

    // delete-branch is a message dialog with delete/force/cancel buttons
    if (action === 'delete-branch') {
      if (buttonId === 'delete') {
        // 이 갈래만 afterGitOp 을 쓰지 않는다 — 실패가 곧 "force 로 다시 물어볼 일"이라
        // 오류 창을 바로 띄우면 안 되기 때문이다. 대신 갱신을 직접 기다린 뒤 작업을
        // 내리므로 뒷정리 구간이 아예 없다(force 갈래는 평소대로 afterGitOp).
        const delOp = startSpinner('Deleting branch...', [REFS]);
        const err = await gitDeleteBranch(state.cwd, target, false);
        // 사라진 브랜치의 핀/필터 지정은 남기지 않는다 — 같은 이름이 다시 생기면
        // 지정한 적 없는 브랜치가 핀·필터 상태로 되살아난다.
        if (!err) { unpinBranch(target); forgetRef(localRefKey(target)); }
        if (!state.spinnerActive) state.error = null;
        await refreshAsync();
        if (state.rightView === 'log') refreshLog();
        stopSpinner(delOp);
        if (err) {
          if (isBranchNotFullyMergedError(err)) {
            showForceDeleteBranchDialog(target, err);
          } else {
            showError('Delete branch failed:\n' + err);
          }
        } else {
          render();
        }
      } else if (buttonId === 'force') {
        const forceDelOp = startSpinner('Deleting branch...', [REFS]);
        const err = await gitDeleteBranch(state.cwd, target, true);
        // 사라진 브랜치의 핀/필터 지정은 남기지 않는다 — 같은 이름이 다시 생기면
        // 지정한 적 없는 브랜치가 핀·필터 상태로 되살아난다.
        if (!err) { unpinBranch(target); forgetRef(localRefKey(target)); }
        await afterGitOp(err, 'Delete branch', {}, forceDelOp);
      }
      return;
    }
    if (action === 'reset-confirm') {
      const resetMode = buttonId === 'reset_soft' ? 'soft'
        : buttonId === 'reset_mixed' ? 'mixed'
        : buttonId === 'reset_hard' ? 'hard'
        : null;
      if (resetMode) {
        // soft/mixed 는 워킹트리를 건드리지 않지만 hard 는 갈아엎는다 — 셋을 갈라
        // 적으면 같은 버튼이 모드에 따라 다르게 막혀 읽기 어렵다. 가장 넓은 쪽으로 맞춘다.
        const resetModeOp = startSpinner('Resetting (' + resetMode + ')...', CHECKOUT_SCOPES);
        gitResetModeAsync(state.cwd, target, resetMode).then(async err => { await afterGitOp(err, 'Reset', {}, resetModeOp); });
      }
      return;
    }
    if (action === 'stash-drop-confirm') {
      if (buttonId === 'drop') {
        const stashDropOp = startSpinner('Deleting stash...', [STASH]);
        const err = await gitStashDrop(state.cwd, target);
        await afterGitOp(err, 'Stash delete', {}, stashDropOp);
      }
      return;
    }
    if (action === 'stash-apply-confirm') {
      if (buttonId === 'apply') {
        const deleteAfter = params.checkboxes && params.checkboxes.delete_after;
        const applyStashOp = startSpinner('Applying stash...', STASH_SCOPES);
        const err = await gitStashApply(state.cwd, target);
        if (!err && deleteAfter) {
          const dropErr = await gitStashDrop(state.cwd, target);
          await afterGitOp(dropErr, 'Stash apply & delete', {}, applyStashOp);
        } else {
          await afterGitOp(err, 'Stash apply', {}, applyStashOp);
        }
      }
      return;
    }
    if (action === 'discard-confirm') {
      if (buttonId === 'discard') {
        const discardOp = startSpinner('Discarding...', WORKTREE_SCOPES);
        const files = state.pendingDiscardFiles || [];
        state.pendingDiscardFiles = null;
        let err = null;
        for (const item of files) {
          if (!item) continue;
          const oneErr = await gitDiscardFile(state.cwd, item);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Discard', {}, discardOp);
      } else {
        state.pendingDiscardFiles = null;
      }
      return;
    }
    if (action === 'remove-from-repo-confirm') {
      const keepLocal = !!state.pendingRemoveKeepLocal;
      const files = state.pendingRemoveFiles || [];
      state.pendingRemoveFiles = null;
      state.pendingRemoveKeepLocal = false;
      if (buttonId === 'remove') {
        const removeOp = startSpinner(keepLocal ? 'Removing...' : 'Deleting...', WORKTREE_SCOPES);
        let err = null;
        for (const file of files) {
          if (!file) continue;
          const oneErr = await gitRemoveFromRepo(state.cwd, file, keepLocal);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, keepLocal ? 'Remove from version control' : 'Delete', {}, removeOp);
      }
      return;
    }
    if (action === 'checkout-commit-confirm') {
      if (buttonId === 'checkout') {
        const commitCoOp = startSpinner('Checking out...', CHECKOUT_SCOPES);
        gitCheckoutRefAsync(state.cwd, target).then(async err => { await afterGitOp(err, 'Checkout', {}, commitCoOp); });
      }
      return;
    }
    if (action === 'cherry-pick-confirm') {
      if (buttonId === 'cherry_pick_commit') {
        await runCherryPickFromDialog(target, true);
      } else if (buttonId === 'cherry_pick_stage') {
        await runCherryPickFromDialog(target, false);
      }
      return;
    }
    if (action === 'reword-commit') {
      if (buttonId === 'ok' && params.value != null) {
        const newMessage = params.value.replace(/\r\n/g, '\n');
        if (!newMessage.trim()) {
          showError('Commit message cannot be empty');
          return;
        }
        await runHistoryRewrite('Reword', () => gitRewordCommitAsync(state.cwd, target, newMessage));
      }
      return;
    }
    if (action === 'squash-commit' || action === 'fixup-commit') {
      if (buttonId === 'proceed') {
        const isFixup = action === 'fixup-commit';
        await runHistoryRewrite(isFixup ? 'Fixup' : 'Squash', () => gitSquashIntoParentAsync(state.cwd, target, isFixup));
      }
      return;
    }
    if (action === 'edit-commit') {
      if (buttonId === 'proceed') {
        await runHistoryRewrite('Edit commit', () => gitEditCommitAsync(state.cwd, target));
      }
      return;
    }
    if (action === 'drop-commit') {
      if (buttonId === 'drop') {
        await runHistoryRewrite('Drop commit', () => gitDropCommitAsync(state.cwd, target));
      }
      return;
    }
    // New tag 2단계: 이름 입력 후 메시지 입력 (빈 메시지 = lightweight)
    if (action === 'new-tag') {
      if (buttonId === 'ok' && params.value != null) {
        const tagName = params.value.trim();
        if (!tagName) {
          showError('Name cannot be empty');
          return;
        }
        hecaton.dialog.show({
          type: 'input',
          title: 'New Tag',
          message: "Message for '" + tagName + "' (leave empty for a lightweight tag):",
          defaultValue: '',
          buttons: [{ id: 'ok', label: 'Create', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-tag-message';
        state.pendingDialogTarget = { ref: target, name: tagName };
      }
      return;
    }
    if (action === 'new-tag-message') {
      if (buttonId === 'ok' && params.value != null && target && target.name) {
        const tagMessage = params.value.trim();
        const tagOp = startSpinner('Tag...', [REFS]);
        const err = tagMessage
          ? await gitCreateTagAnnotated(state.cwd, target.name, tagMessage, target.ref)
          : await gitCreateTag(state.cwd, target.name, target.ref);
        await afterGitOp(err, 'Tag', {}, tagOp);
      }
      return;
    }
    if (action === 'force-push-confirm') {
      if (buttonId === 'force_push' && target) {
        const forcePushOp = startSpinner('Force pushing...', [REMOTE]);
        gitForcePushAsync(state.cwd, target.remote, target.branch).then(async err => { await afterGitOp(err, 'Force push', { metadataOnly: true, forceMeta: true }, forcePushOp); });
      }
      return;
    }
    // Renamed branch: upstream name no longer matches the local name, so the
    // user picked which remote branch to update.
    if (action === 'push-name-mismatch') {
      if (target && (buttonId === 'push_local' || buttonId === 'push_upstream')) {
        const mismatchPushOp = startSpinner('Pushing...', [REMOTE]);
        const pushPromise = buttonId === 'push_local'
          ? gitPushToRemoteAsync(state.cwd, target.remote, target.local)
          : gitPushHeadToBranchAsync(state.cwd, target.remote, target.upstreamBranch);
        pushPromise.then(async err => { await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true }, mismatchPushOp); });
      }
      return;
    }
    if (action === 'delete-remote-branch-confirm') {
      if (buttonId === 'delete' && target) {
        const delRemoteOp = startSpinner('Deleting remote branch...', [REMOTE]);
        gitPushDeleteBranchAsync(state.cwd, target.remote, target.branch).then(async err => {
          // 사라진 리모트 브랜치의 필터/숨김 지정은 남기지 않는다(로컬 삭제와 같은 이유).
          if (!err) forgetRef(remoteRefKey(target.remote + '/' + target.branch));
          await afterGitOp(err, 'Delete remote branch', { metadataOnly: true }, delRemoteOp);
        });
      }
      return;
    }
    if (action === 'push-tags-confirm') {
      if (buttonId === 'proceed' && target) {
        const pushTagsOp = startSpinner('Pushing tags...', [REMOTE]);
        gitPushTagsAsync(state.cwd, target).then(async err => { await afterGitOp(err, 'Push tags', { metadataOnly: true }, pushTagsOp); });
      }
      return;
    }
    if (action === 'remove-remote-confirm') {
      if (buttonId === 'remove' && target) {
        const rmRemoteOp = startSpinner('Removing remote...', [CONFIG]);
        const err = await gitRemoteRemove(state.cwd, target);
        await afterGitOp(err, 'Remove remote', {}, rmRemoteOp);
      }
      return;
    }
    if (action === 'rename-remote') {
      if (buttonId === 'ok' && params.value != null) {
        const newName = params.value.trim();
        if (!newName) {
          showError('Name cannot be empty');
          return;
        }
        // remote rename 은 config 뿐 아니라 remote-tracking ref 도 함께 옮긴다
        const renameRemoteOp = startSpinner('Renaming remote...', [CONFIG, REMOTE]);
        const err = await gitRemoteRename(state.cwd, target, newName);
        await afterGitOp(err, 'Rename remote', {}, renameRemoteOp);
      }
      return;
    }
    if (action === 'set-remote-url') {
      if (buttonId === 'ok' && params.value != null) {
        const newUrl = params.value.trim();
        if (!newUrl) {
          showError('URL cannot be empty');
          return;
        }
        const setUrlOp = startSpinner('Updating remote URL...', [CONFIG]);
        const err = await gitRemoteSetUrl(state.cwd, target, newUrl);
        await afterGitOp(err, 'Set remote URL', {}, setUrlOp);
      }
      return;
    }
    if (action === 'delete-tag-confirm') {
      if (buttonId === 'delete' && target) {
        const delTagOp = startSpinner('Deleting tag...', [REFS]);
        const err = await gitDeleteTag(state.cwd, target);
        await afterGitOp(err, 'Delete tag', {}, delTagOp);
      }
      return;
    }
    if (action === 'delete-remote-tag-confirm') {
      if (buttonId === 'delete' && target) {
        const delRemoteTagOp = startSpinner('Deleting remote tag...', [REMOTE]);
        gitPushDeleteTagAsync(state.cwd, target.remote, target.tag).then(async err => { await afterGitOp(err, 'Delete remote tag', { metadataOnly: true }, delRemoteTagOp); });
      }
      return;
    }
    // New worktree 2단계: 경로 → 브랜치
    if (action === 'new-worktree-path') {
      if (buttonId === 'ok' && params.value != null) {
        const wtPath = params.value.trim();
        if (!wtPath) {
          showError('Path cannot be empty');
          return;
        }
        hecaton.dialog.show({
          type: 'input',
          title: 'New Worktree',
          message: 'Enter branch for the worktree:\n(existing branch is checked out, new branch is created)',
          defaultValue: baseName(wtPath),
          buttons: [{ id: 'ok', label: 'Create', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-worktree-branch';
        state.pendingDialogTarget = wtPath;
      }
      return;
    }
    if (action === 'new-worktree-branch') {
      if (buttonId === 'ok' && params.value != null) {
        const branchName = params.value.trim();
        if (!branchName) {
          showError('Branch cannot be empty');
          return;
        }
        const wtAddOp = startSpinner('Creating worktree...', [REFS, CONFIG]);
        const exists = await gitBranchExists(state.cwd, branchName);
        const err = await gitWorktreeAdd(state.cwd, target, branchName, !exists);
        await afterGitOp(err, 'Worktree add', { metadataOnly: true }, wtAddOp);
      }
      return;
    }
    if (action === 'remove-worktree-confirm') {
      if ((buttonId === 'remove' || buttonId === 'force') && target) {
        const wtRmOp = startSpinner('Removing worktree...', [REFS, CONFIG]);
        const err = await gitWorktreeRemove(state.cwd, target, buttonId === 'force');
        await afterGitOp(err, 'Worktree remove', { metadataOnly: true }, wtRmOp);
      }
      return;
    }
    if (action === 'clean-confirm') {
      if (buttonId === 'clean') {
        const cleanOp = startSpinner('Cleaning...', WORKTREE_SCOPES);
        const err = await gitCleanUntrackedAsync(state.cwd);
        await afterGitOp(err, 'Clean', { statusOnly: true }, cleanOp);
      }
      return;
    }
    if (action === 'discard-all-confirm') {
      if (buttonId === 'discard_all') {
        const discardAllOp = startSpinner('Discarding all changes...', WORKTREE_SCOPES);
        const err = await gitDiscardAllChangesAsync(state.cwd);
        await afterGitOp(err, 'Discard all changes', { statusOnly: true }, discardAllOp);
      }
      return;
    }
    // Clone 2단계: URL → 대상 폴더 선택
    if (action === 'clone-url') {
      if (buttonId === 'ok' && params.value != null) {
        const cloneUrl = params.value.trim();
        if (!cloneUrl) {
          showError('URL cannot be empty');
          return;
        }
        if (ui.stopGitWatcher) ui.stopGitWatcher();
        const result = await hecaton.picker.folder({ title: 'Select Destination Folder', default_path: state.cwd || '' });
        if (!result || !result.path) {
          if (ui.setupGitWatcher) ui.setupGitWatcher();
          return;
        }
        const repoName = cloneUrl.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '') || 'repo';
        const cloneOp = startSpinner('Cloning ' + repoName + '...');
        const err = await gitCloneAsync(result.path, cloneUrl, repoName);
        stopSpinner(cloneOp);
        if (err) {
          if (ui.setupGitWatcher) ui.setupGitWatcher();
          showError('Clone failed:\n' + err);
          return;
        }
        const sep = result.path.includes('\\') ? '\\' : '/';
        await openRepositoryAt(result.path.replace(/[\\/]+$/, '') + sep + repoName);
      }
      return;
    }

    // Step 1 of add remote: got the name, now ask for URL
    if (action === 'new-remote-name' && buttonId === 'ok' && params.value != null) {
      const remoteName = params.value.trim();
      if (!remoteName) {
        showError('Remote name cannot be empty');
        return;
      }
      hecaton.dialog.show({
        type: 'input',
        title: 'Add Remote',
        message: 'Enter URL for \'' + remoteName + '\':',
        defaultValue: '',
        buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
      });
      state.pendingDialogAction = 'new-remote-url';
      state.pendingDialogTarget = remoteName;
      return;
    }

    // Step 2 of add remote: got the URL, execute
    if (action === 'new-remote-url' && buttonId === 'ok' && params.value != null) {
      const remoteUrl = params.value.trim();
      if (!remoteUrl) {
        showError('Remote URL cannot be empty');
        return;
      }
      const addRemoteOp = startSpinner('Adding remote...', [CONFIG]);
      const err = await gitRemoteAdd(state.cwd, target, remoteUrl);
      await afterGitOp(err, 'Remote', {}, addRemoteOp);
      return;
    }

    if (buttonId === 'ok' && params.value != null) {
      const name = params.value.trim();
      if (!name) {
        showError('Name cannot be empty');
        return;
      }
      const opName = action === 'rename-branch' ? 'Rename branch'
        : action === 'rename-stash' ? 'Rename stash'
        : action === 'new-branch' ? 'Branch'
        : 'Tag';
      // 리네임은 ref(와 딸린 config 섹션)만 옮긴다 — 인덱스도 워킹트리도 그대로이므로
      // 도는 동안 스테이징을 막을 이유가 없다. 브랜치 생성은 runCreateBranch 에서
      // 체크아웃까지 이어질 수 있어 밝히지 않는다(= 전부 붙잡은 것으로 본다).
      const opScopes = action === 'rename-branch' ? [REFS, CONFIG]
        : action === 'rename-stash' ? [STASH]
        : action === 'new-tag' ? [REFS]
        : null;
      const nameOp = startSpinner(opName + '...', opScopes);
      let err;
      if (action === 'rename-branch') {
        const renameRes = await gitRenameBranch(state.cwd, target, name);
        // ref 가 옮겨졌으면 config 갱신이 실패했더라도 핀은 새 이름을 따라가야 한다
        // 핀도 필터 지정도 이름으로 물려 있어 함께 옮긴다
        if (renameRes.renamed) {
          renamePinnedBranch(target, name);
          renameRef(localRefKey(target), localRefKey(name));
        }
        err = renameRes.error;
      } else if (action === 'rename-stash') {
        err = await gitStashRename(state.cwd, target, name);
      } else if (action === 'new-branch') {
        await runCreateBranch(name, target, opName, nameOp);
        return;
      } else if (action === 'new-tag') {
        err = await gitCreateTag(state.cwd, name, target);
      }
      await afterGitOp(err, opName, {}, nameOp);
    }
    return;
  }

  // Operation menu dialog result (rebase/merge/cherry-pick/revert)
  if (state.pendingRebaseMenu) {
    state.pendingRebaseMenu = false;
    const op = state.operationState;
    const opType = op ? op.type : 'rebase-merge';
    const isRebase = opType === 'rebase-merge' || opType === 'rebase-apply';
    if (buttonId !== 'continue' && buttonId !== 'abort' && buttonId !== 'skip') return;
    // 확인창이 떠 있는 사이에 작업이 끝났거나(다른 창에서 abort) 다른 쓰기가 시작됐을
    // 수 있다. op-abort 계열은 진행 중인 작업이 있어야만 성립하므로 그것까지 함께 본다.
    if (!guardDeferredAction(buttonId === 'skip' ? 'op-skip' : 'op-abort')) { render(); return; }
    // 같은 continue/abort/skip 을 'b' 메뉴나 타이틀 버튼으로 하면 진행 표시가 켜지고
    // 그동안 다른 쓰기가 막힌다. 이 다이얼로그 경로만 그러지 않으면 같은 명령인데
    // 들어온 문이 다르다는 이유로 보호가 사라진다 — 인덱스·워킹트리·ref 를 통째로
    // 옮기는 명령이므로 그 사이 스테이징이나 커밋이 끼어들면 안 된다.
    const opLabel = operationLabel(opType);
    const menuOpLabel = buttonId === 'continue' ? opLabel + ' continue...'
      : buttonId === 'abort' ? 'Aborting ' + opLabel.toLowerCase() + '...'
      : opLabel + ' skip...';
    const menuOp = startSpinner(menuOpLabel, CHECKOUT_SCOPES);
    let err;
    if (buttonId === 'continue') {
      if (isRebase) err = await gitRebaseContinue(state.cwd);
      else if (opType === 'merge') err = await gitMergeContinue(state.cwd);
      else if (opType === 'cherry-pick') err = await gitCherryPickContinue(state.cwd);
      else if (opType === 'revert') err = await gitRevertContinue(state.cwd);
    } else if (buttonId === 'abort') {
      if (isRebase) err = await gitRebaseAbort(state.cwd);
      else if (opType === 'merge') err = await gitMergeAbort(state.cwd);
      else if (opType === 'cherry-pick') err = await gitCherryPickAbort(state.cwd);
      else if (opType === 'revert') err = await gitRevertAbort(state.cwd);
    } else if (buttonId === 'skip') {
      if (isRebase) err = await gitRebaseSkip(state.cwd);
      else if (opType === 'cherry-pick') err = await gitCherryPickSkip(state.cwd);
      else if (opType === 'revert') err = await gitRevertSkip(state.cwd);
    }
    refreshAsync().then(() => {
      if (state.rightView === 'log') refreshLog();
      stopSpinner(menuOp);
      if (err && isRebaseConflictError(err)) {
        // Conflict on continue/skip — show info dialog and switch to diff view
        if (state.rightView !== 'diff') {
          state.rightView = 'diff';
          updateDiff();
        }
        render();
      } else if (err) {
        showError(err);
      } else {
        render();
      }
    });
    return;
  }

  // Committer input dialog result
  if (state.pendingCommitterEdit && buttonId === 'ok' && params.value != null) {
    const field = state.pendingCommitterEdit;
    state.pendingCommitterEdit = null;
    if (!guardDeferredAction(field === 'name' ? 'committer-name' : 'committer-email')) { render(); return; }
    const configKey = field === 'name' ? 'user.name' : 'user.email';
    const val = params.value.trim();
    if (val) {
      // .git/config.lock 을 잡는다 — 같은 CONFIG 를 쓰는 작업과 겹치면 실패한다.
      const setOp = startSpinner('Setting committer...', [CONFIG]);
      const err = await gitSetConfig(state.cwd, configKey, val);
      if (err) {
        stopSpinner(setOp);
        showError('Set ' + field + ' failed:\n' + err);
      } else {
        // 방금 내가 바꾼 값이다 — TTL 을 기다리지 않고 다음 refresh 가 바로 다시 읽게 한다.
        invalidateCommitterCache();
        refreshInBackground({}, { message: 'Setting committer...', settle: true, scopes: setOp.scopes });
        stopSpinner(setOp);
      }
    }
    return;
  }
  if (state.pendingCommitterEdit) {
    state.pendingCommitterEdit = null;
    return;
  }
  if (state.pendingStash && buttonId === 'stash_confirm') {
    state.pendingStash = false;
    if (!guardDeferredAction('git-stash')) { render(); return; }
    const stashOp = startSpinner('Stashing...', STASH_SCOPES);
    gitStashSaveAsync(state.cwd).then(async stashErr => {
      if (stashErr) {
        stopSpinner(stashOp);
        showError('Stash failed:\n' + stashErr);
      } else {
        await refreshAsync();
        stopSpinner(stashOp);
        render();
      }
    });
    return;
  }
  if (state.pendingStash) {
    state.pendingStash = false;
    return;
  }
  // 로컬 변경에 막힌 브랜치 생성 — stash 로 워킹트리를 비우고 다시 만든 뒤 되돌린다.
  if (state.pendingStashCreateBranch) {
    const req = state.pendingStashCreateBranch;
    state.pendingStashCreateBranch = null;
    if (buttonId !== 'stash_create_branch') {
      render();
      return;
    }
    if (!guardDeferredAction('new_branch')) { render(); return; }
    const label = req.opName + '...';
    (async () => {
      // stash → 브랜치 생성(체크아웃) → stash 복원. 세 단계가 인덱스·워킹트리·ref·
      // 스태시를 차례로 옮기므로 처음부터 넷 다 붙잡은 채로 간다.
      const seqOp = startSpinner(label + ' (1/3) Stashing', STASH_REWRITE_SCOPES);
      const stashErr = await gitStashSaveAsync(state.cwd);
      if (stashErr) {
        stopSpinner(seqOp);
        showError('Stash failed:\n' + stashErr);
        return;
      }
      updateSpinner(label + ' (2/3) Creating branch', seqOp);
      const createErr = await gitCreateBranch(state.cwd, req.name, req.startPoint);
      if (createErr) {
        // 브랜치가 만들어지지 않았으니 원래 자리에서 그대로 되돌려 놓는다.
        updateSpinner(label + ' (3/3) Restoring stash', seqOp);
        await gitStashPopAsync(state.cwd);
        await refreshAsync();
        stopSpinner(seqOp);
        if (state.rightView === 'log') refreshLog();
        showError(req.opName + ' failed:\n' + createErr);
        return;
      }
      updateSpinner(label + ' (3/3) Restoring stash', seqOp);
      const popErr = await gitStashPopAsync(state.cwd);
      await refreshAsync();
      stopSpinner(seqOp);
      if (state.rightView === 'log') refreshLog();
      if (popErr) {
        // 브랜치는 만들어졌고 변경분은 stash 에 남아 있다 — 유실이 아니라는 점을 알린다.
        showError("Branch '" + req.name + "' was created, but restoring your changes failed:\n"
          + popErr + '\n\nYour changes are still saved in the stash.');
      } else {
        render();
      }
    })();
    return;
  }
  // no-op 안내에서 고른 되돌리기 — 브랜치를 그 리비전으로 옮긴다(앞선 커밋은 떨어져 나간다).
  if (state.pendingRebaseRef && buttonId === 'rebase_reset_hard') {
    const ref = state.pendingRebaseRef;
    state.pendingRebaseRef = null;
    if (!guardDeferredAction('reset')) { render(); return; }
    const resetOp = startSpinner('Resetting...', CHECKOUT_SCOPES);
    gitResetAsync(state.cwd, ref).then(async err => { await afterGitOp(err, 'Reset', {}, resetOp); });
    return;
  }
  if (state.pendingRebaseRef && buttonId === 'rebase_proceed') {
    const ref = state.pendingRebaseRef;
    state.pendingRebaseRef = null;
    if (!guardDeferredAction('rebase')) { render(); return; }
    const rebaseOp = startSpinner('Rebasing...', CHECKOUT_SCOPES);
    gitRebaseAsync(state.cwd, ref).then(async err => {
      await refreshAsync();
      stopSpinner(rebaseOp);
      if (state.rightView === 'log') refreshLog();
      if (err && isStaleRebaseError(err)) {
        state.pendingRebaseRef = ref;
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
        if (state.rightView !== 'diff') {
          state.rightView = 'diff';
          updateDiff();
        }
        render();
      } else if (err) {
        showError(err);
      } else {
        render();
      }
    });
    return;
  }
  if (state.pendingRebaseRef && buttonId === 'abort_retry_rebase') {
    const ref = state.pendingRebaseRef;
    state.pendingRebaseRef = null;
    // 중단된 rebase 를 스스로 걷어내고 다시 시도하는 길이다 — 그 rebase 를 이유로
    // 막으면 빠져나올 방법이 없어진다. 자원 겹침만 본다.
    if (!guardDeferredAction('rebase', { allowDuringOperation: true })) { render(); return; }
    (async () => {
      const retryOp = startSpinner('Aborting stale rebase...', CHECKOUT_SCOPES);
      await gitRebaseAbort(state.cwd);
      updateSpinner('Retrying rebase...', retryOp);
      const retryErr = await gitRebaseAsync(state.cwd, ref);
      await refreshAsync();
      stopSpinner(retryOp);
      if (state.rightView === 'log') refreshLog();
      if (retryErr && isRebaseConflictError(retryErr)) {
        if (state.rightView !== 'diff') {
          state.rightView = 'diff';
          updateDiff();
        }
        render();
      } else if (retryErr) {
        showError('Rebase failed:\n' + retryErr);
      } else {
        render();
      }
    })();
    return;
  }
  if (state.pendingRebaseRef && buttonId === 'stash_rebase') {
    const ref = state.pendingRebaseRef;
    state.pendingRebaseRef = null;
    // 중단된 rebase 를 스스로 걷어내는 단계를 품고 있다 — allowDuringOperation.
    if (!guardDeferredAction('rebase', { allowDuringOperation: true })) { render(); return; }
    (async () => {
      // stash → rebase → stash 복원. 인덱스·워킹트리·ref·스태시를 차례로 옮긴다.
      const srOp = startSpinner('Stash & Rebase... (1/3) Stashing', STASH_REWRITE_SCOPES);
      const stashErr = await gitStashSaveAsync(state.cwd);
      if (stashErr) {
        stopSpinner(srOp);
        showError('Stash failed:\n' + stashErr);
        return;
      }
      updateSpinner('Stash & Rebase... (2/3) Rebasing', srOp);
      let rebaseErr = await gitRebaseAsync(state.cwd, ref);
      if (rebaseErr && isStaleRebaseError(rebaseErr)) {
        updateSpinner('Stash & Rebase... (2/3) Aborting stale rebase & retrying', srOp);
        await gitRebaseAbort(state.cwd);
        rebaseErr = await gitRebaseAsync(state.cwd, ref);
      }
      if (rebaseErr && isRebaseConflictError(rebaseErr)) {
        await refreshAsync();
        stopSpinner(srOp);
        if (state.rightView === 'log') refreshLog();
        if (state.rightView !== 'diff') {
          state.rightView = 'diff';
          updateDiff();
        }
        render();
        return;
      }
      if (rebaseErr) {
        updateSpinner('Stash & Rebase... (3/3) Restoring stash', srOp);
        await gitStashPopAsync(state.cwd);
        await refreshAsync();
        stopSpinner(srOp);
        if (state.rightView === 'log') refreshLog();
        showError('Rebase failed:\n' + rebaseErr);
        return;
      }
      updateSpinner('Stash & Rebase... (3/3) Restoring stash', srOp);
      const popErr = await gitStashPopAsync(state.cwd);
      await refreshAsync();
      stopSpinner(srOp);
      if (state.rightView === 'log') refreshLog();
      if (popErr) {
        showError('Rebase succeeded, but stash pop failed:\n' + popErr);
      } else {
        render();
      }
    })();
  } else {
    state.pendingRebaseRef = null;
  }
}

async function runCherryPickFromDialog(ref, commitImmediately) {
  if (commitImmediately) {
    const cpOp = startSpinner('Cherry-picking...', CHECKOUT_SCOPES);
    gitCherryPickAsync(state.cwd, ref).then(async err => { await afterGitOp(err, 'Cherry-pick', {}, cpOp); });
    return;
  }

  // --no-commit 은 HEAD 를 옮기지 않는다 — 인덱스와 워킹트리에만 얹는다.
  const cpNoCommitOp = startSpinner('Cherry-picking without commit...', WORKTREE_SCOPES);
  try {
    const message = await gitCommitMessage(state.cwd, ref);
    const err = await gitCherryPickNoCommitAsync(state.cwd, ref);
    await refreshAsync();
    stopSpinner(cpNoCommitOp);

    if (err && isRebaseConflictError(err)) {
      if (state.rightView !== 'diff') state.rightView = 'diff';
      updateDiff();
      render();
      return;
    }
    if (err) {
      showError('Cherry-pick failed:\n' + err);
      return;
    }

    state.rightView = 'diff';
    state.mode = 'commit';
    state.commitAmend = false;
    state.commitMsg = message;
    state.commitCursor = message.length;
    state.diffScrollOffset = 0;
    state.diffScrollX = 0;
    updateDiff();
    render();
  } catch (e) {
    stopSpinner(cpNoCommitOp);
    showError('Cherry-pick failed:\n' + ((e && e.message) || e || 'Operation failed'));
  }
}

// 히스토리 Filter/Hide 를 바꾼 뒤 화면에 반영한다. 지정은 순수 UI 상태라 git 을 다시
// 부르지 않는다 — 캐시된 커밋으로 그래프만 다시 만들고(rebuildLogGraphRows) render()가
// 저장까지 맡는다. 캐시가 아직 없으면(로그를 한 번도 안 읽었으면) 그때만 refreshLog 로
// 채우고, 그것도 히스토리를 보고 있을 때만 한다 — 다른 탭에서 우클릭했다고 로그를
// 새로 읽을 이유가 없다(다음에 탭을 열 때 어차피 읽는다).
function applyRefFilterChange() {
  const rebuilt = rebuildLogGraphRows();
  if (state.rightView === 'log') {
    if (rebuilt) updateLogDetail();
    else refreshLog();
  }
  render();
}

function hasLocalChanges() {
  return state.staged.length > 0 || state.unstaged.length > 0;
}

// 다른 경로의 저장소로 전환 (탭 변경/worktree 열기/clone 완료 공용)
async function openRepositoryAt(path) {
  if (ui.stopGitWatcher) ui.stopGitWatcher();
  // 폴더 선택/worktree 열기로 하위 디렉터리가 들어와도 워크트리 루트로 맞춘다 —
  // git 출력 경로(루트 기준)와 pathspec 해석 기준(cwd)이 어긋나면 파일 조작이 전부 실패한다.
  path = await resolveWorkTreeRoot(path);
  state.cwd = path;
  await require('./persist').attachRepo(path);
  state.isGitRepo = false;
  state.error = null;
  state.branch = '';
  state.gitDir = '';
  state.gitCommonDir = '';
  state.worktrees = [];
  state.isLinkedWorktree = false;
  state.staged = [];
  state.unstaged = [];
  state.untracked = [];
  state.ignored = [];
  state.ignoredLoaded = false;
  state.ignoredLoading = false;
  state.diffLines = [];
  state.currentDiffFile = null;
  state.logEntries = [];
  state.logCursor = 0;
  state.logScrollOffset = 0;
  state.diffScrollOffset = 0;
  render();
  await refreshAsync();
  if (state.rightView === 'log') { refreshLog(); updateLogDetail(); }
  if (state.rightView === 'fresh') { refreshFresh(); updateFreshDetail(); }
  render();
  if (ui.setupGitWatcher) ui.setupGitWatcher();
}

// 히스토리 재작성(reword/squash/fixup/drop/edit) 공통 실행기.
// 충돌이 나면 diff 뷰로 전환해 기존 rebase continue/abort UI([b] 메뉴)로 이어간다.
async function runHistoryRewrite(opName, fn) {
  // reword/squash/fixup/drop/edit 은 전부 rebase 로 도는 재작성이다 —
  // 인덱스·워킹트리·ref 를 함께 옮긴다.
  const rewriteOp = startSpinner(opName + '...', CHECKOUT_SCOPES);
  let err = null;
  try {
    err = await fn();
  } catch (e) {
    err = (e && e.message) || 'Operation failed';
  }
  await refreshAsync();
  stopSpinner(rewriteOp);
  if (state.rightView === 'log') refreshLog();
  if (err && isRebaseConflictError(err)) {
    if (state.rightView !== 'diff') {
      state.rightView = 'diff';
      updateDiff();
    }
    render();
  } else if (err) {
    showError(opName + ' failed:\n' + err);
  } else {
    render();
  }
}

// op 은 startSpinner 가 돌려준 작업 표다. 자원을 좁게 밝힌 작업은 다른 작업과 겹쳐
// 돌 수 있으므로 반드시 넘겨야 한다 — 넘기지 않으면 stopSpinner 가 "가장 나중에
// 시작된 작업"을 끝내므로, 겹친 상대를 대신 끝내 버린다.
async function afterGitOp(err, opName, refreshOpts = {}, op = null) {
  if (!state.spinnerActive) state.error = null;
  // git 명령 자체는 대개 수십 ms 만에 끝나고, 결과를 화면에 반영하는 refresh가 그보다
  // 훨씬 오래 걸린다. 라벨을 넘기지 않으면 사용자가 보는 거의 모든 시간 동안
  // "Refreshing..."만 떠서 정작 무슨 작업이었는지 알 수 없다. 후속 갱신까지가 한 동작이다.
  // 실패한 경우엔 이름을 잇지 않는다 — 되돌아간 상태를 다시 읽는 것뿐이고,
  // 무슨 일이 있었는지는 곧 뜨는 오류 창이 말해 준다.
  // settle: 이 갱신이 끝나야 목록이 작업 결과를 반영한다 — 그때까지는 새 쓰기를 받지 않는다.
  // 실패한 경우엔 저장소가 그대로라 목록도 낡지 않았으므로 걸지 않는다.
  const followup = { refreshLog: !refreshOpts.statusOnly };
  if (!err) {
    followup.message = opName + '...';
    followup.settle = true;
    // 뒷정리가 막을 범위는 방금 끝난 작업과 같다. op 을 알면 그대로 물려주고,
    // 모르면 아직 살아 있는 작업의 것을 startSettleOp 가 알아서 가져간다.
    if (op) followup.scopes = op.scopes;
  }
  // stopSpinner 보다 먼저 건다. 순서를 뒤집으면 스피너 참조가 잠깐 0이 되어
  // 두 표시 사이에서 제목이 한 번 맨 상태로 떨어졌다 돌아온다.
  refreshInBackground(refreshOpts, followup);
  stopSpinner(op);
  if (err) showError(opName + ' failed:\n' + err);
}

function showError(msg) {
  // 쓰기 작업이 진행 중이면 힌트바의 진행 메시지를 지우지 않는다
  // (읽기 액션의 안내 다이얼로그가 작업 표시를 덮어쓰는 것 방지).
  if (!state.spinnerActive) state.error = null;
  hecaton.dialog.show({
    type: 'message',
    title: 'Error',
    message: msg,
    buttons: [{ id: 'ok', label: 'OK', default: true }],
  });
  render();
}

function isStaleRebaseError(err) {
  return err && (err.includes('rebase-merge') || err.includes('rebase-apply'));
}

// 해시는 짧게, 브랜치/태그 이름은 그대로 보여준다.
function shortRefLabel(ref) {
  return /^[0-9a-f]{20,40}$/i.test(ref) ? ref.substring(0, 8) : ref;
}

// 대상이 이미 HEAD 의 조상이면 git rebase 는 "up to date" 만 남기고 조용히 끝난다.
// 사용자 눈에는 스피너만 돌다 아무 일도 안 일어난 것으로 보이므로,
// 실행하지 않고 이유를 알린 뒤 실제로 의도했을 동작(그 리비전으로 되돌리기)을 제시한다.
function showRebaseNoopDialog(ref) {
  const short = shortRefLabel(ref);
  const branch = state.branch || 'HEAD';
  state.pendingRebaseRef = ref;
  hecaton.dialog.show({
    type: 'message',
    title: 'Rebase',
    message: "'" + short + "' is already an ancestor of '" + branch + "'.\n"
      + 'There are no commits to move, so rebase would do nothing.\n\n'
      + 'Reset moves ' + branch + ' back to ' + short + '.\n'
      + 'The commits ahead leave the branch (recoverable via reflog).',
    buttons: [
      { id: 'rebase_reset_hard', label: 'Reset', default: true, style: 'success' },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  render();
}

function isRebaseConflictError(err) {
  return err && (err.includes('could not apply') || err.includes('Resolve all conflicts') || err.includes('CONFLICT') || err.includes('fix conflicts') || err.includes('needs merge'));
}

function isBranchNotFullyMergedError(err) {
  return !!(err && /not fully merged/i.test(err));
}

// `git checkout -b` 는 브랜치 생성과 체크아웃을 함께 한다. 기준점이 HEAD 와 다르면
// 실제 체크아웃이 일어나므로, 수정 중인 파일의 내용이 두 커밋 사이에서 다르면 git 이 거부한다.
// 이때 git 은 브랜치를 만들지 않고 워킹트리도 건드리지 않은 채 중단하므로, stash 후 재시도가 안전하다.
function isCheckoutOverwriteError(err) {
  return !!(err && /would be overwritten by (checkout|merge)/i.test(err));
}

function showStashCreateBranchDialog(name, startPoint, opName, err) {
  state.pendingStashCreateBranch = { name, startPoint, opName };
  hecaton.dialog.show({
    type: 'message',
    title: opName,
    message: 'Your local changes would be overwritten by checking out this branch.\n'
      + 'Would you like to stash them, create the branch, and then reapply?\n\n' + err,
    buttons: [
      { id: 'stash_create_branch', label: 'Stash & Create', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  render();
}

// 브랜치 생성의 공통 실행 경로 — 로컬 변경에 막힌 경우에만 stash 재시도를 제안한다.
// 그 외에는 평소대로 성공/실패 처리하므로, 기준점이 HEAD 와 같은 흔한 경우엔 확인창이 끼어들지 않는다.
// op 은 호출부가 이미 켜 둔 진행 표시다(이 함수는 시작하지 않고 끝내기만 한다).
async function runCreateBranch(name, startPoint, opName, op = null) {
  const err = await gitCreateBranch(state.cwd, name, startPoint);
  if (isCheckoutOverwriteError(err)) {
    stopSpinner(op);
    showStashCreateBranchDialog(name, startPoint, opName, err);
    return;
  }
  await afterGitOp(err, opName, {}, op);
}

// 체크아웃하지 않은 브랜치에 Pull을 눌렀을 때 — 왜 그대로는 안 되는지 알리고,
// 같은 의도를 이루는 두 명령 중에서 고르게 한다.
//   Fast-Forward   : git fetch <remote> <upstream>:<branch>
//                    ref만 옮긴다. 워킹트리·현재 브랜치를 건드리지 않지만 갈라졌으면 거절된다.
//   Checkout & Pull: git checkout <branch> && git pull [--rebase] <remote> <upstream>
//                    진짜 pull이라 갈라져도 병합/리베이스로 합칠 수 있지만 워킹트리가 바뀐다.
function showPullOtherBranchDialog(branchName, upstream, rebase) {
  const branch = state.branches.find(b => b.name === branchName);
  const ahead = branch ? (branch.ahead || 0) : 0;
  const behind = branch ? (branch.behind || 0) : 0;
  const current = state.branch || 'HEAD';

  // 다른 워크트리가 잡고 있으면 두 선택지 모두 git이 거절한다 — 고르게 하지 않고 알려만 준다.
  const holder = state.worktrees.find(w => !w.isCurrent && w.branch === branchName);
  if (holder) {
    showError("'" + branchName + "' is checked out in another worktree:\n" + holder.path
      + '\n\nUpdate it from that worktree — git refuses to move a branch that is checked out elsewhere.');
    return;
  }

  let situation;
  if (behind === 0 && ahead === 0) situation = "'" + branchName + "' already matches '" + upstream + "'.";
  else if (ahead > 0 && behind > 0) {
    situation = "'" + branchName + "' has diverged from '" + upstream + "' (↑" + ahead + ' ↓' + behind + ')'
      + '\nFast-Forward will be refused — only Checkout & Pull can merge the two sides.';
  } else if (behind > 0) situation = "'" + branchName + "' is ↓" + behind + " behind '" + upstream + "' and can be fast-forwarded.";
  else situation = "'" + branchName + "' is ↑" + ahead + " ahead of '" + upstream + "' — nothing to receive.";

  const pullLabel = rebase ? 'Checkout & Pull (Rebase)' : 'Checkout & Pull';
  hecaton.dialog.show({
    type: 'message',
    title: rebase ? "Pull '" + branchName + "' with Rebase" : "Pull '" + branchName + "'",
    message: "git pull always merges into the checked-out branch, so it would update '" + current
      + "' instead of '" + branchName + "'.\n\n" + situation
      + '\n\nFast-Forward moves the branch without touching your working tree.\n'
      + pullLabel + " switches to '" + branchName + "' first, then pulls.",
    buttons: [
      { id: 'ff', label: 'Fast-Forward', default: !(ahead > 0 && behind > 0) },
      { id: 'checkout_pull', label: pullLabel, default: ahead > 0 && behind > 0 },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  state.pendingDialogAction = rebase ? 'pull-other-branch-rebase' : 'pull-other-branch';
  state.pendingDialogTarget = branchName;
}

function showForceDeleteBranchDialog(branchName, err) {
  hecaton.dialog.show({
    type: 'message',
    title: 'Delete Branch',
    message: "Branch '" + branchName + "' is not fully merged into the current branch.\n\nForce delete it anyway?\n\n" + err,
    buttons: [
      { id: 'force', label: 'Force Delete', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  state.pendingDialogAction = 'delete-branch';
  state.pendingDialogTarget = branchName;
  render();
}

function copyToClipboard(text) {
  hecaton.clipboard.write({ text }).catch(() => null);
}

async function openExternal(fullPath) {
  try {
    let program, args;
    if (process.platform === 'win32') {
      program = 'cmd'; args = ['/c', 'start', '', fullPath];
    } else if (process.platform === 'darwin') {
      program = 'open'; args = [fullPath];
    } else {
      program = 'xdg-open'; args = [fullPath];
    }
    const r = await hecaton.process.exec({ program, args, timeout_ms: 5000 });
    if (r && r.ok) return null;
    return (r && r.error) || 'Failed to open file';
  } catch (e) {
    return e.message || 'Failed to open file';
  }
}

async function showInExplorer(fullPath) {
  const result = await hecaton.fs.reveal({ path: fullPath }).catch(() => null);
  if (!result || !result.ok) {
    return (result && result.error) || 'Failed to show file';
  }
  return null;
}

module.exports = {
  buildHistoryContextMenuItems,
  buildStashContextMenuItems,
  buildFileContextMenuItems,
  buildRemotesContextMenuItems,
  buildPushRemoteMenuItems,
  buildRemoteBranchContextMenuItems,
  buildBranchContextMenuItems,
  buildBranchTrackingMenuItems,
  buildHistoryBranchMenuItems,
  buildTabContextMenuItems,
  buildWorktreeContextMenuItems,
  handleContextMenuAction,
  handleDialogResult,
  runCreateBranch,
  isCheckoutOverwriteError,
};
