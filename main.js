#!/usr/bin/env node

/**
 * Git Client - Hecaton Plugin
 *
 * Lazygit-style TUI overlay for staging, unstaging, committing,
 * and viewing diffs inside the Hecaton terminal.
 *
 * Keyboard:
 *   Up/Down - Navigate file list
 *   s       - Stage selected file
 *   u       - Unstage selected file
 *   a       - Stage/unstage all
 *   c       - Enter commit mode
 *   Enter   - Execute commit (in commit mode)
 *   Esc     - Cancel commit / close
 *   Tab     - Switch panel focus
 *   r       - Refresh
 *   q       - Quit
 */

const { execFileSync } = require('child_process');

// ============================================================
// ANSI Helpers
// ============================================================
const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  inverse: CSI + '7m',
  fg: (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg: (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  moveTo: (row, col) => `${CSI}${row};${col}H`,
};

const colors = {
  title: ansi.fg(130, 180, 255),
  label: ansi.fg(180, 180, 200),
  value: ansi.fg(255, 255, 255),
  dim: ansi.fg(100, 100, 120),
  green: ansi.fg(120, 220, 150),
  red: ansi.fg(230, 110, 110),
  yellow: ansi.fg(230, 200, 100),
  cyan: ansi.fg(100, 200, 230),
  orange: ansi.fg(230, 170, 100),
  border: ansi.fg(80, 80, 100),
  sectionHeader: ansi.fg(160, 160, 180),
  cursor: ansi.fg(255, 255, 255),
  cursorBg: ansi.bg(60, 60, 90),
  diffAdd: ansi.fg(120, 220, 150),
  diffDel: ansi.fg(230, 110, 110),
  diffHunk: ansi.fg(100, 200, 230),
  diffHeader: ansi.fg(180, 180, 200),
  inputBg: ansi.bg(40, 40, 60),
};

// Branch lane colors for graph visualization
const branchPalette = [
  ansi.fg(86, 194, 244),   // blue
  ansi.fg(120, 220, 150),  // green
  ansi.fg(255, 167, 89),   // orange
  ansi.fg(224, 108, 117),  // red
  ansi.fg(180, 130, 230),  // purple
  ansi.fg(229, 192, 100),  // yellow
  ansi.fg(90, 210, 200),   // teal
  ansi.fg(240, 140, 180),  // pink
];

// ============================================================
// Terminal Size & Mouse State
// ============================================================
let termCols = parseInt(process.env.HECA_COLS || '80', 10);
let termRows = parseInt(process.env.HECA_ROWS || '24', 10);

let clickableAreas = [];   // { row, colStart, colEnd, action }
let hoveredAreaIndex = -1;
let fileLineMap = [];       // maps visible left-panel line index → file list index (-1 = not a file)
let lastLayout = { startRow: 0, startCol: 0, width: 0, height: 0, leftW: 0, rightW: 0, bodyH: 0 };
let lastLogListH = 0;      // number of rows in log commit list area
let stashMap = new Map();  // shortHash → stash@{N}

// ============================================================
// RPC Communication
// ============================================================
let rpcIdCounter = 0;
const pendingRpc = new Map();

function sendRpc(method, params = {}) {
  const id = ++rpcIdCounter;
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
  return new Promise((resolve) => {
    pendingRpc.set(id, resolve);
    setTimeout(() => {
      if (pendingRpc.has(id)) {
        pendingRpc.delete(id);
        resolve(null);
      }
    }, 3000);
  });
}

function sendRpcNotify(method, params = {}) {
  const id = ++rpcIdCounter;
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
}

function handleRpcResponse(json) {
  if (json.id != null && pendingRpc.has(json.id)) {
    const resolve = pendingRpc.get(json.id);
    pendingRpc.delete(json.id);
    resolve(json.result || null);
  }
}

// ============================================================
// Text Helpers
// ============================================================
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) ||
    cp === 0x2329 || cp === 0x232A ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3040 && cp <= 0x33BF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xAC00 && cp <= 0xD7AF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE19) ||
    (cp >= 0xFE30 && cp <= 0xFE6F) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x20000 && cp <= 0x3134F);
}

function visLen(text) {
  const plain = stripAnsi(text);
  let w = 0;
  for (const ch of plain) {
    w += isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return w;
}

function padRight(text, width) {
  const pad = Math.max(0, width - visLen(text));
  return text + ' '.repeat(pad);
}

function truncate(text, maxLen) {
  if (visLen(text) <= maxLen) return text;
  // Walk through text, counting visible width
  let vis = 0;
  let i = 0;
  while (i < text.length && vis < maxLen - 1) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i);
      if (end !== -1) { i = end + 1; continue; }
    }
    const cp = text.codePointAt(i);
    const cw = isWide(cp) ? 2 : 1;
    if (vis + cw > maxLen - 1) break;
    vis += cw;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return text.substring(0, i) + '\u2026';
}

