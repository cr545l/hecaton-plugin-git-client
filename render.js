const { CSI, ansi, colors, seriePalette } = require('./ansi');
const { SIXEL_ENABLED, SIXEL_PALETTE, SCROLLBAR_PALETTE, SCROLLBAR_HOVER_PALETTE, SCROLLBAR_ACTIVE_PALETTE, renderScrollbarPixels, renderHScrollbarPixels, renderCombinedGraphPixels, encodeSixel } = require('./sixel');
const { visLen, padRight, truncate, viewport, sliceByWidth, stripAnsi } = require('./text');
const { state, ui } = require('./state');
const { buildFileList, selectedItem, selectedLogRef, FRESH_TIME_WINDOWS } = require('./refresh');
const { highlightCode, getLanguage } = require('./highlighter');
const { BRAILLE_FRAMES, isSpinning } = require('./spinner');
const RECOVERY_TEXT = ansi.dim + ansi.fg(160, 160, 160);
const STASH_TEXT = CSI + '38;5;249m'; // ANSI 256 palette #249 (~#b2b2b2)

// Layout 전환 감지 — sixel은 텍스트 redraw로 지워지지 않아 잔상이 남는다.
// rightView/minimize/패널 collapse/터미널 크기 변화 시점에 한 번 화면을 erase해서
// 이전 sixel(그래프, 스크롤바)을 강제로 제거한다. 일반 redraw는 그대로 둬 깜빡임을 피한다.
let _lastLayoutSig = '';
function computeLayoutSig() {
  return [
    state.minimized ? 'mini' : 'norm',
    state.rightView || 'diff',
    ui.leftPanelCollapsed ? '1' : '0',
    ui.middlePanelCollapsed ? '1' : '0',
    ui.rightPanelCollapsed ? '1' : '0',
    ui.rightTopCollapsed ? '1' : '0',
    ui.rightBottomCollapsed ? '1' : '0',
    ui.termCols,
    ui.termRows,
  ].join('|');
}

