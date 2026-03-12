const { state } = require('./state');

function getLocalChangeCount() {
  return state.staged.length + state.unstaged.length + state.untracked.length;
}

function formatWindowTitle() {
  if (!state.branch) return '';
  const parts = [state.branch];
  const totalChanges = getLocalChangeCount();
  if (totalChanges > 0) parts.push(`*${totalChanges}`);
  if (state.behind > 0) parts.push(`↓${state.behind}`);
  if (state.ahead > 0) parts.push(`↑${state.ahead}`);
  return parts.join(' | ');
}

module.exports = { getLocalChangeCount, formatWindowTitle };
