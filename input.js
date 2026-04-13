const { ESC, CSI, ansi } = require('./ansi');
const { state, ui } = require('./state');
const { gitStage, gitUnstage, gitStashSave, gitUnsetConfigLocal,
  gitCommitAsync, gitFetchAsync, gitPullAsync, gitPushAsync, gitPushToRemoteAsync,
  gitRebaseAsync, gitRebaseContinueAsync, gitRebaseAbortAsync, gitRebaseSkipAsync,
  gitStageAsync, gitUnstageAsync, gitStageMultiple, gitUnstageMultiple,
  gitWriteRebaseMessage, gitCheckRebaseConflicts, gitWriteConflictResolution,
} = require('./git');
const { startSpinner, stopSpinner } = require('./spinner');
const { sendRpc, sendRpcNotify } = require('./rpc');
const { buildFileList, selectedItem, selectedLogRef, refreshAsync, refreshLog, updateLogDetail, updateDiff, FRESH_TIME_WINDOWS, refreshFresh, updateFreshDetail, applyStageToState, applyUnstageToState } = require('./refresh');
const { render } = require('./render');
const { buildHistoryContextMenuItems, buildStashContextMenuItems, buildFileContextMenuItems, buildRemotesContextMenuItems, buildRemoteBranchContextMenuItems, buildBranchContextMenuItems, buildTabContextMenuItems } = require('./context-menu');

let currentMouseShape = 'default';
function setMouseShape(shape) {
  if (shape !== currentMouseShape) {
    currentMouseShape = shape;
    process.stdout.write(ansi.mouseShape(shape));
  }
}

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
    buttons: [{ id: 'ok', label: 'OK', default: true }],
  });
}

function isStaleRebaseError(err) {
  return err && (err.includes('rebase-merge') || err.includes('rebase-apply'));
}

function isRebaseConflictError(err) {
  return err && (err.includes('could not apply') || err.includes('Resolve all conflicts') || err.includes('CONFLICT') || err.includes('fix conflicts') || err.includes('needs merge'));
}

function switchToDiffViewForConflict() {
  if (state.rightView !== 'diff') {
    state.rightView = 'diff';
    updateDiff();
  }
}

function getConflictChunkIndices() {
  if (!state.conflictView) return [];
  return state.conflictView.chunks
    .map((chunk, idx) => chunk.type === 'conflict' ? idx : -1)
    .filter(idx => idx >= 0);
}

function moveConflictChunkCursor(delta) {
  const conflictIndices = getConflictChunkIndices();
  if (conflictIndices.length === 0) return false;
  const currentPos = Math.max(0, conflictIndices.indexOf(ui.mergeChunkCursor));
  const nextPos = Math.max(0, Math.min(conflictIndices.length - 1, currentPos + delta));
  ui.mergeChunkCursor = conflictIndices[nextPos];
  ensureConflictCursorVisible();
  return true;
}

function ensureConflictCursorVisible() {
  const range = ui.mergeChunkLineMap ? ui.mergeChunkLineMap[ui.mergeChunkCursor] : null;
  const viewport = Math.max(1, ui.rightDiffH || 1);
  if (!range) return;
  if (range.start < state.diffScrollOffset) {
    state.diffScrollOffset = range.start;
  } else if (range.end >= state.diffScrollOffset + viewport) {
    state.diffScrollOffset = Math.max(0, range.end - viewport + 1);
  }
}

function buildResolvedConflictContent() {
  if (!state.conflictView) return { ok: false, message: 'No conflict view is active' };
  const outLines = [];
  for (let i = 0; i < state.conflictView.chunks.length; i++) {
    const chunk = state.conflictView.chunks[i];
    if (chunk.type === 'context') {
      outLines.push(...chunk.lines);
      continue;
    }
    const selection = ui.mergeChunkSelections[i];
    if (selection !== 'ours' && selection !== 'theirs') {
      return { ok: false, message: 'Select a side for every conflict chunk before applying' };
    }
    outLines.push(...(selection === 'ours' ? chunk.ours : chunk.theirs));
  }

  let content = outLines.join('\n');
  if (state.conflictView.hasTrailingNewline) content += '\n';
  return { ok: true, content };
}

async function applyConflictSelections() {
  const sel = selectedItem();
  if (!sel || sel.status !== 'U' || !state.conflictView) {
    showErrorDialog('Select a conflicted file first');
    render();
    return;
  }

  const resolved = buildResolvedConflictContent();
  if (!resolved.ok) {
    showErrorDialog(resolved.message);
    render();
    return;
  }

  startSpinner('Applying resolution...');
  const writeErr = await gitWriteConflictResolution(state.cwd, sel.file, resolved.content);
  if (writeErr) {
    stopSpinner();
    showErrorDialog(writeErr);
    render();
    return;
  }

  const stageErr = await gitStageAsync(state.cwd, sel.file);
  if (stageErr !== true) {
    stopSpinner();
    showErrorDialog(typeof stageErr === 'string' && stageErr ? stageErr : 'Failed to stage resolved file');
    render();
    return;
  }

  await refreshAsync();
  stopSpinner();
  updateDiff();
  render();
}

