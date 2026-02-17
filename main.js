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

// Serie-style branch lane colors (6 colors from serie's palette)
const seriePalette = [
  ansi.fg(224, 108, 118),  // red/coral
  ansi.fg(152, 195, 121),  // green
  ansi.fg(229, 192, 123),  // yellow
  ansi.fg(97, 175, 239),   // blue
  ansi.fg(198, 120, 221),  // purple
  ansi.fg(86, 182, 194),   // cyan
];

// ============================================================
// Sixel Graph Rendering
// ============================================================
const SIXEL_ENABLED = true;
const CELL_W = 8;
const CELL_H = 16;
const LINE_W = 2;
const DOT_R = 3;
const SIXEL_PALETTE = [
  [224, 108, 118],
  [152, 195, 121],
  [229, 192, 123],
  [97,  175, 239],
  [198, 120, 221],
  [86,  182, 194],
];

function pxSet(buf, w, h, x, y, c) { if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = c; }

function pxVLine(buf, w, h, x, y0, y1, c, t) {
  const half = t >> 1;
  for (let dx = -half; dx < t - half; dx++)
    for (let y = y0; y <= y1; y++) pxSet(buf, w, h, x + dx, y, c);
}

function pxHLine(buf, w, h, x0, x1, y, c, t) {
  const half = t >> 1;
  for (let dy = -half; dy < t - half; dy++)
    for (let x = x0; x <= x1; x++) pxSet(buf, w, h, x, y + dy, c);
}

function pxCircle(buf, w, h, cx, cy, r, c) {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r2) pxSet(buf, w, h, cx + dx, cy + dy, c);
}

function pxBezier(buf, w, h, x0, y0, x1, y1, x2, y2, c, t) {
  const half = t >> 1;
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps, ms = 1 - s;
    const px = Math.round(ms * ms * x0 + 2 * ms * s * x1 + s * s * x2);
    const py = Math.round(ms * ms * y0 + 2 * ms * s * y1 + s * s * y2);
    for (let bx = -half; bx < t - half; bx++)
      for (let by = -half; by < t - half; by++)
        pxSet(buf, w, h, px + bx, py + by, c);
  }
}

function renderGraphRowInto(buf, pw, ph, yOff, chars, charColors, numCols, prevChars, nextChars) {
  for (let i = 0; i < chars.length && i < numCols; i++) {
    const ch = chars[i];
    const cc = charColors[i];
    if (cc < 0 || ch === ' ') continue;
    const c = (cc % 6) + 1; // 1-6, 0 = transparent
    const cx = i * CELL_W + (CELL_W >> 1); // center x of cell
    const cy = yOff + (CELL_H >> 1);       // center y in combined image
    const top = yOff, bot = yOff + CELL_H - 1;
    const left = i * CELL_W, right = (i + 1) * CELL_W - 1;

    switch (ch) {
      case '\u2502': // │ vertical line
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        break;
      case '\u25cf': { // ● commit dot
        const hasAbove = prevChars && i < prevChars.length && prevChars[i] !== ' ';
        const hasBelow = nextChars && i < nextChars.length && nextChars[i] !== ' ';
        if (hasAbove) pxVLine(buf, pw, ph, cx, top, cy - DOT_R - 1, c, LINE_W);
        if (hasBelow) pxVLine(buf, pw, ph, cx, cy + DOT_R + 1, bot, c, LINE_W);
        pxCircle(buf, pw, ph, cx, cy, DOT_R, c);
        break;
      }
      case '\u251c': // ├ vertical + right
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        pxHLine(buf, pw, ph, cx, right, cy, c, LINE_W);
        break;
      case '\u2524': // ┤ vertical + left
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        pxHLine(buf, pw, ph, left, cx, cy, c, LINE_W);
        break;
      case '\u256e': // ╮ bezier: left → down
        pxBezier(buf, pw, ph, left, cy, cx, cy, cx, bot, c, LINE_W);
        break;
      case '\u256d': // ╭ bezier: right → down
        pxBezier(buf, pw, ph, right, cy, cx, cy, cx, bot, c, LINE_W);
        break;
      case '\u256f': // ╯ bezier: up → left
        pxBezier(buf, pw, ph, cx, top, cx, cy, left, cy, c, LINE_W);
        break;
      case '\u2570': // ╰ bezier: up → right
        pxBezier(buf, pw, ph, cx, top, cx, cy, right, cy, c, LINE_W);
        break;
      case '\u2500': // ─ horizontal line
        pxHLine(buf, pw, ph, left, right, cy, c, LINE_W);
        break;
      case '\u253c': // ┼ cross
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        pxHLine(buf, pw, ph, left, right, cy, c, LINE_W);
        break;
    }
  }
}

