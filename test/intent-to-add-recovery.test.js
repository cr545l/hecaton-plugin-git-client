require('./helpers/git-mutation-host');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const dialogs = [], calls = [];
let exec;
const stashFailure = 'Merge failed:\nOperation failed:\n'
  + "error: Entry 'evidence/first.json' not uptodate. Cannot merge.\n"
  + 'Cannot save the current worktree state\nfatal: stash failed';
const until = async condition => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
};

global.hecaton = {
  initialState: { cols: 160, rows: 40 }, terminal: {}, fs: {},
  on: () => {},
  window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({}), set: async () => ({}), remove: async () => ({}) },
  process: {
    spawn: async () => ({ ok: false, error: 'unexpected spawn' }),
    exec: async params => { calls.push(params); return exec(params); },
  },
  dialog: { show: params => { dialogs.push(params); return Promise.resolve({ ok: true }); } },
};

const { state, ui } = require('../state');
const perms = require('../permissions');
const spinner = require('../spinner');
const rendering = require('../render');
rendering.render = () => {};
const refresh = require('../refresh');
refresh.refreshInBackground = () => { state.error = null; };
const { handleContextMenuAction } = require('../context-menu');
const { handleKey } = require('../input');
const errors = require('../operation-error');
const { setLocale } = require('../i18n');

test.beforeEach(() => {
  spinner.resetOps();
  perms.reset();
  setLocale('en');
  dialogs.length = calls.length = 0;
  exec = async () => ({ ok: true, exit_code: 0, stdout: '' });
  delete hecaton.permissions;
  Object.assign(state, {
    cwd: 'C:/ita-repo', isGitRepo: true, loading: false, minimized: false,
    mode: 'normal', focusPanel: 'status', branch: 'feat', branches: [], remotes: [],
    staged: [], unstaged: [], untracked: [], ignored: [],
    cursor: 0, scrollOffset: 0, selectedFiles: new Set(),
    indexLocked: false, operationState: null, operationError: null, error: null,
    pendingDialogAction: null, pendingDialogTarget: null, pendingRebaseMenu: false,
    pendingCommitterEdit: null, pendingStash: false, refreshing: false, rightView: 'diff',
  });
  Object.assign(ui, { termCols: 160, termRows: 40, contextMenuBranch: null });
});

test.afterEach(() => {
  spinner.resetOps();
  while (spinner.isSpinning()) spinner.releaseSpinner();
  setLocale('en');
});

function realRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hecaton-ita-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hecaton-ita-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_MERGE_AUTOEDIT: 'no' };
  const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', env });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', '--local', 'user.name', 'test');
  git('config', '--local', 'user.email', 'test@example.com');
  git('config', '--local', 'core.autocrlf', 'false');
  write('base.txt', 'base\n');
  git('add', 'base.txt');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  write('feat.txt', 'feat\n');
  git('add', 'feat.txt');
  git('commit', '-qm', 'feat');
  git('checkout', '-q', 'main');
  write('main.txt', 'main\n');
  git('add', 'main.txt');
  git('commit', '-qm', 'main');
  git('checkout', '-q', 'feat');
  write('base.txt', 'base\nlocal edit\n');
  exec = async params => {
    try {
      return { ok: true, exit_code: 0, stdout: cp.execFileSync(params.program, params.args, { cwd: params.cwd, encoding: 'utf8', stdio: 'pipe', env }) };
    } catch (error) {
      return { ok: true, exit_code: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
    }
  };
  state.cwd = root;
  return { root, git, write };
}

