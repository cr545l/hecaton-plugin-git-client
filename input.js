const { ESC, CSI } = require('./ansi');
const { state, ui } = require('./state');
const { gitStage, gitUnstage, gitCommit, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip, gitCreateBranch, gitCreateTag, gitFetch, gitPull, gitPush, gitStashSave, gitStashRename, gitRemoteAdd, gitUnsetConfigLocal } = require('./git');
const { sendRpc, sendRpcNotify } = require('./rpc');
const { buildFileList, selectedItem, selectedLogRef, refresh, refreshLog, updateLogDetail, updateDiff, FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail } = require('./refresh');
const { render } = require('./render');
const { registerHistoryContextMenu, registerStashContextMenu, registerFileContextMenu, registerRemotesContextMenu, registerTabContextMenu, unregisterContextMenu } = require('./context-menu');

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

function showErrorDialog(msg) {
  state.error = null;
  sendRpc('show_dialog', {
    type: 'message',
    title: 'Error',
    message: msg,
    buttons: [{ id: 'ok', label: 'OK' }],
  });
}

function handleKey(key) {
  // Fresh time window mode intercept
  if (state.freshTimeWindowMode) {
    if (key === CSI + 'D' || key === 'h') { // Left
      state.freshTimeWindow = Math.max(0, state.freshTimeWindow - 1);
      render();
    } else if (key === CSI + 'C' || key === 'l') { // Right
      state.freshTimeWindow = Math.min(FRESH_TIME_WINDOWS.length - 1, state.freshTimeWindow + 1);
      render();
    } else if (key === '\r' || key === '\n') { // Enter
      state.freshTimeWindowMode = false;
      refreshFresh();
      state.diffScrollOffset = 0;
      updateFreshDetail();
      render();
    } else if (key === ESC || key === '\x1b') { // Esc
      state.freshTimeWindowMode = false;
      render();
    }
    return;
  }
  if (state.mode === 'rebase-menu') {
    handleRebaseMenuInput(key);
    return;
  }
  if (state.mode === 'commit') {
    handleCommitInput(key);
    return;
  }
  if (state.mode === 'new-branch' || state.mode === 'new-tag' || state.mode === 'rename-stash' || state.mode === 'new-remote') {
    handleNameInput(key);
    return;
  }

  // Arrow keys (VT sequences)
  if (key === CSI + 'A' || key === 'k') { // Up
    if (state.focusPanel === 'status') {
      if (state.rightView === 'fresh') {
        if (state.freshItems.length > 0) {
          state.freshCursor = Math.max(0, state.freshCursor - 1);
          state.diffScrollOffset = 0;
          updateFreshDetail();
        }
      } else if (state.rightView === 'log') {
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
      if (state.rightView === 'fresh') {
        if (state.freshItems.length > 0) {
          state.freshCursor = Math.min(state.freshItems.length - 1, state.freshCursor + 1);
          state.diffScrollOffset = 0;
          updateFreshDetail();
        }
      } else if (state.rightView === 'log') {
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

  // Ctrl+A: select all / deselect all in cursor's group (diff view only)
  if (key === '\x01' && state.rightView !== 'log' && state.rightView !== 'fresh') {
    const list = buildFileList();
    if (list.length > 0) {
      const unstagedCount = state.unstaged.length + state.untracked.length;
      const cursorInUnstaged = state.cursor < unstagedCount;
      const groupStart = cursorInUnstaged ? 0 : unstagedCount;
      const groupEnd = cursorInUnstaged ? unstagedCount : list.length;
      const groupSize = groupEnd - groupStart;
      // Check if all in this group are already selected
      let allSelected = groupSize > 0;
      for (let i = groupStart; i < groupEnd; i++) {
        if (!state.selectedFiles.has(i)) { allSelected = false; break; }
      }
      state.selectedFiles.clear();
      if (!allSelected) {
        for (let i = groupStart; i < groupEnd; i++) state.selectedFiles.add(i);
      }
    }
    render();
    return;
  }

  switch (key) {
    case 's': {
      if (state.rightView === 'log') break;
      const fileList = buildFileList();
      const targets = state.selectedFiles.size > 0
        ? Array.from(state.selectedFiles).sort((a, b) => a - b)
        : (fileList.length > 0 ? [Math.min(state.cursor, fileList.length - 1)] : []);
      for (const idx of targets) {
        const item = fileList[idx];
        if (item && item.type !== 'staged') {
          gitStage(state.cwd, item.file);
        }
      }
      if (targets.length > 0) {
        state.selectedFiles.clear();
        refresh();
      }
      render();
      break;
    }
    case 'u': {
      if (state.rightView === 'log') break;
      const fileList = buildFileList();
      const targets = state.selectedFiles.size > 0
        ? Array.from(state.selectedFiles).sort((a, b) => a - b)
        : (fileList.length > 0 ? [Math.min(state.cursor, fileList.length - 1)] : []);
      for (const idx of targets) {
        const item = fileList[idx];
        if (item && item.type === 'staged') {
          gitUnstage(state.cwd, item.file);
        }
      }
      if (targets.length > 0) {
        state.selectedFiles.clear();
        refresh();
      }
      render();
      break;
    }
    case 'c': {
      if (state.staged.length === 0) {
        showErrorDialog('Nothing staged to commit');
        render();
        break;
      }
      state.mode = 'commit';
      state.commitMsg = '';
      state.commitCursor = 0;
      render();
      break;
    }
    case 'l':
    case 'L': {
      if (state.rightView === 'diff') {
        state.rightView = 'log';
        refreshLog();
        state.logCursor = 0;
        state.logScrollOffset = 0;
        state.diffScrollOffset = 0;
        updateLogDetail();
      } else if (state.rightView === 'log') {
        state.rightView = 'fresh';
        refreshFresh();
        state.freshCursor = 0;
        state.freshScrollOffset = 0;
        state.diffScrollOffset = 0;
        updateFreshDetail();
        unregisterContextMenu();
      } else {
        state.rightView = 'diff';
        updateDiff();
        unregisterContextMenu();
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
          showErrorDialog('Select a commit in log view to rebase onto');
          render();
          break;
        }
        if (state.staged.length > 0 || state.unstaged.length > 0) {
          state.pendingRebaseRef = logItem.ref;
          sendRpc('show_dialog', {
            type: 'message',
            title: 'Rebase',
            message: 'You have uncommitted local changes.\nWould you like to stash them, rebase, and then reapply?',
            buttons: [
              { id: 'stash_rebase', label: 'Stash & Rebase' },
              { id: 'cancel', label: 'Cancel' },
            ],
          });
        } else {
          const err = gitRebase(state.cwd, logItem.ref);
          refresh();
          if (state.rightView === 'log') refreshLog();
          if (err) {
            showErrorDialog(err);
            render();
          } else {
            render();
          }
        }
      }
      break;
    }
    case 'w': {
      if (state.rightView === 'fresh') {
        state.freshTimeWindowMode = true;
        render();
      }
      break;
    }
    case 'r':
    case 'R': {
      refresh();
      if (state.rightView === 'log') refreshLog();
      if (state.rightView === 'fresh') {
        refreshFresh();
        updateFreshDetail();
      }
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

function prevCharIndex(str, idx) {
  if (idx <= 0) return 0;
  if (idx >= 2) {
    const lo = str.charCodeAt(idx - 1);
    const hi = str.charCodeAt(idx - 2);
    if (lo >= 0xDC00 && lo <= 0xDFFF && hi >= 0xD800 && hi <= 0xDBFF) return idx - 2;
  }
  return idx - 1;
}

function nextCharIndex(str, idx) {
  if (idx >= str.length) return str.length;
  const hi = str.charCodeAt(idx);
  if (hi >= 0xD800 && hi <= 0xDBFF && idx + 1 < str.length) return idx + 2;
  return idx + 1;
}

function handleCommitInput(key) {
  // IME 입력과 이스케이프 시퀀스가 하나의 청크로 합쳐진 경우 분리 처리
  // (예: "최적화\x1b[13;5u" → "최적화" + "\x1b[13;5u")
  const escIdx = key.indexOf('\x1b');
  if (escIdx > 0) {
    handleCommitInput(key.substring(0, escIdx));
    if (state.mode === 'commit') {
      handleCommitInput(key.substring(escIdx));
    }
    return;
  }
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    state.commitMsg = '';
    state.commitCursor = 0;
    render();
    return;
  }
  // Ctrl+Enter → submit commit
  if (key === CSI + '13;5u') {
    if (state.commitMsg.trim().length === 0) {
      showErrorDialog('Commit message cannot be empty');
      render();
      return;
    }
    const err = gitCommit(state.cwd, state.commitMsg);
    state.mode = 'normal';
    if (err) {
      showErrorDialog(err);
      render();
    } else {
      state.commitMsg = '';
      state.commitCursor = 0;
      refresh();
      render();
    }
    return;
  }
  // Ctrl+C → clear commit message
  if (key === '\x03') {
    state.commitMsg = '';
    state.commitCursor = 0;
    render();
    return;
  }
  // Enter → insert newline
  if (key === '\r' || key === '\n') {
    state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + '\n' + state.commitMsg.substring(state.commitCursor);
    state.commitCursor += 1;
    render();
    return;
  }
  // Up arrow → move to previous line
  if (key === CSI + 'A') {
    const before = state.commitMsg.substring(0, state.commitCursor);
    const lastNL = before.lastIndexOf('\n');
    if (lastNL === -1) { render(); return; }
    const col = state.commitCursor - lastNL - 1;
    const prevLineStart = before.lastIndexOf('\n', lastNL - 1) + 1;
    const prevLineLen = lastNL - prevLineStart;
    state.commitCursor = prevLineStart + Math.min(col, prevLineLen);
    render();
    return;
  }
  // Down arrow → move to next line
  if (key === CSI + 'B') {
    const after = state.commitMsg.substring(state.commitCursor);
    const nextNL = after.indexOf('\n');
    if (nextNL === -1) { render(); return; }
    const lineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
    const col = state.commitCursor - lineStart;
    const nextLineStart = state.commitCursor + nextNL + 1;
    const nextNL2 = state.commitMsg.indexOf('\n', nextLineStart);
    const nextLineLen = nextNL2 === -1 ? state.commitMsg.length - nextLineStart : nextNL2 - nextLineStart;
    state.commitCursor = nextLineStart + Math.min(col, nextLineLen);
    render();
    return;
  }
  // Left arrow
  if (key === CSI + 'D') {
    if (state.commitCursor > 0) {
      state.commitCursor = prevCharIndex(state.commitMsg, state.commitCursor);
    }
    render();
    return;
  }
  // Right arrow
  if (key === CSI + 'C') {
    if (state.commitCursor < state.commitMsg.length) {
      state.commitCursor = nextCharIndex(state.commitMsg, state.commitCursor);
    }
    render();
    return;
  }
  // Home → start of current line
  if (key === CSI + 'H' || key === CSI + '1~') {
    const lineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
    state.commitCursor = lineStart;
    render();
    return;
  }
  // End → end of current line
  if (key === CSI + 'F' || key === CSI + '4~') {
    const nextNL = state.commitMsg.indexOf('\n', state.commitCursor);
    state.commitCursor = nextNL === -1 ? state.commitMsg.length : nextNL;
    render();
    return;
  }
  // Backspace – delete character before cursor
  if (key === '\x7f' || key === '\b') {
    if (state.commitCursor > 0) {
      const prev = prevCharIndex(state.commitMsg, state.commitCursor);
      state.commitMsg = state.commitMsg.substring(0, prev) + state.commitMsg.substring(state.commitCursor);
      state.commitCursor = prev;
    }
    render();
    return;
  }
  // Delete key – delete character after cursor
  if (key === CSI + '3~') {
    if (state.commitCursor < state.commitMsg.length) {
      const next = nextCharIndex(state.commitMsg, state.commitCursor);
      state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + state.commitMsg.substring(next);
    }
    render();
    return;
  }
  // Regular character
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + key + state.commitMsg.substring(state.commitCursor);
    state.commitCursor += key.length;
    render();
    return;
  }
  // Multi-byte character (IME input / paste)
  if (key.length > 1 && !key.startsWith('\x1b')) {
    const clean = key.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (clean.length === 0) return;
    state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + clean + state.commitMsg.substring(state.commitCursor);
    state.commitCursor += clean.length;
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
    if (err) {
      showErrorDialog(err);
    }
    render();
    return;
  }
  if (key === 'a') {
    state.mode = 'normal';
    const err = gitRebaseAbort(state.cwd);
    refresh();
    if (state.rightView === 'log') refreshLog();
    if (err) {
      showErrorDialog(err);
    }
    render();
    return;
  }
  if (key === 's') {
    state.mode = 'normal';
    const err = gitRebaseSkip(state.cwd);
    refresh();
    if (state.rightView === 'log') refreshLog();
    if (err) {
      showErrorDialog(err);
    }
    render();
    return;
  }
}

function handleNameInput(key) {
  // IME 입력과 이스케이프 시퀀스가 하나의 청크로 합쳐진 경우 분리 처리
  const escIdx = key.indexOf('\x1b');
  if (escIdx > 0) {
    handleNameInput(key.substring(0, escIdx));
    if (state.mode === 'new-branch' || state.mode === 'new-tag' || state.mode === 'rename-stash' || state.mode === 'new-remote') {
      handleNameInput(key.substring(escIdx));
    }
    return;
  }
  if (key === ESC || key === '\x1b') {
    state.mode = 'normal';
    state.inputBuffer = '';
    state.inputTarget = '';
    render();
    return;
  }
  if (key === '\r' || key === '\n') {
    const name = state.inputBuffer.trim();
    if (name.length === 0) {
      showErrorDialog('Name cannot be empty');
      render();
      return;
    }
    let err;
    if (state.mode === 'rename-stash') {
      err = gitStashRename(state.cwd, state.inputTarget, name);
    } else if (state.mode === 'new-remote') {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        showErrorDialog('Use: <remote-name> <remote-url>');
        render();
        return;
      }
      const remoteName = parts.shift();
      const remoteUrl = parts.join(' ');
      err = gitRemoteAdd(state.cwd, remoteName, remoteUrl);
    } else if (state.mode === 'new-branch') {
      err = gitCreateBranch(state.cwd, name, state.inputTarget);
    } else {
      err = gitCreateTag(state.cwd, name, state.inputTarget);
    }
    const opName = state.mode === 'rename-stash'
      ? 'Rename stash'
      : state.mode === 'new-remote'
        ? 'Remote'
        : state.mode === 'new-branch'
          ? 'Branch'
          : 'Tag';
    state.mode = 'normal';
    state.inputBuffer = '';
    state.inputTarget = '';
    if (err) {
      showErrorDialog(opName + ' failed:\n' + err);
      render();
    } else {
      refresh();
      if (state.rightView === 'log') refreshLog();
      render();
    }
    return;
  }
  if (key === '\x7f' || key === '\b' || key === CSI + '3~') {
    state.inputBuffer = state.inputBuffer.slice(0, -1);
    render();
    return;
  }
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.inputBuffer += key;
    render();
    return;
  }
  if (key.length > 1 && !key.startsWith('\x1b')) {
    state.inputBuffer += key;
    render();
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
    const titleH = (L.titleRows || 2) + 1; // title rows + separator
    const bodyTop = L.startRow + titleH;
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
      if (cy >= L.startRow && cy < bodyTop) {
        for (let i = 0; i < ui.titleClickZones.length; i++) {
          const zone = ui.titleClickZones[i];
          if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
            newTitleHover = i;
            break;
          }
        }
      }
      // Context menu: tab buttons (Local, Commits, Fresh)
      {
        let onTab = false;
        if (newTitleHover >= 0 && newTitleHover < ui.titleClickZones.length) {
          const act = ui.titleClickZones[newTitleHover].action;
          if (act === 'tab-local' || act === 'tab-commits' || act === 'tab-fresh') {
            onTab = true;
            if (!ui.contextMenuTab) {
              registerTabContextMenu();
            }
          }
        }
        if (!onTab && ui.contextMenuTab) {
          unregisterContextMenu();
        }
      }
      let newDivHover = null;
      const inBody = cy >= bodyTop && cy < bodyTop + L.bodyH;
      if (!ui.leftPanelCollapsed && inBody) {
        if (cx >= div1Col - 1 && cx <= div1Col + 1) {
          newDivHover = 'vertical';
        }
      }
      if (L.middleW > 0 && inBody && cx >= div2Col - 1 && cx <= div2Col + 1) {
        newDivHover = 'vertical2';
      }
      if ((state.rightView === 'log' || state.rightView === 'fresh') && inBody) {
        const hListH = state.rightView === 'fresh' ? ui.lastFreshListH : ui.lastLogListH;
        if (hListH > 0) {
          const hDivRow = bodyTop + hListH;
          if (cy >= hDivRow - 1 && cy <= hDivRow + 1 && cx >= rightStart) {
            newDivHover = 'horizontal';
          }
        }
      }
      // Hover: file header buttons ([Stage] / [Unstage])
      let newFileHeaderHover = -1;
      if (state.rightView !== 'log' && state.rightView !== 'fresh' && inBody) {
        const bodyRowIdx = cy - (bodyTop);
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
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.leftPanelClickMap.length && ui.leftPanelClickMap[bodyRowIdx]) {
            newLeftPanelHover = bodyRowIdx;
          }
        }
      }

      // Context menu: stash items in left panel
      if (!ui.leftPanelCollapsed && inBody) {
        const inLeft = cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft) {
          const bodyRowIdx2 = cy - (bodyTop);
          const entry = bodyRowIdx2 >= 0 && bodyRowIdx2 < ui.leftPanelClickMap.length ? ui.leftPanelClickMap[bodyRowIdx2] : null;
          if (entry && entry.action === 'goto-stash') {
            const stashRef = entry.ref;
            if (!ui.contextMenuActive || ui.contextMenuStashRef !== stashRef) {
              registerStashContextMenu(stashRef);
            }
          } else if (ui.contextMenuStashRef && inLeft) {
            unregisterContextMenu();
          }
        }
      }

      // Context menu: only active when mouse is over the history list area
      if (state.rightView === 'log') {
        const bodyRowIdx = cy - (bodyTop);
        const inHistoryList = inBody && cx >= rightStart && cx < L.startCol + L.width &&
          bodyRowIdx >= 0 && bodyRowIdx < ui.lastLogListH;
        if (inHistoryList && (!ui.contextMenuActive || ui.contextMenuStashRef || ui.contextMenuFileItem)) {
          registerHistoryContextMenu();
        } else if (!inHistoryList && ui.contextMenuActive && !ui.contextMenuStashRef) {
          unregisterContextMenu();
        }
      }

      // Hover: fresh window button
      let newFreshWindowHover = false;
      if (state.rightView === 'fresh' && inBody && ui.freshWindowZone) {
        const bodyRowIdx = cy - bodyTop;
        if (bodyRowIdx === ui.freshWindowZone.lineIdx) {
          const relCol = cx - rightStart;
          if (relCol >= ui.freshWindowZone.colStart && relCol <= ui.freshWindowZone.colEnd) {
            newFreshWindowHover = true;
          }
        }
      }

      if (newHover !== ui.hoveredAreaIndex || newTitleHover !== ui.hoveredTitleZoneIndex || newDivHover !== ui.hoveredDivider || newFileHeaderHover !== ui.hoveredFileHeaderIdx || newLeftPanelHover !== ui.hoveredLeftPanelRow || newFreshWindowHover !== ui.hoveredFreshWindow) {
        ui.hoveredAreaIndex = newHover;
        ui.hoveredTitleZoneIndex = newTitleHover;
        ui.hoveredDivider = newDivHover;
        ui.hoveredFileHeaderIdx = newFileHeaderHover;
        ui.hoveredLeftPanelRow = newLeftPanelHover;
        ui.hoveredFreshWindow = newFreshWindowHover;
        render();
      }
      continue;
    }

    if (isRelease) {
      if (ui.dragging !== null) ui.dragging = null;
      continue;
    }

    // Ctrl+Left click: toggle file selection (same group only)
    if (cb === 16) {
      const bodyRowIdx = cy - (bodyTop);
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      if (state.rightView !== 'log' && inMiddle && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
        const fileIdx = ui.fileLineMap[bodyRowIdx];
        const unstagedCount = state.unstaged.length + state.untracked.length;
        const clickedInUnstaged = fileIdx < unstagedCount;
        // Enforce same-group constraint
        if (state.selectedFiles.size > 0) {
          const firstSel = state.selectedFiles.values().next().value;
          if ((firstSel < unstagedCount) !== clickedInUnstaged) {
            state.selectedFiles.clear();
          }
        }
        if (state.selectedFiles.has(fileIdx)) {
          state.selectedFiles.delete(fileIdx);
        } else {
          state.selectedFiles.add(fileIdx);
        }
        state.focusPanel = 'status';
        render();
      }
      continue;
    }

    // Shift+Left click: range selection (same group only)
    if (cb === 4) {
      const bodyRowIdx = cy - (bodyTop);
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      if (state.rightView !== 'log' && inMiddle && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
        const fileIdx = ui.fileLineMap[bodyRowIdx];
        const unstagedCount = state.unstaged.length + state.untracked.length;
        const clickedInUnstaged = fileIdx < unstagedCount;
        const groupStart = clickedInUnstaged ? 0 : unstagedCount;
        const groupEnd = clickedInUnstaged ? unstagedCount : buildFileList().length;
        const anchor = Math.max(groupStart, Math.min(groupEnd - 1, state.cursor));
        const from = Math.max(groupStart, Math.min(anchor, fileIdx));
        const to = Math.min(groupEnd - 1, Math.max(anchor, fileIdx));
        state.selectedFiles.clear();
        for (let i = from; i <= to; i++) state.selectedFiles.add(i);
        state.focusPanel = 'status';
        render();
      }
      continue;
    }

    // Scroll wheel
    if (cb === 64 || cb === 65) {
      const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      const inRight = cx >= rightStart && cx < L.startCol + L.width;
      const inBody = cy >= bodyTop && cy < bodyTop + L.bodyH;
      if (inBody && inLeft) {
        const prev = ui.leftPanelScrollOffset;
        if (cb === 64) ui.leftPanelScrollOffset = Math.max(0, ui.leftPanelScrollOffset - 3);
        else ui.leftPanelScrollOffset = Math.min(ui.leftMaxScroll || 0, ui.leftPanelScrollOffset + 3);
        if (ui.leftPanelScrollOffset !== prev) render();
      } else if (inBody && inMiddle) {
        // Middle panel (diff mode only): file list scroll
        const list = buildFileList();
        if (list.length > 0) {
          const prev = state.cursor;
          if (cb === 64) state.cursor = Math.max(0, state.cursor - 3);
          else state.cursor = Math.min(list.length - 1, state.cursor + 3);
          if (state.cursor !== prev) {
            updateDiff();
            state.focusPanel = 'status';
            render();
          }
        }
      } else if (inBody && inRight) {
        let changed = false;
        if (state.rightView === 'fresh') {
          // Fresh mode: top = file list scroll, bottom = detail scroll
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx < ui.lastFreshListH) {
            if (state.freshItems.length > 0) {
              const prev = state.freshCursor;
              if (cb === 64) state.freshCursor = Math.max(0, state.freshCursor - 3);
              else state.freshCursor = Math.min(state.freshItems.length - 1, state.freshCursor + 3);
              if (state.freshCursor !== prev) {
                state.diffScrollOffset = 0;
                updateFreshDetail();
                changed = true;
              }
            }
            state.focusPanel = 'status';
          } else {
            const prev = state.diffScrollOffset;
            const maxDiff = Math.max(0, state.freshDetailLines.length - Math.max(1, Math.floor((L.bodyH - 2) * (1 - ui.logListRatio)) - 1));
            if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
            else state.diffScrollOffset = Math.min(maxDiff, state.diffScrollOffset + 3);
            if (state.diffScrollOffset !== prev) changed = true;
            state.focusPanel = 'diff';
          }
        } else if (state.rightView === 'log') {
          // Log mode: top = log scroll, bottom = detail scroll
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx < ui.lastLogListH) {
            if (state.logSelectables.length > 0) {
              const prev = state.logCursor;
              if (cb === 64) state.logCursor = Math.max(0, state.logCursor - 3);
              else state.logCursor = Math.min(state.logSelectables.length - 1, state.logCursor + 3);
              if (state.logCursor !== prev) {
                state.diffScrollOffset = 0;
                updateLogDetail();
                changed = true;
              }
            }
            state.focusPanel = 'status';
          } else {
            const prev = state.diffScrollOffset;
            const maxDiff = Math.max(0, (ui.filteredDetailCount || state.logDetailLines.length) - (ui.lastDetailContentH || 1));
            if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
            else state.diffScrollOffset = Math.min(maxDiff, state.diffScrollOffset + 3);
            if (state.diffScrollOffset !== prev) changed = true;
            state.focusPanel = 'diff';
          }
        } else {
          // Diff mode: diff scroll
          const prev = state.diffScrollOffset;
          const maxDiff = Math.max(0, state.diffLines.length - (ui.rightDiffH || 1));
          if (cb === 64) state.diffScrollOffset = Math.max(0, state.diffScrollOffset - 3);
          else state.diffScrollOffset = Math.min(maxDiff, state.diffScrollOffset + 3);
          if (state.diffScrollOffset !== prev) changed = true;
          state.focusPanel = 'diff';
        }
        if (changed) render();
      }
      continue;
    }

    // Left click
    if (cb === 0) {
      // Title rows click
      if (cy >= L.startRow && cy < bodyTop) {
        let handled = false;
        for (const zone of ui.titleClickZones) {
          if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
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
            } else if (zone.action === 'toggleFiles') {
              ui.middlePanelCollapsed = !ui.middlePanelCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'toggleDiff') {
              ui.rightPanelCollapsed = !ui.rightPanelCollapsed;
              render();
              handled = true;
            } else if (zone.action === 'tab-local') {
              ui.leftPanelActiveBranch = null;
              state.rightView = 'diff';
              updateDiff();
              unregisterContextMenu();
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'tab-commits') {
              state.rightView = 'log';
              refreshLog();
              state.logCursor = 0;
              state.logScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateLogDetail();
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'tab-fresh') {
              state.rightView = 'fresh';
              refreshFresh();
              state.freshCursor = 0;
              state.freshScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateFreshDetail();
              unregisterContextMenu();
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'git-fetch') {
              state.error = 'Fetching...';
              render();
              const err = gitFetch(state.cwd);
              if (err) {
                showErrorDialog(err);
                render();
              } else {
                state.error = null;
                refresh();
                render();
              }
              handled = true;
            } else if (zone.action === 'git-pull') {
              state.error = 'Pulling...';
              render();
              const err = gitPull(state.cwd);
              if (err) {
                showErrorDialog(err);
                render();
              } else {
                state.error = null;
                refresh();
                render();
              }
              handled = true;
            } else if (zone.action === 'git-push') {
              state.error = 'Pushing...';
              render();
              const err = gitPush(state.cwd);
              if (err) {
                showErrorDialog(err);
                render();
              } else {
                state.error = null;
                refresh();
                render();
              }
              handled = true;
            } else if (zone.action === 'git-stash') {
              const err = gitStashSave(state.cwd);
              if (err) {
                showErrorDialog(err);
                render();
              } else {
                refresh();
                render();
              }
              handled = true;
            } else if (zone.action === 'reset-committer-name') {
              const err = gitUnsetConfigLocal(state.cwd, 'user.name');
              if (err) {
                showErrorDialog(err);
              } else {
                refresh();
              }
              render();
              handled = true;
            } else if (zone.action === 'reset-committer-email') {
              const err = gitUnsetConfigLocal(state.cwd, 'user.email');
              if (err) {
                showErrorDialog(err);
              } else {
                refresh();
              }
              render();
              handled = true;
            } else if (zone.action === 'committer-name') {
              state.pendingCommitterEdit = 'name';
              sendRpc('show_dialog', {
                type: 'input',
                title: 'Committer Name',
                message: 'Enter name for local git commits:',
                defaultValue: state.committerName || '',
                buttons: [
                  { id: 'ok', label: 'OK' },
                  { id: 'cancel', label: 'Cancel' },
                ],
              });
              handled = true;
            } else if (zone.action === 'committer-email') {
              state.pendingCommitterEdit = 'email';
              sendRpc('show_dialog', {
                type: 'input',
                title: 'Committer Email',
                message: 'Enter email for local git commits:',
                defaultValue: state.committerEmail || '',
                buttons: [
                  { id: 'ok', label: 'OK' },
                  { id: 'cancel', label: 'Cancel' },
                ],
              });
              handled = true;
            }
            break;
          }
        }
        if (handled) continue;
      }

      // Divider drag start: first vertical divider
      if (!ui.leftPanelCollapsed) {
        if (cx >= div1Col - 1 && cx <= div1Col + 1 && cy >= bodyTop && cy < bodyTop + L.bodyH) {
          ui.dragging = 'vertical';
          continue;
        }
      }
      // Divider drag start: second vertical divider (diff mode only)
      if (L.middleW > 0 && cx >= div2Col - 1 && cx <= div2Col + 1 && cy >= bodyTop && cy < bodyTop + L.bodyH) {
        ui.dragging = 'vertical2';
        continue;
      }
      // Horizontal divider drag start (log/fresh mode)
      if (state.rightView === 'log' || state.rightView === 'fresh') {
        const hListH = state.rightView === 'fresh' ? ui.lastFreshListH : ui.lastLogListH;
        if (hListH > 0) {
          const hDivRow = bodyTop + hListH;
          if (cy >= hDivRow - 1 && cy <= hDivRow + 1 && cx >= rightStart) {
            ui.dragging = 'horizontal';
            continue;
          }
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
        const bodyRowIdx2 = cy - (bodyTop);
        const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft && bodyRowIdx2 >= 0 && bodyRowIdx2 < ui.leftPanelClickMap.length) {
          const entry = ui.leftPanelClickMap[bodyRowIdx2];
          if (entry) {
            let leftHandled = true;
            if (entry.action === 'tab-local') {
              ui.leftPanelActiveBranch = null;
              state.rightView = 'diff';
              updateDiff();
              unregisterContextMenu();
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
            } else if (entry.action === 'tab-fresh') {
              state.rightView = 'fresh';
              refreshFresh();
              state.freshCursor = 0;
              state.freshScrollOffset = 0;
              state.diffScrollOffset = 0;
              updateFreshDetail();
              unregisterContextMenu();
              state.focusPanel = 'status';
              render();
            } else if (entry.action === 'toggle-section') {
              ui.collapsedSections[entry.section] = !ui.collapsedSections[entry.section];
              render();
            } else if (entry.action === 'toggle-group') {
              ui.collapsedGroups[entry.group] = !ui.collapsedGroups[entry.group];
              render();
            } else if (entry.action === 'goto-branch') {
              if (state.remoteBranches.includes(entry.branch)) {
                ui.remoteRecentBranchUsage[entry.branch] = Date.now();
              }
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
          // Trigger commit via button click
          handleCommitInput(CSI + '13;5u');
        } else if (state.staged.length > 0 && state.mode !== 'commit') {
          state.mode = 'commit';
          state.commitMsg = '';
          state.commitCursor = 0;
          render();
        }
        continue;
      }

      // Click on commit input row -> enter commit mode
      if (ui.commitInputRow > 0 && cy === ui.commitInputRow && cx >= rightStart && cx < L.startCol + L.width) {
        if (state.mode !== 'commit' && state.staged.length > 0) {
          state.mode = 'commit';
          state.commitMsg = '';
          state.commitCursor = 0;
          render();
        }
        continue;
      }

      const bodyRowIdx = cy - (bodyTop);
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
          // File header button click ([Stage] / [Unstage])
          let headerHandled = false;
          for (const zone of ui.fileHeaderZones) {
            const visibleLineIdx = zone.lineIdx - state.scrollOffset;
            if (visibleLineIdx === bodyRowIdx) {
              const btnScreenColStart = midStart + zone.btnColStart;
              const btnScreenColEnd = midStart + zone.btnColEnd;
              if (cx >= btnScreenColStart && cx <= btnScreenColEnd) {
                const fileList = buildFileList();
                const targets = state.selectedFiles.size > 0
                  ? Array.from(state.selectedFiles).sort((a, b) => a - b)
                  : (fileList.length > 0 ? [Math.min(state.cursor, fileList.length - 1)] : []);
                for (const idx of targets) {
                  const item = fileList[idx];
                  if (zone.action === 'stageSelected') {
                    if (item && item.type !== 'staged') gitStage(state.cwd, item.file);
                  } else if (zone.action === 'unstageSelected') {
                    if (item && item.type === 'staged') gitUnstage(state.cwd, item.file);
                  }
                }
                if (targets.length > 0) {
                  state.selectedFiles.clear();
                  refresh();
                }
                render();
                headerHandled = true;
                break;
              }
            }
          }
          if (headerHandled) { continue; }
          // File list click
          if (bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
            state.selectedFiles.clear();
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
        if (state.rightView === 'fresh') {
          // Fresh mode: check window button click first
          if (ui.freshWindowZone && bodyRowIdx === ui.freshWindowZone.lineIdx) {
            const relCol = cx - rightStart;
            if (relCol >= ui.freshWindowZone.colStart && relCol <= ui.freshWindowZone.colEnd) {
              state.freshTimeWindow = (state.freshTimeWindow + 1) % FRESH_TIME_WINDOWS.length;
              refreshFresh();
              state.diffScrollOffset = 0;
              updateFreshDetail();
              render();
              continue;
            }
          }
          // Fresh mode: top = file list, bottom = detail
          if (bodyRowIdx < ui.lastFreshListH) {
            const mapIdx = bodyRowIdx;
            if (mapIdx >= 0 && mapIdx < ui.freshFileLineMap.length && ui.freshFileLineMap[mapIdx] >= 0) {
              state.freshCursor = ui.freshFileLineMap[mapIdx];
              state.diffScrollOffset = 0;
              updateFreshDetail();
            }
            state.focusPanel = 'status';
          } else {
            state.focusPanel = 'diff';
          }
        } else if (state.rightView === 'log') {
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
            // Detail area: check for file header toggle click
            const detailRowIdx = bodyRowIdx - ui.lastLogListH - 1 - 1; // -separator -refs line
            if (detailRowIdx >= 0 && detailRowIdx < ui.detailFileHeaderMap.length) {
              const file = ui.detailFileHeaderMap[detailRowIdx];
              if (file) {
                if (ui.collapsedDetailFiles.has(file)) {
                  ui.collapsedDetailFiles.delete(file);
                } else {
                  ui.collapsedDetailFiles.add(file);
                }
              }
            }
            state.focusPanel = 'diff';
          }
        } else {
          state.focusPanel = 'diff';
        }
        render();
      }
    }

    // Right click - update selection for context menu
    if (cb === 2) {
      // Right-click on left panel stash item
      if (!ui.leftPanelCollapsed) {
        const bodyRowIdx = cy - (bodyTop);
        const inLeft = cx >= L.startCol && cx < L.startCol + L.leftW;
        if (inLeft && bodyRowIdx >= 0 && bodyRowIdx < ui.leftPanelClickMap.length) {
          const entry = ui.leftPanelClickMap[bodyRowIdx];
          if (isRemoteMenuTarget(entry)) {
            registerRemotesContextMenu();
            render();
            continue;
          }
          if (entry && entry.action === 'goto-stash' && entry.ref) {
            registerStashContextMenu(entry.ref);
            // Also select the stash
            ui.leftPanelActiveBranch = 'stash:' + entry.shortHash;
            render();
            continue;
          }
        }
      }
      if (state.rightView === 'log') {
        const bodyRowIdx = cy - (bodyTop);
        const rightStart2 = midStart + L.middleW + L.divider2W;
        const inRight2 = cx >= rightStart2 && cx < L.startCol + L.width;
        if (inRight2 && bodyRowIdx >= 0 && bodyRowIdx < ui.lastLogListH) {
          const itemIdx = state.logScrollOffset + bodyRowIdx;
          const selectIdx = state.logSelectables.indexOf(itemIdx);
          if (selectIdx >= 0) {
            state.logCursor = selectIdx;
            state.diffScrollOffset = 0;
            updateLogDetail();
            state.focusPanel = 'status';
            render();
          }
        }
      } else {
        // Diff mode: right-click on file list updates cursor
        const bodyRowIdx = cy - (bodyTop);
        const inMiddle2 = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
        if (inMiddle2 && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
          const fileIdx = ui.fileLineMap[bodyRowIdx];
          const fileList = buildFileList();
          const item = fileList[fileIdx];
          state.cursor = fileIdx;
          updateDiff();
          state.focusPanel = 'status';
          if (item) {
            // If right-clicked file is not in current selection, scope context menu to it.
            if (!state.selectedFiles.has(fileIdx)) {
              state.selectedFiles.clear();
              state.selectedFiles.add(fileIdx);
            }
            const targets = Array.from(state.selectedFiles)
              .sort((a, b) => a - b)
              .map((idx) => fileList[idx])
              .filter(Boolean);
            registerFileContextMenu(item, targets);
          }
          render();
          continue;
        }
      }
    }
  }
  return hadMouse;
}

function cleanup() {
  process.stdout.write(CSI + '?7h' + require('./ansi').ansi.showCursor + require('./ansi').ansi.reset + require('./ansi').ansi.clear);
}

function isRemoteMenuTarget(entry) {
  if (!entry) return false;
  if (entry.action === 'toggle-section' && entry.section === 'remotes') return true;
  if (entry.action === 'toggle-group' && typeof entry.group === 'string' && entry.group.startsWith('r:')) return true;
  if (entry.action === 'goto-branch' && state.remoteBranches.includes(entry.branch)) return true;
  return false;
}

module.exports = { handleKey, handleMouseData, actionToKey, cleanup };
