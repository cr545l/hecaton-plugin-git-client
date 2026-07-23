const test = require('node:test');
const assert = require('node:assert/strict');

const {
  gitStageAll,
  gitStageMultiple,
  gitUnstageAsync,
} = require('../git');

function mockExec(handler) {
  global.hecaton = {
    process: {
      exec: handler,
    },
  };
}

test('Stage All respects ignore rules and allows enough time for a large repository', async () => {
  let request;
  mockExec(async params => {
    request = params;
    return { ok: true, exit_code: 0, stdout: '', stderr: '' };
  });

  const err = await gitStageAll('C:\\repo');

  assert.equal(err, null);
  assert.deepEqual(request.args, ['add', '-A']);
  assert.equal(request.timeout_ms, 30000);
});

test('stage failures preserve the Git error and actionable index-lock guidance', async () => {
  mockExec(async () => ({
    ok: false,
    exit_code: 128,
    error: 'process exited with code 128',
    stderr: "fatal: Unable to create 'C:/repo/.git/index.lock': File exists.",
  }));

  const err = await gitStageMultiple('C:\\repo', ['problem.txt', 'other.txt']);

  assert.match(err, /Could not stage 2 selected files/);
  assert.match(err, /index\.lock/);
  assert.match(err, /Use the Unlock button only after confirming no Git process is running/);
});

test('stage timeout errors explain recovery instead of returning a bare false', async () => {
  mockExec(async () => ({
    ok: false,
    error: 'process timed out',
    stderr: 'warning: line ending conversion',
  }));

  const err = await gitStageMultiple('C:\\repo', ['slow.txt']);

  assert.match(err, /process timed out/);
  assert.match(err, /exceeded 10 seconds/);
  assert.match(err, /stage fewer files at a time/);
});

test('successful host results without exit_code are accepted', async () => {
  mockExec(async () => ({ ok: true, stdout: '', stderr: '' }));

  const err = await gitUnstageAsync('C:\\repo', 'file.txt');

  assert.equal(err, null);
});
