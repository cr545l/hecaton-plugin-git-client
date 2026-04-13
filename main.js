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

const { state, ui, init: initState } = require('./state');
const { sendRpc } = require('./rpc');
const { handleRpcResponse } = require('./rpc');
const { refreshAsync, refreshLog, refreshFresh, getLastUserRefreshTime } = require('./refresh');
const { render } = require('./render');
const { handleKey, handleMouseData, cleanup, handleContextMenuRequest } = require('./input');
const { handleContextMenuAction, handleDialogResult } = require('./context-menu');

async function main() {
  // Register stdin handler BEFORE any await — the deno runner drops
  // unmatched stdin lines (like resize events) if no callbacks are registered.
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch { /* ignore */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  function processRpcMessage(msg) {
    try {
      const json = JSON.parse(msg);

      // Batch RPC response (array)
      if (Array.isArray(json)) {
        handleRpcResponse(json);
        for (const item of json) {
          if (item && item.result && item.result.buttonId != null) {
            handleDialogResult(item.result);
          }
        }
        return;
      }

      // RPC response
      if (json.id != null && (json.result || json.error)) {
        handleRpcResponse(json);
        if (json.result && json.result.buttonId != null) {
          handleDialogResult(json.result);
        }
        return;
      }

      // Host notifications
      if (json.method === 'resize' && json.params) {
        ui.termCols = json.params.cols || ui.termCols;
        ui.termRows = json.params.rows || ui.termRows;
        const newCellW = json.params.cellWidth ? Math.round(json.params.cellWidth) : ui.cellW;
        const newCellH = json.params.cellHeight ? Math.round(json.params.cellHeight) : ui.cellH;
        if (newCellW !== ui.cellW || newCellH !== ui.cellH) {
          ui.cellW = newCellW;
          ui.cellH = newCellH;
          ui.logSixelOverlay = null;
        }
        render();
      }
      if (json.method === 'minimize') {
        state.minimized = true;
        render();
      }
      if (json.method === 'restore') {
        state.minimized = false;
        refreshAsync().then(() => render());
      }
      if (json.method === 'maximize') {
        // Host handles sizing; plugin just re-renders on resize
      }
      if (json.method === 'context_menu_request' && json.params) {
        handleContextMenuRequest(json.params.col, json.params.row);
      }
      if (json.method === 'context_menu_action' && json.params) {
        handleContextMenuAction(json.params.id);
      }
      if (json.method === 'dialog_result' && json.params) {
        handleDialogResult(json.params);
      }
    } catch { /* ignore parse errors */ }
  }

  process.stdin.on('data', async (data) => {
    // Host RPC messages
    if (data.indexOf('__HECA_RPC__') !== -1) {
      const segments = data.split('__HECA_RPC__');
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        processRpcMessage(trimmed);
      }
      return;
    }

    // Ignore input while loading or spinner active
    if (state.loading || state.spinnerActive) return;

    // Handle SGR mouse sequences
    const hadMouse = await handleMouseData(data);
    if (hadMouse) return;

    // Keyboard input
    await handleKey(data);
  });

  // Now safe to await — stdin handler is registered, resize events won't be dropped
  await initState();
  state.minimized = hecaton.initialState?.minimized ?? false;
  render();

  // Get CWD from host (launchParams.path overrides)
  const params = hecaton.initialState?.params;
  if (params && params.path) {
    state.cwd = params.path;
  } else {
    const cwdResult = await sendRpc('get_cwd');
    if (cwdResult && cwdResult.cwd) {
      state.cwd = cwdResult.cwd;
    } else {
      state.cwd = process.cwd();
    }
  }

  // Get initial cell size from host
  try {
    const cellSizeResult = await sendRpc('get_cell_size');
    if (cellSizeResult && cellSizeResult.cellWidth && cellSizeResult.cellHeight) {
      ui.cellW = Math.round(cellSizeResult.cellWidth);
      ui.cellH = Math.round(cellSizeResult.cellHeight);
    }
  } catch { /* ignore — use defaults */ }

  state.loading = false;
  await refreshAsync();
  render();

  // Auto-refresh: watch .git directory for changes
  await setupGitWatcher();

  // Graceful shutdown
  process.on('SIGTERM', () => { stopGitWatcher(); process.exit(0); });
  process.on('SIGINT', () => { stopGitWatcher(); process.exit(0); });
  process.stdin.on('end', () => { stopGitWatcher(); process.exit(0); });
}

