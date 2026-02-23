const { state, ui } = require('./state');
const { git, gitExec, gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked, gitStashRefs, gitLogCommits, gitShowRef, gitStashDiff, gitRebaseState, gitBranches, gitRemoteBranches, gitFreshLog, gitShowCommitFile, gitFilePatch, gitGetConfig, gitGetConfigLocal } = require('./git');

const FRESH_TIME_WINDOWS = [
  { label: 'Pending', days: 0 },
  { label: '7 days',  days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
];
const { calcGraphRows } = require('./graph');
const { sendRpcNotify } = require('./rpc');

function buildFileList() {
  const list = [];
  for (let i = 0; i < state.unstaged.length; i++) {
    list.push({ type: 'unstaged', index: i, status: state.unstaged[i].status, file: state.unstaged[i].file });
  }
  for (let i = 0; i < state.untracked.length; i++) {
    list.push({ type: 'untracked', index: i, status: '?', file: state.untracked[i].file });
  }
  for (let i = 0; i < state.staged.length; i++) {
    list.push({ type: 'staged', index: i, status: state.staged[i].status, file: state.staged[i].file });
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
  sendRpcNotify('set_title', { title: state.branch });
  state.rebaseState = gitRebaseState(state.cwd);
  state.branches = gitBranches(state.cwd);
  state.remoteBranches = gitRemoteBranches(state.cwd);
  state.stashes = gitStashRefs(state.cwd);
  state.committerName = gitGetConfig(state.cwd, 'user.name');
  state.committerEmail = gitGetConfig(state.cwd, 'user.email');
  state.committerNameIsLocal = !!gitGetConfigLocal(state.cwd, 'user.name');
  state.committerEmailIsLocal = !!gitGetConfigLocal(state.cwd, 'user.email');
  const status = gitStatus(state.cwd);
  state.staged = status.staged;
  state.unstaged = status.unstaged;
  state.untracked = status.untracked;
  state.selectedFiles.clear();
  clampCursor();
  updateDiff();
}

async function refreshAsync() {
  if (!state.cwd) return;

  const [isRepoRaw, branchRaw, statusRaw, stashRaw, branchesRaw, remotesRaw, gitDirRaw, nameRaw, emailRaw, localNameRaw, localEmailRaw] =
    await Promise.all([
      gitExec(['rev-parse', '--is-inside-work-tree'], state.cwd),
      gitExec(['branch', '--show-current'], state.cwd),
      gitExec(['status', '--porcelain=v1', '-uall'], state.cwd),
      gitExec(['stash', 'list', '--format=%H\t%h\t%gd'], state.cwd),
      gitExec(['branch', '--format=%(refname:short)\t%(HEAD)'], state.cwd),
      gitExec(['branch', '-r', '--format=%(refname:short)'], state.cwd),
      gitExec(['rev-parse', '--git-dir'], state.cwd),
      gitExec(['config', 'user.name'], state.cwd),
      gitExec(['config', 'user.email'], state.cwd),
      gitExec(['config', '--local', 'user.name'], state.cwd),
      gitExec(['config', '--local', 'user.email'], state.cwd),
    ]);

  // isGitRepo 판정
  if (isRepoRaw.trim() !== 'true') {
    state.isGitRepo = false;
    state.error = 'Not a git repository: ' + state.cwd;
    state.branch = ''; state.staged = []; state.unstaged = []; state.untracked = []; state.diffLines = [];
    return;
  }
  state.isGitRepo = true;
  state.error = null;

  // branch
  state.branch = branchRaw.trim() || 'HEAD (detached)';
  sendRpcNotify('set_title', { title: state.branch });

  // status — gitStatus()와 동일한 파싱 로직
  const staged = [], unstaged = [], untracked = [];
  for (const line of statusRaw.split('\n')) {
    if (!line) continue;
    const x = line[0], y = line[1], file = line.substring(3);
    if (x === '?') { untracked.push({ file }); }
    else {
      if (x !== ' ' && x !== '?') staged.push({ status: x, file });
      if (y !== ' ' && y !== '?') unstaged.push({ status: y, file });
    }
  }
  state.staged = staged; state.unstaged = unstaged; state.untracked = untracked;

  // stashes
  state.stashes = stashRaw.trim() ? stashRaw.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return { hash: parts[0], shortHash: parts[1], ref: parts[2] };
  }) : [];

  // branches
  state.branches = branchesRaw.trim() ? branchesRaw.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return { name: parts[0], isCurrent: parts[1] === '*' };
  }) : [];

  // remoteBranches
  state.remoteBranches = remotesRaw.trim()
    ? remotesRaw.trim().split('\n').filter(b => !b.includes('/HEAD'))
    : [];

  // rebaseState — gitDirRaw를 이용해 파일시스템 확인 (동기, 빠름)
  state.rebaseState = null;
  const gitDir = gitDirRaw.trim();
  if (gitDir) {
    const fs = require('fs');
    const path = require('path');
    const base = path.resolve(state.cwd, gitDir);
    const rebaseMerge = path.join(base, 'rebase-merge');
    if (fs.existsSync(rebaseMerge)) {
      const step = fs.readFileSync(path.join(rebaseMerge, 'msgnum'), 'utf-8').trim();
      const total = fs.readFileSync(path.join(rebaseMerge, 'end'), 'utf-8').trim();
      state.rebaseState = { type: 'rebase-merge', step: parseInt(step), total: parseInt(total) };
    } else {
      const rebaseApply = path.join(base, 'rebase-apply');
      if (fs.existsSync(rebaseApply)) {
        const step = fs.readFileSync(path.join(rebaseApply, 'next'), 'utf-8').trim();
        const total = fs.readFileSync(path.join(rebaseApply, 'last'), 'utf-8').trim();
        state.rebaseState = { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
      }
    }
  }

  state.committerName = nameRaw.trim();
  state.committerEmail = emailRaw.trim();
  state.committerNameIsLocal = !!localNameRaw.trim();
  state.committerEmailIsLocal = !!localEmailRaw.trim();

  state.selectedFiles.clear();
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
  const stashRefList = state.stashes;
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
  const lines = [];

  // Commit info header
  lines.push('commit ' + item.hash);
  if (item.authorName || item.authorDate) {
    const dateStr = item.authorDate ? formatDateTime(item.authorDate) : '';
    lines.push('Author: ' + (item.authorName || '') + (dateStr ? '  ' + dateStr : ''));
  }
  if (item.committerName || item.committerDate) {
    const dateStr = item.committerDate ? formatDateTime(item.committerDate) : '';
    lines.push('Commit: ' + (item.committerName || '') + (dateStr ? '  ' + dateStr : ''));
  }

  // Separator before message
  lines.push('\u2500'.repeat(40));

  // Commit message body (full multi-line message)
  if (item.body) {
    for (const l of item.body.split('\n')) {
      lines.push(l.replace(/[\r\n]/g, ''));
    }
  }

  // Separator after message
  lines.push('\u2500'.repeat(40));
  lines.push('');

  // Diff only (suppress commit header/message with --pretty=format:)
  let raw = '';
  const stashRef = ui.stashMap.get(item.ref);
  if (stashRef) {
    raw = gitStashDiff(state.cwd, stashRef);
  } else {
    try {
      raw = git(['show', '--pretty=format:', item.ref], state.cwd);
    } catch {
      raw = '';
    }
  }
  for (const l of raw.split('\n')) {
    lines.push(l.replace(/\r/g, ''));
  }

  state.logDetailLines = lines;
}

