const { state, ui } = require('./state');
const { git, gitExec, unquoteGitPath, gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked, gitStashRefs, gitLogCommits, gitShowRef, gitStashDiff, gitRebaseState, gitBranches, gitRemoteBranches, gitAheadBehind, gitFreshLog, gitShowCommitFile, gitFilePatch, gitGetConfig, gitGetConfigLocal } = require('./git');

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
const { acquireSpinner, releaseSpinner } = require('./spinner');

let refreshCount = 0;
let _diffSeq = 0;
let _logDetailSeq = 0;
let _freshDetailSeq = 0;
let _logSeq = 0;
let _freshSeq = 0;

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
  if (ui.collapsedSections.ignored === false) {
    for (let i = 0; i < state.ignored.length; i++) {
      list.push({ type: 'ignored', index: i, status: '!', file: state.ignored[i].file });
    }
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

function remapSelectedFiles() {
  if (state.selectedFiles.size === 0) return;
  const oldList = state._prevFileList || [];
  const selectedPaths = new Set();
  for (const idx of state.selectedFiles) {
    if (idx < oldList.length) {
      const item = oldList[idx];
      selectedPaths.add(item.type + ':' + item.file);
    }
  }
  state.selectedFiles.clear();
  if (selectedPaths.size > 0) {
    const newList = buildFileList();
    for (let i = 0; i < newList.length; i++) {
      if (selectedPaths.has(newList[i].type + ':' + newList[i].file)) {
        state.selectedFiles.add(i);
      }
    }
  }
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
    state.ignored = [];
    state.diffLines = [];
    state.currentDiffFile = null;
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
  const ab = gitAheadBehind(state.cwd);
  state.ahead = ab.ahead;
  state.behind = ab.behind;
  state._prevFileList = buildFileList();
  const status = gitStatus(state.cwd);
  state.staged = status.staged;
  state.unstaged = status.unstaged;
  state.untracked = status.untracked;
  state.ignored = status.ignored;
  remapSelectedFiles();
  clampCursor();
  updateDiff();
}

async function refreshAsync() {
  if (!state.cwd) return;

  refreshCount++;
  if (refreshCount === 1) {
    acquireSpinner();
  }

  try {

  const [isRepoRaw, branchRaw, statusRaw, stashRaw, branchesRaw, remotesRaw, gitDirRaw, nameRaw, emailRaw, localNameRaw, localEmailRaw, aheadBehindRaw] =
    await Promise.all([
      gitExec(['rev-parse', '--is-inside-work-tree'], state.cwd),
      gitExec(['branch', '--show-current'], state.cwd),
      gitExec(['status', '--porcelain=v1', '-uall', '--ignored'], state.cwd),
      gitExec(['stash', 'list', '--format=%H\t%h\t%gd'], state.cwd),
      gitExec(['branch', '--format=%(refname:short)\t%(HEAD)'], state.cwd),
      gitExec(['branch', '-r', '--format=%(refname:short)'], state.cwd),
      gitExec(['rev-parse', '--git-dir'], state.cwd),
      gitExec(['config', 'user.name'], state.cwd),
      gitExec(['config', 'user.email'], state.cwd),
      gitExec(['config', '--local', 'user.name'], state.cwd),
      gitExec(['config', '--local', 'user.email'], state.cwd),
      gitExec(['rev-list', '--left-right', '--count', '@{u}...HEAD'], state.cwd),
    ]);

  // isGitRepo 판정
  if (isRepoRaw.trim() !== 'true') {
    state.isGitRepo = false;
    state.error = 'Not a git repository: ' + state.cwd;
    state.branch = ''; state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.diffLines = []; state.currentDiffFile = null;
    return;
  }
  state.isGitRepo = true;
  state.error = null;

  // branch
  state.branch = branchRaw.trim() || 'HEAD (detached)';
  sendRpcNotify('set_title', { title: state.branch });

  // status — gitStatus()와 동일한 파싱 로직
  const staged = [], unstaged = [], untracked = [], ignored = [];
  for (const line of statusRaw.split('\n')) {
    if (!line) continue;
    const x = line[0], y = line[1], file = unquoteGitPath(line.substring(3));
    if (x === '!' && y === '!') { ignored.push({ file }); }
    else if (x === '?') { untracked.push({ file }); }
    else {
      if (x !== ' ' && x !== '?') staged.push({ status: x, file });
      if (y !== ' ' && y !== '?') unstaged.push({ status: y, file });
    }
  }
  state._prevFileList = buildFileList();
  state.staged = staged; state.unstaged = unstaged; state.untracked = untracked; state.ignored = ignored;

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

  // ahead/behind
  const abParts = aheadBehindRaw.trim().split(/\s+/);
  state.behind = parseInt(abParts[0]) || 0;
  state.ahead = parseInt(abParts[1]) || 0;

  remapSelectedFiles();
  clampCursor();
  updateDiff();

  } finally {
    refreshCount--;
    if (refreshCount === 0) {
      releaseSpinner();
    }
  }
}

function refreshLog() {
  if (!state.cwd || !state.isGitRepo) {
    state.logItems = [];
    state.logSelectables = [];
    ui.stashMap = new Map();
    return;
  }

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

  const seq = ++_logSeq;
  const args = ['log', '--all', '--topo-order', '--format=%x01%H%x00%P%x00%D%x00%an%x00%aI%x00%cn%x00%cI%x00%B'];
  if (stashHashes.length > 0) args.push(...stashHashes);
  args.push('-2000');

  gitExec(args, state.cwd, 30000).then(raw => {
    if (_logSeq !== seq) return;

    raw = raw.replace(/\r/g, '').trim();
    let rawCommits = [];
    if (raw) {
      rawCommits = raw.split('\x01').filter(r => r.trim()).map(record => {
        const trimmed = record.trim();
        const parts = [];
        let pos = 0;
        for (let i = 0; i < 7; i++) {
          const next = trimmed.indexOf('\x00', pos);
          if (next === -1) break;
          parts.push(trimmed.substring(pos, next));
          pos = next + 1;
        }
        parts.push(trimmed.substring(pos));
        const fullBody = (parts[7] || '').trim();
        const firstLine = fullBody.split('\n')[0];
        return {
          hash: parts[0] || '',
          parents: parts[1] ? parts[1].split(' ') : [],
          refs: parts[2] || '',
          authorName: parts[3] || '',
          authorDate: parts[4] || '',
          committerName: parts[5] || '',
          committerDate: parts[6] || '',
          subject: firstLine.replace(/[\r\n]/g, ''),
          body: fullBody,
        };
      });
    }

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

    state.logItems = [];
    state.logSelectables = [];
    for (const row of graphRows) {
      if (row.type === 'commit') {
        state.logSelectables.push(state.logItems.length);
      }
      state.logItems.push(row);
    }

    if (state.logCursor >= state.logSelectables.length) {
      state.logCursor = Math.max(0, state.logSelectables.length - 1);
    }

    require('./render').render();
  });
}

function selectedLogRef() {
  if (state.logSelectables.length === 0) return null;
  const idx = state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)];
  return state.logItems[idx] || null;
}