function renderCombinedGraphPixels(graphRows, numCols) {
  const pw = numCols * CELL_W;
  const ph = graphRows.length * CELL_H;
  if (pw <= 0 || ph <= 0) return null;
  const buf = new Uint8Array(pw * ph);
  for (let r = 0; r < graphRows.length; r++) {
    const row = graphRows[r];
    if (!row) continue;
    const prev = r > 0 && graphRows[r - 1] ? graphRows[r - 1].chars : null;
    const next = r < graphRows.length - 1 && graphRows[r + 1] ? graphRows[r + 1].chars : null;
    renderGraphRowInto(buf, pw, ph, r * CELL_H, row.chars, row.charColors, numCols, prev, next);
  }
  return buf;
}

function encodeSixel(buf, w, h, palette) {
  // DCS header: P0;1;0q  (Ps2=1 → transparent background)
  let out = '\x1bP0;1;0q';
  // Raster attributes
  out += '"1;1;' + w + ';' + h;
  // Palette definitions (RGB 0-100)
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = palette[i];
    out += '#' + (i + 1) + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255);
  }
  // Pixel data: process 6 rows at a time (one sixel band)
  for (let bandY = 0; bandY < h; bandY += 6) {
    const bandH = Math.min(6, h - bandY);
    let bandHasData = false;
    for (let ci = 1; ci <= palette.length; ci++) {
      // Build sixel row for this color
      let row = '';
      let runChar = '';
      let runLen = 0;
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let dy = 0; dy < bandH; dy++) {
          const y = bandY + dy;
          if (buf[y * w + x] === ci) bits |= (1 << dy);
        }
        const ch = String.fromCharCode(63 + bits);
        if (ch === runChar) {
          runLen++;
        } else {
          if (runLen > 0) {
            if (runLen >= 4) row += '!' + runLen + runChar;
            else row += runChar.repeat(runLen);
          }
          runChar = ch;
          runLen = 1;
        }
      }
      if (runLen > 0) {
        if (runLen >= 4) row += '!' + runLen + runChar;
        else row += runChar.repeat(runLen);
      }
      // Skip color if entirely transparent (all '?' = 63+0)
      if (row.replace(/[!0-9]/g, '').replace(/\?/g, '') === '') continue;
      bandHasData = true;
      out += '#' + ci + row + '$'; // $ = carriage return (same band, next color)
    }
    if (bandHasData) {
      // Remove trailing $ and add - (next band / line feed)
      if (out.endsWith('$')) out = out.slice(0, -1);
    }
    out += '-'; // - = next sixel line (band)
  }
  // Remove trailing -
  if (out.endsWith('-')) out = out.slice(0, -1);
  // String terminator
  out += '\x1b\\';
  return out;
}

let logSixelOverlay = null;  // single combined Sixel overlay

// ============================================================
// Terminal Size & Mouse State
// ============================================================
let termCols = parseInt(process.env.HECA_COLS || '80', 10);
let termRows = parseInt(process.env.HECA_ROWS || '24', 10);

let clickableAreas = [];   // { row, colStart, colEnd, action }
let hoveredAreaIndex = -1;
let fileLineMap = [];       // maps visible left-panel line index → file list index (-1 = not a file)
let lastLayout = { startRow: 0, startCol: 0, width: 0, height: 0, leftW: 0, dividerW: 0, rightW: 0, bodyH: 0 };
let lastLogListH = 0;      // number of rows in log commit list area
let stashMap = new Map();  // shortHash → stash@{N}
let verticalDividerRatio = 0.35;   // 세로 구분선 위치 (좌/우 비율)
let logListRatio = 0.4;            // 로그뷰 가로 구분선 위치 (상/하 비율)
let dragging = null;               // null | 'vertical' | 'horizontal'
let leftPanelCollapsed = false;    // Status 패널 접힘 상태
let rightTopCollapsed = false;     // 우측 상단 섹션 접힘 (History / Diff)
let rightBottomCollapsed = false;  // 우측 하단 섹션 접힘 (Detail)
let titleClickZones = [];          // { colStart, colEnd, action }
let hoveredTitleZoneIndex = -1;
let hoveredDivider = null;         // null | 'vertical' | 'horizontal'

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
// Serie-style Graph Engine
// ============================================================
function gitLogCommits(cwd, extraRefs, maxCount) {
  try {
    const args = ['log', '--all', '--topo-order', '--format=%H%x00%P%x00%D%x00%s'];
    if (extraRefs && extraRefs.length > 0) args.push(...extraRefs);
    if (maxCount) args.push('-' + maxCount);
    const raw = execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    }).replace(/\r\n/g, '\n').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\0');
      return {
        hash: parts[0],
        parents: parts[1] ? parts[1].split(' ') : [],
        refs: parts[2] || '',
        subject: parts[3] || '',
      };
    });
  } catch {
    return [];
  }
}

