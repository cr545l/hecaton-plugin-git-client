const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {
    stat: async () => ({ ok: true, exists: false }),
  },
  process: {},
  window: {
    set_title: async () => ({ ok: true }),
  },
  terminal: {},
  initialState: { cols: 120, rows: 40 },
};

const { state } = require('../state');
const { refreshAsync } = require('../refresh');

function resetNonRepoState() {
  state.cwd = 'C:/empty-folder';
  state.loading = false;
  state.isGitRepo = false;
  state.gitDir = '';
  state.gitCommonDir = '';
  state.branch = '';
  state.error = null;
  state.spinnerActive = false;
  state.staged = [];
  state.unstaged = [];
  state.untracked = [];
  state.ignored = [];
}

test('fast initial refresh does not treat a completed Git process with exit 128 as a repository', async () => {
  resetNonRepoState();
  const calls = [];
  hecaton.process.exec = async ({ args }) => {
    calls.push(args);
    return {
      ok: true,
      exit_code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    };
  };

  await refreshAsync({
    statusOnly: true,
    loadBranch: true,
    singleProcessStatus: true,
    fastFirstPaint: true,
    silent: true,
  });

  assert.equal(state.isGitRepo, false);
  assert.equal(state.branch, '');
  assert.match(state.error, /not a git repository/i);
  assert.ok(calls.some(args => args.includes('status')), 'fast status probe should run');
  assert.ok(calls.some(args => args.includes('rev-parse')), 'repository pre-check should run after status fails');
});
