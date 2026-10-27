const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const dialogs = [], calls = [], toasts = [], handlers = new Map();
let nextId = 0, configResult, dialogFailure, refreshes;
const file = 'evidence/' + 'nested-directory/'.repeat(16) + 'result.json';
const diagnostic = 'error: open("' + file + '"): Filename too long\n'
  + 'error: unable to index file ' + file + '\nfatal: adding files failed\n';
const emit = (name, value) => handlers.get(name)(value);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function failedSpawn(params) {
  calls.push({ kind: 'spawn', ...params });
  const process_id = String(++nextId);
  // The recovery's config write is streamed like every other write.
  if (params.args[0] === 'config') {
    Promise.resolve(configResult).then(result => {
      if (result.stderr) emit('process_output', { process_id, stream: 'stderr', data: result.stderr });
      emit('process_exited', { process_id, ok: result.ok, exit_code: result.exit_code });
    });
    return Promise.resolve({ ok: true, process_id });
  }
  emit('process_output', { process_id, stream: 'stderr', data: 'warning: scan details\n'.repeat(1200) });
  emit('process_output', { process_id, stream: 'stderr', data: diagnostic.slice(0, -3) });
  emit('process_output', { process_id, stream: 'stderr', data: diagnostic.slice(-3) });
  emit('process_exited', { process_id, ok: true, exit_code: 128 });
  return Promise.resolve({ ok: true, process_id });
}

global.hecaton = {
  initialState: { cols: 160, rows: 40 }, terminal: {}, fs: {},
  on: (name, handler) => handlers.set(name, handler),
  window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({}), set: async () => ({}), remove: async () => ({}) },
  process: {
    spawn: failedSpawn,
    exec: async params => { calls.push({ kind: 'exec', ...params }); return configResult; },
  },
  dialog: { show: params => {
    dialogs.push(params);
    if (dialogFailure === true) return Promise.reject(new Error('modal unavailable'));
    return Promise.resolve(dialogFailure || { ok: true });
  } },
};

const { state, ui } = require('../state');
const perms = require('../permissions');
const spinner = require('../spinner');
spinner.showToast = message => { toasts.push(message); };
const rendering = require('../render');
const realRender = rendering.render;
rendering.render = () => {};
const refresh = require('../refresh');
refresh.refreshInBackground = () => { refreshes++; state.error = null; };
const { handleContextMenuAction, handleDialogResult } = require('../context-menu');
const { handleKey, handleMouseData } = require('../input');
const errors = require('../operation-error');
const { setLocale } = require('../i18n');
const { SCOPE } = require('../actions');
const enableButton = () => dialogs.at(-1)?.buttons.find(button => button.id.startsWith('git-error:long-paths:'));

test.beforeEach(() => {
  spinner.resetOps();
  perms.reset();
  setLocale('en');
  dialogs.length = calls.length = toasts.length = 0;
  configResult = { ok: true, exit_code: 0 };
  dialogFailure = false;
  refreshes = 0;
  hecaton.process.spawn = failedSpawn;
  delete hecaton.permissions;
  Object.assign(state, {
    cwd: 'C:/long-path-repo', isGitRepo: true, loading: false, minimized: false,
    mode: 'normal', focusPanel: 'status', branch: 'main', branches: [], remotes: [],
    staged: [], unstaged: [{ status: 'M', file }], untracked: [], ignored: [],
    cursor: 0, scrollOffset: 0, selectedFiles: new Set(),
    indexLocked: false, operationState: null, operationError: null, error: null,
    pendingDialogAction: null, pendingDialogTarget: null, pendingRebaseMenu: false,
    pendingCommitterEdit: null, pendingStash: false, refreshing: false, rightView: 'diff',
  });
  Object.assign(ui, {
    fileTreeView: false, collapsedSections: {}, collapsedGroups: {}, collapsedFileDirs: {},
    termCols: 160, termRows: 40, cellW: 8, cellH: 16,
    leftPanelCollapsed: false, middlePanelCollapsed: false, rightPanelCollapsed: false,
    contextMenuFileItem: { file, type: 'unstaged', status: 'M' }, contextMenuFileItems: [],
  });
});

test.afterEach(() => {
  spinner.resetOps();
  while (spinner.isSpinning()) spinner.releaseSpinner();
  setLocale('en');
});

const windows = { skip: process.platform !== 'win32' };

test('Stage All preserves streamed long-path failure and offers repository-local recovery', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  assert.match(dialogs[0].message, /Filename too long/);
  assert.match(dialogs[0].message, /core\.longpaths=true/);
  assert.match(dialogs[0].message, /Linked worktrees/);
  assert.ok(dialogs[0].message.includes(file));
  assert.ok(enableButton());
  assert.equal(enableButton().style, 'success');
  assert.equal(dialogs[0].buttons.find(button => button.default).style, 'danger');
  assert.equal(dialogs[0].buttons.find(button => button.default).id, 'git-error:' + errors.current().id);
  assert.match(errors.hint(), /path is too long/);
  assert.equal(state.spinnerActive, false);
  assert.equal(state.staged.length, 0);
  assert.equal(state.unstaged.length, 1);
  assert.equal(refreshes, 1, 'a skipped directory may leave other files staged');
  assert.equal(calls.filter(call => call.kind === 'exec').length, 0);
});

