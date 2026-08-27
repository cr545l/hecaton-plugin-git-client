const state = {
  cwd: '',
  isGitRepo: false,
  gitDir: '',           // cached resolved git-dir absolute path (invalidated on cwd change)
  gitCommonDir: '',     // cached resolved git-common-dir — linked worktree에서 공용 .git (refs/config/packed-refs/worktrees)
  branch: '',
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  ignoredLoaded: false,
  ignoredLoading: false,
  cursor: 0,
  scrollOffset: 0,
  focusPanel: 'status',  // 'status' | 'diff'
  diffLines: [],
  conflictView: null,      // conflict chunks for unmerged file side-by-side view
  diffView: 'side',  // 'side' | 'unified' (staged/unstaged 양쪽에 적용)
  diffScrollOffset: 0,
  diffScrollX: 0,
  filesScrollX: 0,
  currentDiffFile: null, // Current file being viewed in diff panel
  rightView: 'diff',     // 'diff' | 'log' | 'fresh'
  logItems: [],           // [{ type:'commit'|'graph', graphStr, ref, decoration, subject }]
  logSelectables: [],     // indices into logItems that are selectable
  logLoading: false,
  logLoadingMore: false,
  logHasMore: false,
  logLoadedLimit: 0,
  logCursor: 0,           // index into logSelectables
  logScrollOffset: 0,
  logDetailLines: [],
  branches: [],           // [{ name, isCurrent }]
  remoteBranches: [],     // ['origin/main', ...]
  remotes: [],            // ['origin', 'upstream', ...]
  worktrees: [],          // [{ path, branch, head, isCurrent, isMain, isDetached, isBare, isLocked, isPrunable }]
  isLinkedWorktree: false, // 현재 저장소가 메인이 아닌 linked worktree인지
  stashes: [],            // [{ hash, shortHash, ref }]
  recoveryRefs: {},       // { [hash]: { selector, subject } }
  operationState: null,  // null | { type: 'rebase-merge'|'rebase-apply'|'merge'|'cherry-pick'|'revert', step?, total? }
  rebaseMessage: '',     // pre-filled commit message during rebase/merge/cherry-pick
  selectedFiles: new Set(),
  mode: 'normal',        // 'normal' | 'commit'
  commitMsg: '',
  commitCursor: 0,
  commitAmend: false,    // commit 모드에서 --amend 여부
  pendingDialogAction: null,  // 'new-branch' | 'new-tag' | 'rename-stash' | 'new-remote' | null
  pendingDialogTarget: null,
  pendingRebaseMenu: false,
  error: null,
  loading: true,
  minimized: false,
  pendingStash: false,
  pendingRebaseRef: null,
  pendingStashCreateBranch: null,  // { name, startPoint, opName } — 로컬 변경에 막힌 브랜치 생성의 재시도 정보
  pendingDiscardFiles: null,
  pendingRemoveFiles: null,        // 버전관리 제외 대상 파일 경로 목록
  pendingRemoveKeepLocal: false,   // true: git rm --cached (로컬 유지), false: git rm (로컬 삭제)
  committerName: '',
  committerEmail: '',
  committerNameIsLocal: false,
  committerEmailIsLocal: false,
  pendingCommitterEdit: null, // 'name' | 'email' | null
  freshItems: [],          // [{file, status, author, date, commitHash, commitMsg, isPending, isDeleted}]
  freshCursor: 0,
  freshScrollOffset: 0,
  freshDetailLines: [],
  freshTimeWindow: 1,      // FRESH_TIME_WINDOWS index (default: 7 days)
  freshTimeWindowMode: false,
  ahead: 0,
  behind: 0,
  // ── 진행 중인 쓰기 작업 목록 ──
  // [{ label, scopes: string[], phase: 'running' | 'settling' }]
  // 예전에는 "무언가 돌고 있다"는 사실만 불리언 하나로 들고 있었다. 그래서 브랜치
  // 리네임처럼 ref 만 건드리는 작업이 도는 동안에도 스테이징까지 전부 막혔다.
  // 지금은 각 작업이 무엇을 붙잡고 있는지(scopes)를 함께 들고, actions.js 가 그것과
  // 겹치는 동작만 막는다. spinner.js 가 유일한 관리자이며 아래 두 플래그를 파생시킨다.
  activeOps: [],
  spinnerActive: false,  // activeOps 에 running 이 하나라도 있는가 (파생값)
  // 쓰기 작업의 git 명령은 끝났지만 그 결과를 다시 읽어오는 갱신이 아직 도는 중.
  // 이 구간의 목록(staged/unstaged/branches)은 커밋 직전 상태 그대로라, 여기에 대고
  // 새 쓰기를 걸면 사라진 대상을 상대로 명령을 쏘게 된다. 창 타이틀도 이 동안 계속
  // "Committing..."을 보여 주므로, 사용자 눈에도 아직 끝나지 않은 한 동작이다.
  // → 뒷정리 갱신도 원래 작업과 같은 scopes 를 물려받은 activeOps 항목으로 남는다.
  settlingWrite: false,  // activeOps 에 settling 이 하나라도 있는가 (파생값)
  busyFlashUntil: 0,     // 쓰기 작업 중 차단된 입력 피드백 표시 만료 시각 (ms epoch)
  spinnerFrame: 0,
  // 읽기 작업(diff/상세 로드)의 진행 표시 — 쓰기 작업의 spinnerActive 와 달리 입력을 막지 않고
  // 해당 패널 안에만 스피너를 그린다. Since 는 스피너를 그리기 시작할 시점을 재는 기준이다.
  diffLoading: false,
  diffLoadingSince: 0,
  logDetailLoading: false,
  logDetailLoadingSince: 0,
  freshDetailLoading: false,
  freshDetailLoadingSince: 0,
  refreshing: false,
  refreshMessage: '',
  indexLocked: false,    // .git/index.lock 존재 여부 — Unlock 버튼 노출 트리거
};

