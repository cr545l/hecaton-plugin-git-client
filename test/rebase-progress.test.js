const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readRebaseProgress } = require('../rebase-progress');
const { gitOperationState } = require('../git');

function host(files, directory = 'C:/repo/.git/rebase-merge') {
  global.hecaton = {
    process: { exec: async () => ({ ok: true, stdout: 'C:/repo/.git\n' }) },
    fs: {
      stat: async ({ path: file }) => ({ exists: path.normalize(file) === path.normalize(directory), is_dir: true }),
      read_file: async ({ path: file }) => {
        const name = path.basename(file);
        if (!(name in files)) throw new Error('not found');
        return { ok: true, content: files[name] };
      },
    },
  };
}

test('merge and apply counters preserve actual progress', async () => {
  host({ msgnum: '3\n', end: '9\n', next: '2', last: '7' });
  assert.deepEqual(await readRebaseProgress('repo'), { step: 3, total: 9 });
  assert.deepEqual(await readRebaseProgress('repo', true), { step: 2, total: 7 });
});

test('missing or corrupt counters are unknown rather than zero', async () => {
  for (const files of [{}, { msgnum: 'NaN', end: '4' }, { msgnum: '2oops', end: '4' }, { msgnum: '5', end: '4' }]) {
    host(files);
    assert.deepEqual(await readRebaseProgress('repo'), { step: null, total: null });
  }
});

test('Day7 noop state has zero commits, even without counter files', async () => {
  host({ done: 'noop\n', 'git-rebase-todo': '' });
  assert.deepEqual(await readRebaseProgress('repo'), { step: 0, total: 0 });
});

test('pending commit commands without counters do not pretend to be noop', async () => {
  host({ done: 'noop\n', 'git-rebase-todo': 'pick abc123 commit' });
  assert.deepEqual(await readRebaseProgress('repo'), { step: null, total: null });
});

test('operation detection resolves absolute git directories and survives missing files', async () => {
  host({});
  assert.deepEqual(await gitOperationState('C:/repo'), { type: 'rebase-merge', step: null, total: null });
});
