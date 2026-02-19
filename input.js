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
      if (state.rightView === 'log') {
        if (state.logSelectables.length > 0) {
          state.logCursor = Math.max(0, state.logCursor - 1);
          state.diffScrollOffset = 0;
          updateLogDetail();
        }
      } else {
        const list = buildFileList();
        if (list.length > 0) {
          state.cursor = Math.max(0, state.cursor - 1);
          updateDiff();
        }
      }
    } else {
      state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 1);
    }
    render();
    return;
  }
  if (key === CSI + 'B' || key === 'j') { // Down
    if (state.focusPanel === 'status') {
      if (state.rightView === 'log') {
        if (state.logSelectables.length > 0) {
          state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 1);
          state.diffScrollOffset = 0;
          updateLogDetail();
        }
      } else {
        const list = buildFileList();
        if (list.length > 0) {
          state.cursor = Math.min(list.length - 1, state.cursor + 1);
          updateDiff();
        }
      }
    } else {
      state.diffScrollOffset++;
    }
    render();
    return;
  }

  switch (key) {
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
      }
      state.focusPanel = 'status';
      render();
      break;
    }
    case 'b': {
      if (state.rebaseState) {
        state.mode = 'rebase-menu';
        render();
      } else {
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
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    state.commitMsg = '';
    render();
    return;
  }
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
  if (key === '\x7f' || key === '\b' || key === CSI + '3~') {
    state.commitMsg = state.commitMsg.slice(0, -1);
    render();
    return;
  }
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.commitMsg += key;
    render();
    return;
  }
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

    const L = ui.lastLayout;
    const midStart = L.startCol + L.leftW + L.divider1W;
    const rightStart = midStart + L.middleW + L.divider2W;
    const div1Col = L.startCol + L.leftW;
    const div2Col = midStart + L.middleW;

    // Motion events (cb bit 5 set) -> drag resize / hover
    if ((cb & 32) !== 0) {
      if (ui.dragging === 'vertical') {
        ui.verticalDividerRatio = Math.max(1 / L.width, Math.min(0.5, (cx - L.startCol) / L.width));
        render();
        continue;
      }
      if (ui.dragging === 'vertical2') {
        const remaining = L.width - L.leftW - L.divider1W;
        const relX = cx - midStart;
        ui.filesDividerRatio = Math.max(0.15, Math.min(0.7, relX / remaining));
        render();
        continue;
      }
      if (ui.dragging === 'horizontal') {
        const bodyTop = L.startRow + 2;
        const contentH = Math.max(1, L.bodyH - 2);
        const relY = cy - bodyTop;
        ui.logListRatio = Math.max(0.1, Math.min(0.9, relY / contentH));
        render();
        continue;
      }

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
        if (cx >= div1Col - 1 && cx <= div1Col + 1) {
          newDivHover = 'vertical';
        }
      }
      if (L.middleW > 0 && inBody && cx >= div2Col - 1 && cx <= div2Col + 1) {
        newDivHover = 'vertical2';
      }
      if (state.rightView === 'log' && inBody && ui.lastLogListH > 0) {
        const hDivRow = L.startRow + 2 + ui.lastLogListH;
        if (cy >= hDivRow - 1 && cy <= hDivRow + 1 && cx >= rightStart) {
          newDivHover = 'horizontal';
        }
      }
      // Hover: file header buttons (Stage All / Unstage All)
      let newFileHeaderHover = -1;
      if (state.rightView !== 'log' && inBody) {
        const bodyRowIdx = cy - (L.startRow + 2);
        for (let i = 0; i < ui.fileHeaderZones.length; i++) {
          const zone = ui.fileHeaderZones[i];
          const visibleLineIdx = zone.lineIdx - state.scrollOffset;
          if (visibleLineIdx === bodyRowIdx) {
            const btnScreenColStart = midStart + zone.btnColStart;
            const btnScreenColEnd = midStart + zone.btnColEnd;
            if (cx >= btnScreenColStart && cx <= btnScreenColEnd) {
              newFileHeaderHover = i;
              break;
            }
          }
        }
      }

      // Hover: left panel clickable rows
      let newLeftPanelHover = -1;
      if (!ui.leftPanelCollapsed && inBody) {
        const inLeft = cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft) {
          const bodyRowIdx = cy - (L.startRow + 2);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.leftPanelClickMap.length && ui.leftPanelClickMap[bodyRowIdx]) {
            newLeftPanelHover = bodyRowIdx;
          }
        }
      }

      if (newHover !== ui.hoveredAreaIndex || newTitleHover !== ui.hoveredTitleZoneIndex || newDivHover !== ui.hoveredDivider || newFileHeaderHover !== ui.hoveredFileHeaderIdx || newLeftPanelHover !== ui.hoveredLeftPanelRow) {
        ui.hoveredAreaIndex = newHover;
        ui.hoveredTitleZoneIndex = newTitleHover;
        ui.hoveredDivider = newDivHover;
        ui.hoveredFileHeaderIdx = newFileHeaderHover;
        ui.hoveredLeftPanelRow = newLeftPanelHover;
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
      const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      const inRight = cx >= rightStart && cx < L.startCol + L.width;
      const inBody = cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH;
      if (inBody && inLeft) {
        if (cb === 64) ui.leftPanelScrollOffset = Math.max(0, ui.leftPanelScrollOffset - 3);
        else ui.leftPanelScrollOffset += 3;
        render();
      } else if (inBody && inMiddle) {
        // Middle panel (diff mode only): file list scroll
        const list = buildFileList();
        if (list.length > 0) {
          if (cb === 64) state.cursor = Math.max(0, state.cursor - 3);
          else state.cursor = Math.min(list.length - 1, state.cursor + 3);
          updateDiff();
        }
        state.focusPanel = 'status';
        render();
      } else if (inBody && inRight) {
        if (state.rightView === 'log') {
          // Log mode: top = log scroll, bottom = detail scroll
          const bodyRowIdx = cy - (L.startRow + 2);
          if (bodyRowIdx < ui.lastLogListH) {
            if (state.logSelectables.length > 0) {
              if (cb === 64) state.logCursor = Math.max(0, state.logCursor - 3);
              else state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 3);
              state.diffScrollOffset = 0;
              updateLogDetail();
            }
            state.focusPanel = 'status';
          } else {
            if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
            else state.diffScrollOffset += 3;
            state.focusPanel = 'diff';
          }
        } else {
          // Diff mode: diff scroll
          if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
          else state.diffScrollOffset += 3;
          state.focusPanel = 'diff';
        }
        render();
      }
      continue;
    }

    // Left click
    if (cb === 0) {
      // Title row click
      if (cy === L.startRow) {
        let handled = false;
        for (const zone of ui.titleClickZones) {
          if (cx >= zone.colStart && cx <= zone.colEnd) {
            if (zone.action === 'toggleStatus') {
              ui.leftPanelCollapsed = !ui.leftPanelCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleHistory') {
              ui.rightTopCollapsed = !ui.rightTopCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleDetail') {
              ui.rightBottomCollapsed = !ui.rightBottomCollapsed;
              render();
              handled = true;
            }
            break;
          }
        }
        if (handled) continue;
      }

      // Divider drag start: first vertical divider
      if (!ui.leftPanelCollapsed) {
        if (cx >= div1Col - 1 && cx <= div1Col + 1 && cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH) {
          ui.dragging = 'vertical';
          continue;
        }
      }
      // Divider drag start: second vertical divider (diff mode only)
      if (L.middleW > 0 && cx >= div2Col - 1 && cx <= div2Col + 1 && cy >= L.startRow + 2 && cy < L.startRow + 2 + L.bodyH) {
        ui.dragging = 'vertical2';
        continue;
      }
      // Horizontal divider drag start (log mode only)
      if (state.rightView === 'log' && ui.lastLogListH > 0) {
        const hDivRow = L.startRow + 2 + ui.lastLogListH;
        if (cy >= hDivRow - 1 && cy <= hDivRow + 1 && cx >= rightStart) {
          ui.dragging = 'horizontal';
          continue;
        }
      }

      // Click on hint bar buttons
      for (const area of ui.clickableAreas) {
        if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
          handleKey(actionToKey(area.action));
          break;
        }
      }

      // Click on left panel (clickMap-based)
      {
        const bodyRowIdx2 = cy - (L.startRow + 2);
        const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft && bodyRowIdx2 >= 0 && bodyRowIdx2 < ui.leftPanelClickMap.length) {
          const entry = ui.leftPanelClickMap[bodyRowIdx2];
          if (entry) {
            let leftHandled = true;
            if (entry.action === 'tab-local') {
              ui.leftPanelActiveBranch = null;
              state.rightView = 'diff';
              updateDiff();
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'tab-commits') {
              state.rightView = 'log';
              refreshLog();
              state.logCursor = 0;
              state.logScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateLogDetail();
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'toggle-section') {
              ui.collapsedSections[entry.section] = !ui.collapsedSections[entry.section];
              render();
            } else if (entry.action === 'toggle-group') {
              ui.collapsedGroups[entry.group] = !ui.collapsedGroups[entry.group];
              render();
            } else if (entry.action === 'goto-branch') {
              ui.leftPanelActiveBranch = entry.branch;
              if (state.rightView !== 'log') {
                state.rightView = 'log';
                refreshLog();
                state.logCursor = 0;
                state.logScrollOffset = 0;
                state.diffScrollOffset = 0;
                updateLogDetail();
              }
              const targetBranch = entry.branch;
              let foundIdx = -1;
              for (let si = 0; si < state.logItems.length; si++) {
                const item = state.logItems[si];
                if (item.type !== 'commit' || !item.decoration) continue;
                const refs = item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '').split(', ');
                for (const ref of refs) {
                  const cleaned = ref.startsWith('HEAD -> ') ? ref.substring(8) : ref;
                  if (cleaned === targetBranch) { foundIdx = si; break; }
                }
                if (foundIdx >= 0) break;
              }
              if (foundIdx >= 0) {
                const selectIdx = state.logSelectables.indexOf(foundIdx);
                if (selectIdx >= 0) {
                  state.logCursor = selectIdx;
                  state.diffScrollOffset = 0;
                  updateLogDetail();
                }
              }
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'goto-stash') {
              ui.leftPanelActiveBranch = 'stash:' + entry.shortHash;
              if (state.rightView !== 'log') {
                state.rightView = 'log';
                refreshLog();
                state.logCursor = 0;
                state.logScrollOffset = 0;
                state.diffScrollOffset = 0;
                updateLogDetail();
              }
              const targetHash = entry.shortHash;
              let foundIdx = -1;
              for (let si = 0; si < state.logItems.length; si++) {
                const item = state.logItems[si];
                if (item.type === 'commit' && item.ref === targetHash) { foundIdx = si; break; }
              }
              if (foundIdx >= 0) {
                const selectIdx = state.logSelectables.indexOf(foundIdx);
                if (selectIdx >= 0) {
                  state.logCursor = selectIdx;
                  state.diffScrollOffset = 0;
                  updateLogDetail();
                }
              }
              state.focusPanel = 'status';
              render();
            } else {
              leftHandled = false;
            }
            if (leftHandled) continue;
          }
        }
      }

      // Click on commit button zone
      if (ui.commitButtonZone && cy === ui.commitButtonZone.row && cx >= ui.commitButtonZone.colStart && cx <= ui.commitButtonZone.colEnd) {
        if (state.mode === 'commit' && state.commitMsg.trim().length > 0) {
          // Trigger commit
          handleCommitInput('\r');
        } else if (state.staged.length > 0 && state.mode !== 'commit') {
          state.mode = 'commit';
          state.commitMsg = '';
          render();
        }
        continue;
      }

      // Click on commit input row -> enter commit mode
      if (ui.commitInputRow > 0 && cy === ui.commitInputRow && cx >= rightStart && cx < L.startCol + L.width) {
        if (state.mode !== 'commit' && state.staged.length > 0) {
          state.mode = 'commit';
          state.commitMsg = '';
          render();
        }
        continue;
      }

      const bodyRowIdx = cy - (L.startRow + 2);
      const inMiddle = cx >= midStart && cx < midStart + L.middleW;
      const inRight = cx >= rightStart && cx < L.startCol + L.width;

      // Click on middle panel
      if (inMiddle && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
        if (state.rightView === 'log') {
          // Log list click
          const itemIdx = state.logScrollOffset + bodyRowIdx;
          const selectIdx = state.logSelectables.indexOf(itemIdx);
          if (selectIdx >= 0) {
            state.logCursor = selectIdx;
            state.diffScrollOffset = 0;
            updateLogDetail();
          }
        } else {
          // File header button click (Stage All / Unstage All)
          let headerHandled = false;
          for (const zone of ui.fileHeaderZones) {
            const visibleLineIdx = zone.lineIdx - state.scrollOffset;
            if (visibleLineIdx === bodyRowIdx) {
              const btnScreenColStart = midStart + zone.btnColStart;
              const btnScreenColEnd = midStart + zone.btnColEnd;
              if (cx >= btnScreenColStart && cx <= btnScreenColEnd) {
                if (zone.action === 'stageAll') {
                  gitStageAll(state.cwd);
                } else if (zone.action === 'unstageAll') {
                  gitUnstageAll(state.cwd);
                }
                refresh();
                render();
                headerHandled = true;
                break;
              }
            }
          }
          if (headerHandled) { continue; }
          // File list click
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
              state.cursor = fileIdx;
              ui.lastClickFileIdx = fileIdx;
              ui.lastClickTime = now;
            }
            updateDiff();
          }
        }
        state.focusPanel = 'status';
        render();
      }

      // Click on right panel
      if (inRight && bodyRowIdx >= 0 && bodyRowIdx < L.bodyH) {
        if (state.rightView === 'log') {
          // Log mode: top = log list, bottom = detail
          if (bodyRowIdx < ui.lastLogListH) {
            const itemIdx = state.logScrollOffset + bodyRowIdx;
            const selectIdx = state.logSelectables.indexOf(itemIdx);
            if (selectIdx >= 0) {
              state.logCursor = selectIdx;
              state.diffScrollOffset = 0;
              updateLogDetail();
            }
            state.focusPanel = 'status';
          } else {
            state.focusPanel = 'diff';
          }
        } else {
          state.focusPanel = 'diff';
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