const ui = {
  termCols: 80,
  termRows: 24,
  logSixelOverlay: null,
  logSixelOverlaySize: null,
  logSixelRegion: null,
  logSixelAnchorBank: false, // host-owned scroll: graph anchored at overscan bank row
  hostScrollRegions: [],     // host-owned scroll: per-render region defs from panel builders
  clickableAreas: [],
  hoveredAreaIndex: -1,
  committerClickZones: [],
  hoveredCommitterAction: null,
  fileLineMap: [],
  lastLayout: { startRow: 0, startCol: 0, width: 0, height: 0, leftW: 0, divider1W: 0, middleW: 0, divider2W: 0, rightW: 0, bodyH: 0 },
  rightDiffH: 0,
  lastLogListH: 0,
  lastDetailContentH: 0,
  commitInputRow: -1,
  commitButtonZone: null,
  commitAmendZone: null,      // { row, colStart, colEnd } amend 토글 클릭 존 (Commit 버튼 오른쪽)
  hoveredCommitAmend: false,
  commitAmendBtnOffset: -1,   // 렌더 시 commit 버튼 행 내 amend 토글 시작 컬럼(상대), -1이면 미표시
  commitAmendBtnLen: 0,
  commitClearZone: null,      // { row, colStart, colEnd } 메시지 지우기 버튼 클릭 존 (메시지 첫 줄 오른쪽)
  hoveredCommitClear: false,
  commitClearBtnOffset: -1,   // 렌더 시 메시지 첫 줄 내 지우기 버튼 시작 컬럼(상대), -1이면 미표시
  commitClearBtnLen: 0,
  commitMsgCursorMaxW: 0,     // 커서가 놓인 메시지 줄을 렌더할 때 쓴 폭 (IME 커서 위치를 렌더와 맞춘다)
  diffHunkZones: [],          // [{ lineIdx, colStart, colEnd, hunkIdx }] hunk 버튼 클릭 존
  hoveredDiffHunkIdx: -1,
  stashMap: new Map(),
  fileHeaderZones: [],
  verticalDividerRatio: 0.25,
  filesDividerRatio: 0.4,
  logListRatio: 0.4,
  dragging: null,
  leftPanelCollapsed: false,
  rightTopCollapsed: false,
  rightBottomCollapsed: false,
  middlePanelCollapsed: false,
  rightPanelCollapsed: false,
  titleClickZones: [],
  leftTabZones: [],
  leftTabInfo: null,
  leftPanelClickMap: [],
  collapsedSections: {},
  collapsedGroups: {},
  leftPanelActiveBranch: null,
  pinnedBranches: [],              // 핀 고정한 로컬 브랜치 이름 — 핀 지정 순서 유지, 리포별 영속
  // 히스토리 Filter/Hide — 값은 풀 refname('refs/heads/x' | 'refs/remotes/origin/x')이다.
  // 이름만 들고 다니면 로컬 'foo'와 리모트 'origin/foo'를 구분할 수 없어 한쪽 지정이
  // 다른 쪽까지 걸린다(핀은 일부러 그렇게 묶여 있지만, 이쪽은 각각 지정할 수 있어야 한다).
  filteredRefs: [],                // 화이트리스트 — 비어 있지 않으면 여기서 닿는 커밋만 그린다
  hiddenRefs: [],                  // 블랙리스트 — 그래프 루트에서 뺀다(공유 커밋은 남는다)
  leftPanelScrollOffset: 0,
  leftRevealBranch: null,          // 상단 브랜치명 클릭 → 다음 렌더에서 Branches 목록의 그 줄로 스크롤
  hoveredTitleZoneIndex: -1,
  hoveredFileHeaderIdx: -1,
  hoveredLeftPanelRow: -1,
  hoveredFileRow: -1,         // hover row in file list (middle panel)
  hoveredLogRow: -1,          // hover row in log list (right panel)
  hoveredFreshRow: -1,        // hover row in fresh list (right panel)
  hoveredCommitButton: false, // hover on [Commit] button
  // 마우스가 올라간 버튼의 동작 id. 막혀 있으면 힌트바에 사유를 띄운다(actions.js 판정).
  // 사유 문자열이 아니라 id 를 들고 있어야 상황이 바뀔 때 렌더가 다시 판정한다.
  hoveredAction: null,
  hoveredMergeApplyButton: false,
  hoveredMergeZoneIndex: -1,
  hoveredDetailCopyZone: null,
  hoveredCollapseAllButton: false,
  hoveredDivider: null,
  contextMenuActive: false,
  contextMenuStashRef: null,
  contextMenuFileItem: null,
  contextMenuFileItems: [],
  contextMenuFilePath: '',
  contextMenuTab: false,
  contextMenuBranch: null,
  contextMenuRemote: null,    // remote 그룹 우클릭 시 remote 이름
  contextMenuWorktree: null,  // worktree 행 우클릭 시 worktree 경로
  remoteSortMode: 'alpha', // 'alpha' | 'alpha_desc' | 'recent'
  // 커밋 그래프 정렬 — 'date': git --date-order 그대로(날짜 내림차순, 일반 GUI 클라이언트와 동일)
  //                  'branch': HEAD 기준 first-parent 줄기에 분기 그룹을 붙여 재배치
  logSortMode: 'date',
  // 리커버리(reflog 에만 남은 유실) 커밋을 목록·그래프에 보일지. 끄면 그리기 단계에서만
  // 걸러내고 조회는 그대로 두므로, 다시 켤 때 git 재조회 없이 즉시 되살아난다.
  logShowRecovery: true,
  remoteRecentBranchUsage: {},
  scrollPct: { status: -1, files: -1, diff: -1, history: -1, detail: -1 },
  lastClickTime: 0,
  lastClickFileIdx: -1,
  lastClickStashRef: null,
  lastClickStashTime: 0,
  cellW: 8,
  cellH: 16,
  lastFreshListH: 0,
  freshFileLineMap: [],
  freshWindowZone: null, // { lineIdx, colStart, colEnd }
  hoveredFreshWindow: false,
  collapsedDetailFiles: new Set(),
  detailFileHeaderMap: [], // maps visible detail row → file path (or null)
  filteredDetailCount: 0, // filtered logDetailLines count (respecting collapse)
  detailCollapseAllZone: null, // { colStart, colEnd } for Collapse/Expand All button on refs line
  scrollbarOverlays: [],
  scrollbarDragInfo: null,    // { target, trackTop, trackH, maxScroll }
  hoveredScrollbarTarget: null, // 'left' | 'files' | 'diff' | 'logList' | 'logDetail' | 'freshList' | 'freshDetail'
  filesScrollPin: undefined,     // pinned cursor value when scrollbar used
  logScrollPin: undefined,       // pinned logCursor value when scrollbar used
  freshScrollPin: undefined,     // pinned freshCursor value when scrollbar used
  filesMaxScroll: 0,
  diffMaxScroll: 0,
  diffMaxScrollX: 0,
  filesMaxScrollX: 0,
  logListMaxScroll: 0,
  logDetailMaxScroll: 0,
  freshListMaxScroll: 0,
  freshDetailMaxScroll: 0,
  hScrollbarZones: [],
  hScrollbarDragInfo: null,
  hoveredHScrollbarTarget: null,
  logDetailMaxScrollX: 0,
  freshDetailMaxScrollX: 0,
  // Merge conflict resolution UI
  mergeConflictFile: null,     // current conflict file being resolved
  mergeChunkCursor: 0,         // focused conflict chunk index
  mergeChunkSelections: {},    // { [chunkIndex]: 'ours' | 'theirs' }
  mergeChunkLineMap: {},       // { [chunkIndex]: { start, end } }
  mergeClickZones: [],         // click zones for merge UI
  mergeApplyZone: null,        // fixed apply button zone in footer area
};