let _gitWatcherCleanup = null;

function stopGitWatcher() {
  if (_gitWatcherCleanup) { _gitWatcherCleanup(); _gitWatcherCleanup = null; }
}

// context-menu 등 외부에서 워처 재시작 가능하도록 노출
ui.stopGitWatcher = stopGitWatcher;
ui.setupGitWatcher = () => setupGitWatcher();

async function setupGitWatcher() {
  stopGitWatcher(); // 기존 워처 정리
  if (!state.cwd || !state.isGitRepo) return;

  let debounceTimer = null;
  const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';

  function triggerRefresh() {
    // 사용자 작업 직후 2초간은 폴링에 의한 중복 refresh 억제
    if (Date.now() - getLastUserRefreshTime() < 2000) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (state.loading || state.minimized) return;
      if (state.mode !== 'normal') return;
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      if (state.rightView === 'fresh') refreshFresh();
      render();
    }, 150);
  }

  // 폴링으로 .git 상태 변경 감지 (fs.watch 대신 fs_stat 호스트 API 사용)
  // Worktree인 경우 .git은 파일이므로 실제 git 디렉토리를 찾아야 함
  let gitDir = state.cwd + sep + '.git';
  try {
    const gitDirResult = await hecaton.exec_process({
      program: 'git', args: ['rev-parse', '--git-dir'], cwd: state.cwd, timeout: 3000
    });
    if (gitDirResult && gitDirResult.ok && gitDirResult.stdout) {
      const resolved = gitDirResult.stdout.replace(/\r\n/g, '\n').trim();
      if (resolved) {
        const isAbsolute = resolved.startsWith('/') || /^[A-Za-z]:[\\/]/.test(resolved);
        gitDir = isAbsolute ? resolved : (state.cwd + sep + resolved);
      }
    }
  } catch { /* fallback to .git */ }
  const pollTargets = [
    gitDir + sep + 'index',
    gitDir + sep + 'HEAD',
    gitDir + sep + 'refs',
    gitDir + sep + 'refs' + sep + 'heads',
    gitDir + sep + 'logs' + sep + 'HEAD',
    gitDir + sep + 'FETCH_HEAD',
  ];

  async function statMtime(filePath) {
    try {
      const r = await hecaton.fs_stat({ path: filePath });
      return (r && r.exists && r.modifiedTime) ? r.modifiedTime : 0;
    } catch { return 0; }
  }

  let lastMtimes = await Promise.all(pollTargets.map(statMtime));
  const pollInterval = setInterval(async () => {
    const current = await Promise.all(pollTargets.map(statMtime));
    let changed = false;
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== lastMtimes[i]) { changed = true; break; }
    }
    if (changed) {
      lastMtimes = current;
      triggerRefresh();
    }
  }, 2000);

  // 워킹 디렉토리 변경 감지 (diff-files로 변경 여부만 확인 — 가볍고 빠름)
  let lastStatusSnapshot = '';
  let statusPolling = false;
  const statusPollInterval = setInterval(async () => {
    if (statusPolling) return;
    if (state.loading || state.minimized) return;
    if (state.mode !== 'normal') return;
    statusPolling = true;
    try {
      const result = await hecaton.exec_process({
        program: 'git', args: ['--no-optional-locks', 'diff-files', '--name-only'], cwd: state.cwd, timeout: 5000
      });
      const snapshot = (result && result.ok) ? (result.stdout || '') : '';
      if (snapshot !== lastStatusSnapshot) {
        lastStatusSnapshot = snapshot;
        triggerRefresh();
      }
    } catch { /* ignore */ }
    statusPolling = false;
  }, 3000);

  _gitWatcherCleanup = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollInterval);
    clearInterval(statusPollInterval);
  };
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
