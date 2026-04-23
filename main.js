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

  hecaton.on('window_resized', (params) => {
    ui.termCols = params.cols || ui.termCols;
    ui.termRows = params.rows || ui.termRows;
    const newCellW = params.cell_width ? Math.round(params.cell_width) : ui.cellW;
    const newCellH = params.cell_height ? Math.round(params.cell_height) : ui.cellH;
    if (newCellW !== ui.cellW || newCellH !== ui.cellH) {
      ui.cellW = newCellW;
      ui.cellH = newCellH;
      ui.logSixelOverlay = null;
    }
    render();
  });
  hecaton.on('window_minimized', () => {
    state.minimized = true;
    render();
  });
  hecaton.on('window_restored', () => {
    state.minimized = false;
    refreshAsync().then(() => render());
  });
  hecaton.on('menu_requested', (params) => {
    handleContextMenuRequest(params.col, params.row);
  });
  hecaton.on('menu_activated', (params) => {
    handleContextMenuAction(params.id);
  });
  hecaton.on('dialog_resolved', (params) => {
    handleDialogResult(params);
  });

  process.stdin.on('data', async (data) => {
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
    const cwdResult = await hecaton.terminal.get_cwd().catch(() => null);
    if (cwdResult && cwdResult.cwd) {
      state.cwd = cwdResult.cwd;
    } else {
      state.cwd = process.cwd();
    }
  }

  // Get initial cell size from host
  try {
    const cellSizeResult = await hecaton.window.get_cell_size().catch(() => null);
    if (cellSizeResult && cellSizeResult.cell_width && cellSizeResult.cell_height) {
      ui.cellW = Math.round(cellSizeResult.cell_width);
      ui.cellH = Math.round(cellSizeResult.cell_height);
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
    const gitDirResult = await hecaton.process.exec({
      program: 'git', args: ['rev-parse', '--git-dir'], cwd: state.cwd, timeout_ms: 3000
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
      const r = await hecaton.fs.stat({ path: filePath });
      return (r && r.exists && r.mtime_ms) ? r.mtime_ms : 0;
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
      const result = await hecaton.process.exec({
        program: 'git', args: ['--no-optional-locks', 'diff-files', '--name-only'], cwd: state.cwd, timeout_ms: 5000
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
