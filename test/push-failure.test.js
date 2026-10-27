require('./helpers/git-mutation-host');
const test = require('node:test');
const assert = require('node:assert/strict');

const dialogs = [], calls = [];
let result, throwExec, dialogFailure, refreshes;
global.hecaton = {
  initialState: { cols: 120, rows: 40 }, terminal: {}, on() {}, fs: {},
  window: { set_title: async () => ({ ok: true }) },
  process: { exec: async params => {
    calls.push(params);
    if (throwExec) throw throwExec;
    return result;
  } },
  dialog: { show: params => {
    dialogs.push(params);
    if (dialogFailure === 'throw') throw new Error('modal unavailable');
    if (dialogFailure === 'reject') return Promise.reject(new Error('modal unavailable'));
    return Promise.resolve(dialogFailure ? { ok: false } : { ok: true });
  } },
};

const { state } = require('../state');
const spinner = require('../spinner');
const refresh = require('../refresh');
const rendering = require('../render');
const realRender = rendering.render;
rendering.render = () => {};
refresh.refreshInBackground = () => { refreshes++; state.error = null; };
const coordinate = require('../coordinate');
const { handleKey } = require('../input');
const { handleContextMenuAction, handleDialogResult } = require('../context-menu');
const errors = require('../operation-error');
const git = require('../git');
const { CSI } = require('../ansi');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test.beforeEach(() => {
  spinner.resetOps();
  coordinate.configure('', '');
  dialogs.length = calls.length = 0;
  throwExec = dialogFailure = null;
  refreshes = 0;
  result = { ok: true, exit_code: 1, stderr: 'remote: error: GH001: Large files detected.' };
  Object.assign(state, {
    cwd: 'C:/repo', isGitRepo: true, loading: false, minimized: false, mode: 'normal',
    branch: 'main', branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }],
    remotes: ['origin'], pendingDialogAction: null, pendingDialogTarget: null,
    pendingRebaseMenu: false, pendingCommitterEdit: null, pendingStash: false,
    indexLocked: false, operationState: null, operationError: null, error: null,
  });
});
test.afterEach(() => { spinner.resetOps(); while (spinner.isSpinning()) spinner.releaseSpinner(); });

test('server rejection shows an error dialog with both large filenames even after a long transfer log', async () => {
  const bundle = 'Unity/Assets/Firebase/FirebaseCppApp-13_4_0.bundle';
  const so = 'Unity/Assets/Firebase/FirebaseCppApp-13_4_0.so';
  result.stderr = 'Writing objects: 90%\r'.repeat(1000)
    + `remote: error: File ${bundle} is 173.32 MB; exceeds GitHub limit of 100.00 MB\n`
    + `remote: error: File ${so} is 111.38 MB; exceeds GitHub limit of 100.00 MB\n`
    + 'remote: error: GH001: Large files detected.\n' + 'transfer details\n'.repeat(1000);
  await handleKey(CSI + '112;6u');
  await tick();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /Push failed/);
  assert.ok(dialogs[0].message.includes(bundle));
  assert.ok(dialogs[0].message.includes(so));
  assert.match(dialogs[0].message, /100\.00 MB/);
  assert.equal(state.spinnerActive, false);
  assert.equal(refreshes, 0, 'failure must not enter the success refresh path');
  state.error = null;
  assert.match(errors.hint(), /\[E\].*FirebaseCppApp/);
});

for (const [name, failure] of [
  ['RPC rejection', () => { throwExec = new Error('RPC transport disconnected'); }],
  ['error field', () => { result = { ok: false, error: 'process timed out' }; }],
  ['error despite host ok', () => { result = { ok: true, exit_code: null, error: 'process timed out' }; }],
  ['host error code', () => { result = { ok: true, error_code: 'access_denied' }; }],
  ['RPC error field', () => { result = { ok: true, __rpcError: { message: 'host RPC timeout' } }; }],
  ['nonzero exit with no output', () => { result = { ok: true, exit_code: 128 }; }],
  ['null response', () => { result = null; }],
]) {
  test(name + ' is surfaced and releases the push spinner', async () => {
    failure();
    await handleKey(CSI + '112;6u');
    await tick();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /Push failed/);
    assert.equal(state.spinnerActive, false);
    assert.ok(errors.current());
    if (name === 'RPC rejection') assert.match(dialogs[0].message, /RPC transport disconnected/);
    if (name === 'error field') assert.match(dialogs[0].message, /Git command timed out/);
    if (name === 'RPC error field') assert.match(dialogs[0].message, /host RPC timeout/);
    if (name === 'nonzero exit with no output') assert.match(dialogs[0].message, /128/);
  });
}