function calcGraphRows(commits) {
  const rows = [];
  let lanes = [];
  let maxLanes = 0;

  for (const commit of commits) {
    const { hash, parents } = commit;

    let commitLane = lanes.indexOf(hash);
    if (commitLane === -1) {
      // Reuse a null (empty) lane slot to keep graph compact
      commitLane = lanes.indexOf(null);
      if (commitLane === -1) {
        commitLane = lanes.length;
        lanes.push(hash);
      } else {
        lanes[commitLane] = hash;
      }
    }

    const merges = [];

    if (parents.length === 0) {
      lanes[commitLane] = null;
    } else {
      lanes[commitLane] = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const existing = lanes.indexOf(parents[p]);
        if (existing !== -1 && existing !== commitLane) {
          merges.push({ lane: existing, isNew: false });
        } else if (existing === -1) {
          // Reuse a null lane slot or append
          let newLane = lanes.indexOf(null);
          if (newLane === -1) {
            newLane = lanes.length;
            lanes.push(parents[p]);
          } else {
            lanes[newLane] = parents[p];
          }
          merges.push({ lane: newLane, isNew: true });
        }
      }
    }

    const { chars, charColors } = buildGraphChars(commitLane, lanes, merges);
    maxLanes = Math.max(maxLanes, lanes.length);

    const shortHash = hash.substring(0, 7);
    let decoration = '';
    if (commit.refs) {
      decoration = ' (' + commit.refs + ')';
      const sRef = stashMap.get(shortHash);
      if (sRef) decoration = decoration.replace(/\)$/, ', ' + sRef + ')');
    } else {
      const sRef = stashMap.get(shortHash);
      if (sRef) decoration = ' (' + sRef + ')';
    }

    rows.push({ type: 'commit', chars, charColors, commitLane, ref: shortHash, decoration, subject: commit.subject });

    // Collapse duplicate lanes — merge visual into the commit row
    const lastRow = rows[rows.length - 1];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) continue;
      for (let j = i + 1; j < lanes.length; j++) {
        if (lanes[j] === lanes[i]) {
          maxLanes = Math.max(maxLanes, lanes.length);
          while (lastRow.chars.length < lanes.length * 2) {
            lastRow.chars.push(' ');
            lastRow.charColors.push(-1);
          }
          const keepCol = i * 2;
          const removeCol = j * 2;
          if (lastRow.chars[removeCol] === '\u2502') {
            lastRow.chars[removeCol] = j > i ? '\u256f' : '\u2570';
            lastRow.charColors[removeCol] = j;
          }
          if (lastRow.chars[keepCol] === '\u2502') {
            lastRow.chars[keepCol] = j > i ? '\u251c' : '\u2524';
            lastRow.charColors[keepCol] = i;
          }
          fillHorizontal(lastRow.chars, lastRow.charColors, i, j, lanes);
          lanes[j] = null;
        }
      }
    }

    // Only remove trailing null lanes (interior nulls are reused later)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    // (connector rows removed — one line per commit)
  }

  // Post-process: align all rows to same width, add trailing ─ for commits
  const graphWidth = maxLanes * 2;
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    // Extend chars/charColors to graphWidth
    while (row.chars.length < graphWidth) {
      row.chars.push(' ');
      row.charColors.push(-1);
    }

    row.graphStr = renderGraphCharsFixed(row.chars, row.charColors, graphWidth);

    // Sixel is now generated as a single combined image in buildLogPanel
  }

  return rows;
}

function buildGraphChars(commitLane, lanes, merges) {
  const n = lanes.length;
  const width = n * 2;
  const chars = new Array(width).fill(' ');
  const charColors = new Array(width).fill(-1);

  for (let i = 0; i < n; i++) {
    const col = i * 2;
    if (i === commitLane) {
      chars[col] = '\u25cf';
      charColors[col] = commitLane;
    } else if (lanes[i] !== null) {
      chars[col] = '\u2502';
      charColors[col] = i;
    }
  }

  for (const merge of merges) {
    const target = merge.lane;
    fillHorizontal(chars, charColors, commitLane, target, lanes);
    const targetCol = target * 2;
    if (merge.isNew) {
      chars[targetCol] = target > commitLane ? '\u256e' : '\u256d';
    } else {
      chars[targetCol] = target > commitLane ? '\u2524' : '\u251c';
    }
    charColors[targetCol] = target;
  }

  return { chars, charColors };
}

