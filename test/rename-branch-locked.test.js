// 브랜치 리네임의 부분 성공 처리 — 실제 git 을 돌린다.
// `git branch -m` 은 ref 를 옮긴 뒤 마지막에 config 의 branch.<old>.* 섹션을 옮기는데,
// 이 단계에서만 .git/config.lock 을 잡는다. 다른 클라이언트가 config 를 쓰는 중이거나
// 죽은 프로세스가 남긴 stale lock 이 있으면 리네임은 끝났는데 fatal 만 올라온다.
// 그 결과가 "에러 다이얼로그가 떴는데 브랜치 이름은 바뀌어 있다" 였다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 특정 git 호출이 실행되는 "동안에만" lock 을 걸어 두는 훅.
// 다른 클라이언트가 잠깐 config 를 쥐고 있는 상황을 재현한다.
let lockDuring = null;

global.hecaton = {
  process: {
    exec: async ({ program, args, cwd }) => {
      const lockPath = lockDuring && lockDuring.match(args) ? lockDuring.lockPath : null;
      if (lockPath) fs.copyFileSync(lockPath.replace(/\.lock$/, ''), lockPath);
      try {
        const stdout = execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, exit_code: 0, stdout, stderr: '' };
      } catch (e) {
        return {
          ok: false,
          exit_code: typeof e.status === 'number' ? e.status : 1,
          stdout: e.stdout || '',
          stderr: e.stderr || '',
          error: String(e.message),
        };
      } finally {
        if (lockPath) fs.rmSync(lockPath, { force: true });
      }
    },
  },
};

const { gitRenameBranch } = require('../git');

const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrename-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root], { encoding: 'utf8' });
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'commit', '--allow-empty', '-m', 'init');
  return root;
}

// upstream 이 잡힌 브랜치 — 리네임 때 옮겨야 할 config 섹션이 생긴다
function addTrackedBranch(root, name) {
  git(root, 'branch', name);
  git(root, 'config', 'branch.' + name + '.remote', 'origin');
  git(root, 'config', 'branch.' + name + '.merge', 'refs/heads/' + name);
}

function lockConfig(root) {
  const cfg = path.join(root, '.git', 'config');
  fs.copyFileSync(cfg, cfg + '.lock');
}

function branchNames(cwd) {
  return git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n').filter(Boolean);
}

function configKeys(root, branch) {
  try {
    return git(root, 'config', '--local', '--get-regexp', '^branch\\.' + branch.replace(/\./g, '\\.') + '\\.').trim();
  } catch {
    return '';
  }
}

test.afterEach(() => { lockDuring = null; });

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('lock 이 없으면 평소대로 성공하고 config 섹션도 새 이름으로 옮겨진다', async () => {
  const root = makeRepo();
  addTrackedBranch(root, 'feature-old');

  const res = await gitRenameBranch(root, 'feature-old', 'feature-new');

  assert.deepEqual(res, { renamed: true, error: null });
  assert.ok(branchNames(root).includes('feature-new'));
  assert.equal(configKeys(root, 'feature-old'), '');
  assert.match(configKeys(root, 'feature-new'), /branch\.feature-new\.remote origin/);
});

// 옮길 설정이 없는 브랜치도 git 은 lock 부터 잡으므로 똑같이 fatal 을 냈다.
// 실제로 잃은 것이 없으니 에러 없이 끝나야 한다.
test('upstream 이 없는 브랜치는 stale lock 이 있어도 에러 없이 끝난다', async () => {
  const root = makeRepo();
  git(root, 'branch', 'plain-old');
  lockConfig(root);

  const res = await gitRenameBranch(root, 'plain-old', 'plain-new');

  assert.deepEqual(res, { renamed: true, error: null });
  assert.ok(branchNames(root).includes('plain-new'));
  assert.ok(!branchNames(root).includes('plain-old'));
});

