// 브랜치 생성이 로컬 변경에 막히는 경우 — 실제 git 을 돌린다.
//
// `git checkout -b <name> <start>` 는 브랜치 생성과 체크아웃을 함께 한다. 기준점이 HEAD 와
// 다르면 실제 체크아웃이 일어나므로, 수정 중인 파일의 내용이 두 커밋 사이에서 다르면
// "Your local changes ... would be overwritten by checkout" 으로 거부된다.
// 플러그인은 브랜치 목록/커밋 로그의 커서 위치를 늘 기준점으로 넘기기 때문에,
// 사용자 눈에는 "이름만 새로 지었는데 브랜치 생성이 실패"한 것으로 보였다.
//
// 다만 이 실패는 기준점이 HEAD 와 다를 때만 나므로, 리베이스처럼 로컬 변경이 있다고 해서
// 무조건 확인창을 띄우면 잘 되던 경우까지 막게 된다. 아래 테스트가 그 경계를 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

global.hecaton = {
  fs: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 },
  process: {
    exec: async ({ program, args, cwd }) => {
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
      }
    },
  },
};

const { gitCreateBranch, gitStashSaveAsync, gitStashPopAsync } = require('../git');
const { isCheckoutOverwriteError } = require('../context-menu');

const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const branchExists = (cwd, name) => git(cwd, 'branch', '--list', name).trim() !== '';
const current = cwd => git(cwd, 'branch', '--show-current').trim();
const read = (cwd, f) => fs.readFileSync(path.join(cwd, f), 'utf8');

// ci.yml 이 main 과 other 에서 갈라진, 사용자가 겪은 것과 같은 구조.
// other 는 파일 위쪽(stages)만 고쳤으므로, 아래쪽을 고친 로컬 변경은 자동 병합될 수 있다.
// app.txt 는 양쪽에서 같아 "수정했지만 체크아웃을 막지 않는 파일" 역할을 한다.
const CI_BASE = [
  'stages:',
  '  - build',
  '',
  'build:',
  '  script: make',
  '',
  'test:',
  '  script: make test',
  '',
].join('\n');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcreatebr-'));
  roots.push(root);
  git(root, 'init', '-q', '--initial-branch=main', '.');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');   // 체크아웃마다 줄바꿈이 바뀌면 내용 비교가 흔들린다
  fs.writeFileSync(path.join(root, 'ci.yml'), CI_BASE);
  fs.writeFileSync(path.join(root, 'app.txt'), 'shared\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(root, 'ci.yml'), CI_BASE.replace('  - build\n', '  - build\n  - deploy\n'));
  git(root, 'commit', '-am', 'ci change');

  git(root, 'checkout', '-q', 'main');
  return root;
}

// 로컬에서 파일 아래쪽만 손댄다 — other 가 고친 위쪽과 겹치지 않는다.
function editCiTail(root) {
  fs.writeFileSync(path.join(root, 'ci.yml'), CI_BASE.replace('  script: make test\n', '  script: make test -v\n'));
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

// 재현 — 이 실패가 나면 git 은 브랜치도 만들지 않고 워킹트리도 건드리지 않는다.
// 그래서 사후에 stash 하고 다시 시도하는 복구가 안전하다.
test('수정한 파일이 기준점에서 다르면 브랜치 생성이 거부된다', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'ci.yml'), 'my edit\n');

  const err = await gitCreateBranch(root, 'feature/x', 'other');

  assert.ok(err, '거부되어야 한다');
  assert.ok(isCheckoutOverwriteError(err), '이 에러를 stash 재시도 대상으로 인식해야 한다:\n' + err);
  assert.equal(branchExists(root, 'feature/x'), false, '브랜치가 만들어지면 안 된다');
  assert.equal(current(root), 'main', '브랜치도 그대로여야 한다');
  assert.equal(read(root, 'ci.yml'), 'my edit\n', '수정 내용이 살아 있어야 한다');
});

