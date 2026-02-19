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
    : Math.max(1, Math.min(width - 4, Math.floor(width * ui.verticalDividerRatio)));
  const divider1W = ui.leftPanelCollapsed ? 0 : 1;
  const remaining = width - leftW - divider1W;

  // Layout depends on view mode
  let middleW, divider2W, rightW;
  if (state.rightView === 'log') {
    // 2-column: left | right (history+detail top/bottom)
    middleW = 0;
    divider2W = 0;
    rightW = remaining;
  } else {
    // 3-column: left | middle (files) | right (diff+commit)
    middleW = Math.max(1, Math.min(remaining - 2, Math.floor(remaining * ui.filesDividerRatio)));
    divider2W = 1;
    rightW = Math.max(1, remaining - middleW - divider2W);
  }

  const bodyH = height - 2;
  const contentH = Math.max(0, bodyH - 2);
  const hintRow = startRow + height - 1;
  const sepRow = startRow + height - 2;

  // -- Title row --
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

    // Left: Status
    pushZone((ui.leftPanelCollapsed ? ' + ' : ' - ') + 'Status', 'toggleStatus');

    if (!ui.leftPanelCollapsed) {
      titleStr += ' '.repeat(Math.max(0, leftW - (col - startCol)));
      col = startCol + leftW;
      titleStr += colors.border + V + ansi.reset;
      col += 1;
    }

    if (state.rightView === 'log') {
      // 2-column title: History + Detail in the right area
      const rStart = col;
      pushZone((ui.rightTopCollapsed ? ' + ' : ' - ') + 'History', 'toggleHistory');
      titleStr += '  '; col += 2;
      pushZone((ui.rightBottomCollapsed ? ' + ' : ' - ') + 'Detail', 'toggleDetail');
      const rEnd = ui.leftPanelCollapsed ? startCol + width : startCol + leftW + divider1W + rightW;
      titleStr += ' '.repeat(Math.max(0, rEnd - col));
    } else {
      // 3-column title: Files | Diff
      {
        pushZone(' Files', 'middleLabel');
        const midEnd = startCol + leftW + divider1W + middleW;
        titleStr += ' '.repeat(Math.max(0, midEnd - col));
        col = midEnd;
        titleStr += colors.border + V + ansi.reset;
        col += 1;
      }
      {
        pushZone(' Diff', 'rightLabel');
        const totalEnd = startCol + width;
        titleStr += ' '.repeat(Math.max(0, totalEnd - col));
      }
    }

    buf.push(titleStr);
  }

  // -- Title separator --
  const vDiv1Color = ui.hoveredDivider === 'vertical' ? colors.value : colors.border;
  const vDiv2Color = ui.hoveredDivider === 'vertical2' ? colors.value : colors.border;
  {
    let sepStr = ansi.moveTo(startRow + 1, startCol);
    if (ui.leftPanelCollapsed) {
      if (state.rightView === 'log') {
        sepStr += colors.border + H.repeat(width) + ansi.reset;
      } else {
        sepStr += colors.border + H.repeat(middleW) + ansi.reset;
        sepStr += vDiv2Color + CROSS + ansi.reset;
        sepStr += colors.border + H.repeat(rightW) + ansi.reset;
      }
    } else {
      sepStr += colors.border + H.repeat(leftW) + ansi.reset;
      sepStr += vDiv1Color + CROSS + ansi.reset;
      if (state.rightView === 'log') {
        sepStr += colors.border + H.repeat(rightW) + ansi.reset;
      } else {
        sepStr += colors.border + H.repeat(middleW) + ansi.reset;
        sepStr += vDiv2Color + CROSS + ansi.reset;
        sepStr += colors.border + H.repeat(rightW) + ansi.reset;
      }
    }
    buf.push(sepStr);
  }

  // -- Body --
  if (state.rightView === 'log') {
    // 2-column body: left | right (log panel with top/bottom split)
    const rightLines = buildLogPanel(rightW, contentH);

    if (ui.leftPanelCollapsed) {
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + 2 + i;
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(ansi.moveTo(row, startCol) + padRight(rContent, width));
      }
      ui.fileLineMap = [];
      ui.leftTabZones = [];
    } else {
      const leftLines = buildLeftPanel(leftW, contentH);
      buildLeftTabZones(startRow, startCol, contentH);
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + 2 + i;
        const lContent = i < leftLines.length ? leftLines[i] : '';
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(
          ansi.moveTo(row, startCol) +
          padRight(lContent, leftW) +
          vDiv1Color + V + ansi.reset +
          padRight(rContent, rightW)
        );
      }
    }
  } else {
    // 3-column body: left | middle (files) | right (diff+commit)
    const middleLines = buildFileListPanel(middleW, contentH);
    const rightLines = buildDiffCommitPanel(rightW, contentH);

    if (ui.leftPanelCollapsed) {
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + 2 + i;
        const mContent = i < middleLines.length ? middleLines[i] : '';
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(
          ansi.moveTo(row, startCol) +
          padRight(mContent, middleW) +
          vDiv2Color + V + ansi.reset +
          padRight(rContent, rightW)
        );
      }
      ui.leftTabZones = [];
    } else {
      const leftLines = buildLeftPanel(leftW, contentH);
      buildLeftTabZones(startRow, startCol, contentH);
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + 2 + i;
        const lContent = i < leftLines.length ? leftLines[i] : '';
        const mContent = i < middleLines.length ? middleLines[i] : '';
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(
          ansi.moveTo(row, startCol) +
          padRight(lContent, leftW) +
          vDiv1Color + V + ansi.reset +
          padRight(mContent, middleW) +
          vDiv2Color + V + ansi.reset +
          padRight(rContent, rightW)
        );
      }
    }
  }

  // -- Bottom separator --
  buf.push(
    ansi.moveTo(sepRow, startCol) +
    colors.border + H.repeat(width) + ansi.reset
  );

  // -- Hint bar --
  let hintContent;
  if (state.mode === 'rebase-menu') {
    hintContent = colors.yellow + ' Rebase: ' + ansi.reset
      + colors.value + '[c]ontinue' + ansi.reset + '  '
      + colors.value + '[a]bort' + ansi.reset + '  '
      + colors.value + '[s]kip' + ansi.reset + '  '
      + colors.dim + '[Esc]cancel' + ansi.reset;
  } else if (state.mode === 'commit') {
    hintContent = colors.yellow + ' Commit: ' + ansi.reset
      + colors.dim + '[Enter]submit  [Esc]cancel' + ansi.reset;
  } else if (state.error) {
    hintContent = ' ' + colors.red + state.error + ansi.reset;
  } else {
    hintContent = ' ' + buildHintText();
  }
  buf.push(ansi.moveTo(hintRow, startCol) + padRight(hintContent, width));

  // Append Sixel overlay (for log graph)
  if (SIXEL_ENABLED && ui.logSixelOverlay && state.rightView === 'log') {
    const graphCol = startCol + leftW + divider1W + 1;
    const screenRow = startRow + 2;
    buf.push(ansi.moveTo(screenRow, graphCol) + ui.logSixelOverlay);
  }
  ui.logSixelOverlay = null;

  process.stdout.write(buf.join(''));

  // Record layout
  ui.lastLayout = { startRow, startCol, width, height, leftW, divider1W, middleW, divider2W, rightW, bodyH };

  // Commit button zone (diff mode only)
  if (state.rightView !== 'log' && ui.rightDiffH >= 0) {
    const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;
    ui.commitInputRow = startRow + 2 + ui.rightDiffH + 1;
    ui.commitButtonZone = {
      row: startRow + 2 + ui.rightDiffH + 2,
      colStart: rpStartCol + 1,
      colEnd: rpStartCol + 9,
    };
  } else {
    ui.commitInputRow = -1;
    ui.commitButtonZone = null;
  }

  // Clickable areas for hint bar
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

