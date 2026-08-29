const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { resolveWorkTreeRoot, findGitDirFromDisk } = require('../git');

// git이 보고하는 파일 경로는 저장소 루트 기준인데 pathspec은 cwd 기준으로 해석된다.
// 하위 디렉터리에서 열면 그 둘이 어긋나 discard/stage/diff가 전부 빗나가므로,
// 저장소를 열 때 워크트리 루트로 cwd를 맞춘다.

const ROOT = path.resolve(path.sep + 'repo');
const SUB = path.join(ROOT, 'provider-backend');

// dotGitEntries: '.git'을 가진 디렉터리 → stat 결과. execHandler: git spawn 대역.
function mockHost(dotGitDirs, execHandler) {
  const owners = new Set(dotGitDirs.map(d => path.resolve(d)));
  global.hecaton = {
    fs: {
      stat: async ({ path: p }) => {
        for (const owner of owners) {
          const marker = path.join(owner, '.git');
          if (p === marker) return { exists: true, is_dir: true };
          if (p === path.join(marker, 'HEAD')) return { exists: true, is_dir: false };
        }
        return { exists: false };
      },
      read_file: async () => ({ content: '' }),
    },
    process: {
      exec: execHandler || (async () => ({ ok: false, exit_code: 128, stdout: '', stderr: '' })),
    },
  };
}

test('하위 디렉터리에서 열면 .git을 품은 워크트리 루트로 올라간다', async () => {
  mockHost([ROOT]);

  assert.equal(await resolveWorkTreeRoot(SUB), ROOT);
});

test('이미 워크트리 루트면 경로가 그대로 유지된다', async () => {
  mockHost([ROOT]);

  assert.equal(await resolveWorkTreeRoot(ROOT), ROOT);
});

test('가장 가까운 .git을 고른다 — 서브모듈 안에서는 서브모듈 루트가 된다', async () => {
  const submodule = path.join(ROOT, 'vendor', 'lib');
  mockHost([ROOT, submodule]);

  assert.equal(await resolveWorkTreeRoot(path.join(submodule, 'src')), submodule);
});

test('디스크 탐색이 실패하면 rev-parse --show-toplevel로 폴백한다', async () => {
  let requestedArgs = null;
  mockHost([], async params => {
    requestedArgs = params.args;
    return { ok: true, exit_code: 0, stdout: ROOT.replace(/\\/g, '/') + '\n', stderr: '' };
  });

  assert.equal(await resolveWorkTreeRoot(SUB), ROOT);
  assert.deepEqual(requestedArgs, ['--no-optional-locks', 'rev-parse', '--show-toplevel']);
});

test('저장소가 아니면(bare 포함) 원래 경로를 그대로 둔다', async () => {
  mockHost([]);

  assert.equal(await resolveWorkTreeRoot(SUB), SUB);
});

test('HEAD 없는 가짜 .git 디렉터리는 저장소로 오인하지 않는다', async () => {
  const fake = path.join(ROOT, 'empty');
  global.hecaton = {
    fs: {
      stat: async ({ path: p }) => {
        if (p === path.join(fake, '.git')) return { exists: true, is_dir: true };
        return { exists: false };
      },
      read_file: async () => ({ content: '' }),
    },
    process: {
      exec: async () => ({ ok: false, exit_code: 128, stdout: '', stderr: 'not a git repository' }),
    },
  };

  assert.equal(await findGitDirFromDisk(fake), '');
  assert.equal(await resolveWorkTreeRoot(fake), fake);
});

test('가짜 .git이 있어도 상위의 실제 저장소를 계속 찾는다', async () => {
  const fake = path.join(ROOT, 'nested');
  global.hecaton = {
    fs: {
      stat: async ({ path: p }) => {
        if (p === path.join(fake, '.git')) return { exists: true, is_dir: true };
        if (p === path.join(ROOT, '.git')) return { exists: true, is_dir: true };
        if (p === path.join(ROOT, '.git', 'HEAD')) return { exists: true, is_dir: false };
        return { exists: false };
      },
      read_file: async () => ({ content: '' }),
    },
    process: {
      exec: async () => ({ ok: false, exit_code: 128, stdout: '', stderr: '' }),
    },
  };

  assert.equal(await resolveWorkTreeRoot(path.join(fake, 'src')), ROOT);
});

test('.git 파일이 가리키는 linked worktree의 HEAD도 검증한다', async () => {
  const linked = path.join(ROOT, 'linked');
  const linkedGitDir = path.join(ROOT, '.git', 'worktrees', 'linked');
  global.hecaton = {
    fs: {
      stat: async ({ path: p }) => {
        if (p === path.join(linked, '.git')) return { exists: true, is_dir: false };
        if (p === path.join(linkedGitDir, 'HEAD')) return { exists: true, is_dir: false };
        return { exists: false };
      },
      read_file: async ({ path: p }) => p === path.join(linked, '.git')
        ? { content: 'gitdir: ' + linkedGitDir }
        : { content: '' },
    },
    process: {
      exec: async () => ({ ok: false, exit_code: 128, stdout: '', stderr: '' }),
    },
  };

  assert.equal(await findGitDirFromDisk(linked), linkedGitDir);
  assert.equal(await resolveWorkTreeRoot(path.join(linked, 'src')), linked);
});

test('빈 cwd는 건드리지 않는다', async () => {
  mockHost([]);

  assert.equal(await resolveWorkTreeRoot(''), '');
});
