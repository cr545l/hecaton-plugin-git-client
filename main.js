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
const GIT_MTIME_POLL_INTERVAL_MS = 2000;
const GIT_WORKTREE_POLL_INTERVAL_MS = 15000;

function stopGitWatcher() {
  if (_gitWatcherCleanup) { _gitWatcherCleanup(); _gitWatcherCleanup = null; }
}

// context-menu 등 외부에서 워처 재시작 가능하도록 노출
ui.stopGitWatcher = stopGitWatcher;
ui.setupGitWatcher = () => setupGitWatcher();

// cwd당 1회만 시도하기 위한 메모. 같은 저장소를 다시 열어도 추가 spawn은 발생하지 않는다.
const _gitOptimizationsAppliedFor = new Set();

// status 가속을 위해 core.untrackedCache, core.fsmonitor를 자동 활성화한다.
// - 이미 사용자가 true/false로 명시한 경우는 건드리지 않는다 (의도 존중).
// - fsmonitor는 git 2.37+에서만 활성화 (그 이하에서는 동작이 다르다).
// - 모든 호출은 best-effort. 실패해도 silent.
async function applyGitOptimizations(cwd) {
  if (_gitOptimizationsAppliedFor.has(cwd)) return;
  _gitOptimizationsAppliedFor.add(cwd);

  // core.untrackedCache
  try {
    const cur = await hecaton.process.exec({
      program: 'git', args: ['config', '--local', '--get', 'core.untrackedCache'],
      cwd, timeout_ms: 3000,
    });
    const val = cur && cur.ok ? (cur.stdout || '').replace(/\r\n/g, '\n').trim().toLowerCase() : '';
    // exit_code != 0 이거나 stdout 비어있으면 미설정 → 자동 활성화
    if (val !== 'true' && val !== 'false') {
      await hecaton.process.exec({
        program: 'git', args: ['config', '--local', 'core.untrackedCache', 'true'],
        cwd, timeout_ms: 3000,
      });
      console.log('[git-client] enabled core.untrackedCache=true (' + cwd + ')');
    }
  } catch { /* ignore */ }

  // core.fsmonitor — git 2.37+ 필요
  try {
    const ver = await hecaton.process.exec({
      program: 'git', args: ['--version'],
      cwd, timeout_ms: 3000,
    });
    const verStr = ver && ver.ok ? (ver.stdout || '').replace(/\r\n/g, '\n').trim() : '';
    const m = verStr.match(/git version (\d+)\.(\d+)/);
    if (!m) return;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const supportsFsmonitor = (major > 2) || (major === 2 && minor >= 37);
    if (!supportsFsmonitor) return;

    const cur = await hecaton.process.exec({
      program: 'git', args: ['config', '--local', '--get', 'core.fsmonitor'],
      cwd, timeout_ms: 3000,
    });
    const val = cur && cur.ok ? (cur.stdout || '').replace(/\r\n/g, '\n').trim().toLowerCase() : '';
    // 미설정만 자동 활성화. true/false/외부 hook 경로가 잡혀 있으면 그대로 둔다.
    if (val !== '' && val !== 'true' && val !== 'false') return;
    if (val === '') {
      await hecaton.process.exec({
        program: 'git', args: ['config', '--local', 'core.fsmonitor', 'true'],
        cwd, timeout_ms: 3000,
      });
      console.log('[git-client] enabled core.fsmonitor=true (' + verStr + ')');
    }
  } catch { /* ignore */ }
}

async function setupGitWatcher() {
  stopGitWatcher(); // 기존 워처 정리
  if (!state.cwd || !state.isGitRepo) return;

  // 저장소별 1회 자동 활성화 (status 가속). state.isGitRepo 확인 후라 안전.
  applyGitOptimizations(state.cwd);

  let debounceTimer = null;
  const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';

  function triggerRefresh() {
    // 사용자 작업 직후 5초간은 폴링에 의한 중복 refresh 억제 (액션 연타 시 폴러와의 경합 방지)
    if (Date.now() - getLastUserRefreshTime() < 5000) return;
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
  // state.gitDir이 이미 캐시되어 있으면 재사용 — refreshAsync가 먼저 채웠을 수 있음
  if (state.gitDir) {
    gitDir = state.gitDir;
  } else {
    try {
      const gitDirResult = await hecaton.process.exec({
        program: 'git', args: ['rev-parse', '--git-dir'], cwd: state.cwd, timeout_ms: 3000
      });
      if (gitDirResult && gitDirResult.ok && gitDirResult.stdout) {
        const resolved = gitDirResult.stdout.replace(/\r\n/g, '\n').trim();
        if (resolved) {
          const isAbsolute = resolved.startsWith('/') || /^[A-Za-z]:[\\/]/.test(resolved);
          gitDir = isAbsolute ? resolved : (state.cwd + sep + resolved);
          state.gitDir = gitDir;
        }
      }
    } catch { /* fallback to .git */ }
  }
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
  }, GIT_MTIME_POLL_INTERVAL_MS);

  // 워킹 디렉토리 변경 감지 — 외부 도구의 워킹트리 수정은 .git/index mtime을 안 건드리므로
  // mtime 폴러로 잡을 수 없다. diff-files로만 감지 가능. spawn이 발생하므로 주기는 idle 부담을 고려해 둔다.
  let lastStatusSnapshot = '';
  let statusPolling = false;
  const statusPollInterval = setInterval(async () => {
    if (statusPolling) return;
    if (state.loading || state.minimized) return;
    if (state.mode !== 'normal') return;
    // 사용자 액션 직후 5초간은 polling spawn도 회피
    if (Date.now() - getLastUserRefreshTime() < 5000) return;
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
  }, GIT_WORKTREE_POLL_INTERVAL_MS);

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
