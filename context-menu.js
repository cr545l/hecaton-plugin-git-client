const { state, ui } = require('./state');
const { sendRpc, sendRpcNotify } = require('./rpc');
function baseName(p) { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return s.substring(s.lastIndexOf('/') + 1); }
function extName(p) { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.substring(i); }
function joinPath(...parts) { return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/'); }
const {
  gitCherryPick, gitRevert, gitCheckoutRef,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitStashApply, gitStashDrop, gitStashSave, gitStashPop, gitStashRename,
  gitStage, gitUnstage, gitStageAll, gitDiscardFile,
  gitStashFile, gitIgnorePattern, gitFileHistory, gitBlameFile, gitFilePatch,
  gitSetConfig, gitCreateBranch, gitCreateTag, gitRemoteAdd,
  gitRenameBranch, gitDeleteBranch, gitSetUpstream, gitUnsetUpstream, gitGetRemoteUrl,
  gitMergeAsync, gitRebaseAsync, gitResetAsync, gitCheckoutRefAsync,
  gitCherryPickAsync, gitRevertAsync, gitStashSaveAsync, gitStashPopAsync,
  gitStageAsync, gitUnstageAsync, gitStageMultiple, gitUnstageMultiple,
  gitMergeFastForwardAsync, gitPushToRemoteAsync, gitPullFromRemoteAsync,
} = require('./git');
const { refreshAsync, refreshLog, selectedLogRef, updateLogDetail, refreshFresh, updateFreshDetail } = require('./refresh');
const { render } = require('./render');
const { startSpinner, stopSpinner } = require('./spinner');

function registerHistoryContextMenu() {
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
    { id: 'copy_sha', label: 'Copy Commit SHA', icon: 'copy', shortcut: 'Ctrl+C' },
    { id: 'copy_info', label: 'Copy Commit Info', icon: 'copy', shortcut: 'Ctrl+Shift+C' },
  );

  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
}

function registerStashContextMenu(stashRef) {
  const items = [
    { id: 'stash_apply', label: 'Apply', icon: 'add' },
    { id: 'stash_drop', label: 'Drop', icon: 'warning' },
    { type: 'separator' },
    { id: 'stash_rename', label: 'Rename...' },
  ];
  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
  ui.contextMenuStashRef = stashRef;
}

function registerFileContextMenu(fileItem, fileItems) {
  if (!fileItem || !fileItem.file) return;

  const targets = Array.isArray(fileItems) && fileItems.length > 0 ? fileItems : [fileItem];
  const canStage = targets.some((item) => item && item.type !== 'staged');
  const canUnstage = targets.some((item) => item && item.type === 'staged');

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
    { id: 'file_stash_one', label: 'Stash 1 File...' },
    { id: 'file_save_patch', label: 'Save as Patch...', icon: 'save' },
    { type: 'separator' },
    { id: 'file_copy_path', label: 'Copy Path', icon: 'copy' },
    { id: 'file_copy_full_path', label: 'Copy Full Path', icon: 'copy' },
  ];

  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
  ui.contextMenuStashRef = null;
  ui.contextMenuFileItem = fileItem;
  ui.contextMenuFileItems = targets;
  ui.contextMenuFilePath = joinPath(state.cwd, fileItem.file);
}

function registerTabContextMenu() {
  const items = [
    { id: 'tab_refresh', label: 'Refresh' },
  ];
  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
  ui.contextMenuTab = true;
  ui.contextMenuStashRef = null;
  ui.contextMenuFileItem = null;
  ui.contextMenuFileItems = [];
  ui.contextMenuFilePath = '';
}