function render() {
  if (state.minimized) {
    renderMinimized();
    _lastLayoutSig = computeLayoutSig();
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

  // Layout 전환 시 화면 강제 erase — sixel 잔상 제거
  const layoutSig = computeLayoutSig();
  if (layoutSig !== _lastLayoutSig) {
    buf.push(CSI + '2J');
    _lastLayoutSig = layoutSig;
  }

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
      const localLabel = state.loading ? ' Local ... ' : ` Local *${totalChanges} `;
      const commitsLabel = ' Commits ';
      const freshLabel = ' Files ';

      const localIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(localLabel) - 1, action: 'tab-local' });
      const localHighlight = !state.loading && totalChanges > 0;
      const localColor = localHighlight ? colors.orange + ansi.bold : colors.cyan;
      const localStyle = localIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isLocal ? localColor + ansi.inverse : localColor;
      row1 += localStyle + localLabel + ansi.reset;
      col1 += visLen(localLabel);

      const commitsIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(commitsLabel) - 1, action: 'tab-commits' });
      const commitsStyle = commitsIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isCommits ? colors.cyan + ansi.bold + ansi.inverse : colors.cyan;
      row1 += commitsStyle + commitsLabel + ansi.reset;
      col1 += visLen(commitsLabel);

      const freshIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(freshLabel) - 1, action: 'tab-fresh' });
      const freshStyle = freshIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isFresh ? colors.cyan + ansi.bold + ansi.inverse : colors.cyan;
      row1 += freshStyle + freshLabel + ansi.reset;
      col1 += visLen(freshLabel);
    }

    // === Action buttons or Rebase progress bar ===
    {
      row1 += colors.border + ' \u2502 ' + ansi.reset;
      col1 += 3;

      const op = state.operationState;
      const isRebaseOp = op && (op.type === 'rebase-merge' || op.type === 'rebase-apply');
      if (isRebaseOp) {
        // Rebase progress bar (Fork-style)
        const branch = state.branch || 'HEAD';
        const rebasedStep = Math.max(0, (op.step || 1) - 1);
        const totalSteps = op.total || '?';
        const rebaseBranch = op.headName || branch;
        const progressLabel = " Rebasing '" + rebaseBranch + "' (rebased " + rebasedStep + '/' + totalSteps + ' commits) ';
        row1 += colors.yellow + ansi.bold + progressLabel + ansi.reset;
        col1 += visLen(progressLabel);

        // Abort button
        const abortLabel = ' Abort ';
        const abortIdx = zoneIdx++;
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(abortLabel) - 1, action: 'rebase-abort' });
        const abortStyle = abortIdx === ui.hoveredTitleZoneIndex
          ? colors.cursorBg + colors.red + ansi.bold + CSI + '4m'
          : colors.red + ansi.bold;
        row1 += abortStyle + abortLabel + ansi.reset;
        col1 += visLen(abortLabel);

        // Skip button
        const skipLabel = ' Skip ';
        const skipIdx = zoneIdx++;
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(skipLabel) - 1, action: 'rebase-skip' });
        const skipStyle = skipIdx === ui.hoveredTitleZoneIndex
          ? colors.cursorBg + colors.orange + ansi.bold + CSI + '4m'
          : colors.orange;
        row1 += skipStyle + skipLabel + ansi.reset;
        col1 += visLen(skipLabel);
      } else {
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
            : hasCount ? colors.orange + ansi.bold : colors.dim;
          row1 += style + label + ansi.reset;
          col1 += visLen(label);
        }
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
      + colors.value + '[s]kip' + ansi.reset;
  } else if (state.mode === 'commit') {
    const commitOpRebase = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    const commitHintLabel = commitOpRebase ? ' Continue Rebase: ' : ' Commit: ';
    hintContent = colors.yellow + commitHintLabel + ansi.reset
      + colors.dim + '[Ctrl+Enter]submit  [Esc]cancel' + ansi.reset;
  } else if (state.mode === 'new-branch') {
    hintContent = colors.yellow + ' New Branch: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create' + ansi.reset;
  } else if (state.mode === 'new-tag') {
    hintContent = colors.yellow + ' New Tag: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create' + ansi.reset;
  } else if (state.mode === 'rename-stash') {
    hintContent = colors.yellow + ' Rename Stash: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]rename' + ansi.reset;
  } else if (state.mode === 'new-remote') {
    hintContent = colors.yellow + ' Remote Name: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]next' + ansi.reset;
  } else if (state.mode === 'new-remote-url') {
    hintContent = colors.yellow + ' Remote URL (' + state.inputTarget + '): ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create' + ansi.reset;
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
    windowHint += colors.dim + '  [\u2190\u2192]select  [Enter]apply' + ansi.reset;
    hintContent = windowHint;
  } else if (!state.isGitRepo && (state.error || state.cwd)) {
    hintContent = ' ' + colors.red + (state.error || 'cwd: ' + state.cwd) + ansi.reset;
  } else if (state.error) {
    const isInProgress = state.error.endsWith('...');
    const msgColor = isInProgress ? colors.yellow : colors.red;
    if (state.spinnerActive) {
      const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      hintContent = ' ' + msgColor + BRAILLE[state.spinnerFrame % BRAILLE.length] + ' ' + state.error + ansi.reset;
    } else {
      hintContent = ' ' + msgColor + state.error + ansi.reset;
    }
  } else if (state.rightView === 'fresh') {
    hintContent = ' ' + colors.dim + '[w]indow  [r]efresh  [Tab]focus' + ansi.reset;
  } else if (state.operationState) {
    const op = state.operationState;
    const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
    const label = isRebase ? 'Rebase' : op.type === 'merge' ? 'Merge' : op.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
    const progress = isRebase && op.step ? ' (' + op.step + '/' + op.total + ')' : '';
    const hasUnmerged = state.unstaged.some(f => f.status === 'U');
    if (hasUnmerged) {
      hintContent = colors.yellow + ' ' + label + progress + ansi.reset + '  '
        + colors.dim + '[Tab]focus conflict  [1]/[2] choose side  [m] apply  [b] continue' + ansi.reset;
    } else {
      hintContent = colors.yellow + ' ' + label + progress + ansi.reset + '  '
        + colors.dim + '[b] continue/abort' + (op.type !== 'merge' ? '/skip' : '') + ansi.reset;
    }
  } else {
    hintContent = ' ' + buildHintText();
  }
  if (isSpinning()) {
    const spinnerPart = colors.dim + BRAILLE_FRAMES[state.spinnerFrame % BRAILLE_FRAMES.length] + ansi.reset;
    const gap = Math.max(0, width - visLen(hintContent) - 1);
    buf.push(ansi.moveTo(hintRow, startCol) + hintContent + ' '.repeat(gap) + spinnerPart);
  } else {
    buf.push(ansi.moveTo(hintRow, startCol) + padRight(hintContent, width));
  }

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
      const filesVSbH = ui.filesMaxScrollX > 0 ? contentH - 1 : contentH;
      addScrollbar(state.scrollOffset, ui.filesMaxScroll, filesVSbH, sbBodyTop, midStart + middleW - 1, 'files');
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
        const freshHsbH = ui.freshDetailMaxScrollX > 0 ? 1 : 0;
        if (freshDetailH > 1) {
          const detailTop = sbBodyTop + ui.lastFreshListH + 1 + 1; // +1 separator +1 header
          addScrollbar(state.diffScrollOffset, ui.freshDetailMaxScroll, freshDetailH - 1 - freshHsbH, detailTop, startCol + width - 1, 'freshDetail');
        }
      }
    }

    for (const sb of ui.scrollbarOverlays) {
      buf.push(ansi.moveTo(sb.screenRow, sb.screenCol) + sb.sixelStr);
    }

    // Horizontal scrollbars (sixel)
    ui.hScrollbarZones = [];
    const hasSixel = ui.cellW > 0 && ui.cellH > 0;
    if (hasSixel) {
      function addHScrollbar(target, hScreenRow, hColStart, hCols, viewportCols, scrollX, maxScrollX) {
        const hPixBuf = renderHScrollbarPixels(ui.cellW, ui.cellH, hCols, viewportCols, scrollX, maxScrollX);
        if (hPixBuf) {
          const isActive = ui.dragging === 'hscrollbar' && ui.hScrollbarDragInfo && ui.hScrollbarDragInfo.target === target;
          const isHovered = ui.hoveredHScrollbarTarget === target;
          const palette = isActive ? SCROLLBAR_ACTIVE_PALETTE : isHovered ? SCROLLBAR_HOVER_PALETTE : SCROLLBAR_PALETTE;
          const hSixelStr = encodeSixel(hPixBuf, hCols * ui.cellW, ui.cellH, palette);
          buf.push(ansi.moveTo(hScreenRow, hColStart) + hSixelStr);
          ui.hScrollbarZones.push({
            target,
            screenRow: hScreenRow,
            colStart: hColStart,
            colEnd: hColStart + hCols - 1,
            trackCols: hCols,
            maxScrollX,
          });
        }
      }

      const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;

      // Diff panel horizontal scrollbar (diff mode)
      if (state.rightView === 'diff' && ui.diffMaxScrollX > 0 && rightW > 0) {
        const hCols = rightW - 1;
        addHScrollbar('diff', sbBodyTop + ui.rightDiffH, rpStartCol, hCols, rightW - 1, state.diffScrollX, ui.diffMaxScrollX);
      }
      // Files panel horizontal scrollbar (diff mode)
      if (state.rightView === 'diff' && ui.filesMaxScrollX > 0 && middleW > 0) {
        const hCols = middleW - 1;
        addHScrollbar('files', sbBodyTop + contentH - 1, midStart, hCols, middleW - 1, state.filesScrollX, ui.filesMaxScrollX);
      }
      // Log detail horizontal scrollbar
      if (state.rightView === 'log' && ui.logDetailMaxScrollX > 0 && rightW > 0 && ui.lastLogListH > 0) {
        const hCols = rightW - 1;
        const detailBottom = sbBodyTop + contentH - 1;
        addHScrollbar('logDetail', detailBottom, rpStartCol, hCols, rightW - 1, state.diffScrollX, ui.logDetailMaxScrollX);
      }
      // Fresh detail horizontal scrollbar
      if (state.rightView === 'fresh' && ui.freshDetailMaxScrollX > 0 && rightW > 0 && ui.lastFreshListH > 0) {
        const hCols = rightW - 1;
        const detailBottom = sbBodyTop + contentH - 1;
        addHScrollbar('freshDetail', detailBottom, rpStartCol, hCols, rightW - 1, state.diffScrollX, ui.freshDetailMaxScrollX);
      }
    }
  }

  process.stdout.write(buf.join(''));

  // Record layout
  ui.lastLayout = { startRow, startCol, width, height, leftW, divider1W, middleW, divider2W, rightW, bodyH, titleRows };

  // Commit button zone (diff mode only)
  if (state.rightView !== 'log' && state.rightView !== 'fresh' && ui.rightDiffH >= 0) {
    const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;
    const visLines = ui.commitMsgVisibleLines || 1;
    const hsbOffset = ui.diffMaxScrollX > 0 ? 1 : 0;
    const mergeFooterOffset = state.conflictView ? 1 : 0;
    ui.commitInputRow = startRow + titleRows + 1 + ui.rightDiffH + hsbOffset + 1 + mergeFooterOffset;
    const btnIsRebase = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    const btnIsMergeOp = state.operationState && (state.operationState.type === 'merge' || state.operationState.type === 'cherry-pick' || state.operationState.type === 'revert');
    const btnLabelLen = btnIsRebase ? 16 : btnIsMergeOp ? (state.operationState.type === 'merge' ? 13 : state.operationState.type === 'cherry-pick' ? 19 : 14) : 6; // Continue Rebase=16, Commit=6, etc
    ui.commitButtonZone = {
      row: startRow + titleRows + 1 + ui.rightDiffH + hsbOffset + visLines + 1 + mergeFooterOffset,
      colStart: rpStartCol + 1,
      colEnd: rpStartCol + 1 + btnLabelLen,
    };
    if (state.conflictView) {
      const conflictIndices = state.conflictView.chunks
        .map((chunk, idx) => chunk.type === 'conflict' ? idx : -1)
        .filter(idx => idx >= 0);
      const selectedCount = conflictIndices.filter(idx => ui.mergeChunkSelections[idx]).length;
      const canApply = conflictIndices.length > 0 && selectedCount === conflictIndices.length;
      const applyLabel = canApply ? ' Apply resolution ' : ' Select every conflict to apply ';
      ui.mergeApplyZone = {
        row: startRow + titleRows + 1 + ui.rightDiffH + hsbOffset + 1,
        colStart: rpStartCol + 1,
        colEnd: rpStartCol + applyLabel.length,
        enabled: canApply,
        label: applyLabel,
      };
    } else {
      ui.mergeApplyZone = null;
    }
  } else {
    ui.commitInputRow = -1;
    ui.commitButtonZone = null;
    ui.mergeApplyZone = null;
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
    const hsbOff = ui.diffMaxScrollX > 0 ? 1 : 0;
    const cursorRow = startRow + titleRows + 1 + ui.rightDiffH + hsbOff + 1 + (cursorLineIdx - topLine);
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
    if (state.operationState) {
      const op = state.operationState;
      const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
      const opLabel = isRebase ? 'rebasing' : op.type === 'merge' ? 'merging' : op.type === 'cherry-pick' ? 'cherry-picking' : 'reverting';
      const suffix = isRebase && op.step ? ' (' + opLabel + ' ' + op.step + '/' + op.total + ')' : ' (' + opLabel + ')';
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
    if (state.gitNotFound) {
      pushLine(colors.red + ' git executable not found' + ansi.reset);
    } else {
      pushLine(colors.red + ' Not a git repository' + ansi.reset);
    }
    ui.leftTabInfo = null;
    ui.leftPanelClickMap = clickMap.slice(0, h);
    return lines.slice(0, h);
  }

  const ARROW_OPEN = '-';
  const ARROW_CLOSED = '+';
  const activeBranch = ui.leftPanelActiveBranch;

  function branchLine(indent, name, fullRef, isCurrent, isRemote) {
    const isActive = activeBranch === fullRef;
    const maxW = innerW - indent;
    if (isCurrent) {
      const content = ' '.repeat(indent) + colors.green + ansi.bold + '\u2713 ' + truncate(name, maxW - 2) + ansi.reset;
      return isActive ? colors.cursorBg + padRight(content, innerW) + ansi.reset : content;
    } else {
      const clr = isRemote ? colors.red : colors.value;
      const content = ' '.repeat(indent) + clr + truncate(name, maxW) + ansi.reset;
      return isActive ? colors.cursorBg + padRight(content, innerW) + ansi.reset : content;
    }
  }

  function basename(path) {
    const norm = (path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.substring(idx + 1) : norm;
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
  {
    const collapsed = !!ui.collapsedSections.remotes;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Remotes' + ansi.reset, { action: 'toggle-section', section: 'remotes' });
    if (!collapsed && state.remoteBranches.length > 0) {
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
                pushLine(branchLine(8, item.shortName, item.fullRef, false, true), { action: 'goto-branch', branch: item.fullRef });
              }
            }
          }
          for (const item of topLevel) {
            pushLine(branchLine(6, item.shortName, item.fullRef, false, true), { action: 'goto-branch', branch: item.fullRef });
          }
        }
      }
    }
  }

  // Worktrees
  if (state.worktrees.length > 0) {
    const collapsed = !!ui.collapsedSections.worktrees;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Worktrees' + ansi.reset, { action: 'toggle-section', section: 'worktrees' });
    if (!collapsed) {
      for (const wt of state.worktrees) {
        const stateParts = [];
        if (wt.branch) stateParts.push(wt.branch);
        else if (wt.isDetached) stateParts.push('detached');
        if (wt.isLocked) stateParts.push('locked');
        if (wt.isPrunable) stateParts.push('prunable');
        const label = basename(wt.path || '') || wt.path || '(unknown)';
        const detail = stateParts.length > 0 ? '  ' + stateParts.join(', ') : '';
        const line = (wt.isCurrent ? '  ' + colors.green + ansi.bold + '\u2713 ' : '    ')
          + colors.value + truncate(label, Math.max(1, innerW - 6 - visLen(detail))) + ansi.reset
          + (detail ? colors.dim + detail + ansi.reset : '');
        pushLine(wt.isCurrent ? colors.cursorBg + padRight(line, innerW) + ansi.reset : line);
        if (wt.path) {
          pushLine('      ' + colors.dim + truncate(wt.path, innerW - 6) + ansi.reset);
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
        const stashLabel = s.message ? s.ref + ' ' + s.message : s.ref;
        const content = '  ' + STASH_TEXT + truncate(stashLabel, innerW - 2) + ansi.reset;
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

  if (state.loading) {
    ui.fileLineMap = [];
    ui.filesMaxScroll = 0;
    ui.scrollPct.files = -1;
    return [colors.dim + ' Loading status...' + ansi.reset].slice(0, h);
  }

  // Pre-compute horizontal scroll to reserve row for scrollbar
  // Only count files in non-collapsed sections
  let preMaxFileW = 0;
  for (const f of state.unstaged) {
    const fw = f.file ? f.file.length : 0;
    if (fw > preMaxFileW) preMaxFileW = fw;
  }
  for (const f of state.untracked) {
    const fw = f.file ? f.file.length : 0;
    if (fw > preMaxFileW) preMaxFileW = fw;
  }
  for (const f of state.staged) {
    const fw = f.file ? f.file.length : 0;
    if (fw > preMaxFileW) preMaxFileW = fw;
  }
  if (state.ignored.length > 0 && ui.collapsedSections.ignored === false) {
    for (const f of state.ignored) {
      const fw = f.file ? f.file.length : 0;
      if (fw > preMaxFileW) preMaxFileW = fw;
    }
  }
  const filesContentWPre = Math.max(1, innerW - 6);
  const preFilesMaxScrollX = Math.max(0, preMaxFileW - filesContentWPre);
  const hasFilesHScrollbar = preFilesMaxScrollX > 0;
  if (hasFilesHScrollbar && h > 1) h--;

  function pushFileLine(content, fileIdx) {
    lineToFileIdx.push(fileIdx);
    if (visLen(content) > innerW) content = truncate(content, innerW);
    lines.push(content);
  }

  function statusColor(s) {
    if (s === 'D') return colors.red;
    if (s === 'U') return colors.red;  // unmerged/conflict
    if (s === 'A') return colors.green;
    if (s === 'R' || s === 'C') return colors.cyan;
    return colors.orange;
  }

  // Unstaged (includes untracked)
  const unstagedCount = state.unstaged.length + state.untracked.length;
  {
    const headerLabel = ' Unstaged (' + unstagedCount + ')';
    const allBtnLabel = 'Stage All';
    const btnLabel = 'Stage';
    const totalBtnLen = allBtnLabel.length + 1 + btnLabel.length;
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - totalBtnLen - 1);

    const allZoneIdx = ui.fileHeaderZones.length;
    const allHovered = ui.hoveredFileHeaderIdx === allZoneIdx;
    const allBtnStyle = allHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;

    const zoneIdx = ui.fileHeaderZones.length + 1;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const btnStyle = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;

    const allBtnStart = headerLabelLen + gap;
    const btnStart = allBtnStart + allBtnLabel.length + 1;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + allBtnStyle + allBtnLabel + ansi.reset + ' '
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: allBtnStart, btnColEnd: allBtnStart + allBtnLabel.length - 1, action: 'stageAll' });
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: btnStart, btnColEnd: btnStart + btnLabel.length - 1, action: 'stageSelected' });
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
    const line = prefix + statusColor(item.status) + item.status + resetTo + ' ' + sliceByWidth(item.file, state.filesScrollX, innerW - 6);
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
    const line = prefix + colors.dim + '?' + resetTo + ' ' + sliceByWidth(item.file, state.filesScrollX, innerW - 6);
    pushFileLine(bgColor + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  // Staged
  {
    const headerLabel = ' Staged (' + state.staged.length + ')';
    const allBtnLabel = 'Unstage All';
    const btnLabel = 'Unstage';
    const totalBtnLen = allBtnLabel.length + 1 + btnLabel.length;
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - totalBtnLen - 1);

    const allZoneIdx = ui.fileHeaderZones.length;
    const allHovered = ui.hoveredFileHeaderIdx === allZoneIdx;
    const allBtnStyle = allHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;

    const zoneIdx = ui.fileHeaderZones.length + 1;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const btnStyle = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;

    const allBtnStart = headerLabelLen + gap;
    const btnStart = allBtnStart + allBtnLabel.length + 1;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + allBtnStyle + allBtnLabel + ansi.reset + ' '
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: allBtnStart, btnColEnd: allBtnStart + allBtnLabel.length - 1, action: 'unstageAll' });
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: btnStart, btnColEnd: btnStart + btnLabel.length - 1, action: 'unstageSelected' });
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
    const line = prefix + statusColor(item.status) + item.status + resetTo + ' ' + sliceByWidth(item.file, state.filesScrollX, innerW - 6);
    pushFileLine(bgColor + padRight(line, innerW) + ansi.reset, listIdx);
    listIdx++;
  }

  // Ignored
  if (state.ignoredLoaded ? (state.ignored.length > 0 || ui.collapsedSections.ignored === false) : true) {
    const ignoredCollapsed = ui.collapsedSections.ignored !== false; // default collapsed
    const arrow = ignoredCollapsed ? '+' : '-';
    const ignoredCount = state.ignoredLoading ? '...' : (state.ignoredLoaded ? String(state.ignored.length) : '?');
    const headerLabel = ' ' + arrow + '  Ignored (' + ignoredCount + ')';
    const zoneIdx = ui.fileHeaderZones.length;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const headerStyle = isHovered ? colors.dim + ansi.bold + CSI + '4m' : colors.dim;
    const headerLine = headerStyle + headerLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: 0, btnColEnd: visLen(headerLabel), action: 'toggleIgnored' });
    pushFileLine(headerLine, -1);
    if (!ignoredCollapsed && !state.ignoredLoaded) {
      pushFileLine(colors.dim + '   Loading ignored files...' + ansi.reset, -1);
    } else if (!ignoredCollapsed) {
      for (let i = 0; i < state.ignored.length; i++) {
        const item = state.ignored[i];
        const isCursor = state.cursor === listIdx;
        if (isCursor) cursorLineIdx = lines.length;
        const bgColor = isCursor && focused ? colors.cursorBg : '';
        const line = '   ' + colors.dim + '!' + ansi.reset + (bgColor || '') + ' ' + colors.dim + sliceByWidth(item.file, state.filesScrollX, innerW - 6) + ansi.reset;
        pushFileLine(bgColor + padRight(line, innerW) + ansi.reset, listIdx);
        listIdx++;
      }
    }
  }

  ui.filesMaxScrollX = preFilesMaxScrollX;
  if (state.filesScrollX > preFilesMaxScrollX) state.filesScrollX = preFilesMaxScrollX;

  if (buildFileList().length === 0) {
    pushFileLine(colors.dim + ' Working tree clean' + ansi.reset, -1);
  }

  // Scroll (skip auto-scroll when scrollbar pin is active)
  const filesPinned = ui.filesScrollPin !== undefined && ui.filesScrollPin === state.cursor;
  if (ui.filesScrollPin !== undefined && ui.filesScrollPin !== state.cursor) ui.filesScrollPin = undefined;
  if (!filesPinned && lines.length > h && cursorLineIdx >= 0) {
    if (cursorLineIdx < state.scrollOffset) {
      // Include section headers above the cursor in the viewport
      let target = cursorLineIdx;
      while (target > 0 && lineToFileIdx[target - 1] === -1) target--;
      state.scrollOffset = target;
    } else if (cursorLineIdx >= state.scrollOffset + h) {
      state.scrollOffset = cursorLineIdx - h + 1;
    }
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
  const visibleLines = lines.slice(state.scrollOffset, state.scrollOffset + h);

  // Apply hover highlight to file list
  const hoverRow = ui.hoveredFileRow;
  if (hoverRow >= 0 && hoverRow < visibleLines.length && ui.fileLineMap[hoverRow] >= 0) {
    const orig = visibleLines[hoverRow];
    // Remove existing background and apply hover
    const deBg = orig.replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
    visibleLines[hoverRow] = colors.hoverBg + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + colors.hoverBg), innerW) + ansi.reset;
  }

  // Append empty row for horizontal scrollbar
  if (hasFilesHScrollbar) visibleLines.push('');

  return visibleLines;
}

