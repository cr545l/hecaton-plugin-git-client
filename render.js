const { CSI, ansi, colors, seriePalette } = require('./ansi');
const { SIXEL_ENABLED, SIXEL_PALETTE, SCROLLBAR_PALETTE, SCROLLBAR_HOVER_PALETTE, SCROLLBAR_ACTIVE_PALETTE, renderScrollbarPixels, renderCombinedGraphPixels, encodeSixel } = require('./sixel');
const { visLen, padRight, truncate, viewport } = require('./text');
const { state, ui } = require('./state');
const { buildFileList, selectedItem, selectedLogRef, FRESH_TIME_WINDOWS } = require('./refresh');

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
  if (state.rightView === 'log' || state.rightView === 'fresh') {
    // 2-column: left | right (history+detail top/bottom)
    middleW = 0;
    divider2W = 0;
    rightW = remaining;
  } else if (ui.middlePanelCollapsed && ui.rightPanelCollapsed) {
    middleW = 0; divider2W = 0; rightW = 0;
  } else if (ui.middlePanelCollapsed) {
    middleW = 0; divider2W = 0; rightW = remaining;
  } else if (ui.rightPanelCollapsed) {
    middleW = remaining; divider2W = 0; rightW = 0;
  } else {
    // 3-column: left | middle (files) | right (diff+commit)
    middleW = Math.max(1, Math.min(remaining - 2, Math.floor(remaining * ui.filesDividerRatio)));
    divider2W = 1;
    rightW = Math.max(1, remaining - middleW - divider2W);
  }

  const titleRows = 1;
  const bodyH = height - (titleRows + 1);  // title row + separator
  const contentH = Math.max(0, bodyH - 2);
  const hintRow = startRow + height - 1;
  const sepRow = startRow + height - 2;

  // -- Title row (rendered after body so scrollPct is available) --
  function buildTitleRows() {
    ui.titleClickZones = [];
    let zoneIdx = 0;

    const zoneStyle = (idx, collapsed) => {
      if (idx === ui.hoveredTitleZoneIndex) return colors.value + ansi.bold + CSI + '4m';
      return collapsed ? colors.dim : colors.title + ansi.bold;
    };

    // Build right-side panel buttons string first to know its width
    let rightParts = []; // { label, action, collapsed }
    rightParts.push({ label: (ui.leftPanelCollapsed ? ' + ' : ' - ') + 'Status', action: 'toggleStatus', collapsed: ui.leftPanelCollapsed });
    if (state.rightView === 'log' || state.rightView === 'fresh') {
      rightParts.push({ label: (ui.rightTopCollapsed ? '  + ' : '  - ') + (state.rightView === 'fresh' ? 'Files' : 'History'), action: 'toggleHistory', collapsed: ui.rightTopCollapsed });
      rightParts.push({ label: (ui.rightBottomCollapsed ? '  + ' : '  - ') + 'Detail', action: 'toggleDetail', collapsed: ui.rightBottomCollapsed });
    } else {
      rightParts.push({ label: (ui.middlePanelCollapsed ? '  + ' : '  - ') + 'Stage', action: 'toggleFiles', collapsed: ui.middlePanelCollapsed });
      rightParts.push({ label: (ui.rightPanelCollapsed ? '  + ' : '  - ') + 'Diff', action: 'toggleDiff', collapsed: ui.rightPanelCollapsed });
    }
    let rightTotalW = 0;
    for (const p of rightParts) rightTotalW += visLen(p.label);

    // === Left side: Local / Commits tabs ===
    let row1 = ansi.moveTo(startRow, startCol);
    let col1 = startCol;
    {
      const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;
      const isLocal = state.rightView === 'diff';
      const isCommits = state.rightView === 'log';
      const isFresh = state.rightView === 'fresh';
      const localLabel = ` Local (${totalChanges}) `;
      const commitsLabel = ' Commits ';
      const freshLabel = ' Files ';

      const localIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(localLabel) - 1, action: 'tab-local' });
      const localStyle = localIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isLocal ? colors.cursorBg + colors.cyan + ansi.bold : colors.cyan;
      row1 += localStyle + localLabel + ansi.reset;
      col1 += visLen(localLabel);

      const commitsIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(commitsLabel) - 1, action: 'tab-commits' });
      const commitsStyle = commitsIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isCommits ? colors.cursorBg + colors.cyan + ansi.bold : colors.cyan;
      row1 += commitsStyle + commitsLabel + ansi.reset;
      col1 += visLen(commitsLabel);

      const freshIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(freshLabel) - 1, action: 'tab-fresh' });
      const freshStyle = freshIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isFresh ? colors.cursorBg + colors.cyan + ansi.bold : colors.cyan;
      row1 += freshStyle + freshLabel + ansi.reset;
      col1 += visLen(freshLabel);
    }

    // === Action buttons: Fetch, Pull, Push, Stash (after separator) ===
    {
      row1 += colors.border + ' \u2502 ' + ansi.reset;
      col1 += 3;

      const pullLabel = state.behind > 0 ? 'Pull \u2193' + state.behind : 'Pull';
      const pushLabel = state.ahead > 0 ? 'Push \u2191' + state.ahead : 'Push';
      const actionBtns = [
        { label: 'Fetch', action: 'git-fetch' },
        { label: pullLabel, action: 'git-pull' },
        { label: pushLabel, action: 'git-push' },
        { label: 'Stash', action: 'git-stash' },
      ];
      for (let i = 0; i < actionBtns.length; i++) {
        const btn = actionBtns[i];
        const label = ' ' + btn.label + ' ';
        const si = zoneIdx++;
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(label) - 1, action: btn.action });
        const hasCount = (btn.action === 'git-pull' && state.behind > 0)
          || (btn.action === 'git-push' && state.ahead > 0);
        const style = si === ui.hoveredTitleZoneIndex
          ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
          : hasCount ? colors.cyan + ansi.bold : colors.dim;
        row1 += style + label + ansi.reset;
        col1 += visLen(label);
      }
    }

    // === Committer info (after Stash separator) ===
    {
      const name = state.committerName || '(no name)';
      const email = state.committerEmail || '(no email)';
      const nameIsLocal = state.committerNameIsLocal;
      const emailIsLocal = state.committerEmailIsLocal;
      row1 += colors.border + ' \u2502 ' + ansi.reset;
      col1 += 3;
      // Name zone
      const nameTag = nameIsLocal ? '[L] ' : '';
      const nameLabel = ' ' + nameTag + name + ' ';
      const ni = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(nameLabel) - 1, action: 'committer-name' });
      const nameStyle = ni === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : nameIsLocal ? colors.cyan : colors.dim;
      row1 += nameStyle + nameLabel + ansi.reset;
      col1 += visLen(nameLabel);
      // Name reset button (only if local)
      if (nameIsLocal) {
        const resetLabel = '\u00D7';
        const ri = zoneIdx++;
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(resetLabel) - 1, action: 'reset-committer-name' });
        const resetStyle = ri === ui.hoveredTitleZoneIndex
          ? colors.cursorBg + colors.red + ansi.bold
          : colors.red;
        row1 += resetStyle + resetLabel + ansi.reset;
        col1 += visLen(resetLabel);
      }
      row1 += ' ';
      col1 += 1;
      // Email zone
      const emailTag = emailIsLocal ? '[L] ' : '';
      const emailLabel = '<' + emailTag + email + '>';
      const ei = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(emailLabel) - 1, action: 'committer-email' });
      const emailStyle = ei === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : emailIsLocal ? colors.cyan : colors.dim;
      row1 += emailStyle + emailLabel + ansi.reset;
      col1 += visLen(emailLabel);
      // Email reset button (only if local)
      if (emailIsLocal) {
        const resetLabel = '\u00D7';
        const ri = zoneIdx++;
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(resetLabel) - 1, action: 'reset-committer-email' });
        const resetStyle = ri === ui.hoveredTitleZoneIndex
          ? colors.cursorBg + colors.red + ansi.bold
          : colors.red;
        row1 += resetStyle + resetLabel + ansi.reset;
        col1 += visLen(resetLabel);
      }
    }

    // === Right side: panel toggle buttons (right-aligned) ===
    const rightStartCol = startCol + width - rightTotalW;
    const gap = Math.max(0, rightStartCol - col1);
    row1 += ' '.repeat(gap);
    col1 += gap;

    for (const p of rightParts) {
      const si = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(p.label) - 1, action: p.action });
      row1 += zoneStyle(si, p.collapsed) + p.label + ansi.reset;
      col1 += visLen(p.label);
    }

    return row1;
  }

  // -- Separator line (with scroll percentages) --
  function buildSeparator() {
    let sepStr = ansi.moveTo(startRow + titleRows, startCol);

    function sectionLine(w) {
      if (w <= 0) return '';
      return colors.border + H.repeat(w) + ansi.reset;
    }

    if (leftW > 0) {
      sepStr += sectionLine(leftW);
      sepStr += colors.border + CROSS + ansi.reset;
    }

    if (state.rightView === 'log' || state.rightView === 'fresh') {
      sepStr += sectionLine(rightW);
    } else {
      if (middleW > 0 && rightW > 0) {
        sepStr += sectionLine(middleW);
        sepStr += colors.border + CROSS + ansi.reset;
        sepStr += sectionLine(rightW);
      } else if (middleW > 0) {
        sepStr += sectionLine(remaining);
      } else if (rightW > 0) {
        sepStr += sectionLine(remaining);
      } else {
        sepStr += colors.border + H.repeat(remaining) + ansi.reset;
      }
    }

    return sepStr;
  }

  // Vertical divider colors (used in body)
  const vDiv1Color = ui.hoveredDivider === 'vertical' ? colors.value : colors.border;
  const vDiv2Color = ui.hoveredDivider === 'vertical2' ? colors.value : colors.border;

  // Reset scroll pct (will be set by panel builders)
  ui.scrollPct = { status: -1, files: -1, diff: -1, history: -1, detail: -1 };

  // -- Body --
  if (state.rightView === 'fresh') {
    // 2-column body: left | right (fresh panel with top/bottom split)
    ui.fileLineMap = [];
    const rightLines = buildFreshPanel(rightW, contentH);

    if (ui.leftPanelCollapsed) {
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(ansi.moveTo(row, startCol) + padRight(rContent, width));
      }
      ui.leftTabZones = [];
      ui.leftPanelClickMap = [];
    } else {
      const leftLines = buildLeftPanel(leftW, contentH);
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
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
  } else if (state.rightView === 'log') {
    // 2-column body: left | right (log panel with top/bottom split)
    ui.fileLineMap = [];
    const rightLines = buildLogPanel(rightW, contentH);

    if (ui.leftPanelCollapsed) {
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(ansi.moveTo(row, startCol) + padRight(rContent, width));
      }
      ui.leftTabZones = [];
      ui.leftPanelClickMap = [];
    } else {
      const leftLines = buildLeftPanel(leftW, contentH);
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
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
    const middleLines = middleW > 0 ? buildFileListPanel(middleW, contentH) : [];
    const rightLines = rightW > 0 ? buildDiffCommitPanel(rightW, contentH) : [];
    if (middleW === 0) { ui.fileLineMap = []; ui.fileHeaderZones = []; }

    const hasLeft = !ui.leftPanelCollapsed && leftW > 0;
    const leftLines = hasLeft ? buildLeftPanel(leftW, contentH) : [];
    if (!hasLeft) { ui.leftTabZones = []; ui.leftPanelClickMap = []; }

    for (let i = 0; i < bodyH; i++) {
      const row = startRow + titleRows + 1 + i;
      let line = ansi.moveTo(row, startCol);
      if (hasLeft) {
        line += padRight(i < leftLines.length ? leftLines[i] : '', leftW);
        line += vDiv1Color + V + ansi.reset;
      }
      if (middleW > 0) {
        line += padRight(i < middleLines.length ? middleLines[i] : '', middleW);
      }
      if (middleW > 0 && rightW > 0) {
        line += vDiv2Color + V + ansi.reset;
      }
      if (rightW > 0) {
        line += padRight(i < rightLines.length ? rightLines[i] : '', rightW);
      }
      // Fill remaining if both middle and right collapsed
      if (middleW === 0 && rightW > 0) {
        // rightW takes full remaining — already handled
      } else if (middleW > 0 && rightW === 0) {
        // middleW takes full remaining — already handled
      } else if (middleW === 0 && rightW === 0) {
        line += ' '.repeat(remaining);
      }
      buf.push(line);
    }
  }

  // -- Title row + separator (after body so scrollPct is computed) --
  buf.push(buildTitleRows());
  buf.push(buildSeparator());

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
      + colors.dim + '[Ctrl+Enter]submit  [Esc]cancel' + ansi.reset;
  } else if (state.mode === 'new-branch') {
    hintContent = colors.yellow + ' New Branch: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create  [Esc]cancel' + ansi.reset;
  } else if (state.mode === 'new-tag') {
    hintContent = colors.yellow + ' New Tag: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create  [Esc]cancel' + ansi.reset;
  } else if (state.mode === 'rename-stash') {
    hintContent = colors.yellow + ' Rename Stash: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]rename  [Esc]cancel' + ansi.reset;
  } else if (state.mode === 'new-remote') {
    hintContent = colors.yellow + ' New Remote: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create (name url)  [Esc]cancel' + ansi.reset;
  } else if (state.freshTimeWindowMode) {
    const tw = FRESH_TIME_WINDOWS;
    let windowHint = colors.yellow + ' Time Window: ' + ansi.reset;
    for (let i = 0; i < tw.length; i++) {
      if (i === state.freshTimeWindow) {
        windowHint += colors.cursorBg + colors.cyan + ansi.bold + ' ' + tw[i].label + ' ' + ansi.reset + ' ';
      } else {
        windowHint += colors.dim + ' ' + tw[i].label + ' ' + ansi.reset + ' ';
      }
    }
    windowHint += colors.dim + '  [\u2190\u2192]select  [Enter]apply  [Esc]cancel' + ansi.reset;
    hintContent = windowHint;
  } else if (state.error) {
    hintContent = ' ' + colors.red + state.error + ansi.reset;
  } else if (state.rightView === 'fresh') {
    hintContent = ' ' + colors.dim + '[w]indow  [r]efresh  [Tab]focus' + ansi.reset;
  } else {
    hintContent = ' ' + buildHintText();
  }
  buf.push(ansi.moveTo(hintRow, startCol) + padRight(hintContent, width));

  // Append Sixel overlay (for log graph)
  if (SIXEL_ENABLED && ui.logSixelOverlay && state.rightView === 'log') {
    const graphCol = startCol + leftW + divider1W + 1;
    const screenRow = startRow + titleRows + 1;
    buf.push(ansi.moveTo(screenRow, graphCol) + ui.logSixelOverlay);
  }
  ui.logSixelOverlay = null;

  // Scrollbar overlays
  ui.scrollbarOverlays = [];
  if (SIXEL_ENABLED) {
    const sbBodyTop = startRow + titleRows + 1;
    const midStart = startCol + leftW + divider1W;

    function addScrollbar(scrollOffset, maxScroll, viewportRows, screenRow, screenCol, target) {
      if (maxScroll <= 0 || viewportRows <= 0) return;
      const pixBuf = renderScrollbarPixels(ui.cellW, ui.cellH, viewportRows, scrollOffset, maxScroll);
      if (pixBuf) {
        const isActive = ui.dragging === 'scrollbar' && ui.scrollbarDragInfo && ui.scrollbarDragInfo.target === target;
        const isHovered = ui.hoveredScrollbarTarget === target;
        const palette = isActive ? SCROLLBAR_ACTIVE_PALETTE : isHovered ? SCROLLBAR_HOVER_PALETTE : SCROLLBAR_PALETTE;
        const sixelStr = encodeSixel(pixBuf, ui.cellW, viewportRows * ui.cellH, palette);
        ui.scrollbarOverlays.push({ sixelStr, screenRow, screenCol, viewportRows, maxScroll, target });
      }
    }

    // Left panel
    if (!ui.leftPanelCollapsed && leftW > 0) {
      addScrollbar(ui.leftPanelScrollOffset, ui.leftMaxScroll, contentH, sbBodyTop, startCol + leftW - 1, 'left');
    }

    // Middle panel (files) - diff mode only
    if (state.rightView === 'diff' && middleW > 0) {
      addScrollbar(state.scrollOffset, ui.filesMaxScroll, contentH, sbBodyTop, midStart + middleW - 1, 'files');
    }

    // Right panels
    if (state.rightView === 'diff') {
      // Diff section
      if (rightW > 0) {
        addScrollbar(state.diffScrollOffset, ui.diffMaxScroll, ui.rightDiffH, sbBodyTop, startCol + width - 1, 'diff');
      }
    } else if (state.rightView === 'log') {
      // Log history list
      if (rightW > 0 && ui.lastLogListH > 0) {
        addScrollbar(state.logScrollOffset, ui.logListMaxScroll, ui.lastLogListH, sbBodyTop, startCol + width - 1, 'logList');
      }
      // Log detail
      if (rightW > 0 && ui.lastDetailContentH > 0) {
        const detailTop = sbBodyTop + ui.lastLogListH + 1 + 1; // +1 separator +1 refs line
        addScrollbar(state.diffScrollOffset, ui.logDetailMaxScroll, ui.lastDetailContentH, detailTop, startCol + width - 1, 'logDetail');
      }
    } else if (state.rightView === 'fresh') {
      // Fresh file list
      const freshFileListH = Math.max(0, ui.lastFreshListH - 1);
      if (rightW > 0 && freshFileListH > 0) {
        addScrollbar(state.freshScrollOffset, ui.freshListMaxScroll, freshFileListH, sbBodyTop + 1, startCol + width - 1, 'freshList');
      }
      // Fresh detail
      if (rightW > 0 && ui.lastFreshListH > 0) {
        const freshDetailH = contentH - ui.lastFreshListH - 1; // -1 separator
        if (freshDetailH > 1) {
          const detailTop = sbBodyTop + ui.lastFreshListH + 1 + 1; // +1 separator +1 header
          addScrollbar(state.diffScrollOffset, ui.freshDetailMaxScroll, freshDetailH - 1, detailTop, startCol + width - 1, 'freshDetail');
        }
      }
    }

    for (const sb of ui.scrollbarOverlays) {
      buf.push(ansi.moveTo(sb.screenRow, sb.screenCol) + sb.sixelStr);
    }
  }

  process.stdout.write(buf.join(''));

  // Record layout
  ui.lastLayout = { startRow, startCol, width, height, leftW, divider1W, middleW, divider2W, rightW, bodyH, titleRows };

  // Commit button zone (diff mode only)
  if (state.rightView !== 'log' && state.rightView !== 'fresh' && ui.rightDiffH >= 0) {
    const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;
    const visLines = ui.commitMsgVisibleLines || 1;
    ui.commitInputRow = startRow + titleRows + 1 + ui.rightDiffH + 1;
    ui.commitButtonZone = {
      row: startRow + titleRows + 1 + ui.rightDiffH + visLines + 1,
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

  // Position cursor at text input location for IME composition
  if (state.mode === 'commit' && state.rightView !== 'log' && ui.rightDiffH >= 0) {
    const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;
    const topLine = ui.commitTopLine || 0;
    const cursorLineIdx = ui.commitCursorLineIdx || 0;
    const cursorRow = startRow + titleRows + 1 + ui.rightDiffH + 1 + (cursorLineIdx - topLine);
    const maxW = rightW - 2;
    const cursorLineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
    const cursorLineEnd = state.commitMsg.indexOf('\n', state.commitCursor);
    const lineText = state.commitMsg.substring(cursorLineStart, cursorLineEnd === -1 ? state.commitMsg.length : cursorLineEnd);
    const colInLine = state.commitCursor - cursorLineStart;
    const beforeVis = visLen(lineText.substring(0, colInLine));
    const afterVis = visLen(lineText.substring(colInLine));
    const totalVis = beforeVis + 1 + afterVis;
    const fits = totalVis <= maxW;
    const leftEllipsis = fits ? 0 : (beforeVis > 0 ? 1 : 0);
    const rightEllipsis = fits ? 0 : (afterVis > 0 ? 1 : 0);
    const contentWidth = maxW - leftEllipsis - rightEllipsis;
    const scrollOff = fits ? 0 : Math.max(0, beforeVis + 1 - contentWidth);
    const showLeftEllipsis = scrollOff > 0;
    const cursorCol = rpStartCol + 1 + (showLeftEllipsis ? 1 : 0) + (beforeVis - scrollOff);
    process.stdout.write(ansi.moveTo(cursorRow, cursorCol));
  } else if (state.mode === 'new-branch') {
    process.stdout.write(ansi.moveTo(hintRow, startCol + 13 + visLen(state.inputBuffer)));
  } else if (state.mode === 'new-tag') {
    process.stdout.write(ansi.moveTo(hintRow, startCol + 10 + visLen(state.inputBuffer)));
  } else if (state.mode === 'rename-stash') {
    process.stdout.write(ansi.moveTo(hintRow, startCol + 16 + visLen(state.inputBuffer)));
  } else if (state.mode === 'new-remote') {
    process.stdout.write(ansi.moveTo(hintRow, startCol + 14 + visLen(state.inputBuffer)));
  }
}

// ── Left panel: branch tree ──

function buildLeftPanel(w, h) {
  const lines = [];
  const clickMap = [];
  const innerW = w - 1;

  function pushLine(content, action) {
    if (visLen(content) > innerW) {
      content = truncate(content, innerW);
    }
    lines.push(content);
    clickMap.push(action || null);
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

  pushLine('');

  if (state.loading) {
    pushLine(colors.dim + ' Loading...' + ansi.reset);
    ui.leftTabInfo = null;
    ui.leftPanelClickMap = clickMap.slice(0, h);
    return lines.slice(0, h);
  }

  if (!state.isGitRepo) {
    pushLine(colors.red + ' Not a git repository' + ansi.reset);
    ui.leftTabInfo = null;
    ui.leftPanelClickMap = clickMap.slice(0, h);
    return lines.slice(0, h);
  }

  const ARROW_OPEN = '-';
  const ARROW_CLOSED = '+';
  const activeBranch = ui.leftPanelActiveBranch;

  function branchLine(indent, name, fullRef, isCurrent) {
    const isActive = activeBranch === fullRef;
    const maxW = innerW - indent;
    if (isCurrent) {
      const content = ' '.repeat(indent) + colors.green + ansi.bold + '\u2713 ' + truncate(name, maxW - 2) + ansi.reset;
      return isActive ? colors.cursorBg + padRight(content, innerW) + ansi.reset : content;
    } else {
      const content = ' '.repeat(indent) + colors.value + truncate(name, maxW) + ansi.reset;
      return isActive ? colors.cursorBg + padRight(content, innerW) + ansi.reset : content;
    }
  }

  // Branches
  {
    const collapsed = !!ui.collapsedSections.branches;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Branches' + ansi.reset, { action: 'toggle-section', section: 'branches' });
    if (!collapsed) {
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
        const groupKey = 'b:' + prefix;
        const groupCollapsed = !!ui.collapsedGroups[groupKey];
        pushLine(colors.dim + '   ' + (groupCollapsed ? ARROW_CLOSED : ARROW_OPEN) + ' ' + prefix + '/' + ansi.reset, { action: 'toggle-group', group: groupKey });
        if (!groupCollapsed) {
          for (const item of items) {
            const fullName = prefix + '/' + item.shortName;
            pushLine(branchLine(item.isCurrent ? 4 : 6, item.shortName, fullName, item.isCurrent), { action: 'goto-branch', branch: fullName });
          }
        }
      }
      for (const b of topLevel) {
        pushLine(branchLine(b.isCurrent ? 2 : 4, b.name, b.name, b.isCurrent), { action: 'goto-branch', branch: b.name });
      }
    }
  }

  // Remotes
  if (state.remoteBranches.length > 0) {
    const collapsed = !!ui.collapsedSections.remotes;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Remotes' + ansi.reset, { action: 'toggle-section', section: 'remotes' });
    if (!collapsed) {
      const remoteGroups = new Map();
      for (const rb of state.remoteBranches) {
        const slashIdx = rb.indexOf('/');
        if (slashIdx >= 0) {
          const remote = rb.substring(0, slashIdx);
          const branch = rb.substring(slashIdx + 1);
          if (!remoteGroups.has(remote)) remoteGroups.set(remote, []);
          remoteGroups.get(remote).push(branch);
        }
      }
      let remoteEntries = Array.from(remoteGroups.entries());
      remoteEntries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [remote, branchesRaw] of remoteEntries) {
        let branches = branchesRaw.slice();
        const mode = ui.remoteSortMode || 'alpha';
        if (mode === 'alpha') {
          branches.sort((a, b) => a.localeCompare(b));
        } else if (mode === 'alpha_desc') {
          branches.sort((a, b) => b.localeCompare(a));
        } else {
          branches.sort((a, b) => {
            const fullA = remote + '/' + a;
            const fullB = remote + '/' + b;
            const ta = ui.remoteRecentBranchUsage[fullA] || 0;
            const tb = ui.remoteRecentBranchUsage[fullB] || 0;
            if (tb !== ta) return tb - ta;
            return a.localeCompare(b);
          });
        }
        const remoteKey = 'r:' + remote;
        const remoteCollapsed = !!ui.collapsedGroups[remoteKey];
        pushLine(colors.dim + '   ' + (remoteCollapsed ? ARROW_CLOSED : ARROW_OPEN) + ' ' + remote + ansi.reset, { action: 'toggle-group', group: remoteKey });
        if (!remoteCollapsed) {
          // Sub-group by prefix within this remote
          const subGroups = new Map();
          const topLevel = [];
          for (const b of branches) {
            const slashIdx = b.indexOf('/');
            if (slashIdx >= 0) {
              const prefix = b.substring(0, slashIdx);
              const rest = b.substring(slashIdx + 1);
              if (!subGroups.has(prefix)) subGroups.set(prefix, []);
              subGroups.get(prefix).push({ shortName: rest, fullRef: remote + '/' + b });
            } else {
              topLevel.push({ shortName: b, fullRef: remote + '/' + b });
            }
          }
          for (const [prefix, items] of subGroups) {
            const subKey = 'r:' + remote + '/' + prefix;
            const subCollapsed = !!ui.collapsedGroups[subKey];
            pushLine(colors.dim + '     ' + (subCollapsed ? ARROW_CLOSED : ARROW_OPEN) + ' ' + prefix + '/' + ansi.reset, { action: 'toggle-group', group: subKey });
            if (!subCollapsed) {
              for (const item of items) {
                pushLine(branchLine(8, item.shortName, item.fullRef, false), { action: 'goto-branch', branch: item.fullRef });
              }
            }
          }
          for (const item of topLevel) {
            pushLine(branchLine(6, item.shortName, item.fullRef, false), { action: 'goto-branch', branch: item.fullRef });
          }
        }
      }
    }
  }

  // Stashes
  if (state.stashes.length > 0) {
    const collapsed = !!ui.collapsedSections.stashes;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Stashes' + ansi.reset, { action: 'toggle-section', section: 'stashes' });
    if (!collapsed) {
      for (const s of state.stashes) {
        const isActive = activeBranch === 'stash:' + s.shortHash;
        const content = '  ' + colors.yellow + truncate(s.ref, innerW - 2) + ansi.reset;
        pushLine(isActive ? colors.cursorBg + padRight(content, innerW) + ansi.reset : content, { action: 'goto-stash', shortHash: s.shortHash, ref: s.ref });
      }
    }
  }

  ui.leftTabInfo = null;
  const maxScroll = Math.max(0, lines.length - h);
  ui.leftMaxScroll = maxScroll;
  if (ui.leftPanelScrollOffset > maxScroll) ui.leftPanelScrollOffset = maxScroll;
  if (maxScroll > 0) {
    ui.scrollPct.status = Math.round((ui.leftPanelScrollOffset / maxScroll) * 100);
  } else {
    ui.scrollPct.status = -1;
  }
  const off = ui.leftPanelScrollOffset;
  ui.leftPanelClickMap = clickMap.slice(off, off + h);
  const visibleLines = lines.slice(off, off + h);

  // Apply hover highlight
  const hoverRow = ui.hoveredLeftPanelRow;
  if (hoverRow >= 0 && hoverRow < visibleLines.length && ui.leftPanelClickMap[hoverRow]) {
    visibleLines[hoverRow] = CSI + '4m' + colors.value + visibleLines[hoverRow] + ansi.reset;
  }

  return visibleLines;
}

