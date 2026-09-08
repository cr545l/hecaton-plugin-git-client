const { state, ui, localRefKey, remoteRefKey } = require('./state');

function reset() {
  ui.branchSelectionCwd = state.cwd;
  ui.selectedBranchRefs = new Set();
  ui.branchSelectionAnchor = null;
  ui.branchSelectionAnchorOccurrence = 0;
  ui.contextMenuBranches = null;
}

function sync() {
  if (ui.branchSelectionCwd !== state.cwd) reset();
  const existing = new Set(state.branches.map(b => localRefKey(b.name))
    .concat(state.remoteBranches.map(remoteRefKey)));
  for (const ref of ui.selectedBranchRefs) {
    if (!existing.has(ref)) ui.selectedBranchRefs.delete(ref);
  }
  if (!existing.has(ui.branchSelectionAnchor)) ui.branchSelectionAnchor = null;
}

function entryRef(entry) {
  if (!entry || entry.action !== 'goto-branch') return null;
  if (entry.refKey) return entry.refKey;
  return state.remoteBranches.includes(entry.branch)
    ? remoteRefKey(entry.branch) : localRefKey(entry.branch);
}

function select(entry, mode = 'single') {
  sync();
  const ref = entryRef(entry);
  if (!ref) return false;
  const rows = (ui.leftPanelFullClickMap || ui.leftPanelClickMap)
    .filter(e => e && !e.reveal && entryRef(e));
  const refs = rows.map(entryRef);
  const row = rows.indexOf(entry);
  const end = row >= 0 ? row : refs.indexOf(ref);
  // A pinned branch has two rows. Retain the clicked occurrence across renders.
  const occurrence = refs.slice(0, Math.max(0, end)).filter(r => r === ref).length;
  if (mode === 'range') {
    const anchors = refs.map((r, i) => r === ui.branchSelectionAnchor ? i : -1).filter(i => i >= 0);
    const start = anchors[ui.branchSelectionAnchorOccurrence] ?? anchors[0] ?? -1;
    ui.selectedBranchRefs = new Set(start >= 0 && end >= 0
      ? refs.slice(Math.min(start, end), Math.max(start, end) + 1) : [ref]);
    if (start < 0) {
      ui.branchSelectionAnchor = ref;
      ui.branchSelectionAnchorOccurrence = occurrence;
    }
  } else if (mode === 'toggle') {
    if (ui.selectedBranchRefs.has(ref)) ui.selectedBranchRefs.delete(ref);
    else ui.selectedBranchRefs.add(ref);
    ui.branchSelectionAnchor = ref;
    ui.branchSelectionAnchorOccurrence = occurrence;
  } else if (mode !== 'context' || !ui.selectedBranchRefs.has(ref)) {
    ui.selectedBranchRefs = new Set([ref]);
    ui.branchSelectionAnchor = ref;
    ui.branchSelectionAnchorOccurrence = occurrence;
  }
  ui.leftPanelActiveBranch = entry.branch;
  ui.branchDragCandidate = null;
  return true;
}

function capture(entry) {
  select(entry, 'context');
  ui.contextMenuBranches = { cwd: state.cwd, refs: [...ui.selectedBranchRefs] };
  return ui.contextMenuBranches;
}

function resolve(target) {
  if (!target || target.cwd !== state.cwd || !Array.isArray(target.refs)) return [];
  const locals = new Map(state.branches.map(branch => [branch.name, branch]));
  const remotes = new Set(state.remoteBranches);
  return [...new Set(target.refs)].map(ref => {
    const local = ref.startsWith('refs/heads/');
    const name = ref.slice(local ? 11 : 13);
    const branch = local ? locals.get(name) : null;
    if (local ? !branch : !ref.startsWith('refs/remotes/') || !remotes.has(name)) return null;
    return { ref, name, local, upstream: branch ? branch.upstream || '' : '', current: !!(branch && (branch.isCurrent || name === state.branch)) };
  }).filter(Boolean);
}

function allowed(action, target) {
  const entries = resolve(target);
  if (!entries.length || entries.length !== new Set(target.refs).size) return false;
  switch (action) {
    case 'copy': case 'filter': case 'unfilter': case 'unhide': return true;
    case 'clear_filters': case 'show_all': return true;
    case 'hide': return entries.every(e => !e.current);
    case 'pin': case 'unpin': return entries.every(e => e.local);
    case 'delete': return entries.every(e => e.local && !e.current &&
      !state.worktrees.some(w => w.branch === e.name));
    case 'delete_remote': return networkTargets(action, target) !== null;
    case 'push': return entries.every(e => e.local) && networkTargets(action, target) !== null;
    case 'ff': return entries.every(e => e.local && !e.current &&
      !state.worktrees.some(w => w.branch === e.name)) && networkTargets(action, target) !== null;
    default: return false;
  }
}

// Resolve exact destinations, never infer an upstream from a matching short name.
// Multiple local selections may share one upstream: delete that remote ref only once.
function networkTargets(action, target, metadata = state) {
  const entries = resolve(target);
  if (!entries.length || entries.length !== new Set(target.refs).size) return null;
  const result = new Map();
  for (const entry of entries) {
    const branch = metadata.branches.find(b => b.name === entry.name);
    if (entry.local && !branch) return null;
    let upstream = entry.local ? branch.upstream : entry.name;
    if (!upstream && action === 'push' && metadata.remotes.length === 1) upstream = metadata.remotes[0] + '/' + entry.name;
    const parts = require('./git').splitUpstreamRef(upstream, [...metadata.remotes].sort((a, b) => b.length - a.length));
    if (!parts.remote || !parts.branch || parts.branch === 'HEAD' || !metadata.remotes.includes(parts.remote)) return null;
    const item = { remote: parts.remote, branch: parts.branch };
    if (action !== 'delete_remote') {
      if (!entry.local) return null;
      item.localName = entry.name;
    }
    result.set(JSON.stringify(item), item);
  }
  return [...result.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

module.exports = { reset, sync, entryRef, select, capture, resolve, allowed, networkTargets };