test('the Stage All header button uses the same recovery flow', windows, async () => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { realRender(); } finally { process.stdout.write = write; }
  const zone = ui.fileHeaderZones.find(zone => zone.action === 'stageAll');
  assert.ok(zone);
  const layout = ui.lastLayout;
  const col = layout.startCol + layout.leftW + layout.divider1W + zone.btnColStart;
  const row = layout.startRow + (layout.titleRows || 2) + 1 + zone.lineIdx;
  await handleMouseData(`\x1b[<0;${col};${row}M`);
  await flush();
  assert.ok(enableButton());
  assert.deepEqual(calls[0].args, ['add', '-A']);
});

test('a delayed staging failure automatically calls the Hecaton message dialog API', windows, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let process_id;
  hecaton.process.spawn = async params => {
    calls.push({ kind: 'spawn', ...params });
    process_id = String(++nextId);
    return { ok: true, process_id };
  };
  const pending = handleContextMenuAction('file_stage_all');
  await flush();
  t.mock.timers.tick(73000);
  emit('process_output', { process_id, stream: 'stderr', data: diagnostic });
  emit('process_exited', { process_id, ok: true, exit_code: 128 });
  await pending;
  assert.equal(dialogs.length, 1, 'the API is called without clicking the error hint');
  assert.equal(dialogs[0].type, 'message');
  assert.equal(enableButton().style, 'success');
  assert.equal(dialogs[0].buttons.find(button => button.default).style, 'danger');
});

test('selected-file staging also offers long-path recovery', windows, async () => {
  await handleKey('s');
  await flush();
  assert.ok(enableButton());
  assert.ok(calls[0].args.includes(file));
});

test('cancel acknowledges the failure without changing Git settings', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  await handleDialogResult({ button_id: dialogs[0].buttons.find(button => button.default).id });
  assert.equal(errors.current(), null);
  assert.equal(calls.length, 1);
});

test('accepting recovery saves only local config and asks the user to retry staging', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  await handleDialogResult({ button_id: enableButton().id });
  assert.deepEqual(calls[1].args, ['config', '--local', 'core.longpaths', 'true']);
  assert.equal(calls[1].cwd, 'C:/long-path-repo');
  assert.equal(errors.current(), null);
  assert.match(dialogs.at(-1).message, /Retry staging/);
  assert.match(toasts[0], /Retry staging/);
  assert.equal(calls.filter(call => call.args[0] === 'add').length, 1, 'configuration must not stage files');
  assert.equal(state.staged.length, 0);
  assert.equal(state.spinnerActive, false);
  assert.equal(refreshes, 2, 'refresh paths omitted before long paths were enabled');
});

test('nonzero config exit is displayed even when the host reports ok:true', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  configResult = { ok: true, exit_code: 5, stderr: 'error: could not lock config file: Permission denied' };
  await handleDialogResult({ button_id: enableButton().id });
  assert.match(dialogs.at(-1).message, /Could not enable long paths/);
  assert.match(dialogs.at(-1).message, /Permission denied/);
  assert.ok(enableButton(), 'the user can retry saving the setting');
  assert.ok(errors.current());
  assert.equal(toasts.length, 0);
  assert.equal(state.spinnerActive, false);
});

test('denied process permission is retained as a settings failure', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  perms.reset();
  hecaton.permissions = { query: async () => ({ ok: true, state: 'denied' }) };
  await handleDialogResult({ button_id: enableButton().id });
  assert.match(dialogs.at(-1).message, /access_denied/);
  assert.equal(calls.length, 1);
  assert.equal(state.spinnerActive, false);
});

test('stale recovery buttons cannot configure a newer error or a different repository', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  const old = enableButton().id;
  errors.show('another operation failed');
  await handleDialogResult({ button_id: old });
  assert.equal(errors.current().message, 'another operation failed');
  assert.equal(calls.length, 1);
  errors.show(diagnostic);
  const other = enableButton().id;
  state.cwd = 'C:/different-repo';
  await handleDialogResult({ button_id: other });
  assert.equal(calls.length, 1);
});

test('duplicate clicks do not repeat config writes or clear a newer failure', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  const button_id = enableButton().id;
  let complete;
  configResult = new Promise(resolve => { complete = resolve; });
  const pending = handleDialogResult({ button_id });
  await flush();
  await handleDialogResult({ button_id });
  assert.equal(calls.length, 2);
  errors.show('newer failure');
  complete({ ok: true, exit_code: 0 });
  await pending;
  assert.equal(errors.current().message, 'newer failure');
  assert.equal(state.spinnerActive, false);
});