function init() {
  ui.termCols = hecaton.initialState?.cols || 80;
  ui.termRows = hecaton.initialState?.rows || 24;
}

// ── 핀 고정 브랜치 ──
// 목록은 이름만 들고 다니고(핀 지정 순서), 실제 존재 여부는 그릴 때 state.branches로 판별한다.
// 변경 후에는 호출부가 render()를 부르면 persist가 디바운스 저장한다.

function isPinnedBranch(name) {
  return !!name && ui.pinnedBranches.includes(name);
}

// 핀 토글 — 새로 지정하면 목록 끝에 붙어 지정 순서대로 표시된다. 결과 핀 상태를 반환.
function togglePinnedBranch(name) {
  if (!name) return false;
  const idx = ui.pinnedBranches.indexOf(name);
  if (idx >= 0) {
    ui.pinnedBranches.splice(idx, 1);
    return false;
  }
  ui.pinnedBranches.push(name);
  return true;
}

function unpinBranch(name) {
  const idx = ui.pinnedBranches.indexOf(name);
  if (idx >= 0) ui.pinnedBranches.splice(idx, 1);
}

// 브랜치 리네임 시 핀도 따라가게 한다 — 이름이 유일한 식별자라 갱신하지 않으면 핀이 끊긴다.
function renamePinnedBranch(oldName, newName) {
  const idx = ui.pinnedBranches.indexOf(oldName);
  if (idx < 0) return;
  if (ui.pinnedBranches.includes(newName)) ui.pinnedBranches.splice(idx, 1);
  else ui.pinnedBranches[idx] = newName;
}