async function handleKey(key) {
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
  if (state.mode === 'commit') {
    handleCommitInput(key);
    return;
  }

  // Ctrl+Shift+P: push
  if (key === CSI + '112;6u') {
    startSpinner('Pushing...');
    gitPushAsync(state.cwd).then(async err => {
      if (err) {
        stopSpinner();
        showErrorDialog(err);
        render();
      } else {
        await refreshAsync();
        if (state.rightView === 'log') refreshLog();
        if (state.rightView === 'fresh') refreshFresh();
        stopSpinner();
        render();
      }
    });
    return;
  }

  // Arrow keys (VT sequences)
  if (key === CSI + 'A' || key === 'k') { // Up
    if (state.rightView === 'diff' && state.focusPanel === 'diff' && state.conflictView) {
      if (moveConflictChunkCursor(-1)) render();
      return;
    }
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
    if (state.rightView === 'diff' && state.focusPanel === 'diff' && state.conflictView) {
      if (moveConflictChunkCursor(1)) render();
      return;
    }
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

  // Left/Right: horizontal scroll
  if (key === CSI + 'C') { // Right
    if (state.focusPanel === 'diff') {
      const maxX = state.rightView === 'log' ? (ui.logDetailMaxScrollX || 0)
        : state.rightView === 'fresh' ? (ui.freshDetailMaxScrollX || 0)
        : (ui.diffMaxScrollX || 0);
      state.diffScrollX = Math.min(maxX, state.diffScrollX + 2);
    } else {
      state.filesScrollX = Math.min((ui.filesMaxScrollX || 0), state.filesScrollX + 2);
    }
    render();
    return;
  }
  if (key === CSI + 'D') { // Left
    if (state.focusPanel === 'diff') {
      state.diffScrollX = Math.max(0, state.diffScrollX - 2);
    } else {
      state.filesScrollX = Math.max(0, state.filesScrollX - 2);
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
      if (targets.length > 0) {
        const filesToStage = targets
          .map(i => fileList[i])
          .filter(item => item && item.type !== 'staged')
          .map(item => item.file);
        if (filesToStage.length > 0) {
          // 즉시 state 업데이트 후 백그라운드로 git add 실행
          state.selectedFiles.clear();
          applyStageToState(filesToStage);
          render();
          gitStageMultiple(state.cwd, filesToStage);
        }
      }
      break;
    }
    case 'u': {
      if (state.rightView === 'log') break;
      const fileList = buildFileList();
      const targets = state.selectedFiles.size > 0
        ? Array.from(state.selectedFiles).sort((a, b) => a - b)
        : (fileList.length > 0 ? [Math.min(state.cursor, fileList.length - 1)] : []);
      if (targets.length > 0) {
        const filesToUnstage = targets
          .map(i => fileList[i])
          .filter(item => item && item.type === 'staged')
          .map(item => item.file);
        if (filesToUnstage.length > 0) {
          // 즉시 state 업데이트 후 백그라운드로 git restore --staged 실행
          state.selectedFiles.clear();
          applyUnstageToState(filesToUnstage);
          render();
          gitUnstageMultiple(state.cwd, filesToUnstage);
        }
      }
      break;
    }
    case 'c': {
      if (state.staged.length === 0) {
        showErrorDialog('Nothing staged to commit');
        render();
        break;
      }
      state.mode = 'commit';
      if (state.operationState && state.rebaseMessage) {
        state.commitMsg = state.rebaseMessage;
        state.commitCursor = state.rebaseMessage.length;
      } else {
        state.commitMsg = '';
        state.commitCursor = 0;
      }
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

      } else {
        state.rightView = 'diff';
        updateDiff();

      }
      state.focusPanel = 'status';
      render();
      break;
    }
    case '1':
    case '2': {
      if (state.rightView !== 'diff' || !state.conflictView) break;
      const sel = selectedItem();
      if (!sel || sel.status !== 'U') break;
      if (key === '1') ui.mergeChunkSelections[ui.mergeChunkCursor] = 'ours';
      if (key === '2') ui.mergeChunkSelections[ui.mergeChunkCursor] = 'theirs';
      ensureConflictCursorVisible();
      render();
      break;
    }
    case 'm': {
      if (state.rightView !== 'diff' || !state.conflictView) break;
      await applyConflictSelections();
      break;
    }
    case 'b': {
      if (state.operationState) {
        const op = state.operationState;
        const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
        const typeLabel = isRebase ? 'Rebase' : op.type === 'merge' ? 'Merge' : op.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
        const buttons = [
          { id: 'continue', label: 'Continue', default: true },
          { id: 'abort', label: 'Abort' },
        ];
        if (op.type !== 'merge') buttons.push({ id: 'skip', label: 'Skip' });
        buttons.push({ id: 'cancel', label: 'Cancel' });
        sendRpc('show_dialog', {
          type: 'message',
          title: typeLabel,
          message: 'Choose action:',
          buttons,
        });
        state.pendingRebaseMenu = true;
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
              { id: 'stash_rebase', label: 'Stash & Rebase', default: true },
              { id: 'cancel', label: 'Cancel' },
            ],
          });
        } else {
          // Pre-check for conflicts before rebasing
          const conflictCheck = await gitCheckRebaseConflicts(state.cwd, logItem.ref);
          if (conflictCheck.willConflict) {
            const fileList = conflictCheck.files.length > 0
              ? '\n\nConflicting files:\n' + conflictCheck.files.slice(0, 10).join('\n')
              : '';
            state.pendingRebaseRef = logItem.ref;
            sendRpc('show_dialog', {
              type: 'message',
              title: 'Rebase',
              message: '\u26A0 Rebase will cause conflicts.' + fileList + '\n\nDo you want to continue?',
              buttons: [
                { id: 'rebase_proceed', label: 'Rebase', default: true },
                { id: 'cancel', label: 'Cancel' },
              ],
            });
            render();
            break;
          }
          startSpinner('Rebasing...');
          gitRebaseAsync(state.cwd, logItem.ref).then(async err => {
            await refreshAsync();
            stopSpinner();
            if (state.rightView === 'log') refreshLog();
            if (err && isStaleRebaseError(err)) {
              state.pendingRebaseRef = logItem.ref;
              sendRpc('show_dialog', {
                type: 'message',
                title: 'Rebase',
                message: 'A stale rebase state was found.\nAbort the previous rebase and retry?',
                buttons: [
                  { id: 'abort_retry_rebase', label: 'Abort & Retry', default: true },
                  { id: 'cancel', label: 'Cancel' },
                ],
              });
            } else if (err && isRebaseConflictError(err)) {
              switchToDiffViewForConflict();
              render();
            } else if (err) {
              showErrorDialog(err);
              render();
            } else {
              render();
            }
          });
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
      refreshAsync().then(() => {
        if (state.rightView === 'log') refreshLog();
        if (state.rightView === 'fresh') {
          refreshFresh();
          updateFreshDetail();
        }
        render();
      });
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
  // Ctrl+V — Paste from clipboard
  if (key === '\x16') {
    (async () => {
      const result = await sendRpc('read_clipboard');
      if (result && result.text) {
        const clean = result.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        state.commitMsg = state.commitMsg.substring(0, state.commitCursor) + clean + state.commitMsg.substring(state.commitCursor);
        state.commitCursor += clean.length;
        render();
      }
    })();
    return;
  }
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
  // Ctrl+Enter → submit commit or continue rebase
  if (key === CSI + '13;5u') {
    if (state.commitMsg.trim().length === 0) {
      showErrorDialog('Commit message cannot be empty');
      render();
      return;
    }
    const isRebaseOp = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    state.mode = 'normal';
    if (isRebaseOp) {
      // Fork-style: write message to rebase message file, then rebase --continue
      startSpinner('Rebase continue...');
      (async () => {
        try {
          const writeErr = await gitWriteRebaseMessage(state.cwd, state.commitMsg, state.operationState.type);
          if (writeErr) {
            stopSpinner();
            showErrorDialog('Failed to write rebase message:\n' + writeErr);
            render();
            return;
          }
          const err = await gitRebaseContinueAsync(state.cwd);
          state.commitMsg = '';
          state.commitCursor = 0;
          await refreshAsync();
          if (state.rightView === 'log') refreshLog();
          stopSpinner();
          if (err && isRebaseConflictError(err)) {
            switchToDiffViewForConflict();
            render();
          } else if (err) {
            showErrorDialog(err);
          } else {
            render();
          }
        } catch (e) {
          stopSpinner();
          showErrorDialog(e.message || 'Rebase continue failed');
          render();
        }
      })();
    } else {
      startSpinner('Committing...');
      gitCommitAsync(state.cwd, state.commitMsg).then(async err => {
        if (err) {
          stopSpinner();
          showErrorDialog(err);
          render();
        } else {
          state.commitMsg = '';
          state.commitCursor = 0;
          await refreshAsync({ statusOnly: true });
          stopSpinner();
          render();
        }
      });
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
    startSpinner('Rebase continue...');
    gitRebaseContinueAsync(state.cwd).then(async err => {
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      stopSpinner();
      if (err) showErrorDialog(err);
      render();
    });
    return;
  }
  if (key === 'a') {
    state.mode = 'normal';
    startSpinner('Aborting rebase...');
    gitRebaseAbortAsync(state.cwd).then(async err => {
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      stopSpinner();
      if (err) showErrorDialog(err);
      render();
    });
    return;
  }
  if (key === 's') {
    state.mode = 'normal';
    startSpinner('Rebase skip...');
    gitRebaseSkipAsync(state.cwd).then(async err => {
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      stopSpinner();
      if (err) showErrorDialog(err);
      render();
    });
    return;
  }
}

async function handleNameInput(key) {
  // Ctrl+V — Paste from clipboard
  if (key === '\x16') {
    (async () => {
      const result = await sendRpc('read_clipboard');
      if (result && result.text) {
        state.inputBuffer += result.text.replace(/[\r\n]/g, '');
        render();
      }
    })();
    return;
  }
  // IME 입력과 이스케이프 시퀀스가 하나의 청크로 합쳐진 경우 분리 처리
  const escIdx = key.indexOf('\x1b');
  if (escIdx > 0) {
    handleNameInput(key.substring(0, escIdx));
    if (state.mode === 'new-branch' || state.mode === 'new-tag' || state.mode === 'rename-stash' || state.mode === 'new-remote' || state.mode === 'new-remote-url') {
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
      err = await gitStashRename(state.cwd, state.inputTarget, name);
    } else if (state.mode === 'new-remote') {
      state.mode = 'new-remote-url';
      state.inputTarget = name;
      state.inputBuffer = '';
      render();
      return;
    } else if (state.mode === 'new-remote-url') {
      err = await gitRemoteAdd(state.cwd, state.inputTarget, name);
    } else if (state.mode === 'new-branch') {
      err = await gitCreateBranch(state.cwd, name, state.inputTarget);
    } else {
      err = await gitCreateTag(state.cwd, name, state.inputTarget);
    }
    const opName = state.mode === 'rename-stash'
      ? 'Rename stash'
      : state.mode === 'new-remote-url'
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
      refreshAsync().then(() => {
        if (state.rightView === 'log') refreshLog();
        render();
      });
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

function applyScrollbarOffset(target, offset) {
  switch (target) {
    case 'left': ui.leftPanelScrollOffset = offset; break;
    case 'files': state.scrollOffset = offset; ui.filesScrollPin = state.cursor; break;
    case 'diff': state.diffScrollOffset = offset; break;
    case 'logList': state.logScrollOffset = offset; ui.logScrollPin = state.logCursor; break;
    case 'logDetail': state.diffScrollOffset = offset; break;
    case 'freshList': state.freshScrollOffset = offset; ui.freshScrollPin = state.freshCursor; break;
    case 'freshDetail': state.diffScrollOffset = offset; break;
  }
}

async function handleMouseData(data) {
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
      if (ui.dragging === 'scrollbar') {
        const info = ui.scrollbarDragInfo;
        const relY = cy - info.trackTop;
        const ratio = Math.max(0, Math.min(1, relY / Math.max(1, info.trackH - 1)));
        applyScrollbarOffset(info.target, Math.round(ratio * info.maxScroll));
        render();
        continue;
      }
      if (ui.dragging === 'hscrollbar') {
        const info = ui.hScrollbarDragInfo;
        const relX = cx - info.colStart;
        const ratio = Math.max(0, Math.min(1, relX / Math.max(1, info.trackCols - 1)));
        const newScrollX = Math.round(ratio * info.maxScrollX);
        if (info.target === 'diff') {
          state.diffScrollX = newScrollX;
        } else if (info.target === 'files') {
          state.filesScrollX = newScrollX;
        } else {
          // logDetail, freshDetail share diffScrollX
          state.diffScrollX = newScrollX;
        }
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
      let newDivHover = null;
      const inBody = cy >= bodyTop && cy < bodyTop + L.bodyH;
      if (!ui.leftPanelCollapsed && inBody) {
        if (cx === div1Col) {
          newDivHover = 'vertical';
        }
      }
      if (L.middleW > 0 && inBody && cx === div2Col) {
        newDivHover = 'vertical2';
      }
      if ((state.rightView === 'log' || state.rightView === 'fresh') && inBody) {
        const hListH = state.rightView === 'fresh' ? ui.lastFreshListH : ui.lastLogListH;
        if (hListH > 0) {
          const hDivRow = bodyTop + hListH;
          if (cy === hDivRow && cx >= rightStart) {
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

      // Hover: file list (middle panel)
      let newFileRowHover = -1;
      if (state.rightView !== 'log' && state.rightView !== 'fresh' && L.middleW > 0 && inBody) {
        const inMiddle = cx >= midStart && cx < midStart + L.middleW;
        if (inMiddle) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
            newFileRowHover = bodyRowIdx;
          }
        }
      }

      // Hover: log list (right panel)
      let newLogRowHover = -1;
      if (state.rightView === 'log' && inBody) {
        const inRight = cx >= rightStart && cx < L.startCol + L.width;
        if (inRight) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.lastLogListH) {
            newLogRowHover = bodyRowIdx;
          }
        }
      }

      // Hover: fresh list (right panel)
      let newFreshRowHover = -1;
      if (state.rightView === 'fresh' && inBody) {
        const inRight = cx >= rightStart && cx < L.startCol + L.width;
        if (inRight) {
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx >= 0 && bodyRowIdx < ui.freshFileLineMap.length && ui.freshFileLineMap[bodyRowIdx] >= 0) {
            newFreshRowHover = bodyRowIdx;
          }
        }
      }

      // Context menu: stash items in left panel
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

      // Hover: scrollbar
      let newScrollbarHover = null;
      for (const sb of ui.scrollbarOverlays) {
        if (cx === sb.screenCol && cy >= sb.screenRow && cy < sb.screenRow + sb.viewportRows) {
          newScrollbarHover = sb.target;
          break;
        }
      }

      // Hover: horizontal scrollbar
      let newHScrollbarHover = null;
      for (const hsb of ui.hScrollbarZones) {
        if (cy === hsb.screenRow && cx >= hsb.colStart && cx <= hsb.colEnd) {
          newHScrollbarHover = hsb.target;
          break;
        }
      }

      // Hover: detail copy zones (log detail metadata)
      let newDetailCopyZone = null;
      if (state.rightView === 'log' && inBody && ui.detailCopyZones && ui.detailCopyZones.length > 0) {
        const inRight = cx >= rightStart && cx < L.startCol + L.width;
        if (inRight) {
          const bodyRowIdx = cy - bodyTop;
          const relCol = cx - rightStart;
          for (const zone of ui.detailCopyZones) {
            if (bodyRowIdx === zone.lineIdx && relCol >= zone.colStart && relCol <= zone.colEnd) {
              newDetailCopyZone = zone;
              break;
            }
          }
        }
      }
      // Hover: detail Collapse All button
      let newCollapseAllHover = false;
      if (state.rightView === 'log' && inBody && ui.detailCollapseAllZone) {
        const bodyRowIdx = cy - bodyTop;
        if (bodyRowIdx === ui.detailCollapseAllZone.lineIdx) {
          const relCol = cx - rightStart;
          if (relCol >= ui.detailCollapseAllZone.colStart && relCol <= ui.detailCollapseAllZone.colEnd) {
            newCollapseAllHover = true;
          }
        }
      }

      // Hover: commit button
      let newCommitButtonHover = false;
      if (ui.commitButtonZone && state.rightView !== 'log' && state.rightView !== 'fresh') {
        if (cy === ui.commitButtonZone.row && cx >= ui.commitButtonZone.colStart && cx <= ui.commitButtonZone.colEnd) {
          newCommitButtonHover = true;
        }
      }

      let newMergeApplyHover = false;
      if (ui.mergeApplyZone && state.rightView === 'diff') {
        if (cy === ui.mergeApplyZone.row && cx >= ui.mergeApplyZone.colStart && cx <= ui.mergeApplyZone.colEnd) {
          newMergeApplyHover = true;
        }
      }

      let newMergeZoneHover = -1;
      if (ui.mergeClickZones && ui.mergeClickZones.length > 0 && state.rightView === 'diff' && inBody) {
        const rpStartCol = L.startCol + L.leftW + L.divider1W + L.middleW + L.divider2W;
        for (let i = 0; i < ui.mergeClickZones.length; i++) {
          const zone = ui.mergeClickZones[i];
          const zoneRow = bodyTop + zone.lineIdx;
          const zoneColStart = rpStartCol + zone.colStart;
          const zoneColEnd = rpStartCol + zone.colEnd;
          if (cy === zoneRow && cx >= zoneColStart && cx <= zoneColEnd) {
            newMergeZoneHover = i;
            break;
          }
        }
      }

      if (newHover !== ui.hoveredAreaIndex || newTitleHover !== ui.hoveredTitleZoneIndex || newDivHover !== ui.hoveredDivider || newFileHeaderHover !== ui.hoveredFileHeaderIdx || newLeftPanelHover !== ui.hoveredLeftPanelRow || newFileRowHover !== ui.hoveredFileRow || newLogRowHover !== ui.hoveredLogRow || newFreshRowHover !== ui.hoveredFreshRow || newFreshWindowHover !== ui.hoveredFreshWindow || newScrollbarHover !== ui.hoveredScrollbarTarget || newCommitButtonHover !== ui.hoveredCommitButton || newHScrollbarHover !== ui.hoveredHScrollbarTarget || newMergeApplyHover !== ui.hoveredMergeApplyButton || newMergeZoneHover !== ui.hoveredMergeZoneIndex || newDetailCopyZone !== ui.hoveredDetailCopyZone || newCollapseAllHover !== ui.hoveredCollapseAllButton) {
        ui.hoveredAreaIndex = newHover;
        ui.hoveredTitleZoneIndex = newTitleHover;
        ui.hoveredDivider = newDivHover;
        ui.hoveredFileHeaderIdx = newFileHeaderHover;
        ui.hoveredLeftPanelRow = newLeftPanelHover;
        ui.hoveredFileRow = newFileRowHover;
        ui.hoveredLogRow = newLogRowHover;
        ui.hoveredFreshRow = newFreshRowHover;
        ui.hoveredFreshWindow = newFreshWindowHover;
        ui.hoveredScrollbarTarget = newScrollbarHover;
        ui.hoveredCommitButton = newCommitButtonHover;
        ui.hoveredHScrollbarTarget = newHScrollbarHover;
        ui.hoveredMergeApplyButton = newMergeApplyHover;
        ui.hoveredMergeZoneIndex = newMergeZoneHover;
        ui.hoveredDetailCopyZone = newDetailCopyZone;
        ui.hoveredCollapseAllButton = newCollapseAllHover;
        // Update mouse cursor shape
        if (!ui.dragging) {
          if (newDivHover === 'vertical' || newDivHover === 'vertical2') {
            setMouseShape('ew-resize');
          } else if (newDivHover === 'horizontal') {
            setMouseShape('ns-resize');
          } else if (newTitleHover >= 0 || newFileHeaderHover >= 0 || newCommitButtonHover || newMergeApplyHover || newFreshWindowHover || newHover >= 0 || newDetailCopyZone || newCollapseAllHover) {
            setMouseShape('pointer');
          } else {
            setMouseShape('default');
          }
        }
        render();
      }
      continue;
    }

    if (isRelease) {
      if (ui.dragging !== null) {
        ui.dragging = null;
        setMouseShape('default');
      }
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

    // Scroll wheel (native horizontal wheel or Shift+wheel = horizontal scroll)
    const isWheel = !isRelease && (cb & 64) !== 0;
    if (isWheel) {
      const wheelStep = (cb & 1) !== 0 ? 3 : -3;
      const wheelBtn = cb & 3; // 0/1: vertical up/down, 2/3: horizontal left/right
      const isHorizontalWheel = wheelBtn === 2 || wheelBtn === 3;
      const isShiftWheel = (cb & 4) !== 0;
      const inLeft = !ui.leftPanelCollapsed && cx >= L.startCol && cx < L.startCol + L.leftW;
      const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
      const inRight = cx >= rightStart && cx < L.startCol + L.width;
      const inBody = cy >= bodyTop && cy < bodyTop + L.bodyH;
      if (isHorizontalWheel || isShiftWheel) {
        let changed = false;
        if (inBody && inMiddle) {
          const prev = state.filesScrollX;
          state.filesScrollX = Math.max(0, Math.min((ui.filesMaxScrollX || 0), state.filesScrollX + wheelStep));
          if (state.filesScrollX !== prev) changed = true;
          state.focusPanel = 'status';
        } else if (inBody && inRight) {
          const prev = state.diffScrollX;
          const maxX = state.rightView === 'log' ? (ui.logDetailMaxScrollX || 0)
            : state.rightView === 'fresh' ? (ui.freshDetailMaxScrollX || 0)
            : (ui.diffMaxScrollX || 0);
          state.diffScrollX = Math.max(0, Math.min(maxX, state.diffScrollX + wheelStep));
          if (state.diffScrollX !== prev) changed = true;
          state.focusPanel = 'diff';
        }
        if (changed) render();
        continue;
      }
      if (inBody && inLeft) {
        const prev = ui.leftPanelScrollOffset;
        ui.leftPanelScrollOffset = Math.max(0, Math.min(ui.leftMaxScroll || 0, ui.leftPanelScrollOffset + wheelStep));
        if (ui.leftPanelScrollOffset !== prev) render();
      } else if (inBody && inMiddle) {
        // Middle panel (diff mode only): file list viewport scroll
        const maxScroll = ui.filesMaxScroll || 0;
        if (maxScroll > 0) {
          const prev = state.scrollOffset;
          if (cb === 64) state.scrollOffset = Math.max(0, state.scrollOffset - 3);
          else state.scrollOffset = Math.min(maxScroll, state.scrollOffset + 3);
          if (state.scrollOffset !== prev) {
            ui.filesScrollPin = state.cursor;
            render();
          }
        }
      } else if (inRight && (inBody || state.rightView === 'diff')) {
        let changed = false;
        if (state.rightView === 'fresh') {
          // Fresh mode: top = file list scroll, bottom = detail scroll
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx < ui.lastFreshListH) {
            const maxScroll = ui.freshListMaxScroll || 0;
            if (maxScroll > 0) {
              const prev = state.freshScrollOffset;
              if (cb === 64) state.freshScrollOffset = Math.max(0, state.freshScrollOffset - 3);
              else state.freshScrollOffset = Math.min(maxScroll, state.freshScrollOffset + 3);
              if (state.freshScrollOffset !== prev) {
                ui.freshScrollPin = state.freshCursor;
                changed = true;
              }
            }
            state.focusPanel = 'status';
          } else {
            const prev = state.diffScrollOffset;
            const maxDiff = Math.max(0, state.freshDetailLines.length - Math.max(1, Math.floor((L.bodyH - 2) * (1 - ui.logListRatio)) - 1));
            state.diffScrollOffset = Math.max(0, Math.min(maxDiff, state.diffScrollOffset + wheelStep));
            if (state.diffScrollOffset !== prev) changed = true;
            state.focusPanel = 'diff';
          }
        } else if (state.rightView === 'log') {
          // Log mode: top = log scroll, bottom = detail scroll
          const bodyRowIdx = cy - (bodyTop);
          if (bodyRowIdx < ui.lastLogListH) {
            const maxScroll = ui.logListMaxScroll || 0;
            if (maxScroll > 0) {
              const prev = state.logScrollOffset;
              if (cb === 64) state.logScrollOffset = Math.max(0, state.logScrollOffset - 3);
              else state.logScrollOffset = Math.min(maxScroll, state.logScrollOffset + 3);
              if (state.logScrollOffset !== prev) {
                ui.logScrollPin = state.logCursor;
                changed = true;
              }
            }
            state.focusPanel = 'status';
          } else {
            const prev = state.diffScrollOffset;
            const maxDiff = Math.max(0, (ui.filteredDetailCount || state.logDetailLines.length) - (ui.lastDetailContentH || 1));
            state.diffScrollOffset = Math.max(0, Math.min(maxDiff, state.diffScrollOffset + wheelStep));
            if (state.diffScrollOffset !== prev) changed = true;
            state.focusPanel = 'diff';
          }
        } else {
          // Diff mode: diff scroll
          const prev = state.diffScrollOffset;
          const maxDiff = Math.max(0, state.diffLines.length - (ui.rightDiffH || 1));
          const conflictMaxDiff = Math.max(0, (ui.diffMaxScroll || 0));
          state.diffScrollOffset = Math.max(0, Math.min(state.conflictView ? conflictMaxDiff : maxDiff, state.diffScrollOffset + wheelStep));
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
      
              state.focusPanel = 'status';
              render();
              handled = true;
            } else if (zone.action === 'git-fetch') {
              startSpinner('Fetching...');
              gitFetchAsync(state.cwd).then(async err => {
                if (err) {
                  stopSpinner();
                  showErrorDialog(err);
                  render();
                } else {
                  await refreshAsync();
                  if (state.rightView === 'log') refreshLog();
                  if (state.rightView === 'fresh') refreshFresh();
                  stopSpinner();
                  render();
                }
              });
              handled = true;
            } else if (zone.action === 'git-pull') {
              startSpinner('Pulling...');
              gitPullAsync(state.cwd).then(async err => {
                if (err) {
                  stopSpinner();
                  showErrorDialog(err);
                  render();
                } else {
                  await refreshAsync();
                  if (state.rightView === 'log') refreshLog();
                  if (state.rightView === 'fresh') refreshFresh();
                  stopSpinner();
                  render();
                }
              });
              handled = true;
            } else if (zone.action === 'git-push') {
              startSpinner('Pushing...');
              const currentBranch = state.branches.find(b => b.isCurrent) || state.branches.find(b => b.name === state.branch);
              const pushPromise = currentBranch && !currentBranch.upstream
                ? (state.remotes.length > 0
                    ? gitPushToRemoteAsync(state.cwd, state.remotes[0], currentBranch.name)
                    : Promise.resolve('No remote configured for push'))
                : gitPushAsync(state.cwd);
              pushPromise.then(async err => {
                if (err) {
                  stopSpinner();
                  showErrorDialog(err);
                  render();
                } else {
                  await refreshAsync();
                  if (state.rightView === 'log') refreshLog();
                  if (state.rightView === 'fresh') refreshFresh();
                  stopSpinner();
                  render();
                }
              });
              handled = true;
            } else if (zone.action === 'git-stash') {
              state.pendingStash = true;
              sendRpc('show_dialog', {
                type: 'message',
                title: 'Stash',
                message: 'Stash changes?',
                buttons: [
                  { id: 'stash_confirm', label: 'Stash', default: true },
                  { id: 'cancel', label: 'Cancel' },
                ],
              });
              handled = true;
            } else if (zone.action === 'rebase-abort') {
              startSpinner('Aborting rebase...');
              gitRebaseAbortAsync(state.cwd).then(async err => {
                await refreshAsync();
                if (state.rightView === 'log') refreshLog();
                stopSpinner();
                if (err) showErrorDialog(err);
                render();
              });
              handled = true;
            } else if (zone.action === 'rebase-skip') {
              startSpinner('Rebase skip...');
              gitRebaseSkipAsync(state.cwd).then(async err => {
                await refreshAsync();
                if (state.rightView === 'log') refreshLog();
                stopSpinner();
                if (err && isRebaseConflictError(err)) {
                  switchToDiffViewForConflict();
                }
                if (err) showErrorDialog(err);
                render();
              });
              handled = true;
            } else if (zone.action === 'reset-committer-name') {
              const err = await gitUnsetConfigLocal(state.cwd, 'user.name');
              if (err) {
                showErrorDialog(err);
              } else {
                refreshAsync().then(() => render());
              }
              render();
              handled = true;
            } else if (zone.action === 'reset-committer-email') {
              const err = await gitUnsetConfigLocal(state.cwd, 'user.email');
              if (err) {
                showErrorDialog(err);
              } else {
                refreshAsync().then(() => render());
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
                  { id: 'ok', label: 'OK', default: true },
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
                  { id: 'ok', label: 'OK', default: true },
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
        if (cx === div1Col && cy >= bodyTop && cy < bodyTop + L.bodyH) {
          ui.dragging = 'vertical';
          setMouseShape('ew-resize');
          continue;
        }
      }
      // Divider drag start: second vertical divider (diff mode only)
      if (L.middleW > 0 && cx === div2Col && cy >= bodyTop && cy < bodyTop + L.bodyH) {
        ui.dragging = 'vertical2';
        setMouseShape('ew-resize');
        continue;
      }
      // Horizontal divider drag start (log/fresh mode)
      if (state.rightView === 'log' || state.rightView === 'fresh') {
        const hListH = state.rightView === 'fresh' ? ui.lastFreshListH : ui.lastLogListH;
        if (hListH > 0) {
          const hDivRow = bodyTop + hListH;
          if (cy === hDivRow && cx >= rightStart) {
            ui.dragging = 'horizontal';
            setMouseShape('ns-resize');
            continue;
          }
        }
      }

      // Scrollbar drag start
      {
        let sbHandled = false;
        for (const sb of ui.scrollbarOverlays) {
          if (cx === sb.screenCol && cy >= sb.screenRow && cy < sb.screenRow + sb.viewportRows) {
            ui.dragging = 'scrollbar';
            ui.scrollbarDragInfo = {
              target: sb.target,
              trackTop: sb.screenRow,
              trackH: sb.viewportRows,
              maxScroll: sb.maxScroll
            };
            const relY = cy - sb.screenRow;
            const ratio = Math.max(0, Math.min(1, relY / Math.max(1, sb.viewportRows - 1)));
            applyScrollbarOffset(sb.target, Math.round(ratio * sb.maxScroll));
            render();
            sbHandled = true;
            break;
          }
        }
        if (sbHandled) continue;
      }

      // Horizontal scrollbar drag start
      {
        let hsbHandled = false;
        for (const hsb of ui.hScrollbarZones) {
          if (cy === hsb.screenRow && cx >= hsb.colStart && cx <= hsb.colEnd) {
            ui.dragging = 'hscrollbar';
            ui.hScrollbarDragInfo = {
              target: hsb.target,
              colStart: hsb.colStart,
              trackCols: hsb.trackCols,
              maxScrollX: hsb.maxScrollX,
            };
            const relX = cx - hsb.colStart;
            const ratio = Math.max(0, Math.min(1, relX / Math.max(1, hsb.trackCols - 1)));
            const newScrollX = Math.round(ratio * hsb.maxScrollX);
            if (hsb.target === 'diff') {
              state.diffScrollX = newScrollX;
            } else if (hsb.target === 'files') {
              state.filesScrollX = newScrollX;
            } else {
              state.diffScrollX = newScrollX;
            }
            render();
            hsbHandled = true;
            break;
          }
        }
        if (hsbHandled) continue;
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
              // Check if target is the current branch (may be detached HEAD)
              const isCurrentBranch = state.branches.some(b => b.isCurrent && b.name === targetBranch);
              for (let si = 0; si < state.logItems.length; si++) {
                const item = state.logItems[si];
                if (item.type !== 'commit' || !item.decoration) continue;
                const refs = item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '').split(', ');
                for (const ref of refs) {
                  const trimmed = ref.trim();
                  const cleaned = trimmed.startsWith('HEAD -> ') ? trimmed.substring(8) : trimmed;
                  if (cleaned === targetBranch) { foundIdx = si; break; }
                  // Detached HEAD: decoration is bare "HEAD", match if clicking current branch
                  if (isCurrentBranch && trimmed === 'HEAD') { foundIdx = si; break; }
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
              const now = Date.now();
              if (ui.lastClickStashRef === entry.ref && now - ui.lastClickStashTime < 400) {
                // Double-click: show Apply Stash dialog
                ui.lastClickStashRef = null;
                ui.lastClickStashTime = 0;
                const stashEntry = state.stashes.find(s => s.ref === entry.ref);
                const stashMessage = stashEntry ? stashEntry.message : '';
                const displayRef = entry.ref + (stashMessage ? '  ' + stashMessage : '');
                sendRpc('show_dialog', {
                  type: 'message',
                  title: 'Apply Stash',
                  message: 'Apply changes of the stash to your working directory.\n\nStash to Apply:  ' + displayRef,
                  checkboxes: [{ id: 'delete_after', label: 'Delete stash after applying\nStash will not be deleted if a conflict occurs', checked: false }],
                  buttons: [
                    { id: 'apply', label: 'Apply', default: true },
                    { id: 'cancel', label: 'Cancel' },
                  ],
                });
                state.pendingDialogAction = 'stash-apply-confirm';
                state.pendingDialogTarget = entry.ref;
              } else {
                ui.lastClickStashRef = entry.ref;
                ui.lastClickStashTime = now;
              }
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

      // Click on merge conflict UI zones
      if (ui.mergeClickZones && ui.mergeClickZones.length > 0 && state.rightView === 'diff') {
        const rpStartCol = L.startCol + L.leftW + L.divider1W + L.middleW + L.divider2W;
        let mergeHandled = false;
        for (const zone of ui.mergeClickZones) {
          const zoneRow = bodyTop + zone.lineIdx;
          const zoneColStart = rpStartCol + zone.colStart;
          const zoneColEnd = rpStartCol + zone.colEnd;
          if (cy === zoneRow && cx >= zoneColStart && cx <= zoneColEnd) {
            if (zone.action === 'select-ours') {
              ui.mergeChunkCursor = zone.chunkIndex;
              ui.mergeChunkSelections[zone.chunkIndex] = 'ours';
              ensureConflictCursorVisible();
              render();
              mergeHandled = true;
            } else if (zone.action === 'select-theirs') {
              ui.mergeChunkCursor = zone.chunkIndex;
              ui.mergeChunkSelections[zone.chunkIndex] = 'theirs';
              ensureConflictCursorVisible();
              render();
              mergeHandled = true;
            } else if (zone.action === 'focus-chunk') {
              ui.mergeChunkCursor = zone.chunkIndex;
              ensureConflictCursorVisible();
              render();
              mergeHandled = true;
            } else if (zone.action === 'apply-merge') {
              await applyConflictSelections();
              mergeHandled = true;
            }
            break;
          }
        }
        if (mergeHandled) continue;
      }

      if (ui.mergeApplyZone && cy === ui.mergeApplyZone.row && cx >= ui.mergeApplyZone.colStart && cx <= ui.mergeApplyZone.colEnd) {
        await applyConflictSelections();
        continue;
      }

      // Click on commit button zone
      if (ui.commitButtonZone && cy === ui.commitButtonZone.row && cx >= ui.commitButtonZone.colStart && cx <= ui.commitButtonZone.colEnd) {
        if (state.mode === 'commit' && state.commitMsg.trim().length > 0) {
          // Trigger commit via button click
          handleCommitInput(CSI + '13;5u');
        } else if (state.staged.length > 0 && state.mode !== 'commit') {
          state.mode = 'commit';
          if (state.operationState && state.rebaseMessage) {
            state.commitMsg = state.rebaseMessage;
            state.commitCursor = state.rebaseMessage.length;
          } else {
            state.commitMsg = '';
            state.commitCursor = 0;
          }
          render();
        }
        continue;
      }

      // Click on commit input row -> enter commit mode
      if (ui.commitInputRow > 0 && cy === ui.commitInputRow && cx >= rightStart && cx < L.startCol + L.width) {
        if (state.mode !== 'commit' && state.staged.length > 0) {
          state.mode = 'commit';
          if (state.operationState && state.rebaseMessage) {
            state.commitMsg = state.rebaseMessage;
            state.commitCursor = state.rebaseMessage.length;
          } else {
            state.commitMsg = '';
            state.commitCursor = 0;
          }
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
                if (zone.action === 'toggleIgnored') {
                  ui.collapsedSections.ignored = ui.collapsedSections.ignored === false ? true : false;
                  render();
                  headerHandled = true;
                  break;
                }
                if (zone.action === 'stageAll' || zone.action === 'unstageAll') {
                  const fileList = buildFileList();
                  const isStage = zone.action === 'stageAll';
                  const files = fileList
                    .filter(item => isStage ? item.type !== 'staged' : item.type === 'staged')
                    .map(item => item.file);
                  if (files.length > 0) {
                    const label = isStage ? 'Staging all' : 'Unstaging all';
                    startSpinner(`${label}...`);
                    (async () => {
                      if (isStage) {
                        await gitStageMultiple(state.cwd, files);
                      } else {
                        await gitUnstageMultiple(state.cwd, files);
                      }
                      state.selectedFiles.clear();
                      await refreshAsync();
                      stopSpinner();
                      render();
                    })();
                  }
                  headerHandled = true;
                  break;
                }
                const fileList = buildFileList();
                const targets = state.selectedFiles.size > 0
                  ? Array.from(state.selectedFiles).sort((a, b) => a - b)
                  : (fileList.length > 0 ? [Math.min(state.cursor, fileList.length - 1)] : []);
                if (targets.length > 0) {
                  const total = targets.length;
                  const label = zone.action === 'stageSelected' ? 'Staging' : 'Unstaging';
                  const isStage = zone.action === 'stageSelected';
                  startSpinner(`${label}... (0/${total}) 0%`);
                  (async () => {
                    for (let i = 0; i < total; i++) {
                      const item = fileList[targets[i]];
                      if (isStage) {
                        if (item && item.type !== 'staged') await gitStageAsync(state.cwd, item.file);
                      } else {
                        if (item && item.type === 'staged') await gitUnstageAsync(state.cwd, item.file);
                      }
                      const pct = Math.round(((i + 1) / total) * 100);
                      state.error = `${label}... (${i + 1}/${total}) ${pct}%`;
                    }
                    state.selectedFiles.clear();
                    await refreshAsync();
                    stopSpinner();
                    render();
                  })();
                }
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
                const isUnstage = item.type === 'staged';
                const msg = isUnstage ? 'Unstaging...' : 'Staging...';
                startSpinner(msg);
                (isUnstage ? gitUnstageAsync(state.cwd, item.file) : gitStageAsync(state.cwd, item.file)).then(async () => {
                  await refreshAsync();
                  stopSpinner();
                  render();
                });
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
            // Detail area: check for copy zone click
            let copyHandled = false;
            if (ui.detailCopyZones && ui.detailCopyZones.length > 0) {
              const relCol = cx - rightStart;
              for (const zone of ui.detailCopyZones) {
                if (bodyRowIdx === zone.lineIdx && relCol >= zone.colStart && relCol <= zone.colEnd) {
                  sendRpc('write_clipboard', { text: zone.text });
                  startSpinner('Copied: ' + zone.text);
                  setTimeout(() => { stopSpinner(); render(); }, 1000);
                  state.focusPanel = 'diff';
                  copyHandled = true;
                  break;
                }
              }
            }
            if (copyHandled) { render(); continue; }
            // Check for Collapse/Expand All button on refs line
            const refsRowIdx = ui.lastLogListH + 1; // separator + refs line
            if (bodyRowIdx === refsRowIdx && ui.detailCollapseAllZone) {
              const relCol = cx - rightStart;
              if (relCol >= ui.detailCollapseAllZone.colStart && relCol <= ui.detailCollapseAllZone.colEnd) {
                // Toggle all detail files
                const allFiles = [];
                for (const entry of (state.logDetailLines || [])) {
                  const m = entry.match && entry.match(/^diff --git a\/.+ b\/(.+)/);
                  if (m) allFiles.push(m[1]);
                }
                // Also check from detailFileHeaderMap
                for (const f of ui.detailFileHeaderMap) {
                  if (f && !allFiles.includes(f)) allFiles.push(f);
                }
                const allCollapsed = allFiles.length > 0 && allFiles.every(f => ui.collapsedDetailFiles.has(f));
                if (allCollapsed) {
                  ui.collapsedDetailFiles.clear();
                } else {
                  for (const f of allFiles) ui.collapsedDetailFiles.add(f);
                }
                state.focusPanel = 'diff';
                render();
                continue;
              }
            }
            // Check for file header toggle click
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

  }
  return hadMouse;
}

function cleanup() {
  process.stdout.write(ansi.mouseShape('default') + CSI + '?7h' + ansi.showCursor + ansi.reset + ansi.clear);
}

function joinPath(...parts) { return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/'); }

function handleContextMenuRequest(col, row) {
  const L = ui.lastLayout;
  if (!L) return;

  const titleH = (L.titleRows || 2) + 1;
  const bodyTop = L.startRow + titleH;
  const midStart = L.startCol + L.leftW + L.divider1W;
  const cx = col;
  const cy = row;

  // Title bar: tab context menu
  if (cy >= L.startRow && cy < bodyTop) {
    for (let i = 0; i < ui.titleClickZones.length; i++) {
      const zone = ui.titleClickZones[i];
      if (cy === zone.row && cx >= zone.colStart && cx <= zone.colEnd) {
        const act = zone.action;
        if (act === 'tab-local' || act === 'tab-commits' || act === 'tab-fresh') {
          ui.contextMenuTab = true;
          ui.contextMenuStashRef = null;
          ui.contextMenuFileItem = null;
          ui.contextMenuFileItems = [];
          ui.contextMenuFilePath = '';
          sendRpc('show_context_menu', { items: buildTabContextMenuItems() });
          render();
          return;
        }
      }
    }
  }

  // Left panel
  if (!ui.leftPanelCollapsed) {
    const bodyRowIdx = cy - bodyTop;
    const inLeft = cx >= L.startCol && cx < L.startCol + L.leftW;
    if (inLeft && bodyRowIdx >= 0 && bodyRowIdx < ui.leftPanelClickMap.length) {
      const entry = ui.leftPanelClickMap[bodyRowIdx];
      if (entry && entry.action === 'goto-branch' && state.remoteBranches.includes(entry.branch)) {
        ui.leftPanelActiveBranch = entry.branch;
        ui.contextMenuRemoteBranch = entry.branch;
        sendRpc('show_context_menu', { items: buildRemoteBranchContextMenuItems(entry.branch) });
        render();
        return;
      }
      if (isRemoteMenuTarget(entry)) {
        ui.contextMenuStashRef = null;
        ui.contextMenuFileItem = null;
        ui.contextMenuFileItems = [];
        ui.contextMenuFilePath = '';
        sendRpc('show_context_menu', { items: buildRemotesContextMenuItems() });
        render();
        return;
      }
      if (entry && entry.action === 'goto-stash' && entry.ref) {
        ui.leftPanelActiveBranch = 'stash:' + entry.shortHash;
        ui.contextMenuStashRef = entry.ref;
        const stashEntry = state.stashes.find(s => s.ref === entry.ref);
        const stashMessage = stashEntry ? stashEntry.message : '';
        sendRpc('show_context_menu', { items: buildStashContextMenuItems(entry.ref, stashMessage) });
        render();
        return;
      }
      if (entry && entry.action === 'goto-branch' && !state.remoteBranches.includes(entry.branch)) {
        ui.leftPanelActiveBranch = entry.branch;
        ui.contextMenuBranch = entry.branch;
        sendRpc('show_context_menu', { items: buildBranchContextMenuItems(entry.branch) });
        render();
        return;
      }
    }
  }

  // Right panel: log view
  if (state.rightView === 'log') {
    const bodyRowIdx = cy - bodyTop;
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
      }
    }
    // stash 커밋이면 stash 전용 컨텍스트 메뉴 표시
    const logItem = selectedLogRef();
    const stashRef = logItem ? ui.stashMap.get(logItem.ref) : null;
    if (stashRef) {
      ui.contextMenuStashRef = stashRef;
      const stashEntry = state.stashes.find(s => s.ref === stashRef);
      const stashMessage = stashEntry ? stashEntry.message : '';
      sendRpc('show_context_menu', { items: buildStashContextMenuItems(stashRef, stashMessage) });
    } else {
      sendRpc('show_context_menu', { items: buildHistoryContextMenuItems() });
    }
    render();
    return;
  }

  // Middle panel: file list (diff mode)
  {
    const bodyRowIdx = cy - bodyTop;
    const inMiddle = L.middleW > 0 && cx >= midStart && cx < midStart + L.middleW;
    if (inMiddle && bodyRowIdx >= 0 && bodyRowIdx < ui.fileLineMap.length && ui.fileLineMap[bodyRowIdx] >= 0) {
      const fileIdx = ui.fileLineMap[bodyRowIdx];
      const fileList = buildFileList();
      const item = fileList[fileIdx];
      state.cursor = fileIdx;
      updateDiff();
      state.focusPanel = 'status';
      if (item) {
        if (!state.selectedFiles.has(fileIdx)) {
          state.selectedFiles.clear();
          state.selectedFiles.add(fileIdx);
        }
        const targets = Array.from(state.selectedFiles)
          .sort((a, b) => a - b)
          .map((idx) => fileList[idx])
          .filter(Boolean);
        ui.contextMenuStashRef = null;
        ui.contextMenuFileItem = item;
        ui.contextMenuFileItems = targets;
        ui.contextMenuFilePath = joinPath(state.cwd, item.file);
        sendRpc('show_context_menu', { items: buildFileContextMenuItems(item, targets) });
      }
      render();
      return;
    }
  }
}

function isRemoteMenuTarget(entry) {
  if (!entry) return false;
  if (entry.action === 'toggle-section' && entry.section === 'remotes') return true;
  if (entry.action === 'toggle-group' && typeof entry.group === 'string' && entry.group.startsWith('r:')) return true;
  if (entry.action === 'goto-branch' && state.remoteBranches.includes(entry.branch)) return true;
  return false;
}

module.exports = { handleKey, handleMouseData, actionToKey, cleanup, handleContextMenuRequest };
