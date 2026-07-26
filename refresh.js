const { state, ui } = require('./state');
const { gitExec, gitStatusSplit, gitStatusPorcelain, gitWorktrees, gitReflogRecoveries, gitReadConflictFile } = require('./git');

const FRESH_TIME_WINDOWS = [
  { label: 'Pending', days: 0 },
  { label: '7 days',  days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
];
const FRESH_LOG_MAX_COUNT = 1000;
const { calcGraphRows } = require('./graph');
const { acquireSpinner, releaseSpinner } = require('./spinner');
const { formatWindowTitle } = require('./title');

function findHeadCommitHash(commits) {
  for (const c of commits) {
    if (c.refs && (c.refs.includes('HEAD') || c.refs.startsWith('HEAD'))) {
      return c.hash;
    }
  }
  return null;
}

// Large histories need a linear-time approximation. The exact Fork-style
// reorder below repeatedly walks ancestors and becomes a visible cost once the
// initial page grows into several thousand commits.
function reorderForkStyleFast(commits) {
  if (commits.length <= 1) return commits;

  const byHash = new Map();
  for (const c of commits) byHash.set(c.hash, c);

  const headHash = findHeadCommitHash(commits);
  if (!headHash) return commits;

  const fpChain = [];
  const fpSet = new Set();
  let cur = headHash;
  while (cur && byHash.has(cur)) {
    fpChain.push(cur);
    fpSet.add(cur);
    const c = byHash.get(cur);
    cur = c.parents.length > 0 ? c.parents[0] : null;
  }

  const forkMemo = new Map();
  function firstParentFork(hash) {
    const path = [];
    let h = hash;
    let fork = null;
    while (h) {
      if (fpSet.has(h)) {
        fork = h;
        break;
      }
      if (forkMemo.has(h)) {
        fork = forkMemo.get(h);
        break;
      }
      const c = byHash.get(h);
      if (!c || c.parents.length === 0) break;
      path.push(h);
      h = c.parents[0];
    }
    for (const p of path) forkMemo.set(p, fork);
    return fork;
  }

  const branchesByFork = new Map();
  for (const c of commits) {
    if (fpSet.has(c.hash)) continue;
    const fork = firstParentFork(c.hash);
    if (!fork) continue;
    if (!branchesByFork.has(fork)) branchesByFork.set(fork, []);
    branchesByFork.get(fork).push(c);
  }

  const result = [];
  const inserted = new Set();
  for (const fpHash of fpChain) {
    const group = branchesByFork.get(fpHash);
    if (group) {
      for (const c of group) {
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

  for (const c of commits) {
    if (!inserted.has(c.hash)) result.push(c);
  }
  return result;
}

// Fork-style reorder: DFS traversal of the branch tree.
// HEAD's first-parent chain is the trunk; at each commit,
// branches that fork from it are recursively inserted before it.
function reorderForkStyle(commits) {
  if (commits.length <= 1) return commits;
  if (commits.length > 1500) return reorderForkStyleFast(commits);

  const byHash = new Map();
  for (const c of commits) byHash.set(c.hash, c);

  // Find HEAD commit
  const headHash = findHeadCommitHash(commits);
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
let _backgroundRefreshCount = 0;

function renderNow() {
  require('./render').render();
}

function refreshInBackground(options = {}, followup = {}) {
  if (!state.cwd) return Promise.resolve();
  _backgroundRefreshCount++;
  state.refreshing = true;
  state.refreshMessage = followup.message || 'Refreshing...';
  acquireSpinner();
  renderNow();

  const refreshOptions = { ...options, silent: true };
  return refreshAsync(refreshOptions)
    .then(() => {
      if (followup.refreshLog && state.rightView === 'log') refreshLog();
      if (followup.refreshFresh && state.rightView === 'fresh') refreshFresh();
    })
    .catch(err => {
      state.error = (err && (err.message || String(err))) || 'Refresh failed';
    })
    .finally(() => {
      _backgroundRefreshCount = Math.max(0, _backgroundRefreshCount - 1);
      releaseSpinner();
      if (_backgroundRefreshCount === 0) {
        state.refreshing = false;
        state.refreshMessage = '';
      }
      renderNow();
    });
}

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

// ── 즉시 state 업데이트 (git status 호출 없이 로컬 state만 조작) ──

function applyStageToState(filePaths) {
  _lastUserRefreshTime = Date.now();
  const fileSet = new Set(filePaths);
  state._prevFileList = buildFileList();
  state.staged = state.staged.filter(f => !fileSet.has(f.file));
  // unstaged → staged 이동
  const remainUnstaged = [];
  for (const f of state.unstaged) {
    if (fileSet.has(f.file)) {
      // unstaged에서 제거하고 staged에 추가 (status 유지)
      state.staged.push({ status: f.status, file: f.file });
    } else {
      remainUnstaged.push(f);
    }
  }
  state.unstaged = remainUnstaged;
  // untracked → staged 이동 (status는 'A')
  const remainUntracked = [];
  for (const f of state.untracked) {
    if (fileSet.has(f.file)) {
      state.staged.push({ status: 'A', file: f.file });
    } else {
      remainUntracked.push(f);
    }
  }
  state.untracked = remainUntracked;
  hecaton.window.set_title({ title: formatWindowTitle() }).catch(() => null);
  remapSelectedFiles();
  clampCursor();
  updateDiff();
}

function applyUnstageToState(filePaths) {
  _lastUserRefreshTime = Date.now();
  const fileSet = new Set(filePaths);
  state._prevFileList = buildFileList();
  state.unstaged = state.unstaged.filter(f => !fileSet.has(f.file));
  state.untracked = state.untracked.filter(f => !fileSet.has(f.file));
  // staged → unstaged/untracked 이동
  const remainStaged = [];
  for (const f of state.staged) {
    if (fileSet.has(f.file)) {
      if (f.status === 'A') {
        // 새 파일은 untracked으로 되돌림
        state.untracked.push({ file: f.file });
      } else {
        // 수정된 파일은 unstaged로 이동
        state.unstaged.push({ status: f.status, file: f.file });
      }
    } else {
      remainStaged.push(f);
    }
  }
  state.staged = remainStaged;
  hecaton.window.set_title({ title: formatWindowTitle() }).catch(() => null);
  remapSelectedFiles();
  clampCursor();
  updateDiff();
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

let _refreshRunning = false;
let _refreshQueued = false;
let _refreshQueuedOpts = {};
let _refreshQueuedWaiters = [];

function refreshNeedsStatus(options) {
  return options.metadataOnly !== true;
}

function refreshNeedsMeta(options) {
  return options.statusOnly !== true;
}

function mergeRefreshOptions(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const needsStatus = refreshNeedsStatus(existing) || refreshNeedsStatus(incoming);
  const needsMeta = refreshNeedsMeta(existing) || refreshNeedsMeta(incoming);

  if (needsStatus && !needsMeta) {
    merged.statusOnly = true;
    delete merged.metadataOnly;
  } else if (!needsStatus && needsMeta) {
    merged.metadataOnly = true;
    delete merged.statusOnly;
  } else {
    delete merged.statusOnly;
    delete merged.metadataOnly;
  }

  if (existing.includeIgnored || incoming.includeIgnored) merged.includeIgnored = true;
  if (existing.loadBranch || incoming.loadBranch) merged.loadBranch = true;
  if (existing.loadGuiConfig || incoming.loadGuiConfig) merged.loadGuiConfig = true;
  if (existing.singleProcessStatus || incoming.singleProcessStatus) merged.singleProcessStatus = true;
  if (existing.fastFirstPaint || incoming.fastFirstPaint) merged.fastFirstPaint = true;
  if (existing.statusTimeout || incoming.statusTimeout) {
    merged.statusTimeout = Math.max(existing.statusTimeout || 0, incoming.statusTimeout || 0);
  }
  if (existing.silent === true && incoming.silent === true) merged.silent = true;
  else delete merged.silent;

  return merged;
}

// 캐싱된 gui config — 전체 refresh 시에만 갱신
let _cachedUntrackedFlag = '-unormal';
let _cachedMaxFilesDisplayed = 5000;
let _guiConfigLoaded = false;

// 메타 데이터 캐시 — .git 내부 mtime fingerprint가 동일하면 재호출 생략.
// 대상: stash, for-each-ref(branches/remotes), remote 이름, worktrees, user.* config(글로벌+로컬), ahead/behind.
// status는 워킹트리 변경을 잡아야 하므로 항상 새로 호출한다.
let _metaCache = null;
let _metaFingerprint = '';
let _metaCacheCwd = '';

// .git/refs 하위 loose ref 트리의 지문.
// 디렉터리 mtime은 "직접 자식"이 바뀔 때만 갱신된다. refs/remotes/origin/foo를
// 지우면 refs/remotes/origin의 mtime만 바뀌고 refs·refs/remotes는 그대로다.
// 그래서 refs 한 곳만 stat하면 원격 브랜치 삭제/prune, 태그 추가/삭제,
// 중첩 이름(feature/x) 브랜치 변경을 통째로 놓친다. 트리를 직접 훑어
// "경로:mtime:size" 목록을 지문으로 만든다. packed-refs에 묶인 ref는
// packed-refs 파일 mtime으로 별도 추적된다.
const REFS_SCAN_MAX_ENTRIES = 4000;

async function collectRefEntries(dirPath, relPath, out, budget) {
  let res = null;
  try {
    res = await hecaton.fs.read_dir({ path: dirPath });
  } catch { return; }
  if (!res || !res.ok || !Array.isArray(res.entries)) return;
  budget.scanned = true;
  const sep = (process.platform === 'win32') ? '\\' : '/';
  const subdirs = [];
  for (const entry of res.entries) {
    if (!entry || !entry.name) continue;
    if (budget.remaining <= 0) { budget.truncated = true; break; }
    budget.remaining--;
    const rel = relPath ? relPath + '/' + entry.name : entry.name;
    if (entry.is_dir) {
      out.push(rel + '/');
      subdirs.push([dirPath + sep + entry.name, rel]);
    } else {
      out.push(rel + ':' + (entry.mtime_ms || 0) + ':' + (entry.size_bytes || 0));
    }
  }
  await Promise.all(subdirs.map(([p, r]) => collectRefEntries(p, r, out, budget)));
}

// refs 트리 지문 문자열. read_dir을 제공하지 않는 호스트나 스캔 실패 시 ''를
// 반환해, 호출자가 기존 mtime 지문만으로 판단하도록(= 종전 동작) 폴백한다.
async function computeRefsTreeSignature(gitDir) {
  if (!gitDir) return '';
  if (!hecaton || !hecaton.fs || typeof hecaton.fs.read_dir !== 'function') return '';
  const sep = (process.platform === 'win32') ? '\\' : '/';
  const out = [];
  const budget = { remaining: REFS_SCAN_MAX_ENTRIES, truncated: false, scanned: false };
  await collectRefEntries(gitDir + sep + 'refs', '', out, budget);
  if (!budget.scanned) return '';
  // read_dir 순서는 플랫폼/파일시스템마다 다르므로 정렬해 안정화한다.
  out.sort();
  // ref가 상한을 넘는 저장소는 부분 지문만 남는다. 지문 자체는 안정적이므로
  // 오탐은 없고, 잘린 구간의 변경만 놓친다(= 종전 동작 수준).
  if (budget.truncated) out.push('~truncated');
  return 'refs\n' + out.join('\n');
}

async function computeMetaFingerprint(cwd, gitDir) {
  if (!gitDir) return '';
  const sep = (process.platform === 'win32') ? '\\' : '/';
  const targets = [
    gitDir + sep + 'HEAD',
    gitDir + sep + 'config',
    gitDir + sep + 'packed-refs',
    gitDir + sep + 'FETCH_HEAD',
    gitDir + sep + 'refs',
    gitDir + sep + 'worktrees',
    gitDir + sep + 'logs' + sep + 'HEAD',
  ];
  const [stats, refsSig] = await Promise.all([
    Promise.all(targets.map(async p => {
      try {
        const r = await hecaton.fs.stat({ path: p });
        return (r && r.exists) ? (r.mtime_ms || 0) : -1;
      } catch { return -1; }
    })),
    computeRefsTreeSignature(gitDir).catch(() => ''),
  ]);
  return stats.join('|') + '\x1e' + refsSig;
}

function invalidateMetaCache() {
  _metaCache = null;
  _metaFingerprint = '';
  _metaCacheCwd = '';
}

// 마지막 사용자 refresh 시간 — 폴링 억제용으로 외부에서 참조
let _lastUserRefreshTime = 0;
function getLastUserRefreshTime() { return _lastUserRefreshTime; }
function touchUserRefreshTime() { _lastUserRefreshTime = Date.now(); }

function shouldIncludeIgnored(options) {
  return options.includeIgnored === true || ui.collapsedSections.ignored === false;
}

function applyStatusSnapshot(snapshot, includeIgnored) {
  state._prevFileList = buildFileList();
  state.staged = snapshot.staged || [];
  state.unstaged = snapshot.unstaged || [];
  state.untracked = snapshot.untracked || [];
  state.ignored = includeIgnored ? (snapshot.ignored || []) : [];
  state.ignoredLoaded = includeIgnored;
  state.ignoredLoading = false;
  hecaton.window.set_title({ title: formatWindowTitle() }).catch(() => null);
  remapSelectedFiles();
  clampCursor();
  updateDiff();
}

// .git/index.lock 경로 — worktree에서는 per-worktree git dir에 위치하므로 gitDir 우선 사용
function indexLockPath() {
  const sep = (process.platform === 'win32') ? '\\' : '/';
  const base = state.gitDir || (state.cwd + sep + '.git');
  return base + sep + 'index.lock';
}

// index.lock 존재 여부를 확인해 state.indexLocked 갱신 (best-effort, 실패 시 변경 없음)
async function detectIndexLock() {
  try {
    const lockStat = await hecaton.fs.stat({ path: indexLockPath() });
    state.indexLocked = !!(lockStat && lockStat.exists);
  } catch { /* ignore — best-effort */ }
}

// 사용자가 Unlock 버튼을 눌렀을 때 호출 — index.lock 강제 제거
async function removeIndexLock() {
  let deleteError = null;
  try {
    await hecaton.fs.delete({ path: indexLockPath() });
  } catch (e) {
    deleteError = (e && e.message) || String(e || 'Delete failed');
  }
  await detectIndexLock();
  if (state.indexLocked) {
    return 'Could not delete index.lock'
      + (deleteError ? ':\n' + deleteError : '. The file may still be in use by another Git process.');
  }
  return null;
}

async function readBranchNameFast() {
  if (!state.gitDir) {
    return (await gitExec(['--no-optional-locks', 'symbolic-ref', '--short', 'HEAD'], state.cwd, 5000)).trim();
  }
  const sep = (process.platform === 'win32') ? '\\' : '/';
  try {
    const res = await hecaton.fs.read_file({ path: state.gitDir + sep + 'HEAD' });
    const head = (typeof res === 'string' ? res : (res && res.content) ? res.content : '').trim();
    if (head.startsWith('ref: refs/heads/')) return head.substring('ref: refs/heads/'.length);
    return '';
  } catch {
    return (await gitExec(['--no-optional-locks', 'symbolic-ref', '--short', 'HEAD'], state.cwd, 5000)).trim();
  }
}

async function refreshAsync(options = {}) {
  if (!state.cwd) return;

  const statusOnly = !!options.statusOnly;
  const metadataOnly = !!options.metadataOnly;
  const showSpinner = options.silent !== true;
  const statusTimeout = options.statusTimeout || 15000;

  // 동시 실행 방지 — 이미 실행 중이면 대기열에 넣고 리턴
  if (_refreshRunning) {
    // 대기 중인 요청들은 필요한 범위(status/meta)를 합쳐서 한 번만 실행한다.
    _refreshQueuedOpts = _refreshQueued
      ? mergeRefreshOptions(_refreshQueuedOpts, options)
      : { ...options };
    _refreshQueued = true;
    return new Promise((resolve, reject) => {
      _refreshQueuedWaiters.push({ resolve, reject });
    });
  }
  _refreshRunning = true;
  _refreshQueued = false;
  _refreshQueuedOpts = {};

  if (!options.silent) _lastUserRefreshTime = Date.now();

  refreshCount++;
  if (showSpinner && refreshCount === 1) {
    acquireSpinner();
  }

  try {

  if (statusOnly && options.fastFirstPaint && !state.isGitRepo) {
    const includeIgnored = shouldIncludeIgnored(options);
    state.ignoredLoading = includeIgnored;
    const statusSnapshot = await gitStatusPorcelain(state.cwd, {
      displayUntracked: _cachedUntrackedFlag !== '-uno',
      includeIgnored,
      maxFilesDisplayed: _cachedMaxFilesDisplayed,
      timeout: statusTimeout,
      includeBranch: options.loadBranch,
      nullOnError: true,
    });
    if (statusSnapshot) {
      state.isGitRepo = true;
      if (options.loadBranch) state.branch = statusSnapshot.branch || 'HEAD (detached)';
      if (!state.spinnerActive) state.error = null;
      applyStatusSnapshot(statusSnapshot, includeIgnored);
      return;
    }
    state.ignoredLoading = false;
  }

  // index.lock은 오래됐다는 이유만으로 자동 삭제하지 않는다. 타임아웃을 반환한
  // Git 프로세스가 Windows에서 계속 실행 중일 수 있어, 활성 lock 삭제는 index를
  // 손상시킬 수 있다. 존재 여부만 표시하고 사용자가 프로세스를 확인한 뒤 Unlock한다.
  if (!metadataOnly) {
    await detectIndexLock();
  }

  // Pre-check: 이미 git repo로 확인된 상태면 skip (cwd가 바뀌는 경우 isGitRepo를 false로 리셋하는 쪽이 책임짐).
  // 첫 refresh나 repo 미확인 상태에서만 rev-parse 수행 — status/diff 결과로 실제 repo 여부가 다시 검증됨.
  // is-inside-work-tree와 git-dir을 한 번에 가져와 이후 Promise.all에서 git-dir 호출을 생략한다.
  if (!state.isGitRepo) {
    const preCheck = await hecaton.process.exec({ program: 'git', args: ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree', '--git-dir'], cwd: state.cwd, timeout_ms: 5000 });
    const preLines = preCheck ? (preCheck.stdout || '').replace(/\r\n/g, '\n').split('\n') : [];
    const insideWorkTree = (preLines[0] || '').trim();
    const preGitDir = (preLines[1] || '').trim();
    if (!preCheck || !preCheck.ok || insideWorkTree !== 'true') {
      if (state.gitDir) {
        state.isGitRepo = true;
        state.ignoredLoading = false;
        if (!state.branch) {
          const branchName = await readBranchNameFast().catch(() => '');
          state.branch = branchName || 'HEAD';
        }
        if (!state.spinnerActive) state.error = 'Repository detected; Git is still warming up...';
        return;
      }
      state.isGitRepo = false;
      const parts = [];
      if (preCheck && preCheck.ok && insideWorkTree !== 'true') {
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
        if (preCheck.exit_code !== undefined && preCheck.exit_code !== 0) parts.push('exit: ' + preCheck.exit_code);
        parts.push('ok:' + preCheck.ok + ' stdout:[' + insideWorkTree + ']');
      }
      state.error = parts.join(' | ');
      state.branch = ''; state.worktrees = []; state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.ignoredLoaded = false; state.ignoredLoading = false; state.diffLines = []; state.conflictView = null; state.currentDiffFile = null;
      return;
    }
    if (preGitDir && !state.gitDir) {
      const sep = (process.platform === 'win32') ? '\\' : '/';
      const isAbsolute = preGitDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(preGitDir);
      state.gitDir = isAbsolute ? preGitDir : (state.cwd + sep + preGitDir);
    }
  }

  // preCheck를 통과했으므로 git 저장소 확정
  state.isGitRepo = true;
  if (!state.spinnerActive) state.error = null;

  // gui 설정 읽기 — 전체 refresh 시에만 갱신 (거의 변경되지 않으므로 캐싱)
  // 두 키를 --get-regexp '^gui\.' 한 번의 spawn으로 가져온다
  if ((!metadataOnly && (!statusOnly || !_guiConfigLoaded)) || (options.loadGuiConfig && !_guiConfigLoaded)) {
    const guiRaw = await gitExec(['--no-optional-locks', 'config', '--get-regexp', '^gui\\.'], state.cwd);
    let duVal = '';
    let mfVal = '';
    if (guiRaw) {
      for (const line of guiRaw.split('\n')) {
        if (!line) continue;
        const sp = line.indexOf(' ');
        if (sp === -1) continue;
        const key = line.substring(0, sp);
        const val = line.substring(sp + 1).trim();
        if (key === 'gui.displayuntracked') duVal = val.toLowerCase();
        else if (key === 'gui.maxfilesdisplayed') mfVal = val;
      }
    }
    // gui.displayuntracked (기본: true) — false면 untracked 스캔 건너뜀
    const showUntracked = !duVal || duVal === 'true' || duVal === '1' || duVal === 'yes' || duVal === 'on';
    _cachedUntrackedFlag = showUntracked ? '-unormal' : '-uno';
    // gui.maxfilesdisplayed (기본: 5000) — 초과 시 untracked부터 제외
    _cachedMaxFilesDisplayed = parseInt(mfVal) || 5000;
    _guiConfigLoaded = true;
  }
  const untrackedFlag = _cachedUntrackedFlag;
  const maxFilesDisplayed = _cachedMaxFilesDisplayed;

  if (statusOnly) {
    // ── 경량 refresh: git status만 실행 ──
    const includeIgnored = shouldIncludeIgnored(options);
    state.ignoredLoading = includeIgnored;
    const statusReader = options.singleProcessStatus === false ? gitStatusSplit : gitStatusPorcelain;
    const statusOptions = {
      displayUntracked: untrackedFlag !== '-uno',
      includeIgnored,
      maxFilesDisplayed,
      timeout: statusTimeout,
    };
    if (options.fastFirstPaint && statusReader === gitStatusPorcelain) {
      statusOptions.nullOnError = true;
    }
    const statusPromise = statusReader(state.cwd, {
      ...statusOptions,
    });
    const branchPromise = options.loadBranch
      ? readBranchNameFast()
      : Promise.resolve('');
    const [statusSnapshot, branchRaw] = await Promise.all([statusPromise, branchPromise]);
    if (options.loadBranch) {
      const branchName = (branchRaw || '').trim();
      state.branch = branchName || 'HEAD (detached)';
    }
    if (!statusSnapshot) {
      state.ignoredLoading = false;
      if (!state.spinnerActive) state.error = 'Repository detected; status scan is still warming up...';
      return;
    }
    if (!state.spinnerActive) state.error = null;

    applyStatusSnapshot(statusSnapshot, includeIgnored);
    return; // 경량 refresh 완료 — 나머지 skip
  }

  // ── 전체 refresh ──
  // 평상시 spawn 수:
  // - status는 항상 호출 (워킹트리 변경 추적)
  // - 메타(stash/for-each-ref/remote/worktrees/user 2종/ahead-behind) 7개는 fingerprint 캐시 적중 시 재호출 생략
  // - git-dir은 state.gitDir 캐시 우선 (preCheck/setupGitWatcher가 채움)
  // → 캐시 적중: 1 spawn (status), 미스: 8 spawn
  const refsFormat = '%(HEAD)\t%(refname)\t%(upstream:short)';
  const sepLocal = (process.platform === 'win32') ? '\\' : '/';
  const gitDirPromise = state.gitDir
    ? Promise.resolve(state.gitDir)
    : gitExec(['--no-optional-locks', 'rev-parse', '--git-dir'], state.cwd).then(raw => {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        const isAbsolute = trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed);
        const resolved = isAbsolute ? trimmed : (state.cwd + sepLocal + trimmed);
        state.gitDir = resolved;
        return resolved;
      });

  // git-dir과 fingerprint를 먼저 확정 (메타 캐시 적중 여부 결정)
  const gitDir = await gitDirPromise;
  if (_metaCacheCwd && _metaCacheCwd !== state.cwd) invalidateMetaCache();
  // push는 원격 추적 ref(refs/remotes/...)만 갱신하는데 fingerprint가 이를 잡지 못해
  // ahead/behind가 캐시에 묶인다. forceMeta로 명시 무효화한다.
  if (options.forceMeta) invalidateMetaCache();
  const fingerprint = await computeMetaFingerprint(state.cwd, gitDir);
  const metaHit = !!_metaCache && fingerprint && fingerprint === _metaFingerprint;

  const includeIgnored = metadataOnly ? false : shouldIncludeIgnored(options);
  if (!metadataOnly) state.ignoredLoading = includeIgnored;
  let statusSnapshot, stashRaw, refsRaw, remoteNamesRaw, worktrees, userCfgRaw, localUserCfgRaw, aheadBehindRaw;
  const statusPromise = metadataOnly
    ? Promise.resolve(null)
    : gitStatusSplit(state.cwd, {
        displayUntracked: untrackedFlag !== '-uno',
        includeIgnored,
        maxFilesDisplayed,
        timeout: statusTimeout,
      });
  if (metaHit) {
    statusSnapshot = await statusPromise;
    stashRaw = _metaCache.stashRaw;
    refsRaw = _metaCache.refsRaw;
    remoteNamesRaw = _metaCache.remoteNamesRaw;
    worktrees = _metaCache.worktrees;
    userCfgRaw = _metaCache.userCfgRaw;
    localUserCfgRaw = _metaCache.localUserCfgRaw;
    aheadBehindRaw = _metaCache.aheadBehindRaw;
  } else {
    [statusSnapshot, stashRaw, refsRaw, remoteNamesRaw, worktrees, userCfgRaw, localUserCfgRaw, aheadBehindRaw] =
      await Promise.all([
        statusPromise,
        gitExec(['--no-optional-locks', 'stash', 'list', '--format=%H\t%h\t%gd\t%s'], state.cwd),
        gitExec(['--no-optional-locks', 'for-each-ref', '--format=' + refsFormat, 'refs/heads', 'refs/remotes'], state.cwd),
        gitExec(['--no-optional-locks', 'remote'], state.cwd),
        gitWorktrees(state.cwd),
        gitExec(['--no-optional-locks', 'config', '--get-regexp', '^user\\.'], state.cwd),
        gitExec(['--no-optional-locks', 'config', '--local', '--get-regexp', '^user\\.'], state.cwd),
        gitExec(['--no-optional-locks', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], state.cwd),
      ]);
    if (fingerprint) {
      _metaCache = { stashRaw, refsRaw, remoteNamesRaw, worktrees, userCfgRaw, localUserCfgRaw, aheadBehindRaw };
      _metaFingerprint = fingerprint;
      _metaCacheCwd = state.cwd;
    }
  }

  if (!state.spinnerActive) state.error = null;

  // refs 파싱: branches + remoteBranches + 현재 브랜치 한 번에
  let currentBranch = '';
  const branches = [];
  const remoteBranches = [];
  if (refsRaw.trim()) {
    for (const line of refsRaw.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      const headMark = parts[0] || '';
      const refname = parts[1] || '';
      const upstream = parts[2] || '';
      if (refname.startsWith('refs/heads/')) {
        const name = refname.substring('refs/heads/'.length);
        const isCurrent = headMark === '*';
        if (isCurrent) currentBranch = name;
        branches.push({ name, isCurrent, upstream });
      } else if (refname.startsWith('refs/remotes/')) {
        const name = refname.substring('refs/remotes/'.length);
        if (name.includes('/HEAD')) continue;
        remoteBranches.push(name);
      }
    }
  }
  state.branch = currentBranch || (metadataOnly && state.branch ? state.branch : 'HEAD (detached)');
  if (!metadataOnly) {
    applyStatusSnapshot(statusSnapshot, includeIgnored);
  }

  // stashes
  state.stashes = stashRaw.trim() ? stashRaw.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return { hash: parts[0], shortHash: parts[1], ref: parts[2], message: parts[3] || '' };
  }) : [];

  // branches / remoteBranches — refs 파싱 결과 사용
  state.branches = branches;
  state.remoteBranches = remoteBranches;

  // remotes (remote 이름 목록 — 브랜치 없이 remote만 있을 수 있어 별도 조회)
  state.remotes = remoteNamesRaw.trim() ? remoteNamesRaw.trim().split('\n').filter(Boolean) : [];

  state.worktrees = worktrees;

  // operationState — detect rebase/merge/cherry-pick/revert in progress (병렬화)
  state.operationState = null;
  if (gitDir) {
    const sep = sepLocal;
    // gitDir is already resolved to an absolute path (cached or by gitDirPromise)
    const base = gitDir;
    const rebaseMerge = base + sep + 'rebase-merge';
    const rebaseApply = base + sep + 'rebase-apply';
    const mergeHead = base + sep + 'MERGE_HEAD';
    const cherryHead = base + sep + 'CHERRY_PICK_HEAD';
    const revertHead = base + sep + 'REVERT_HEAD';

    // 모든 상태 파일을 병렬로 확인
    const [rmStat, raStat, mhStat, chStat, rvStat] = await Promise.all([
      hecaton.fs.stat({ path: rebaseMerge }),
      hecaton.fs.stat({ path: rebaseApply }),
      hecaton.fs.stat({ path: mergeHead }),
      hecaton.fs.stat({ path: cherryHead }),
      hecaton.fs.stat({ path: revertHead }),
    ]);

    if (rmStat && rmStat.exists && rmStat.is_dir) {
      const [stepRes, totalRes, headNameRes, ontoRes] = await Promise.all([
        hecaton.fs.read_file({ path: rebaseMerge + sep + 'msgnum' }),
        hecaton.fs.read_file({ path: rebaseMerge + sep + 'end' }),
        hecaton.fs.read_file({ path: rebaseMerge + sep + 'head-name' }),
        hecaton.fs.read_file({ path: rebaseMerge + sep + 'onto' }),
      ]);
      const step = (stepRes && stepRes.content) ? stepRes.content.trim() : '0';
      const total = (totalRes && totalRes.content) ? totalRes.content.trim() : '0';
      let headName = (headNameRes && headNameRes.content) ? headNameRes.content.trim() : '';
      if (headName.startsWith('refs/heads/')) headName = headName.substring('refs/heads/'.length);
      const ontoHash = (ontoRes && ontoRes.content) ? ontoRes.content.trim().substring(0, 7) : '';
      state.operationState = { type: 'rebase-merge', step: parseInt(step), total: parseInt(total), headName, ontoHash };
    } else if (raStat && raStat.exists && raStat.is_dir) {
      const [stepRes, totalRes] = await Promise.all([
        hecaton.fs.read_file({ path: rebaseApply + sep + 'next' }),
        hecaton.fs.read_file({ path: rebaseApply + sep + 'last' }),
      ]);
      const step = (stepRes && stepRes.content) ? stepRes.content.trim() : '0';
      const total = (totalRes && totalRes.content) ? totalRes.content.trim() : '0';
      state.operationState = { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
    } else if (mhStat && mhStat.exists) {
      state.operationState = { type: 'merge' };
    } else if (chStat && chStat.exists) {
      state.operationState = { type: 'cherry-pick' };
    } else if (rvStat && rvStat.exists) {
      state.operationState = { type: 'revert' };
    }
  }

  // Read rebase/merge commit message for pre-fill.
  // Preserve the previous value if the operation is still active and message files
  // momentarily read as empty during a refresh after conflict resolution.
  const prevRebaseMessage = state.rebaseMessage || '';
  state.rebaseMessage = '';
  if (state.operationState && gitDir) {
    const sep = sepLocal;
    const base = gitDir;
    // Try multiple message sources in priority order
    const msgPaths = [];
    if (state.operationState.type === 'rebase-merge') {
      msgPaths.push(base + sep + 'rebase-merge' + sep + 'message');
    } else if (state.operationState.type === 'rebase-apply') {
      msgPaths.push(base + sep + 'rebase-apply' + sep + 'msg');
      msgPaths.push(base + sep + 'rebase-apply' + sep + 'final-commit');
    }
    msgPaths.push(base + sep + 'MERGE_MSG');
    msgPaths.push(base + sep + 'COMMIT_EDITMSG');
    for (const p of msgPaths) {
      try {
        const res = await hecaton.fs.read_file({ path: p });
        if (res && res.content && res.content.trim()) {
          state.rebaseMessage = res.content.replace(/\r\n/g, '\n').trim();
          break;
        }
      } catch { /* ignore */ }
    }
    if (!state.rebaseMessage && prevRebaseMessage) {
      state.rebaseMessage = prevRebaseMessage;
    }
    // Append conflict file list if there are unmerged files
    const conflictFiles = state.unstaged.filter(f => f.status === 'U').map(f => f.file);
    if (conflictFiles.length > 0 && state.rebaseMessage && !state.rebaseMessage.includes('# Conflicts:')) {
      state.rebaseMessage += '\n\n# Conflicts:\n' + conflictFiles.map(f => '#\t' + f).join('\n');
    }
  }

  // config --get-regexp 출력: "user.name VALUE\nuser.email VALUE\n..."
  const parseUserCfg = (raw) => {
    const out = { name: '', email: '' };
    if (!raw) return out;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      const key = line.substring(0, sp);
      const val = line.substring(sp + 1);
      if (key === 'user.name') out.name = val.trim();
      else if (key === 'user.email') out.email = val.trim();
    }
    return out;
  };
  const userCfg = parseUserCfg(userCfgRaw);
  const localUserCfg = parseUserCfg(localUserCfgRaw);
  state.committerName = userCfg.name;
  state.committerEmail = userCfg.email;
  state.committerNameIsLocal = !!localUserCfg.name;
  state.committerEmailIsLocal = !!localUserCfg.email;

  // ahead/behind
  const abParts = aheadBehindRaw.trim().split(/\s+/);
  state.behind = parseInt(abParts[0]) || 0;
  state.ahead = parseInt(abParts[1]) || 0;

  if (metadataOnly) {
    hecaton.window.set_title({ title: formatWindowTitle() }).catch(() => null);
  } else {
    remapSelectedFiles();
    clampCursor();
    updateDiff();
  }

  } finally {
    refreshCount--;
    if (showSpinner && refreshCount === 0) {
      releaseSpinner();
    }
    _refreshRunning = false;
    // 대기 중인 refresh가 있으면 다시 실행
    if (_refreshQueued) {
      const queuedOpts = _refreshQueuedOpts;
      const queuedWaiters = _refreshQueuedWaiters;
      _refreshQueued = false;
      _refreshQueuedOpts = {};
      _refreshQueuedWaiters = [];
      refreshAsync(queuedOpts).then(
        (value) => queuedWaiters.forEach(waiter => waiter.resolve(value)),
        (error) => queuedWaiters.forEach(waiter => waiter.reject(error)),
      );
    }
  }
}

// 로그 fetch 한도. 첫 paint는 LOG_FAST_LIMIT으로 빨리 띄우고,
// 백그라운드에서 LOG_FULL_LIMIT으로 받아 그래프를 보강한다.
const LOG_FAST_LIMIT = 300;
const LOG_PREFETCH_LIMIT = 2000;
const LOG_FULL_LIMIT = 6000;
const LOG_PAGE_SIZE = 4000;
let _logRequestedLimit = LOG_FULL_LIMIT;
let _logLimitCwd = '';
let _logExpansionRunning = false;

function parseLogRaw(raw, recovery, recoveryHashSet) {
  raw = (raw || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  return raw.split('\x01').filter(r => r.trim()).map(record => {
    const trimmed = record.trim();
    const parts = [];
    let pos = 0;
    for (let i = 0; i < 9; i++) {
      const next = trimmed.indexOf('\x00', pos);
      if (next === -1) break;
      parts.push(trimmed.substring(pos, next));
      pos = next + 1;
    }
    parts.push(trimmed.substring(pos));
    const subject = (parts[9] || '').trim().replace(/[\r\n]/g, '');
    return {
      hash: parts[0] || '',
      parents: parts[1] ? parts[1].split(' ') : [],
      refs: parts[2] || '',
      authorName: parts[3] || '',
      authorEmail: parts[4] || '',
      authorDate: parts[5] || '',
      committerName: parts[6] || '',
      committerEmail: parts[7] || '',
      committerDate: parts[8] || '',
      subject,
      body: '',
      isRecovery: recoveryHashSet.has(parts[0] || ''),
      recoveryRef: recovery.refsByHash ? recovery.refsByHash[parts[0] || ''] || null : null,
    };
  });
}

// 정렬 모드 토글 시 git 재조회 없이 그래프만 다시 만들기 위한 마지막 입력 캐시
let _lastGraphCommits = null;
let _lastGraphStashHashes = null;

function buildLogGraphRows(rawCommits, stashFullHashes) {
  _lastGraphCommits = rawCommits;
  _lastGraphStashHashes = stashFullHashes;

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

  // 'date' 모드는 git --date-order 결과를 그대로 쓴다 (커밋 날짜 내림차순 + 토폴로지 제약).
  if (ui.logSortMode !== 'date') commits = reorderForkStyle(commits);
  return calcGraphRows(commits, stashFullHashes, ui.stashMap);
}

// 정렬 모드 변경용 — 캐시된 커밋으로 그래프 행만 다시 만들고 선택 커밋을 해시로 복원한다.
// 캐시가 없으면 false를 돌려줘 호출부가 refreshLog()로 폴백하게 한다.
function rebuildLogGraphRows() {
  if (!_lastGraphCommits) return false;
  const selIdx = state.logSelectables[state.logCursor];
  const selectedHash = (selIdx !== undefined && state.logItems[selIdx]) ? state.logItems[selIdx].hash : null;

  applyLogGraphRows(buildLogGraphRows(_lastGraphCommits, _lastGraphStashHashes || new Set()));

  ui.logScrollPin = undefined;
  if (selectedHash) {
    const found = state.logSelectables.findIndex(i => state.logItems[i] && state.logItems[i].hash === selectedHash);
    if (found >= 0) state.logCursor = found;
  }
  return true;
}

function applyLogGraphRows(graphRows) {
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
}

function refreshLog(options = {}) {
  if (!state.cwd || !state.isGitRepo) {
    state.logItems = [];
    state.logSelectables = [];
    state.logLoading = false;
    state.logLoadingMore = false;
    state.logHasMore = false;
    state.logLoadedLimit = 0;
    state.recoveryRefs = {};
    ui.stashMap = new Map();
    return;
  }
  if (state.logLoading) {
    if (state.rightView === 'log') require('./render').render();
    return;
  }
  if (_logExpansionRunning && state.logItems.length > 0) {
    if (state.rightView === 'log') require('./render').render();
    return;
  }
  state.logLoadingMore = false;
  if (_logLimitCwd !== state.cwd) {
    _logLimitCwd = state.cwd;
    _logRequestedLimit = LOG_FULL_LIMIT;
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
  state.logLoading = true;
  (async () => {
    const baseFormat = '%x01%H%x00%P%x00%D%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s';
    const buildArgs = (limit, recoveryHashes) => {
      const args = [
        '--no-optional-locks',
        'log',
        '--date-order',
        '--no-show-signature',
        '--no-notes',
        '--all',
        '--max-count=' + limit,
        '--format=' + baseFormat,
      ];
      if (stashHashes.length > 0) args.push(...stashHashes);
      if (recoveryHashes && recoveryHashes.length > 0) args.push(...recoveryHashes);
      return args;
    };
    const loadRecovery = () => gitReflogRecoveries(state.cwd, 250, 64, 256)
      .catch(() => ({ hashes: [], refsByHash: {} }));

    // 1차: 빠른 첫 paint (작은 한도). graph는 부분 데이터 기준이라 정확도가 약간 떨어질 수 있으나
    // 즉시 화면이 뜨므로 체감 속도 우선. _logSeq로 out-of-order 가드.
    const fastRaw = await gitExec(buildArgs(LOG_FAST_LIMIT, []), state.cwd, 30000);
    if (_logSeq !== seq) return;
    const fastCommits = parseLogRaw(fastRaw, { refsByHash: {} }, new Set());
    applyLogGraphRows(buildLogGraphRows(fastCommits, stashFullHashes));
    state.logLoadedLimit = fastCommits.length;
    state.logHasMore = fastCommits.length >= LOG_FAST_LIMIT;
    state.logLoading = false;
    if (state.rightView === 'log') {
      updateLogDetail({ headerOnly: true });
      require('./render').render();
    }

    if (fastCommits.length < LOG_FAST_LIMIT) {
      const recovery = await loadRecovery();
      if (_logSeq !== seq) return;
      state.recoveryRefs = recovery.refsByHash || {};
      const recoveryHashSet = new Set(recovery.hashes || []);
      if (recoveryHashSet.size === 0) {
        state.logHasMore = false;
        state.logLoadedLimit = fastCommits.length;
        state.logLoading = false;
        if (state.rightView === 'log') require('./render').render();
        return;
      }

      const recoveredRaw = await gitExec(buildArgs(LOG_FULL_LIMIT, recovery.hashes || []), state.cwd, 30000);
      if (_logSeq !== seq) return;
      const recoveredCommits = parseLogRaw(recoveredRaw, recovery, recoveryHashSet);
      if (recoveredCommits.length === 0 && fastCommits.length > 0) {
        state.logLoading = false;
        if (state.rightView === 'log') require('./render').render();
        return;
      }
      applyLogGraphRows(buildLogGraphRows(recoveredCommits, stashFullHashes));
      state.logLoadedLimit = recoveredCommits.length;
      state.logHasMore = false;
      if (state.rightView === 'log') updateLogDetail();
      state.logLoading = false;
      if (state.rightView === 'log') require('./render').render();
      return;
    }

    // 2차: 백그라운드 full-path. 결과가 오면 그래프를 갱신해 정확도/범위를 보강.
    // 더 큰 limit이라 1차 결과는 superset에 포함됨 → cursor 인덱스 보존 가능.
    _logExpansionRunning = true;

    const prefetchLimit = Math.min(LOG_PREFETCH_LIMIT, _logRequestedLimit);
    let expandedCommits = fastCommits;
    if (prefetchLimit > LOG_FAST_LIMIT) {
      const prefetchRaw = await gitExec(buildArgs(prefetchLimit, []), state.cwd, 30000);
      if (_logSeq !== seq) { _logExpansionRunning = false; return; }
      const prefetchCommits = parseLogRaw(prefetchRaw, { refsByHash: {} }, new Set());
      if (prefetchCommits.length > 0) {
        expandedCommits = prefetchCommits;
        applyLogGraphRows(buildLogGraphRows(expandedCommits, stashFullHashes));
        state.logLoadedLimit = prefetchLimit;
        state.logHasMore = expandedCommits.length >= prefetchLimit;
        if (state.rightView === 'log') updateLogDetail();
        if (state.rightView === 'log') require('./render').render();
      }
    }

    const fullLimit = _logRequestedLimit;
    if (fullLimit > prefetchLimit && expandedCommits.length >= prefetchLimit) {
      const fullRaw = await gitExec(buildArgs(fullLimit, []), state.cwd, 30000);
      if (_logSeq !== seq) { _logExpansionRunning = false; return; }
      const fullCommits = parseLogRaw(fullRaw, { refsByHash: {} }, new Set());
      if (fullCommits.length > 0) {
        expandedCommits = fullCommits;
        applyLogGraphRows(buildLogGraphRows(expandedCommits, stashFullHashes));
        state.logLoadedLimit = fullLimit;
        state.logHasMore = expandedCommits.length >= fullLimit;
        if (state.rightView === 'log') updateLogDetail();
        if (state.rightView === 'log') require('./render').render();
      }
    }

    _logExpansionRunning = false;

    const recovery = await loadRecovery();
    if (_logSeq !== seq) return;
    state.recoveryRefs = recovery.refsByHash || {};
    const recoveryHashSet = new Set(recovery.hashes || []);
    if (recoveryHashSet.size === 0) return;

    const recoveredRaw = await gitExec(buildArgs(fullLimit, recovery.hashes || []), state.cwd, 30000);
    if (_logSeq !== seq) return;
    const recoveredCommits = parseLogRaw(recoveredRaw, recovery, recoveryHashSet);
    if (recoveredCommits.length === 0 && expandedCommits.length > 0) return;
    applyLogGraphRows(buildLogGraphRows(recoveredCommits, stashFullHashes));
    state.logLoadedLimit = fullLimit;
    state.logHasMore = recoveredCommits.length >= fullLimit;
    if (state.rightView === 'log') updateLogDetail();
    if (state.rightView === 'log') require('./render').render();
  })().catch(() => {
    if (_logSeq !== seq) return;
    _logExpansionRunning = false;
    state.logLoading = false;
    state.logLoadingMore = false;
    if (state.rightView === 'log') require('./render').render();
  });
}

function loadMoreLog() {
  if (!state.cwd || !state.isGitRepo) return false;
  if (state.logLoading || state.logLoadingMore || !state.logHasMore) return false;
  _logExpansionRunning = false;
  if (_logLimitCwd !== state.cwd) {
    _logLimitCwd = state.cwd;
    _logRequestedLimit = LOG_FULL_LIMIT;
  }

  _logRequestedLimit += LOG_PAGE_SIZE;
  const targetLimit = _logRequestedLimit;
  const keepCursor = state.logCursor;
  const keepScrollOffset = state.logScrollOffset;

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
  state.logLoadingMore = true;
  state.logLoading = true;
  acquireSpinner();
  require('./render').render();

  (async () => {
    const recovery = await gitReflogRecoveries(state.cwd, 250, 64, 256)
      .catch(() => ({ hashes: [], refsByHash: {} }));
    if (_logSeq !== seq) return;
    state.recoveryRefs = recovery.refsByHash || {};
    const recoveryHashSet = new Set(recovery.hashes || []);
    const baseFormat = '%x01%H%x00%P%x00%D%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s';
    const args = [
      '--no-optional-locks',
      'log',
      '--date-order',
      '--no-show-signature',
      '--no-notes',
      '--all',
      '--max-count=' + targetLimit,
      '--format=' + baseFormat,
    ];
    if (stashHashes.length > 0) args.push(...stashHashes);
    if (recovery.hashes && recovery.hashes.length > 0) args.push(...recovery.hashes);

    const raw = await gitExec(args, state.cwd, 30000);
    if (_logSeq !== seq) return;
    const commits = parseLogRaw(raw, recovery, recoveryHashSet);
    applyLogGraphRows(buildLogGraphRows(commits, stashFullHashes));
    state.logCursor = Math.min(keepCursor, Math.max(0, state.logSelectables.length - 1));
    state.logScrollOffset = keepScrollOffset;
    state.logLoadedLimit = targetLimit;
    state.logHasMore = commits.length >= targetLimit;
    if (state.rightView === 'log') updateLogDetail();
  })().catch(() => {
    if (_logSeq === seq) state.logHasMore = false;
  }).finally(() => {
    const isCurrent = _logSeq === seq;
    if (isCurrent) {
      state.logLoading = false;
      state.logLoadingMore = false;
    }
    releaseSpinner();
    if (isCurrent && state.rightView === 'log') require('./render').render();
  });
  return true;
}

function selectedLogRef() {
  if (state.logSelectables.length === 0) return null;
  const idx = state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)];
  return state.logItems[idx] || null;
}

function updateLogDetail(options = {}) {
  ui.collapsedDetailFiles.clear();
  state.diffScrollX = 0;
  const item = selectedLogRef();
  if (!item) {
    state.logDetailLines = [];
    return;
  }
  const lines = [];
  const separator = '\u2500'.repeat(40);

  lines.push('commit ' + item.hash);
  if (item.authorName || item.authorDate) {
    const emailPart = item.authorEmail ? ' <' + item.authorEmail + '>' : '';
    const dateStr = item.authorDate ? formatDateTime(item.authorDate) : '';
    lines.push('Author: ' + (item.authorName || '') + emailPart + (dateStr ? '  ' + dateStr : ''));
  }
  if (item.committerName || item.committerDate) {
    const emailPart = item.committerEmail ? ' <' + item.committerEmail + '>' : '';
    const dateStr = item.committerDate ? formatDateTime(item.committerDate) : '';
    lines.push('Commit: ' + (item.committerName || '') + emailPart + (dateStr ? '  ' + dateStr : ''));
  }

  lines.push(separator);
  const headerLines = [...lines];

  const recoveryLines = [];
  if (item.isRecovery) {
    recoveryLines.push('');
    recoveryLines.push('Recovery: reflog-only commit');
    if (item.recoveryRef && item.recoveryRef.selector) {
      recoveryLines.push('Reflog: ' + item.recoveryRef.selector);
    }
    if (item.recoveryRef && item.recoveryRef.subject) {
      recoveryLines.push('Event: ' + item.recoveryRef.subject);
    }
  }

  lines.push(...recoveryLines);
  lines.push(separator);

  // Show header immediately, load body/diff async.
  state.logDetailLines = [...lines];
  const seq = ++_logDetailSeq;
  if (options.headerOnly) return;
  const stashRef = ui.stashMap.get(item.ref);
  const promise = stashRef
    ? gitExec(['stash', 'show', '-p', stashRef], state.cwd, 30000)
    : gitExec(['show', '--format=%B%x00', '--patch', item.ref], state.cwd, 30000);
  promise.then(raw => {
    if (_logDetailSeq !== seq) return;
    const detailLines = [];
    if (stashRef) {
      detailLines.push(...lines);
      for (const l of raw.split('\n')) {
        detailLines.push(l.replace(/\r/g, ''));
      }
    } else {
      const normalized = raw.replace(/\r/g, '');
      const markerIdx = normalized.indexOf('\x00');
      const bodyRaw = markerIdx >= 0 ? normalized.substring(0, markerIdx).trim() : '';
      const patchRaw = (markerIdx >= 0 ? normalized.substring(markerIdx + 1) : normalized).replace(/^\n+/, '');
      detailLines.push(...headerLines);
      if (bodyRaw) {
        for (const l of bodyRaw.split('\n')) {
          detailLines.push(l.replace(/[\r\n]/g, ''));
        }
      }
      detailLines.push(...recoveryLines);
      detailLines.push(separator);
      for (const l of patchRaw.split('\n')) {
        detailLines.push(l.replace(/\r/g, ''));
      }
    }
    state.logDetailLines = detailLines;
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

// 빠른 커서 이동 시 spawn 큐 누적을 막기 위해 실제 fetch는 80ms debounce.
// 헤더/스크롤 reset은 즉시 처리해 시각적 즉응을 유지하고, _diffSeq로 out-of-order 결과를 가드한다.
const DIFF_DEBOUNCE_MS = 80;
let _diffDebounceTimer = null;

function updateDiff() {
  const item = selectedItem();
  if (!item) {
    if (_diffDebounceTimer) { clearTimeout(_diffDebounceTimer); _diffDebounceTimer = null; }
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
  if (_diffDebounceTimer) clearTimeout(_diffDebounceTimer);
  _diffDebounceTimer = setTimeout(() => {
    _diffDebounceTimer = null;
    if (_diffSeq !== seq) return;

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
  }, DIFF_DEBOUNCE_MS);
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
    gitExec(['log', '--max-count=' + FRESH_LOG_MAX_COUNT, '--since=' + tw.days + '.days.ago', '--name-status', '--pretty=format:__COMMIT__%h|%an|%aI|%s'], state.cwd, 30000).then(raw => {
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
  refreshAsync, refreshLog, loadMoreLog, rebuildLogGraphRows, selectedLogRef, updateLogDetail, updateDiff,
  FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail,
  refreshInBackground,
  getLastUserRefreshTime, touchUserRefreshTime, applyStageToState, applyUnstageToState,
  removeIndexLock,
  computeRefsTreeSignature,
};
