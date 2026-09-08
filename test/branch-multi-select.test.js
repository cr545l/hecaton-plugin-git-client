const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dialogs = [], menus = [], commands = [], copies = [];
global.hecaton = {
  initialState: { cols: 120, rows: 40 }, terminal: {}, on() {},
  fs: {}, window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({}), set: async () => ({}), remove: async () => ({}) },
  dialog: { show: async opts => { dialogs.push(opts); return {}; } },
  menu: { show: async opts => { menus.push(opts); return {}; } },
  clipboard: { write: async ({ text }) => { copies.push(text); return {}; } },
  process: { exec: async ({ program, args, cwd }) => {
    commands.push(args);
    try {
      return { ok: true, exit_code: 0, stdout: execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
    } catch (e) {
      return { ok: false, exit_code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  } },
};

const { state, ui, localRefKey, remoteRefKey } = require('../state');
const selection = require('../branch-selection');
const rendering = require('../render');
const originalRender = rendering.render;
rendering.render = () => {};
const refresh = require('../refresh');
let refreshes = 0, graphRebuilds = 0;
refresh.refreshAsync = async () => { refreshes++; };
refresh.refreshLog = () => {};
refresh.rebuildLogGraphRows = () => { graphRebuilds++; return true; };
refresh.updateLogDetail = () => {};
const { buildBranchesContextMenuItems, buildBranchContextMenuItems, buildRemoteBranchContextMenuItems, handleContextMenuAction, handleDialogResult } = require('../context-menu');
const { handleMouseData, handleKey, handleContextMenuRequest } = require('../input');
const { startSpinner, stopSpinner } = require('../spinner');
const { SCOPE } = require('../actions');
const { gitBranches, gitWorktrees, gitRemoteBranches } = require('../git');

const local = name => ({ action: 'goto-branch', branch: name, refKey: localRefKey(name) });
const remote = name => ({ action: 'goto-branch', branch: name, refKey: remoteRefKey(name) });
function setup() {
  Object.assign(state, { cwd: 'C:/branch-selection-test', branch: 'main', loading: false, isGitRepo: true,
    gitNotFound: false, indexLocked: false, spinnerActive: false, settlingWrite: false, operationState: null,
    minimized: false, error: null, conflictView: null, mode: 'normal', refreshing: false,
    logLoading: false, logLoadingMore: false, freshTimeWindowMode: false,
    branches: [{ name: 'main', isCurrent: true }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
    remoteBranches: ['origin/a'], remotes: ['origin'], stashes: [],
    worktrees: [{ branch: 'main', path: 'C:/branch-selection-test', isCurrent: true, isMain: true }],
    staged: [], unstaged: [], untracked: [], ignored: [], selectedFiles: new Set(),
    rightView: 'log', logItems: [], logSelectables: [], logCursor: 0, logScrollOffset: 0,
    logDetailLines: [], pendingDialogAction: null, pendingDialogTarget: null });
  Object.assign(ui, { termCols: 120, termRows: 40, cellW: 8, cellH: 16,
    collapsedSections: {}, collapsedGroups: {}, pinnedBranches: [], filteredRefs: [], hiddenRefs: [],
    leftPanelScrollOffset: 0, hoveredLeftPanelRow: -1, hoveredLogRow: -1, hoveredTitleZoneIndex: -1,
    leftPanelCollapsed: false, middlePanelCollapsed: false, rightPanelCollapsed: false,
    leftPanelActiveBranch: null, dragging: null, branchDragCandidate: null, leftPanelFullClickMap: null });
  selection.reset();
  dialogs.length = menus.length = commands.length = copies.length = 0;
  refreshes = graphRebuilds = 0;
}

function frame() {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = text => { output += text; return true; };
  try { originalRender(); } finally { process.stdout.write = write; }
  return output;
}
function click(name, modifier = 0, release = false) {
  const idx = ui.leftPanelClickMap.findIndex(e => e && !e.reveal && e.branch === name);
  assert.ok(idx >= 0, name + ' must be visible');
  const row = ui.lastLayout.startRow + (ui.lastLayout.titleRows || 2) + 1 + idx;
  const col = ui.lastLayout.startCol + 3;
  if (modifier === 2) return handleContextMenuRequest(col, row);
  return handleMouseData(`\x1b[<${modifier};${col};${row}${release ? 'm' : 'M'}`);
}
function target(...entries) {
  selection.select(entries[0]);
  for (const entry of entries.slice(1)) selection.select(entry, 'toggle');
  return selection.capture(entries[0]);
}
const enabled = (t, action) => buildBranchesContextMenuItems(t).find(i => i.id === 'branch_' + (action === 'copy' ? 'copy_name' : action)).enabled !== false;

test('mouse modifiers, range, context selection and Escape use the branch list', async () => {
  setup(); frame();
  await click('a');
  await click('c', 4);
  assert.deepEqual([...ui.selectedBranchRefs], ['a', 'b', 'c'].map(localRefKey));
  assert.equal(ui.branchDragCandidate, null);
  await click('b', 16);
  await click('b', 16, true);
  assert.deepEqual([...ui.selectedBranchRefs], ['a', 'c'].map(localRefKey));
  await click('a', 2);
  assert.equal(menus.at(-1).items[0].id, 'branch_checkout');
  assert.equal(ui.selectedBranchRefs.size, 2);
  assert.match(frame(), /2 branches selected/);
  await click('b', 2);
  assert.deepEqual([...ui.selectedBranchRefs], [localRefKey('b')]);
  await handleKey('\x1b');
  assert.equal(ui.selectedBranchRefs.size, 0);
});

test('range skips headers, includes scrolled rows, and deduplicates pinned refs', () => {
  setup();
  ui.leftPanelFullClickMap = [local('a'), { action: 'toggle-section' }, local('a'), local('b'), local('c')];
  selection.select(local('a'));
  ui.leftPanelClickMap = [local('c')];
  selection.select(local('c'), 'range');
  assert.deepEqual([...ui.selectedBranchRefs], ['a', 'b', 'c'].map(localRefKey));
  state.branches.reverse(); selection.sync();
  assert.equal(ui.selectedBranchRefs.size, 3);
  state.branches = state.branches.filter(b => b.name !== 'b'); selection.sync();
  assert.equal(ui.selectedBranchRefs.has(localRefKey('b')), false);
  state.cwd = 'C:/another-repo'; selection.sync();
  assert.equal(ui.selectedBranchRefs.size, 0);
  assert.equal(ui.contextMenuBranches, null);
});

test('local/remote refs with identical display names remain distinct', () => {
  setup(); state.branches.push({ name: 'origin/a' });
  const t = target(local('origin/a'), remote('origin/a'));
  assert.equal(selection.resolve(t).length, 2);
  assert.equal(enabled(t, 'delete'), false);
  assert.equal(enabled(t, 'pin'), false);
  assert.equal(enabled(t, 'copy'), true);
});

test('range anchors to the clicked occurrence in Pinned or Branches', () => {
  setup();
  const pinnedA = local('a'), treeA = local('a'), treeC = local('c');
  ui.leftPanelFullClickMap = [pinnedA, local('b'), treeA, treeC];
  selection.select(treeA);
  selection.select(treeC, 'range');
  assert.deepEqual([...ui.selectedBranchRefs], ['a', 'c'].map(localRefKey));
  selection.select(pinnedA);
  selection.select(treeC, 'range');
  assert.deepEqual([...ui.selectedBranchRefs], ['a', 'b', 'c'].map(localRefKey));
});

test('selection rendering survives a removed anchor and highlights duplicate rows', () => {
  setup();
  target(local('a'), local('b'), local('c'));
  state.branches = state.branches.filter(b => b.name !== 'c');
  ui.pinnedBranches = ['a'];
  const lines = rendering.buildLeftPanel(40, 40);
  const { colors } = require('../ansi');
  for (const name of ['a', 'b']) {
    const rows = ui.leftPanelClickMap.map((entry, i) => entry && entry.branch === name ? i : -1).filter(i => i >= 0);
    assert.equal(rows.length, name === 'a' ? 2 : 1);
    for (const row of rows) assert.ok(lines[row].includes(colors.cursorBg));
  }
  assert.equal(ui.branchSelectionAnchor, null);
});

test('all targets must qualify, with current/worktree and busy restrictions', () => {
  setup();
  assert.equal(enabled(target(local('a'), local('b')), 'delete'), true);
  const current = target(local('main'), local('b'));
  assert.equal(enabled(current, 'delete'), false);
  assert.equal(enabled(current, 'hide'), false);
  state.worktrees.push({ branch: 'b', path: 'C:/other' });
  const held = target(local('a'), local('b'));
  assert.equal(enabled(held, 'delete'), false);
  state.worktrees.pop();
  const op = startSpinner('test', [SCOPE.REFS]);
  try {
    assert.equal(enabled(held, 'delete'), false);
    assert.equal(enabled(held, 'copy'), true);
    assert.equal(enabled(held, 'filter'), true);
  } finally { stopSpinner(op); }
});

test('shared UI actions set mixed selections uniformly, copy every name, and rebuild once', async () => {
  setup(); target(local('a'), local('b'));
  ui.pinnedBranches = ['a'];
  await handleContextMenuAction('branch_pin');
  assert.deepEqual(ui.pinnedBranches, ['a', 'b']);
  await handleContextMenuAction('branch_pin');
  assert.deepEqual(ui.pinnedBranches, []);
  ui.filteredRefs = [localRefKey('a')];
  await handleContextMenuAction('branch_filter');
  assert.deepEqual(ui.filteredRefs, ['a', 'b'].map(localRefKey));
  assert.equal(graphRebuilds, 1);
  await handleContextMenuAction('branch_hide');
  assert.deepEqual(ui.hiddenRefs, ['a', 'b'].map(localRefKey));
  assert.deepEqual(ui.filteredRefs, []);
  await handleContextMenuAction('branch_hide');
  assert.deepEqual(ui.hiddenRefs, []);
  await handleContextMenuAction('branch_copy_name');
  assert.equal(copies.at(-1), 'a\nb');
  assert.equal(commands.length, 0);
});

test('disabled and stale menu actions cannot dispatch writes or hide current branch', async () => {
  setup(); target(local('a'), local('main'));
  await handleContextMenuAction('branch_delete');
  await handleContextMenuAction('branch_hide');
  await handleContextMenuAction('branch_checkout');
  assert.equal(state.pendingDialogAction, null);
  assert.deepEqual(ui.hiddenRefs, []);
  target(local('a'), local('b'));
  state.branches = state.branches.filter(b => b.name !== 'b');
  await handleContextMenuAction('branch_pin');
  assert.deepEqual(ui.pinnedBranches, []);
  assert.equal(commands.length, 0);
});

test('mixed local and remote selections apply filters to exact refs', async () => {
  setup();
  state.branches.push({ name: 'origin/a' });
  target(local('a'), remote('origin/a'));
  await handleContextMenuAction('branch_filter');
  assert.deepEqual(ui.filteredRefs, [localRefKey('a'), remoteRefKey('origin/a')]);
  await handleContextMenuAction('branch_filter');
  assert.deepEqual(ui.filteredRefs, []);
  await handleContextMenuAction('branch_hide');
  assert.deepEqual(ui.hiddenRefs, [localRefKey('a'), remoteRefKey('origin/a')]);
  await handleContextMenuAction('branch_copy_name');
  assert.equal(copies.at(-1), 'a\norigin/a');
  assert.equal(commands.length, 0);
});

test('a write started during confirmation blocks batch deletion', async () => {
  setup(); target(local('a'), local('b'));
  await handleContextMenuAction('branch_delete');
  const op = startSpinner('test', [SCOPE.REFS]);
  try {
    await handleDialogResult({ button_id: 'delete' });
    assert.equal(commands.length, 0);
    assert.equal(state.pendingDialogAction, null);
  } finally { stopSpinner(op); }
});

test('single and multiple selections share menu ids, order, icons and shortcuts', () => {
  setup();
  const shape = items => items.map(({ id, type, icon, shortcut, color }) => ({ id, type, icon, shortcut, color }));
  const single = buildBranchContextMenuItems('a');
  const multiple = buildBranchesContextMenuItems(target(local('a'), local('b')));
  assert.deepEqual(shape(single), shape(multiple));
  assert.equal(single.find(i => i.id === 'branch_checkout').enabled, true);
  assert.equal(multiple.find(i => i.id === 'branch_checkout').enabled, false);
  for (const item of multiple.filter(i => i.id)) assert.ok(item.icon, item.id + ' has an icon');
  assert.equal(multiple.find(i => i.id === 'branch_copy_name').icon, 'copy');
  assert.equal(multiple.find(i => i.id === 'branch_delete_remote').icon, 'warning');
  assert.equal(multiple.some(i => i.id && i.id.startsWith('branches_')), false);
  state.remoteBranches.push('origin/b');
  const remoteSingle = buildRemoteBranchContextMenuItems('origin/a');
  const remoteMultiple = buildBranchesContextMenuItems(target(remote('origin/a'), remote('origin/b')));
  assert.deepEqual(shape(remoteSingle), shape(remoteMultiple));
  assert.equal(remoteMultiple.find(i => i.id === 'remotebranch_delete_remote').enabled, true);
  assert.equal(remoteMultiple.find(i => i.id === 'branch_delete').enabled, false);
});

test('network capabilities require an unambiguous destination for every selection', () => {
  setup(); state.remotes = ['origin', 'backup'];
  const t = target(local('a'), local('b'));
  assert.equal(enabled(t, 'push'), false);
  assert.equal(enabled(t, 'delete_remote'), false);
  state.branches.find(b => b.name === 'a').upstream = 'origin/topic/a';
  state.branches.find(b => b.name === 'b').upstream = 'backup/topic/b';
  assert.equal(enabled(t, 'push'), true);
  assert.equal(enabled(t, 'ff'), true);
  assert.equal(enabled(t, 'delete_remote'), true);
  assert.equal(enabled(t, 'force_push'), false);
  assert.equal(enabled(t, 'pull'), false);
  const configOp = startSpinner('test', [SCOPE.CONFIG]);
  try {
    assert.equal(enabled(t, 'push'), false);
    assert.equal(enabled(t, 'delete_remote'), false);
    assert.equal(buildBranchContextMenuItems('a').find(i => i.id === 'branch_ff').enabled, false);
    assert.equal(enabled(t, 'copy'), true);
  } finally { stopSpinner(configOp); }
  state.worktrees.push({ branch: 'a', path: 'C:/other' });
  assert.equal(enabled(t, 'ff'), false);
  assert.equal(enabled(t, 'push'), true);
  state.remoteBranches.push('origin/HEAD');
  assert.equal(selection.allowed('delete_remote', target(remote('origin/a'), remote('origin/HEAD'))), false);
});

const tempRoots = [];
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-multi-'));
  tempRoots.push(cwd);
  git(cwd, 'init', '--initial-branch=main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'commit', '--allow-empty', '-m', 'base');
  git(cwd, 'branch', 'a');
  git(cwd, 'checkout', '-b', 'b');
  git(cwd, 'commit', '--allow-empty', '-m', 'unmerged');
  git(cwd, 'checkout', 'main');
  state.cwd = cwd; state.branches = await gitBranches(cwd); state.worktrees = await gitWorktrees(cwd);
  selection.reset();
  return cwd;
}
test.after(() => {
  for (const dir of tempRoots) {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('branch-multi-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real Git deletion keeps unmerged branches and aggregates partial failure', async () => {
  setup(); const cwd = await repo();
  target(local('a'), local('b'));
  ui.pinnedBranches = ['a', 'b']; ui.filteredRefs = ['a', 'b'].map(localRefKey);
  await handleContextMenuAction('branch_delete');
  assert.equal(state.pendingDialogAction, 'delete-branches');
  assert.match(dialogs.at(-1).message, /a\nb/);
  selection.select(local('main')); // Confirmation retains the captured targets.
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(git(cwd, 'branch', '--list', 'a'), '');
  assert.notEqual(git(cwd, 'branch', '--list', 'b'), '');
  assert.equal(git(cwd, 'branch', '--show-current'), 'main');
  assert.deepEqual(ui.pinnedBranches, ['b']);
  assert.deepEqual(ui.filteredRefs, [localRefKey('b')]);
  assert.match(dialogs.at(-1).message, /Succeeded: 1 \/ Failed: 1/);
  assert.match(dialogs.at(-1).message, /b:/);
  assert.equal(commands.some(args => args.includes('-D')), false);
  assert.equal(refreshes, 1);
  assert.equal(state.spinnerActive, false);
});

test('confirmation rechecks external checkout before deleting any target', async () => {
  setup(); const cwd = await repo();
  target(local('a'), local('b'));
  await handleContextMenuAction('branch_delete');
  git(cwd, 'checkout', 'a');
  await handleDialogResult({ button_id: 'delete' });
  assert.notEqual(git(cwd, 'branch', '--list', 'b'), '');
  assert.equal(commands.some(args => args[0] === 'branch' && args[1] === '-d'), false);
  assert.equal(state.spinnerActive, false);
});

test('cancel and repository changes never delete branches', async () => {
  setup(); target(local('a'), local('b'));
  await handleContextMenuAction('branch_delete');
  await handleDialogResult({ button_id: 'cancel' });
  assert.equal(commands.length, 0);
  await handleContextMenuAction('branch_delete');
  state.cwd = 'C:/another-repo';
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(commands.length, 0);
});

async function networkRepo() {
  const cwd = await repo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-multi-'));
  tempRoots.push(root);
  const origin = path.join(root, 'origin.git');
  const backup = path.join(root, 'backup.git');
  for (const [name, dir] of [['origin', origin], ['backup', backup]]) {
    git(root, 'init', '--bare', '--initial-branch=main', dir);
    git(cwd, 'remote', 'add', name, dir);
  }
  git(cwd, 'push', '-u', 'origin', 'refs/heads/a:refs/heads/topic/a');
  git(cwd, 'push', '-u', 'backup', 'refs/heads/b:refs/heads/topic/b');
  state.branches = await gitBranches(cwd);
  state.remoteBranches = await gitRemoteBranches(cwd);
  state.remotes = ['origin', 'backup'];
  commands.length = 0;
  return { cwd, origin, backup };
}

test('remote deletion aggregates server rejection and keeps local branches and same-named tags', async () => {
  setup(); const { cwd, origin, backup } = await networkRepo();
  git(cwd, 'tag', 'topic/a', 'a');
  git(cwd, 'push', 'origin', 'refs/tags/topic/a');
  git(backup, 'config', 'receive.denyDeletes', 'true');
  const localA = git(cwd, 'rev-parse', 'a');
  target(remote('origin/topic/a'), remote('backup/topic/b'));
  await handleContextMenuAction('remotebranch_delete_remote');
  assert.equal(state.pendingDialogAction, 'delete-remote-branches');
  assert.match(dialogs.at(-1).message, /refs\/heads\/topic\/a/);
  assert.match(dialogs.at(-1).message, /refs\/heads\/topic\/b/);
  assert.equal(commands.some(args => args[0] === 'push'), false);
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(git(origin, 'branch', '--list', 'topic/a'), '');
  assert.notEqual(git(backup, 'branch', '--list', 'topic/b'), '');
  assert.equal(git(cwd, 'rev-parse', 'a'), localA);
  assert.equal(git(origin, 'rev-parse', 'refs/tags/topic/a'), localA);
  assert.match(dialogs.at(-1).message, /Succeeded: 1 \/ Failed: 1/);
  assert.match(dialogs.at(-1).message, /backup\/topic\/b/);
  assert.equal(refreshes, 1);
  assert.equal(state.spinnerActive, false);
});

test('local upstream and remote selections delete one shared destination once', async () => {
  setup(); const { cwd, origin } = await networkRepo();
  target(local('a'), remote('origin/topic/a'));
  await handleContextMenuAction('branch_delete_remote');
  assert.equal(state.pendingDialogTarget.targets.length, 1);
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(git(origin, 'branch', '--list', 'topic/a'), '');
  assert.notEqual(git(cwd, 'branch', '--list', 'a'), '');
  assert.equal(commands.filter(args => args[0] === 'push').length, 1);
  assert.deepEqual(commands.find(args => args[0] === 'push'), ['push', 'origin', '--delete', 'refs/heads/topic/a']);
});

test('remote URL and upstream changes after confirmation block deletion', async () => {
  setup(); const { cwd, origin, backup } = await networkRepo();
  target(local('a'), local('b'));
  await handleContextMenuAction('branch_delete_remote');
  git(cwd, 'remote', 'set-url', '--push', 'origin', backup);
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(commands.some(args => args[0] === 'push'), false);
  assert.notEqual(git(origin, 'branch', '--list', 'topic/a'), '');
  git(cwd, 'remote', 'set-url', '--push', 'origin', origin);
  await handleContextMenuAction('branch_delete_remote');
  git(cwd, 'branch', '--set-upstream-to=backup/topic/b', 'a');
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(commands.some(args => args[0] === 'push'), false);
  assert.equal(state.spinnerActive, false);
});

test('remote deletion cancellation and repository changes cannot push a deletion', async () => {
  setup(); await networkRepo();
  target(remote('origin/topic/a'), remote('backup/topic/b'));
  await handleContextMenuAction('remotebranch_delete_remote');
  const configOp = startSpinner('test', [SCOPE.CONFIG]);
  try { await handleDialogResult({ button_id: 'delete' }); }
  finally { stopSpinner(configOp); }
  assert.equal(commands.some(args => args[0] === 'push'), false);
  await handleContextMenuAction('remotebranch_delete_remote');
  await handleDialogResult({ button_id: 'cancel' });
  assert.equal(commands.some(args => args[0] === 'push'), false);
  await handleContextMenuAction('remotebranch_delete_remote');
  state.cwd = 'C:/different-repo';
  await handleDialogResult({ button_id: 'delete' });
  assert.equal(commands.some(args => args[0] === 'push'), false);
});

test('batch Push and Fast-forward use each upstream and preserve the checked-out branch', async () => {
  setup(); const { cwd, origin, backup } = await networkRepo();
  const previous = {}, next = {};
  const main = git(cwd, 'rev-parse', 'main');
  for (const name of ['a', 'b']) {
    previous[name] = git(cwd, 'rev-parse', name);
    git(cwd, 'checkout', name);
    git(cwd, 'commit', '--allow-empty', '-m', 'next ' + name);
    next[name] = git(cwd, 'rev-parse', name);
  }
  git(cwd, 'checkout', 'main');
  state.branches = await gitBranches(cwd);
  target(local('a'), local('b'));
  await handleContextMenuAction('branch_push');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/topic/a'), next.a);
  assert.equal(git(backup, 'rev-parse', 'refs/heads/topic/b'), next.b);
  assert.equal(git(origin, 'branch', '--list', 'a'), '');
  assert.match(dialogs.at(-1).message, /Succeeded: 2 \/ Failed: 0/);
  for (const name of ['a', 'b']) git(cwd, 'branch', '-f', name, previous[name]);
  state.branches = await gitBranches(cwd);
  commands.length = 0;
  await handleContextMenuAction('branch_ff');
  assert.equal(git(cwd, 'rev-parse', 'a'), next.a);
  assert.equal(git(cwd, 'rev-parse', 'b'), next.b);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), main);
  assert.equal(git(cwd, 'branch', '--show-current'), 'main');
  assert.equal(commands.some(args => args[0] === 'checkout'), false);
  assert.equal(commands.filter(args => args[0] === 'fetch').length, 2);
  assert.match(dialogs.at(-1).message, /Succeeded: 2 \/ Failed: 0/);
});
