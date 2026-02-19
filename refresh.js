const { state, ui } = require('./state');
const { gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked, gitStashRefs, gitLogCommits, gitShowRef, gitStashDiff, gitRebaseState } = require('./git');
const { calcGraphRows } = require('./graph');

function buildFileList() {
  const list = [];
  for (let i = 0; i < state.staged.length; i++) {
    list.push({ type: 'staged', index: i, status: state.staged[i].status, file: state.staged[i].file });
  }
  for (let i = 0; i < state.unstaged.length; i++) {
    list.push({ type: 'unstaged', index: i, status: state.unstaged[i].status, file: state.unstaged[i].file });
  }
  for (let i = 0; i < state.untracked.length; i++) {
    list.push({ type: 'untracked', index: i, status: '?', file: state.untracked[i].file });
  }
  return list;
}

function selectedItem() {
  const list = buildFileList();
  if (list.length === 0) return null;
  return list[Math.min(state.cursor, list.length - 1)];
}

function clampCursor() {
  const list = buildFileList();
  if (list.length === 0) state.cursor = 0;
  else state.cursor = Math.min(state.cursor, list.length - 1);
}

function refresh() {
  if (!state.cwd) return;
  state.isGitRepo = gitIsRepo(state.cwd);
  if (!state.isGitRepo) {
    state.error = 'Not a git repository: ' + state.cwd;
    state.branch = '';
    state.staged = [];
    state.unstaged = [];
    state.untracked = [];
    state.diffLines = [];
    return;
  }
  state.error = null;
  state.branch = gitBranch(state.cwd);
  state.rebaseState = gitRebaseState(state.cwd);
  const status = gitStatus(state.cwd);
  state.staged = status.staged;
  state.unstaged = status.unstaged;
  state.untracked = status.untracked;
  clampCursor();
  updateDiff();
}

function refreshLog() {
  if (!state.cwd || !state.isGitRepo) {
    state.logItems = [];
    state.logSelectables = [];
    ui.stashMap = new Map();
    return;
  }

  state.logItems = [];
  state.logSelectables = [];

  // Build stash map and collect stash hashes for graph inclusion
  const stashRefList = gitStashRefs(state.cwd);
  ui.stashMap = new Map();
  const stashHashes = [];
  const stashFullHashes = new Set();
  for (const s of stashRefList) {
    ui.stashMap.set(s.shortHash, s.ref);
    stashHashes.push(s.hash);
    stashFullHashes.add(s.hash);
  }

  const rawCommits = gitLogCommits(state.cwd, stashHashes);

  // Filter stash sub-commits (index, untracked) to keep graph clean.
  const stashSubHashes = new Set();
  for (const c of rawCommits) {
    if (stashFullHashes.has(c.hash) && c.parents.length > 1) {
      for (let i = 1; i < c.parents.length; i++) {
        stashSubHashes.add(c.parents[i]);
      }
    }
  }
  let commits = stashSubHashes.size > 0
    ? rawCommits
        .filter(c => !stashSubHashes.has(c.hash))
        .map(c => {
          const fp = c.parents.filter(p => !stashSubHashes.has(p));
          return fp.length === c.parents.length ? c : { ...c, parents: fp };
        })
    : rawCommits;

  // Reorder stash commits: place them right BEFORE their parent commit
  if (stashFullHashes.size > 0) {
    const hashIdx = new Map();
    for (let i = 0; i < commits.length; i++) hashIdx.set(commits[i].hash, i);

    const stashByParent = new Map();
    const stashSet = new Set();
    for (const c of commits) {
      if (!stashFullHashes.has(c.hash)) continue;
      const parentHash = c.parents[0];
      if (!parentHash || !hashIdx.has(parentHash)) continue;
      if (!stashByParent.has(parentHash)) stashByParent.set(parentHash, []);
      stashByParent.get(parentHash).push(c);
      stashSet.add(c.hash);
    }

    if (stashByParent.size > 0) {
      const reordered = [];
      for (const c of commits) {
        if (stashSet.has(c.hash)) continue;
        const stashes = stashByParent.get(c.hash);
        if (stashes) {
          for (const s of stashes) reordered.push(s);
        }
        reordered.push(c);
      }
      commits = reordered;
    }
  }

  const graphRows = calcGraphRows(commits, stashFullHashes, ui.stashMap);

  for (const row of graphRows) {
    if (row.type === 'commit') {
      state.logSelectables.push(state.logItems.length);
    }
    state.logItems.push(row);
  }

  if (state.logCursor >= state.logSelectables.length) {
    state.logCursor = Math.max(0, state.logSelectables.length - 1);
  }
}

function selectedLogRef() {
  if (state.logSelectables.length === 0) return null;
  const idx = state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)];
  return state.logItems[idx] || null;
}

function updateLogDetail() {
  const item = selectedLogRef();
  if (!item) {
    state.logDetailLines = [];
    return;
  }
  let raw = '';
  const stashRef = ui.stashMap.get(item.ref);
  if (stashRef) {
    raw = gitStashDiff(state.cwd, stashRef);
  } else {
    raw = gitShowRef(state.cwd, item.ref);
  }
  state.logDetailLines = raw.split('\n');
}

function updateDiff() {
  const item = selectedItem();
  state.diffScrollOffset = 0;
  if (!item) {
    state.diffLines = [];
    return;
  }
  let raw = '';
  if (item.type === 'staged') {
    raw = gitDiff(state.cwd, item.file, true);
  } else if (item.type === 'unstaged') {
    raw = gitDiff(state.cwd, item.file, false);
  } else {
    raw = gitDiffUntracked(state.cwd, item.file);
  }
  state.diffLines = raw.split('\n');
}

module.exports = {
  buildFileList, selectedItem, clampCursor,
  refresh, refreshLog, selectedLogRef, updateLogDetail, updateDiff,
};
