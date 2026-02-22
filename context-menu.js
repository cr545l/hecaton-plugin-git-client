const { state, ui } = require('./state');
const { sendRpcNotify } = require('./rpc');
const { execFileSync } = require('child_process');
const path = require('path');
const {
  gitCherryPick, gitRevert, gitCheckoutRef,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitRebase, gitStashApply, gitStashDrop,
  gitStage, gitUnstage, gitStageAll, gitDiscardFile,
  gitStashFile, gitIgnorePattern, gitFileHistory, gitBlameFile, gitFilePatch,
} = require('./git');
const { refresh, refreshLog, selectedLogRef } = require('./refresh');
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

function registerFileContextMenu(fileItem) {
  if (!fileItem || !fileItem.file) return;

  const canStage = fileItem.type !== 'staged';
  const canUnstage = fileItem.type === 'staged';

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
  ui.contextMenuFilePath = path.join(state.cwd, fileItem.file);
}

function unregisterContextMenu() {
  sendRpcNotify('register_context_menu', { items: [] });
  ui.contextMenuActive = false;
  ui.contextMenuStashRef = null;
  ui.contextMenuFileItem = null;
  ui.contextMenuFilePath = '';
}

function handleContextMenuAction(actionId) {
  // File context menu actions
  if (actionId.startsWith('file_')) {
    const fileItem = ui.contextMenuFileItem;
    const fullPath = ui.contextMenuFilePath;
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
        if (fileItem.type !== 'staged') {
          gitStage(state.cwd, fileItem.file);
          afterGitOp(null);
        }
        break;
      case 'file_unstage':
        if (fileItem.type === 'staged') {
          gitUnstage(state.cwd, fileItem.file);
          afterGitOp(null);
        }
        break;
      case 'file_discard': {
        const err = gitDiscardFile(state.cwd, fileItem);
        afterGitOp(err, 'Discard');
        break;
      }
      case 'file_stage_all':
        gitStageAll(state.cwd);
        afterGitOp(null);
        break;
      case 'file_ignore_name': {
        const pattern = path.basename(fileItem.file);
        const err = gitIgnorePattern(state.cwd, pattern);
        afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_ignore_ext': {
        const ext = path.extname(fileItem.file);
        if (!ext) {
          showError('No extension to ignore');
          break;
        }
        const err = gitIgnorePattern(state.cwd, '*' + ext);
        afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_ignore_path': {
        const err = gitIgnorePattern(state.cwd, fileItem.file.replace(/\\/g, '/'));
        afterGitOp(err, 'Ignore');
        break;
      }
      case 'file_stash_one': {
        const err = gitStashFile(state.cwd, fileItem.file);
        afterGitOp(err, 'Stash file');
        break;
      }
      case 'file_save_patch': {
        const patch = gitFilePatch(state.cwd, fileItem);
        if (patch) {
          copyToClipboard(patch);
          showError('Patch copied to clipboard');
        } else {
          showError('No patch for this file');
        }
        break;
      }
      case 'file_copy_path':
        copyToClipboard(fileItem.file.replace(/\\/g, '/'));
        break;
      case 'file_copy_full_path':
        copyToClipboard(fullPath);
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
      const err = gitRebase(state.cwd, hash);
      refresh();
      if (state.rightView === 'log') refreshLog();
      if (err) {
        showError(err);
      } else {
        render();
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
  state.error = msg;
  state.errorLines = msg.split('\n');
  state.errorScrollOffset = 0;
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
  unregisterContextMenu,
  handleContextMenuAction,
};
