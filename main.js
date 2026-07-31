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
 *   v       - Toggle staged diff side/unified view
 *   Enter   - Execute commit (in commit mode)
 *   Esc     - Cancel commit / close
 *   Tab     - Switch panel focus
 *   r       - Refresh
 *   q       - Quit
 */

const { state, ui, init: initState } = require('./state');
const { refreshAsync, refreshLog, refreshFresh, refreshInBackground, getLastUserRefreshTime, computeRefsTreeSignature } = require('./refresh');
const { render } = require('./render');
const { handleKey, handleMouseData, cleanup, handleContextMenuRequest, maybeLoadMoreLog } = require('./input');
const { handleContextMenuAction, handleDialogResult } = require('./context-menu');
const { resolveWorkTreeRoot } = require('./git');
const hostScroll = require('./scroll');
const persist = require('./persist');
const path = require('path');

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

  // Resize/font-change 이벤트는 드래그 한 번에 수십 개가 쏟아진다. 매 이벤트마다
  // full-screen erase + 무거운 sixel 재인코딩을 돌리면 그래프가 내내 깜빡인다.
  // 치수는 즉시 반영하되(레이아웃 계산은 최신 값으로), 실제 render는 짧게
  // 디바운스해 마지막 상태 한 번만 그린다. 트레일링 엣지를 보장해 최종 프레임을 놓치지 않는다.
  let _resizeTimer = null;
  const RESIZE_DEBOUNCE_MS = 24;
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
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => { _resizeTimer = null; render(); }, RESIZE_DEBOUNCE_MS);
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

  // Host-owned scroll: subscribe to scroll.update (host momentum → integer
  // offsets) and re-render. No-op on hosts without the scroll API.
  hostScroll.init({ render, maybeLoadMoreLog });

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
  // 영속화 게이트만 연다 — 실제 설정 로드는 cwd 확정 후 attachRepo에서
  await persist.load();
  state.minimized = hecaton.initialState?.minimized ?? false;
  render();

  // Get CWD from host (launchParams.path overrides)
  const params = hecaton.initialState?.params;
  if (params && params.path) {
    state.cwd = params.path;
  } else if (hecaton.initialState?.cwd) {
    state.cwd = hecaton.initialState.cwd;
  } else {
    const cwdResult = await hecaton.terminal.get_cwd().catch(() => null);
    if (cwdResult && cwdResult.cwd) {
      state.cwd = cwdResult.cwd;
    } else {
      state.cwd = process.cwd();
    }
  }
  // 저장소 하위 디렉터리에서 열렸으면 워크트리 루트로 맞춘다 — git이 보고하는
  // 파일 경로(루트 기준)와 pathspec 해석 기준(cwd)을 일치시켜야 stage/discard/diff가 맞는다.
  state.cwd = await resolveWorkTreeRoot(state.cwd);
  // 저장된 UI 설정(탭/패널/분할 비율 등)을 프로젝트 파일에서 복원
  await persist.attachRepo(state.cwd);

  const primedFromDisk = await primeInitialBranchFromDisk();
  if (primedFromDisk) {
    render();
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
  let initialRefresh = null;
  if (primedFromDisk) {
    render();
    initialRefresh = refreshInBackground({
      statusOnly: true,
      loadBranch: true,
      singleProcessStatus: true,
      fastFirstPaint: true,
      statusTimeout: 60000,
    }, { message: 'Scanning repository...' });
  } else {
    await refreshAsync({ statusOnly: true, loadBranch: true, singleProcessStatus: true, fastFirstPaint: true });
    render();
  }

  // Auto-refresh: watch .git directory for changes
  setupGitWatcher().catch(() => null);

  const scheduleStartupBackgroundWork = () => {
    if (!state.isGitRepo) return;
    if (state.rightView === 'log') {
      setTimeout(() => {
        if (state.rightView === 'log') refreshLog();
      }, 250);
    }

    setTimeout(() => {
      if (!state.isGitRepo) return;
      refreshAsync({ metadataOnly: true, silent: true, loadGuiConfig: true }).then(() => {
        if (state.rightView === 'log') refreshLog();
        else if (state.logItems.length === 0 && !state.logLoading) refreshLog({ prefetch: true });
        if (state.rightView === 'fresh') refreshFresh();
        render();
      }).catch(() => null);
    }, 1000);
  };

  if (initialRefresh) {
    initialRefresh.finally(scheduleStartupBackgroundWork);
  } else {
    scheduleStartupBackgroundWork();
  }

  // Graceful shutdown — 설정 플러시는 best-effort (300ms 내 완료 못 하면 그냥 종료)
  const shutdown = () => {
    stopGitWatcher();
    Promise.resolve(persist.flushNow()).catch(() => null).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}

async function primeInitialBranchFromDisk() {
  if (!state.cwd || state.branch) return false;
  const gitDir = await findGitDirFromDisk(state.cwd);
  if (!gitDir) return false;
  const branch = await readBranchFromGitDir(gitDir);
  state.gitDir = gitDir;
  state.isGitRepo = true;
  state.branch = branch || 'HEAD';
  state.error = null;
  hecaton.window.set_title({ title: state.branch }).catch(() => null);
  return true;
}

async function findGitDirFromDisk(cwd) {
  let dir = path.resolve(cwd);
  while (dir) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = await hecaton.fs.stat({ path: dotGit });
      if (st && st.exists) {
        if (st.is_dir) return dotGit;
        const res = await hecaton.fs.read_file({ path: dotGit });
        const content = typeof res === 'string' ? res : (res && res.content) ? res.content : '';
        const m = content.match(/^gitdir:\s*(.+)\s*$/i);
        if (m) return path.resolve(dir, m[1].trim());
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return '';
}

async function readBranchFromGitDir(gitDir) {
  try {
    const res = await hecaton.fs.read_file({ path: path.join(gitDir, 'HEAD') });
    const head = (typeof res === 'string' ? res : (res && res.content) ? res.content : '').trim();
    if (head.startsWith('ref: refs/heads/')) return head.substring('ref: refs/heads/'.length);
    if (head) return 'HEAD (detached)';
  } catch { /* ignore */ }
  return '';
}

let _gitWatcherCleanup = null;
const GIT_MTIME_POLL_INTERVAL_MS = 2000;
const GIT_WORKTREE_POLL_INTERVAL_MS = 3000;
const USER_ACTION_REFRESH_SUPPRESS_MS = 1500;

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
  let pendingAutoRefreshOptions = null;
  const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';

  function mergeAutoRefreshOptions(existing, incoming) {
    if (!existing) return { ...incoming };
    if (existing.statusOnly === true && incoming.statusOnly === true) {
      return { statusOnly: true };
    }
    return {};
  }

  function triggerRefresh(options = {}) {
    // Delay auto-refresh briefly after local actions, but do not drop it.
    pendingAutoRefreshOptions = mergeAutoRefreshOptions(pendingAutoRefreshOptions, options);
    if (debounceTimer) clearTimeout(debounceTimer);
    const elapsed = Date.now() - getLastUserRefreshTime();
    const delay = elapsed < USER_ACTION_REFRESH_SUPPRESS_MS
      ? USER_ACTION_REFRESH_SUPPRESS_MS - elapsed
      : 150;
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const refreshOptions = pendingAutoRefreshOptions || {};
      pendingAutoRefreshOptions = null;
      if (state.loading || state.minimized) return;
      if (state.mode !== 'normal') return;
      await refreshAsync(refreshOptions);
      if (!refreshOptions.statusOnly && state.rightView === 'log') refreshLog();
      if (state.rightView === 'fresh') refreshFresh();
      render();
    }, delay);
  }

  // 폴링으로 .git 상태 변경 감지 (fs.watch 대신 fs_stat 호스트 API 사용)
  // Worktree인 경우 .git은 파일이므로 실제 git 디렉토리를 찾아야 함
  let gitDir = state.cwd + sep + '.git';
  let commonDir = '';
  // state.gitDir이 이미 캐시되어 있으면 재사용 — refreshAsync가 먼저 채웠을 수 있음
  if (state.gitDir && state.gitCommonDir) {
    gitDir = state.gitDir;
    commonDir = state.gitCommonDir;
  } else {
    try {
      const gitDirResult = await hecaton.process.exec({
        program: 'git', args: ['rev-parse', '--git-dir', '--git-common-dir'], cwd: state.cwd, timeout_ms: 3000
      });
      if (gitDirResult && gitDirResult.ok && gitDirResult.stdout) {
        const lines = gitDirResult.stdout.replace(/\r\n/g, '\n').split('\n');
        const toAbs = (v) => {
          const trimmed = (v || '').trim();
          if (!trimmed) return '';
          const isAbsolute = trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed);
          return isAbsolute ? trimmed : (state.cwd + sep + trimmed);
        };
        const resolved = toAbs(lines[0]);
        if (resolved) {
          gitDir = resolved;
          state.gitDir = gitDir;
        }
        commonDir = toAbs(lines[1]);
        if (commonDir) state.gitCommonDir = commonDir;
      }
    } catch { /* fallback to .git */ }
  }
  // linked worktree면 index/HEAD/logs는 per-worktree git dir에, refs/packed-refs는 공용 dir에 있다.
  if (!commonDir) commonDir = gitDir;
  // refs 하위는 mtime만으로 변경을 잡을 수 없어(디렉터리 mtime은 직접 자식만 반영)
  // computeRefsTreeSignature로 따로 감시한다. 여기 남긴 refs/refs/heads는
  // read_dir을 제공하지 않는 호스트에서의 폴백이다.
  const pollTargets = [
    gitDir + sep + 'index',
    gitDir + sep + 'HEAD',
    gitDir + sep + 'logs' + sep + 'HEAD',
    gitDir + sep + 'FETCH_HEAD',
    commonDir + sep + 'refs',
    commonDir + sep + 'refs' + sep + 'heads',
    commonDir + sep + 'packed-refs',
    commonDir + sep + 'worktrees',
  ];

  async function statMtime(filePath) {
    try {
      const r = await hecaton.fs.stat({ path: filePath });
      return (r && r.exists && r.mtime_ms) ? r.mtime_ms : 0;
    } catch { return 0; }
  }

  function splitNul(raw) {
    return (raw || '').split('\0').filter(Boolean);
  }

  async function statWorktreeEntry(file) {
    try {
      const r = await hecaton.fs.stat({ path: path.join(state.cwd, file) });
      if (!r || !r.exists) return file + '\tmissing';
      const type = r.is_dir ? 'd' : 'f';
      const mtime = r.mtime_ms || 0;
      const size = r.size || 0;
      return file + '\t' + type + '\t' + mtime + '\t' + size;
    } catch {
      return file + '\tmissing';
    }
  }

  async function buildWorktreeSnapshot() {
    const [diffResult, untrackedResult] = await Promise.all([
      hecaton.process.exec({
        program: 'git',
        args: ['--no-optional-locks', 'diff-files', '--name-only', '-z'],
        cwd: state.cwd,
        timeout_ms: 5000,
      }),
      hecaton.process.exec({
        program: 'git',
        args: ['--no-optional-locks', 'ls-files', '--others', '--directory', '--no-empty-directory', '-z', '--exclude-standard'],
        cwd: state.cwd,
        timeout_ms: 5000,
      }),
    ]);
    if (!diffResult || !diffResult.ok) return null;
    const diffRaw = diffResult.stdout || '';
    const untrackedRaw = (untrackedResult && untrackedResult.ok) ? (untrackedResult.stdout || '') : '';
    const files = new Set();
    for (const file of splitNul(diffRaw)) files.add(file);
    for (let file of splitNul(untrackedRaw)) {
      if (file.endsWith('/')) file = file.slice(0, -1);
      if (file) files.add(file);
    }
    const stats = await Promise.all(Array.from(files).sort().map(statWorktreeEntry));
    return diffRaw + '\x1e' + untrackedRaw + '\x1e' + stats.join('\x1e');
  }

  let lastMtimes = await Promise.all(pollTargets.map(statMtime));
  let lastRefsSig = await computeRefsTreeSignature(commonDir).catch(() => '');
  let metaPolling = false;
  const pollInterval = setInterval(async () => {
    if (metaPolling) return;
    metaPolling = true;
    try {
      const [current, refsSig] = await Promise.all([
        Promise.all(pollTargets.map(statMtime)),
        // 스캔 실패 시 직전 값을 그대로 써서 오탐 refresh를 만들지 않는다.
        computeRefsTreeSignature(commonDir).catch(() => lastRefsSig),
      ]);
      let changed = refsSig !== lastRefsSig;
      for (let i = 0; !changed && i < current.length; i++) {
        if (current[i] !== lastMtimes[i]) changed = true;
      }
      if (changed) {
        lastMtimes = current;
        lastRefsSig = refsSig;
        triggerRefresh();
      }
    } finally {
      metaPolling = false;
    }
  }, GIT_MTIME_POLL_INTERVAL_MS);

  // Worktree edits do not touch .git/index. Track names plus mtimes so
  // repeated edits to an already-modified file also refresh the diff/status.
  let lastStatusSnapshot = await buildWorktreeSnapshot().catch(() => '') || '';
  let statusPolling = false;
  const statusPollInterval = setInterval(async () => {
    if (statusPolling) return;
    if (state.loading || state.minimized) return;
    if (state.mode !== 'normal') return;
    // Avoid polling during the short action-coalescing window.
    if (Date.now() - getLastUserRefreshTime() < USER_ACTION_REFRESH_SUPPRESS_MS) return;
    statusPolling = true;
    try {
      const snapshot = await buildWorktreeSnapshot();
      if (snapshot !== null && snapshot !== lastStatusSnapshot) {
        lastStatusSnapshot = snapshot;
        triggerRefresh({ statusOnly: true });
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