function buildCollapseChars(keepLane, removeLane, lanes) {
  const n = lanes.length;
  const width = n * 2;
  const chars = new Array(width).fill(' ');
  const charColors = new Array(width).fill(-1);

  for (let i = 0; i < n; i++) {
    if (i === keepLane || i === removeLane) continue;
    if (lanes[i] !== null) {
      chars[i * 2] = '\u2502';
      charColors[i * 2] = i;
    }
  }

  const keepCol = keepLane * 2;
  chars[keepCol] = removeLane > keepLane ? '\u251c' : '\u2524';
  charColors[keepCol] = keepLane;

  const removeCol = removeLane * 2;
  chars[removeCol] = removeLane > keepLane ? '\u256f' : '\u2570';
  charColors[removeCol] = removeLane;

  fillHorizontal(chars, charColors, keepLane, removeLane, lanes);

  return { chars, charColors };
}

function fillHorizontal(chars, charColors, fromLane, toLane, lanes) {
  const left = Math.min(fromLane, toLane);
  const right = Math.max(fromLane, toLane);
  const lineColor = toLane;

  for (let col = left * 2 + 1; col < right * 2; col++) {
    const isLanePos = (col % 2 === 0);
    if (isLanePos) {
      const laneIdx = col / 2 | 0;
      if (laneIdx === fromLane || laneIdx === toLane) continue;
      const existing = chars[col];
      if (existing === '\u2502' || existing === '\u251c' || existing === '\u2524' || existing === '\u256e' || existing === '\u256d') {
        chars[col] = '\u253c';
      } else if (existing === ' ') {
        chars[col] = '\u2500';
        charColors[col] = lineColor;
      }
    } else {
      if (chars[col] === ' ') {
        chars[col] = '\u2500';
        charColors[col] = lineColor;
      }
    }
  }
}

