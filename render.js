const { CSI, ansi, colors, seriePalette } = require('./ansi');
const { SIXEL_ENABLED, CELL_W, CELL_H, SIXEL_PALETTE, renderCombinedGraphPixels, encodeSixel } = require('./sixel');
const { visLen, padRight, truncate } = require('./text');
const { state, ui } = require('./state');
const { buildFileList, selectedItem, selectedLogRef } = require('./refresh');

function render() {
  if (state.minimized) {
    renderMinimized();
    return;
  }

  const cols = ui.termCols;
  const rows = ui.termRows;
  const width = cols;
  const height = rows;
  const startCol = 1;
  const startRow = 1;

  const buf = [];
  buf.push(ansi.hideCursor + CSI + '?7l');

  const H = '\u2500', V = '\u2502', CROSS = '\u253c';

  const leftW = ui.leftPanelCollapsed
    ? 0
    : Math.max(1, Math.min(width - 2, Math.floor(width * ui.verticalDividerRatio)));
  const dividerW = ui.leftPanelCollapsed ? 0 : 1;
  const rightW = width - leftW - dividerW;
  const bodyH = height - 2;
  const contentH = Math.max(0, bodyH - 2);
  const hintRow = startRow + height - 1;
  const sepRow = startRow + height - 2;

  // ── Title row ──
  ui.titleClickZones = [];
  {
    let titleStr = ansi.moveTo(startRow, startCol);
    let col = startCol;
    let zoneIdx = 0;

    const zoneStyle = (idx) => (idx === ui.hoveredTitleZoneIndex)
      ? colors.value + ansi.bold + CSI + '4m'
      : colors.title + ansi.bold;

    function pushZone(label, action) {
      const si = zoneIdx++;
      ui.titleClickZones.push({ colStart: col, colEnd: col + visLen(label) - 1, action });
      titleStr += zoneStyle(si) + label + ansi.reset;
      col += visLen(label);
    }

    pushZone((ui.leftPanelCollapsed ? ' + ' : ' - ') + 'Status', 'toggleStatus');

    if (ui.leftPanelCollapsed) {
      titleStr += '  '; col += 2;
    } else {
      titleStr += ' '.repeat(Math.max(0, leftW - (col - startCol)));
      col = startCol + leftW;
      titleStr += colors.border + V + ansi.reset;
      col += 1;
    }

    {
      const topLabel = state.rightView === 'log' ? 'History' : 'Diff';
      const rStart = col;
      pushZone((ui.rightTopCollapsed ? ' + ' : ' - ') + topLabel, 'toggleHistory');
      titleStr += '  '; col += 2;
      pushZone((ui.rightBottomCollapsed ? ' + ' : ' - ') + 'Detail', 'toggleDetail');
      if (!ui.leftPanelCollapsed) {
        titleStr += ' '.repeat(Math.max(0, rightW - (col - rStart)));
      } else {
        titleStr += ' '.repeat(Math.max(0, width - (col - startCol)));
      }
    }

    buf.push(titleStr);
  }

  // ── Title separator ──
  const vDivColor = ui.hoveredDivider === 'vertical' ? colors.value : colors.border;
  if (ui.leftPanelCollapsed) {
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
    ? buildLogPanel(rightW, contentH)
    : buildRightPanel(rightW, contentH);

  if (ui.leftPanelCollapsed) {
    for (let i = 0; i < bodyH; i++) {
      const row = startRow + 2 + i;
      const rContent = i < rightLines.length ? rightLines[i] : '';
      buf.push(
        ansi.moveTo(row, startCol) +
        padRight(rContent, width)
      );
    }
    ui.fileLineMap = [];
    ui.leftTabZones = [];
  } else {
    const leftLines = buildLeftPanel(leftW, contentH);
    ui.leftTabZones = [];
    if (ui.leftTabInfo) {
      const visibleIdx = ui.leftTabInfo.lineIdx - state.scrollOffset;
      if (visibleIdx >= 0 && visibleIdx < contentH) {
        const screenRow = startRow + 2 + visibleIdx;
        ui.leftTabZones.push({
          row: screenRow,
          colStart: startCol + ui.leftTabInfo.localColStart,
          colEnd: startCol + ui.leftTabInfo.localColEnd,
          action: 'localChanges'
        });
        ui.leftTabZones.push({
          row: screenRow,
          colStart: startCol + ui.leftTabInfo.allColStart,
          colEnd: startCol + ui.leftTabInfo.allColEnd,
          action: 'allCommits'
        });
      }
    }
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

  // Append single combined Sixel overlay
  if (SIXEL_ENABLED && ui.logSixelOverlay && state.rightView === 'log') {
    const graphCol = startCol + leftW + dividerW + 1;
    const screenRow = startRow + 2;
    buf.push(ansi.moveTo(screenRow, graphCol) + ui.logSixelOverlay);
  }
  ui.logSixelOverlay = null;

  process.stdout.write(buf.join(''));

  // Record layout for mouse hit testing
  ui.lastLayout = { startRow, startCol, width, height, leftW, dividerW, rightW, bodyH };

  // Record clickable areas for hint bar buttons
  ui.clickableAreas = [];
  if (state.mode === 'normal' && !state.error) {
    const contentStart = startCol + 1;
    let plainOffset = 0;
    for (let i = 0; i < hintButtons.length; i++) {
      if (i > 0) plainOffset += 2;
      ui.clickableAreas.push({
        row: hintRow,
        colStart: contentStart + plainOffset,
        colEnd: contentStart + plainOffset + hintButtons[i].label.length - 1,
        action: hintButtons[i].action,
      });
      plainOffset += hintButtons[i].label.length;
    }
  }
  if (ui.hoveredAreaIndex >= ui.clickableAreas.length) ui.hoveredAreaIndex = -1;
}

function buildLeftPanel(w, h) {
  const lines = [];
  const lineToFileIdx = [];
  const innerW = w - 1;
  let cursorLineIdx = -1;

  function pushLine(content, fileIdx) {
    lineToFileIdx.push(fileIdx);
    lines.push(content);
  }

  // Branch
  pushLine(colors.cyan + ' \u2387 ' + ansi.reset + colors.value + ansi.bold + (state.branch || '...') + ansi.reset, -1);

  // Tab buttons: Local Changes / All Commits
  {
    const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;
    const localLabel = `Local (${totalChanges})`;
    const allLabel = 'Commits';
    const isLocal = state.rightView !== 'log';
    const isAll = state.rightView === 'log';
    const activeStyle = colors.title + ansi.bold;
    const inactiveStyle = colors.title;

    let col = 1;
    const localColStart = col;
    col += localLabel.length;
    const localColEnd = col - 1;
    col += 2;
    const allColStart = col;
    col += allLabel.length;
    const allColEnd = col - 1;

    ui.leftTabInfo = { lineIdx: lines.length, localColStart, localColEnd, allColStart, allColEnd };

    let tabLine = ' ';
    tabLine += (isLocal ? activeStyle + CSI + '4m' : inactiveStyle) + localLabel + ansi.reset;
    tabLine += '  ';
    tabLine += (isAll ? activeStyle + CSI + '4m' : inactiveStyle) + allLabel + ansi.reset;
    pushLine(tabLine, -1);
  }
  pushLine('', -1);

  if (state.loading) {
    pushLine(colors.dim + ' Loading...' + ansi.reset, -1);
    ui.fileLineMap = lineToFileIdx;
    return lines;
  }

  if (!state.isGitRepo) {
    pushLine(colors.red + ' Not a git repository' + ansi.reset, -1);
    ui.fileLineMap = lineToFileIdx;
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
    const statusColor = item.status === 'D' ? colors.red : colors.orange;
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
    ui.fileLineMap = lineToFileIdx.slice(state.scrollOffset, state.scrollOffset + h);
    return lines.slice(state.scrollOffset, state.scrollOffset + h);
  }
  state.scrollOffset = 0;
  ui.fileLineMap = lineToFileIdx.slice(0, h);
  return lines;
}

function buildRightPanel(w, h) {
  const lines = [];

  if (state.diffLines.length === 0) {
    lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
    return lines;
  }

  let diffH, detailH, separatorH;
  if (ui.rightTopCollapsed && ui.rightBottomCollapsed) {
    diffH = 0; separatorH = 0; detailH = 0;
  } else if (ui.rightTopCollapsed) {
    diffH = 0; separatorH = 0; detailH = h;
  } else if (ui.rightBottomCollapsed) {
    diffH = h; separatorH = 0; detailH = 0;
  } else {
    diffH = Math.min(Math.max(1, Math.floor(h * ui.logListRatio)), h - 2);
    separatorH = 1;
    detailH = h - diffH - separatorH;
  }
  ui.lastLogListH = diffH;

  // ── Diff section (top) ──
  if (diffH > 0) {
    const maxScroll = Math.max(0, state.diffLines.length - diffH);
    if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
    const visible = state.diffLines.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
    for (const rawLine of visible) {
      lines.push(' ' + colorizeDiffLine(rawLine, w - 1));
    }
    if (state.diffLines.length > diffH) {
      const pct = Math.round((state.diffScrollOffset / maxScroll) * 100);
      const indicator = colors.dim + ` [${pct}%]` + ansi.reset;
      if (lines.length > 0) {
        lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 8) + indicator;
      }
    }
  }

  // ── Separator ──
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // ── Detail section (bottom) ──
  if (detailH > 0) {
    const item = selectedItem();
    if (item) {
      const statusMap = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' };
      lines.push(colors.label + ' File:   ' + ansi.reset + colors.value + truncate(item.file, w - 10) + ansi.reset);
      lines.push(colors.label + ' Status: ' + ansi.reset + colors.value + (item.status || '?') + ' (' + (statusMap[item.type] || item.type) + ')' + ansi.reset);
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

  let listH, detailH, separatorH;
  if (ui.rightTopCollapsed && ui.rightBottomCollapsed) {
    listH = 0; separatorH = 0; detailH = 0;
  } else if (ui.rightTopCollapsed) {
    listH = 0; separatorH = 0; detailH = h;
  } else if (ui.rightBottomCollapsed) {
    listH = h; separatorH = 0; detailH = 0;
  } else {
    listH = Math.min(Math.max(1, Math.floor(h * ui.logListRatio)), h - 2);
    separatorH = 1;
    detailH = h - listH - separatorH;
  }
  ui.lastLogListH = listH;

  const lines = [];

  const selectedItemIdx = state.logSelectables.length > 0
    ? state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)]
    : -1;

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
  const graphRows = [];
  let graphWidth = 0;
  for (let i = 0; i < listH; i++) {
    const itemIdx = state.logScrollOffset + i;
    const item = visibleItems[i];
    if (!item) { lines.push(''); graphRows.push(null); continue; }

    const isCursor = state.focusPanel === 'diff' && itemIdx === selectedItemIdx;

    if (item.type === 'commit') {
      const prefix = isCursor ? (colors.cursorBg + colors.cursor + '\u25b8') : ' ';
      const graphVisLen = visLen(item.graphStr);
      const graphPart = SIXEL_ENABLED
        ? ' '.repeat(graphVisLen) + ' '
        : item.graphStr + ' ';
      const fixedLen = 1 + graphVisLen + 1 + 7 + 1;
      const available = w - fixedLen;
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
        const decoNeed = visLen(decoRaw) + 1;
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
      const graphPart = SIXEL_ENABLED ? ' '.repeat(visLen(item.graphStr)) : item.graphStr;
      lines.push(' ' + graphPart);
      graphRows.push(item.chars ? { chars: item.chars, charColors: item.charColors } : null);
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
    }
  }

  // Generate combined Sixel image
  if (SIXEL_ENABLED && graphRows.length > 0 && graphWidth > 0) {
    const pixBuf = renderCombinedGraphPixels(graphRows, graphWidth);
    if (pixBuf) {
      ui.logSixelOverlay = encodeSixel(pixBuf, graphWidth * CELL_W, graphRows.length * CELL_H, SIXEL_PALETTE);
    }
  }

  // Scroll indicator
  if (listH > 0 && state.logItems.length > listH) {
    const maxScroll = Math.max(1, state.logItems.length - listH);
    const pct = Math.round((state.logScrollOffset / maxScroll) * 100);
    const indicator = colors.dim + ` [${pct}%]` + ansi.reset;
    if (lines.length > 0) {
      lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 8) + indicator;
    }
  }

  // ── Separator ──
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // ── Detail ──
  if (detailH > 0) {
    const selItem = selectedLogRef();
    if (state.logDetailLines.length === 0) {
      lines.push(colors.dim + ' Select an item to view details' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
    } else {
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
        lines.push(' ' + colorizeDiffLine(rawLine, w - 1));
      }
      if (state.logDetailLines.length > contentH && lines.length > listH + separatorH + 1) {
        const pct = Math.round((state.diffScrollOffset / maxDetailScroll) * 100);
        const idx = listH + separatorH + 1;
        lines[idx] = padRight(lines[idx], w - 8) + colors.dim + ` [${pct}%]` + ansi.reset;
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
  { label: '[r]efresh',  action: 'refresh' },
];

function buildHintText() {
  let result = '';
  for (let i = 0; i < hintButtons.length; i++) {
    if (i > 0) result += '  ';
    const color = (i === ui.hoveredAreaIndex) ? colors.value + ansi.bold : colors.dim;
    result += color + hintButtons[i].label + ansi.reset;
  }
  return result;
}

function renderMinimized() {
  const cols = ui.termCols;
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

module.exports = { render, hintButtons };
