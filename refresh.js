const { state, ui } = require('./state');
const { git, gitExec, unquoteGitPath, gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked, gitStashRefs, gitLogCommits, gitShowRef, gitStashDiff, gitRebaseState, gitOperationState, gitBranches, gitRemoteBranches, gitRemotes, gitWorktrees, gitReflogRecoveries, gitAheadBehind, gitFreshLog, gitShowCommitFile, gitFilePatch, gitGetConfig, gitGetConfigLocal, gitReadConflictFile } = require('./git');

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
const { formatWindowTitle } = require('./title');

// Fork-style reorder: DFS traversal of the branch tree.
// HEAD's first-parent chain is the trunk; at each commit,
// branches that fork from it are recursively inserted before it.
function reorderForkStyle(commits) {
  if (commits.length <= 1) return commits;

  const byHash = new Map();
  for (const c of commits) byHash.set(c.hash, c);

  // Find HEAD commit
  let headHash = null;
  for (const c of commits) {
    if (c.refs && (c.refs.includes('HEAD') || c.refs.startsWith('HEAD'))) {
      headHash = c.hash;
      break;
    }
  }
  if (!headHash) return commits;

  // Build first-parent chain from HEAD
  const fpChain = []; // ordered list of hashes on HEAD's first-parent path
  const fpSet = new Set();
  let cur = headHash;
  while (cur && byHash.has(cur)) {
    fpChain.push(cur);
    fpSet.add(cur);
    const c = byHash.get(cur);
    cur = c.parents.length > 0 ? c.parents[0] : null;
  }

  // For any commit, find its closest ancestor on a given chain (BFS up parents)
  function findAncestorIn(hash, chainSet) {
    const visited = new Set();
    const queue = [hash];
    while (queue.length > 0) {
      const h = queue.shift();
      if (visited.has(h)) continue;
      visited.add(h);
      if (chainSet.has(h)) return h;
      const c = byHash.get(h);
      if (c) {
        for (const p of c.parents) queue.push(p);
      }
    }
    return null;
  }

  // Collect all non-fp commits and group by their fork point on fpChain
  const commitSet = new Set(commits.map(c => c.hash));
  const branchTips = []; // non-fp commits that are branch tips (no child points to them as first-parent)
  const childOf = new Map(); // hash → list of commits whose first parent is hash
  for (const c of commits) {
    if (c.parents.length > 0 && byHash.has(c.parents[0])) {
      if (!childOf.has(c.parents[0])) childOf.set(c.parents[0], []);
      childOf.get(c.parents[0]).push(c.hash);
    }
  }

  // Group non-fp commits by their fork point on the fp chain
  const branchesByFork = new Map(); // fpHash → [commit objects in topo-order]
  for (const c of commits) {
    if (fpSet.has(c.hash)) continue;
    const fork = findAncestorIn(c.hash, fpSet);
    if (!fork) continue;
    if (!branchesByFork.has(fork)) branchesByFork.set(fork, []);
    branchesByFork.get(fork).push(c);
  }

  // Within each fork group, recursively sub-sort:
  // build a sub-first-parent chain for each branch tip, and nest sub-branches
  function sortBranchGroup(groupCommits) {
    if (groupCommits.length <= 1) return groupCommits;

    const groupSet = new Set(groupCommits.map(c => c.hash));

    // Find tip commits in this group (commits not referenced as first-parent by another group commit)
    const hasChild = new Set();
    for (const c of groupCommits) {
      if (c.parents.length > 0 && groupSet.has(c.parents[0])) {
        hasChild.add(c.parents[0]);
      }
    }
    const tips = groupCommits.filter(c => !hasChild.has(c.hash));

    // For each tip, collect its first-parent chain within the group
    const result = [];
    const placed = new Set();

    for (const tip of tips) {
      // Walk first-parent chain within group
      const chain = [];
      let h = tip.hash;
      while (h && groupSet.has(h) && !placed.has(h)) {
        chain.push(h);
        placed.add(h);
        const cc = byHash.get(h);
        h = cc && cc.parents.length > 0 ? cc.parents[0] : null;
      }
      // Find sub-branches: group commits whose ancestor is on this chain but not on the chain itself
      const chainSet = new Set(chain);
      const subBranches = new Map();
      for (const gc of groupCommits) {
        if (placed.has(gc.hash) || chainSet.has(gc.hash)) continue;
        const anc = findAncestorIn(gc.hash, chainSet);
        if (!anc) continue;
        if (!subBranches.has(anc)) subBranches.set(anc, []);
        subBranches.get(anc).push(gc);
      }
      // Walk chain, inserting sub-branches at fork points
      for (const ch of chain) {
        const subs = subBranches.get(ch);
        if (subs) {
          const sorted = sortBranchGroup(subs);
          for (const s of sorted) {
            if (!placed.has(s.hash)) {
              result.push(s);
              placed.add(s.hash);
            }
          }
        }
        result.push(byHash.get(ch));
      }
    }

    // Append any remaining
    for (const c of groupCommits) {
      if (!placed.has(c.hash)) result.push(c);
    }
    return result;
  }

  // Build final result: walk fp chain, insert sorted branch groups before each fp commit
  const result = [];
  const inserted = new Set();

  for (const fpHash of fpChain) {
    const group = branchesByFork.get(fpHash);
    if (group) {
      const sorted = sortBranchGroup(group);
      for (const c of sorted) {
        if (!inserted.has(c.hash)) {
          result.push(c);
          inserted.add(c.hash);
        }
      }
    }
    if (!inserted.has(fpHash)) {
      result.push(byHash.get(fpHash));
      inserted.add(fpHash);
    }
  }

  // Append remaining commits not on fp chain and not grouped
  for (const c of commits) {
    if (!inserted.has(c.hash)) {
      result.push(c);
    }
  }

  return result;
}

