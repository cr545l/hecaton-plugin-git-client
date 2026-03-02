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

const { state, ui } = require('./state');
const { sendRpc } = require('./rpc');
const { handleRpcResponse } = require('./rpc');
const { refreshAsync, refreshLog, refreshFresh } = require('./refresh');
const { render } = require('./render');
const { handleKey, handleMouseData, cleanup } = require('./input');
const { handleContextMenuAction, handleDialogResult } = require('./context-menu');
const fs = require('fs');
const path = require('path');

async function main() {
  render();

  // Set up stdin FIRST so RPC responses can be received
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } catch { /* ignore */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (data) => {
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
    const hadMouse = handleMouseData(data);
    if (hadMouse) return;

    // Keyboard input
    handleKey(data);
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
  setupGitWatcher();

  // Graceful shutdown
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });
}

function setupGitWatcher() {
  if (!state.cwd || !state.isGitRepo) return;

  let debounceTimer = null;
  const watchers = [];

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

  // .git 디렉토리 감시 (stage, commit, checkout 등 git 명령 감지)
  const gitDir = path.join(state.cwd, '.git');
  try {
    watchers.push(fs.watch(gitDir, { recursive: true }, triggerRefresh));
  } catch { /* ignore */ }

  // 워킹 트리 감시 (파일 편집, 생성, 삭제 감지)
  const ignorePatterns = ['.git', 'node_modules', '.hg', '.svn'];
  try {
    watchers.push(fs.watch(state.cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const normalized = filename.replace(/\\/g, '/');
      for (const pattern of ignorePatterns) {
        if (normalized === pattern || normalized.startsWith(pattern + '/')) return;
      }
      triggerRefresh();
    }));
  } catch { /* ignore */ }

  // 폴링 fallback: .git/index, .git/HEAD mtime 변경 감지
  // fs.watch가 누락할 수 있는 외부 git 클라이언트 변경을 보완
  const pollTargets = [
    path.join(gitDir, 'index'),
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'refs'),
    path.join(gitDir, 'refs', 'heads'),
    path.join(gitDir, 'logs', 'HEAD'),
    path.join(gitDir, 'FETCH_HEAD'),
  ];
  let lastMtimes = pollTargets.map(f => {
    try { return fs.statSync(f).mtimeMs; } catch { return 0; }
  });
  const pollInterval = setInterval(() => {
    const current = pollTargets.map(f => {
      try { return fs.statSync(f).mtimeMs; } catch { return 0; }
    });
    let changed = false;
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== lastMtimes[i]) { changed = true; break; }
    }
    if (changed) {
      lastMtimes = current;
      triggerRefresh();
    }
  }, 1000);

  // 종료 시 watcher 정리
  function closeWatchers() {
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollInterval);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
  }
  process.on('SIGTERM', closeWatchers);
  process.on('SIGINT', closeWatchers);
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
