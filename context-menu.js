const { state, ui } = require('./state');
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
  gitStage, gitUnstage, gitStageAll, gitDiscardFile, gitRemoveFromRepo,
  gitStashFile, gitStashFiles, gitIgnorePattern, gitFileHistory, gitBlameFile, gitFilePatch,
  gitSetConfig, gitCreateBranch, gitCreateTag, gitRemoteAdd,
  gitRenameBranch, gitDeleteBranch, gitSetUpstream, gitUnsetUpstream, gitGetRemoteUrl,
  gitMergeAsync, gitRebaseAsync, gitResetAsync, gitCheckoutRefAsync,
  gitCherryPickAsync, gitCherryPickNoCommitAsync, gitRevertAsync, gitStashSaveAsync, gitStashPopAsync,
  gitStageAsync, gitUnstageAsync, gitStageMultiple, gitUnstageMultiple,
  gitMergeFastForwardAsync, gitPushToRemoteAsync, gitPullFromRemoteAsync,
  gitCheckRebaseConflicts, gitCheckoutOurs, gitCheckoutTheirs, gitCommitMessage,
  gitExec, gitResetModeAsync, gitRewordCommitAsync, gitSquashIntoParentAsync,
  gitDropCommitAsync, gitEditCommitAsync,
  gitPullRebaseAsync, gitForcePushAsync, gitPushDeleteBranchAsync,
  gitPushTagsAsync, gitPushTagAsync, gitPushDeleteTagAsync,
  gitRemoteRemove, gitRemoteRename, gitRemoteSetUrl, gitRemotePruneAsync,
  gitDeleteTag, gitCreateTagAnnotated, gitApplyPatchFromText,
  gitWorktreeAdd, gitWorktreeRemove, gitWorktreePruneAsync, gitBranchExists,
  gitInit, gitCloneAsync, gitCleanUntrackedAsync,
} = require('./git');
const { refreshAsync, refreshLog, selectedLogRef, updateLogDetail, refreshFresh, updateFreshDetail, updateDiff, refreshInBackground, applyStageToState, applyUnstageToState } = require('./refresh');
const { render } = require('./render');
const { startSpinner, stopSpinner } = require('./spinner');

