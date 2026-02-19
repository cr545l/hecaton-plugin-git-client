const { ESC, CSI } = require('./ansi');
const { state, ui } = require('./state');
const { gitStage, gitUnstage, gitStageAll, gitUnstageAll, gitCommit, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip } = require('./git');
const { sendRpcNotify } = require('./rpc');
const { buildFileList, selectedItem, selectedLogRef, refresh, refreshLog, updateLogDetail, updateDiff } = require('./refresh');
const { render } = require('./render');

function actionToKey(action) {
  switch (action) {
    case 'stage':    return 's';
    case 'unstage':  return 'u';
    case 'all':      return 'a';
    case 'commit':   return 'c';
    case 'log':      return 'l';
    case 'rebase':   return 'b';
    case 'refresh':  return 'r';
    case 'tab':      return '\t';
    case 'quit':     return 'q';
    default:         return '';
  }
}

function handleKey(key) {
  if (state.mode === 'rebase-menu') {
    handleRebaseMenuInput(key);
    return;
  }
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
    case 'b': {
      if (state.rebaseState) {
        state.mode = 'rebase-menu';
        render();
      } else {
        // Start rebase from log view
        const logItem = selectedLogRef();
        if (!logItem || !logItem.ref) {
          state.error = 'Select a commit in log view to rebase onto';
          render();
          setTimeout(() => { state.error = null; render(); }, 2000);
          break;
        }
        const err = gitRebase(state.cwd, logItem.ref);
        refresh();
        if (state.rightView === 'log') refreshLog();
        if (err && state.rebaseState) {
          // Conflict: rebase in progress
          render();
        } else if (err) {
          state.error = 'Rebase failed: ' + err.substring(0, 60);
          render();
          setTimeout(() => { state.error = null; render(); }, 3000);
        } else {
          render();
        }
      }
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

function handleRebaseMenuInput(key) {
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    render();
    return;
  }
  if (key === 'c') {
    state.mode = 'normal';
    const err = gitRebaseContinue(state.cwd);
    refresh();
    if (state.rightView === 'log') refreshLog();
    if (err && state.rebaseState) {
      state.error = 'Rebase continue: resolve conflicts first';
      render();
      setTimeout(() => { state.error = null; render(); }, 3000);
    } else if (err) {
      state.error = 'Rebase continue failed: ' + err.substring(0, 60);
      render();
      setTimeout(() => { state.error = null; render(); }, 3000);
    } else {
      render();
    }
    return;
  }
  if (key === 'a') {
    state.mode = 'normal';
    const err = gitRebaseAbort(state.cwd);
    refresh();
    if (state.rightView === 'log') refreshLog();
    if (err) {
      state.error = 'Rebase abort failed: ' + err.substring(0, 60);
      render();
      setTimeout(() => { state.error = null; render(); }, 3000);
    } else {
      render();
    }
    return;
  }
  if (key === 's') {
    state.mode = 'normal';
    const err = gitRebaseSkip(state.cwd);
    refresh();
    if (state.rightView === 'log') refreshLog();
    if (err && state.rebaseState) {
      render();
    } else if (err) {
      state.error = 'Rebase skip failed: ' + err.substring(0, 60);
      render();
      setTimeout(() => { state.error = null; render(); }, 3000);
    } else {
      render();
    }
    return;
  }
}

function handleMouseData(data) {
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
      if (ui.dragging === 'vertical') {
        const L = ui.lastLayout;
        ui.verticalDividerRatio = Math.max(1 / L.width, Math.min(1 - 2 / L.width, (cx - L.startCol) / L.width));
        render();
        continue;
      }
      if (ui.dragging === 'horizontal') {
        const L = ui.lastLayout;
        ui.logListRatio = Math.max(1 / L.bodyH, Math.min(1 - 1 / L.bodyH, (cy - (L.startRow + 2)) / L.bodyH));
        render();
        continue;
      }
      const L = ui.lastLayout;
      let newHover = -1;
      for (let i = 0; i < ui.clickableAreas.length; i++) {
        const area = ui.clickableAreas[i];
        if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
          newHover = i;
          break;
        }
      }
      let newTitleHover = -1;
      if (cy === L.startRow) {
        for (let i = 0; i < ui.titleClickZones.length; i++) {
          const zone = ui.titleClickZones[i];
          if (cx >= zone.colStart && cx <= zone.colEnd) {
            newTitleHover = i;
            break;
          }
        }
      }
      let newDivHover = null;
      const inBody = cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH;
      if (!ui.leftPanelCollapsed && inBody) {
        const dividerCol = L.startCol + L.leftW;
        if (cx >= dividerCol - 1 && cx <= dividerCol + 1) {
          newDivHover = 'vertical';
        }
      }
      if (!ui.rightTopCollapsed && !ui.rightBottomCollapsed) {
        const hSepRow = L.startRow + 2 + ui.lastLogListH;
        if (cy === hSepRow && cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width) {
          newDivHover = 'horizontal';
        }
      }
      if (newHover !== ui.hoveredAreaIndex || newTitleHover !== ui.hoveredTitleZoneIndex || newDivHover !== ui.hoveredDivider) {
        ui.hoveredAreaIndex = newHover;
        ui.hoveredTitleZoneIndex = newTitleHover;
        ui.hoveredDivider = newDivHover;
        render();
      }
      continue;
    }

    if (isRelease) {
      if (ui.dragging !== null) ui.dragging = null;
      continue;
    }

    // Scroll wheel
    if (cb === 64 || cb === 65) {
      const L = ui.lastLayout;
      const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
      const inRight = cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width;
      const inBody = cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH;
      if (inBody && inRight) {
        if (state.rightView === 'log') {
          const rightRowIdx = cy - (L.startRow + 2);
          if (rightRowIdx < ui.lastLogListH) {
            if (state.logSelectables.length > 0) {
              if (cb === 64) state.logCursor = Math.max(0, state.logCursor - 3);
              else state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 3);
              state.diffScrollOffset = 0;
              updateLogDetail();
            }
          } else {
            if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
            else state.diffScrollOffset += 3;
          }
        } else {
          const rightRowIdx = cy - (L.startRow + 2);
          if (rightRowIdx < ui.lastLogListH) {
            if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
            else state.diffScrollOffset += 3;
          }
        }
        state.focusPanel = 'diff';
        render();
      } else if (inBody && inLeft) {
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
      const L = ui.lastLayout;

      // Title row click → collapse/expand
      if (cy === L.startRow) {
        let handled = false;
        for (const zone of ui.titleClickZones) {
          if (cx >= zone.colStart && cx <= zone.colEnd) {
            if (zone.action === 'toggleStatus') {
              ui.leftPanelCollapsed = !ui.leftPanelCollapsed;
            } else if (zone.action === 'toggleHistory') {
              ui.rightTopCollapsed = !ui.rightTopCollapsed;
            } else if (zone.action === 'toggleDetail') {
              ui.rightBottomCollapsed = !ui.rightBottomCollapsed;
            }
            render();
            handled = true;
            break;
          }
        }
        if (handled) continue;
      }

      // Divider drag start detection
      if (!ui.leftPanelCollapsed) {
        const dividerCol = L.startCol + L.leftW;
        if (cx >= dividerCol - 1 && cx <= dividerCol + 1 && cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH) {
          ui.dragging = 'vertical';
          continue;
        }
      }
      if (!ui.rightTopCollapsed && !ui.rightBottomCollapsed && cy === L.startRow + 2 + ui.lastLogListH && cx >= L.startCol + L.leftW + L.dividerW && cx < L.startCol + L.width) {
        ui.dragging = 'horizontal';
        continue;
      }

      // Click on hint bar buttons
      for (const area of ui.clickableAreas) {
        if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
          handleKey(actionToKey(area.action));
          break;
        }
      }

      // Click on left panel tab buttons
      if (!ui.leftPanelCollapsed) {
        let tabHandled = false;
        for (const zone of ui.leftTabZones) {
          if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
            if (zone.action === 'localChanges') {
              state.rightView = 'diff';
              updateDiff();
            } else if (zone.action === 'allCommits') {
              state.rightView = 'log';
              refreshLog();
              state.logCursor = 0;
              state.logScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateLogDetail();
              state.focusPanel = 'diff';
            }
            render();
            tabHandled = true;
            break;
          }
        }
        if (tabHandled) continue;
      }

      // Click on left panel (file list)
      const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
      const bodyRowIdx = cy - (L.startRow + 2);
      if (inLeft && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
        if (bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
          const fileIdx = ui.fileLineMap[bodyRowIdx];
          const now = Date.now();

          if (fileIdx === ui.lastClickFileIdx && now - ui.lastClickTime < 400) {
            // Double-click: stage/unstage toggle
            const fileList = buildFileList();
            const item = fileList[fileIdx];
            if (item) {
              if (item.type === 'staged') {
                gitUnstage(state.cwd, item.file);
              } else {
                gitStage(state.cwd, item.file);
              }
              refresh();
            }
            ui.lastClickFileIdx = -1;
            ui.lastClickTime = 0;
          } else {
            // Single click: select
            state.cursor = fileIdx;
            ui.lastClickFileIdx = fileIdx;
            ui.lastClickTime = now;
          }

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
        if (state.rightView === 'log' && bodyRowIdx < ui.lastLogListH) {
          const itemIdx = state.logScrollOffset + bodyRowIdx;
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
  return hadMouse;
}

function cleanup() {
  process.stdout.write(CSI + '?7h' + require('./ansi').ansi.showCursor + require('./ansi').ansi.reset + require('./ansi').ansi.clear);
}

module.exports = { handleKey, handleMouseData, actionToKey, cleanup };
