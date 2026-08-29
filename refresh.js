const { state, ui } = require('./state');
const { gitExec, gitExecChecked, gitProcessSucceeded, gitStatusSplit, gitStatusPorcelain, gitWorktrees, gitReflogRecoveries, gitReadConflictFile, splitUpstreamRef, parseUpstreamTrack } = require('./git');

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
const { acquireSpinner, releaseSpinner, beginPanelLoading, endPanelLoading, startSettleOp, endSettleOp } = require('./spinner');
const { applyWindowTitle } = require('./title');
const { stripDiffFileHeaders } = require('./text');

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
    const sel = ui.mergeChunkSelections[i];
    if (sel === 'ours' || sel === 'theirs' || sel === 'both') {
      nextSelections[i] = sel;
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
  // followup.message 는 이 refresh가 어떤 작업에 딸린 것인지 알려 주는 이름이다
  // (예: rename 뒤의 갱신은 계속 "Rename branch..."). 이름 없는 refresh가 나중에
  // 겹쳐 들어와도 그 이름을 "Refreshing..."으로 끌어내리지 않는다 — 무슨 작업이
  // 진행 중인지가 갱신 중이라는 사실보다 중요하다.
  if (followup.message) {
    state.refreshMessage = followup.message;
  } else if (!state.refreshing || !state.refreshMessage) {
    state.refreshMessage = 'Refreshing...';
  }
  state.refreshing = true;
  // followup.settle 은 "이 갱신이 끝나야 방금 한 쓰기 작업이 화면에 반영된다"는 표시다.
  // 그때까지 목록은 작업 직전 상태 그대로이므로 새 쓰기를 받으면 안 된다 — 예를 들어
  // 커밋 직후 이 구간에 Unstage 를 누르면 이미 커밋된 53개 파일을 상대로 명령이 나간다.
  // 낙관적 갱신(applyStageToState 등)으로 목록을 이미 맞춰 둔 호출부는 넘기지 않는다.
  //
  // 막을 범위는 원래 작업이 붙잡던 자원 그대로다 — 낡는 것은 그 작업이 바꾼 부분뿐이다.
  // 리네임 뒷정리 중의 파일 목록은 낡지 않았으므로 스테이징은 그대로 열려 있어야 한다.
  // scopes 를 따로 넘기지 않으면 아직 살아 있는 원래 작업의 것을 물려받는다.
  let settleOp = null;
  if (followup.settle) {
    settleOp = startSettleOp(followup.message || state.refreshMessage, followup.scopes);
  }
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
      if (settleOp) endSettleOp(settleOp);
      // releaseSpinner가 마지막 updateTitle을 부르므로, 타이틀에 남을 처리상태
      // 플래그를 먼저 내려야 스피너가 사라진 타이틀로 원복된다.
      if (_backgroundRefreshCount === 0) {
        state.refreshing = false;
        state.refreshMessage = '';
      }
      releaseSpinner();
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
  applyWindowTitle();
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
  applyWindowTitle();
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
// 대상: stash, for-each-ref(branches/remotes), remote 이름, worktrees, ahead/behind.
// user.* config는 글로벌 설정 변경과 일시적 조회 실패가 캐시에 고착되지 않도록 매번 다시 읽는다.
// status는 워킹트리 변경을 잡아야 하므로 항상 새로 호출한다.
let _metaCache = null;
let _metaFingerprint = '';
let _metaCacheCwd = '';

function configLookupCompleted(result) {
  // `git config --get-regexp` uses exit 1 for a valid "no matching key" result.
  return !!(result && (result.ok || result.exitCode === 1));
}

// `--show-scope` 출력("<scope>\t<key> <value>")을 종전의 2회 조회와 같은 모양으로 되돌린다.
// git은 우선순위가 낮은 scope부터 내보내므로 같은 키가 여러 번 나오면 뒤에 온 값이 이긴다.
// local 판정에 worktree scope는 넣지 않는다 — `config --local` 조회도 그것까지 세지는 않았다.
function parseScopedUserConfig(raw) {
  const effective = [];
  const effectiveIdx = new Map();
  const local = [];
  for (const line of (raw || '').split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const scope = line.substring(0, tab);
    const entry = line.substring(tab + 1);
    const sp = entry.indexOf(' ');
    const key = sp === -1 ? entry : entry.substring(0, sp);
    if (effectiveIdx.has(key)) effective[effectiveIdx.get(key)] = entry;
    else { effectiveIdx.set(key, effective.length); effective.push(entry); }
    if (scope === 'local') local.push(entry);
  }
  return { effective: effective.join('\n'), local: local.join('\n') };
}

async function queryCommitterConfig(cwd) {
  // effective 값과 "로컬에 지정되어 있는지"를 한 번의 조회로 얻는다. 예전에는 전체 조회와
  // --local 조회를 따로 걸어 refresh마다 프로세스를 두 개 썼다 — 프로세스 생성이 비싼
  // 환경에서는 이 하나가 그대로 체감 지연이 된다.
  const scoped = await gitExecChecked(['--no-optional-locks', 'config', '--show-scope', '--get-regexp', '^user\\.'], cwd);
  if (configLookupCompleted(scoped)) {
    return { ok: true, ...parseScopedUserConfig(scoped.text) };
  }
  // --show-scope 미지원(git 2.26 미만)이거나 조회 자체가 실패한 경우 — 종전 방식으로 되돌린다.
  const [effective, local] = await Promise.all([
    gitExecChecked(['--no-optional-locks', 'config', '--get-regexp', '^user\\.'], cwd),
    gitExecChecked(['--no-optional-locks', 'config', '--local', '--get-regexp', '^user\\.'], cwd),
  ]);
  return {
    ok: configLookupCompleted(effective) && configLookupCompleted(local),
    effective: effective.text,
    local: local.text,
  };
}

// committer 조회는 fingerprint 캐시에 넣지 않는다 — user.* 는 전역 config 에서도 오고,
// include/includeIf 로 딸려 오는 파일까지 mtime 으로 좇을 수는 없다. 대신 짧은 TTL 을 둔다.
// fetch 직후처럼 refresh 가 연달아 도는 구간에서 같은 값을 다시 읽지 않게 하는 것이 목적이고,
// 이 창을 넘기면 종전대로 다시 읽으므로 밖에서 바꾼 설정도 곧 따라온다.
// 실제 커밋은 git 이 config 를 직접 읽으므로 이 캐시의 영향을 받지 않는다 — 낡을 수 있는 것은 표시뿐이다.
const COMMITTER_CACHE_TTL_MS = 10000;
let _committerCache = null;
let _committerCacheCwd = '';
let _committerCacheAt = 0;

async function readCommitterConfig(cwd) {
  const now = Date.now();
  if (_committerCache && _committerCacheCwd === cwd && (now - _committerCacheAt) < COMMITTER_CACHE_TTL_MS) {
    return _committerCache;
  }
  let result = await queryCommitterConfig(cwd);
  // A failed host/Git call used to look like an unset config and was cached.
  // Retry once so a brief startup failure does not leave placeholders behind.
  if (!result.ok) result = await queryCommitterConfig(cwd);
  // 실패한 조회는 캐시하지 않는다 — 성공할 때까지 매번 다시 시도해야 한다.
  if (result.ok) {
    _committerCache = result;
    _committerCacheCwd = cwd;
    _committerCacheAt = now;
  }
  return result;
}

// 사용자가 플러그인에서 committer 를 직접 고쳤을 때처럼, 다음 refresh 가 반드시 다시 읽어야 하는 경우.
function invalidateCommitterCache() {
  _committerCache = null;
  _committerCacheCwd = '';
  _committerCacheAt = 0;
}

// 브랜치가 올라가 있는 리모트 이름 — 없으면 '' (아직 push 하지 않은 로컬 전용 브랜치).
// upstream이 우선이지만, 다른 도구가 `git push origin HEAD`처럼 추적 설정 없이 올린 브랜치는
// upstream이 비어 있어도 리모트에는 존재한다. 그래서 같은 이름의 원격 브랜치까지 확인해,
// 커밋 데코레이션에 origin/…이 보이는데 왼쪽 패널에는 @origin이 없는 어긋남을 없앤다.
function branchRemoteFor(branch) {
  if (!branch) return '';
  const fromUpstream = splitUpstreamRef(branch.upstream, state.remotes).remote;
  if (fromUpstream) return fromUpstream;
  // 여러 리모트에 같은 이름이 있을 수 있어 관례대로 origin을 먼저 본다.
  const ordered = state.remotes.includes('origin')
    ? ['origin', ...state.remotes.filter(r => r !== 'origin')]
    : state.remotes;
  for (const r of ordered) {
    if (state.remoteBranches.includes(r + '/' + branch.name)) return r;
  }
  return '';
}

function currentBranchRemote() {
  return branchRemoteFor(state.branches.find(b => b.isCurrent));
}

// for-each-ref 타임아웃. gitExec 기본값 5초는 ref가 많은 저장소에서 메타 조회 8개를
// 동시에 spawn할 때(특히 Windows) 빠듯하다. 여기서 타임아웃이 나면 브랜치 목록이
// 통째로 비므로 status와 같은 수준으로 여유를 준다.
const REFS_TIMEOUT_MS = 15000;

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

// linked worktree에서는 HEAD/logs/HEAD만 per-worktree git dir에 있고
// config·packed-refs·refs·worktrees는 공용 git dir(--git-common-dir)에 있다.
// 두 경로를 구분하지 않으면 워크트리에서 브랜치/원격/워크트리 변경을 영영 놓친다.
//
// FETCH_HEAD는 일부러 넣지 않는다. 이 지문이 지키는 것은 stash·for-each-ref·remote·
// worktree·ahead-behind 다섯 가지인데, 그중 어느 것도 FETCH_HEAD를 읽지 않는다.
// 반면 FETCH_HEAD는 가져온 것이 없는 fetch에도 매번 다시 쓰이므로, 넣어 두면
// "원격에 변화 없음"이라는 가장 흔한 fetch가 매번 메타 조회 전량 재실행으로 이어진다.
// fetch가 실제로 무언가를 가져왔다면 refs 트리나 packed-refs가 바뀌므로 그 쪽에서 잡힌다.
function metaFingerprintTargets(gitDir, commonDir) {
  const sep = (process.platform === 'win32') ? '\\' : '/';
  const common = commonDir || gitDir;
  const targets = [
    gitDir + sep + 'HEAD',
    gitDir + sep + 'logs' + sep + 'HEAD',
    common + sep + 'config',
    common + sep + 'packed-refs',
    common + sep + 'refs',
    common + sep + 'worktrees',
  ];
  if (common !== gitDir) targets.push(gitDir + sep + 'refs');
  return targets;
}

async function statMtimeOrMissing(path) {
  try {
    const r = await hecaton.fs.stat({ path });
    return (r && r.exists) ? (r.mtime_ms || 0) : -1;
  } catch { return -1; }
}

async function computeMetaFingerprint(cwd, gitDir, commonDir) {
  if (!gitDir) return '';
  const common = commonDir || gitDir;
  const targets = metaFingerprintTargets(gitDir, common);
  const [stats, refsSig] = await Promise.all([
    Promise.all(targets.map(statMtimeOrMissing)),
    computeRefsTreeSignature(common).catch(() => ''),
  ]);
  return stats.join('|') + '\x1e' + refsSig;
}

// 로그 지문이 보는 대상. 메타 지문과 달리 FETCH_HEAD와 config는 넣지 않는다 —
// `git log --all`이 읽지 않는 것들이라, 넣어 두면 가져온 것이 없는 fetch까지
// (FETCH_HEAD는 매번 다시 쓰이므로) 로그 전량 재조회로 이어진다.
// logs/HEAD는 남긴다: 리커버리 후보가 reflog에서 나온다.
function logFingerprintTargets(gitDir, commonDir) {
  const sep = (process.platform === 'win32') ? '\\' : '/';
  const common = commonDir || gitDir;
  const targets = [
    gitDir + sep + 'HEAD',
    gitDir + sep + 'logs' + sep + 'HEAD',
    common + sep + 'packed-refs',
    common + sep + 'refs',
    common + sep + 'worktrees',
  ];
  if (common !== gitDir) targets.push(gitDir + sep + 'refs');
  return targets;
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
  applyWindowTitle();
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
    const preCheck = await hecaton.process.exec({ program: 'git', args: ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree', '--git-dir', '--git-common-dir'], cwd: state.cwd, timeout_ms: 5000 });
    const preLines = preCheck ? (preCheck.stdout || '').replace(/\r\n/g, '\n').split('\n') : [];
    const insideWorkTree = (preLines[0] || '').trim();
    const preGitDir = (preLines[1] || '').trim();
    const preCommonDir = (preLines[2] || '').trim();
    if (!gitProcessSucceeded(preCheck) || insideWorkTree !== 'true') {
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
      if (gitProcessSucceeded(preCheck) && insideWorkTree !== 'true') {
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
      state.branch = ''; state.worktrees = []; state.isLinkedWorktree = false; state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.ignoredLoaded = false; state.ignoredLoading = false; state.diffLines = []; state.conflictView = null; state.currentDiffFile = null;
      return;
    }
    if (preGitDir && !state.gitDir) {
      const sep = (process.platform === 'win32') ? '\\' : '/';
      const isAbsolute = preGitDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(preGitDir);
      state.gitDir = isAbsolute ? preGitDir : (state.cwd + sep + preGitDir);
    }
    if (!state.gitCommonDir) {
      const sep = (process.platform === 'win32') ? '\\' : '/';
      if (preCommonDir) {
        const isAbsolute = preCommonDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(preCommonDir);
        state.gitCommonDir = isAbsolute ? preCommonDir : (state.cwd + sep + preCommonDir);
      } else {
        state.gitCommonDir = state.gitDir;  // --git-common-dir 미지원 git 폴백
      }
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
  // - status는 항상 호출 (워킹트리 변경 추적). porcelain 한 번으로 staged/unstaged/
  //   untracked/ignored를 모두 받는다 — split 방식은 rev-parse까지 앞세워 4번을 썼다.
  // - 메타(stash/for-each-ref/remote/worktrees/user 2종/ahead-behind) 7개는 fingerprint 캐시 적중 시 재호출 생략
  // - git-dir은 state.gitDir 캐시 우선 (preCheck/setupGitWatcher가 채움)
  // → 캐시 적중: 1 spawn (status), 미스: 8 spawn
  // upstream:track / trackshort까지 함께 받아 브랜치별 ahead/behind를 얻는다. 같은
  // for-each-ref 한 번에 딸려 오므로 spawn이 늘지 않는다 — Pinned 목록이 현재 브랜치처럼
  // push/pull 대기 수를 보여주는 데 쓴다.
  const refsFormat = '%(HEAD)\t%(refname)\t%(upstream:short)\t%(upstream:track)\t%(upstream:trackshort)';
  const sepLocal = (process.platform === 'win32') ? '\\' : '/';
  const gitDirPromise = (state.gitDir && state.gitCommonDir)
    ? Promise.resolve(state.gitDir)
    : gitExec(['--no-optional-locks', 'rev-parse', '--git-dir', '--git-common-dir'], state.cwd).then(raw => {
        const lines = raw.replace(/\r\n/g, '\n').split('\n');
        const resolve = (v) => {
          const trimmed = (v || '').trim();
          if (!trimmed) return '';
          const isAbsolute = trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed);
          return isAbsolute ? trimmed : (state.cwd + sepLocal + trimmed);
        };
        const resolvedGitDir = resolve(lines[0]);
        const resolvedCommon = resolve(lines[1]);
        if (resolvedGitDir) state.gitDir = resolvedGitDir;
        // --git-common-dir 미지원(구 git)이면 git-dir로 폴백 — 종전 동작과 동일해진다.
        state.gitCommonDir = resolvedCommon || resolvedGitDir;
        return state.gitDir;
      });

  // git-dir과 fingerprint를 먼저 확정 (메타 캐시 적중 여부 결정)
  const gitDir = await gitDirPromise;
  if (_metaCacheCwd && _metaCacheCwd !== state.cwd) invalidateMetaCache();
  // push는 원격 추적 ref(refs/remotes/...)만 갱신하는데 fingerprint가 이를 잡지 못해
  // ahead/behind가 캐시에 묶인다. forceMeta로 명시 무효화한다.
  if (options.forceMeta) invalidateMetaCache();
  const fingerprint = await computeMetaFingerprint(state.cwd, gitDir, state.gitCommonDir);
  const metaHit = !!_metaCache && fingerprint && fingerprint === _metaFingerprint;

  const includeIgnored = metadataOnly ? false : shouldIncludeIgnored(options);
  if (!metadataOnly) state.ignoredLoading = includeIgnored;
  let statusSnapshot, stashRaw, refsRaw, remoteNamesRaw, worktrees, aheadBehindRaw;
  // refs/remote/worktrees 조회가 실제로 성공했는지 — 실패를 "0건"으로 오인해 목록을 지우지 않기 위한 플래그.
  // 캐시에는 성공한 결과만 넣으므로 캐시 적중 경로는 항상 true다.
  let refsOk = true, remoteNamesOk = true, worktreesOk = true;
  // status 조회 방식은 경량 refresh와 같은 규칙을 쓴다 — 기본은 단일 프로세스(porcelain).
  // split은 rev-parse(직렬) → diff-index + diff-files + ls-files 로 프로세스를 4개 쓰는데,
  // 프로세스 생성 자체가 비싼 환경에서는 그 차이가 곧 체감 지연이 된다.
  const fullStatusReader = options.singleProcessStatus === false ? gitStatusSplit : gitStatusPorcelain;
  const statusPromise = metadataOnly
    ? Promise.resolve(null)
    : fullStatusReader(state.cwd, {
        displayUntracked: untrackedFlag !== '-uno',
        includeIgnored,
        maxFilesDisplayed,
        timeout: statusTimeout,
      });
  const committerConfigPromise = readCommitterConfig(state.cwd);
  let committerConfig;
  if (metaHit) {
    [statusSnapshot, committerConfig] = await Promise.all([statusPromise, committerConfigPromise]);
    stashRaw = _metaCache.stashRaw;
    refsRaw = _metaCache.refsRaw;
    remoteNamesRaw = _metaCache.remoteNamesRaw;
    worktrees = _metaCache.worktrees;
    aheadBehindRaw = _metaCache.aheadBehindRaw;
  } else {
    let refsRes, remoteNamesRes;
    [statusSnapshot, stashRaw, refsRes, remoteNamesRes, worktrees, aheadBehindRaw, committerConfig] =
      await Promise.all([
        statusPromise,
        gitExec(['--no-optional-locks', 'stash', 'list', '--format=%H\t%h\t%gd\t%s'], state.cwd),
        gitExecChecked(['--no-optional-locks', 'for-each-ref', '--format=' + refsFormat, 'refs/heads', 'refs/remotes'], state.cwd, REFS_TIMEOUT_MS),
        gitExecChecked(['--no-optional-locks', 'remote'], state.cwd),
        gitWorktrees(state.cwd),
        gitExec(['--no-optional-locks', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], state.cwd),
        committerConfigPromise,
      ]);
    refsOk = refsRes.ok;
    refsRaw = refsRes.text;
    // 일시적인 host/Git 실패를 "리모트 0개"로 캐시하면 원격 브랜치는 보이는데
    // Fetch/Pull만 막히는 상태가 된다. 한 번 더 읽고, 그래도 실패하면 이전 값을 보존한다.
    if (!remoteNamesRes.ok) {
      remoteNamesRes = await gitExecChecked(['--no-optional-locks', 'remote'], state.cwd);
    }
    remoteNamesOk = remoteNamesRes.ok;
    remoteNamesRaw = remoteNamesRes.text;
    // 정상 저장소의 worktree list는 최소 메인 워크트리 한 줄을 낸다. 빈 결과는 조회 실패다.
    worktreesOk = worktrees.length > 0;
    // 실패한 조회 결과를 캐시에 넣으면 fingerprint(.git 내부 mtime)가 바뀔 때까지 빈 목록이
    // 계속 재사용된다. 브랜치가 한참 동안 사라져 보이는 원인이므로 성공했을 때만 캐시한다.
    if (fingerprint && refsOk && remoteNamesOk && worktreesOk) {
      _metaCache = { stashRaw, refsRaw, remoteNamesRaw, worktrees, aheadBehindRaw };
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
        const track = parseUpstreamTrack(parts[3] || '', parts[4] || '');
        branches.push({ name, isCurrent, upstream, ahead: track.ahead, behind: track.behind, upstreamGone: track.gone });
      } else if (refname.startsWith('refs/remotes/')) {
        const name = refname.substring('refs/remotes/'.length);
        if (name.includes('/HEAD')) continue;
        remoteBranches.push(name);
      }
    }
  }
  // refs 조회가 실패했으면 이전 브랜치 상태를 그대로 둔다. 빈 파싱 결과로 덮어쓰면
  // 브랜치/원격 목록이 통째로 사라지고 현재 브랜치까지 detached로 잘못 표시된다.
  if (refsOk) {
    state.branch = currentBranch || (metadataOnly && state.branch ? state.branch : 'HEAD (detached)');
  } else {
    // git 호출이 실패해도 .git/HEAD는 읽을 수 있다 — 브랜치명만이라도 최신으로 맞춘다.
    const headName = await readBranchNameFast().catch(() => '');
    if (headName) state.branch = headName;
    else if (!state.branch) state.branch = 'HEAD (detached)';
  }
  if (!metadataOnly) {
    applyStatusSnapshot(statusSnapshot, includeIgnored);
  }

  // stashes
  state.stashes = stashRaw.trim() ? stashRaw.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return { hash: parts[0], shortHash: parts[1], ref: parts[2], message: parts[3] || '' };
  }) : [];

  // branches / remoteBranches — refs 파싱 결과 사용
  if (refsOk) {
    state.branches = branches;
    state.remoteBranches = remoteBranches;
  }

  // remotes (remote 이름 목록 — 브랜치 없이 remote만 있을 수 있어 별도 조회)
  // 조회 실패를 실제 0개와 구분해, 화면에 이미 보이던 리모트와 버튼 상태를 지킨다.
  if (remoteNamesOk) {
    state.remotes = remoteNamesRaw.trim() ? remoteNamesRaw.trim().split('\n').filter(Boolean) : [];
  }

  if (worktreesOk) {
    state.worktrees = worktrees;
    const currentWt = worktrees.find(w => w.isCurrent);
    state.isLinkedWorktree = !!(currentWt && !currentWt.isMain);
  }

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
    // MERGE_HEAD 는 해시만 남기므로 들어오는 브랜치 이름은 메시지에서 뽑는다 —
    // 충돌 화면에서 Ours/Theirs 가 각각 어느 브랜치인지 적으려면 이름이 필요하다.
    if (state.operationState.type === 'merge' && state.rebaseMessage) {
      const m = state.rebaseMessage.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
      if (m) state.operationState.incomingName = m[1];
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
  if (committerConfig.ok) {
    const userCfg = parseUserCfg(committerConfig.effective);
    const localUserCfg = parseUserCfg(committerConfig.local);
    state.committerName = userCfg.name;
    state.committerEmail = userCfg.email;
    state.committerNameIsLocal = !!localUserCfg.name;
    state.committerEmailIsLocal = !!localUserCfg.email;
  }

  // ahead/behind
  // upstream이 없으면 `@{u}` 조회가 실패해 빈 값이 온다. 그래도 같은 이름의 원격 브랜치가 있으면
  // 그 ref로 한 번 더 세어, @리모트 표기는 붙었는데 화살표만 빠지는 어긋남을 막는다.
  // 결과를 메타 캐시에 넣어 새로고침마다 spawn이 하나 늘지 않게 한다. 조회가 실패해 빈 값이
  // 와도 시도 자체를 기록해 둔다 — 안 그러면 같은 fingerprint 동안 매번 다시 spawn 한다.
  const abFallbackDone = !!(metaHit && _metaCache && _metaCache.abFallbackDone);
  if (!aheadBehindRaw.trim() && !abFallbackDone) {
    const cur = state.branches.find(b => b.isCurrent);
    const remote = cur && !cur.upstream ? currentBranchRemote() : '';
    if (remote) {
      aheadBehindRaw = await gitExec(
        ['--no-optional-locks', 'rev-list', '--left-right', '--count', 'refs/remotes/' + remote + '/' + cur.name + '...HEAD'],
        state.cwd,
      );
      if (_metaCache && _metaCacheCwd === state.cwd) {
        _metaCache.aheadBehindRaw = aheadBehindRaw;
        _metaCache.abFallbackDone = true;
      }
    }
  }
  const abParts = aheadBehindRaw.trim().split(/\s+/);
  state.behind = parseInt(abParts[0]) || 0;
  state.ahead = parseInt(abParts[1]) || 0;

  if (metadataOnly) {
    applyWindowTitle();
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

// 로그 조회 결과 캐시. refreshLog 한 번은 git 프로세스를 최대 5개까지 직렬로 쓴다
// (fast → prefetch → full → reflog → recovered). 그런데 rename branch 처럼 커밋
// 그래프를 건드리지 않는 작업 뒤에도 액션마다 전량을 다시 돌고 있었다.
// 그래프의 입력이 그대로면 결과도 그대로이므로, 지문이 같으면 통째로 건너뛴다.
//
// 지문에 넣는 것은 "git 을 다시 불러야만 알 수 있는" 입력뿐이다. 리커버리 토글이나
// 브랜치 Filter/Hide 는 _lastGraphCommits(원본 커밋 캐시)로 다시 그리면 되므로 넣지 않고,
// 캐시 적중 경로에서 rebuildLogGraphRows() 를 돌려 현재 표시 설정을 반영한다.
let _logCacheFingerprint = '';
let _logCacheCwd = '';

// 지문을 못 만들면 '' 를 돌려준다 — 호출부는 캐시를 쓰지 않고 종전대로 전량 실행한다.
// (gitDir 미확정, read_dir 미지원 호스트, refs 스캔 실패 등)
async function computeLogFingerprint(stashHashes) {
  if (!state.gitDir) return '';
  const common = state.gitCommonDir || state.gitDir;
  const [stats, refsSig] = await Promise.all([
    Promise.all(logFingerprintTargets(state.gitDir, common).map(statMtimeOrMissing)),
    computeRefsTreeSignature(common).catch(() => ''),
  ]);
  // refs 트리를 읽지 못하면 브랜치/태그 이동을 놓친다. mtime만으로 넘겨짚지 않고 포기한다.
  if (!refsSig) return '';
  return stats.join('|') + '\x1e' + refsSig + '\x1e' + stashHashes.join(',') + '\x1e' + _logRequestedLimit;
}

// 로그 조회가 끝까지 정상적으로 완주했을 때만 지문을 기록한다. 중간에 밀려난(_logSeq 불일치)
// 실행이나 실패한 실행의 지문을 남기면, 화면에 없는 결과를 캐시된 것으로 착각한다.
function markLogCached(fingerprint, seq) {
  if (!fingerprint || _logSeq !== seq) return;
  _logCacheFingerprint = fingerprint;
  _logCacheCwd = state.cwd;
}

// 커밋 그래프를 바꾼 작업 뒤에 호출해 다음 refreshLog 가 반드시 git 을 다시 돌게 한다.
function invalidateLogCache() {
  _logCacheFingerprint = '';
  _logCacheCwd = '';
}

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

// decoration(%D) 한 줄에서 ref 키를 뽑는다. Filter/Hide 가 쓰는 키와 같은 형식이어야
// 하므로 풀 refname 으로 맞춘다.
//   - 'HEAD -> main' 은 main 하나로 본다. HEAD 를 따로 루트로 세우면 현재 브랜치를 숨겨도
//     HEAD 가 남아 아무것도 사라지지 않는다.
//   - '<remote>/HEAD' 는 다른 ref 의 별칭일 뿐이라 건너뛴다. 남겨 두면 origin/HEAD 때문에
//     origin/main 숨김이 통째로 무력해진다.
//   - 로컬/리모트 판별은 실제 브랜치 목록으로 한다. 'origin/foo' 라는 로컬 브랜치가 있어도
//     리모트로 오인하지 않는다.
//   - 정체를 모르는 ref(refs/stash 등)는 'ref:' 를 붙여 그대로 둔다 — 지정 대상이 될 일은
//     없지만 루트로는 살아 있어야 그 커밋이 사라지지 않는다.
function refKeysOfDecoration(deco, localNames, remoteNames) {
  if (!deco) return [];
  const keys = [];
  for (let token of String(deco).split(',')) {
    token = token.trim();
    if (!token) continue;
    if (token.startsWith('HEAD -> ')) token = token.substring('HEAD -> '.length).trim();
    if (!token) continue;
    if (token === 'HEAD') { keys.push('HEAD'); continue; }
    if (token.startsWith('tag: ')) { keys.push('refs/tags/' + token.substring('tag: '.length).trim()); continue; }
    if (localNames.has(token)) { keys.push('refs/heads/' + token); continue; }
    if (token.endsWith('/HEAD')) continue;
    if (remoteNames.has(token)) { keys.push('refs/remotes/' + token); continue; }
    keys.push('ref:' + token);
  }
  return keys;
}

// 히스토리 Filter/Hide 적용 — 그래프에 남길 커밋을 ref 도달성으로 고른다.
//
// 루트 = (Filter 가 있으면 그 ref 들, 없으면 로그에 등장한 모든 ref) − Hide 한 ref.
// 거기서 부모를 따라 내려가며 닿는 커밋만 남긴다. Hide 로는 "그 브랜치에서만 닿는" 커밋이
// 사라지고 다른 ref 와 공유하는 커밋은 그대로 남는데, 다른 ref 들이 여전히 루트라서 그렇다.
//
// 팁 해시는 %D(decoration)에서 읽는다 — 이미 받아 둔 로그 안에 있어 추가 조회가 없고,
// 태그나 detached HEAD 처럼 for-each-ref 로 따로 받지 않는 ref 도 같은 자리에 들어 있다.
// 팁이 max-count 밖으로 밀려난 브랜치는 애초에 그릴 커밋이 없으니 루트로 세울 일도 없다.
function applyRefFilters(commits, stashFullHashes) {
  const filterList = ui.filteredRefs || [];
  const hiddenList = ui.hiddenRefs || [];
  if (filterList.length === 0 && hiddenList.length === 0) return commits;

  const localNames = new Set(state.branches.map(b => b.name));
  const remoteNames = new Set(state.remoteBranches);
  const filterSet = new Set(filterList);
  const hiddenSet = new Set(hiddenList);
  const whitelist = filterList.length > 0;

  const byHash = new Map();
  for (const c of commits) byHash.set(c.hash, c);

  const keep = new Set();
  const stack = [];
  const addRoot = (hash) => {
    if (keep.has(hash) || !byHash.has(hash)) return;
    keep.add(hash);
    stack.push(hash);
  };

  for (const c of commits) {
    // Filter 는 "이 브랜치만 보기"다 — 지정 밖이면 스태시도 유실 커밋도 함께 빠진다.
    // Filter 가 없을 때(Hide 만 걸렸을 때)는 어떤 브랜치에도 매달리지 않은 이 커밋들이
    // 루트를 잃고 통째로 사라지므로 여기서 살려 둔다.
    if (!whitelist && (stashFullHashes.has(c.hash) || c.isRecovery)) { addRoot(c.hash); continue; }
    for (const key of refKeysOfDecoration(c.refs, localNames, remoteNames)) {
      if (hiddenSet.has(key)) continue;
      if (whitelist && !filterSet.has(key)) continue;
      addRoot(c.hash);
      break;
    }
  }

  while (stack.length > 0) {
    const commit = byHash.get(stack.pop());
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (keep.has(parent) || !byHash.has(parent)) continue;
      keep.add(parent);
      stack.push(parent);
    }
  }

  return commits.filter(c => keep.has(c.hash));
}

// 정렬 모드 토글 시 git 재조회 없이 그래프만 다시 만들기 위한 마지막 입력 캐시
let _lastGraphCommits = null;
let _lastGraphStashHashes = null;

function buildLogGraphRows(rawCommits, stashFullHashes) {
  _lastGraphCommits = rawCommits;
  _lastGraphStashHashes = stashFullHashes;

  // 리커버리 숨김. 캐시에는 원본을 남겨 두어 토글을 다시 켜면 git 재조회 없이 되살아난다.
  // 유실 커밋의 자식은 언제나 유실 커밋이므로, 빼도 살아있는 커밋의 부모 사슬은 안 끊긴다.
  const afterRecovery = ui.logShowRecovery ? rawCommits : rawCommits.filter(c => !c.isRecovery);

  // 브랜치 Filter/Hide. 리커버리 토글과 같은 이유로 그리기 단계에서만 걸러 낸다 —
  // 지정을 바꿔도 git 을 다시 부르지 않고 rebuildLogGraphRows() 로 즉시 반영된다.
  // 스태시 서브커밋 정리보다 먼저 돌려야 한다: 스태시 커밋이 남으면 그 부모인 서브커밋도
  // 도달 가능하므로 따라 남고, 아래 정리 단계가 평소대로 걷어 간다.
  const visibleCommits = applyRefFilters(afterRecovery, stashFullHashes);

  // Filter stash sub-commits (index, untracked) to keep graph clean.
  const stashSubHashes = new Set();
  for (const c of visibleCommits) {
    if (stashFullHashes.has(c.hash) && c.parents.length > 1) {
      for (let i = 1; i < c.parents.length; i++) {
        stashSubHashes.add(c.parents[i]);
      }
    }
  }
  let commits = stashSubHashes.size > 0
    ? visibleCommits
        .filter(c => !stashSubHashes.has(c.hash))
        .map(c => {
          const fp = c.parents.filter(p => !stashSubHashes.has(p));
          return fp.length === c.parents.length ? c : { ...c, parents: fp };
        })
    : visibleCommits;

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
    // 그래프 입력이 지난번과 같으면 git 을 한 번도 부르지 않는다. 지문 계산은 fs 조회만
    // 쓰므로(호스트 RPC 중 exec 만 비싸다) 아낀 프로세스 5개에 비하면 사실상 공짜다.
    const logFingerprint = await computeLogFingerprint(stashHashes);
    if (_logSeq !== seq) return;
    const cacheHit = !options.force
      && logFingerprint
      && logFingerprint === _logCacheFingerprint
      && _logCacheCwd === state.cwd
      && _lastGraphCommits
      && state.logItems.length > 0;
    if (cacheHit) {
      // 커밋은 그대로여도 리커버리 토글·필터 지정은 그 사이 바뀌었을 수 있다.
      // 원본 커밋 캐시로 다시 그려 현재 표시 설정을 반영한다.
      rebuildLogGraphRows();
      state.logLoading = false;
      if (state.rightView === 'log') {
        updateLogDetail();
        require('./render').render();
      }
      return;
    }
    // 여기서부터는 실제로 다시 읽는다. 완주하기 전에 밀려나면 낡은 지문이 남지 않도록 먼저 지운다.
    invalidateLogCache();

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
        markLogCached(logFingerprint, seq);
        if (state.rightView === 'log') require('./render').render();
        return;
      }

      const recoveredRaw = await gitExec(buildArgs(LOG_FULL_LIMIT, recovery.hashes || []), state.cwd, 30000);
      if (_logSeq !== seq) return;
      const recoveredCommits = parseLogRaw(recoveredRaw, recovery, recoveryHashSet);
      if (recoveredCommits.length === 0 && fastCommits.length > 0) {
        // 리커버리 재조회가 빈손으로 왔다 — 화면은 1차 결과 그대로다. 실패했을 수 있는
        // 결과를 캐시하면 지문이 바뀔 때까지 그 상태에 묶이므로 여기서는 기록하지 않는다.
        state.logLoading = false;
        if (state.rightView === 'log') require('./render').render();
        return;
      }
      applyLogGraphRows(buildLogGraphRows(recoveredCommits, stashFullHashes));
      state.logLoadedLimit = recoveredCommits.length;
      state.logHasMore = false;
      if (state.rightView === 'log') updateLogDetail();
      state.logLoading = false;
      markLogCached(logFingerprint, seq);
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
    if (recoveryHashSet.size === 0) { markLogCached(logFingerprint, seq); return; }

    const recoveredRaw = await gitExec(buildArgs(fullLimit, recovery.hashes || []), state.cwd, 30000);
    if (_logSeq !== seq) return;
    const recoveredCommits = parseLogRaw(recoveredRaw, recovery, recoveryHashSet);
    // 위와 같은 이유로, 빈손으로 온 재조회 결과는 캐시하지 않는다.
    if (recoveredCommits.length === 0 && expandedCommits.length > 0) return;
    applyLogGraphRows(buildLogGraphRows(recoveredCommits, stashFullHashes));
    state.logLoadedLimit = fullLimit;
    state.logHasMore = recoveredCommits.length >= fullLimit;
    if (state.rightView === 'log') updateLogDetail();
    markLogCached(logFingerprint, seq);
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
    endPanelLoading('logDetail');
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
  if (options.headerOnly) { endPanelLoading('logDetail'); return; }
  // 본문/패치가 도착할 때까지 상세 끝에 스피너를 붙인다.
  beginPanelLoading('logDetail');
  const stashRef = ui.stashMap.get(item.ref);
  const promise = stashRef
    ? gitExec(['stash', 'show', '-p', stashRef], state.cwd, 30000)
    : gitExec(['show', '--format=%B%x00', '--patch', item.ref], state.cwd, 30000);
  promise.then(raw => {
    if (_logDetailSeq !== seq) return;
    endPanelLoading('logDetail');
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
  }, () => {
    // 실패로 끝나도 스피너는 걷는다. 더 새 요청이 떠 있으면 그 쪽 것은 건드리지 않는다.
    if (_logDetailSeq !== seq) return;
    endPanelLoading('logDetail');
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
    endPanelLoading('diff');
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

  // 보여 줄 것이 없는 동안에만 스피너를 켠다 — 이미 그려진 diff를 다시 읽는 경우(스테이징,
  // 백그라운드 refresh)엔 화면이 비지 않으니 알릴 것도 없고, 프레임마다 다시 그릴 이유도 없다.
  // debounce 전에 켜야 기다리는 80ms 동안 "Select a file to view diff" 안내가 잘못 보이지 않는다.
  const showsNothing = state.diffLines.length === 0
    && !(state.conflictView && state.conflictView.file === item.file);
  if (showsNothing) beginPanelLoading('diff');

  const seq = ++_diffSeq;
  if (_diffDebounceTimer) clearTimeout(_diffDebounceTimer);
  _diffDebounceTimer = setTimeout(() => {
    _diffDebounceTimer = null;
    if (_diffSeq !== seq) return;

    if (item.status === 'U') {
      gitReadConflictFile(state.cwd, item.file).then(conflictView => {
        if (_diffSeq !== seq) return;
        endPanelLoading('diff');
        state.conflictView = conflictView;
        state.diffLines = [];
        if (ui.mergeConflictFile !== item.file) {
          ui.mergeConflictFile = item.file;
          ui.mergeChunkCursor = 0;
          ui.mergeChunkSelections = {};
        }
        ensureConflictSelections(conflictView);
        require('./render').render();
      }, () => {
        if (_diffSeq !== seq) return;
        endPanelLoading('diff');
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
      endPanelLoading('diff');
      state.conflictView = null;
      state.diffLines = raw.split('\n');
      require('./render').render();
    }, () => {
      if (_diffSeq !== seq) return;
      endPanelLoading('diff');
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
    endPanelLoading('freshDetail');
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
  // diff 쪽과 같은 기준 — 이미 그려진 내용이 있으면 스피너를 켜지 않는다.
  if (state.freshDetailLines.length === 0) beginPanelLoading('freshDetail');

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
    endPanelLoading('freshDetail');
    // 여기서 걸러 두면 스크롤 한계 계산까지 한 배열만 보게 된다 — 이 목록은
    // 화면 표시 전용이라(패치를 만들지 않는다) 원본을 남길 이유가 없다.
    state.freshDetailLines = stripDiffFileHeaders(raw.split('\n'));
    require('./render').render();
  }, () => {
    if (_freshDetailSeq !== seq) return;
    endPanelLoading('freshDetail');
    require('./render').render();
  });
}

module.exports = {
  buildFileList, selectedItem, clampCursor,
  refreshAsync, refreshLog, loadMoreLog, buildLogGraphRows, rebuildLogGraphRows, selectedLogRef, updateLogDetail, updateDiff,
  formatDateTime,
  FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail,
  refreshInBackground,
  getLastUserRefreshTime, touchUserRefreshTime, applyStageToState, applyUnstageToState,
  removeIndexLock,
  invalidateCommitterCache,
  // 테스트용: TTL 만료를 흉내낸다. 캐시 내용은 그대로 두고 나이만 되돌린다.
  __expireCommitterCache() { _committerCacheAt = 0; },
  computeRefsTreeSignature,
  currentBranchRemote,
  branchRemoteFor,
};