function buildHistoryContextMenuItems() {
  const branch = state.branch || 'HEAD';

  // Branch submenu
  const branchChildren = state.branches
    .filter(b => !b.isCurrent)
    .slice(0, 20)
    .map(b => ({ id: 'checkout_branch:' + b.name, label: b.name }));

  const items = [];

  if (branchChildren.length > 0) {
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
    while ((tagMatch = tagRe.exec(selectedItem.decoration))) {
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

  return items;
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
  return items;
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

  return items;
}

function buildTabContextMenuItems() {
  const items = [
    { id: 'tab_refresh', label: 'Refresh' },
    { type: 'separator' },
    { id: 'tab_apply_patch', label: 'Apply Patch from Clipboard...' },
    { id: 'tab_clean', label: 'Remove All Untracked Files...', icon: 'warning' },
    { type: 'separator' },
    { id: 'tab_change_repo', label: 'Change Repository...' },
    { id: 'tab_clone', label: 'Clone Repository...' },
  ];
  if (!state.isGitRepo) {
    items.push({ id: 'tab_init', label: 'Init Repository Here' });
  }
  return items;
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
    items.push({ type: 'separator' });
    items.push({ id: 'worktree_copy_path', label: 'Copy Path', icon: 'copy' });
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
  if (upstream) {
    items.push({ id: 'branch_delete_remote', label: "Delete '" + upstream + "' on Remote...", icon: 'warning' });
  }

  items.push({ type: 'separator' });
  items.push(
    { id: 'branch_new_branch', label: 'New Branch...', shortcut: 'Ctrl+Shift+B' },
    { id: 'branch_new_tag', label: 'New Tag...', shortcut: 'Ctrl+Shift+T' },
  );

  const trackingChildren = state.remoteBranches.map(rb => ({
    id: 'branch_track:' + rb,
    label: rb + (rb === upstream ? ' (current)' : ''),
  }));
  if (upstream) {
    trackingChildren.push({ type: 'separator' });
    trackingChildren.push({ id: 'branch_untrack', label: 'Unset Upstream' });
  }
  if (trackingChildren.length > 0) {
    items.push({ id: 'branch_tracking', label: 'Tracking', children: trackingChildren });
  }

  items.push({ type: 'separator' });
  items.push(
    { id: 'branch_rename', label: "Rename '" + branchName + "'...", shortcut: 'F2' },
  );
  if (!branch.isCurrent) {
    items.push({ id: 'branch_delete', label: "Delete '" + branchName + "'...", shortcut: 'Delete' });
  }
  items.push({ type: 'separator' });
  items.push({ id: 'branch_copy_name', label: 'Copy Branch Name' });

  return items;
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
  return items;
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
  return items;
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
    { type: 'separator' },
    { id: 'remotebranch_copy_name', label: 'Copy Branch Name', icon: 'copy' },
  );

  return items;
}

async function handleContextMenuAction(actionId) {
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
    startSpinner('Applying patch...');
    const err = await gitApplyPatchFromText(state.cwd, patchText);
    await afterGitOp(err, 'Apply patch');
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

  if (actionId === 'tab_init') {
    startSpinner('Initializing repository...');
    const err = await gitInit(state.cwd);
    if (err) {
      stopSpinner();
      showError('Init failed:\n' + err);
      return;
    }
    stopSpinner();
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
    startSpinner('Pushing to ' + remote + '...');
    gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => {
      await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true });
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
        startSpinner('Pruning...');
        gitRemotePruneAsync(state.cwd, targetRemote).then(async err => { await afterGitOp(err, 'Prune', { metadataOnly: true }); });
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
        startSpinner('Pruning worktrees...');
        const err = await gitWorktreePruneAsync(state.cwd);
        await afterGitOp(err, 'Worktree prune', { metadataOnly: true });
        break;
      }
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
      startSpinner('Pushing tag...');
      gitPushTagAsync(state.cwd, tagRemote, tagName).then(async err => { await afterGitOp(err, 'Push tag', { metadataOnly: true }); });
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
            startSpinner('Staging...');
            const ok = await gitStageMultiple(state.cwd, files);
            if (!ok) {
              stopSpinner();
              showError('Stage failed');
              render();
            } else {
              stopSpinner();
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
            startSpinner('Unstaging...');
            const ok = await gitUnstageMultiple(state.cwd, files);
            if (!ok) {
              stopSpinner();
              showError('Unstage failed');
              render();
            } else {
              stopSpinner();
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
        startSpinner('Accepting ours...');
        (async () => {
          const files = fileItems.filter(item => item && item.status === 'U').map(item => item.file);
          for (const f of files) {
            const err = await gitCheckoutOurs(state.cwd, f);
            if (err) { showError(err); return; }
            await gitStageAsync(state.cwd, f);
          }
          await afterGitOp(null);
        })();
        break;
      }
      case 'file_accept_theirs': {
        startSpinner('Accepting theirs...');
        (async () => {
          const files = fileItems.filter(item => item && item.status === 'U').map(item => item.file);
          for (const f of files) {
            const err = await gitCheckoutTheirs(state.cwd, f);
            if (err) { showError(err); return; }
            await gitStageAsync(state.cwd, f);
          }
          await afterGitOp(null);
        })();
        break;
      }
      case 'file_stage_all': {
        const allFiles = [...state.unstaged.map(f => f.file), ...state.untracked.map(f => f.file)];
        if (allFiles.length === 0) break;
        startSpinner('Staging all...');
        const ok = await gitStageAll(state.cwd);
        if (!ok) {
          stopSpinner();
          showError('Stage all failed');
          render();
        } else {
          stopSpinner();
          applyStageToState(allFiles);
          refreshInBackground({ statusOnly: true });
        }
        break;
      }
      case 'file_ignore_name': {
        startSpinner('Ignoring...');
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const pattern = baseName(item.file);
          const oneErr = await gitIgnorePattern(state.cwd, pattern);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore');
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
        startSpinner('Ignoring...');
        let err = null;
        for (const ext of exts) {
          const oneErr = await gitIgnorePattern(state.cwd, '*' + ext);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_ignore_path': {
        startSpinner('Ignoring...');
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const relPath = item.file.replace(/\\/g, '/').replace(/^\/+/, '');
          const oneErr = await gitIgnorePattern(state.cwd, '/' + relPath);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_stash_one': {
        startSpinner('Stashing...');
        const files = fileItems.filter(item => item && item.file).map(item => item.file);
        let err;
        if (files.length === 1) {
          err = await gitStashFile(state.cwd, files[0]);
        } else if (files.length > 1) {
          err = await gitStashFiles(state.cwd, files);
        } else {
          err = 'No files selected';
        }
        await afterGitOp(err, 'Stash file');
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
        hecaton.overlay.open({ plugin_id: 'explorer', params: { path: dir } }).catch(() => null);
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
      case 'remotebranch_checkout_local':
        startSpinner('Checking out...');
        gitCheckoutRefAsync(state.cwd, localName).then(async err => { await afterGitOp(err, 'Checkout'); });
        break;
      case 'remotebranch_checkout_tracking': {
        startSpinner('Checking out...');
        const err = await gitCreateBranch(state.cwd, localName, remoteBranchName);
        await afterGitOp(err, 'Checkout');
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
          message: "Delete '" + remoteBranchName + "' on the remote?\n\nThis cannot be undone from this client.",
          buttons: [{ id: 'delete', label: 'Delete', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'delete-remote-branch-confirm';
        state.pendingDialogTarget = { remote: remoteName, branch: localName };
        break;
      }
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
      startSpinner('Setting upstream...');
      const err = await gitSetUpstream(state.cwd, branchName, remoteBranch);
      await afterGitOp(err, 'Set upstream');
      return;
    }

    switch (actionId) {
      case 'branch_checkout':
        startSpinner('Checking out...');
        gitCheckoutRefAsync(state.cwd, branchName).then(async err => { await afterGitOp(err, 'Checkout'); });
        break;
      case 'branch_ff':
        startSpinner('Fast-forwarding...');
        gitMergeFastForwardAsync(state.cwd, upstream).then(async err => { await afterGitOp(err, 'Fast-forward'); });
        break;
      case 'branch_pull':
        startSpinner('Pulling...');
        gitPullFromRemoteAsync(state.cwd, remote, branchName).then(async err => { await afterGitOp(err, 'Pull'); });
        break;
      case 'branch_pull_rebase':
        startSpinner('Pulling with rebase...');
        gitPullRebaseAsync(state.cwd, remote, branchName).then(async err => {
          if (err && isRebaseConflictError(err)) {
            await refreshAsync();
            stopSpinner();
            if (state.rightView === 'log') refreshLog();
            if (state.rightView !== 'diff') {
              state.rightView = 'diff';
              updateDiff();
            }
            render();
            return;
          }
          await afterGitOp(err, 'Pull (rebase)');
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
          message: "Delete '" + upstream + "' on the remote?\n\nThis cannot be undone from this client.",
          buttons: [{ id: 'delete', label: 'Delete', default: true, style: 'danger' }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'delete-remote-branch-confirm';
        state.pendingDialogTarget = { remote, branch: remoteBranchPart };
        break;
      }
      case 'branch_push':
        startSpinner('Pushing...');
        gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => { await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true }); });
        break;
      case 'branch_push_pr':
        startSpinner('Pushing...');
        gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => {
          if (err) { await afterGitOp(err, 'Push', { metadataOnly: true, forceMeta: true }); return; }
          const remoteUrl = await gitGetRemoteUrl(state.cwd, remote);
          const prUrl = buildPullRequestUrl(remoteUrl, branchName);
          if (prUrl) await openExternal(prUrl);
          await afterGitOp(null, 'Push', { metadataOnly: true, forceMeta: true });
        });
        break;
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
        const err = await gitUnsetUpstream(state.cwd, branchName);
        await afterGitOp(err, 'Unset upstream');
        break;
      }
      case 'branch_copy_name':
        copyToClipboard(branchName);
        break;
      case 'branch_rebase_onto': {
        // Pre-check for conflicts
        const conflictCheck = await gitCheckRebaseConflicts(state.cwd, branchName);
        if (conflictCheck.willConflict) {
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
        startSpinner('Rebasing...');
        gitRebaseAsync(state.cwd, branchName).then(async err => {
          await refreshAsync();
          stopSpinner();
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
      case 'branch_merge_into':
        startSpinner('Merging...');
        gitMergeAsync(state.cwd, branchName).then(async err => {
          await afterGitOp(err, 'Merge');
        });
        break;
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

  const logItem = selectedLogRef();
  if (!logItem) return;

  const hash = logItem.hash || logItem.ref;

  // Branch checkout from submenu
  if (actionId.startsWith('checkout_branch:')) {
    const branchName = actionId.substring('checkout_branch:'.length);
    const err = await gitCheckoutRef(state.cwd, branchName);
    await afterGitOp(err, 'Checkout');
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
      startSpinner('Merging...');
      gitMergeAsync(state.cwd, hash).then(async err => { await afterGitOp(err, 'Merge'); });
      break;
    }
    case 'rebase': {
      if (state.staged.length > 0 || state.unstaged.length > 0) {
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
        startSpinner('Rebasing...');
        gitRebaseAsync(state.cwd, hash).then(async err => {
          await refreshAsync();
          stopSpinner();
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
      startSpinner('Reverting...');
      gitRevertAsync(state.cwd, hash).then(async err => { await afterGitOp(err, 'Revert'); });
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

async function handleDialogResult(params) {
  const buttonId = params && params.button_id;

  // Name input dialog results (new-branch, new-tag, rename-stash, rename-branch, new-remote, delete-branch)
  if (state.pendingDialogAction) {
    const action = state.pendingDialogAction;
    const target = state.pendingDialogTarget || '';
    state.pendingDialogAction = null;
    state.pendingDialogTarget = null;

    // delete-branch is a message dialog with delete/force/cancel buttons
    if (action === 'delete-branch') {
      if (buttonId === 'delete') {
        startSpinner('Deleting branch...');
        const err = await gitDeleteBranch(state.cwd, target, false);
        if (!state.spinnerActive) state.error = null;
        await refreshAsync();
        if (state.rightView === 'log') refreshLog();
        stopSpinner();
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
        startSpinner('Deleting branch...');
        const err = await gitDeleteBranch(state.cwd, target, true);
        await afterGitOp(err, 'Delete branch');
      }
      return;
    }
    if (action === 'reset-confirm') {
      const resetMode = buttonId === 'reset_soft' ? 'soft'
        : buttonId === 'reset_mixed' ? 'mixed'
        : buttonId === 'reset_hard' ? 'hard'
        : null;
      if (resetMode) {
        startSpinner('Resetting (' + resetMode + ')...');
        gitResetModeAsync(state.cwd, target, resetMode).then(async err => { await afterGitOp(err, 'Reset'); });
      }
      return;
    }
    if (action === 'stash-drop-confirm') {
      if (buttonId === 'drop') {
        startSpinner('Deleting stash...');
        const err = await gitStashDrop(state.cwd, target);
        await afterGitOp(err, 'Stash delete');
      }
      return;
    }
    if (action === 'stash-apply-confirm') {
      if (buttonId === 'apply') {
        const deleteAfter = params.checkboxes && params.checkboxes.delete_after;
        startSpinner('Applying stash...');
        const err = await gitStashApply(state.cwd, target);
        if (!err && deleteAfter) {
          const dropErr = await gitStashDrop(state.cwd, target);
          await afterGitOp(dropErr, 'Stash apply & delete');
        } else {
          await afterGitOp(err, 'Stash apply');
        }
      }
      return;
    }
    if (action === 'discard-confirm') {
      if (buttonId === 'discard') {
        startSpinner('Discarding...');
        const files = state.pendingDiscardFiles || [];
        state.pendingDiscardFiles = null;
        let err = null;
        for (const item of files) {
          if (!item) continue;
          const oneErr = await gitDiscardFile(state.cwd, item);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Discard');
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
        startSpinner(keepLocal ? 'Removing...' : 'Deleting...');
        let err = null;
        for (const file of files) {
          if (!file) continue;
          const oneErr = await gitRemoveFromRepo(state.cwd, file, keepLocal);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, keepLocal ? 'Remove from version control' : 'Delete');
      }
      return;
    }
    if (action === 'checkout-commit-confirm') {
      if (buttonId === 'checkout') {
        startSpinner('Checking out...');
        gitCheckoutRefAsync(state.cwd, target).then(async err => { await afterGitOp(err, 'Checkout'); });
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
        startSpinner('Tag...');
        const err = tagMessage
          ? await gitCreateTagAnnotated(state.cwd, target.name, tagMessage, target.ref)
          : await gitCreateTag(state.cwd, target.name, target.ref);
        await afterGitOp(err, 'Tag');
      }
      return;
    }
    if (action === 'force-push-confirm') {
      if (buttonId === 'force_push' && target) {
        startSpinner('Force pushing...');
        gitForcePushAsync(state.cwd, target.remote, target.branch).then(async err => { await afterGitOp(err, 'Force push', { metadataOnly: true, forceMeta: true }); });
      }
      return;
    }
    if (action === 'delete-remote-branch-confirm') {
      if (buttonId === 'delete' && target) {
        startSpinner('Deleting remote branch...');
        gitPushDeleteBranchAsync(state.cwd, target.remote, target.branch).then(async err => { await afterGitOp(err, 'Delete remote branch', { metadataOnly: true }); });
      }
      return;
    }
    if (action === 'push-tags-confirm') {
      if (buttonId === 'proceed' && target) {
        startSpinner('Pushing tags...');
        gitPushTagsAsync(state.cwd, target).then(async err => { await afterGitOp(err, 'Push tags', { metadataOnly: true }); });
      }
      return;
    }
    if (action === 'remove-remote-confirm') {
      if (buttonId === 'remove' && target) {
        startSpinner('Removing remote...');
        const err = await gitRemoteRemove(state.cwd, target);
        await afterGitOp(err, 'Remove remote');
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
        startSpinner('Renaming remote...');
        const err = await gitRemoteRename(state.cwd, target, newName);
        await afterGitOp(err, 'Rename remote');
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
        startSpinner('Updating remote URL...');
        const err = await gitRemoteSetUrl(state.cwd, target, newUrl);
        await afterGitOp(err, 'Set remote URL');
      }
      return;
    }
    if (action === 'delete-tag-confirm') {
      if (buttonId === 'delete' && target) {
        startSpinner('Deleting tag...');
        const err = await gitDeleteTag(state.cwd, target);
        await afterGitOp(err, 'Delete tag');
      }
      return;
    }
    if (action === 'delete-remote-tag-confirm') {
      if (buttonId === 'delete' && target) {
        startSpinner('Deleting remote tag...');
        gitPushDeleteTagAsync(state.cwd, target.remote, target.tag).then(async err => { await afterGitOp(err, 'Delete remote tag', { metadataOnly: true }); });
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
        startSpinner('Creating worktree...');
        const exists = await gitBranchExists(state.cwd, branchName);
        const err = await gitWorktreeAdd(state.cwd, target, branchName, !exists);
        await afterGitOp(err, 'Worktree add', { metadataOnly: true });
      }
      return;
    }
    if (action === 'remove-worktree-confirm') {
      if ((buttonId === 'remove' || buttonId === 'force') && target) {
        startSpinner('Removing worktree...');
        const err = await gitWorktreeRemove(state.cwd, target, buttonId === 'force');
        await afterGitOp(err, 'Worktree remove', { metadataOnly: true });
      }
      return;
    }
    if (action === 'clean-confirm') {
      if (buttonId === 'clean') {
        startSpinner('Cleaning...');
        const err = await gitCleanUntrackedAsync(state.cwd);
        await afterGitOp(err, 'Clean', { statusOnly: true });
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
        startSpinner('Cloning ' + repoName + '...');
        const err = await gitCloneAsync(result.path, cloneUrl, repoName);
        stopSpinner();
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
      startSpinner('Adding remote...');
      const err = await gitRemoteAdd(state.cwd, target, remoteUrl);
      await afterGitOp(err, 'Remote');
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
      startSpinner(opName + '...');
      let err;
      if (action === 'rename-branch') {
        err = await gitRenameBranch(state.cwd, target, name);
      } else if (action === 'rename-stash') {
        err = await gitStashRename(state.cwd, target, name);
      } else if (action === 'new-branch') {
        err = await gitCreateBranch(state.cwd, name, target);
      } else if (action === 'new-tag') {
        err = await gitCreateTag(state.cwd, name, target);
      }
      await afterGitOp(err, opName);
    }
    return;
  }

  // Operation menu dialog result (rebase/merge/cherry-pick/revert)
  if (state.pendingRebaseMenu) {
    state.pendingRebaseMenu = false;
    const op = state.operationState;
    const opType = op ? op.type : 'rebase-merge';
    const isRebase = opType === 'rebase-merge' || opType === 'rebase-apply';
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
    } else {
      return;
    }
    refreshAsync().then(() => {
      if (state.rightView === 'log') refreshLog();
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
    const configKey = field === 'name' ? 'user.name' : 'user.email';
    const val = params.value.trim();
    if (val) {
      const err = await gitSetConfig(state.cwd, configKey, val);
      if (err) {
        showError('Set ' + field + ' failed:\n' + err);
      } else {
        refreshAsync().then(() => render());
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
    startSpinner('Stashing...');
    gitStashSaveAsync(state.cwd).then(async stashErr => {
      if (stashErr) {
        stopSpinner();
        showError('Stash failed:\n' + stashErr);
      } else {
        await refreshAsync();
        stopSpinner();
        render();
      }
    });
    return;
  }
  if (state.pendingStash) {
    state.pendingStash = false;
    return;
  }
  if (state.pendingRebaseRef && buttonId === 'rebase_proceed') {
    const ref = state.pendingRebaseRef;
    state.pendingRebaseRef = null;
    startSpinner('Rebasing...');
    gitRebaseAsync(state.cwd, ref).then(async err => {
      await refreshAsync();
      stopSpinner();
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
    (async () => {
      startSpinner('Aborting stale rebase...');
      await gitRebaseAbort(state.cwd);
      state.error = 'Retrying rebase...';
      const retryErr = await gitRebaseAsync(state.cwd, ref);
      await refreshAsync();
      stopSpinner();
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
    (async () => {
      startSpinner('Stash & Rebase... (1/3) Stashing');
      const stashErr = await gitStashSaveAsync(state.cwd);
      if (stashErr) {
        stopSpinner();
        showError('Stash failed:\n' + stashErr);
        return;
      }
      state.error = 'Stash & Rebase... (2/3) Rebasing';
      let rebaseErr = await gitRebaseAsync(state.cwd, ref);
      if (rebaseErr && isStaleRebaseError(rebaseErr)) {
        state.error = 'Stash & Rebase... (2/3) Aborting stale rebase & retrying';
        await gitRebaseAbort(state.cwd);
        rebaseErr = await gitRebaseAsync(state.cwd, ref);
      }
      if (rebaseErr && isRebaseConflictError(rebaseErr)) {
        await refreshAsync();
        stopSpinner();
        if (state.rightView === 'log') refreshLog();
        if (state.rightView !== 'diff') {
          state.rightView = 'diff';
          updateDiff();
        }
        render();
        return;
      }
      if (rebaseErr) {
        state.error = 'Stash & Rebase... (3/3) Restoring stash';
        await gitStashPopAsync(state.cwd);
        await refreshAsync();
        stopSpinner();
        if (state.rightView === 'log') refreshLog();
        showError('Rebase failed:\n' + rebaseErr);
        return;
      }
      state.error = 'Stash & Rebase... (3/3) Restoring stash';
      const popErr = await gitStashPopAsync(state.cwd);
      await refreshAsync();
      stopSpinner();
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
    startSpinner('Cherry-picking...');
    gitCherryPickAsync(state.cwd, ref).then(async err => { await afterGitOp(err, 'Cherry-pick'); });
    return;
  }

  startSpinner('Cherry-picking without commit...');
  try {
    const message = await gitCommitMessage(state.cwd, ref);
    const err = await gitCherryPickNoCommitAsync(state.cwd, ref);
    await refreshAsync();
    stopSpinner();

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
    stopSpinner();
    showError('Cherry-pick failed:\n' + ((e && e.message) || e || 'Operation failed'));
  }
}

function hasLocalChanges() {
  return state.staged.length > 0 || state.unstaged.length > 0;
}

// 다른 경로의 저장소로 전환 (탭 변경/worktree 열기/clone 완료 공용)
async function openRepositoryAt(path) {
  if (ui.stopGitWatcher) ui.stopGitWatcher();
  state.cwd = path;
  await require('./persist').attachRepo(path);
  state.isGitRepo = false;
  state.error = null;
  state.branch = '';
  state.gitDir = '';
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
  startSpinner(opName + '...');
  let err = null;
  try {
    err = await fn();
  } catch (e) {
    err = (e && e.message) || 'Operation failed';
  }
  await refreshAsync();
  stopSpinner();
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

async function afterGitOp(err, opName, refreshOpts = {}) {
  if (!state.spinnerActive) state.error = null;
  stopSpinner();
  if (err) {
    refreshInBackground(refreshOpts, { refreshLog: !refreshOpts.statusOnly });
    showError(opName + ' failed:\n' + err);
  } else {
    refreshInBackground(refreshOpts, { refreshLog: !refreshOpts.statusOnly });
  }
}

function showError(msg) {
  state.error = null;
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

function isRebaseConflictError(err) {
  return err && (err.includes('could not apply') || err.includes('Resolve all conflicts') || err.includes('CONFLICT') || err.includes('fix conflicts') || err.includes('needs merge'));
}

function isBranchNotFullyMergedError(err) {
  return !!(err && /not fully merged/i.test(err));
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
  if (!result || !result.success) {
    return 'Failed to show file';
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
  buildTabContextMenuItems,
  buildWorktreeContextMenuItems,
  handleContextMenuAction,
  handleDialogResult,
};