function buildLeftTabZones(startRow, startCol, contentH) {
  ui.leftTabZones = [];
  if (ui.leftTabInfo) {
    const visibleIdx = ui.leftTabInfo.lineIdx;
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
}

// ── Left panel: branch tree ──

function buildLeftPanel(w, h) {
  const lines = [];
  const innerW = w - 1;

  function pushLine(content) {
    if (visLen(content) > innerW) {
      content = truncate(content, innerW);
    }
    lines.push(content);
  }

  // Branch name + rebase state
  {
    const availW = innerW - 1;
    let branchName = state.branch || '...';
    const slashIdx = branchName.lastIndexOf('/');
    if (slashIdx >= 0) branchName = branchName.substring(slashIdx + 1);
    if (state.rebaseState) {
      const suffix = ' (rebasing ' + state.rebaseState.step + '/' + state.rebaseState.total + ')';
      branchName = truncate(branchName, Math.max(3, availW - suffix.length));
      pushLine(' ' + colors.value + ansi.bold + branchName + colors.yellow + suffix + ansi.reset);
    } else {
      branchName = truncate(branchName, availW);
      pushLine(' ' + colors.value + ansi.bold + branchName + ansi.reset);
    }
  }

  // Tab buttons
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
    pushLine(tabLine);
  }
  pushLine('');

  if (state.loading) {
    pushLine(colors.dim + ' Loading...' + ansi.reset);
    ui.fileLineMap = [];
    return lines;
  }

  if (!state.isGitRepo) {
    pushLine(colors.red + ' Not a git repository' + ansi.reset);
    ui.fileLineMap = [];
    return lines;
  }

  // Branches
  pushLine(colors.sectionHeader + ansi.bold + ' Branches' + ansi.reset);
  {
    const groups = new Map();
    const topLevel = [];
    for (const b of state.branches) {
      const slashIdx = b.name.indexOf('/');
      if (slashIdx >= 0) {
        const prefix = b.name.substring(0, slashIdx);
        const rest = b.name.substring(slashIdx + 1);
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix).push({ ...b, shortName: rest });
      } else {
        topLevel.push(b);
      }
    }
    for (const [prefix, items] of groups) {
      pushLine(colors.dim + '   ' + prefix + '/' + ansi.reset);
      for (const item of items) {
        if (item.isCurrent) {
          pushLine('    ' + colors.green + ansi.bold + '\u2713 ' + truncate(item.shortName, innerW - 6) + ansi.reset);
        } else {
          pushLine('      ' + colors.value + truncate(item.shortName, innerW - 6) + ansi.reset);
        }
      }
    }
    for (const b of topLevel) {
      if (b.isCurrent) {
        pushLine('  ' + colors.green + ansi.bold + '\u2713 ' + truncate(b.name, innerW - 4) + ansi.reset);
      } else {
        pushLine('    ' + colors.value + truncate(b.name, innerW - 4) + ansi.reset);
      }
    }
  }

  // Remotes
  if (state.remoteBranches.length > 0) {
    pushLine('');
    pushLine(colors.sectionHeader + ansi.bold + ' Remotes' + ansi.reset);
    const remoteGroups = new Map();
    for (const rb of state.remoteBranches) {
      const slashIdx = rb.indexOf('/');
      if (slashIdx >= 0) {
        const remote = rb.substring(0, slashIdx);
        const branch = rb.substring(slashIdx + 1);
        if (!remoteGroups.has(remote)) remoteGroups.set(remote, []);
        remoteGroups.get(remote).push(branch);
      } else {
        if (!remoteGroups.has('')) remoteGroups.set('', []);
        remoteGroups.get('').push(rb);
      }
    }
    for (const [remote, branches] of remoteGroups) {
      if (remote) pushLine(colors.dim + '   ' + remote + ansi.reset);
      for (const b of branches) {
        pushLine('    ' + colors.cyan + truncate(b, innerW - 4) + ansi.reset);
      }
    }
  }

  // Stashes
  if (state.stashes.length > 0) {
    pushLine('');
    pushLine(colors.sectionHeader + ansi.bold + ' Stashes' + ansi.reset);
    for (const s of state.stashes) {
      pushLine('  ' + colors.yellow + truncate(s.ref, innerW - 2) + ansi.reset);
    }
  }

  ui.fileLineMap = [];
  return lines.slice(0, h);
}