// ============================================================
// Git Commands
// ============================================================
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).replace(/\r\n/g, '\n');
  } catch (e) {
    if (e.stdout) return e.stdout.replace(/\r\n/g, '\n');
    throw e;
  }
}

function gitIsRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitBranch(cwd) {
  try {
    return git(['branch', '--show-current'], cwd).trim() || 'HEAD (detached)';
  } catch {
    return '???';
  }
}

function gitStatus(cwd) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  try {
    const output = git(['status', '--porcelain=v1'], cwd);
    for (const line of output.split('\n')) {
      if (!line) continue;
      const x = line[0]; // index status
      const y = line[1]; // worktree status
      const file = line.substring(3);
      if (x === '?') {
        untracked.push({ file });
      } else {
        if (x !== ' ' && x !== '?') {
          staged.push({ status: x, file });
        }
        if (y !== ' ' && y !== '?') {
          unstaged.push({ status: y, file });
        }
      }
    }
  } catch { /* empty */ }
  return { staged, unstaged, untracked };
}

function gitDiff(cwd, file, isStaged) {
  try {
    const args = ['diff'];
    if (isStaged) args.push('--cached');
    args.push('--', file);
    return git(args, cwd);
  } catch {
    return '';
  }
}

function gitDiffUntracked(cwd, file) {
  try {
    return git(['diff', '--no-index', '--', '/dev/null', file], cwd);
  } catch {
    return '';
  }
}

