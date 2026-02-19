const state = {
  cwd: '',
  isGitRepo: false,
  branch: '',
  staged: [],
  unstaged: [],
  untracked: [],
  cursor: 0,
  scrollOffset: 0,
  focusPanel: 'status',  // 'status' | 'diff'
  diffLines: [],
  diffScrollOffset: 0,
  rightView: 'diff',     // 'diff' | 'log'
  logItems: [],           // [{ type:'commit'|'graph', graphStr, ref, decoration, subject }]
  logSelectables: [],     // indices into logItems that are selectable
  logCursor: 0,           // index into logSelectables
  logScrollOffset: 0,
  logDetailLines: [],
  branches: [],           // [{ name, isCurrent }]
  remoteBranches: [],     // ['origin/main', ...]
  stashes: [],            // [{ hash, shortHash, ref }]
  rebaseState: null,     // null | { type, step, total }
  mode: 'normal',        // 'normal' | 'commit' | 'rebase-menu'
  commitMsg: '',
  error: null,
  loading: true,
  minimized: false,
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
  commitInputRow: -1,
  commitButtonZone: null,
  stashMap: new Map(),
  verticalDividerRatio: 0.25,
  filesDividerRatio: 0.4,
  logListRatio: 0.4,
  dragging: null,
  leftPanelCollapsed: false,
  rightTopCollapsed: false,
  rightBottomCollapsed: false,
  titleClickZones: [],
  leftTabZones: [],
  leftTabInfo: null,
  leftPanelClickMap: [],
  collapsedSections: {},
  collapsedGroups: {},
  leftPanelActiveBranch: null,
  hoveredTitleZoneIndex: -1,
  hoveredDivider: null,
  lastClickTime: 0,
  lastClickFileIdx: -1,
};

module.exports = { state, ui };