test('real non-fast-forward merge blocked by intent-to-add files explains the cause and lists every file', async t => {
  const { git, write } = realRepo(t);
  const files = ['evidence/a.json', 'evidence/b.json', 'evidence/c.json'];
  for (const file of files) { write(file, '{"ok":true}\n'); git('add', '-N', file); }
  const head = git('rev-parse', 'HEAD');
  ui.contextMenuBranch = 'main';
  await handleContextMenuAction('branch_merge_into');
  await until(() => dialogs.length > 0);

  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Stopped by intent-to-add files');
  assert.match(dialogs[0].message, /not a merge conflict/);
  for (const file of files) assert.ok(dialogs[0].message.includes('  ' + file), file);
  assert.match(dialogs[0].message, /stage and commit them first/);
  assert.match(dialogs[0].message, /Staging alone is not enough/);
  assert.match(dialogs[0].message, /git rm --cached -- <file>/);
  assert.match(dialogs[0].message, /fatal: stash failed/, 'the original Git output stays for reference');
  assert.match(errors.hint(), /intent-to-add \(git add -N\)/);
  assert.equal(git('rev-parse', 'HEAD'), head, 'nothing was merged');
  assert.equal(git('diff', '--name-only', '--diff-filter=A').trim().split('\n').length, 3);
  assert.equal(state.spinnerActive, false);

  // 스테이징만으로는 부족하다 — 머지는 스테이징된 변경이 있으면 시작하지 않는다.
  git('add', '--', ...files);
  dialogs.length = 0;
  await handleContextMenuAction('branch_merge_into');
  await until(() => dialogs.length > 0);
  assert.equal(dialogs[0].title, 'Error');
  assert.match(dialogs[0].message, /would be overwritten by merge/);
  assert.equal(git('rev-parse', 'HEAD'), head);

  // 안내한 두 방법: 커밋하거나, 표시를 해제해 추적하지 않는 파일로 둔다.
  git('commit', '-qm', 'evidence', '--', 'evidence/a.json', 'evidence/b.json');
  git('rm', '-q', '--cached', '--', 'evidence/c.json');
  const committed = git('rev-parse', 'HEAD');
  dialogs.length = 0;
  await handleContextMenuAction('branch_merge_into');
  await until(() => git('rev-parse', 'HEAD') !== committed);
  assert.equal(git('rev-parse', 'HEAD^2'), git('rev-parse', 'main'));
  assert.equal(dialogs.length, 0);
  assert.equal(fs.readFileSync(path.join(state.cwd, 'evidence/c.json'), 'utf8'), '{"ok":true}\n');
});

test('real plugin stash failure gets the same guidance', async t => {
  const { git, write } = realRepo(t);
  write('notes.json', '{}\n');
  git('add', '-N', 'notes.json');
  const err = await require('../git').gitStashSave(state.cwd);
  errors.show('Stash failed:\n' + err);
  await until(() => dialogs.length > 0);
  assert.equal(dialogs[0].title, 'Stopped by intent-to-add files');
  assert.ok(dialogs[0].message.includes('  notes.json'));
});

test('falls back to the path in the message when Git cannot list the files', async () => {
  exec = async () => ({ ok: true, exit_code: 128, stderr: 'fatal: unable to read index' });
  errors.show(stashFailure);
  await until(() => dialogs.length > 0);
  assert.equal(dialogs.length, 1);
  assert.ok(dialogs[0].message.includes('  evidence/first.json'));
  assert.deepEqual(calls[0].args.slice(0, 2), ['--no-optional-locks', 'diff']);
});

test('long lists are shortened', async () => {
  const paths = Array.from({ length: 14 }, (_, i) => 'evidence/file-' + i + '.json');
  exec = async () => ({ ok: true, exit_code: 0, stdout: paths.join('\0') + '\0' });
  errors.show(stashFailure);
  await until(() => dialogs.length > 0);
  assert.ok(dialogs[0].message.includes('  evidence/file-9.json'));
  assert.ok(!dialogs[0].message.includes('evidence/file-10.json'));
  assert.match(dialogs[0].message, /\.\.\.and 4 more/);
});

test('the dialog waits for the file list, and E does not open a partial one', async () => {
  let complete;
  exec = () => new Promise(resolve => { complete = resolve; });
  errors.show(stashFailure);
  await until(() => complete);
  assert.equal(dialogs.length, 0);
  await handleKey('e');
  assert.equal(dialogs.length, 0);
  assert.match(errors.hint(), /Press E for the cause/);
  complete({ ok: true, exit_code: 0, stdout: 'evidence/first.json\0evidence/second.json\0' });
  await until(() => dialogs.length > 0);
  assert.equal(dialogs.length, 1);
  assert.ok(dialogs[0].message.includes('  evidence/second.json'));
});

test('a newer failure during inspection keeps its own dialog', async () => {
  let complete;
  exec = () => new Promise(resolve => { complete = resolve; });
  errors.show(stashFailure);
  await until(() => complete);
  errors.show('fatal: another failure');
  complete({ ok: true, exit_code: 0, stdout: 'evidence/first.json\0' });
  await until(() => !errors.current().inspecting);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Error');
  assert.equal(errors.current().message, 'fatal: another failure');
});

test('unrelated not-uptodate errors keep the ordinary dialog without extra Git calls', () => {
  errors.show("error: Entry 'a.txt' not uptodate. Cannot merge.\nfatal: read-tree failed");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Error');
  assert.equal(calls.length, 0);
});

test('Korean guidance', async () => {
  setLocale('ko');
  exec = async () => ({ ok: true, exit_code: 0, stdout: 'evidence/first.json\0' });
  errors.show(stashFailure);
  await until(() => dialogs.length > 0);
  assert.equal(dialogs[0].title, '추가 예정 파일 때문에 중단됨');
  assert.match(dialogs[0].message, /머지 충돌이 아니며/);
  assert.match(errors.hint(), /원인과 해결 방법/);
});
