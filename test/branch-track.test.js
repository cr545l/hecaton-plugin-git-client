// 브랜치별 추적 상태(upstream, ahead/behind, gone) 파싱 검증.
//
// Status 힌트바가 push/pull 대기 수를 보여주려면 브랜치 목록 조회에서 그 값이 함께
// 와야 한다. track 문자열은 로케일에 따라 번역될 수 있으므로 방향 판별은 번역되지 않는
// trackshort에 맡긴다 — 그 조합이 실제 git 출력에서도 맞는지 함께 본다.
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

const { gitBranches, parseUpstreamTrack } = require('../git');

// ── 파싱 ──

test('추적 상태가 없으면 0으로 둔다', () => {
  assert.deepEqual(parseUpstreamTrack('', ''), { ahead: 0, behind: 0, gone: false });
  assert.deepEqual(parseUpstreamTrack('', '='), { ahead: 0, behind: 0, gone: false });
});

test('ahead / behind / 양쪽 갈림을 각각 읽는다', () => {
  assert.deepEqual(parseUpstreamTrack('[ahead 2]', '>'), { ahead: 2, behind: 0, gone: false });
  assert.deepEqual(parseUpstreamTrack('[behind 3]', '<'), { ahead: 0, behind: 3, gone: false });
  assert.deepEqual(parseUpstreamTrack('[ahead 2, behind 3]', '<>'), { ahead: 2, behind: 3, gone: false });
});

test('upstream이 사라졌으면 gone으로 표시한다', () => {
  assert.deepEqual(parseUpstreamTrack('[gone]', ''), { ahead: 0, behind: 0, gone: true });
});

// 번역된 git이라도 방향은 trackshort로 판별하므로 숫자만 맞으면 된다.
test('번역된 track 문자열에서도 방향이 뒤집히지 않는다', () => {
  assert.deepEqual(parseUpstreamTrack('[2 앞서 있음]', '>'), { ahead: 2, behind: 0, gone: false });
  assert.deepEqual(parseUpstreamTrack('[3 뒤에 있음]', '<'), { ahead: 0, behind: 3, gone: false });
});

// ── 실제 git ──

const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(repo, text) {
  fs.writeFileSync(path.join(repo, 'a.txt'), text + '\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-m', text);
}

// bare 원격 하나에 클론 둘 — 한쪽에서 밀고 다른 쪽에서 쌓아 갈라진 상태를 만든다.
function makeDivergedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittrack-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const other = path.join(root, 'other');

  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test');
  commit(local, 'first');
  git(local, 'push', '-u', 'origin', 'main');

  git(root, 'clone', remote, other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  commit(other, 'remote-side');
  git(other, 'push', 'origin', 'main');

  commit(local, 'local-side-1');
  commit(local, 'local-side-2');
  git(local, 'fetch', 'origin');

  return { root, remote, local };
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('갈라진 브랜치의 ahead/behind를 실제 git에서 읽어온다', async () => {
  const { local } = makeDivergedRepo();
  const main = (await gitBranches(local)).find(b => b.name === 'main');

  assert.equal(main.upstream, 'origin/main');
  assert.equal(main.ahead, 2, '밀지 않은 로컬 커밋 수');
  assert.equal(main.behind, 1, '받지 않은 원격 커밋 수');
  assert.equal(main.upstreamGone, false);
});

test('upstream이 없는 브랜치는 추적 값이 비어 있다', async () => {
  const { local } = makeDivergedRepo();
  git(local, 'branch', 'scratch');
  const scratch = (await gitBranches(local)).find(b => b.name === 'scratch');

  assert.equal(scratch.upstream, '');
  assert.equal(scratch.ahead, 0);
  assert.equal(scratch.behind, 0);
  assert.equal(scratch.upstreamGone, false);
});

test('원격에서 지워진 upstream은 gone으로 온다', async () => {
  const { local } = makeDivergedRepo();
  git(local, 'checkout', '-b', 'temp');
  git(local, 'push', '-u', 'origin', 'temp');
  git(local, 'push', 'origin', '--delete', 'temp');
  git(local, 'fetch', '--prune', 'origin');

  const temp = (await gitBranches(local)).find(b => b.name === 'temp');
  assert.equal(temp.upstreamGone, true, 'upstream이 사라진 상태여야 한다');
});