function renderGraphCharsFixed(chars, charColors, width) {
  let result = '';
  for (let i = 0; i < width; i++) {
    const ch = i < chars.length ? chars[i] : ' ';
    const cc = i < charColors.length ? charColors[i] : -1;
    if (cc >= 0) {
      result += seriePalette[cc % seriePalette.length] + ch + ansi.reset;
    } else {
      result += ch;
    }
  }
  return result;
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
  logItems: [],           // [{ type:'commit'|'graph', graphStr, ref, decoration, subject }]
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
  const stashFullHashes = new Set();
  for (const s of stashRefList) {
    stashMap.set(s.shortHash, s.ref);
    stashHashes.push(s.hash);
    stashFullHashes.add(s.hash);
  }

  const rawCommits = gitLogCommits(state.cwd, stashHashes);

  // Filter stash sub-commits (index, untracked) to keep graph clean.
  // Stash WIP commits are merge commits whose non-first parents are internal.
  const stashSubHashes = new Set();
  for (const c of rawCommits) {
    if (stashFullHashes.has(c.hash) && c.parents.length > 1) {
      for (let i = 1; i < c.parents.length; i++) {
        stashSubHashes.add(c.parents[i]);
      }
    }
  }
  const commits = stashSubHashes.size > 0
    ? rawCommits
        .filter(c => !stashSubHashes.has(c.hash))
        .map(c => {
          const fp = c.parents.filter(p => !stashSubHashes.has(p));
          return fp.length === c.parents.length ? c : { ...c, parents: fp };
        })
    : rawCommits;

  const graphRows = calcGraphRows(commits);

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
  buf.push(ansi.hideCursor);

  // Internal divider characters (outer border drawn by overlay system)
  const H = '\u2500', V = '\u2502', CROSS = '\u253c';

  // Layout dimensions
  const leftW = leftPanelCollapsed
    ? 0
    : Math.max(1, Math.min(width - 2, Math.floor(width * verticalDividerRatio)));
  const dividerW = leftPanelCollapsed ? 0 : 1;
  const rightW = width - leftW - dividerW;
  const bodyH = height - 2; // -1 title, -1 separator
  const hintRow = startRow + height - 1;
  const sepRow = startRow + height - 2;

  // ── Title row ──
  titleClickZones = [];
  {
    let titleStr = ansi.moveTo(startRow, startCol);
    let col = startCol;
    let zoneIdx = 0;

    // 호버 시 밝은 흰색+밑줄, 기본은 title 색상
    const zoneStyle = (idx) => (idx === hoveredTitleZoneIndex)
      ? colors.value + ansi.bold + CSI + '4m'   // underline
      : colors.title + ansi.bold;

    function pushZone(label, action) {
      const si = zoneIdx++;
      titleClickZones.push({ colStart: col, colEnd: col + visLen(label) - 1, action });
      titleStr += zoneStyle(si) + label + ansi.reset;
      col += visLen(label);
    }

    // Status 버튼 (항상 표시)
    pushZone((leftPanelCollapsed ? ' + ' : ' - ') + 'Status', 'toggleStatus');

    if (leftPanelCollapsed) {
      // 구분선 없이 우측 타이틀 이어서 표시
      titleStr += '  '; col += 2;
    } else {
      // 패딩 + 구분선
      titleStr += ' '.repeat(Math.max(0, leftW - (col - startCol)));
      col = startCol + leftW;
      titleStr += colors.border + V + ansi.reset;
      col += 1;
    }

    {
      const topLabel = state.rightView === 'log' ? 'History' : 'Diff';
      const rStart = col;
      pushZone((rightTopCollapsed ? ' + ' : ' - ') + topLabel, 'toggleHistory');
      titleStr += '  '; col += 2;
      pushZone((rightBottomCollapsed ? ' + ' : ' - ') + 'Detail', 'toggleDetail');
      if (!leftPanelCollapsed) {
        titleStr += ' '.repeat(Math.max(0, rightW - (col - rStart)));
      } else {
        titleStr += ' '.repeat(Math.max(0, width - (col - startCol)));
      }
    }

    buf.push(titleStr);
  }

  // ── Title separator ──
  const vDivColor = hoveredDivider === 'vertical' ? colors.value : colors.border;
  if (leftPanelCollapsed) {
    buf.push(
      ansi.moveTo(startRow + 1, startCol) +
      colors.border +
      H.repeat(width) +
      ansi.reset
    );
  } else {
    buf.push(
      ansi.moveTo(startRow + 1, startCol) +
      colors.border + H.repeat(leftW) + ansi.reset +
      vDivColor + CROSS + ansi.reset +
      colors.border + H.repeat(rightW) + ansi.reset
    );
  }

  // ── Body ──
  const rightLines = state.rightView === 'log'
    ? buildLogPanel(rightW, bodyH)
    : buildRightPanel(rightW, bodyH);

  if (leftPanelCollapsed) {
    for (let i = 0; i < bodyH; i++) {
      const row = startRow + 2 + i;
      const rContent = i < rightLines.length ? rightLines[i] : '';
      buf.push(
        ansi.moveTo(row, startCol) +
        padRight(rContent, width)
      );
    }
    fileLineMap = [];
  } else {
    const leftLines = buildLeftPanel(leftW, bodyH);
    for (let i = 0; i < bodyH; i++) {
      const row = startRow + 2 + i;
      const lContent = i < leftLines.length ? leftLines[i] : '';
      const rContent = i < rightLines.length ? rightLines[i] : '';
      buf.push(
        ansi.moveTo(row, startCol) +
        padRight(lContent, leftW) +
        vDivColor + V + ansi.reset +
        padRight(rContent, rightW)
      );
    }
  }

  // ── Bottom separator ──
  buf.push(
    ansi.moveTo(sepRow, startCol) +
    colors.border +
    H.repeat(width) +
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
    padRight(hintContent, width)
  );

  // Append single combined Sixel overlay (one DCS — survives pipe chunking)
  if (SIXEL_ENABLED && logSixelOverlay && state.rightView === 'log') {
    const graphCol = startCol + leftW + dividerW + 1; // +1 for prefix char
    const screenRow = startRow + 2; // first body row
    buf.push(ansi.moveTo(screenRow, graphCol) + logSixelOverlay);
  }
  logSixelOverlay = null;

  process.stdout.write(buf.join(''));

  // Record layout for mouse hit testing
  lastLayout = { startRow, startCol, width, height, leftW, dividerW, rightW, bodyH };

  // Record clickable areas for hint bar buttons
  clickableAreas = [];
  if (state.mode === 'normal' && !state.error) {
    const contentStart = startCol + 1; // after space
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

  const focused = state.focusPanel === 'status';

  // Staged
  pushLine(colors.sectionHeader + ansi.bold + ' Staged (' + state.staged.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.staged.length; i++) {
    const item = state.staged[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const statusColor = colors.green;
    const line = prefix + statusColor + item.status + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  pushLine('', -1);

  // Unstaged
  pushLine(colors.sectionHeader + ansi.bold + ' Unstaged (' + state.unstaged.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.unstaged.length; i++) {
    const item = state.unstaged[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const statusColor = colors.red;
    const line = prefix + statusColor + item.status + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  pushLine('', -1);

  // Untracked
  pushLine(colors.sectionHeader + ansi.bold + ' Untracked (' + state.untracked.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.untracked.length; i++) {
    const item = state.untracked[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const line = prefix + colors.dim + '?' + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
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

  // Diff(상단) / Detail(하단) 분할 — buildLogPanel과 동일 패턴
  let diffH, detailH, separatorH;
  if (rightTopCollapsed && rightBottomCollapsed) {
    diffH = 0; separatorH = 0; detailH = 0;
  } else if (rightTopCollapsed) {
    diffH = 0; separatorH = 0; detailH = h;
  } else if (rightBottomCollapsed) {
    diffH = h; separatorH = 0; detailH = 0;
  } else {
    diffH = Math.min(Math.max(1, Math.floor(h * logListRatio)), h - 2);
    separatorH = 1;
    detailH = h - diffH - separatorH;
  }
  lastLogListH = diffH;

  // ── Diff 섹션 (상단) ──
  if (diffH > 0) {
    const maxScroll = Math.max(0, state.diffLines.length - diffH);
    if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
    const visible = state.diffLines.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
    for (const rawLine of visible) {
      lines.push(' ' + colorizeDiffLine(rawLine, w));
    }
    if (state.diffLines.length > diffH) {
      const pct = Math.round((state.diffScrollOffset / maxScroll) * 100);
      const indicator = colors.dim + ` [${pct}%]` + ansi.reset;
      if (lines.length > 0) {
        lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 6) + indicator;
      }
    }
  }

  // ── Separator ──
  if (separatorH > 0) {
    const hDivColor = hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // ── Detail 섹션 (하단: 선택 파일 정보) ──
  if (detailH > 0) {
    const item = selectedItem();
    if (item) {
      const statusMap = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' };
      lines.push(colors.label + ' File:   ' + ansi.reset + colors.value + truncate(item.file, w - 10) + ansi.reset);
      lines.push(colors.label + ' Status: ' + ansi.reset + colors.value + (item.status || '?') + ' (' + (statusMap[item.type] || item.type) + ')' + ansi.reset);
      // diff 통계
      let adds = 0, dels = 0;
      for (const l of state.diffLines) {
        if (l.startsWith('+') && !l.startsWith('+++')) adds++;
        else if (l.startsWith('-') && !l.startsWith('---')) dels++;
      }
      lines.push(colors.label + ' Lines:  ' + ansi.reset + colors.green + '+' + adds + ansi.reset + '  ' + colors.red + '-' + dels + ansi.reset);
      for (let i = 3; i < detailH; i++) lines.push('');
    } else {
      lines.push(colors.dim + ' No file selected' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
    }
  }

  return lines;
}

function buildLogPanel(w, h) {
  if (state.logItems.length === 0) {
    return [colors.dim + ' No commits yet' + ansi.reset];
  }

  // Upper half: item list, lower half: detail
  let listH, detailH, separatorH;
  if (rightTopCollapsed && rightBottomCollapsed) {
    listH = 0;
    separatorH = 0;
    detailH = 0;
  } else if (rightTopCollapsed) {
    listH = 0;
    separatorH = 0;
    detailH = h;
  } else if (rightBottomCollapsed) {
    listH = h;
    separatorH = 0;
    detailH = 0;
  } else {
    listH = Math.min(Math.max(1, Math.floor(h * logListRatio)), h - 2);
    separatorH = 1;
    detailH = h - listH - separatorH;
  }
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
  const graphRows = []; // collect graph data for combined Sixel image
  let graphWidth = 0;
  for (let i = 0; i < listH; i++) {
    const itemIdx = state.logScrollOffset + i;
    const item = visibleItems[i];
    if (!item) { lines.push(''); graphRows.push(null); continue; }

    const isCursor = state.focusPanel === 'diff' && itemIdx === selectedItemIdx;

    if (item.type === 'commit') {
      const prefix = isCursor ? (colors.cursorBg + colors.cursor + '\u25b8') : ' ';
      const graphVisLen = visLen(item.graphStr);
      // Use spaces for graph area when Sixel is active (Sixel overlay will cover it)
      const graphPart = SIXEL_ENABLED
        ? ' '.repeat(graphVisLen) + ' '
        : item.graphStr + ' ';
      // 고정 부분: prefix + graph + hash(7)
      const fixedLen = 1 + graphVisLen + 1 + 7 + 1; // prefix(1) + graph + space + hash(7) + space(1)
      const available = w - fixedLen;
      // decoration에서 괄호 제거: " (main, origin/main)" → "main, origin/main"
      const decoRaw = item.decoration ? item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      let subjStr, decoStr;
      if (available <= 0) {
        subjStr = '';
        decoStr = '';
      } else if (!decoRaw) {
        subjStr = truncate(item.subject, available);
        decoStr = '';
      } else {
        const subjNeed = visLen(item.subject);
        const decoNeed = visLen(decoRaw) + 1; // +1 for leading space
        if (subjNeed + decoNeed <= available) {
          subjStr = item.subject;
          decoStr = ' ' + decoRaw;
        } else {
          const subjW = Math.min(subjNeed, available - Math.min(decoNeed, Math.max(4, available - subjNeed)));
          subjStr = truncate(item.subject, subjW);
          const decoW = available - visLen(subjStr);
          if (decoW >= 4) {
            decoStr = ' ' + truncate(decoRaw, decoW - 1);
          } else {
            subjStr = truncate(item.subject, available);
            decoStr = '';
          }
        }
      }
      const subjPart = colors.value + subjStr + ansi.reset;
      const decoPart = decoStr ? colors.cyan + decoStr + ansi.reset : '';
      const hashPart = colors.yellow + item.ref + ansi.reset;
      const usedLen = 1 + graphVisLen + 1 + visLen(subjStr) + visLen(decoStr);
      const pad = Math.max(1, w - usedLen - 7);
      const line = prefix + graphPart + subjPart + decoPart + ' '.repeat(pad) + hashPart;
      lines.push((isCursor ? colors.cursorBg : '') + padRight(line, w) + ansi.reset);
      graphRows.push(item.chars ? { chars: item.chars, charColors: item.charColors } : null);
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
    } else {
      // graph-only line (collapse connectors)
      const graphPart = SIXEL_ENABLED ? ' '.repeat(visLen(item.graphStr)) : item.graphStr;
      lines.push(' ' + graphPart);
      graphRows.push(item.chars ? { chars: item.chars, charColors: item.charColors } : null);
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
    }
  }

  // Generate combined Sixel image for the entire graph column
  if (SIXEL_ENABLED && graphRows.length > 0 && graphWidth > 0) {
    const pixBuf = renderCombinedGraphPixels(graphRows, graphWidth);
    if (pixBuf) {
      logSixelOverlay = encodeSixel(pixBuf, graphWidth * CELL_W, graphRows.length * CELL_H, SIXEL_PALETTE);
    }
  }

  // Scroll indicator for commit list
  if (listH > 0 && state.logItems.length > listH) {
    const maxScroll = Math.max(1, state.logItems.length - listH);
    const pct = Math.round((state.logScrollOffset / maxScroll) * 100);
    const indicator = colors.dim + ` [${pct}%]` + ansi.reset;
    if (lines.length > 0) {
      lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 6) + indicator;
    }
  }

  // ── Separator ──
  if (separatorH > 0) {
    const hDivColor = hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // ── Detail ──
  if (detailH > 0) {
    const selItem = selectedLogRef();
    if (state.logDetailLines.length === 0) {
      lines.push(colors.dim + ' Select an item to view details' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
    } else {
      // 첫째줄: 선택된 리비전의 브랜치/refs
      const refsRaw = selItem && selItem.decoration ? selItem.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      if (refsRaw) {
        lines.push(colors.cyan + ' \u2387 ' + truncate(refsRaw, w - 4) + ansi.reset);
      } else {
        lines.push(colors.dim + ' (no refs)' + ansi.reset);
      }
      const contentH = detailH - 1;
      const maxDetailScroll = Math.max(0, state.logDetailLines.length - contentH);
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
      const visible = state.logDetailLines.slice(state.diffScrollOffset, state.diffScrollOffset + contentH);
      for (const rawLine of visible) {
        lines.push(' ' + colorizeDiffLine(rawLine, w));
      }
      if (state.logDetailLines.length > contentH && lines.length > listH + separatorH + 1) {
        const pct = Math.round((state.diffScrollOffset / maxDetailScroll) * 100);
        const idx = listH + separatorH + 1;
        lines[idx] = padRight(lines[idx], w - 6) + colors.dim + ` [${pct}%]` + ansi.reset;
      }
    }
  }

  return lines;
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
  let line = '';
  if (state.branch) {
    line += colors.cyan + state.branch + ansi.reset;
  }
  const fileCount = state.staged.length + state.unstaged.length + state.untracked.length;
  if (fileCount > 0) {
    line += colors.dim + ' | ' + ansi.reset;
    if (state.staged.length > 0) line += colors.green + '+' + state.staged.length + ansi.reset + ' ';
    if (state.unstaged.length > 0) line += colors.red + '~' + state.unstaged.length + ansi.reset + ' ';
    if (state.untracked.length > 0) line += colors.dim + '?' + state.untracked.length + ansi.reset;
  }
  line += ' '.repeat(Math.max(0, cols - visLen(line)));
  process.stdout.write(ansi.hideCursor + ansi.moveTo(1, 1) + line + ansi.reset);
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
    // Check for RPC messages from host.
    // Multiple RPCs can arrive in a single read (pipe buffering), so split and
    // process each one separately.
    if (data.indexOf('__HECA_RPC__') !== -1) {
      const segments = data.split('__HECA_RPC__');
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
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
            handleRpcResponse(json);
          }
        } catch { /* ignore malformed segment */ }
      }
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

      // Motion events (cb bit 5 set) → drag resize / hover
      if ((cb & 32) !== 0) {
        if (dragging === 'vertical') {
          const L = lastLayout;
          verticalDividerRatio = Math.max(1 / L.width, Math.min(1 - 2 / L.width, (cx - L.startCol) / L.width));
          render();
          continue;
        }
        if (dragging === 'horizontal') {
          const L = lastLayout;
          logListRatio = Math.max(1 / L.bodyH, Math.min(1 - 1 / L.bodyH, (cy - (L.startRow + 2)) / L.bodyH));
          render();
          continue;
        }
        const L = lastLayout;
        let newHover = -1;
        for (let i = 0; i < clickableAreas.length; i++) {
          const area = clickableAreas[i];
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            newHover = i;
            break;
          }
        }
        let newTitleHover = -1;
        if (cy === L.startRow) {
          for (let i = 0; i < titleClickZones.length; i++) {
            const zone = titleClickZones[i];
            if (cx >= zone.colStart && cx <= zone.colEnd) {
              newTitleHover = i;
              break;
            }
          }
        }
        let newDivHover = null;
        const inBody = cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH;
        if (!leftPanelCollapsed && inBody) {
          const dividerCol = L.startCol + L.leftW;
          if (cx >= dividerCol - 1 && cx <= dividerCol + 1) {
            newDivHover = 'vertical';
          }
        }
        if (!rightTopCollapsed && !rightBottomCollapsed) {
          const hSepRow = L.startRow + 2 + lastLogListH;
          if (cy === hSepRow && cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width) {
            newDivHover = 'horizontal';
          }
        }
        if (newHover !== hoveredAreaIndex || newTitleHover !== hoveredTitleZoneIndex || newDivHover !== hoveredDivider) {
          hoveredAreaIndex = newHover;
          hoveredTitleZoneIndex = newTitleHover;
          hoveredDivider = newDivHover;
          render();
        }
        continue;
      }

      if (isRelease) {
        if (dragging !== null) dragging = null;
        continue;
      }

      // Scroll wheel
      if (cb === 64 || cb === 65) {
        const L = lastLayout;
        const inLeft = !leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
        const inRight = cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width;
        const inBody = cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH;
        if (inBody && inRight) {
          if (state.rightView === 'log') {
            // Determine if mouse is in commit list or detail area
            const rightRowIdx = cy - (L.startRow + 2);
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
            // Scroll diff panel (top section only)
            const rightRowIdx = cy - (L.startRow + 2);
            if (rightRowIdx < lastLogListH) {
              if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
              else state.diffScrollOffset += 3;
            }
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

        // Title row click → collapse/expand
        if (cy === L.startRow) {
          let handled = false;
          for (const zone of titleClickZones) {
            if (cx >= zone.colStart && cx <= zone.colEnd) {
              if (zone.action === 'toggleStatus') {
                leftPanelCollapsed = !leftPanelCollapsed;
              } else if (zone.action === 'toggleHistory') {
                rightTopCollapsed = !rightTopCollapsed;
              } else if (zone.action === 'toggleDetail') {
                rightBottomCollapsed = !rightBottomCollapsed;
              }
              render();
              handled = true;
              break;
            }
          }
          if (handled) continue;
        }

        // Divider drag start detection (only when left panel is visible)
        if (!leftPanelCollapsed) {
          const dividerCol = L.startCol + L.leftW;
          if (cx >= dividerCol - 1 && cx <= dividerCol + 1 && cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH) {
            dragging = 'vertical';
            continue;
          }
        }
        if (!rightTopCollapsed && !rightBottomCollapsed && cy === L.startRow + 2 + lastLogListH && cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width) {
          dragging = 'horizontal';
          continue;
        }

        // Click on hint bar buttons
        for (const area of clickableAreas) {
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            handleKey(actionToKey(area.action));
            break;
          }
        }

        // Click on left panel (file list)
        const inLeft = !leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
        const bodyRowIdx = cy - (L.startRow + 2);
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
        const inRight = cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width;
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
