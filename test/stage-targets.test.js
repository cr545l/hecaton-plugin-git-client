// 묶인 추적하지 않는 폴더(dir/)는 미리 구해 둔 파일로 담고, 폴더째 git 에 넘기지 않는다.
//
// 배경: 폴더째 넘기면 git 이 폴더 안 파일 전부를 무시 패턴과 대조한다. 패턴 5,447개, 파일
// 6만여 개인 워크트리에서 Stage All 이 6초였다(대조만 4.8초 — 실측). 미리 구한 파일만
// update-index 로 담으면 탐색이 없다. 그 사이 지워진 파일에 실패하지 않고, 그 사이 생긴
// 파일은 뒤따라 담는다. 선택한 폴더 항목은 -f 없이 담아 안의 무시 파일을 끌어들이지 않는다.
require('./helpers/git-mutation-host');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const commands = [];
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
global.hecaton = {
  process: {
    exec: async ({ args, cwd }) => {
      commands.push(args);
      try { return { ok: true, exit_code: 0, stdout: git(cwd, ...args) }; }
      catch (e) { return { ok: true, exit_code: e.status || 1, stderr: String(e.stderr || e.message) }; }
    },
  },
  fs: {
    write_file: async ({ path: target, content }) => { fs.writeFileSync(target, content); return { ok: true }; },
    delete: async ({ path: target }) => { fs.unlinkSync(target); return { ok: true }; },
  },
  window: { set_title: async () => ({ ok: true }) },
};

const { gitStatusPorcelain } = require('../git');
const expand = require('../untracked-expand');
const { stageTargets, catchUpExpanded } = require('../stage-targets');
const { state } = require('../state');

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-stage-targets-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('git-stage-targets-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(root, 'config', k, v);
  // The heavy worktree's shape: everything under evidence/ is ignored except whitelisted files.
  fs.writeFileSync(path.join(root, '.gitignore'), 'evidence/**\n!evidence/**/\n!evidence/**/keep-*.txt\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function write(root, rel, content = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

async function loadStatus(cwd) {
  const snapshot = await gitStatusPorcelain(cwd, {});
  state.cwd = cwd;
  state.unstaged = snapshot.unstaged;
  state.untracked = snapshot.untracked;
  state.ignored = [];
  state.untrackedComplete = snapshot.untrackedComplete === true;
  state.activeOps = [];
  return snapshot;
}

const staged = cwd => git(cwd, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort();

test('Stage All stages a prefetched folder by its files, never handing the folder to git add', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  write(cwd, 'evidence/run/keep-a.txt');
  write(cwd, 'evidence/run/deep/keep-b.txt');
  write(cwd, 'evidence/run/deep/noise.log');
  write(cwd, 'evidence/run/gone/keep-c.txt');
  await loadStatus(cwd);
  assert.deepEqual(state.untracked.map(e => e.file), ['evidence/']);
  await expand.prefetch(cwd, state.untracked.map(e => e.file));

  fs.rmSync(path.join(cwd, 'evidence/run/gone'), { recursive: true }); // deleted after the prefetch
  write(cwd, 'evidence/run/keep-late.txt');                               // created after the prefetch
  commands.length = 0;
  const { err, expandedDirs } = await stageTargets(cwd, ['tracked.txt', 'evidence/'], 'stage failed');
  assert.equal(err, null);
  assert.deepEqual(expandedDirs, ['evidence/']);
  assert.ok(!commands.some(args => args.includes('add') && args.includes('evidence/')), 'the folder itself never reaches git add');
  assert.ok(commands.some(args => args[0] === 'update-index'));
  assert.deepEqual(staged(cwd), ['evidence/run/deep/keep-b.txt', 'evidence/run/keep-a.txt', 'tracked.txt']);

  await catchUpExpanded(cwd, expandedDirs);
  assert.deepEqual(staged(cwd), ['evidence/run/deep/keep-b.txt', 'evidence/run/keep-a.txt', 'evidence/run/keep-late.txt', 'tracked.txt']);
});

test('a folder that is not prefetched yet is staged without -f, so its ignored files stay out', async t => {
  const cwd = repo(t);
  write(cwd, 'evidence/fresh/keep-a.txt');
  write(cwd, 'evidence/fresh/noise.log');
  await loadStatus(cwd);
  expand.forget(cwd);
  commands.length = 0;
  const { err } = await stageTargets(cwd, ['evidence/'], 'stage failed');
  assert.equal(err, null);
  const add = commands.find(args => args.includes('add'));
  assert.ok(add && !add.includes('-f'), 'no force flag for an untracked folder: ' + JSON.stringify(add));
  assert.deepEqual(staged(cwd), ['evidence/fresh/keep-a.txt']);
});

test('an ignored file picked from the Ignored list is still force-added', async t => {
  const cwd = repo(t);
  write(cwd, 'evidence/pick/noise.log');
  await loadStatus(cwd);
  state.ignored = [{ status: '!', file: 'evidence/pick/noise.log' }];
  const { err } = await stageTargets(cwd, ['evidence/pick/noise.log'], 'stage failed');
  assert.equal(err, null);
  assert.deepEqual(staged(cwd), ['evidence/pick/noise.log']);
});