let refreshCount = 0;
let _diffSeq = 0;

function ensureConflictSelections(conflictView) {
  if (!conflictView) {
    ui.mergeChunkCursor = 0;
    ui.mergeChunkSelections = {};
    return;
  }

  const nextSelections = {};
  for (let i = 0; i < conflictView.chunks.length; i++) {
    if (conflictView.chunks[i].type !== 'conflict') continue;
    if (ui.mergeChunkSelections[i] === 'ours' || ui.mergeChunkSelections[i] === 'theirs') {
      nextSelections[i] = ui.mergeChunkSelections[i];
    }
  }
  ui.mergeChunkSelections = nextSelections;
  const conflictIndices = conflictView.chunks
    .map((chunk, idx) => chunk.type === 'conflict' ? idx : -1)
    .filter(idx => idx >= 0);
  if (conflictIndices.length === 0) {
    ui.mergeChunkCursor = 0;
  } else if (!conflictIndices.includes(ui.mergeChunkCursor)) {
    ui.mergeChunkCursor = conflictIndices[0];
  }
}
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

async function refresh() {
  if (!state.cwd) return;
  // Set pending message before exec_process (may hang)
  state.error = 'Checking git... cwd: ' + state.cwd;
  const repoCheck = await gitIsRepo(state.cwd);
  if (repoCheck === true) {
    state.isGitRepo = true;
    state.gitNotFound = false;
    state.error = null;
  } else {
    state.isGitRepo = false;
    const diag = repoCheck || {};
    state.gitNotFound = !!diag.notFound;
    const parts = [state.gitNotFound ? 'git not found' : 'Not a git repository'];
    parts.push('cwd: ' + state.cwd);
    if (diag.error) parts.push('error: ' + diag.error);
    if (diag.stderr) parts.push('stderr: ' + diag.stderr.trim());
    if (diag.exitCode !== undefined) parts.push('exit: ' + diag.exitCode);
    state.error = parts.join(' | ');
  }
  if (!state.isGitRepo) {
    state.branch = '';
    state.worktrees = [];
    state.staged = [];
    state.unstaged = [];
    state.untracked = [];
    state.ignored = [];
    state.diffLines = [];
    state.conflictView = null;
    state.currentDiffFile = null;
    return;
  }
  if (!state.spinnerActive) state.error = null;
  state.branch = await gitBranch(state.cwd);
  state.operationState = await gitOperationState(state.cwd);
  state.branches = await gitBranches(state.cwd);
  state.remoteBranches = await gitRemoteBranches(state.cwd);
  state.remotes = await gitRemotes(state.cwd);
  state.worktrees = await gitWorktrees(state.cwd);
  state.stashes = await gitStashRefs(state.cwd);
  state.committerName = await gitGetConfig(state.cwd, 'user.name');
  state.committerEmail = await gitGetConfig(state.cwd, 'user.email');
  state.committerNameIsLocal = !!(await gitGetConfigLocal(state.cwd, 'user.name'));
  state.committerEmailIsLocal = !!(await gitGetConfigLocal(state.cwd, 'user.email'));
  const ab = await gitAheadBehind(state.cwd);
  state.ahead = ab.ahead;
  state.behind = ab.behind;
  state._prevFileList = buildFileList();
  const status = await gitStatus(state.cwd);
  state.staged = status.staged;
  state.unstaged = status.unstaged;
  state.untracked = status.untracked;
  state.ignored = status.ignored;
  remapSelectedFiles();
  clampCursor();
  sendRpcNotify('set_title', { title: formatWindowTitle() });
  updateDiff();
}

