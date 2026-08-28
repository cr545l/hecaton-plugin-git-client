const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');

const { gitDiscardFile, gitDiscardAllChangesAsync } = require('../git');

const CWD = 'C:\repo';
const UNLINK_ERROR = "error: unable to unlink old 'plugin.json': Invalid argument";

// exec 호출을 인자 배열로 매칭해 응답을 돌려주는 목. 각 호출은 calls 에 순서대로 쌓인다.
function mockGit(routes) {
  const calls = [];
  const fsCalls = [];
  global.hecaton = {
    process: {
      exec: async params => {
        calls.push(params.args);
        for (const [match, reply] of routes) {
          if (match(params.args)) return typeof reply === 'function' ? reply(params.args) : reply;
        }
        return { ok: true, exit_code: 0, stdout: '', stderr: '' };
      },
    },
    fs: {
      copy: async params => { fsCalls.push(['copy', params]); return { ok: true }; },
      delete: async params => { fsCalls.push(['delete', params]); return { ok: true }; },
    },
  };
  return { calls, fsCalls };
}

const starts = (...prefix) => args => prefix.every((p, i) => args[i] === p);
const fail = stderr => ({ ok: true, exit_code: 128, stdout: '', stderr });
const ok = (stdout = '') => ({ ok: true, exit_code: 0, stdout, stderr: '' });

test('unlink 이 막힌 파일은 삭제 없이 제자리 복원으로 discard 를 끝낸다', async () => {
  const { calls, fsCalls } = mockGit([
    [starts('restore', '--'), fail(UNLINK_ERROR)],
    [starts('checkout-index', '--temp'), ok('.merge_file_ab12\tplugin.json\n')],
    [starts('diff', '--quiet'), ok()],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'unstaged', file: 'plugin.json' });

  assert.equal(err, null);
  assert.deepEqual(calls[0], ['restore', '--', 'plugin.json']);
  assert.deepEqual(calls[1], ['checkout-index', '--temp', '--', 'plugin.json']);
  assert.deepEqual(calls[2], ['diff', '--quiet', '--', 'plugin.json']);
  assert.deepEqual(fsCalls, [
    ['copy', {
      from_path: nodePath.join(CWD, '.merge_file_ab12'),
      to_path: nodePath.join(CWD, 'plugin.json'),
      overwrite: true,
    }],
    ['delete', { path: nodePath.join(CWD, '.merge_file_ab12') }],
  ]);
});

test('staged 파일은 인덱스를 HEAD 로 되돌린 뒤 워크트리를 제자리 복원한다', async () => {
  const { calls } = mockGit([
    [starts('restore', '--staged', '--worktree'), fail(UNLINK_ERROR)],
    [starts('checkout-index', '--temp'), ok('.merge_file_cd34\tplugin.json\n')],
    [starts('diff', '--quiet'), ok()],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'staged', file: 'plugin.json' });

  assert.equal(err, null);
  assert.deepEqual(calls[1], ['restore', '--staged', '--source=HEAD', '--', 'plugin.json']);
  assert.deepEqual(calls[2], ['checkout-index', '--temp', '--', 'plugin.json']);
});

test('unlink 과 무관한 실패는 제자리 복원을 시도하지 않고 원래 메시지를 돌려준다', async () => {
  const { calls } = mockGit([
    [starts('restore', '--'), fail("error: pathspec 'gone.txt' did not match any file(s) known to git")],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'unstaged', file: 'gone.txt' });

  assert.match(err, /did not match any file/);
  assert.equal(calls.length, 1);
});

test('제자리 복원까지 실패하면 원인과 잠금 안내를 함께 알린다', async () => {
  mockGit([
    [starts('restore', '--'), fail(UNLINK_ERROR)],
    [starts('checkout-index', '--temp'), ok('.merge_file_ef56\tplugin.json\n')],
    [starts('diff', '--quiet'), { ok: true, exit_code: 1, stdout: '', stderr: '' }],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'unstaged', file: 'plugin.json' });

  assert.match(err, /unable to unlink old/);
  assert.match(err, /Another process is holding the file open/);
  assert.match(err, /still differs after the in-place restore/);
});

test('미추적 파일은 삭제가 목적이라 폴백 없이 잠금 안내만 덧붙인다', async () => {
  const { calls } = mockGit([
    [starts('clean', '-f'), { ok: true, exit_code: 1, stdout: '', stderr: 'warning: failed to remove plugin.json: Invalid argument' }],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'untracked', file: 'plugin.json' });

  assert.match(err, /failed to remove plugin\.json/);
  assert.match(err, /Another process is holding the file open/);
  assert.equal(calls.length, 1);
});

test('Discard All 은 막힌 경로만 제자리 복원한 뒤 reset 을 다시 돌려 끝낸다', async () => {
  let resetCount = 0;
  const { calls } = mockGit([
    [starts('rev-parse', '--verify', 'HEAD'), ok('abc123\n')],
    [starts('reset', '--hard'), () => {
      resetCount += 1;
      return resetCount === 1
        ? fail("error: unable to unlink old 'plugin.json': Invalid argument\n"
             + "error: unable to unlink old 'src/main.js': Invalid argument")
        : ok();
    }],
    [starts('checkout-index', '--temp'), args => ok('.merge_file_' + args[3].length + '\t' + args[3] + '\n')],
    [starts('diff', '--quiet'), ok()],
  ]);

  const err = await gitDiscardAllChangesAsync(CWD);

  assert.equal(err, null);
  assert.equal(resetCount, 2);
  const restored = calls.filter(args => args[0] === 'checkout-index').map(args => args[3]);
  assert.deepEqual(restored, ['plugin.json', 'src/main.js']);
});
