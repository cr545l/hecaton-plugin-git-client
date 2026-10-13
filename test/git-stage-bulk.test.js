const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gitStageMultiple, gitUnstageMultiple, gitStageAll, gitUnstageAll } = require('../git');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

global.hecaton = {
  process: {
    exec: async ({ args, cwd }) => {
      try { return { ok: true, exit_code: 0, stdout: git(cwd, ...args) }; }
      catch (e) { return { ok: true, exit_code: e.status || 1, stderr: String(e.stderr || e.message) }; }
    },
  },
  fs: {
    write_file: async ({ path: target, content }) => { fs.writeFileSync(target, content); return { ok: true }; },
    delete: async ({ path: target }) => { fs.unlinkSync(target); return { ok: true }; },
  },
};

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-stage-bulk-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('git-stage-bulk-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  return root;
}

const tracked = cwd => git(cwd, 'ls-files', '-z').split('\0').filter(Boolean).sort();

test('real Git stages and unstages a selection exceeding Windows argv limits, including unborn HEAD', async t => {
  const cwd = repo(t);
  const files = Array.from({ length: 2000 }, (_, i) => 'asset with spaces and a long filename ' + i + '.txt');
  files.push('한글 [literal].txt', '-option.txt', 'glob[1].txt');
  for (const file of [...files, 'untouched.txt', 'glob1.txt']) fs.writeFileSync(path.join(cwd, file), 'content\n');
  assert.ok(files.join(' ').length > 32767);
  assert.equal(await gitStageMultiple(cwd, files), null);
  assert.deepEqual(tracked(cwd), [...files].sort());
  assert.equal(await gitUnstageMultiple(cwd, files), null);
  assert.deepEqual(tracked(cwd), []);
  assert.equal(fs.readFileSync(path.join(cwd, files[0]), 'utf8'), 'content\n');
  assert.equal(fs.readdirSync(path.join(cwd, '.git')).some(name => name.startsWith('hecaton-pathspec-')), false);
});

test('small selections also treat wildcard characters literally', async t => {
  const cwd = repo(t);
  for (const file of ['glob[1].txt', 'glob1.txt']) fs.writeFileSync(path.join(cwd, file), 'content\n');
  assert.equal(await gitStageMultiple(cwd, ['glob[1].txt']), null);
  assert.deepEqual(tracked(cwd), ['glob[1].txt']);
  assert.equal(await gitUnstageMultiple(cwd, ['glob[1].txt']), null);
  assert.deepEqual(tracked(cwd), []);
});

test('Stage All honors ignore rules while explicit selections may include ignored files', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(cwd, 'visible.txt'), 'visible\n');
  const ignored = Array.from({ length: 520 }, (_, i) => 'ignored-' + i + '.log');
  for (const file of ignored) fs.writeFileSync(path.join(cwd, file), 'ignored\n');
  assert.equal(await gitStageAll(cwd), null);
  assert.deepEqual(tracked(cwd), ['.gitignore', 'visible.txt']);
  assert.equal(await gitStageMultiple(cwd, ignored), null);
  assert.equal(tracked(cwd).length, 522);
  assert.equal(await gitUnstageAll(cwd), null);
  assert.deepEqual(tracked(cwd), []);
});

test('bulk mutations handle modified/deleted paths in a linked worktree and leave other changes alone', async t => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  git(root, 'add', 'seed.txt');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'seed');
  const cwd = path.join(root, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'linked', cwd);
  const files = Array.from({ length: 520 }, (_, i) => 'file-' + i + '.txt');
  for (const file of files) fs.writeFileSync(path.join(cwd, file), 'before\n');
  assert.equal(await gitStageMultiple(cwd, files), null);
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'files');
  for (let i = 0; i < files.length; i++) {
    if (i % 2) fs.unlinkSync(path.join(cwd, files[i]));
    else fs.writeFileSync(path.join(cwd, files[i]), 'after\n');
  }
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'unselected\n');
  assert.equal(await gitStageMultiple(cwd, files), null);
  const changed = git(cwd, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  assert.deepEqual(changed.sort(), [...files].sort());
  assert.equal(await gitUnstageMultiple(cwd, files), null);
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '');
  assert.equal(fs.readFileSync(path.join(cwd, files[0]), 'utf8'), 'after\n');
  assert.equal(fs.existsSync(path.join(cwd, files[1])), false);
  assert.equal(fs.readdirSync(git(cwd, 'rev-parse', '--absolute-git-dir').trim()).some(name => name.startsWith('hecaton-pathspec-')), false);
});