function registerBranchContextMenu(branchName) {
  const branch = state.branches.find(b => b.name === branchName);
  if (!branch) return;

  const upstream = branch.upstream;
  const remote = upstream ? upstream.split('/')[0] : (state.remotes[0] || 'origin');
  const items = [];

  if (!branch.isCurrent) {
    items.push({ id: 'branch_checkout', label: "Checkout '" + branchName + "'" });
  }

  if (upstream) {
    items.push(
      { id: 'branch_ff', label: "Fast-Forward to '" + upstream + "'" },
      { id: 'branch_pull', label: "Pull '" + upstream + "'..." },
    );
  }

  if (remote) {
    items.push(
      { id: 'branch_push', label: "Push '" + branchName + "' to '" + remote + "'..." },
      { id: 'branch_push_pr', label: "Push and Create Pull Request on '" + remote + "'..." },
    );
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
    { id: 'branch_delete', label: "Delete '" + branchName + "'...", shortcut: 'Delete' },
  );
  items.push({ type: 'separator' });
  items.push({ id: 'branch_copy_name', label: 'Copy Branch Name' });

  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
  ui.contextMenuBranch = branchName;
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

function registerRemotesContextMenu() {
  const mode = ui.remoteSortMode || 'alpha';
  const items = [
    { id: 'remote_add', label: 'Add New Remote...' },
    { type: 'separator' },
    { id: 'remote_sort_title', label: 'Sort Branches:', enabled: false },
    { id: 'remote_sort_alpha', label: 'Alphabetically', checked: mode === 'alpha' },
    { id: 'remote_sort_alpha_desc', label: 'Alphabetically backward', checked: mode === 'alpha_desc' },
    { id: 'remote_sort_recent', label: 'Recently used', checked: mode === 'recent' },
  ];
  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
  ui.contextMenuStashRef = null;
  ui.contextMenuFileItem = null;
  ui.contextMenuFileItems = [];
  ui.contextMenuFilePath = '';
}

function registerRemoteBranchContextMenu(remoteBranchName) {
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
    { id: 'remotebranch_copy_name', label: 'Copy Branch Name', icon: 'copy' },
  );

  sendRpcNotify('register_context_menu', { items });
  ui.contextMenuActive = true;
  ui.contextMenuRemoteBranch = remoteBranchName;
}

