const { state, ui } = require('./state');
const { sendRpc, sendRpcNotify } = require('./rpc');
const { execFileSync } = require('child_process');
const path = require('path');
const {
  gitCherryPick, gitRevert, gitCheckoutRef,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitRebase, gitStashApply, gitStashDrop, gitStashSave, gitStashPop,
  gitStage, gitUnstage, gitStageAll, gitDiscardFile,
  gitStashFile, gitIgnorePattern, gitFileHistory, gitBlameFile, gitFilePatch,
  gitSetConfig,
} = require('./git');
const { refresh, refreshLog, selectedLogRef, updateLogDetail, refreshFresh, updateFreshDetail } = require('./refresh');
const { render } = require('./render');

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
  ui.contextMenuFilePath = path.join(state.cwd, fileItem.file);
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

function unregisterContextMenu() {
  sendRpcNotify('register_context_menu', { items: [] });
  ui.contextMenuActive = false;
  ui.contextMenuTab = false;
  ui.contextMenuStashRef = null;
  ui.contextMenuFileItem = null;
  ui.contextMenuFileItems = [];
  ui.contextMenuFilePath = '';
}

function handleContextMenuAction(actionId) {
  // Tab context menu actions
  if (actionId === 'tab_refresh') {
    refresh();
    if (state.rightView === 'log') {
      refreshLog();
      updateLogDetail();
    }
    if (state.rightView === 'fresh') {
      refreshFresh();
      updateFreshDetail();
    }
    render();
    return;
  }

  // Remotes context menu actions
  if (actionId.startsWith('remote_')) {
    switch (actionId) {
      case 'remote_add':
        state.mode = 'new-remote';
        state.inputBuffer = '';
        state.inputTarget = '';
        render();
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
        const err = openExternal(fullPath);
        if (err) showError('Open failed:\n' + err);
        break;
      }
      case 'file_external_diff_head': {
        const raw = gitFilePatch(state.cwd, { ...fileItem, type: 'unstaged' });
        if (raw) {
          copyToClipboard(raw);
          showError('Patch copied to clipboard');
        } else {
          showError('No diff with HEAD');
        }
        break;
      }
      case 'file_external_diff_index': {
        const raw = gitFilePatch(state.cwd, { ...fileItem, type: 'staged' });
        if (raw) {
          copyToClipboard(raw);
          showError('Index diff copied to clipboard');
        } else {
          showError('No diff with index');
        }
        break;
      }
      case 'file_show_in_explorer': {
        const err = showInExplorer(fullPath);
        if (err) showError('Show in Explorer failed:\n' + err);
        break;
      }
      case 'file_blame': {
        const raw = gitBlameFile(state.cwd, fileItem.file);
        if (raw) {
          copyToClipboard(raw);
          showError('Blame copied to clipboard');
        } else {
          showError('Blame not available for this file');
        }
        break;
      }
      case 'file_history': {
        const raw = gitFileHistory(state.cwd, fileItem.file);
        if (raw) {
          copyToClipboard(raw);
          showError('History copied to clipboard');
        } else {
          showError('No history for this file');
        }
        break;
      }
      case 'file_stage':
        for (const item of fileItems) {
          if (item && item.type !== 'staged') {
            gitStage(state.cwd, item.file);
          }
        }
        if (fileItems.length > 0) {
          afterGitOp(null);
        }
        break;
      case 'file_unstage':
        for (const item of fileItems) {
          if (item && item.type === 'staged') {
            gitUnstage(state.cwd, item.file);
          }
        }
        if (fileItems.length > 0) {
          afterGitOp(null);
        }
        break;
      case 'file_discard': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const oneErr = gitDiscardFile(state.cwd, item);
          if (!err && oneErr) err = oneErr;
        }
        afterGitOp(err, 'Discard');
        break;
      }
      case 'file_stage_all':
        gitStageAll(state.cwd);
        afterGitOp(null);
        break;
      case 'file_ignore_name': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const pattern = path.basename(item.file);
          const oneErr = gitIgnorePattern(state.cwd, pattern);
          if (!err && oneErr) err = oneErr;
        }
        afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_ignore_ext': {
        const exts = new Set();
        for (const item of fileItems) {
          if (!item) continue;
          const ext = path.extname(item.file);
          if (ext) exts.add(ext);
        }
        if (exts.size === 0) {
          showError('No extension to ignore');
          break;
        }
        let err = null;
        for (const ext of exts) {
          const oneErr = gitIgnorePattern(state.cwd, '*' + ext);
          if (!err && oneErr) err = oneErr;
        }
        afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_ignore_path': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const oneErr = gitIgnorePattern(state.cwd, item.file.replace(/\\/g, '/'));
          if (!err && oneErr) err = oneErr;
        }
        afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_stash_one': {
        let err = null;
        for (const item of fileItems) {
          if (!item) continue;
          const oneErr = gitStashFile(state.cwd, item.file);
          if (!err && oneErr) err = oneErr;
        }
        afterGitOp(err, 'Stash file');
        break;
      }
      case 'file_save_patch': {
        const patches = [];
        for (const item of fileItems) {
          if (!item) continue;
          const patch = gitFilePatch(state.cwd, item);
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
          .map((item) => path.join(state.cwd, item.file));
        copyToClipboard(paths.join('\n'));
        break;
      }
    }
    return;
  }

  // Stash context menu actions
  if (actionId.startsWith('stash_')) {
    const ref = ui.contextMenuStashRef;
    if (!ref) return;
    switch (actionId) {
      case 'stash_apply': {
        const err = gitStashApply(state.cwd, ref);
        afterGitOp(err, 'Stash apply');
        break;
      }
      case 'stash_drop': {
        const err = gitStashDrop(state.cwd, ref);
        afterGitOp(err, 'Stash drop');
        break;
      }
      case 'stash_rename':
        state.mode = 'rename-stash';
        state.inputBuffer = '';
        state.inputTarget = ref;
        render();
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
    const err = gitCheckoutRef(state.cwd, branchName);
    afterGitOp(err, 'Checkout');
    if (!err) registerHistoryContextMenu();
    return;
  }

  switch (actionId) {
    case 'new_branch':
      state.mode = 'new-branch';
      state.inputBuffer = '';
      state.inputTarget = hash;
      render();
      break;
    case 'new_tag':
      state.mode = 'new-tag';
      state.inputBuffer = '';
      state.inputTarget = hash;
      render();
      break;
    case 'merge': {
      const err = gitMerge(state.cwd, hash);
      afterGitOp(err, 'Merge');
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
            { id: 'stash_rebase', label: 'Stash & Rebase' },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
      } else {
        const err = gitRebase(state.cwd, hash);
        refresh();
        if (state.rightView === 'log') refreshLog();
        if (err) {
          showError(err);
        } else {
          render();
        }
      }
      break;
    }
    case 'reset': {
      const err = gitReset(state.cwd, hash);
      afterGitOp(err, 'Reset');
      break;
    }
    case 'checkout': {
      const err = gitCheckoutRef(state.cwd, hash);
      afterGitOp(err, 'Checkout');
      if (!err) registerHistoryContextMenu();
      break;
    }
    case 'cherry_pick': {
      const err = gitCherryPick(state.cwd, hash);
      afterGitOp(err, 'Cherry-pick');
      break;
    }
    case 'revert': {
      const err = gitRevert(state.cwd, hash);
      afterGitOp(err, 'Revert');
      break;
    }
    case 'save_patch': {
      const patch = gitFormatPatch(state.cwd, hash);
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
      const raw = gitCommitInfo(state.cwd, hash);
      if (raw) {
        copyToClipboard(raw);
      } else {
        copyToClipboard(hash + ' ' + (logItem.subject || ''));
      }
      break;
    }
  }
}

