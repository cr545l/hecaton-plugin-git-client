// Stage All 은 상태 목록에 보이는 경로만 git 에 넘긴다.
//
// 배경: 경로 없는 `git add -A` 는 워크트리 전체를 끝까지 훑는다. 무시 패턴에 예외(!)가
// 5,447개 있고 무시된 파일이 약 12만 개인 워크트리에서는 그 탐색만 21.8초였고, 변경 82개
// 경로로 제한하면 40ms 였다(실측). 경로를 지정해도 뜻은 같아야 한다 — 수정·삭제·추적하지
// 않는 폴더가 모두 담기고, 폴더 항목 안의 무시 파일은 담기지 않는다. 목록이 저장소의
// 전부라고 확신할 수 없으면(추적하지 않는 파일 숨김, 목록 상한) 예전처럼 git 이 직접 찾는다.
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
};

const { gitStageAll, gitStatusPorcelain, gitStatusSplit } = require('../git');
const { stageAllPaths } = require('../refresh');
const { state } = require('../state');

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-stage-all-paths-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('git-stage-all-paths-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function applySnapshot(snapshot) {
  state.unstaged = snapshot.unstaged;
  state.untracked = snapshot.untracked;
  state.untrackedComplete = snapshot.untrackedComplete === true;
}

const staged = cwd => git(cwd, 'diff', '--cached', '--name-status', '-z').split('\0').filter(Boolean);

for (const [name, status] of [['porcelain', gitStatusPorcelain], ['split', gitStatusSplit]]) {
  test(`${name} status: Stage All stages exactly the listed changes through limited paths`, async t => {
    const cwd = repo(t);
    fs.writeFileSync(path.join(cwd, '.gitignore'), '*.log\n');
    fs.writeFileSync(path.join(cwd, 'kept.txt'), 'one\n');
    fs.writeFileSync(path.join(cwd, 'gone.txt'), 'one\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(cwd, 'kept.txt'), 'two\n');
    fs.unlinkSync(path.join(cwd, 'gone.txt'));
    fs.mkdirSync(path.join(cwd, 'newdir'));
    fs.writeFileSync(path.join(cwd, 'newdir', 'a.txt'), 'new\n');
    fs.writeFileSync(path.join(cwd, 'newdir', 'debug.log'), 'ignored inside an untracked folder\n');

    applySnapshot(await status(cwd, {}));
    const paths = stageAllPaths();
    // The split parser reports the folder without its trailing slash; both name the same folder.
    assert.deepEqual(paths.map(p => p.replace(/\/$/, '')).sort(), ['gone.txt', 'kept.txt', 'newdir']);
    commands.length = 0;
    assert.equal(await gitStageAll(cwd, paths), null);
    const add = commands.find(args => args.includes('add'));
    assert.deepEqual(add.slice(0, 4), ['--literal-pathspecs', 'add', '-A', '--']);
    assert.deepEqual(staged(cwd), ['D', 'gone.txt', 'M', 'kept.txt', 'A', 'newdir/a.txt']);
  });
}

test('an incomplete list falls back to letting Git find every change', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'one\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(cwd, 'u' + i + '.txt'), 'new\n');

  const hidden = await gitStatusPorcelain(cwd, { displayUntracked: false });
  assert.equal(hidden.untrackedComplete, false);
  const capped = await gitStatusPorcelain(cwd, { maxFilesDisplayed: 2 });
  assert.equal(capped.untracked.length, 2);
  assert.equal(capped.untrackedComplete, false);
  const cappedSplit = await gitStatusSplit(cwd, { maxFilesDisplayed: 2 });
  assert.equal(cappedSplit.untrackedComplete, false);

  applySnapshot(capped);
  assert.equal(stageAllPaths(), null);
  commands.length = 0;
  assert.equal(await gitStageAll(cwd, stageAllPaths()), null);
  assert.deepEqual(commands.find(args => args.includes('add')), ['add', '-A']);
  assert.equal(staged(cwd).filter(entry => /^u\d\.txt$/.test(entry)).length, 5);
});

test('nothing listed gives no paths, so Stage All never stages an empty pathspec', () => {
  state.unstaged = [];
  state.untracked = [];
  state.untrackedComplete = true;
  assert.equal(stageAllPaths(), null);
});