// ── Right panel (diff mode): diff + commit area ──

function buildDiffCommitPanel(w, h) {
  const lines = [];
  const innerW = w - 1;
  const isConflictView = !!(state.conflictView && state.conflictView.file === state.currentDiffFile);

  let msgLineCount = 1;
  if (state.mode === 'commit') {
    msgLineCount = state.commitMsg.split('\n').length;
  }
  const maxMsgLines = Math.max(1, Math.min(msgLineCount, Math.floor((h - 2) / 2)));
  const commitExtraH = state.conflictView ? 1 : 0;
  const commitAreaH = h >= 5 ? (2 + maxMsgLines + commitExtraH) : 0;
  let diffH = h - commitAreaH;

  let preMaxScrollX = 0;
  let annotated = null;
  let numW = 0; let gutterW = 0; let contentW = 0;
  if (!isConflictView && state.diffLines.length > 0 && diffH > 0) {
    annotated = annotateDiffLineNumbers(state.diffLines);
    numW = annotated.maxLine > 0 ? String(annotated.maxLine).length : 0;
    gutterW = numW > 0 ? numW * 2 + 2 : 0;
    contentW = innerW - (gutterW > 0 ? gutterW : 1);
    let maxLineW = 0;
    for (const line of state.diffLines) {
      const plain = line.replace(/[\r\n]/g, '');
      if (isDiffMetaLine(plain)) continue;
      const lw = stripAnsi(plain).length;
      if (lw > maxLineW) maxLineW = lw;
    }
    preMaxScrollX = Math.max(0, maxLineW - contentW);
  }
  const hasHScrollbar = !isConflictView && preMaxScrollX > 0;
  if (hasHScrollbar) diffH--;

  ui.rightDiffH = diffH;
  ui.commitMsgVisibleLines = maxMsgLines;

  if (diffH > 0) {
    if (isConflictView) {
      const conflictRender = buildConflictDiffLines(innerW);
      ui.mergeClickZones = conflictRender.zones;
      ui.mergeChunkLineMap = conflictRender.chunkLineMap;
      const maxScroll = Math.max(0, conflictRender.lines.length - diffH);
      ui.diffMaxScroll = maxScroll;
      ui.diffMaxScrollX = 0;
      state.diffScrollX = 0;
      if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
      const visible = conflictRender.lines.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
      for (const line of visible) lines.push(line);
      ui.scrollPct.diff = maxScroll > 0 ? Math.round((state.diffScrollOffset / maxScroll) * 100) : -1;
      for (let i = visible.length; i < diffH; i++) lines.push('');
    } else if (state.diffLines.length === 0) {
      ui.mergeClickZones = [];
      ui.mergeChunkLineMap = {};
      lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
      for (let i = 1; i < diffH; i++) lines.push('');
      ui.diffMaxScroll = 0;
      ui.diffMaxScrollX = 0;
    } else {
      ui.mergeClickZones = [];
      ui.mergeChunkLineMap = {};
      const maxScroll = Math.max(0, state.diffLines.length - diffH);
      ui.diffMaxScroll = maxScroll;
      if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
      ui.diffMaxScrollX = preMaxScrollX;
      if (state.diffScrollX > preMaxScrollX) state.diffScrollX = preMaxScrollX;
      const scrollX = state.diffScrollX;
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
          lines.push(gutter + colorizeDiffLine(entry.text, contentW, state.currentDiffFile, scrollX));
        } else {
          lines.push(' ' + colorizeDiffLine(entry.text, innerW - 1, state.currentDiffFile, scrollX));
        }
      }
      ui.scrollPct.diff = state.diffLines.length > diffH ? Math.round((state.diffScrollOffset / maxScroll) * 100) : -1;
      for (let i = visible.length; i < diffH; i++) lines.push('');
      if (hasHScrollbar) lines.push('');
    }
  }

  // Commit area
  if (commitAreaH > 0) {
    lines.push(colors.border + '\u2500'.repeat(w) + ansi.reset);

    if (state.conflictView) {
      const conflictIndices = state.conflictView.chunks
        .map((chunk, idx) => chunk.type === 'conflict' ? idx : -1)
        .filter(idx => idx >= 0);
      const selectedCount = conflictIndices.filter(idx => ui.mergeChunkSelections[idx]).length;
      const canApply = conflictIndices.length > 0 && selectedCount === conflictIndices.length;
      const applyLabel = canApply ? ' Apply resolution ' : ' Select every conflict to apply ';
      const applyStyle = canApply
        ? (ui.hoveredMergeApplyButton ? colors.cursorBg + colors.green + ansi.bold + CSI + '4m' : colors.green + ansi.bold)
        : (ui.hoveredMergeApplyButton ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m' : colors.dim);
      lines.push(' ' + applyStyle + applyLabel + ansi.reset);
    }

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
      if (state.operationState) {
        const opIsRebase = state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply';
        const opLabel = opIsRebase ? 'continue rebase' : 'commit';
        lines.push(colors.dim + ' ' + state.staged.length + ' file(s) staged \u2014 [c] ' + opLabel + '  [b] menu' + ansi.reset);
      } else {
        lines.push(colors.dim + ' ' + state.staged.length + ' file(s) staged \u2014 [c] commit' + ansi.reset);
      }
    } else {
      lines.push(colors.dim + ' No files staged' + ansi.reset);
    }

    const isRebaseOp = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    const isMergeOp = state.operationState && (state.operationState.type === 'merge' || state.operationState.type === 'cherry-pick' || state.operationState.type === 'revert');
    const commitLabel = isRebaseOp ? 'Continue Rebase' : isMergeOp ? 'Commit ' + (state.operationState.type === 'merge' ? 'Merge' : state.operationState.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert') : 'Commit';
    const canCommit = state.mode === 'commit' && state.commitMsg.trim().length > 0;
    const isHovered = ui.hoveredCommitButton;
    if (canCommit) {
      const style = isHovered ? colors.green + ansi.bold + CSI + '4m' : colors.green + ansi.bold;
      lines.push(' ' + style + commitLabel + ansi.reset);
    } else {
      const style = isHovered ? colors.value + ansi.bold + CSI + '4m' : colors.dim;
      lines.push(' ' + style + commitLabel + ansi.reset);
    }
  }

  return lines;
}

