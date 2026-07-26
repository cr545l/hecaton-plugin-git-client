// 실제 git 저장소에 linked worktree를 만들어 gitWorktrees 파싱을 검증한다.
// hecaton.process.exec만 child_process로 대체하고 나머지는 플러그인 코드 그대로 사용.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

global.hecaton = {
  fs: {},
  window: {},
  initialState: {},
  process: {
    exec: async ({ program, args, cwd }) => {
      const r = spawnSync(program, args, { cwd, encoding: 'utf8' });
      return {
        ok: r.status === 0,
        exit_code: r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
      };
    },
  },
};

const { gitWorktrees } = require('../git');

let root, mainRepo, wtFeature, wtHotfix;

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitclient-wt-'));
  mainRepo = path.join(root, 'repo');
  wtFeature = path.join(root, 'wt-feature');
  wtHotfix = path.join(root, 'wt-hotfix');
  fs.mkdirSync(mainRepo);
  git(mainRepo, 'init', '-q', '-b', 'main');
  git(mainRepo, 'config', 'user.email', 't@t');
  git(mainRepo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(mainRepo, 'a.txt'), 'hi\n');
  git(mainRepo, 'add', '.');
  git(mainRepo, 'commit', '-qm', 'init');
  git(mainRepo, 'branch', 'feature/login');
  git(mainRepo, 'branch', 'hotfix');
  git(mainRepo, 'worktree', 'add', '-q', wtFeature, 'feature/login');
  git(mainRepo, 'worktree', 'add', '-q', wtHotfix, 'hotfix');
  fs.mkdirSync(path.join(wtFeature, 'src'));
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('메인 저장소에서: 첫 항목이 메인 워크트리이고 현재 워크트리로 표시된다', async () => {
  const wts = await gitWorktrees(mainRepo);

  assert.equal(wts.length, 3);
  assert.equal(wts[0].isMain, true);
  assert.equal(wts[0].isCurrent, true);
  assert.equal(wts[0].branch, 'main');
  // linked worktree는 isMain이 아니어야 한다
  assert.deepEqual(wts.slice(1).map(w => w.isMain), [false, false]);
  assert.deepEqual(wts.slice(1).map(w => w.isCurrent), [false, false]);
  assert.deepEqual(wts.map(w => w.branch), ['main', 'feature/login', 'hotfix']);
});

test('linked worktree에서: 메인이 아닌 항목이 현재로 표시된다', async () => {
  const wts = await gitWorktrees(wtFeature);

  const current = wts.find(w => w.isCurrent);
  assert.ok(current, 'current worktree가 있어야 한다');
  assert.equal(current.isMain, false);
  assert.equal(current.branch, 'feature/login');
  // 메인 워크트리는 여전히 첫 항목이고 현재가 아니다
  assert.equal(wts[0].isMain, true);
  assert.equal(wts[0].isCurrent, false);
  // 현재 워크트리는 정확히 하나
  assert.equal(wts.filter(w => w.isCurrent).length, 1);
});

test('워크트리 하위 디렉터리를 cwd로 줘도 현재 워크트리를 찾는다', async () => {
  const wts = await gitWorktrees(path.join(wtFeature, 'src'));

  const current = wts.find(w => w.isCurrent);
  assert.ok(current, 'subdirectory에서도 current worktree를 찾아야 한다');
  assert.equal(current.branch, 'feature/login');
  assert.equal(current.isMain, false);
});

test('워크트리가 없는 저장소는 메인 항목 하나만 반환한다', async () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  git(plain, 'init', '-q', '-b', 'main');
  git(plain, 'config', 'user.email', 't@t');
  git(plain, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(plain, 'a.txt'), 'hi\n');
  git(plain, 'add', '.');
  git(plain, 'commit', '-qm', 'init');

  const wts = await gitWorktrees(plain);
  assert.equal(wts.length, 1);
  assert.equal(wts[0].isMain, true);
  assert.equal(wts[0].isCurrent, true);
});

test('detached HEAD 워크트리는 branch 없이 isDetached로 표시된다', async () => {
  const wtDetached = path.join(root, 'wt-detached');
  git(mainRepo, 'worktree', 'add', '-q', '--detach', wtDetached);

  const wts = await gitWorktrees(mainRepo);
  const detached = wts.find(w => w.path.replace(/\\/g, '/').endsWith('wt-detached'));
  assert.ok(detached, 'detached worktree를 찾아야 한다');
  assert.equal(detached.isDetached, true);
  assert.equal(detached.branch, '');
  assert.equal(detached.isMain, false);
});
