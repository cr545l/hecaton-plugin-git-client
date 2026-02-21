const { CSI, ansi, colors, seriePalette } = require('./ansi');
const { SIXEL_ENABLED, CELL_W, CELL_H, SIXEL_PALETTE, renderCombinedGraphPixels, encodeSixel } = require('./sixel');
const { visLen, padRight, truncate, viewport } = require('./text');
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

    function pctSuffix(pct) {
      if (pct < 0) return '';
      return colors.dim + ' ' + pct + '%' + ansi.reset;
    }

    // Build right-side panel buttons string first to know its width
    let rightParts = []; // { label, action, collapsed, pctStr }
    rightParts.push({ label: (ui.leftPanelCollapsed ? ' + ' : ' - ') + 'Status', action: 'toggleStatus', collapsed: ui.leftPanelCollapsed, pctStr: pctSuffix(ui.scrollPct.status) });
    if (state.rightView === 'log') {
      rightParts.push({ label: (ui.rightTopCollapsed ? '  + ' : '  - ') + 'History', action: 'toggleHistory', collapsed: ui.rightTopCollapsed, pctStr: pctSuffix(ui.scrollPct.history) });
      rightParts.push({ label: (ui.rightBottomCollapsed ? '  + ' : '  - ') + 'Detail', action: 'toggleDetail', collapsed: ui.rightBottomCollapsed, pctStr: pctSuffix(ui.scrollPct.detail) });
    } else {
      rightParts.push({ label: (ui.middlePanelCollapsed ? '  + ' : '  - ') + 'Files', action: 'toggleFiles', collapsed: ui.middlePanelCollapsed, pctStr: pctSuffix(ui.scrollPct.files) });
      rightParts.push({ label: (ui.rightPanelCollapsed ? '  + ' : '  - ') + 'Diff', action: 'toggleDiff', collapsed: ui.rightPanelCollapsed, pctStr: pctSuffix(ui.scrollPct.diff) });
    }
    let rightTotalW = 0;
    for (const p of rightParts) rightTotalW += visLen(p.label) + visLen(p.pctStr);

    // === Left side: Local / Commits tabs ===
    let row1 = ansi.moveTo(startRow, startCol);
    let col1 = startCol;
    {
      const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;
      const isLocal = state.rightView !== 'log';
      const isCommits = state.rightView === 'log';
      const localLabel = ` Local (${totalChanges}) `;
      const commitsLabel = ' Commits ';

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
    }

    // === Action buttons: Fetch, Pull, Push, Stash (after separator) ===
    {
      row1 += colors.border + ' \u2502 ' + ansi.reset;
      col1 += 3;

      const actionBtns = [
        { label: 'Fetch', action: 'git-fetch' },
        { label: 'Pull', action: 'git-pull' },
        { label: 'Push', action: 'git-push' },
        { label: 'Stash', action: 'git-stash' },
      ];
      for (let i = 0; i < actionBtns.length; i++) {
        const btn = actionBtns[i];
        const label = ' ' + btn.label + ' ';
        const si = zoneIdx++;
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(label) - 1, action: btn.action });
        const style = si === ui.hoveredTitleZoneIndex
          ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
          : colors.dim;
        row1 += style + label + ansi.reset;
        col1 += visLen(label);
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
      row1 += p.pctStr;
      col1 += visLen(p.pctStr);
    }

    return row1;
  }

  // -- Separator line --
  function buildSeparator() {
    let sepStr = ansi.moveTo(startRow + titleRows, startCol);
    sepStr += colors.border + H.repeat(width) + ansi.reset;
    return sepStr;
  }

  // Vertical divider colors (used in body)
  const vDiv1Color = ui.hoveredDivider === 'vertical' ? colors.value : colors.border;
  const vDiv2Color = ui.hoveredDivider === 'vertical2' ? colors.value : colors.border;

  // Reset scroll pct (will be set by panel builders)
  ui.scrollPct = { status: -1, files: -1, diff: -1, history: -1, detail: -1 };

  // -- Body --
  if (state.rightView === 'log') {
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
  } else if (state.error && state.errorLines.length === 0) {
    hintContent = ' ' + colors.red + state.error + ansi.reset;
  } else if (state.errorLines.length > 0) {
    hintContent = ' ' + colors.red + '[Error] click [X] or outside to close' + ansi.reset;
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

  // -- Error overlay --
  if (state.errorLines.length > 0) {
    const overlayW = Math.min(width - 4, 72);
    const maxVisibleLines = Math.min(height - 6, 16);
    const totalLines = state.errorLines.length;
    const maxScroll = Math.max(0, totalLines - maxVisibleLines);
    state.errorScrollOffset = Math.min(state.errorScrollOffset, maxScroll);
    const scrollOff = state.errorScrollOffset;

    const contentH = Math.min(totalLines, maxVisibleLines);
    const overlayH = contentH + 2; // top + bottom border
    const overlayX = startCol + Math.floor((width - overlayW) / 2);
    const overlayY = startRow + Math.max(1, Math.floor((height - overlayH) / 2));

    // 마우스 처리를 위한 오버레이 위치 저장
    ui.errorOverlay = { x: overlayX, y: overlayY, w: overlayW, h: overlayH, contentH };

    const TOP_L = '\u250c', TOP_R = '\u2510', BOT_L = '\u2514', BOT_R = '\u2518';
    const HORIZ = '\u2500', VERT = '\u2502';

    // Top border with [X] close button
    const title = ' Error ';
    const closeBtn = '[X]';
    const topPad = Math.max(0, overlayW - 2 - title.length - closeBtn.length - 1);
    buf.push(ansi.moveTo(overlayY, overlayX) + colors.red
      + TOP_L + HORIZ + title + HORIZ.repeat(topPad) + closeBtn + HORIZ + TOP_R + ansi.reset);

    // Content lines
    const visibleLines = state.errorLines.slice(scrollOff, scrollOff + contentH);
    for (let i = 0; i < contentH; i++) {
      const row = overlayY + 1 + i;
      const line = (visibleLines[i] || '').replace(/\t/g, '  ');
      const content = truncate(' ' + line, overlayW - 3);
      buf.push(ansi.moveTo(row, overlayX)
        + colors.red + VERT + ansi.reset
        + padRight(content, overlayW - 2)
        + colors.red + VERT + ansi.reset);
    }

    // Bottom border with scroll info
    const scrollInfo = totalLines > maxVisibleLines
      ? ` ${scrollOff + 1}-${scrollOff + contentH}/${totalLines} `
      : '';
    const botPad = Math.max(0, overlayW - 2 - scrollInfo.length);
    buf.push(ansi.moveTo(overlayY + contentH + 1, overlayX) + colors.red
      + BOT_L + HORIZ.repeat(botPad) + scrollInfo + HORIZ + BOT_R + ansi.reset);
  } else {
    ui.errorOverlay = null;
  }

  process.stdout.write(buf.join(''));

  // Record layout
  ui.lastLayout = { startRow, startCol, width, height, leftW, divider1W, middleW, divider2W, rightW, bodyH, titleRows };

  // Commit button zone (diff mode only)
  if (state.rightView !== 'log' && ui.rightDiffH >= 0) {
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

  const ARROW_OPEN = '\u25be';
  const ARROW_CLOSED = '\u25b8';
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
      for (const [remote, branches] of remoteGroups) {
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
        pushLine(isActive ? colors.cursorBg + padRight(content, innerW) + ansi.reset : content, { action: 'goto-stash', shortHash: s.shortHash });
      }
    }
  }

  ui.leftTabInfo = null;
  const maxScroll = Math.max(0, lines.length - h);
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
    const btnLabel = 'Stage All';
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - btnLabel.length - 1);
    const zoneIdx = ui.fileHeaderZones.length;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const btnStyle = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: headerLabelLen + gap, btnColEnd: headerLabelLen + gap + btnLabel.length - 1, action: 'stageAll' });
    pushFileLine(headerLine, -1);
  }
  for (let i = 0; i < state.unstaged.length; i++) {
    const item = state.unstaged[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const hasBg = isSelected && focused;
    const resetTo = hasBg ? ansi.reset + colors.cursorBg : ansi.reset;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const statusColor = item.status === 'D' ? colors.red : colors.orange;
    const line = prefix + statusColor + item.status + resetTo + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }
  for (let i = 0; i < state.untracked.length; i++) {
    const item = state.untracked[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const hasBg = isSelected && focused;
    const resetTo = hasBg ? ansi.reset + colors.cursorBg : ansi.reset;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const line = prefix + colors.dim + '?' + resetTo + ' ' + truncate(item.file, innerW - 6);
    pushFileLine(bgStyle + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  // Staged
  {
    const headerLabel = ' Staged (' + state.staged.length + ')';
    const btnLabel = 'Unstage All';
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - btnLabel.length - 1);
    const zoneIdx = ui.fileHeaderZones.length;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const btnStyle = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: headerLabelLen + gap, btnColEnd: headerLabelLen + gap + btnLabel.length - 1, action: 'unstageAll' });
    pushFileLine(headerLine, -1);
  }
  for (let i = 0; i < state.staged.length; i++) {
    const item = state.staged[i];
    const isSelected = state.cursor === listIdx;
    if (isSelected) cursorLineIdx = lines.length;
    const hasBg = isSelected && focused;
    const resetTo = hasBg ? ansi.reset + colors.cursorBg : ansi.reset;
    const prefix = isSelected ? (focused ? colors.cursorBg + colors.cursor + ' \u25b8 ' : colors.dim + ' \u25b8 ') : '   ';
    const bgStyle = isSelected ? (focused ? colors.cursorBg : '') : '';
    const line = prefix + colors.green + item.status + resetTo + ' ' + truncate(item.file, innerW - 6);
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

  const filesMaxScroll = Math.max(0, lines.length - h);
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
    } else {
      const maxScroll = Math.max(0, state.diffLines.length - diffH);
      if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
      const visible = state.diffLines.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
      for (const rawLine of visible) {
        lines.push(' ' + colorizeDiffLine(rawLine, w - 1));
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
      const resetTo = isCursor ? ansi.reset + colors.cursorBg : ansi.reset;
      const subjPart = colors.value + subjStr + resetTo;
      const hashPart = (isHead ? colors.green + ansi.bold : colors.yellow) + item.ref + resetTo;
      const usedLen = 1 + graphVisLen + 1 + visLen(subjStr) + visLen(decoPart);
      const pad = Math.max(1, w - usedLen - 7);
      const decoPartFixed = isCursor ? decoPart.replace(/\x1b\[0m/g, resetTo) : decoPart;
      const line = prefix + graphPart + subjPart + decoPartFixed + ' '.repeat(pad) + hashPart;
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

  // Scroll pct for title
  if (listH > 0 && state.logItems.length > listH) {
    const maxScroll = Math.max(1, state.logItems.length - listH);
    ui.scrollPct.history = Math.round((state.logScrollOffset / maxScroll) * 100);
  } else {
    ui.scrollPct.history = -1;
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
      if (state.logDetailLines.length > cH) {
        ui.scrollPct.detail = Math.round((state.diffScrollOffset / Math.max(1, maxDetailScroll)) * 100);
      } else {
        ui.scrollPct.detail = -1;
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

const hintButtons = [];

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
