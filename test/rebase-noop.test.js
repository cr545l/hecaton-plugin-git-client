// 이전 리비전(= 이미 HEAD 의 조상)으로 rebase 할 때의 동작 — 실제 git 을 돌린다.
// git 은 이 경우 옮길 커밋이 없다고 판단해 "Current branch X is up to date." 를
// stdout 에 찍고 exit 0 으로 끝낸다. 종료 코드만 보면 성공과 구분되지 않아
// 화면상 "스피너만 돌다 아무 일도 안 일어난" 것처럼 보였다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

global.hecaton = {
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

const { gitIsRebaseNoop, gitRebaseAsync, gitMergeAsync, gitResetAsync } = require('../git');

const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function head(cwd, ref) {
  return git(cwd, 'rev-parse', ref || 'HEAD').trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrebase-'));
  roots.push(root);
  git(root, 'init', '-q', '--initial-branch=main', '.');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  return root;
}

// main 위에 android 가 1커밋 앞서 있는, 사용자가 겪은 것과 같은 구조
function makeAheadRepo() {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'android');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  git(root, 'commit', '-am', 'ahead');
  return root;
}

// main 과 feat 가 같은 파일을 서로 다르게 고쳐 갈라진 구조
function makeDivergedRepo() {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(root, 'a.txt'), 'feat\n');
  git(root, 'commit', '-am', 'feat');
  git(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'main\n');
  git(root, 'commit', '-am', 'main');
  return root;
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('대상이 HEAD 의 조상이면 no-op 으로 판정한다', async () => {
  const root = makeAheadRepo();
  assert.equal(await gitIsRebaseNoop(root, 'main'), true);
});

test('HEAD 자신을 대상으로 해도 no-op 이다', async () => {
  const root = makeAheadRepo();
  assert.equal(await gitIsRebaseNoop(root, 'android'), true);
  assert.equal(await gitIsRebaseNoop(root, head(root)), true);
});

test('갈라진 브랜치는 no-op 이 아니다', async () => {
  const root = makeDivergedRepo();
  assert.equal(await gitIsRebaseNoop(root, 'feat'), false);
});

test('없는 ref 는 no-op 으로 오판하지 않는다', async () => {
  const root = makeAheadRepo();
  assert.equal(await gitIsRebaseNoop(root, 'no-such-branch'), false);
});

// 사전 검사가 필요한 이유 — git 자체는 성공으로 끝내고 아무것도 바꾸지 않는다.
test('조상으로의 rebase 는 에러 없이 끝나지만 HEAD 가 그대로다 (재현)', async () => {
  const root = makeAheadRepo();
  const before = head(root);

  const err = await gitRebaseAsync(root, 'main');

  assert.equal(err, null, 'git 은 실패를 알리지 않는다');
  assert.equal(head(root), before, '그런데 HEAD 는 움직이지 않는다');
});

test('Reset 은 브랜치를 그 리비전으로 되돌린다', async () => {
  const root = makeAheadRepo();
  const target = head(root, 'main');

  const err = await gitResetAsync(root, 'main');

  assert.equal(err, null);
  assert.equal(head(root), target);
  // 떨어져 나간 커밋은 reflog 로 되찾을 수 있어야 한다
  assert.match(git(root, 'reflog'), /ahead/);
});

// gitAsyncWrap 은 stderr 만 읽었다. merge 충돌은 stderr 가 완전히 비고 stdout 에만
// CONFLICT 가 실리므로, 실패 사유가 'Operation failed' 로 뭉개져 호출부의
// 충돌 감지(isRebaseConflictError)까지 빗나갔다.
test('실패 사유가 stdout 에만 있어도 그대로 전달한다', async () => {
  const root = makeDivergedRepo();

  const err = await gitMergeAsync(root, 'feat');

  assert.ok(err, '충돌한 merge 는 실패로 보고되어야 한다');
  assert.notEqual(err, 'Operation failed', 'stdout 을 버려 사유가 뭉개지면 안 된다');
  assert.match(err, /CONFLICT/);
});