// ── Right panel (log mode): history + detail (top/bottom split) ──

function buildLogPanel(w, h) {
  if (state.logItems.length === 0) {
    if (state.logLoading) {
      return [colors.dim + ' Loading commits...' + ansi.reset];
    }
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

  // Compute max natural width among visible rows (trim trailing empty lanes)
  let maxNaturalWidth = 1;
  for (const item of visibleItems) {
    if (item && item.naturalWidth && item.naturalWidth > maxNaturalWidth) {
      maxNaturalWidth = item.naturalWidth;
    }
  }
  const graphRows = [];
  let graphWidth = 0;
  for (let i = 0; i < listH; i++) {
    const itemIdx = state.logScrollOffset + i;
    const item = visibleItems[i];
    if (!item) { lines.push(''); graphRows.push(null); continue; }

    const isCursor = state.focusPanel === 'status' && itemIdx === selectedItemIdx;

    if (item.type === 'commit') {
      const prefix = ' ';
      const graphVisLen = maxNaturalWidth;
      const graphPart = ' '.repeat(graphVisLen) + ' ';
      const fixedLen = 1 + graphVisLen + 1 + 7 + 1;
      const available = innerW - fixedLen;
      const decoRawOrig = item.decoration ? item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      const isHead = /(?:^|,\s*)HEAD(?:\s*->|,|\s*$)/.test(decoRawOrig);
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
      const subjectStyle = item.isRecovery ? RECOVERY_TEXT : colors.value;
      const hashStyle = item.isRecovery
        ? RECOVERY_TEXT
        : (isHead ? colors.green + ansi.bold : colors.yellow);
      const subjPart = (isHead ? ansi.bold : '') + subjectStyle + subjStr + resetTo;
      const hashPart = hashStyle + item.ref + resetTo;
      const usedLen = 1 + graphVisLen + 1 + visLen(subjStr) + visLen(decoPart);
      const pad = Math.max(1, innerW - usedLen - 7);
      const decoPartFixed = isCursor ? decoPart.replace(/\x1b\[0m/g, resetTo) : decoPart;
      const line = prefix + graphPart + subjPart + decoPartFixed + ' '.repeat(pad) + hashPart;
      lines.push((isCursor ? colors.cursorBg : '') + padRight(line, innerW) + ansi.reset);
      graphRows.push(item.chars ? { chars: item.chars, charColors: item.charColors, charStyles: item.charStyles, isCursor } : null);
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
    } else {
      const graphPart = ' '.repeat(maxNaturalWidth);
      lines.push(' ' + graphPart);
      graphRows.push(item.chars ? { chars: item.chars, charColors: item.charColors, charStyles: item.charStyles } : null);
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
    }
  }

  // Apply hover highlight to log list
  const hoverRow = ui.hoveredLogRow;
  if (hoverRow >= 0 && hoverRow < listH) {
    const itemIdx = state.logScrollOffset + hoverRow;
    const item = state.logItems[itemIdx];
    // Only apply hover to commit items (not graph-only rows) and not to cursor
    if (item && item.type === 'commit') {
      const isCursor = state.focusPanel === 'status' && itemIdx === selectedItemIdx;
      if (!isCursor) {
        const orig = lines[hoverRow];
        const deBg = orig.replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
        lines[hoverRow] = colors.hoverBg + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + colors.hoverBg), innerW) + ansi.reset;
        if (graphRows[hoverRow]) graphRows[hoverRow].isHover = true;
      }
    }
  }

  // Sixel
  if (SIXEL_ENABLED && graphRows.length > 0 && maxNaturalWidth > 0) {
    const prevItem = state.logScrollOffset > 0 ? state.logItems[state.logScrollOffset - 1] : null;
    const nextItem = state.logScrollOffset + listH < state.logItems.length ? state.logItems[state.logScrollOffset + listH] : null;
    const prevBoundary = prevItem && prevItem.chars ? { chars: prevItem.chars } : null;
    const nextBoundary = nextItem && nextItem.chars ? { chars: nextItem.chars } : null;
    const pixBuf = renderCombinedGraphPixels(graphRows, maxNaturalWidth, ui.cellW, ui.cellH, prevBoundary, nextBoundary);
    if (pixBuf) {
      ui.logSixelOverlay = encodeSixel(pixBuf, maxNaturalWidth * ui.cellW, graphRows.length * ui.cellH, SIXEL_PALETTE);
    }
  } else {
    ui.logSixelOverlay = null;
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
  ui.detailCopyZones = [];
  if (detailH > 0) {
    const selItem = selectedLogRef();
    if (state.logDetailLines.length === 0) {
      lines.push(colors.dim + ' Select an item to view details' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
      ui.logDetailMaxScrollX = 0;
    } else {
      const refsRaw = selItem && selItem.decoration ? selItem.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      // Collapse/Expand All button
      const allDetailFiles = [];
      for (const entry of filteredDetail) {
        if (entry.isFileHeader) allDetailFiles.push(entry.file);
      }
      const hasFiles = allDetailFiles.length > 0;
      const allCollapsed = hasFiles && allDetailFiles.every(f => ui.collapsedDetailFiles.has(f));
      const collapseLabel = hasFiles ? (allCollapsed ? ' Expand All ' : ' Collapse All ') : '';
      const collapseLabelLen = visLen(collapseLabel);
      function buildRefsLine(refsRaw, maxW, lineIdx) {
        if (!refsRaw) return colors.dim + ' (no refs)' + ansi.reset;
        // Register copy zones and build with hover underline
        let col = 1;
        const refs = refsRaw.split(', ');
        for (const ref of refs) {
          if (col + ref.length > maxW - 1) break;
          const cleanRef = ref.replace(/^HEAD -> /, '');
          ui.detailCopyZones.push({ lineIdx, colStart: col, colEnd: col + ref.length - 1, text: cleanRef });
          col += ref.length + 2;
        }
        // Render with hover underline on hovered ref
        const hoveredZone = ui.hoveredDetailCopyZone;
        if (hoveredZone && hoveredZone.lineIdx === lineIdx) {
          let result = ' ';
          let pos = 1;
          for (const ref of refs) {
            if (pos + ref.length > maxW - 1) break;
            if (pos === hoveredZone.colStart) {
              result += CSI + '4m' + ref + CSI + '24m';
            } else {
              result += ref;
            }
            pos += ref.length;
            if (pos < maxW - 1) { result += ', '; pos += 2; }
          }
          return colors.cyan + result + ansi.reset;
        }
        return colors.cyan + ' ' + truncate(refsRaw, maxW - 2) + ansi.reset;
      }
      if (hasFiles) {
        const refsMaxW = innerW - collapseLabelLen - 1;
        const refsLineIdx = lines.length;
        const refsLine = buildRefsLine(refsRaw, refsMaxW, refsLineIdx);
        const refsVisW = visLen(refsLine);
        const gap = Math.max(1, innerW - refsVisW - collapseLabelLen);
        const btnColStart = refsVisW + gap;
        ui.detailCollapseAllZone = { colStart: btnColStart, colEnd: btnColStart + collapseLabelLen - 1, lineIdx: refsLineIdx };
        const btnStyle = ui.hoveredCollapseAllButton
          ? colors.value + ansi.bold + CSI + '4m'
          : allCollapsed ? colors.cyan : colors.dim;
        lines.push(refsLine + ' '.repeat(gap) + btnStyle + collapseLabel + ansi.reset);
      } else {
        ui.detailCollapseAllZone = null;
        const refsLineIdx = lines.length;
        lines.push(buildRefsLine(refsRaw, innerW, refsLineIdx));
      }
      let cH = detailH - 1;

      // Compute horizontal scroll for log detail
      const logDetailGutterW = filteredDetail.maxLine > 0 ? String(filteredDetail.maxLine).length * 2 + 2 : 0;
      const logDetailContentW = innerW - (logDetailGutterW > 0 ? logDetailGutterW : 1);
      let logDetailMaxLineW = 0;
      for (const entry of filteredDetail) {
        if (entry.text && !entry.isFileHeader && !isDiffMetaLine(entry.text.replace(/[\r\n]/g, ''))) {
          const lw = stripAnsi(entry.text.replace(/[\r\n]/g, '')).length;
          if (lw > logDetailMaxLineW) logDetailMaxLineW = lw;
        }
      }
      const logDetailMaxScrollX = Math.max(0, logDetailMaxLineW - logDetailContentW);
      ui.logDetailMaxScrollX = logDetailMaxScrollX;
      if (state.diffScrollX > logDetailMaxScrollX) state.diffScrollX = logDetailMaxScrollX;
      if (logDetailMaxScrollX > 0 && cH > 1) cH--;
      ui.lastDetailContentH = cH;

      const maxDetailScroll = Math.max(0, filteredDetail.length - cH);
      ui.logDetailMaxScroll = maxDetailScroll;
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
          lines.push(colorizeDiffLine(entry.text, innerW, entry.file));
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
          lines.push(gutter + colorizeDiffLine(entry.text, innerW - gutterW, entry.file, state.diffScrollX));
          ui.detailFileHeaderMap.push(null);
        } else {
          const rawText = (entry.text || '').replace(/[\r\n]/g, '');
          const lineIdx = lines.length;
          // Register copy zones for metadata lines
          if (rawText.startsWith('commit ')) {
            const hash = rawText.substring(7);
            ui.detailCopyZones.push({ lineIdx, colStart: 8, colEnd: 8 + hash.length - 1, text: hash });
          } else if (rawText.startsWith('Author: ') || rawText.startsWith('Commit: ')) {
            const prefix = rawText.startsWith('Author: ') ? 'Author: ' : 'Commit: ';
            const rest = rawText.substring(prefix.length);
            // Parse: name <email>  date or name  date
            const emailMatch = rest.match(/^(.+?) <(.+?)>(  .+)?$/);
            const noEmailMatch = rest.match(/^(.+?)(  \d{4}-.+)?$/);
            let col = prefix.length + 1; // +1 for leading space
            if (emailMatch) {
              const name = emailMatch[1];
              const email = emailMatch[2];
              const dateStr = emailMatch[3] ? emailMatch[3].substring(2) : '';
              ui.detailCopyZones.push({ lineIdx, colStart: col, colEnd: col + name.length - 1, text: name });
              const emailStart = col + name.length + 2; // ' <'
              ui.detailCopyZones.push({ lineIdx, colStart: emailStart, colEnd: emailStart + email.length - 1, text: email });
              if (dateStr) {
                const dateStart = emailStart + email.length + 3; // '>  '
                ui.detailCopyZones.push({ lineIdx, colStart: dateStart, colEnd: dateStart + dateStr.length - 1, text: dateStr });
              }
            } else if (noEmailMatch) {
              const name = noEmailMatch[1];
              const dateStr = noEmailMatch[2] ? noEmailMatch[2].substring(2) : '';
              ui.detailCopyZones.push({ lineIdx, colStart: col, colEnd: col + name.length - 1, text: name });
              if (dateStr) {
                const dateStart = col + name.length + 2;
                ui.detailCopyZones.push({ lineIdx, colStart: dateStart, colEnd: dateStart + dateStr.length - 1, text: dateStr });
              }
            }
          }
          // Render with hover underline
          const hz = ui.hoveredDetailCopyZone;
          const hoveredZone = hz && hz.lineIdx === lineIdx
            ? ui.detailCopyZones.find(z => z.lineIdx === lineIdx && z.colStart === hz.colStart && z.colEnd === hz.colEnd)
            : null;
          if (hoveredZone) {
            lines.push(' ' + colorizeDiffLineWithUnderline(rawText, innerW - 1, hoveredZone.colStart - 1, hoveredZone.colEnd - 1));
          } else {
            lines.push(' ' + colorizeDiffLine(entry.text, innerW - 1, entry.file, state.diffScrollX));
          }
          ui.detailFileHeaderMap.push(null);
        }
      }
      // Reserve row for horizontal scrollbar
      if (logDetailMaxScrollX > 0) lines.push('');
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

  // Apply hover highlight to fresh file list (skip header at row 0)
  const hoverRow = ui.hoveredFreshRow;
  if (hoverRow > 0 && hoverRow < lines.length) {
    const itemIdx = hoverRow > 0 && hoverRow - 1 < visibleItems.length ? state.freshScrollOffset + (hoverRow - 1) : -1;
    const isCursor = state.focusPanel === 'status' && itemIdx === selectedItemIdx;
    if (!isCursor) {
      const orig = lines[hoverRow];
      const deBg = orig.replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
      lines[hoverRow] = colors.hoverBg + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + colors.hoverBg), innerW) + ansi.reset;
    }
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
      ui.freshDetailMaxScrollX = 0;
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
      let cH = detailH - 1;

      // Compute horizontal scroll for fresh detail
      let freshDetailMaxLineW = 0;
      for (const line of state.freshDetailLines) {
        const plain = line.replace(/[\r\n]/g, '');
        if (isDiffMetaLine(plain)) continue;
        const lw = stripAnsi(plain).length;
        if (lw > freshDetailMaxLineW) freshDetailMaxLineW = lw;
      }
      const freshDetailMaxScrollX = Math.max(0, freshDetailMaxLineW - (innerW - 1));
      ui.freshDetailMaxScrollX = freshDetailMaxScrollX;
      if (state.diffScrollX > freshDetailMaxScrollX) state.diffScrollX = freshDetailMaxScrollX;
      if (freshDetailMaxScrollX > 0 && cH > 1) cH--;

      const maxDetailScroll = Math.max(0, state.freshDetailLines.length - cH);
      ui.freshDetailMaxScroll = maxDetailScroll;
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
      const visible = state.freshDetailLines.slice(state.diffScrollOffset, state.diffScrollOffset + cH);
      for (const rawLine of visible) {
        lines.push(' ' + colorizeDiffLine(rawLine, innerW - 1, selItem ? selItem.file : null, state.diffScrollX));
      }
      // Reserve row for horizontal scrollbar
      if (freshDetailMaxScrollX > 0) lines.push('');
    }
  }

  ui.freshFileLineMap = lineToFileIdx.slice(0, listH);
  return lines;
}

