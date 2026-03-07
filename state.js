const state = {
  cwd: '',
  isGitRepo: false,
  branch: '',
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  cursor: 0,
  scrollOffset: 0,
  focusPanel: 'status',  // 'status' | 'diff'
  diffLines: [],
  diffScrollOffset: 0,
  diffScrollX: 0,
  filesScrollX: 0,
  currentDiffFile: null, // Current file being viewed in diff panel
  rightView: 'diff',     // 'diff' | 'log' | 'fresh'
  logItems: [],           // [{ type:'commit'|'graph', graphStr, ref, decoration, subject }]
  logSelectables: [],     // indices into logItems that are selectable
  logCursor: 0,           // index into logSelectables
  logScrollOffset: 0,
  logDetailLines: [],
  branches: [],           // [{ name, isCurrent }]
  remoteBranches: [],     // ['origin/main', ...]
  remotes: [],            // ['origin', 'upstream', ...]
  stashes: [],            // [{ hash, shortHash, ref }]
  rebaseState: null,     // null | { type, step, total }
  selectedFiles: new Set(),
  mode: 'normal',        // 'normal' | 'commit'
  commitMsg: '',
  commitCursor: 0,
  pendingDialogAction: null,  // 'new-branch' | 'new-tag' | 'rename-stash' | 'new-remote' | null
  pendingDialogTarget: null,
  pendingRebaseMenu: false,
  error: null,
  loading: true,
  minimized: false,
  pendingStash: false,
  pendingRebaseRef: null,
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
};

const ui = {
  termCols: parseInt(process.env.HECA_COLS || '80', 10),
  termRows: parseInt(process.env.HECA_ROWS || '24', 10),
  logSixelOverlay: null,
  clickableAreas: [],
  hoveredAreaIndex: -1,
  fileLineMap: [],
  lastLayout: { startRow: 0, startCol: 0, width: 0, height: 0, leftW: 0, divider1W: 0, middleW: 0, divider2W: 0, rightW: 0, bodyH: 0 },
  rightDiffH: 0,
  lastLogListH: 0,
  lastDetailContentH: 0,
  commitInputRow: -1,
  commitButtonZone: null,
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
  hoveredDivider: null,
  contextMenuActive: false,
  contextMenuStashRef: null,
  contextMenuFileItem: null,
  contextMenuFileItems: [],
  contextMenuFilePath: '',
  contextMenuTab: false,
  contextMenuBranch: null,
  remoteSortMode: 'alpha', // 'alpha' | 'alpha_desc' | 'recent'
  remoteRecentBranchUsage: {},
  scrollPct: { status: -1, files: -1, diff: -1, history: -1, detail: -1 },
  lastClickTime: 0,
  lastClickFileIdx: -1,
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
};

module.exports = { state, ui };