test('a concurrent config writer blocks recovery until that operation finishes', windows, async () => {
  await handleContextMenuAction('file_stage_all');
  const button_id = enableButton().id;
  const op = spinner.startSpinner('another config write', [SCOPE.CONFIG]);
  await handleDialogResult({ button_id });
  assert.equal(calls.length, 1);
  assert.ok(errors.current());
  spinner.stopSpinner(op);
  await handleKey('e');
  await handleDialogResult({ button_id: enableButton().id });
  assert.equal(calls.length, 2);
});

test('host dialog failures retain a readable error and retry through the API in Korean', windows, async () => {
  setLocale('ko');
  dialogFailure = true;
  await handleContextMenuAction('file_stage_all');
  await flush();
  assert.match(errors.hint(), /경로가 너무 길어/);
  dialogFailure = false;
  await handleKey('e');
  assert.equal(dialogs.length, 2);
  assert.equal(enableButton().label, '긴 경로 허용');
  assert.match(dialogs.at(-1).message, /로컬 Git 설정/);
});

test('automatic dialog admission rejection is recorded without repeated requests', windows, async () => {
  dialogFailure = { __rpcError: { code: -32002, message: 'DIALOG_USER_INPUT_REQUIRED' } };
  const log = [];
  const write = process.stderr.write;
  process.stderr.write = data => { log.push(String(data)); return true; };
  try {
    await handleContextMenuAction('file_stage_all');
    await flush();
  } finally { process.stderr.write = write; }
  assert.equal(dialogs.length, 1, 'a rejected request must not start a retry loop');
  assert.equal(errors.current().dialogError.message, 'DIALOG_USER_INPUT_REQUIRED');
  assert.match(log.join(''), /dialog\.show failed: DIALOG_USER_INPUT_REQUIRED/);
  assert.match(errors.hint(), /path is too long/);
  dialogFailure = false;
  await handleKey('e');
  await flush();
  assert.equal(dialogs.length, 2);
  assert.equal(errors.current().dialogError, null);
});

test('an error deferred by an existing confirmation opens automatically when it closes', windows, async () => {
  state.pendingDialogAction = 'delete-branch';
  state.pendingDialogTarget = 'keep';
  errors.show(diagnostic);
  assert.equal(dialogs.length, 0, 'preserve the confirmation already awaiting a decision');
  await handleDialogResult({ button_id: 'cancel' });
  await flush();
  assert.equal(dialogs.length, 1, 'the error API is called without a hint click');
  assert.match(dialogs[0].message, /Filename too long/);
  assert.equal(calls.length, 0);
});

test('unrelated and remote errors keep the ordinary error dialog', () => {
  for (const message of ['fatal: index.lock exists', 'remote: error: Filename too long']) {
    errors.show(message);
    assert.equal(enableButton(), undefined);
    assert.equal(dialogs.at(-1).buttons.length, 1);
  }
});

test('real Git fails on a long path, configures through the dialog, and succeeds on manual retry', windows, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hecaton-long-path-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hecaton-long-path-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', '--local', 'core.longpaths', 'false');
  const name = Array.from({ length: 5 }, (_, i) => 'long-directory-' + i + '-'.repeat(30)).join('/') + '/result.txt';
  assert.ok(path.join(root, name).length > 260);
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), 'content\n');
  state.cwd = root;
  state.unstaged = [];
  state.untracked = [{ file: name }];
  ui.contextMenuFileItem = { file: name, type: 'untracked' };
  const output = [];
  hecaton.process.spawn = async params => {
    const process_id = String(++nextId);
    const child = cp.spawn(params.program, params.args, { cwd: params.cwd, windowsHide: true });
    child.stdout.on('data', data => emit('process_output', { process_id, stream: 'stdout', data: data.toString() }));
    child.stderr.on('data', data => {
      output.push(data.toString());
      emit('process_output', { process_id, stream: 'stderr', data: data.toString() });
    });
    child.on('close', exit_code => emit('process_exited', { process_id, ok: true, exit_code }));
    return { ok: true, process_id };
  };
  await handleContextMenuAction('file_stage_all');
  assert.ok(enableButton(), JSON.stringify({ output, dialogs, toasts, staged: state.staged }));
  assert.equal(git('config', '--local', 'core.longpaths').trim(), 'false');
  assert.equal(git('ls-files'), '');
  await handleDialogResult({ button_id: enableButton().id });
  assert.equal(git('config', '--local', 'core.longpaths').trim(), 'true');
  assert.equal(git('ls-files'), '', 'only the setting changes before retry');
  await handleContextMenuAction('file_stage_all');
  assert.equal(errors.current(), null);
  assert.equal(git('ls-files').trim(), name);
});