// ── Helpers ──

function colorizeDecoration(plainDeco, currentBranch, isHead) {
  if (!plainDeco) return '';
  const refs = plainDeco.split(', ').filter(r => !r.endsWith('/HEAD'));
  const parts = [];
  for (const ref of refs) {
    if (ref === 'HEAD') {
      parts.push(colors.green + ansi.bold + 'HEAD' + ansi.reset);
    } else if (ref === currentBranch) {
      parts.push(colors.green + (isHead ? ansi.bold : '') + ref + ansi.reset);
    } else if (ref === 'recovery') {
      parts.push(RECOVERY_TEXT + 'recovery' + ansi.reset);
    } else if (ref === 'refs/stash' || ref.startsWith('stash@{')) {
      parts.push(STASH_TEXT + ref + ansi.reset);
    } else if (ref.startsWith('tag:')) {
      parts.push(colors.yellow + ref + ansi.reset);
    } else if (ref.includes('/')) {
      parts.push(colors.red + ref + ansi.reset);
    } else {
      parts.push(colors.cyan + ref + ansi.reset);
    }
  }
  return parts.join(colors.dim + ', ' + ansi.reset);
}

function buildConflictDiffLines(innerW) {
  const lines = [];
  const zones = [];
  const chunkLineMap = {};
  const conflictView = state.conflictView;
  if (!conflictView) return { lines, zones, chunkLineMap };

  const op = state.operationState || {};
  const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
  const oursLabel = isRebase ? 'HEAD' : 'Ours';
  const theirsLabel = isRebase ? (op.headName || 'Incoming') : 'Theirs';
  const white = ansi.fg(255, 255, 255);
  const brightBlue = ansi.fg(120, 180, 255);
  const accentBg = ansi.bg(156, 96, 0);
  const conflictIndices = conflictView.chunks
    .map((chunk, idx) => chunk.type === 'conflict' ? idx : -1)
    .filter(idx => idx >= 0);
  const selectedCount = conflictIndices.filter(idx => ui.mergeChunkSelections[idx]).length;
  const leftW = Math.max(10, Math.floor((innerW - 3) / 2));
  const gap = ' ' + colors.border + '\u2502' + ansi.reset + ' ';
  const rightW = Math.max(10, innerW - leftW - 3);

  lines.push(colors.yellow + ansi.bold + ' Merge conflict' + ansi.reset
    + colors.dim + '  Select each chunk from left or right' + ansi.reset);
  lines.push(' ' + colors.cyan + conflictView.file + ansi.reset);
  lines.push(colors.dim + ` ${selectedCount}/${conflictIndices.length} conflicts selected` + ansi.reset);
  lines.push('');

  const headerLine = brightBlue + ansi.bold + padRight(' ' + oursLabel, leftW)
    + ansi.reset + gap
    + brightBlue + ansi.bold + padRight(' ' + theirsLabel, rightW) + ansi.reset;
  lines.push(headerLine);
  lines.push(colors.border + '\u2500'.repeat(leftW) + ansi.reset + gap + colors.border + '\u2500'.repeat(rightW) + ansi.reset);

  let ordinal = 0;
  for (let chunkIndex = 0; chunkIndex < conflictView.chunks.length; chunkIndex++) {
    const chunk = conflictView.chunks[chunkIndex];
    if (chunk.type === 'context') {
      for (const line of chunk.lines) {
        lines.push(colors.dim + '  ' + truncate(line, innerW - 2) + ansi.reset);
      }
      continue;
    }

    ordinal++;
    const selection = ui.mergeChunkSelections[chunkIndex] || null;
    const isCursor = ui.mergeChunkCursor === chunkIndex;
    const hoveredZone = ui.hoveredMergeZoneIndex >= 0 ? ui.mergeClickZones[ui.hoveredMergeZoneIndex] : null;
    const headerBg = accentBg;
    const statusText = selection === 'ours' ? `${oursLabel} selected`
      : selection === 'theirs' ? `${theirsLabel} selected`
      : 'unresolved';
    const statusTextLine = ` Conflict ${ordinal}/${conflictIndices.length}  [${statusText}]`;
    lines.push((headerBg || '') + white + ansi.bold + padRight(statusTextLine, innerW) + ansi.reset);

    const chunkStart = lines.length - 1;
    const bodyTop = lines.length;
    const rowCount = Math.max(chunk.ours.length, chunk.theirs.length, 1);
    for (let row = 0; row < rowCount; row++) {
      const leftRaw = chunk.ours[row] !== undefined ? chunk.ours[row] : '';
      const rightRaw = chunk.theirs[row] !== undefined ? chunk.theirs[row] : '';
      const leftPrefix = selection === 'ours' ? white + ansi.bold + '> ' + ansi.reset : colors.dim + '  ' + ansi.reset;
      const rightPrefix = selection === 'theirs' ? white + ansi.bold + '> ' + ansi.reset : colors.dim + '  ' + ansi.reset;
      const leftHovered = hoveredZone && hoveredZone.chunkIndex === chunkIndex && hoveredZone.action === 'select-ours' && hoveredZone.lineIdx === bodyTop + row;
      const rightHovered = hoveredZone && hoveredZone.chunkIndex === chunkIndex && hoveredZone.action === 'select-theirs' && hoveredZone.lineIdx === bodyTop + row;
      const leftBg = selection === 'ours' ? colors.hoverBg : leftHovered ? colors.hoverBg : '';
      const rightBg = selection === 'theirs' ? colors.hoverBg : rightHovered ? colors.hoverBg : '';
      const leftCode = truncate(highlightCode(leftRaw, conflictView.file), Math.max(0, leftW - 2));
      const rightCode = truncate(highlightCode(rightRaw, conflictView.file), Math.max(0, rightW - 2));
      const leftText = leftPrefix + leftCode;
      const rightText = rightPrefix + rightCode;
      const leftStyled = leftBg
        ? leftBg + padRight(leftText.replace(/\x1b\[0m/g, ansi.reset + leftBg), leftW) + ansi.reset
        : padRight(leftText, leftW) + ansi.reset;
      const rightStyled = rightBg
        ? rightBg + padRight(rightText.replace(/\x1b\[0m/g, ansi.reset + rightBg), rightW) + ansi.reset
        : padRight(rightText, rightW) + ansi.reset;
      lines.push(leftStyled + gap + rightStyled);
    }

    const lineEnd = lines.length - 1;
    for (let lineIdx = bodyTop; lineIdx <= lineEnd; lineIdx++) {
      zones.push({ lineIdx, colStart: 0, colEnd: leftW, action: 'select-ours', chunkIndex });
      zones.push({ lineIdx, colStart: leftW + 3, colEnd: innerW, action: 'select-theirs', chunkIndex });
    }
    zones.push({ lineIdx: bodyTop - 1, colStart: 0, colEnd: innerW, action: 'focus-chunk', chunkIndex });
    lines.push(colors.border + '\u2500'.repeat(innerW) + ansi.reset);
    chunkLineMap[chunkIndex] = { start: chunkStart, end: lines.length - 1 };
  }

  return { lines, zones, chunkLineMap };
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
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: null, file: currentFile });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity') || line.startsWith('rename') ||
        line.startsWith('Binary')) {
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: null, file: currentFile });
      continue;
    }
    if (line.startsWith('+')) {
      maxLine = Math.max(maxLine, newLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: newLine, file: currentFile });
      newLine++;
    } else if (line.startsWith('-')) {
      maxLine = Math.max(maxLine, oldLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: oldLine, newNum: null, file: currentFile });
      oldLine++;
    } else {
      maxLine = Math.max(maxLine, oldLine, newLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: oldLine, newNum: newLine, file: currentFile });
      oldLine++;
      newLine++;
    }
  }
  result.maxLine = maxLine;
  return result;
}