// 리베이스처럼 "변경이 있으면 무조건 확인창"으로 하면 안 되는 이유 — 아래 둘은 그냥 성공한다.
test('기준점이 HEAD 면 로컬 변경이 있어도 성공한다', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'ci.yml'), 'my edit\n');

  const err = await gitCreateBranch(root, 'feature/x', 'main');

  assert.equal(err, null);
  assert.equal(current(root), 'feature/x');
  assert.equal(read(root, 'ci.yml'), 'my edit\n', '변경은 새 브랜치로 따라온다');
});

test('수정한 파일이 기준점에서 같으면 다른 기준점이어도 성공한다', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'app.txt'), 'my edit\n');   // 양쪽 커밋에서 동일한 파일

  const err = await gitCreateBranch(root, 'feature/x', 'other');

  assert.equal(err, null);
  assert.equal(current(root), 'feature/x');
  assert.equal(read(root, 'app.txt'), 'my edit\n');
});

// 다이얼로그에서 Stash & Create 를 고르면 도는 순서.
test('stash → 생성 → pop 으로 브랜치 생성과 변경 복원이 모두 된다', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'app.txt'), 'my edit\n');
  editCiTail(root);                                            // 이게 체크아웃을 막는다

  assert.ok(isCheckoutOverwriteError(await gitCreateBranch(root, 'feature/x', 'other')));

  assert.equal(await gitStashSaveAsync(root), null);
  assert.equal(await gitCreateBranch(root, 'feature/x', 'other'), null, 'stash 후엔 생성돼야 한다');
  assert.equal(await gitStashPopAsync(root), null);

  assert.equal(current(root), 'feature/x');
  assert.equal(read(root, 'app.txt'), 'my edit\n', '변경이 되돌아와야 한다');
  assert.match(read(root, 'ci.yml'), /make test -v/, '내 수정이 남아 있어야 한다');
  assert.match(read(root, 'ci.yml'), /- deploy/, '새 브랜치의 내용 위에 얹혀야 한다');
});

// 체크아웃을 막은 파일은 곧 두 커밋 사이에서 다른 파일이므로, 같은 자리를 고쳤다면
// 되돌릴 때 충돌한다. 이건 피할 수 없는 성질이라 stash 를 남겨 두고 그 사실을 알린다.
test('되돌리다 충돌해도 변경은 stash 에 남는다', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'ci.yml'), CI_BASE.replace('  - build\n', '  - build\n  - package\n'));

  assert.equal(await gitStashSaveAsync(root), null);
  assert.equal(await gitCreateBranch(root, 'feature/x', 'other'), null);
  const popErr = await gitStashPopAsync(root);

  assert.ok(popErr, '같은 자리를 고쳤으니 충돌한다');
  assert.match(popErr, /CONFLICT/);
  assert.equal(current(root), 'feature/x', '브랜치는 만들어진 상태다');
  assert.match(git(root, 'stash', 'list'), /stash@\{0\}/, 'stash 가 남아 있어야 복구할 수 있다');
});

// 생성이 다른 이유로 실패했다면 stash 를 되돌려 원래 자리로 복구한다.
test('생성이 실패하면 pop 으로 원래 상태를 되찾는다', async () => {
  const root = makeRepo();
  git(root, 'branch', 'taken');
  fs.writeFileSync(path.join(root, 'ci.yml'), 'my edit\n');

  assert.equal(await gitStashSaveAsync(root), null);
  const err = await gitCreateBranch(root, 'taken', 'other');
  assert.ok(err, '이미 있는 이름은 실패한다');
  assert.equal(await gitStashPopAsync(root), null);

  assert.equal(current(root), 'main');
  assert.equal(read(root, 'ci.yml'), 'my edit\n');
});

test('무관한 실패는 stash 재시도 대상으로 보지 않는다', () => {
  assert.equal(isCheckoutOverwriteError("fatal: a branch named 'x' already exists"), false);
  assert.equal(isCheckoutOverwriteError('fatal: not a valid object name: nope'), false);
  assert.equal(isCheckoutOverwriteError(null), false);
});