// ── 히스토리 Filter / Hide ──
// Filter 는 "이 브랜치들만 보기"(화이트리스트), Hide 는 "이 브랜치는 빼고 보기"(블랙리스트)다.
// 실제 걸러내기는 그리기 단계(refresh.buildLogGraphRows)에서만 일어나므로, 토글해도
// git 재조회 없이 캐시된 커밋으로 그래프만 다시 만든다.

function localRefKey(name) { return name ? 'refs/heads/' + name : ''; }
function remoteRefKey(name) { return name ? 'refs/remotes/' + name : ''; }

function isFilteredRef(key) { return !!key && ui.filteredRefs.includes(key); }
function isHiddenRef(key) { return !!key && ui.hiddenRefs.includes(key); }

// Filter 와 Hide 는 서로 반대 방향의 지정이다. 한 ref 에 둘 다 걸리면 "골라 놓고 감췄다"가
// 되어 결과를 예측할 수 없으므로, 한쪽을 켤 때 다른 쪽에서 뺀다. 결과 상태를 반환.
function toggleFilteredRef(key) {
  if (!key) return false;
  const idx = ui.filteredRefs.indexOf(key);
  if (idx >= 0) { ui.filteredRefs.splice(idx, 1); return false; }
  const hid = ui.hiddenRefs.indexOf(key);
  if (hid >= 0) ui.hiddenRefs.splice(hid, 1);
  ui.filteredRefs.push(key);
  return true;
}

function toggleHiddenRef(key) {
  if (!key) return false;
  const idx = ui.hiddenRefs.indexOf(key);
  if (idx >= 0) { ui.hiddenRefs.splice(idx, 1); return false; }
  const flt = ui.filteredRefs.indexOf(key);
  if (flt >= 0) ui.filteredRefs.splice(flt, 1);
  ui.hiddenRefs.push(key);
  return true;
}

function clearFilteredRefs() { ui.filteredRefs = []; }
function clearHiddenRefs() { ui.hiddenRefs = []; }

// 사라진 ref 의 지정은 남기지 않는다 — 이름이 유일한 식별자라, 나중에 같은 이름이 다시
// 생기면 지정한 적 없는 브랜치가 필터/숨김 상태로 되살아난다.
function forgetRef(key) {
  if (!key) return;
  const flt = ui.filteredRefs.indexOf(key);
  if (flt >= 0) ui.filteredRefs.splice(flt, 1);
  const hid = ui.hiddenRefs.indexOf(key);
  if (hid >= 0) ui.hiddenRefs.splice(hid, 1);
}

// 리네임을 따라가게 한다(핀과 같은 이유). 새 이름이 이미 있으면 중복을 만들지 않는다.
function renameRef(oldKey, newKey) {
  if (!oldKey || !newKey) return;
  for (const list of [ui.filteredRefs, ui.hiddenRefs]) {
    const idx = list.indexOf(oldKey);
    if (idx < 0) continue;
    if (list.includes(newKey)) list.splice(idx, 1);
    else list[idx] = newKey;
  }
}

module.exports = {
  state, ui, init,
  isPinnedBranch, togglePinnedBranch, unpinBranch, renamePinnedBranch,
  localRefKey, remoteRefKey,
  isFilteredRef, isHiddenRef, toggleFilteredRef, toggleHiddenRef,
  clearFilteredRefs, clearHiddenRefs, forgetRef, renameRef,
};