/**
 * Colorize a diff line with syntax highlighting for code content
 * Adds background color for additions (green) and deletions (red)
 * @param {string} rawLine - The raw diff line
 * @param {number} w - Maximum width
 * @param {string} filePath - File path for language detection
 * @returns {string} Colorized line with background
 */
function isDiffMetaLine(rawLine) {
  return rawLine.startsWith('+++') || rawLine.startsWith('---') ||
    rawLine.startsWith('@@') ||
    rawLine.startsWith('diff ') || rawLine.startsWith('index ') || rawLine.startsWith('commit ') ||
    rawLine.startsWith('Author: ') || rawLine.startsWith('Commit: ') ||
    /^\u2500{3,}$/.test(rawLine);
}

function colorizeDiffLineWithUnderline(rawLine, w, ulStart, ulEnd) {
  // Render a metadata line with underline on [ulStart, ulEnd] range (0-based within rawLine)
  const fgColor = rawLine.startsWith('commit ') ? colors.dim : colors.cyan;
  let result = '';
  for (let i = 0; i < Math.min(rawLine.length, w); i++) {
    if (i === ulStart) result += CSI + '4m';
    result += rawLine[i];
    if (i === ulEnd) result += CSI + '24m';
  }
  return fgColor + result + ansi.reset;
}