// ── Middle panel (diff mode): file list ──

function buildFileListPanel(w, h) {
  const lines = [];
  const lineToFileIdx = [];
  const innerW = w - 1;
  let cursorLineIdx = -1;
  let listIdx = 0;
  const focused = state.focusPanel === 'status';
  ui.fileHeaderZones = [];

  function pushFileLine(content, fileIdx) {
    lineToFileIdx.push(fileIdx);
    if (visLen(content) > innerW) content = truncate(content, innerW);
    lines.push(content);
  }

  // Unstaged (includes untracked)
  const unstagedCount = state.unstaged.length + state.untracked.length;
  {
    const headerLabel = ' Unstaged (' + unstagedCount + ')';
    const btnLabel = '[Stage]';
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - btnLabel.length - 1);
    const zoneIdx = ui.fileHeaderZones.length;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const btnStyle = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: headerLabelLen + gap, btnColEnd: headerLabelLen + gap + btnLabel.length - 1, action: 'stageSelected' });
    pushFileLine(headerLine, -1);
  }
  for (let i = 0; i < state.unstaged.length; i++) {
    const item = state.unstaged[i];
    const isCursor = state.cursor === listIdx;
    const isMultiSel = state.selectedFiles.has(listIdx);
    if (isCursor) cursorLineIdx = lines.length;
    const bgColor = isMultiSel ? colors.selectedBg : (isCursor && focused ? colors.cursorBg : '');
    const hasBg = bgColor !== '';
    const resetTo = hasBg ? ansi.reset + bgColor : ansi.reset;
    const prefix = isMultiSel ? bgColor + colors.value + ' \u2713 ' : '   ';
    const statusColor = item.status === 'D' ? colors.red : colors.orange;
    const line = prefix + statusColor + item.status + resetTo + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgColor + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }
  for (let i = 0; i < state.untracked.length; i++) {
    const item = state.untracked[i];
    const isCursor = state.cursor === listIdx;
    const isMultiSel = state.selectedFiles.has(listIdx);
    if (isCursor) cursorLineIdx = lines.length;
    const bgColor = isMultiSel ? colors.selectedBg : (isCursor && focused ? colors.cursorBg : '');
    const hasBg = bgColor !== '';
    const resetTo = hasBg ? ansi.reset + bgColor : ansi.reset;
    const prefix = isMultiSel ? bgColor + colors.value + ' \u2713 ' : '   ';
    const line = prefix + colors.dim + '?' + resetTo + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgColor + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  // Staged
  {
    const headerLabel = ' Staged (' + state.staged.length + ')';
    const btnLabel = '[Unstage]';
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - btnLabel.length - 1);
    const zoneIdx = ui.fileHeaderZones.length;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const btnStyle = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: headerLabelLen + gap, btnColEnd: headerLabelLen + gap + btnLabel.length - 1, action: 'unstageSelected' });
    pushFileLine(headerLine, -1);
  }
  for (let i = 0; i < state.staged.length; i++) {
    const item = state.staged[i];
    const isCursor = state.cursor === listIdx;
    const isMultiSel = state.selectedFiles.has(listIdx);
    if (isCursor) cursorLineIdx = lines.length;
    const bgColor = isMultiSel ? colors.selectedBg : (isCursor && focused ? colors.cursorBg : '');
    const hasBg = bgColor !== '';
    const resetTo = hasBg ? ansi.reset + bgColor : ansi.reset;
    const prefix = isMultiSel ? bgColor + colors.value + ' \u2713 ' : '   ';
    const line = prefix + colors.green + item.status + resetTo + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgColor + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  if (buildFileList().length === 0) {
    pushFileLine(colors.dim + ' Working tree clean' + ansi.reset, -1);
  }

  // Scroll (skip auto-scroll when scrollbar pin is active)
  const filesPinned = ui.filesScrollPin !== undefined && ui.filesScrollPin === state.cursor;
  if (ui.filesScrollPin !== undefined && ui.filesScrollPin !== state.cursor) ui.filesScrollPin = undefined;
  if (!filesPinned && lines.length > h && cursorLineIdx >= 0) {
    if (cursorLineIdx < state.scrollOffset) state.scrollOffset = cursorLineIdx;
    else if (cursorLineIdx >= state.scrollOffset + h) state.scrollOffset = cursorLineIdx - h + 1;
  } else if (!filesPinned) {
    state.scrollOffset = Math.min(state.scrollOffset, Math.max(0, lines.length - h));
  }

  const filesMaxScroll = Math.max(0, lines.length - h);
  ui.filesMaxScroll = filesMaxScroll;
  if (filesMaxScroll > 0) {
    ui.scrollPct.files = Math.round((state.scrollOffset / filesMaxScroll) * 100);
  } else {
    ui.scrollPct.files = -1;
  }
  ui.fileLineMap = lineToFileIdx.slice(state.scrollOffset, state.scrollOffset + h);
  return lines.slice(state.scrollOffset, state.scrollOffset + h);
}