function gitStage(cwd, file) {
  try {
    git(['add', '--', file], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitUnstage(cwd, file) {
  try {
    git(['restore', '--staged', '--', file], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitStageAll(cwd) {
  try {
    git(['add', '-A'], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitUnstageAll(cwd) {
  try {
    git(['reset', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitCommit(cwd, message) {
  try {
    git(['commit', '-m', message], cwd);
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Commit failed';
  }
}

function gitLogGraph(cwd, extraRefs) {
  try {
    const args = ['log', '--graph', '--all', '--oneline', '--decorate', '--color=never'];
    if (extraRefs && extraRefs.length > 0) args.push(...extraRefs);
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    }).replace(/\r\n/g, '\n').trim();
  } catch {
    return '';
  }
}

function gitStashRefs(cwd) {
  try {
    const raw = git(['stash', 'list', '--format=%H\t%h\t%gd'], cwd).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      return { hash: parts[0], shortHash: parts[1], ref: parts[2] };
    });
  } catch {
    return [];
  }
}

function gitShowRef(cwd, ref) {
  try {
    return git(['show', ref], cwd);
  } catch {
    return '';
  }
}

function gitStashDiff(cwd, ref) {
  try {
    return git(['stash', 'show', '-p', ref], cwd);
  } catch {
    return '';
  }
}

// ============================================================
// State
// ============================================================
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
  logItems: [],           // [{ type:'stash'|'commit'|'header'|'graph', display, ref }]
  logSelectables: [],     // indices into logItems that are selectable
  logCursor: 0,           // index into logSelectables
  logScrollOffset: 0,
  logDetailLines: [],
  mode: 'normal',        // 'normal' | 'commit'
  commitMsg: '',
  error: null,
  loading: true,
  minimized: false,
};

// ============================================================
// File List Helpers
// ============================================================
// Build a flat list of items for cursor navigation
// Each item: { type: 'staged'|'unstaged'|'untracked', index, status, file }
function buildFileList() {
  const list = [];
  for (let i = 0; i < state.staged.length; i++) {
    list.push({ type: 'staged', index: i, status: state.staged[i].status, file: state.staged[i].file });
  }
  for (let i = 0; i < state.unstaged.length; i++) {
    list.push({ type: 'unstaged', index: i, status: state.unstaged[i].status, file: state.unstaged[i].file });
  }
  for (let i = 0; i < state.untracked.length; i++) {
    list.push({ type: 'untracked', index: i, status: '?', file: state.untracked[i].file });
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

// ============================================================
// Refresh
// ============================================================
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
  const status = gitStatus(state.cwd);
  state.staged = status.staged;
  state.unstaged = status.unstaged;
  state.untracked = status.untracked;
  clampCursor();
  updateDiff();
}

function refreshLog() {
  if (!state.cwd || !state.isGitRepo) {
    state.logItems = [];
    state.logSelectables = [];
    stashMap = new Map();
    return;
  }

  state.logItems = [];
  state.logSelectables = [];

  // Build stash map and collect stash hashes for graph inclusion
  const stashRefList = gitStashRefs(state.cwd);
  stashMap = new Map();
  const stashHashes = [];
  for (const s of stashRefList) {
    stashMap.set(s.shortHash, s.ref);
    stashHashes.push(s.hash);
  }

  // Graph log with stash commits included at their creation points
  const graphRaw = gitLogGraph(state.cwd, stashHashes);
  if (graphRaw) {
    for (const line of graphRaw.split('\n')) {
      if (!line) continue;
      const match = line.match(/\*\s+([0-9a-f]{7,})\b/);
      if (match) {
        state.logSelectables.push(state.logItems.length);
        state.logItems.push({ type: 'commit', ref: match[1], display: line });
      } else {
        state.logItems.push({ type: 'graph', ref: null, display: line });
      }
    }
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
  let raw = '';
  const stashRef = stashMap.get(item.ref);
  if (stashRef) {
    raw = gitStashDiff(state.cwd, stashRef);
  } else {
    raw = gitShowRef(state.cwd, item.ref);
  }
  state.logDetailLines = raw.split('\n');
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

// ============================================================
// Rendering
// ============================================================
function render() {
  if (state.minimized) {
    renderMinimized();
    return;
  }

  const cols = termCols;
  const rows = termRows;
  const width = cols;
  const height = rows;
  const startCol = 1;
  const startRow = 1;

  const buf = [];
  buf.push(ansi.clear + ansi.hideCursor);

  // Border characters
  const TL = '\u250c', TR = '\u2510', BL = '\u2514', BR = '\u2518';
  const H = '\u2500', V = '\u2502';
  const TJ = '\u252c', BJ = '\u2534', LJ = '\u251c', RJ = '\u2524', CROSS = '\u253c';

  // Layout dimensions
  const leftW = Math.max(24, Math.floor(width * 0.35));
  const rightW = width - leftW - 1; // -1 for middle divider
  const bodyH = height - 4; // -2 top/bottom border, -1 separator, -1 hint bar
  const hintRow = startRow + height - 2;
  const sepRow = startRow + height - 3;

  // ── Top border ──
  buf.push(
    ansi.moveTo(startRow, startCol) +
    colors.border +
    TL + H.repeat(leftW) + TJ + H.repeat(rightW - 1) + TR +
    ansi.reset
  );

  // ── Title row ──
  const titleL = ' Status';
  const titleR = state.rightView === 'log' ? ' Log' : ' Diff / Detail';
  buf.push(
    ansi.moveTo(startRow + 1, startCol) +
    colors.border + V + ansi.reset +
    colors.title + ansi.bold + padRight(titleL, leftW) + ansi.reset +
    colors.border + V + ansi.reset +
    colors.title + ansi.bold + padRight(titleR, rightW - 2) + ansi.reset +
    colors.border + V + ansi.reset
  );

  // ── Title separator ──
  buf.push(
    ansi.moveTo(startRow + 2, startCol) +
    colors.border +
    LJ + H.repeat(leftW) + CROSS + H.repeat(rightW - 1) + RJ +
    ansi.reset
  );

  // ── Body ──
  const leftLines = buildLeftPanel(leftW, bodyH);
  const rightLines = state.rightView === 'log'
    ? buildLogPanel(rightW - 2, bodyH)
    : buildRightPanel(rightW - 2, bodyH);

  for (let i = 0; i < bodyH; i++) {
    const row = startRow + 3 + i;
    const lContent = i < leftLines.length ? leftLines[i] : '';
    const rContent = i < rightLines.length ? rightLines[i] : '';
    buf.push(
      ansi.moveTo(row, startCol) +
      colors.border + V + ansi.reset +
      padRight(lContent, leftW) +
      colors.border + V + ansi.reset +
      padRight(rContent, rightW - 2) +
      colors.border + V + ansi.reset
    );
  }

  // ── Bottom separator ──
  buf.push(
    ansi.moveTo(sepRow, startCol) +
    colors.border +
    LJ + H.repeat(width - 2) + RJ +
    ansi.reset
  );

  // ── Hint bar / commit input ──
  let hintContent;
  if (state.mode === 'commit') {
    hintContent = colors.yellow + ' Commit: ' + ansi.reset + colors.inputBg + colors.value + state.commitMsg + '\u2588' + ansi.reset;
  } else if (state.error) {
    hintContent = ' ' + colors.red + state.error + ansi.reset;
  } else {
    hintContent = ' ' + buildHintText();
  }
  buf.push(
    ansi.moveTo(hintRow, startCol) +
    colors.border + V + ansi.reset +
    padRight(hintContent, width - 2) +
    colors.border + V + ansi.reset
  );

  // ── Bottom border ──
  buf.push(
    ansi.moveTo(hintRow + 1, startCol) +
    colors.border +
    BL + H.repeat(width - 2) + BR +
    ansi.reset
  );

  process.stdout.write(buf.join(''));

  // Record layout for mouse hit testing
  lastLayout = { startRow, startCol, width, height, leftW, rightW, bodyH };

  // Record clickable areas for hint bar buttons
  clickableAreas = [];
  if (state.mode === 'normal' && !state.error) {
    const contentStart = startCol + 2; // after │ and space
    // Build plain text of hint line to find button positions
    let plainOffset = 0;
    for (let i = 0; i < hintButtons.length; i++) {
      if (i > 0) plainOffset += 2; // gap between buttons
      clickableAreas.push({
        row: hintRow,
        colStart: contentStart + plainOffset,
        colEnd: contentStart + plainOffset + hintButtons[i].label.length - 1,
        action: hintButtons[i].action,
      });
      plainOffset += hintButtons[i].label.length;
    }
  }
  if (hoveredAreaIndex >= clickableAreas.length) hoveredAreaIndex = -1;
}

function buildLeftPanel(w, h) {
  const lines = [];
  const lineToFileIdx = []; // parallel array: file list index per line, -1 = non-file
  const innerW = w - 1;
  let cursorLineIdx = -1;

  function pushLine(content, fileIdx) {
    lineToFileIdx.push(fileIdx);
    lines.push(content);
  }

  // Branch
  pushLine(colors.cyan + ' \u2387 ' + ansi.reset + colors.value + ansi.bold + (state.branch || '...') + ansi.reset, -1);
  pushLine('', -1);

  if (state.loading) {
    pushLine(colors.dim + ' Loading...' + ansi.reset, -1);
    fileLineMap = lineToFileIdx;
    return lines;
  }

  if (!state.isGitRepo) {
    pushLine(colors.red + ' Not a git repository' + ansi.reset, -1);
    fileLineMap = lineToFileIdx;
    return lines;
  }

  const fileList = buildFileList();
  let listIdx = 0;

  // Staged
  pushLine(colors.sectionHeader + ansi.bold + ' Staged (' + state.staged.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.staged.length; i++) {
    const item = state.staged[i];
    const isCursor = state.focusPanel === 'status' && state.cursor === listIdx;
    if (isCursor) cursorLineIdx = lines.length;
    const prefix = isCursor ? (colors.cursorBg + colors.cursor + ' \u25b8 ') : '   ';
    const statusColor = colors.green;
    const line = prefix + statusColor + item.status + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushLine((isCursor ? colors.cursorBg : '') + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  pushLine('', -1);

  // Unstaged
  pushLine(colors.sectionHeader + ansi.bold + ' Unstaged (' + state.unstaged.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.unstaged.length; i++) {
    const item = state.unstaged[i];
    const isCursor = state.focusPanel === 'status' && state.cursor === listIdx;
    if (isCursor) cursorLineIdx = lines.length;
    const prefix = isCursor ? (colors.cursorBg + colors.cursor + ' \u25b8 ') : '   ';
    const statusColor = colors.red;
    const line = prefix + statusColor + item.status + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushLine((isCursor ? colors.cursorBg : '') + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  pushLine('', -1);

  // Untracked
  pushLine(colors.sectionHeader + ansi.bold + ' Untracked (' + state.untracked.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.untracked.length; i++) {
    const item = state.untracked[i];
    const isCursor = state.focusPanel === 'status' && state.cursor === listIdx;
    if (isCursor) cursorLineIdx = lines.length;
    const prefix = isCursor ? (colors.cursorBg + colors.cursor + ' \u25b8 ') : '   ';
    const line = prefix + colors.dim + '?' + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushLine((isCursor ? colors.cursorBg : '') + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  if (fileList.length === 0) {
    pushLine('', -1);
    pushLine(colors.dim + ' Nothing to commit, working tree clean' + ansi.reset, -1);
  }

  // Scroll to keep cursor visible
  if (lines.length > h && cursorLineIdx >= 0) {
    if (cursorLineIdx < state.scrollOffset) {
      state.scrollOffset = cursorLineIdx;
    } else if (cursorLineIdx >= state.scrollOffset + h) {
      state.scrollOffset = cursorLineIdx - h + 1;
    }
    fileLineMap = lineToFileIdx.slice(state.scrollOffset, state.scrollOffset + h);
    return lines.slice(state.scrollOffset, state.scrollOffset + h);
  }
  state.scrollOffset = 0;
  fileLineMap = lineToFileIdx.slice(0, h);
  return lines;
}

function buildRightPanel(w, h) {
  const lines = [];

  if (state.diffLines.length === 0) {
    lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
    return lines;
  }

  const maxScroll = Math.max(0, state.diffLines.length - h);
  if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;

  const visible = state.diffLines.slice(state.diffScrollOffset, state.diffScrollOffset + h);
  for (const rawLine of visible) {
    lines.push(' ' + colorizeDiffLine(rawLine, w));
  }

  // Scroll indicator
  if (state.diffLines.length > h) {
    const pct = Math.round((state.diffScrollOffset / maxScroll) * 100);
    const indicator = colors.dim + ` [${pct}%]` + ansi.reset;
    if (lines.length > 0) {
      lines[0] = padRight(lines[0], w - 6) + indicator;
    }
  }

  return lines;
}

function buildLogPanel(w, h) {
  if (state.logItems.length === 0) {
    return [colors.dim + ' No commits yet' + ansi.reset];
  }

  // Upper half: item list, lower half: detail
  const listH = Math.min(Math.max(5, Math.floor(h * 0.4)), state.logItems.length + 1);
  const detailH = h - listH - 1;
  lastLogListH = listH;

  const lines = [];

  // Find the logItems index of the currently selected item
  const selectedItemIdx = state.logSelectables.length > 0
    ? state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)]
    : -1;

  // Scroll to keep selected item visible
  if (selectedItemIdx >= 0) {
    if (selectedItemIdx < state.logScrollOffset) {
      state.logScrollOffset = selectedItemIdx;
    } else if (selectedItemIdx >= state.logScrollOffset + listH) {
      state.logScrollOffset = selectedItemIdx - listH + 1;
    }
  }
  state.logScrollOffset = Math.max(0, Math.min(state.logScrollOffset, state.logItems.length - listH));

  // ── Item list ──
  const visibleItems = state.logItems.slice(state.logScrollOffset, state.logScrollOffset + listH);
  for (let i = 0; i < listH; i++) {
    const itemIdx = state.logScrollOffset + i;
    const item = visibleItems[i];
    if (!item) { lines.push(''); continue; }

    const isCursor = state.focusPanel === 'diff' && itemIdx === selectedItemIdx;

    if (item.type === 'commit') {
      const prefix = isCursor ? (colors.cursorBg + colors.cursor + '\u25b8') : ' ';
      const colorized = colorizeGraphLine(item.display, w - 2);
      const line = prefix + colorized;
      lines.push((isCursor ? colors.cursorBg : '') + padRight(line, w) + ansi.reset);
    } else {
      // graph-only line
      const colorized = colorizeGraphLine(item.display, w - 2);
      lines.push(' ' + colorized);
    }
  }

  // Scroll indicator for commit list
  if (state.logItems.length > listH) {
    const maxScroll = Math.max(1, state.logItems.length - listH);
    const pct = Math.round((state.logScrollOffset / maxScroll) * 100);
    const indicator = colors.dim + ` [${pct}%]` + ansi.reset;
    if (lines.length > 0) {
      lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 6) + indicator;
    }
  }

  // ── Separator ──
  lines.push(colors.border + '\u2500'.repeat(w) + ansi.reset);

  // ── Detail ──
  if (state.logDetailLines.length === 0) {
    lines.push(colors.dim + ' Select an item to view details' + ansi.reset);
    for (let i = 1; i < detailH; i++) lines.push('');
  } else {
    const maxDetailScroll = Math.max(0, state.logDetailLines.length - detailH);
    if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
    const visible = state.logDetailLines.slice(state.diffScrollOffset, state.diffScrollOffset + detailH);
    for (const rawLine of visible) {
      lines.push(' ' + colorizeDiffLine(rawLine, w));
    }
    if (state.logDetailLines.length > detailH && lines.length > listH + 1) {
      const pct = Math.round((state.diffScrollOffset / maxDetailScroll) * 100);
      const idx = listH + 1;
      lines[idx] = padRight(lines[idx], w - 6) + colors.dim + ` [${pct}%]` + ansi.reset;
    }
  }

  return lines;
}

function colorizeGraphChars(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const lane = Math.floor(i / 2);
    const c = branchPalette[lane % branchPalette.length];
    switch (ch) {
      case '*': result += c + '\u25cf' + ansi.reset; break;  // ●
      case '|': result += c + '\u2502' + ansi.reset; break;  // │
      case '/': result += c + '\u2571' + ansi.reset; break;  // ╱
      case '\\': result += c + '\u2572' + ansi.reset; break; // ╲
      case '_': result += c + '\u2500' + ansi.reset; break;  // ─
      case '-': result += c + '\u2500' + ansi.reset; break;  // ─
      default: result += ch; break;
    }
  }
  return result;
}

function colorizeGraphLine(line, maxW) {
  const match = line.match(/^([^*]*\*\s+)([0-9a-f]{7,})(\s+\([^)]+\))?\s*(.*)/);
  if (!match) {
    // Graph-only line (connectors like │ ╱ ╲)
    return colorizeGraphChars(truncate(line, maxW));
  }
  const graphPart = colorizeGraphChars(match[1]);
  const hash = match[2];
  const hashPart = colors.yellow + hash + ansi.reset;

  // Add stash decoration if this commit is a stash
  let decoStr = match[3] || '';
  const sRef = stashMap.get(hash);
  if (sRef) {
    if (decoStr) {
      decoStr = decoStr.replace(/\)$/, ', ' + sRef + ')');
    } else {
      decoStr = ' (' + sRef + ')';
    }
  }
  const decoPart = decoStr ? colors.cyan + decoStr + ansi.reset : '';

  const usedLen = match[1].length + hash.length + decoStr.length + 1;
  const subjPart = colors.value + truncate(match[4] || '', maxW - usedLen) + ansi.reset;
  return graphPart + hashPart + decoPart + ' ' + subjPart;
}

function colorizeDiffLine(rawLine, w) {
  if (rawLine.startsWith('+++') || rawLine.startsWith('---')) {
    return colors.diffHeader + truncate(rawLine, w) + ansi.reset;
  } else if (rawLine.startsWith('+')) {
    return colors.diffAdd + truncate(rawLine, w) + ansi.reset;
  } else if (rawLine.startsWith('-')) {
    return colors.diffDel + truncate(rawLine, w) + ansi.reset;
  } else if (rawLine.startsWith('@@')) {
    return colors.diffHunk + truncate(rawLine, w) + ansi.reset;
  } else if (rawLine.startsWith('diff ') || rawLine.startsWith('index ') || rawLine.startsWith('commit ')) {
    return colors.dim + truncate(rawLine, w) + ansi.reset;
  }
  return colors.label + truncate(rawLine, w) + ansi.reset;
}

const hintButtons = [
  { label: '[s]tage',    action: 'stage' },
  { label: '[u]nstage',  action: 'unstage' },
  { label: '[a]ll',      action: 'all' },
  { label: '[c]ommit',   action: 'commit' },
  { label: '[l]og',      action: 'log' },
  { label: '[r]efresh',  action: 'refresh' },
];

function buildHintText() {
  let result = '';
  for (let i = 0; i < hintButtons.length; i++) {
    if (i > 0) result += '  ';
    const color = (i === hoveredAreaIndex) ? colors.value + ansi.bold : colors.dim;
    result += color + hintButtons[i].label + ansi.reset;
  }
  return result;
}

function renderMinimized() {
  const cols = termCols;
  let line = colors.title + ansi.bold + ' Git' + ansi.reset;
  if (state.branch) {
    line += colors.dim + ' | ' + ansi.reset + colors.cyan + state.branch + ansi.reset;
  }
  const fileCount = state.staged.length + state.unstaged.length + state.untracked.length;
  if (fileCount > 0) {
    line += colors.dim + ' | ' + ansi.reset;
    if (state.staged.length > 0) line += colors.green + '+' + state.staged.length + ansi.reset + ' ';
    if (state.unstaged.length > 0) line += colors.red + '~' + state.unstaged.length + ansi.reset + ' ';
    if (state.untracked.length > 0) line += colors.dim + '?' + state.untracked.length + ansi.reset;
  }
  line += ' '.repeat(Math.max(0, cols - visLen(line)));
  process.stdout.write(ansi.clear + ansi.hideCursor + ansi.moveTo(1, 1) + line + ansi.reset);
}

// ============================================================
// Input Handling
// ============================================================
function actionToKey(action) {
  switch (action) {
    case 'stage':    return 's';
    case 'unstage':  return 'u';
    case 'all':      return 'a';
    case 'commit':   return 'c';
    case 'log':      return 'l';
    case 'refresh':  return 'r';
    case 'tab':      return '\t';
    case 'quit':     return 'q';
    default:         return '';
  }
}

function handleKey(key) {
  if (state.mode === 'commit') {
    handleCommitInput(key);
    return;
  }

  // Arrow keys (VT sequences)
  if (key === CSI + 'A' || key === 'k') { // Up
    if (state.focusPanel === 'status') {
      const list = buildFileList();
      if (list.length > 0) {
        state.cursor = Math.max(0, state.cursor - 1);
        state.rightView = 'diff';
        updateDiff();
      }
    } else if (state.rightView === 'log') {
      if (state.logSelectables.length > 0) {
        state.logCursor = Math.max(0, state.logCursor - 1);
        state.diffScrollOffset = 0;
        updateLogDetail();
      }
    } else {
      state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 1);
    }
    render();
    return;
  }
  if (key === CSI + 'B' || key === 'j') { // Down
    if (state.focusPanel === 'status') {
      const list = buildFileList();
      if (list.length > 0) {
        state.cursor = Math.min(list.length - 1, state.cursor + 1);
        state.rightView = 'diff';
        updateDiff();
      }
    } else if (state.rightView === 'log') {
      if (state.logSelectables.length > 0) {
        state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 1);
        state.diffScrollOffset = 0;
        updateLogDetail();
      }
    } else {
      state.diffScrollOffset++;
    }
    render();
    return;
  }

  switch (key) {
    case 's': {
      const item = selectedItem();
      if (!item) break;
      if (item.type === 'unstaged' || item.type === 'untracked') {
        gitStage(state.cwd, item.file);
        refresh();
      }
      render();
      break;
    }
    case 'u': {
      const item = selectedItem();
      if (!item) break;
      if (item.type === 'staged') {
        gitUnstage(state.cwd, item.file);
        refresh();
      }
      render();
      break;
    }
    case 'a': {
      if (state.staged.length > 0 && state.unstaged.length === 0 && state.untracked.length === 0) {
        gitUnstageAll(state.cwd);
      } else {
        gitStageAll(state.cwd);
      }
      refresh();
      render();
      break;
    }
    case 'c': {
      if (state.staged.length === 0) {
        state.error = 'Nothing staged to commit';
        render();
        setTimeout(() => { state.error = null; render(); }, 2000);
        break;
      }
      state.mode = 'commit';
      state.commitMsg = '';
      render();
      break;
    }
    case 'l':
    case 'L': {
      if (state.rightView === 'log') {
        state.rightView = 'diff';
        updateDiff();
      } else {
        state.rightView = 'log';
        refreshLog();
        state.logCursor = 0;
        state.logScrollOffset = 0;
        state.diffScrollOffset = 0;
        updateLogDetail();
        state.focusPanel = 'diff';
      }
      render();
      break;
    }
    case 'r':
    case 'R': {
      refresh();
      if (state.rightView === 'log') refreshLog();
      render();
      break;
    }
    case '\t': { // Tab
      state.focusPanel = state.focusPanel === 'status' ? 'diff' : 'status';
      render();
      break;
    }
    case 'q':
    case 'Q': {
      cleanup();
      sendRpcNotify('close');
      break;
    }
  }
}

function handleCommitInput(key) {
  // Esc → cancel
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    state.commitMsg = '';
    render();
    return;
  }
  // Enter → commit
  if (key === '\r' || key === '\n') {
    if (state.commitMsg.trim().length === 0) {
      state.error = 'Commit message cannot be empty';
      render();
      setTimeout(() => { state.error = null; render(); }, 2000);
      return;
    }
    const err = gitCommit(state.cwd, state.commitMsg);
    state.mode = 'normal';
    if (err) {
      state.error = 'Commit failed: ' + err.substring(0, 60);
      render();
      setTimeout(() => { state.error = null; render(); }, 3000);
    } else {
      state.commitMsg = '';
      refresh();
      render();
    }
    return;
  }
  // Backspace
  if (key === '\x7f' || key === '\b' || key === CSI + '3~') {
    state.commitMsg = state.commitMsg.slice(0, -1);
    render();
    return;
  }
  // Printable characters
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.commitMsg += key;
    render();
    return;
  }
  // Multi-byte UTF-8
  if (key.length > 1 && !key.startsWith('\x1b')) {
    state.commitMsg += key;
    render();
    return;
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  render();

  // Get CWD from host
  const cwdResult = await sendRpc('get_cwd');
  if (cwdResult && cwdResult.cwd) {
    state.cwd = cwdResult.cwd;
  } else {
    state.cwd = process.cwd();
  }

  state.loading = false;
  refresh();
  render();

  // Handle stdin
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch { /* ignore */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (data) => {
    // Check for RPC messages from host
    if (data.startsWith('__HECA_RPC__')) {
      try {
        const json = JSON.parse(data.slice(12).trim());
        // Notification from host (has method, no id response)
        if (json.method === 'resize' && json.params) {
          termCols = json.params.cols || termCols;
          termRows = json.params.rows || termRows;
          render();
        } else if (json.method === 'minimize') {
          state.minimized = true;
          render();
        } else if (json.method === 'maximize') {
          // Host handles sizing; plugin just re-renders on resize
        } else if (json.method === 'restore') {
          state.minimized = false;
          refresh();
          render();
        } else {
          // RPC response
          handleRpcResponse(json);
        }
      } catch { /* ignore */ }
      return;
    }

    // Handle SGR mouse sequences: ESC [ < Cb ; Cx ; Cy M/m
    const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let mouseMatch;
    let hadMouse = false;
    while ((mouseMatch = mouseRegex.exec(data)) !== null) {
      hadMouse = true;
      const cb = parseInt(mouseMatch[1], 10);
      const cx = parseInt(mouseMatch[2], 10);
      const cy = parseInt(mouseMatch[3], 10);
      const isRelease = mouseMatch[4] === 'm';

      // Motion events (cb bit 5 set) → hover on hint buttons
      if ((cb & 32) !== 0) {
        let newHover = -1;
        for (let i = 0; i < clickableAreas.length; i++) {
          const area = clickableAreas[i];
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            newHover = i;
            break;
          }
        }
        if (newHover !== hoveredAreaIndex) {
          hoveredAreaIndex = newHover;
          render();
        }
        continue;
      }

      if (isRelease) continue;

      // Scroll wheel
      if (cb === 64 || cb === 65) {
        const L = lastLayout;
        const inLeft = cx > L.startCol && cx <= L.startCol + L.leftW;
        const inRight = cx > L.startCol + L.leftW + 1 && cx < L.startCol + L.width;
        const inBody = cy >= L.startRow + 3 && cy < L.startRow + 3 + L.bodyH;
        if (inBody && inRight) {
          if (state.rightView === 'log') {
            // Determine if mouse is in commit list or detail area
            const rightRowIdx = cy - (L.startRow + 3);
            if (rightRowIdx < lastLogListH) {
              // Scroll commit/stash list
              if (state.logSelectables.length > 0) {
                if (cb === 64) state.logCursor = Math.max(0, state.logCursor - 3);
                else state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 3);
                state.diffScrollOffset = 0;
                updateLogDetail();
              }
            } else {
              // Scroll detail diff
              if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
              else state.diffScrollOffset += 3;
            }
          } else {
            // Scroll diff panel
            if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
            else state.diffScrollOffset += 3;
          }
          state.focusPanel = 'diff';
          render();
        } else if (inBody && inLeft) {
          // Scroll file list (move cursor)
          const list = buildFileList();
          if (list.length > 0) {
            if (cb === 64) state.cursor = Math.max(0, state.cursor - 3);
            else state.cursor = Math.min(list.length - 1, state.cursor + 3);
            state.focusPanel = 'status';
            if (state.rightView === 'diff') updateDiff();
          }
          render();
        }
        continue;
      }

      // Left click
      if (cb === 0) {
        const L = lastLayout;

        // Click on hint bar buttons
        for (const area of clickableAreas) {
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            handleKey(actionToKey(area.action));
            break;
          }
        }

        // Click on left panel (file list)
        const inLeft = cx > L.startCol && cx <= L.startCol + L.leftW;
        const bodyRowIdx = cy - (L.startRow + 3);
        if (inLeft && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
          if (bodyRowIdx < fileLineMap.length && fileLineMap[bodyRowIdx] >= 0) {
            state.cursor = fileLineMap[bodyRowIdx];
            state.focusPanel = 'status';
            state.rightView = 'diff';
            updateDiff();
            render();
          }
        }

        // Click on right panel
        const inRight = cx > L.startCol + L.leftW + 1 && cx < L.startCol + L.width;
        if (inRight && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
          state.focusPanel = 'diff';
          if (state.rightView === 'log' && bodyRowIdx < lastLogListH) {
            // Click on item in log list
            const itemIdx = state.logScrollOffset + bodyRowIdx;
            // Find which selectable this maps to
            const selectIdx = state.logSelectables.indexOf(itemIdx);
            if (selectIdx >= 0) {
              state.logCursor = selectIdx;
              state.diffScrollOffset = 0;
              updateLogDetail();
            }
          }
          render();
        }
      }
    }
    if (hadMouse) return;

    // Keyboard input
    handleKey(data);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });
}

function cleanup() {
  process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