function colorizeDiffLine(rawLine, w, filePath, scrollX) {
  rawLine = rawLine.replace(/[\r\n]/g, '');
  // Don't apply horizontal scroll to metadata/header lines
  const sx = isDiffMetaLine(rawLine) ? 0 : (scrollX || 0);

  // Diff metadata lines (no background, just foreground color)
  if (rawLine.startsWith('+++') || rawLine.startsWith('---')) {
    return colors.diffHeader + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (rawLine.startsWith('@@')) {
    return colors.diffHunk + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (rawLine.startsWith('diff ') || rawLine.startsWith('index ') || rawLine.startsWith('commit ')) {
    return colors.dim + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (rawLine.startsWith('Author: ') || rawLine.startsWith('Commit: ')) {
    return colors.cyan + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (/^\u2500{3,}$/.test(rawLine)) {
    return colors.border + '\u2500'.repeat(w) + ansi.reset;
  }

  // Code lines with diff markers
  const isAdd = rawLine.startsWith('+');
  const isDel = rawLine.startsWith('-');

  // Determine background and foreground colors
  const bgColor = isAdd ? colors.diffAddBg : isDel ? colors.diffDelBg : '';
  const fgColor = isAdd ? colors.diffAdd : isDel ? colors.diffDel : colors.label;

  // Get visible portion with horizontal scroll
  const visibleText = sliceByWidth(rawLine, sx, w);

  // Try to apply syntax highlighting on visible portion
  if (filePath && visibleText.trim()) {
    const lang = getLanguage(filePath);
    if (lang) {
      try {
        const highlighted = highlightCode(visibleText, filePath);
        return bgColor + fgColor + highlighted + ansi.reset;
      } catch (e) {
        // Fall back to basic coloring
      }
    }
  }

  // Fallback: basic diff coloring with background (no syntax highlighting)
  return bgColor + fgColor + visibleText + ansi.reset;
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
