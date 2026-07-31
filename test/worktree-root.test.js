const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { resolveWorkTreeRoot } = require('../git');

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
      stat: async ({ path: p }) => ({ exists: owners.has(path.dirname(p)) }),
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

test('빈 cwd는 건드리지 않는다', async () => {
  mockHost([]);

  assert.equal(await resolveWorkTreeRoot(''), '');
});