function unregisterContextMenu() {
  sendRpcNotify('register_context_menu', { items: [] });
  ui.contextMenuActive = false;
  ui.contextMenuTab = false;
  ui.contextMenuStashRef = null;
  ui.contextMenuBranch = null;
  ui.contextMenuRemoteBranch = null;
  ui.contextMenuFileItem = null;
  ui.contextMenuFileItems = [];
  ui.contextMenuFilePath = '';
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

  // Remotes context menu actions
  if (actionId.startsWith('remote_')) {
    switch (actionId) {
      case 'remote_add':
        sendRpc('show_dialog', {
          type: 'input',
          title: 'Add Remote',
          message: 'Enter remote name and URL (e.g. origin https://...):',
          defaultValue: '',
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-remote';
        break;
      case 'remote_sort_alpha':
        ui.remoteSortMode = 'alpha';
        render();
        registerRemotesContextMenu();
        break;
      case 'remote_sort_alpha_desc':
        ui.remoteSortMode = 'alpha_desc';
        render();
        registerRemotesContextMenu();
        break;
      case 'remote_sort_recent':
        ui.remoteSortMode = 'recent';
        render();
        registerRemotesContextMenu();
        break;
    }
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
          startSpinner('Staging...');
          (async () => {
            const files = fileItems.filter(item => item && item.type !== 'staged').map(item => item.file);
            if (files.length > 0) await gitStageMultiple(state.cwd, files);
            stopSpinner();
            await afterGitOp(null);
          })();
        }
        break;
      case 'file_unstage':
        if (fileItems.length > 0) {
          startSpinner('Unstaging...');
          (async () => {
            const files = fileItems.filter(item => item && item.type === 'staged').map(item => item.file);
            if (files.length > 0) await gitUnstageMultiple(state.cwd, files);
            stopSpinner();
            await afterGitOp(null);
          })();
        }
        break;
      case 'file_discard': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const oneErr = await gitDiscardFile(state.cwd, item);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Discard');
        break;
      }
      case 'file_stage_all':
        await gitStageAll(state.cwd);
        await afterGitOp(null);
        break;
      case 'file_ignore_name': {
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
        let err = null;
        for (const ext of exts) {
          const oneErr = await gitIgnorePattern(state.cwd, '*' + ext);
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_ignore_path': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const oneErr = await gitIgnorePattern(state.cwd, item.file.replace(/\\/g, '/'));
          if (!err && oneErr) err = oneErr;
        }
        await afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_stash_one': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const oneErr = await gitStashFile(state.cwd, item.file);
          if (!err && oneErr) err = oneErr;
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
        gitCheckoutRefAsync(state.cwd, localName).then(err => { stopSpinner(); afterGitOp(err, 'Checkout'); });
        break;
      case 'remotebranch_checkout_tracking': {
        startSpinner('Checking out...');
        const err = await gitCreateBranch(state.cwd, localName, remoteBranchName);
        stopSpinner();
        await afterGitOp(err, 'Checkout');
        break;
      }
      case 'remotebranch_new_branch':
        sendRpc('show_dialog', {
          type: 'input',
          title: 'New Branch',
          message: 'Enter branch name:',
          defaultValue: localName,
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'new-branch';
        state.pendingDialogTarget = remoteBranchName;
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
      const err = await gitSetUpstream(state.cwd, branchName, remoteBranch);
      await afterGitOp(err, 'Set upstream');
      return;
    }

    switch (actionId) {
      case 'branch_checkout':
        startSpinner('Checking out...');
        gitCheckoutRefAsync(state.cwd, branchName).then(err => { stopSpinner(); afterGitOp(err, 'Checkout'); });
        break;
      case 'branch_ff':
        startSpinner('Fast-forwarding...');
        gitMergeFastForwardAsync(state.cwd, upstream).then(err => { stopSpinner(); afterGitOp(err, 'Fast-forward'); });
        break;
      case 'branch_pull':
        startSpinner('Pulling...');
        gitPullFromRemoteAsync(state.cwd, remote, branchName).then(err => { stopSpinner(); afterGitOp(err, 'Pull'); });
        break;
      case 'branch_push':
        startSpinner('Pushing...');
        gitPushToRemoteAsync(state.cwd, remote, branchName).then(err => { stopSpinner(); afterGitOp(err, 'Push'); });
        break;
      case 'branch_push_pr':
        startSpinner('Pushing...');
        gitPushToRemoteAsync(state.cwd, remote, branchName).then(async err => {
          stopSpinner();
          if (err) { await afterGitOp(err, 'Push'); return; }
          const remoteUrl = await gitGetRemoteUrl(state.cwd, remote);
          const prUrl = buildPullRequestUrl(remoteUrl, branchName);
          if (prUrl) await openExternal(prUrl);
          await afterGitOp(null, 'Push');
        });
        break;
      case 'branch_new_branch':
        sendRpc('show_dialog', {
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
        sendRpc('show_dialog', {
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
        sendRpc('show_dialog', {
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
        sendRpc('show_dialog', {
          type: 'message',
          title: 'Delete Branch',
          message: "Delete branch '" + branchName + "'?",
          buttons: [{ id: 'delete', label: 'Delete', default: true }, { id: 'force', label: 'Force Delete' }, { id: 'cancel', label: 'Cancel' }],
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
    }
    return;
  }

  // Stash context menu actions
  if (actionId.startsWith('stash_')) {
    const ref = ui.contextMenuStashRef;
    if (!ref) return;
    switch (actionId) {
      case 'stash_apply': {
        const err = await gitStashApply(state.cwd, ref);
        await afterGitOp(err, 'Stash apply');
        break;
      }
      case 'stash_drop': {
        const err = await gitStashDrop(state.cwd, ref);
        await afterGitOp(err, 'Stash drop');
        break;
      }
      case 'stash_rename':
        sendRpc('show_dialog', {
          type: 'input',
          title: 'Rename Stash',
          message: 'Enter new name for stash:',
          defaultValue: '',
          buttons: [{ id: 'ok', label: 'OK', default: true }, { id: 'cancel', label: 'Cancel' }],
        });
        state.pendingDialogAction = 'rename-stash';
        state.pendingDialogTarget = ref;
        break;
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
    if (!err) registerHistoryContextMenu();
    return;
  }

  switch (actionId) {
    case 'new_branch':
      sendRpc('show_dialog', {
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
      sendRpc('show_dialog', {
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
      gitMergeAsync(state.cwd, hash).then(async err => { stopSpinner(); await afterGitOp(err, 'Merge'); });
      break;
    }
    case 'rebase': {
      if (state.staged.length > 0 || state.unstaged.length > 0) {
        state.pendingRebaseRef = hash;
        sendRpc('show_dialog', {
          type: 'message',
          title: 'Rebase',
          message: 'You have uncommitted local changes.\nWould you like to stash them, rebase, and then reapply?',
          buttons: [
            { id: 'stash_rebase', label: 'Stash & Rebase', default: true },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
      } else {
        startSpinner('Rebasing...');
        gitRebaseAsync(state.cwd, hash).then(async err => {
          stopSpinner();
          await refreshAsync();
          if (state.rightView === 'log') refreshLog();
          if (err && isStaleRebaseError(err)) {
            state.pendingRebaseRef = hash;
            sendRpc('show_dialog', {
              type: 'message',
              title: 'Rebase',
              message: 'A stale rebase state was found.\nAbort the previous rebase and retry?',
              buttons: [
                { id: 'abort_retry_rebase', label: 'Abort & Retry', default: true },
                { id: 'cancel', label: 'Cancel' },
              ],
            });
          } else if (err && isRebaseConflictError(err)) {
            showRebaseConflictDialog(err);
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
      startSpinner('Resetting...');
      gitResetAsync(state.cwd, hash).then(async err => { stopSpinner(); await afterGitOp(err, 'Reset'); });
      break;
    }
    case 'checkout': {
      startSpinner('Checking out...');
      gitCheckoutRefAsync(state.cwd, hash).then(async err => {
        stopSpinner();
        await afterGitOp(err, 'Checkout');
        if (!err) registerHistoryContextMenu();
      });
      break;
    }
    case 'cherry_pick': {
      startSpinner('Cherry-picking...');
      gitCherryPickAsync(state.cwd, hash).then(async err => { stopSpinner(); await afterGitOp(err, 'Cherry-pick'); });
      break;
    }
    case 'revert': {
      startSpinner('Reverting...');
      gitRevertAsync(state.cwd, hash).then(async err => { stopSpinner(); await afterGitOp(err, 'Revert'); });
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
  const buttonId = params && params.buttonId;

  // Name input dialog results (new-branch, new-tag, rename-stash, rename-branch, new-remote, delete-branch)
  if (state.pendingDialogAction) {
    const action = state.pendingDialogAction;
    const target = state.pendingDialogTarget || '';
    state.pendingDialogAction = null;
    state.pendingDialogTarget = null;

    // delete-branch is a message dialog with delete/force/cancel buttons
    if (action === 'delete-branch') {
      if (buttonId === 'delete') {
        const err = await gitDeleteBranch(state.cwd, target, false);
        await afterGitOp(err, 'Delete branch');
      } else if (buttonId === 'force') {
        const err = await gitDeleteBranch(state.cwd, target, true);
        await afterGitOp(err, 'Delete branch');
      }
      return;
    }

    if (buttonId === 'ok' && params.value != null) {
      const name = params.value.trim();
      if (!name) {
        showError('Name cannot be empty');
        return;
      }
      let err;
      if (action === 'rename-branch') {
        err = await gitRenameBranch(state.cwd, target, name);
      } else if (action === 'rename-stash') {
        err = await gitStashRename(state.cwd, target, name);
      } else if (action === 'new-remote') {
        const parts = name.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          showError('Use: <remote-name> <remote-url>');
          return;
        }
        const remoteName = parts.shift();
        const remoteUrl = parts.join(' ');
        err = await gitRemoteAdd(state.cwd, remoteName, remoteUrl);
      } else if (action === 'new-branch') {
        err = await gitCreateBranch(state.cwd, name, target);
      } else if (action === 'new-tag') {
        err = await gitCreateTag(state.cwd, name, target);
      }
      const opName = action === 'rename-branch' ? 'Rename branch'
        : action === 'rename-stash' ? 'Rename stash'
        : action === 'new-remote' ? 'Remote'
        : action === 'new-branch' ? 'Branch'
        : 'Tag';
      await afterGitOp(err, opName);
    }
    return;
  }

  // Rebase menu dialog result
  if (state.pendingRebaseMenu) {
    state.pendingRebaseMenu = false;
    let err;
    if (buttonId === 'continue') {
      err = await gitRebaseContinue(state.cwd);
    } else if (buttonId === 'abort') {
      err = await gitRebaseAbort(state.cwd);
    } else if (buttonId === 'skip') {
      err = await gitRebaseSkip(state.cwd);
    } else {
      return;
    }
    refreshAsync().then(() => {
      if (state.rightView === 'log') refreshLog();
      if (err && isRebaseConflictError(err)) {
        showRebaseConflictDialog(err);
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
      stopSpinner();
      if (stashErr) {
        showError('Stash failed:\n' + stashErr);
      } else {
        await refreshAsync();
        render();
      }
    });
    return;
  }
  if (state.pendingStash) {
    state.pendingStash = false;
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
      stopSpinner();
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      if (retryErr && isRebaseConflictError(retryErr)) {
        showRebaseConflictDialog(retryErr);
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
        stopSpinner();
        await refreshAsync();
        if (state.rightView === 'log') refreshLog();
        showRebaseConflictDialog(rebaseErr + '\n\nNote: Your changes are stashed. Run stash pop after resolving.');
        render();
        return;
      }
      if (rebaseErr) {
        state.error = 'Stash & Rebase... (3/3) Restoring stash';
        await gitStashPopAsync(state.cwd);
        stopSpinner();
        await refreshAsync();
        if (state.rightView === 'log') refreshLog();
        showError('Rebase failed:\n' + rebaseErr);
        return;
      }
      state.error = 'Stash & Rebase... (3/3) Restoring stash';
      const popErr = await gitStashPopAsync(state.cwd);
      stopSpinner();
      await refreshAsync();
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

async function afterGitOp(err, opName) {
  state.error = null;
  await refreshAsync();
  if (state.rightView === 'log') refreshLog();
  if (err) {
    showError(opName + ' failed:\n' + err);
  } else {
    render();
  }
}

function showError(msg) {
  state.error = null;
  sendRpc('show_dialog', {
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
  return err && (err.includes('could not apply') || err.includes('Resolve all conflicts'));
}

function showRebaseConflictDialog(err) {
  sendRpc('show_dialog', {
    type: 'message',
    title: 'Rebase Conflict',
    message: err + '\n\nResolve conflicts and choose an action:',
    buttons: [
      { id: 'continue', label: 'Continue', default: true },
      { id: 'skip', label: 'Skip Commit' },
      { id: 'abort', label: 'Abort Rebase' },
    ],
  });
  state.pendingRebaseMenu = true;
}

function copyToClipboard(text) {
  sendRpcNotify('set_clipboard', { text });
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
    const r = await hecaton.exec_process({ program, args, timeout: 5000 });
    if (r && r.ok) return null;
    return (r && r.error) || 'Failed to open file';
  } catch (e) {
    return e.message || 'Failed to open file';
  }
}

async function showInExplorer(fullPath) {
  const result = await sendRpc('show_in_explorer', { path: fullPath });
  if (!result || !result.success) {
    return 'Failed to show file';
  }
  return null;
}

module.exports = {
  registerHistoryContextMenu,
  registerStashContextMenu,
  registerFileContextMenu,
  registerRemotesContextMenu,
  registerRemoteBranchContextMenu,
  registerBranchContextMenu,
  registerTabContextMenu,
  unregisterContextMenu,
  handleContextMenuAction,
  handleDialogResult,
};