test('renamed-branch confirmation shows failure before refresh and retains it afterwards', async () => {
  state.pendingDialogAction = 'push-name-mismatch';
  state.pendingDialogTarget = { remote: 'origin', local: 'main', upstreamBranch: 'main2' };
  await handleDialogResult({ button_id: 'push_local' });
  await tick();
  assert.deepEqual(calls[0].args, ['push', '-u', 'origin', 'main']);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /GH001/);
  assert.equal(refreshes, 1);
  assert.equal(state.spinnerActive, false);
  assert.match(errors.hint(), /GH001/);
});

test('remote menu push also displays thrown process failures', async () => {
  throwExec = new Error('process spawn failed');
  await handleContextMenuAction('push_to_remote:origin');
  await tick();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /process spawn failed/);
  assert.equal(state.spinnerActive, false);
});

for (const failure of ['throw', 'reject', 'false']) {
  test('host dialog ' + failure + ' retains the error for a later API retry', async () => {
    dialogFailure = failure;
    await handleKey(CSI + '112;6u');
    await tick();
    assert.match(errors.hint(), /GH001/);
    refresh.refreshInBackground();
    dialogFailure = null;
    await handleKey('e');
    assert.equal(dialogs.length, 2);
    assert.match(dialogs[1].message, /GH001/);
    await handleDialogResult({ button_id: dialogs[1].buttons[0].id });
    assert.equal(errors.current(), null);
  });
}

test('error acknowledgment cannot consume an unrelated pending confirmation or a newer error', async () => {
  errors.show('first');
  const oldButton = dialogs[0].buttons[0].id;
  state.pendingDialogAction = 'delete-branch';
  state.pendingDialogTarget = 'keep-this';
  errors.show('second');
  assert.equal(dialogs.length, 1, 'do not replace a pending confirmation');
  await handleDialogResult({ button_id: oldButton });
  assert.equal(state.pendingDialogAction, 'delete-branch');
  assert.equal(state.pendingDialogTarget, 'keep-this');
  assert.equal(errors.current().message, 'second');
});

test('successful push produces no error notice', async () => {
  result = { ok: true, exit_code: 0, stderr: 'Everything up-to-date' };
  await handleKey(CSI + '112;6u');
  await tick();
  assert.equal(dialogs.length, 0);
  assert.equal(errors.current(), null);
  assert.equal(refreshes, 1);
});

test('thrown process errors retain stderr as well as their exception message', async () => {
  throwExec = Object.assign(new Error('process failed'), { stderr: 'remote: error: denied by server' });
  assert.match(await git.gitPushAsync(state.cwd), /denied by server/);
});

test('wrapped Git diagnostics keep their continuation lines together', async () => {
  const stderr = 'fatal: The upstream branch does not match\nthe name of your current branch.';
  result = { ok: false, exit_code: 128, stderr, error: 'Command failed: git push\n' + stderr };
  assert.match(await git.gitPushAsync(state.cwd), /does not match\nthe name of your current branch/);
});

test('the rendered error notice survives refresh and another active operation', () => {
  errors.show('Push failed:\nremote: error: Firebase.bundle exceeds 100 MB');
  refresh.refreshInBackground();
  state.spinnerActive = true;
  state.error = 'Fetching...';
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try { realRender(); } finally { process.stdout.write = write; state.spinnerActive = false; }
  assert.match(output, /\[E\] Error details:/);
  assert.match(output, /Firebase\.bundle/);
  assert.ok(require('../state').ui.clickableAreas.some(area => area.action === 'error-details'));
});

test('a real Git remote rejection reaches the push UI with its server diagnostic', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-push-rejected-'));
  const originalExec = hecaton.process.exec;
  const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const remote = path.join(root, 'remote.git');
    const local = path.join(root, 'local');
    run(root, ['init', '--bare', '-q', remote]);
    run(root, ['init', '-q', '-b', 'main', local]);
    fs.writeFileSync(path.join(local, 'file.txt'), 'test\n');
    run(local, ['add', 'file.txt']);
    run(local, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test']);
    run(local, ['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "error: File Firebase.bundle exceeds 100 MB; GH001: Large files detected." >&2\nexit 1\n', { mode: 0o755 });
    hecaton.process.exec = async ({ args, cwd }) => {
      try { return { ok: true, exit_code: 0, stdout: run(cwd, args) }; }
      catch (error) { return { ok: true, exit_code: error.status, stderr: String(error.stderr || '') }; }
    };
    state.cwd = local;
    state.branches[0].upstream = '';
    await handleKey(CSI + '112;6u');
    await tick();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /Firebase\.bundle.*100 MB/);
    assert.match(dialogs[0].message, /pre-receive hook declined/);
    assert.equal(state.spinnerActive, false);
    assert.equal(run(root, ['ls-remote', '--heads', remote]), '');
  } finally {
    hecaton.process.exec = originalExec;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('git-push-rejected-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