function updateLogDetail() {
  ui.collapsedDetailFiles.clear();
  state.diffScrollX = 0;
  const item = selectedLogRef();
  if (!item) {
    state.logDetailLines = [];
    return;
  }
  const lines = [];

  lines.push('commit ' + item.hash);
  if (item.authorName || item.authorDate) {
    const dateStr = item.authorDate ? formatDateTime(item.authorDate) : '';
    lines.push('Author: ' + (item.authorName || '') + (dateStr ? '  ' + dateStr : ''));
  }
  if (item.committerName || item.committerDate) {
    const dateStr = item.committerDate ? formatDateTime(item.committerDate) : '';
    lines.push('Commit: ' + (item.committerName || '') + (dateStr ? '  ' + dateStr : ''));
  }

  lines.push('\u2500'.repeat(40));

  if (item.body) {
    for (const l of item.body.split('\n')) {
      lines.push(l.replace(/[\r\n]/g, ''));
    }
  }

  lines.push('\u2500'.repeat(40));

  // Show header immediately, load diff async
  state.logDetailLines = [...lines];
  const seq = ++_logDetailSeq;
  const stashRef = ui.stashMap.get(item.ref);
  const promise = stashRef
    ? gitExec(['stash', 'show', '-p', stashRef], state.cwd, 30000)
    : gitExec(['show', '--pretty=format:', item.ref], state.cwd, 30000);
  promise.then(raw => {
    if (_logDetailSeq !== seq) return;
    for (const l of raw.split('\n')) {
      lines.push(l.replace(/\r/g, ''));
    }
    state.logDetailLines = lines;
    require('./render').render();
  });
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
  state.diffScrollX = 0;
  if (!item) {
    state.diffLines = [];
    state.currentDiffFile = null;
    return;
  }
  state.currentDiffFile = item.file;
  state.diffLines = [];

  const seq = ++_diffSeq;
  let args;
  if (item.type === 'staged') {
    args = ['diff', '--cached', '--', item.file];
  } else if (item.type === 'unstaged') {
    args = ['diff', '--', item.file];
  } else {
    args = ['diff', '--no-index', '--', '/dev/null', item.file];
  }
  gitExec(args, state.cwd).then(raw => {
    if (_diffSeq !== seq) return;
    state.diffLines = raw.split('\n');
    require('./render').render();
  });
}

