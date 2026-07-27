// 리네임된 브랜치의 푸시 통합 테스트 — 실제 git을 돌린다.
// `git branch -m` 은 branch.<name>.merge 를 옛 이름 그대로 남기므로, 인자 없는
// `git push` 는 push.default=simple 정책에 걸려 fatal 로 죽는다. 인자 문자열만
// 검사해서는 이 상황을 재현할 수 없으므로 bare 원격을 만들어 실제 결과를 본다.
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

const { gitBranches, gitPushAsync, gitPushToRemoteAsync, gitPushHeadToBranchAsync, splitUpstreamRef } = require('../git');

const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// bare 원격 + 그 원격을 추적하는 클론을 만들고, 로컬 브랜치를 리네임해
// upstream 이름만 어긋난 상태를 재현한다.
function makeRenamedBranchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpush-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');

  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test');
  git(local, 'config', 'push.default', 'simple');

  fs.writeFileSync(path.join(local, 'a.txt'), 'one\n');
  git(local, 'add', 'a.txt');
  git(local, 'commit', '-m', 'first');
  git(local, 'checkout', '-b', 'feature-old');
  git(local, 'push', '-u', 'origin', 'feature-old');

  fs.writeFileSync(path.join(local, 'a.txt'), 'two\n');
  git(local, 'commit', '-am', 'second');
  git(local, 'branch', '-m', 'feature-old', 'feature-new');

  return { root, remote, local };
}

// 원격의 브랜치 → 커밋 해시
function remoteHeads(remote) {
  const out = git(remote, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads');
  const map = {};
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    const [name, hash] = line.split(' ');
    map[name] = hash;
  }
  return map;
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('리네임하면 upstream 이름만 어긋난 채 남는다', async () => {
  const { local } = makeRenamedBranchRepo();
  const branches = await gitBranches(local);
  const current = branches.find(b => b.isCurrent);
  assert.equal(current.name, 'feature-new');
  assert.equal(current.upstream, 'origin/feature-old');
});

test('그 상태에서 인자 없는 push 는 실패한다 (재현)', async () => {
  const { local } = makeRenamedBranchRepo();
  const err = await gitPushAsync(local);
  assert.ok(err, 'push 가 성공해서는 안 된다');
  // git 이 줄을 접어 내보내므로 개행을 넘어 매칭한다
  assert.match(err, /does not match\s+the name of your current branch/);
});

test("'Push as <local>' 은 로컬 이름의 원격 브랜치로 밀고 upstream 을 재설정한다", async () => {
  const { local, remote } = makeRenamedBranchRepo();
  const err = await gitPushToRemoteAsync(local, 'origin', 'feature-new');
  assert.equal(err, null);

  const heads = remoteHeads(remote);
  assert.ok(heads['feature-new'], 'origin/feature-new 가 생겨야 한다');
  assert.equal(heads['feature-new'], git(local, 'rev-parse', 'HEAD').trim());

  const current = (await gitBranches(local)).find(b => b.isCurrent);
  assert.equal(current.upstream, 'origin/feature-new');
});

test("'Push to <upstream>' 은 추적 중인 옛 이름 브랜치를 갱신하고 upstream 을 유지한다", async () => {
  const { local, remote } = makeRenamedBranchRepo();
  const before = remoteHeads(remote)['feature-old'];
  const err = await gitPushHeadToBranchAsync(local, 'origin', 'feature-old');
  assert.equal(err, null);

  const heads = remoteHeads(remote);
  assert.notEqual(heads['feature-old'], before, 'origin/feature-old 가 갱신되어야 한다');
  assert.equal(heads['feature-old'], git(local, 'rev-parse', 'HEAD').trim());
  assert.equal(heads['feature-new'], undefined, '새 이름 브랜치는 만들지 않는다');

  const current = (await gitBranches(local)).find(b => b.isCurrent);
  assert.equal(current.upstream, 'origin/feature-old');
});

// upstream 문자열을 remote/branch 로 자를 때 브랜치 이름의 '/' 에 속으면 안 된다.
test('splitUpstreamRef 는 remote 목록을 우선해 자른다', () => {
  assert.deepEqual(splitUpstreamRef('origin/w4-menu', ['origin']), { remote: 'origin', branch: 'w4-menu' });
  assert.deepEqual(
    splitUpstreamRef('origin/hecaton/hecaton-260130-4', ['origin', 'upstream']),
    { remote: 'origin', branch: 'hecaton/hecaton-260130-4' },
  );
  // remote 목록이 비었을 때는 첫 세그먼트로 폴백
  assert.deepEqual(splitUpstreamRef('origin/feature/x', []), { remote: 'origin', branch: 'feature/x' });
  assert.deepEqual(splitUpstreamRef('', ['origin']), { remote: '', branch: '' });
});
