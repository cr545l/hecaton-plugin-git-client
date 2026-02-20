const { state, ui } = require('./state');
const { sendRpcNotify } = require('./rpc');
const {
  gitCherryPick, gitRevert, gitCheckoutRef,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitRebase,
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
}

function unregisterContextMenu() {
  sendRpcNotify('register_context_menu', { items: [] });
}

function handleContextMenuAction(actionId) {
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
      if (err && state.rebaseState) {
        render();
      } else if (err) {
        showError('Rebase failed: ' + err.substring(0, 60));
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
    showError(opName + ' failed: ' + err.substring(0, 60));
  } else {
    render();
  }
}

function showError(msg) {
  state.error = msg;
  render();
  setTimeout(() => { state.error = null; render(); }, 3000);
}

function copyToClipboard(text) {
  sendRpcNotify('set_clipboard', { text });
}

module.exports = { registerHistoryContextMenu, unregisterContextMenu, handleContextMenuAction };