// ── Middle panel (diff mode): file list ──

function buildFileListPanel(w, h) {
  const lines = [];
  const lineToFileIdx = [];
  const innerW = w - 1;
  let cursorLineIdx = -1;
  let listIdx = 0;
  const focused = state.focusPanel === 'status';

  function pushFileLine(content, fileIdx) {
    lineToFileIdx.push(fileIdx);
    if (visLen(content) > innerW) content = truncate(content, innerW);
    lines.push(content);
  }

  pushFileLine(colors.sectionHeader + ansi.bold + ' Staged (' + state.staged.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.staged.length; i++) {
    const item = state.staged[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const line = prefix + colors.green + item.status + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  pushFileLine(colors.sectionHeader + ansi.bold + ' Unstaged (' + state.unstaged.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.unstaged.length; i++) {
    const item = state.unstaged[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const statusColor = item.status === 'D' ? colors.red : colors.orange;
    const line = prefix + statusColor + item.status + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  pushFileLine(colors.sectionHeader + ansi.bold + ' Untracked (' + state.untracked.length + ')' + ansi.reset, -1);
  for (let i = 0; i < state.untracked.length; i++) {
    const item = state.untracked[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const line = prefix + colors.dim + '?' + ansi.reset + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  if (buildFileList().length === 0) {
    pushFileLine(colors.dim + ' Working tree clean' + ansi.reset, -1);
  }

  // Scroll
  if (lines.length > h && cursorLineIdx >= 0) {
    if (cursorLineIdx < state.scrollOffset) state.scrollOffset = cursorLineIdx;
    else if (cursorLineIdx >= state.scrollOffset + h) state.scrollOffset = cursorLineIdx - h + 1;
  } else {
    state.scrollOffset = Math.min(state.scrollOffset, Math.max(0, lines.length - h));
  }

  ui.fileLineMap = lineToFileIdx.slice(state.scrollOffset, state.scrollOffset + h);
  return lines.slice(state.scrollOffset, state.scrollOffset + h);
}

// ── Right panel (diff mode): diff + commit area ──

function buildDiffCommitPanel(w, h) {
  const lines = [];
  const commitAreaH = h >= 5 ? 3 : 0;
  const diffH = h - commitAreaH;
  ui.rightDiffH = diffH;

  // Diff section
  if (diffH > 0) {
    if (state.diffLines.length === 0) {
      lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
      for (let i = 1; i < diffH; i++) lines.push('');
    } else {
      const maxScroll = Math.max(0, state.diffLines.length - diffH);
      if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
      const visible = state.diffLines.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
      for (const rawLine of visible) {
        lines.push(' ' + colorizeDiffLine(rawLine, w - 1));
      }
      if (state.diffLines.length > diffH) {
        const pct = Math.round((state.diffScrollOffset / maxScroll) * 100);
        if (lines.length > 0) {
          lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 8) + colors.dim + ` [${pct}%]` + ansi.reset;
        }
      }
      for (let i = visible.length; i < diffH; i++) lines.push('');
    }
  }

  // Commit area (3 lines)
  if (commitAreaH > 0) {
    lines.push(colors.border + '\u2500'.repeat(w) + ansi.reset);

    if (state.mode === 'commit') {
      lines.push(' ' + colors.value + truncate(state.commitMsg + '\u2588', w - 2) + ansi.reset);
    } else if (state.staged.length > 0) {
      lines.push(colors.dim + ' ' + state.staged.length + ' file(s) staged \u2014 [c] commit' + ansi.reset);
    } else {
      lines.push(colors.dim + ' No files staged' + ansi.reset);
    }

    const commitLabel = '[Commit]';
    if (state.mode === 'commit' && state.commitMsg.trim().length > 0) {
      lines.push(' ' + colors.green + ansi.bold + commitLabel + ansi.reset + colors.dim + '  Enter \u2190 submit  Esc \u2190 cancel' + ansi.reset);
    } else if (state.mode === 'commit') {
      lines.push(' ' + colors.dim + commitLabel + '  Esc \u2190 cancel' + ansi.reset);
    } else {
      lines.push(' ' + colors.dim + commitLabel + ansi.reset);
    }
  }

  return lines;
}

// ── Right panel (log mode): history + detail (top/bottom split) ──

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
  state.logScrollOffset = Math.max(0, Math.min(state.logScrollOffset, Math.max(0, state.logItems.length - listH)));

  // -- Item list --
  const visibleItems = state.logItems.slice(state.logScrollOffset, state.logScrollOffset + listH);
  const graphRows = [];
  let graphWidth = 0;
  for (let i = 0; i < listH; i++) {
    const itemIdx = state.logScrollOffset + i;
    const item = visibleItems[i];
    if (!item) { lines.push(''); graphRows.push(null); continue; }

    const isCursor = state.focusPanel === 'status' && itemIdx === selectedItemIdx;

    if (item.type === 'commit') {
      const prefix = isCursor ? (colors.cursorBg + colors.cursor + '\u25b8') : ' ';
      const graphVisLen = visLen(item.graphStr);
      const graphPart = SIXEL_ENABLED
        ? ' '.repeat(graphVisLen) + ' '
        : item.graphStr + ' ';
      const fixedLen = 1 + graphVisLen + 1 + 7 + 1;
      const available = w - fixedLen;
      const decoRawOrig = item.decoration ? item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      const isHead = decoRawOrig.includes('HEAD');
      const decoRaw = decoRawOrig.split(', ').map(r =>
        r.startsWith('HEAD -> ') ? r.substring(8) : r
      ).join(', ');
      const decoColorized = decoRaw ? colorizeDecoration(decoRaw, state.branch, isHead) : '';
      let subjStr, decoPart;
      if (available <= 0) {
        subjStr = ''; decoPart = '';
      } else if (!decoRaw) {
        subjStr = truncate(item.subject, available); decoPart = '';
      } else {
        const subjNeed = visLen(item.subject);
        const decoNeed = visLen(decoRaw) + 1;
        if (subjNeed + decoNeed <= available) {
          subjStr = item.subject; decoPart = ' ' + decoColorized;
        } else {
          const subjW = Math.min(subjNeed, available - Math.min(decoNeed, Math.max(4, available - subjNeed)));
          subjStr = truncate(item.subject, subjW);
          const decoW = available - visLen(subjStr);
          if (decoW >= 4) { decoPart = ' ' + truncate(decoColorized, decoW - 1); }
          else { subjStr = truncate(item.subject, available); decoPart = ''; }
        }
      }
      const subjPart = colors.value + subjStr + ansi.reset;
      const hashPart = (isHead ? colors.green + ansi.bold : colors.yellow) + item.ref + ansi.reset;
      const usedLen = 1 + graphVisLen + 1 + visLen(subjStr) + visLen(decoPart);
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

  // Sixel
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
    if (lines.length > 0) {
      lines[lines.length - 1] = padRight(lines[lines.length - 1], w - 8) + colors.dim + ` [${pct}%]` + ansi.reset;
    }
  }

  // -- Separator --
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // -- Detail --
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
      const cH = detailH - 1;
      const maxDetailScroll = Math.max(0, state.logDetailLines.length - cH);
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
      const visible = state.logDetailLines.slice(state.diffScrollOffset, state.diffScrollOffset + cH);
      for (const rawLine of visible) {
        lines.push(' ' + colorizeDiffLine(rawLine, w - 1));
      }
      if (state.logDetailLines.length > cH && lines.length > listH + separatorH + 1) {
        const pct = Math.round((state.diffScrollOffset / maxDetailScroll) * 100);
        const idx = listH + separatorH + 1;
        lines[idx] = padRight(lines[idx], w - 8) + colors.dim + ` [${pct}%]` + ansi.reset;
      }
    }
  }

  return lines;
}

// ── Helpers ──

function colorizeDecoration(plainDeco, currentBranch, isHead) {
  if (!plainDeco) return '';
  const refs = plainDeco.split(', ');
  const parts = [];
  for (const ref of refs) {
    if (ref === 'HEAD') {
      parts.push(colors.green + ansi.bold + 'HEAD' + ansi.reset);
    } else if (ref === currentBranch) {
      parts.push(colors.green + (isHead ? ansi.bold : '') + ref + ansi.reset);
    } else if (ref.startsWith('tag:')) {
      parts.push(colors.yellow + ref + ansi.reset);
    } else {
      parts.push(colors.cyan + ref + ansi.reset);
    }
  }
  return parts.join(colors.dim + ', ' + ansi.reset);
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
  { label: '[b]rebase',  action: 'rebase' },
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