// ── Right panel (diff mode): diff + commit area ──

function buildDiffCommitPanel(w, h) {
  const lines = [];
  const innerW = w - 1;

  // Calculate commit area height
  let msgLineCount = 1;
  if (state.mode === 'commit') {
    msgLineCount = state.commitMsg.split('\n').length;
  }
  const maxMsgLines = Math.max(1, Math.min(msgLineCount, Math.floor((h - 2) / 2)));
  const commitAreaH = h >= 5 ? (2 + maxMsgLines) : 0;
  const diffH = h - commitAreaH;
  ui.rightDiffH = diffH;
  ui.commitMsgVisibleLines = maxMsgLines;

  // Diff section
  if (diffH > 0) {
    if (state.diffLines.length === 0) {
      lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
      for (let i = 1; i < diffH; i++) lines.push('');
      ui.diffMaxScroll = 0;
    } else {
      const annotated = annotateDiffLineNumbers(state.diffLines);
      const numW = annotated.maxLine > 0 ? String(annotated.maxLine).length : 0;
      const gutterW = numW > 0 ? numW * 2 + 2 : 0;
      const maxScroll = Math.max(0, state.diffLines.length - diffH);
      ui.diffMaxScroll = maxScroll;
      if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
      const visible = annotated.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
      for (const entry of visible) {
        if (entry.inDiff && gutterW > 0) {
          let gutter;
          if (entry.oldNum != null || entry.newNum != null) {
            const oldStr = entry.oldNum != null ? String(entry.oldNum).padStart(numW) : ' '.repeat(numW);
            const newStr = entry.newNum != null ? String(entry.newNum).padStart(numW) : ' '.repeat(numW);
            gutter = colors.dim + oldStr + ' ' + newStr + ansi.reset + ' ';
          } else {
            gutter = ' '.repeat(gutterW);
          }
          lines.push(gutter + colorizeDiffLine(entry.text, innerW - gutterW));
        } else {
          lines.push(' ' + colorizeDiffLine(entry.text, innerW - 1));
        }
      }
      if (state.diffLines.length > diffH) {
        ui.scrollPct.diff = Math.round((state.diffScrollOffset / maxScroll) * 100);
      } else {
        ui.scrollPct.diff = -1;
      }
      for (let i = visible.length; i < diffH; i++) lines.push('');
    }
  }

  // Commit area
  if (commitAreaH > 0) {
    lines.push(colors.border + '\u2500'.repeat(w) + ansi.reset);

    if (state.mode === 'commit') {
      const msgLines = state.commitMsg.split('\n');
      const cursorLineIdx = state.commitMsg.substring(0, state.commitCursor).split('\n').length - 1;
      const cursorLineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
      const cursorCol = state.commitCursor - cursorLineStart;

      // Vertical viewport: ensure cursor line is visible
      let topLine = Math.max(0, cursorLineIdx - maxMsgLines + 1);
      topLine = Math.min(topLine, Math.max(0, msgLines.length - maxMsgLines));
      ui.commitTopLine = topLine;
      ui.commitCursorLineIdx = cursorLineIdx;

      for (let i = 0; i < maxMsgLines; i++) {
        const lineIdx = topLine + i;
        if (lineIdx < msgLines.length) {
          if (lineIdx === cursorLineIdx) {
            lines.push(' ' + colors.value + viewport(msgLines[lineIdx], cursorCol, w - 2) + ansi.reset);
          } else {
            lines.push(' ' + colors.value + truncate(msgLines[lineIdx], w - 2) + ansi.reset);
          }
        } else {
          lines.push('');
        }
      }
    } else if (state.staged.length > 0) {
      lines.push(colors.dim + ' ' + state.staged.length + ' file(s) staged \u2014 [c] commit' + ansi.reset);
    } else {
      lines.push(colors.dim + ' No files staged' + ansi.reset);
    }

    const commitLabel = '[Commit]';
    if (state.mode === 'commit' && state.commitMsg.trim().length > 0) {
      lines.push(' ' + colors.green + ansi.bold + commitLabel + ansi.reset + colors.dim + '  Ctrl+Enter \u2190 submit  Esc \u2190 cancel' + ansi.reset);
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

  const innerW = w - 1;
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
  ui.lastDetailContentH = Math.max(0, detailH - 1);

  const lines = [];

  const selectedItemIdx = state.logSelectables.length > 0
    ? state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)]
    : -1;

  const logPinned = ui.logScrollPin !== undefined && ui.logScrollPin === state.logCursor;
  if (ui.logScrollPin !== undefined && ui.logScrollPin !== state.logCursor) ui.logScrollPin = undefined;
  if (!logPinned && selectedItemIdx >= 0) {
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
      const prefix = ' ';
      const graphVisLen = visLen(item.graphStr);
      const graphPart = SIXEL_ENABLED
        ? ' '.repeat(graphVisLen) + ' '
        : item.graphStr + ' ';
      const fixedLen = 1 + graphVisLen + 1 + 7 + 1;
      const available = innerW - fixedLen;
      const decoRawOrig = item.decoration ? item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      const isHead = decoRawOrig.includes('HEAD');
      const decoRaw = decoRawOrig.split(', ').map(r =>
        r.startsWith('HEAD -> ') ? r.substring(8) : r
      ).join(', ');
      const decoColorized = decoRaw ? colorizeDecoration(decoRaw, state.branch, isHead) : '';
      const safeSubject = (item.subject || '').replace(/[\r\n]/g, '');
      let subjStr, decoPart;
      if (available <= 0) {
        subjStr = ''; decoPart = '';
      } else if (!decoRaw) {
        subjStr = truncate(safeSubject, available); decoPart = '';
      } else {
        const subjNeed = visLen(safeSubject);
        const decoNeed = visLen(decoRaw) + 1;
        if (subjNeed + decoNeed <= available) {
          subjStr = safeSubject; decoPart = ' ' + decoColorized;
        } else {
          const subjW = Math.min(subjNeed, available - Math.min(decoNeed, Math.max(4, available - subjNeed)));
          subjStr = truncate(safeSubject, subjW);
          const decoW = available - visLen(subjStr);
          if (decoW >= 4) { decoPart = ' ' + truncate(decoColorized, decoW - 1); }
          else { subjStr = truncate(safeSubject, available); decoPart = ''; }
        }
      }
      const resetTo = isCursor ? ansi.reset + colors.cursorBg : ansi.reset;
      const subjPart = colors.value + subjStr + resetTo;
      const hashPart = (isHead ? colors.green + ansi.bold : colors.yellow) + item.ref + resetTo;
      const usedLen = 1 + graphVisLen + 1 + visLen(subjStr) + visLen(decoPart);
      const pad = Math.max(1, innerW - usedLen - 7);
      const decoPartFixed = isCursor ? decoPart.replace(/\x1b\[0m/g, resetTo) : decoPart;
      const line = prefix + graphPart + subjPart + decoPartFixed + ' '.repeat(pad) + hashPart;
      lines.push((isCursor ? colors.cursorBg : '') + padRight(line, innerW) + ansi.reset);
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
    const prevItem = state.logScrollOffset > 0 ? state.logItems[state.logScrollOffset - 1] : null;
    const nextItem = state.logScrollOffset + listH < state.logItems.length ? state.logItems[state.logScrollOffset + listH] : null;
    const prevBoundary = prevItem && prevItem.chars ? { chars: prevItem.chars } : null;
    const nextBoundary = nextItem && nextItem.chars ? { chars: nextItem.chars } : null;
    const pixBuf = renderCombinedGraphPixels(graphRows, graphWidth, ui.cellW, ui.cellH, prevBoundary, nextBoundary);
    if (pixBuf) {
      ui.logSixelOverlay = encodeSixel(pixBuf, graphWidth * ui.cellW, graphRows.length * ui.cellH, SIXEL_PALETTE);
    }
  }

  // Scroll pct for title
  if (listH > 0 && state.logItems.length > listH) {
    const maxScroll = Math.max(1, state.logItems.length - listH);
    ui.logListMaxScroll = maxScroll;
    ui.scrollPct.history = Math.round((state.logScrollOffset / maxScroll) * 100);
  } else {
    ui.logListMaxScroll = 0;
    ui.scrollPct.history = -1;
  }

  // Build filtered detail lines (respecting collapsed files)
  const filteredDetail = filterLogDetailLines(state.logDetailLines, ui.collapsedDetailFiles);
  ui.filteredDetailCount = filteredDetail.length;

  // Pre-calculate detail scroll pct for separator
  if (detailH > 1 && filteredDetail.length > 0) {
    const cH = detailH - 1;
    const maxDetailScroll = Math.max(0, filteredDetail.length - cH);
    ui.logDetailMaxScroll = maxDetailScroll;
    if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
    if (filteredDetail.length > cH) {
      ui.scrollPct.detail = Math.round((state.diffScrollOffset / Math.max(1, maxDetailScroll)) * 100);
    }
  } else {
    ui.logDetailMaxScroll = 0;
  }

  // -- Separator --
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // -- Detail --
  ui.detailFileHeaderMap = [];
  if (detailH > 0) {
    const selItem = selectedLogRef();
    if (state.logDetailLines.length === 0) {
      lines.push(colors.dim + ' Select an item to view details' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
    } else {
      const refsRaw = selItem && selItem.decoration ? selItem.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      if (refsRaw) {
        lines.push(colors.cyan + ' \u2387 ' + truncate(refsRaw, innerW - 4) + ansi.reset);
      } else {
        lines.push(colors.dim + ' (no refs)' + ansi.reset);
      }
      let cH = detailH - 1;
      const maxDetailScroll = Math.max(0, filteredDetail.length - cH);
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;

      // Sticky file header: pin file name when scrolled past it
      let stickyFile = null;
      if (state.diffScrollOffset > 0 && filteredDetail[state.diffScrollOffset] && !filteredDetail[state.diffScrollOffset].isFileHeader) {
        for (let i = state.diffScrollOffset - 1; i >= 0; i--) {
          if (filteredDetail[i].isFileHeader) { stickyFile = filteredDetail[i].file; break; }
          if (!filteredDetail[i].inDiff) break;
        }
      }
      if (stickyFile) {
        const collapsed = ui.collapsedDetailFiles.has(stickyFile);
        const arrow = collapsed ? '+' : '-';
        const label = ' ' + arrow + ' ' + stickyFile;
        lines.push(ansi.bg(153, 121, 0) + ansi.fg(255, 255, 255) + padRight(truncate(label, innerW), innerW) + ansi.reset);
        ui.detailFileHeaderMap.push(stickyFile);
        cH--;
      }

      const visible = filteredDetail.slice(state.diffScrollOffset, state.diffScrollOffset + cH);
      const numW = filteredDetail.maxLine > 0 ? String(filteredDetail.maxLine).length : 0;
      const gutterW = numW > 0 ? numW * 2 + 2 : 0;
      for (let vi = 0; vi < visible.length; vi++) {
        const entry = visible[vi];
        if (entry.isFileHeader) {
          const collapsed = ui.collapsedDetailFiles.has(entry.file);
          const arrow = collapsed ? '+' : '-';
          const label = ' ' + arrow + ' ' + entry.file;
          lines.push(ansi.bg(153, 121, 0) + ansi.fg(255, 255, 255) + padRight(truncate(label, innerW), innerW) + ansi.reset);
          ui.detailFileHeaderMap.push(entry.file);
        } else if (/^\u2500{3,}$/.test(entry.text)) {
          lines.push(colorizeDiffLine(entry.text, innerW));
          ui.detailFileHeaderMap.push(null);
        } else if (entry.inDiff && gutterW > 0) {
          let gutter;
          if (entry.oldNum != null || entry.newNum != null) {
            const oldStr = entry.oldNum != null ? String(entry.oldNum).padStart(numW) : ' '.repeat(numW);
            const newStr = entry.newNum != null ? String(entry.newNum).padStart(numW) : ' '.repeat(numW);
            gutter = colors.dim + oldStr + ' ' + newStr + ansi.reset + ' ';
          } else {
            gutter = ' '.repeat(gutterW);
          }
          lines.push(gutter + colorizeDiffLine(entry.text, innerW - gutterW));
          ui.detailFileHeaderMap.push(null);
        } else {
          lines.push(' ' + colorizeDiffLine(entry.text, innerW - 1));
          ui.detailFileHeaderMap.push(null);
        }
      }
    }
  }

  return lines;
}

// ── Right panel (fresh mode): file list + detail (top/bottom split) ──

function heatmapColor(date, windowDays) {
  const now = Date.now();
  const fileTime = new Date(date).getTime();
  const ageMs = now - fileTime;
  const windowMs = (windowDays || 7) * 24 * 60 * 60 * 1000;
  const fraction = Math.min(1, Math.max(0, ageMs / windowMs));
  const t = Math.pow(fraction, 0.6);

  // 5 stops: #00E5FF → #00C8C8 → #0096C8 → #646464 → #3C3C3C
  const stops = [
    [0, 229, 255],
    [0, 200, 200],
    [0, 150, 200],
    [100, 100, 100],
    [60, 60, 60],
  ];
  const pos = t * (stops.length - 1);
  const idx = Math.min(Math.floor(pos), stops.length - 2);
  const f = pos - idx;
  const r = Math.round(stops[idx][0] + (stops[idx + 1][0] - stops[idx][0]) * f);
  const g = Math.round(stops[idx][1] + (stops[idx + 1][1] - stops[idx][1]) * f);
  const b = Math.round(stops[idx][2] + (stops[idx + 1][2] - stops[idx][2]) * f);
  return ansi.fg(r, g, b);
}

function relativeDate(date) {
  const now = Date.now();
  const d = new Date(date).getTime();
  const diffSec = Math.floor((now - d) / 1000);
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h';
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return days + 'd';
  return Math.floor(days / 7) + 'w';
}

function freshStatusIcon(status) {
  switch (status) {
    case 'M': return colors.yellow + 'M' + ansi.reset;
    case 'A': return colors.green + 'A' + ansi.reset;
    case 'D': return colors.red + 'D' + ansi.reset;
    case 'R': return colors.cyan + 'R' + ansi.reset;
    case '?': return colors.dim + '?' + ansi.reset;
    default:  return colors.dim + status + ansi.reset;
  }
}

function buildFreshPanel(w, h) {
  if (state.freshItems.length === 0) {
    return [colors.dim + ' No fresh files' + ansi.reset];
  }

  const innerW = w - 1;
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
  ui.lastFreshListH = listH;

  const lines = [];
  const lineToFileIdx = [];
  const tw = FRESH_TIME_WINDOWS[state.freshTimeWindow] || FRESH_TIME_WINDOWS[1];

  // -- Header line (time window indicator, clickable) --
  ui.freshWindowZone = null;
  if (listH > 0) {
    const btnLabel = ' ' + tw.label + ' ';
    const btnLen = visLen(btnLabel);
    const suffix = '  ' + colors.dim + state.freshItems.length + ' file(s)' + ansi.reset;
    const isHovered = ui.hoveredFreshWindow;
    const btnStyle = isHovered ? colors.cursorBg + colors.cyan + ansi.bold + CSI + '4m' : colors.cyan;
    const headerLabel = btnStyle + btnLabel + ansi.reset + suffix;
    lines.push(truncate(headerLabel, innerW));
    lineToFileIdx.push(-1);
    // Record click zone (relative col within right panel, will be resolved in input.js)
    ui.freshWindowZone = { lineIdx: 0, colStart: 0, colEnd: btnLen - 1 };
  }

  // -- File list --
  const fileListH = Math.max(0, listH - 1);
  const selectedItemIdx = Math.min(state.freshCursor, state.freshItems.length - 1);

  // Auto-scroll (skip when scrollbar pin is active)
  const freshPinned = ui.freshScrollPin !== undefined && ui.freshScrollPin === state.freshCursor;
  if (ui.freshScrollPin !== undefined && ui.freshScrollPin !== state.freshCursor) ui.freshScrollPin = undefined;
  if (!freshPinned && selectedItemIdx >= 0) {
    if (selectedItemIdx < state.freshScrollOffset) {
      state.freshScrollOffset = selectedItemIdx;
    } else if (selectedItemIdx >= state.freshScrollOffset + fileListH) {
      state.freshScrollOffset = selectedItemIdx - fileListH + 1;
    }
  }
  state.freshScrollOffset = Math.max(0, Math.min(state.freshScrollOffset, Math.max(0, state.freshItems.length - fileListH)));

  const visibleItems = state.freshItems.slice(state.freshScrollOffset, state.freshScrollOffset + fileListH);
  for (let i = 0; i < fileListH; i++) {
    const itemIdx = state.freshScrollOffset + i;
    const item = visibleItems[i];
    if (!item) { lines.push(''); lineToFileIdx.push(-1); continue; }

    const isCursor = state.focusPanel === 'status' && itemIdx === selectedItemIdx;
    const prefix = '   ';
    const resetTo = isCursor ? ansi.reset + colors.cursorBg : ansi.reset;

    const statusIcon = freshStatusIcon(item.status);
    const fileColor = heatmapColor(item.date, tw.days || 7);
    const fileName = truncate(item.file, Math.max(10, innerW - 25));
    const relTime = relativeDate(item.date);
    const authorPart = item.author ? truncate(item.author, 12) : (item.isPending ? 'pending' : '');

    const line = prefix + statusIcon + resetTo + ' ' + fileColor + fileName + resetTo
      + '  ' + colors.dim + padRight(relTime, 4) + resetTo
      + ' ' + colors.dim + authorPart + resetTo;

    lines.push((isCursor ? colors.cursorBg : '') + padRight(line, innerW) + ansi.reset);
    lineToFileIdx.push(itemIdx);
  }

  // Scroll pct
  if (fileListH > 0 && state.freshItems.length > fileListH) {
    const maxScroll = Math.max(1, state.freshItems.length - fileListH);
    ui.freshListMaxScroll = maxScroll;
    ui.scrollPct.history = Math.round((state.freshScrollOffset / maxScroll) * 100);
  } else {
    ui.freshListMaxScroll = 0;
    ui.scrollPct.history = -1;
  }

  // Pre-calculate detail scroll pct
  if (detailH > 1 && state.freshDetailLines.length > 0) {
    const cH = detailH - 1;
    const maxDetailScroll = Math.max(0, state.freshDetailLines.length - cH);
    ui.freshDetailMaxScroll = maxDetailScroll;
    if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
    if (state.freshDetailLines.length > cH) {
      ui.scrollPct.detail = Math.round((state.diffScrollOffset / Math.max(1, maxDetailScroll)) * 100);
    }
  } else {
    ui.freshDetailMaxScroll = 0;
  }

  // -- Separator --
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // -- Detail (diff) --
  if (detailH > 0) {
    const selItem = state.freshItems[state.freshCursor];
    if (state.freshDetailLines.length === 0) {
      lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
    } else {
      // Header: file info
      if (selItem) {
        const info = selItem.isPending
          ? colors.cyan + ' \u25c6 ' + truncate(selItem.file, innerW - 4) + ' (pending)' + ansi.reset
          : colors.cyan + ' \u25c6 ' + truncate(selItem.file, innerW - 20) + ' ' + colors.dim + selItem.commitHash + ansi.reset;
        lines.push(truncate(info, innerW));
      } else {
        lines.push('');
      }
      const cH = detailH - 1;
      const maxDetailScroll = Math.max(0, state.freshDetailLines.length - cH);
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
      const visible = state.freshDetailLines.slice(state.diffScrollOffset, state.diffScrollOffset + cH);
      for (const rawLine of visible) {
        lines.push(' ' + colorizeDiffLine(rawLine, innerW - 1));
      }
    }
  }

  ui.freshFileLineMap = lineToFileIdx.slice(0, listH);
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

function annotateDiffLineNumbers(lines) {
  const result = [];
  let oldLine = 0, newLine = 0, maxLine = 0, inDiff = false;
  for (const line of lines) {
    if (line.match(/^diff --git /)) { inDiff = true; result.push({ text: line, inDiff: false }); continue; }
    if (!inDiff) { result.push({ text: line, inDiff: false }); continue; }
    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hm) { oldLine = parseInt(hm[1]); newLine = parseInt(hm[2]); result.push({ text: line, inDiff: true, oldNum: null, newNum: null }); continue; }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename') ||
        line.startsWith('Binary')) { result.push({ text: line, inDiff: true, oldNum: null, newNum: null }); continue; }
    if (line.startsWith('+')) { maxLine = Math.max(maxLine, newLine); result.push({ text: line, inDiff: true, oldNum: null, newNum: newLine }); newLine++; }
    else if (line.startsWith('-')) { maxLine = Math.max(maxLine, oldLine); result.push({ text: line, inDiff: true, oldNum: oldLine, newNum: null }); oldLine++; }
    else { maxLine = Math.max(maxLine, oldLine, newLine); result.push({ text: line, inDiff: true, oldNum: oldLine, newNum: newLine }); oldLine++; newLine++; }
  }
  result.maxLine = maxLine;
  return result;
}

function filterLogDetailLines(lines, collapsedFiles) {
  const result = [];
  let currentFile = null;
  let isCollapsed = false;
  let inDiff = false;
  let oldLine = 0, newLine = 0;
  let maxLine = 0;
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/.+ b\/(.+)/);
    if (diffMatch) {
      currentFile = diffMatch[1];
      isCollapsed = collapsedFiles.has(currentFile);
      inDiff = true;
      result.push({ isFileHeader: true, file: currentFile, text: line });
      continue;
    }
    if (isCollapsed) continue;
    if (!inDiff) {
      result.push({ isFileHeader: false, text: line, inDiff: false });
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]);
      newLine = parseInt(hunkMatch[2]);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename') ||
        line.startsWith('Binary')) {
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith('+')) {
      maxLine = Math.max(maxLine, newLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      maxLine = Math.max(maxLine, oldLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: oldLine, newNum: null });
      oldLine++;
    } else {
      maxLine = Math.max(maxLine, oldLine, newLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: oldLine, newNum: newLine });
      oldLine++;
      newLine++;
    }
  }
  result.maxLine = maxLine;
  return result;
}

function colorizeDiffLine(rawLine, w) {
  rawLine = rawLine.replace(/[\r\n]/g, '');
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
  } else if (rawLine.startsWith('Author: ') || rawLine.startsWith('Commit: ')) {
    return colors.cyan + truncate(rawLine, w) + ansi.reset;
  } else if (/^\u2500{3,}$/.test(rawLine)) {
    return colors.border + '\u2500'.repeat(w) + ansi.reset;
  }
  return colors.label + truncate(rawLine, w) + ansi.reset;
}

const hintButtons = [];

function buildHintText() {
  let result = '';
  if (state.selectedFiles.size > 0) {
    result += colors.cyan + state.selectedFiles.size + ' selected' + ansi.reset + '  ';
    result += colors.dim + '[s]tage  [u]nstage' + ansi.reset + '  ';
  }
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