// lock 을 쥔 쪽이 곧 놓아주는 흔한 경우 — 남은 config 섹션을 직접 옮겨 마무리한다.
test('리네임 도중에만 lock 이 걸렸다면 config 를 직접 옮겨 완전히 복구한다', async () => {
  const root = makeRepo();
  addTrackedBranch(root, 'feature-old');
  lockDuring = {
    lockPath: path.join(root, '.git', 'config.lock'),
    match: (args) => args[0] === 'branch' && args[1] === '-m',
  };

  const res = await gitRenameBranch(root, 'feature-old', 'feature-new');

  assert.deepEqual(res, { renamed: true, error: null });
  assert.equal(configKeys(root, 'feature-old'), '');
  assert.match(configKeys(root, 'feature-new'), /branch\.feature-new\.remote origin/);
});

// lock 이 계속 남아 있으면 config 는 못 옮긴다. 이때도 ref 는 옮겨졌으므로
// renamed 는 참이어야 한다 — 호출부가 이걸 보고 핀을 새 이름으로 옮긴다.
test('stale lock 이 계속 남아 있으면 리네임 사실과 남은 설정을 함께 알린다', async () => {
  const root = makeRepo();
  addTrackedBranch(root, 'feature-old');
  lockConfig(root);

  const res = await gitRenameBranch(root, 'feature-old', 'feature-new');

  assert.equal(res.renamed, true, 'ref 는 옮겨졌으므로 renamed 여야 한다');
  assert.ok(res.error, '설정이 남았으니 알려야 한다');
  assert.match(res.error, /feature-new/);
  assert.match(res.error, /feature-old/);
  assert.ok(branchNames(root).includes('feature-new'));
  assert.match(configKeys(root, 'feature-old'), /branch\.feature-old\.remote origin/);
});

// worktree 는 자기 gitdir 을 따로 갖지만 config 는 메인 리포와 공유한다.
test('worktree 에서 리네임해도 메인 리포의 lock 을 타고, 같은 처리를 받는다', async () => {
  const root = makeRepo();
  const wt = path.join(root, '..', path.basename(root) + '-wt');
  roots.push(wt);
  git(root, 'worktree', 'add', '--quiet', wt, '-b', 'wt-old');
  git(root, 'config', 'branch.wt-old.remote', 'origin');
  git(root, 'config', 'branch.wt-old.merge', 'refs/heads/wt-old');
  lockDuring = {
    lockPath: path.join(root, '.git', 'config.lock'),
    match: (args) => args[0] === 'branch' && args[1] === '-m',
  };

  const res = await gitRenameBranch(wt, 'wt-old', 'wt-new');

  assert.deepEqual(res, { renamed: true, error: null });
  assert.equal(configKeys(root, 'wt-old'), '');
  assert.match(configKeys(root, 'wt-new'), /branch\.wt-new\.remote origin/);
});

test('없는 브랜치나 이름 충돌은 그대로 실패로 보고한다', async () => {
  const root = makeRepo();
  addTrackedBranch(root, 'keep');

  const missing = await gitRenameBranch(root, 'no-such-branch', 'whatever');
  assert.equal(missing.renamed, false);
  assert.ok(missing.error);

  const clash = await gitRenameBranch(root, 'keep', 'main');
  assert.equal(clash.renamed, false);
  assert.ok(clash.error);
  assert.ok(branchNames(root).includes('keep'), '충돌 시 원래 이름이 남아야 한다');
});

// 브랜치 이름의 '.' 이 --get-regexp 에서 메타문자로 새면 섹션 탐지가 어긋난다.
test("이름에 '.' 이나 '/' 가 있어도 config 섹션을 정확히 옮긴다", async () => {
  const root = makeRepo();
  addTrackedBranch(root, 'release/v1.0');
  lockDuring = {
    lockPath: path.join(root, '.git', 'config.lock'),
    match: (args) => args[0] === 'branch' && args[1] === '-m',
  };

  const res = await gitRenameBranch(root, 'release/v1.0', 'release/v1.1');

  assert.deepEqual(res, { renamed: true, error: null });
  assert.equal(configKeys(root, 'release/v1.0'), '');
  assert.match(configKeys(root, 'release/v1.1'), /branch\.release\/v1\.1\.remote origin/);
});
