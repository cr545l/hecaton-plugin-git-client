const state = {
  cwd: '',
  isGitRepo: false,
  gitDir: '',           // cached resolved git-dir absolute path (invalidated on cwd change)
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
  worktrees: [],          // [{ path, branch, head, isCurrent, isDetached, isBare, isLocked, isPrunable }]
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
  fileLineMap: [],
  lastLayout: { startRow: 0, startCol: 0, width: 0, height: 0, leftW: 0, divider1W: 0, middleW: 0, divider2W: 0, rightW: 0, bodyH: 0 },
  rightDiffH: 0,
  lastLogListH: 0,
  lastDetailContentH: 0,
  commitInputRow: -1,
  commitButtonZone: null,
  commitAmendZone: null,      // { row, colStart, colEnd } amend 체크박스 클릭 존
  hoveredCommitAmend: false,
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
  leftPanelScrollOffset: 0,
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
  hoveredCommitter: false,
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

module.exports = { state, ui, init };