function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return y + '-' + mo + '-' + day + ' ' + h + ':' + mi + ':' + s;
  } catch {
    return isoStr;
  }
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

function refreshFresh() {
  if (!state.cwd || !state.isGitRepo) {
    state.freshItems = [];
    return;
  }

  const items = [];
  const seen = new Set();
  const now = new Date();

  // Always collect pending changes (staged + unstaged + untracked)
  const status = gitStatus(state.cwd);
  for (const f of status.unstaged) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    items.push({
      file: f.file,
      status: f.status,
      author: '',
      date: now.toISOString(),
      commitHash: '',
      commitMsg: '',
      isPending: true,
      isDeleted: f.status === 'D',
    });
  }
  for (const f of status.untracked) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    items.push({
      file: f.file,
      status: '?',
      author: '',
      date: now.toISOString(),
      commitHash: '',
      commitMsg: '',
      isPending: true,
      isDeleted: false,
    });
  }
  for (const f of status.staged) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    items.push({
      file: f.file,
      status: f.status,
      author: '',
      date: now.toISOString(),
      commitHash: '',
      commitMsg: '',
      isPending: true,
      isDeleted: f.status === 'D',
    });
  }

  // Collect historical changes if days > 0
  const tw = FRESH_TIME_WINDOWS[state.freshTimeWindow] || FRESH_TIME_WINDOWS[1];
  if (tw.days > 0) {
    const logItems = gitFreshLog(state.cwd, tw.days);
    for (const item of logItems) {
      if (seen.has(item.file)) continue;
      seen.add(item.file);
      items.push(item);
    }
  }

  // Sort by date descending
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  state.freshItems = items;

  // Clamp cursor
  if (state.freshItems.length === 0) {
    state.freshCursor = 0;
  } else {
    state.freshCursor = Math.min(state.freshCursor, state.freshItems.length - 1);
  }
}

function updateFreshDetail() {
  const item = state.freshItems[state.freshCursor];
  if (!item) {
    state.freshDetailLines = [];
    return;
  }

  let raw = '';
  if (item.isPending) {
    raw = gitFilePatch(state.cwd, {
      file: item.file,
      type: item.status === '?' ? 'untracked' : 'unstaged',
    });
  } else {
    raw = gitShowCommitFile(state.cwd, item.commitHash, item.file);
  }
  state.freshDetailLines = raw.split('\n');
}

module.exports = {
  buildFileList, selectedItem, clampCursor,
  refresh, refreshAsync, refreshLog, selectedLogRef, updateLogDetail, updateDiff,
  FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail,
};