let _refreshRunning = false;
let _refreshQueued = false;

async function refreshAsync() {
  if (!state.cwd) return;

  // 동시 실행 방지 — 이미 실행 중이면 대기열에 넣고 리턴
  if (_refreshRunning) {
    _refreshQueued = true;
    return;
  }
  _refreshRunning = true;
  _refreshQueued = false;

  refreshCount++;
  if (refreshCount === 1) {
    acquireSpinner();
  }

  try {

  // Stale index.lock 정리 — 이전 세션에서 타임아웃 등으로 남은 lock 파일 제거
  try {
    const sep = (process.platform === 'win32') ? '\\' : '/';
    const lockPath = state.cwd + sep + '.git' + sep + 'index.lock';
    const lockStat = await hecaton.fs_stat({ path: lockPath });
    if (lockStat && lockStat.exists) {
      // 5초 이상 된 lock 파일은 stale로 판단 (git timeout이 5초이므로)
      const age = Date.now() - (lockStat.modifiedTime || 0);
      if (age > 5000) {
        await hecaton.exec_process({ program: 'rm', args: ['-f', lockPath], cwd: state.cwd, timeout: 2000 });
      }
    }
  } catch { /* ignore — lock cleanup is best-effort */ }

  // Pre-check: can git run at all? (with diagnostic on failure)
  // Also verify stdout content — host may return ok:true even on timeout/cancellation
  const preCheck = await hecaton.exec_process({ program: 'git', args: ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree'], cwd: state.cwd, timeout: 5000 });
  console.log('[git-client] preCheck:', JSON.stringify(preCheck), 'cwd:', state.cwd);
  const preCheckStdout = preCheck ? (preCheck.stdout || '').replace(/\r\n/g, '\n').trim() : '';
  if (!preCheck || !preCheck.ok || preCheckStdout !== 'true') {
    state.isGitRepo = false;
    const parts = [];
    if (preCheck && preCheck.ok && preCheckStdout !== 'true') {
      parts.push('Not a git repository');
    } else if (!preCheck) {
      parts.push('exec_process returned null');
    } else {
      parts.push(preCheck.error || 'git failed');
    }
    parts.push('cwd: ' + state.cwd);
    if (preCheck) {
      if (preCheck.error) parts.push('error: ' + preCheck.error);
      if (preCheck.stderr && preCheck.stderr.trim()) parts.push('stderr: ' + preCheck.stderr.trim());
      if (preCheck.exitCode !== undefined && preCheck.exitCode !== 0) parts.push('exit: ' + preCheck.exitCode);
      parts.push('ok:' + preCheck.ok + ' stdout:[' + preCheckStdout + ']');
    }
    state.error = parts.join(' | ');
    state.branch = ''; state.worktrees = []; state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.diffLines = []; state.conflictView = null; state.currentDiffFile = null;
    return;
  }

  // preCheck를 통과했으므로 git 저장소 확정
  state.isGitRepo = true;
  if (!state.spinnerActive) state.error = null;

  // gui 설정 읽기 (git-gui 호환)
  const duRaw = await gitExec(['--no-optional-locks', 'config', 'gui.displayuntracked'], state.cwd);
  const mfRaw = await gitExec(['--no-optional-locks', 'config', 'gui.maxfilesdisplayed'], state.cwd);
  // gui.displayuntracked (기본: true) — false면 untracked 스캔 건너뜀
  const duVal = duRaw.trim().toLowerCase();
  const showUntracked = !duVal || duVal === 'true' || duVal === '1' || duVal === 'yes' || duVal === 'on';
  const untrackedFlag = showUntracked ? '-unormal' : '-uno';
  // gui.maxfilesdisplayed (기본: 5000) — 초과 시 untracked부터 제외
  const maxFilesDisplayed = parseInt(mfRaw.trim()) || 5000;

  const [branchRaw, statusRaw, stashRaw, branchesRaw, remotesRaw, remoteNamesRaw, worktrees, gitDirRaw, nameRaw, emailRaw, localNameRaw, localEmailRaw, aheadBehindRaw] =
    await Promise.all([
      gitExec(['--no-optional-locks', 'branch', '--show-current'], state.cwd),
      gitExec(['--no-optional-locks', 'status', '--porcelain=v1', untrackedFlag, '--ignored'], state.cwd, 15000),
      gitExec(['--no-optional-locks', 'stash', 'list', '--format=%H\t%h\t%gd'], state.cwd),
      gitExec(['--no-optional-locks', 'branch', '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)'], state.cwd),
      gitExec(['--no-optional-locks', 'branch', '-r', '--format=%(refname:short)'], state.cwd),
      gitExec(['--no-optional-locks', 'remote'], state.cwd),
      gitWorktrees(state.cwd),
      gitExec(['--no-optional-locks', 'rev-parse', '--git-dir'], state.cwd),
      gitExec(['--no-optional-locks', 'config', 'user.name'], state.cwd),
      gitExec(['--no-optional-locks', 'config', 'user.email'], state.cwd),
      gitExec(['--no-optional-locks', 'config', '--local', 'user.name'], state.cwd),
      gitExec(['--no-optional-locks', 'config', '--local', 'user.email'], state.cwd),
      gitExec(['--no-optional-locks', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], state.cwd),
    ]);

  if (!state.spinnerActive) state.error = null;

  // branch
  state.branch = branchRaw.trim() || 'HEAD (detached)';

  // status 파싱
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
  // gui.maxfilesdisplayed — git-gui처럼 한도 초과 시 untracked부터 제외
  const trackedCount = staged.length + unstaged.length;
  const untrackedLimit = Math.max(0, maxFilesDisplayed - trackedCount);
  if (untracked.length > untrackedLimit) {
    untracked.length = untrackedLimit;
  }

  state._prevFileList = buildFileList();
  state.staged = staged; state.unstaged = unstaged; state.untracked = untracked; state.ignored = ignored;
  sendRpcNotify('set_title', { title: formatWindowTitle() });

  // stashes
  state.stashes = stashRaw.trim() ? stashRaw.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return { hash: parts[0], shortHash: parts[1], ref: parts[2] };
  }) : [];

  // branches
  state.branches = branchesRaw.trim() ? branchesRaw.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return { name: parts[0], isCurrent: parts[1] === '*', upstream: parts[2] || '' };
  }) : [];

  // remotes
  state.remotes = remoteNamesRaw.trim() ? remoteNamesRaw.trim().split('\n').filter(Boolean) : [];

  // remoteBranches
  state.remoteBranches = remotesRaw.trim()
    ? remotesRaw.trim().split('\n').filter(b => !b.includes('/HEAD'))
    : [];

  state.worktrees = worktrees;

  // operationState — detect rebase/merge/cherry-pick/revert in progress
  state.operationState = null;
  const gitDir = gitDirRaw.trim();
  if (gitDir) {
    const sep = (process.platform === 'win32') ? '\\' : '/';
    // gitDir may be absolute (worktrees) or relative (.git)
    const isAbsolute = gitDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(gitDir);
    const base = isAbsolute ? gitDir : (state.cwd + sep + gitDir);
    const rebaseMerge = base + sep + 'rebase-merge';
    const rmStat = await hecaton.fs_stat({ path: rebaseMerge });
    if (rmStat && rmStat.exists && rmStat.isDir) {
      const stepRes = await hecaton.fs_read_file({ path: rebaseMerge + sep + 'msgnum' });
      const totalRes = await hecaton.fs_read_file({ path: rebaseMerge + sep + 'end' });
      const step = (stepRes && stepRes.content) ? stepRes.content.trim() : '0';
      const total = (totalRes && totalRes.content) ? totalRes.content.trim() : '0';
      // Read source branch name and onto commit
      const headNameRes = await hecaton.fs_read_file({ path: rebaseMerge + sep + 'head-name' });
      const ontoRes = await hecaton.fs_read_file({ path: rebaseMerge + sep + 'onto' });
      let headName = (headNameRes && headNameRes.content) ? headNameRes.content.trim() : '';
      if (headName.startsWith('refs/heads/')) headName = headName.substring('refs/heads/'.length);
      const ontoHash = (ontoRes && ontoRes.content) ? ontoRes.content.trim().substring(0, 7) : '';
      state.operationState = { type: 'rebase-merge', step: parseInt(step), total: parseInt(total), headName, ontoHash };
    } else {
      const rebaseApply = base + sep + 'rebase-apply';
      const raStat = await hecaton.fs_stat({ path: rebaseApply });
      if (raStat && raStat.exists && raStat.isDir) {
        const stepRes = await hecaton.fs_read_file({ path: rebaseApply + sep + 'next' });
        const totalRes = await hecaton.fs_read_file({ path: rebaseApply + sep + 'last' });
        const step = (stepRes && stepRes.content) ? stepRes.content.trim() : '0';
        const total = (totalRes && totalRes.content) ? totalRes.content.trim() : '0';
        state.operationState = { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
      } else {
        // Check merge/cherry-pick/revert
        const mergeHead = base + sep + 'MERGE_HEAD';
        const mhStat = await hecaton.fs_stat({ path: mergeHead });
        if (mhStat && mhStat.exists) {
          state.operationState = { type: 'merge' };
        } else {
          const cherryHead = base + sep + 'CHERRY_PICK_HEAD';
          const chStat = await hecaton.fs_stat({ path: cherryHead });
          if (chStat && chStat.exists) {
            state.operationState = { type: 'cherry-pick' };
          } else {
            const revertHead = base + sep + 'REVERT_HEAD';
            const rvStat = await hecaton.fs_stat({ path: revertHead });
            if (rvStat && rvStat.exists) {
              state.operationState = { type: 'revert' };
            }
          }
        }
      }
    }
  }

  // Read rebase/merge commit message for pre-fill
  state.rebaseMessage = '';
  if (state.operationState && gitDir) {
    const sep = (process.platform === 'win32') ? '\\' : '/';
    const isAbsolute = gitDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(gitDir);
    const base = isAbsolute ? gitDir : (state.cwd + sep + gitDir);
    // Try multiple message sources in priority order
    const msgPaths = [];
    if (state.operationState.type === 'rebase-merge') {
      msgPaths.push(base + sep + 'rebase-merge' + sep + 'message');
    } else if (state.operationState.type === 'rebase-apply') {
      msgPaths.push(base + sep + 'rebase-apply' + sep + 'msg');
    }
    msgPaths.push(base + sep + 'MERGE_MSG');
    msgPaths.push(base + sep + 'COMMIT_EDITMSG');
    for (const p of msgPaths) {
      try {
        const res = await hecaton.fs_read_file({ path: p });
        if (res && res.content && res.content.trim()) {
          state.rebaseMessage = res.content.replace(/\r\n/g, '\n').trim();
          break;
        }
      } catch { /* ignore */ }
    }
    // Append conflict file list if there are unmerged files
    const conflictFiles = state.unstaged.filter(f => f.status === 'U').map(f => f.file);
    if (conflictFiles.length > 0 && state.rebaseMessage && !state.rebaseMessage.includes('# Conflicts:')) {
      state.rebaseMessage += '\n\n# Conflicts:\n' + conflictFiles.map(f => '#\t' + f).join('\n');
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
    _refreshRunning = false;
    // 대기 중인 refresh가 있으면 다시 실행
    if (_refreshQueued) {
      _refreshQueued = false;
      refreshAsync();
    }
  }
}

function refreshLog() {
  if (!state.cwd || !state.isGitRepo) {
    state.logItems = [];
    state.logSelectables = [];
    state.recoveryRefs = {};
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
  (async () => {
    const recovery = await gitReflogRecoveries(state.cwd, 250, 64, 256);
    if (_logSeq !== seq) return;
    state.recoveryRefs = recovery.refsByHash || {};
    const recoveryHashSet = new Set(recovery.hashes || []);

    const args = ['log', '--all', '--topo-order', '--format=%x01%H%x00%P%x00%D%x00%an%x00%aI%x00%cn%x00%cI%x00%B'];
    if (stashHashes.length > 0) args.push(...stashHashes);
    if (recovery.hashes && recovery.hashes.length > 0) args.push(...recovery.hashes);
    args.push('-2000');

    let raw = await gitExec(args, state.cwd, 30000);
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
          isRecovery: recoveryHashSet.has(parts[0] || ''),
          recoveryRef: recovery.refsByHash ? recovery.refsByHash[parts[0] || ''] || null : null,
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

    // Fork-style reorder: HEAD's first-parent chain as main lane,
    // branch tips inserted at their fork points
    commits = reorderForkStyle(commits);

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
  })();
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

  if (item.isRecovery) {
    lines.push('');
    lines.push('Recovery: reflog-only commit');
    if (item.recoveryRef && item.recoveryRef.selector) {
      lines.push('Reflog: ' + item.recoveryRef.selector);
    }
    if (item.recoveryRef && item.recoveryRef.subject) {
      lines.push('Event: ' + item.recoveryRef.subject);
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
  if (!item) {
    state.diffLines = [];
    state.conflictView = null;
    state.currentDiffFile = null;
    state.diffScrollOffset = 0;
    state.diffScrollX = 0;
    return;
  }
  const fileChanged = state.currentDiffFile !== item.file;
  state.currentDiffFile = item.file;
  if (fileChanged) {
    state.diffScrollOffset = 0;
    state.diffScrollX = 0;
    state.diffLines = [];
    state.conflictView = null;
  }

  const seq = ++_diffSeq;
  if (item.status === 'U') {
    gitReadConflictFile(state.cwd, item.file).then(conflictView => {
      if (_diffSeq !== seq) return;
      state.conflictView = conflictView;
      state.diffLines = [];
      if (ui.mergeConflictFile !== item.file) {
        ui.mergeConflictFile = item.file;
        ui.mergeChunkCursor = 0;
        ui.mergeChunkSelections = {};
      }
      ensureConflictSelections(conflictView);
      require('./render').render();
    });
    return;
  }

  state.conflictView = null;
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
    state.conflictView = null;
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
  const item = state.freshItems[state.freshCursor];
  if (!item) {
    state.freshDetailLines = [];
    state.diffScrollX = 0;
    return;
  }

  const fileChanged = state._freshDetailFile !== item.file;
  state._freshDetailFile = item.file;
  if (fileChanged) {
    state.diffScrollX = 0;
    state.freshDetailLines = [];
  }
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