function refreshFresh() {
  if (!state.cwd || !state.isGitRepo) {
    state.freshItems = [];
    return;
  }

  const items = [];
  const seen = new Set();
  const now = new Date();

  // Use already-loaded state data instead of calling gitStatus() again
  for (const f of state.unstaged) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    items.push({
      file: f.file, status: f.status, author: '', date: now.toISOString(),
      commitHash: '', commitMsg: '', isPending: true, isDeleted: f.status === 'D',
    });
  }
  for (const f of state.untracked) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    items.push({
      file: f.file, status: '?', author: '', date: now.toISOString(),
      commitHash: '', commitMsg: '', isPending: true, isDeleted: false,
    });
  }
  for (const f of state.staged) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    items.push({
      file: f.file, status: f.status, author: '', date: now.toISOString(),
      commitHash: '', commitMsg: '', isPending: true, isDeleted: f.status === 'D',
    });
  }

  // Show pending items immediately
  state.freshItems = [...items];
  if (state.freshItems.length === 0) state.freshCursor = 0;
  else state.freshCursor = Math.min(state.freshCursor, state.freshItems.length - 1);

  // Collect historical changes async if days > 0
  const tw = FRESH_TIME_WINDOWS[state.freshTimeWindow] || FRESH_TIME_WINDOWS[1];
  if (tw.days > 0) {
    const seq = ++_freshSeq;
    gitExec(['log', '--since=' + tw.days + '.days.ago', '--name-status', '--pretty=format:__COMMIT__%h|%an|%aI|%s'], state.cwd, 30000).then(raw => {
      if (_freshSeq !== seq) return;
      let currentCommit = null;
      for (const line of raw.split('\n')) {
        if (line.startsWith('__COMMIT__')) {
          const parts = line.substring(10).split('|');
          currentCommit = { hash: parts[0] || '', author: parts[1] || '', date: parts[2] || '', msg: parts.slice(3).join('|') };
          continue;
        }
        if (!currentCommit || !line.trim()) continue;
        const tabs = line.split('\t');
        if (tabs.length < 2) continue;
        const logStatus = tabs[0].charAt(0);
        let file;
        if (logStatus === 'R' && tabs.length >= 3) file = tabs[2];
        else file = tabs[1];
        if (seen.has(file)) continue;
        seen.add(file);
        items.push({
          file, status: logStatus, author: currentCommit.author, date: currentCommit.date,
          commitHash: currentCommit.hash, commitMsg: currentCommit.msg, isPending: false, isDeleted: logStatus === 'D',
        });
      }
      items.sort((a, b) => new Date(b.date) - new Date(a.date));
      state.freshItems = items;
      if (state.freshItems.length === 0) state.freshCursor = 0;
      else state.freshCursor = Math.min(state.freshCursor, state.freshItems.length - 1);
      require('./render').render();
    });
  }
}

function updateFreshDetail() {
  state.diffScrollX = 0;
  const item = state.freshItems[state.freshCursor];
  if (!item) {
    state.freshDetailLines = [];
    return;
  }

  state.freshDetailLines = [];
  const seq = ++_freshDetailSeq;
  let promise;
  if (item.isPending) {
    if (item.status === '?') {
      promise = gitExec(['diff', '--no-index', '--', '/dev/null', item.file], state.cwd);
    } else {
      promise = gitExec(['diff', '--', item.file], state.cwd);
    }
  } else {
    promise = gitExec(['show', item.commitHash, '--', item.file], state.cwd, 30000);
  }
  promise.then(raw => {
    if (_freshDetailSeq !== seq) return;
    state.freshDetailLines = raw.split('\n');
    require('./render').render();
  });
}

module.exports = {
  buildFileList, selectedItem, clampCursor,
  refresh, refreshAsync, refreshLog, selectedLogRef, updateLogDetail, updateDiff,
  FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail,
};
