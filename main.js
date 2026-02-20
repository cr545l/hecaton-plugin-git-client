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
const { refresh, refreshAsync, refreshLog } = require('./refresh');
const { render } = require('./render');
const { handleKey, handleMouseData, cleanup } = require('./input');
const { handleContextMenuAction } = require('./context-menu');
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
    // Check for RPC messages from host.
    if (data.indexOf('__HECA_RPC__') !== -1) {
      const segments = data.split('__HECA_RPC__');
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          if (json.method === 'resize' && json.params) {
            ui.termCols = json.params.cols || ui.termCols;
            ui.termRows = json.params.rows || ui.termRows;
            render();
          } else if (json.method === 'minimize') {
            state.minimized = true;
            render();
          } else if (json.method === 'maximize') {
            // Host handles sizing; plugin just re-renders on resize
          } else if (json.method === 'restore') {
            state.minimized = false;
            refresh();
            render();
          } else if (json.method === 'context_menu_action' && json.params) {
            handleContextMenuAction(json.params.id);
          } else {
            handleRpcResponse(json);
          }
        } catch { /* ignore malformed segment */ }
      }
      return;
    }

    // Ignore input while loading
    if (state.loading) return;

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

  function triggerRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (state.loading || state.mode !== 'normal') return;
      refresh();
      if (state.rightView === 'log') refreshLog();
      render();
    }, 300);
  }

  const gitDir = path.join(state.cwd, '.git');
  try {
    fs.watch(gitDir, { recursive: true }, triggerRefresh);
  } catch { /* ignore */ }
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
