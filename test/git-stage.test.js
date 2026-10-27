require('./helpers/git-mutation-host');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  gitStageAll,
  gitStageMultiple,
  gitUnstageMultiple,
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
  assert.equal(request.timeout_ms, undefined);
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
  assert.match(err, /Git command timed out/);
  assert.match(err, /refresh and retry/);
});

test('successful host results without exit_code are accepted', async () => {
  mockExec(async () => ({ ok: true, stdout: '', stderr: '' }));

  const err = await gitUnstageAsync('C:\\repo', 'file.txt');

  assert.equal(err, null);
});

function pathspecHost({ writeResult = { ok: true }, mutationResult = { ok: true, exit_code: 0 }, throwExec = false } = {}) {
  const calls = [], writes = [], deletes = [];
  mockExec(async params => {
    calls.push(params);
    if (params.args[0] === 'rev-parse') return { ok: true, exit_code: 0, stdout: 'C:/repo/.git/worktrees/linked\n' };
    if (throwExec) throw new Error('host disconnected');
    return mutationResult;
  });
  hecaton.fs = {
    write_file: async params => { writes.push(params); return writeResult; },
    delete: async params => { deletes.push(params); return { ok: true }; },
  };
  return { calls, writes, deletes };
}

const largeSelection = () => Array.from({ length: 16378 }, (_, i) => 'Unity/Assets/long directory/asset-' + i + '.meta');

for (const [name, run] of [['stage', gitStageMultiple], ['unstage', gitUnstageMultiple]]) {
  test(name + ' transports 16,378 paths in one bounded command and cleans the pathspec file', async () => {
    const host = pathspecHost();
    const files = [...largeSelection(), '한글/space [x].txt', 'quote"\nline.txt', '-option', ':(glob)*'];
    assert.equal(await run('C:/repo', [...files, files[0]]), null);
    assert.equal(host.calls.length, 2);
    assert.equal(host.writes.length, 1);
    assert.equal(host.writes[0].content, files.join('\0') + '\0');
    assert.match(host.writes[0].path.replace(/\\/g, '/'), /^C:\/repo\/\.git\/worktrees\/linked\/hecaton-pathspec-/);
    const command = host.calls[1];
    assert.ok(command.args.join(' ').length < 1000);
    assert.ok(command.args.includes('--literal-pathspecs'));
    assert.ok(command.args.includes('--pathspec-file-nul'));
    assert.ok(command.args.includes('--pathspec-from-file=' + host.writes[0].path));
    assert.equal(command.timeout_ms, undefined);
    assert.deepEqual(host.deletes, [{ path: host.writes[0].path }]);
  });
}

test('long paths use file transport even with few selections', async () => {
  const host = pathspecHost();
  assert.equal(await gitStageMultiple('C:/repo', Array.from({ length: 30 }, (_, i) => 'x'.repeat(200) + i)), null);
  assert.equal(host.writes.length, 1);
});

test('empty selection never executes Git', async () => {
  const host = pathspecHost();
  assert.equal(await gitStageMultiple('C:/repo', []), null);
  assert.equal(await gitUnstageMultiple('C:/repo', []), null);
  assert.equal(host.calls.length, 0);
});

test('failed pathspec write never starts an index mutation', async () => {
  const host = pathspecHost({ writeResult: { ok: false, error: 'access denied' } });
  const err = await gitStageMultiple('C:/repo', largeSelection());
  assert.match(err, /Could not write the selected paths/);
  assert.match(err, /access denied/);
  assert.equal(host.calls.length, 1);
  assert.equal(host.deletes.length, 1);
});

test('failed git directory lookup never writes a pathspec or mutates the index', async () => {
  const host = pathspecHost();
  hecaton.process.exec = async () => ({ ok: true, exit_code: 128, stdout: '.git' });
  assert.ok(await gitStageMultiple('C:/repo', largeSelection()));
  assert.equal(host.writes.length, 0);
});

test('Git failure keeps diagnostics and cleans only the temporary pathspec', async () => {
  const host = pathspecHost({ mutationResult: { ok: true, exit_code: 128, stderr: 'fatal: index.lock exists' } });
  assert.match(await gitStageMultiple('C:/repo', largeSelection()), /index.lock exists/);
  assert.deepEqual(host.deletes, [{ path: host.writes[0].path }]);
});

test('thrown execution failure also cleans the temporary pathspec', async () => {
  const host = pathspecHost({ throwExec: true });
  assert.match(await gitStageMultiple('C:/repo', largeSelection()), /host disconnected/);
  assert.equal(host.deletes.length, 1);
});

test('cleanup failure does not report a successful stage as failed', async () => {
  pathspecHost();
  hecaton.fs.delete = async () => { throw new Error('cleanup failed'); };
  assert.equal(await gitStageMultiple('C:/repo', largeSelection()), null);
});

test('overlapping requests never share a temporary pathspec', async () => {
  const host = pathspecHost();
  assert.deepEqual(await Promise.all([
    gitStageMultiple('C:/repo', largeSelection()),
    gitStageMultiple('C:/repo', largeSelection()),
  ]), [null, null]);
  assert.notEqual(host.writes[0].path, host.writes[1].path);
});