function handleDialogResult(params) {
  const buttonId = params && params.buttonId;
  // Committer input dialog result
  if (state.pendingCommitterEdit && buttonId === 'ok' && params.value != null) {
    const field = state.pendingCommitterEdit;
    state.pendingCommitterEdit = null;
    const configKey = field === 'name' ? 'user.name' : 'user.email';
    const val = params.value.trim();
    if (val) {
      const err = gitSetConfig(state.cwd, configKey, val);
      if (err) {
        showError('Set ' + field + ' failed:\n' + err);
      } else {
        refresh();
        render();
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
    const stashErr = gitStashSave(state.cwd);
    if (stashErr) {
      showError('Stash failed:\n' + stashErr);
    } else {
      refresh();
      render();
    }
    return;
  }
  if (state.pendingStash) {
    state.pendingStash = false;
    return;
  }
  if (state.pendingRebaseRef && buttonId === 'stash_rebase') {
    const ref = state.pendingRebaseRef;
    state.pendingRebaseRef = null;

    const stashErr = gitStashSave(state.cwd);
    if (stashErr) {
      showError('Stash failed:\n' + stashErr);
      return;
    }

    const rebaseErr = gitRebase(state.cwd, ref);
    if (rebaseErr) {
      gitStashPop(state.cwd);
      refresh();
      if (state.rightView === 'log') refreshLog();
      showError('Rebase failed:\n' + rebaseErr);
      return;
    }

    const popErr = gitStashPop(state.cwd);
    refresh();
    if (state.rightView === 'log') refreshLog();
    if (popErr) {
      showError('Rebase succeeded, but stash pop failed:\n' + popErr);
    } else {
      render();
    }
  } else {
    state.pendingRebaseRef = null;
  }
}

function afterGitOp(err, opName) {
  refresh();
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
    buttons: [{ id: 'ok', label: 'OK' }],
  });
  render();
}

function copyToClipboard(text) {
  sendRpcNotify('set_clipboard', { text });
}

function openExternal(fullPath) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', fullPath], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      execFileSync('open', [fullPath]);
    } else {
      execFileSync('xdg-open', [fullPath]);
    }
    return null;
  } catch (e) {
    return e.message || 'Failed to open file';
  }
}

function showInExplorer(fullPath) {
  try {
    if (process.platform === 'win32') {
      execFileSync('explorer', ['/select,' + fullPath], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      execFileSync('open', ['-R', fullPath]);
    } else {
      execFileSync('xdg-open', [path.dirname(fullPath)]);
    }
    return null;
  } catch (e) {
    return e.message || 'Failed to show file';
  }
}

module.exports = {
  registerHistoryContextMenu,
  registerStashContextMenu,
  registerFileContextMenu,
  registerRemotesContextMenu,
  registerTabContextMenu,
  unregisterContextMenu,
  handleContextMenuAction,
  handleDialogResult,
};
