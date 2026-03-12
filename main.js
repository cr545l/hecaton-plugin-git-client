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
const { refreshAsync, refreshLog, refreshFresh } = require('./refresh');
const { render } = require('./render');
const { handleKey, handleMouseData, cleanup } = require('./input');
const { handleContextMenuAction, handleDialogResult } = require('./context-menu');

async function main() {
  await initState();
  render();

  // Set up stdin FIRST so RPC responses can be received
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch { /* ignore */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', async (data) => {
    // Host RPC messages
    if (data.indexOf('__HECA_RPC__') !== -1) {
      const segments = data.split('__HECA_RPC__');
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);

          // RPC response
          if (json.id != null && (json.result || json.error)) {
            handleRpcResponse(json);
            // Dialog results may arrive as RPC responses to show_dialog
            if (json.result && json.result.buttonId != null) {
              handleDialogResult(json.result);
            }
            continue;
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
          if (json.method === 'context_menu_action' && json.params) {
            handleContextMenuAction(json.params.id);
          }
          if (json.method === 'dialog_result' && json.params) {
            handleDialogResult(json.params);
          }
        } catch { /* ignore */ }
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

  // Get CWD from host (stdin handler is ready, so RPC response will be received)
  const cwdResult = await sendRpc('get_cwd');
  if (cwdResult && cwdResult.cwd) {
    state.cwd = cwdResult.cwd;
  } else {
    state.cwd = process.cwd();
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
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });
}

async function setupGitWatcher() {
  if (!state.cwd || !state.isGitRepo) return;

  let debounceTimer = null;
  const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';

  function triggerRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (state.loading || state.minimized) return;
      if (state.mode !== 'normal') return;
      await refreshAsync();
      if (state.rightView === 'log') refreshLog();
      if (state.rightView === 'fresh') refreshFresh();
      render();
    }, 300);
  }

  // 폴링으로 .git 상태 변경 감지 (fs.watch 대신 fs_stat 호스트 API 사용)
  const gitDir = state.cwd + sep + '.git';
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
  }, 1000);

  // 워킹 디렉토리 변경 감지 (git status 결과 비교)
  let lastStatusSnapshot = '';
  let statusPolling = false;
  const statusPollInterval = setInterval(async () => {
    if (statusPolling) return;
    if (state.loading || state.minimized) return;
    if (state.mode !== 'normal') return;
    statusPolling = true;
    try {
      const result = await hecaton.exec_process({
        program: 'git', args: ['status', '--porcelain=v1', '-uall'], cwd: state.cwd, timeout: 5000
      });
      const snapshot = (result && result.ok) ? (result.stdout || '') : '';
      if (snapshot !== lastStatusSnapshot) {
        lastStatusSnapshot = snapshot;
        triggerRefresh();
      }
    } catch { /* ignore */ }
    statusPolling = false;
  }, 2000);

  // 종료 시 정리
  function cleanup() {
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollInterval);
    clearInterval(statusPollInterval);
  }
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
