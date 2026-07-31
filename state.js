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
  spinnerActive: false,
  spinnerFrame: 0,
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
  leftPanelScrollOffset: 0,
  leftCurrentBranchLineIdx: -1,    // Branches 목록에 그려진 현재 브랜치 줄 인덱스 (없으면 -1)
  leftRevealCurrentBranch: false,  // 상단 브랜치명 클릭 → 다음 렌더에서 그 줄로 스크롤
  hoveredTitleZoneIndex: -1,
  hoveredFileHeaderIdx: -1,
  hoveredLeftPanelRow: -1,
  hoveredFileRow: -1,         // hover row in file list (middle panel)
  hoveredLogRow: -1,          // hover row in log list (right panel)
  hoveredFreshRow: -1,        // hover row in fresh list (right panel)
  hoveredCommitButton: false, // hover on [Commit] button
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

module.exports = { state, ui, init, isPinnedBranch, togglePinnedBranch, unpinBranch, renamePinnedBranch };
