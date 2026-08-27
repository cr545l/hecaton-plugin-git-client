const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state } = require('../state');
const { refreshAsync } = require('../refresh');

const SEP = process.platform === 'win32' ? '\\' : '/';

function installHost(cwd) {
  const host = {
    name: 'Alice',
    email: 'alice@example.com',
    local: false,
    configCalls: 0,
    configFailuresRemaining: 0,
    refsCalls: 0,
  };

  hecaton.process.exec = async ({ args }) => {
    const joined = args.join(' ');
    if (joined.includes('for-each-ref')) {
      host.refsCalls++;
      return { ok: true, exit_code: 0, stdout: '*\trefs/heads/main\t\t\t\n' };
    }
    if (joined.includes('worktree list')) {
      return {
        ok: true,
        exit_code: 0,
        stdout: 'worktree ' + cwd + '\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n',
      };
    }
    if (joined.includes('config') && joined.includes('--get-regexp') && joined.includes('^user\\.')) {
      host.configCalls++;
      if (host.configFailuresRemaining > 0) {
        host.configFailuresRemaining--;
        return { ok: false, exit_code: 128, stdout: '', stderr: 'temporary config read failure' };
      }
      const isLocal = args.includes('--local');
      if (isLocal && !host.local) {
        return { ok: false, exit_code: 1, stdout: '', stderr: '' };
      }
      if (!host.name && !host.email) {
        return { ok: false, exit_code: 1, stdout: '', stderr: '' };
      }
      const lines = [];
      if (host.name) lines.push('user.name ' + host.name);
      if (host.email) lines.push('user.email ' + host.email);
      return { ok: true, exit_code: 0, stdout: lines.join('\n') + '\n' };
    }
    if (joined.includes('stash list')) return { ok: true, exit_code: 0, stdout: '' };
    if (joined.includes('remote')) return { ok: true, exit_code: 0, stdout: '' };
    if (joined.includes('rev-list')) return { ok: true, exit_code: 0, stdout: '0\t0\n' };
    return { ok: true, exit_code: 0, stdout: '' };
  };

  hecaton.fs.stat = async ({ path }) => {
    if (/rebase-merge|rebase-apply|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index\.lock/.test(path)) {
      return { exists: false };
    }
    return { exists: true, mtime_ms: 1000 };
  };
  hecaton.fs.read_dir = async ({ path }) => {
    const refsDir = cwd + SEP + '.git' + SEP + 'refs';
    if (path === refsDir) return { ok: true, entries: [{ name: 'heads', is_dir: true }] };
    if (path === refsDir + SEP + 'heads') {
      return { ok: true, entries: [{ name: 'main', is_dir: false, mtime_ms: 1000, size_bytes: 41 }] };
    }
    return { ok: false };
  };
  hecaton.fs.read_file = async ({ path }) => path.endsWith('HEAD')
    ? { content: 'ref: refs/heads/main\n' }
    : { content: '' };
  hecaton.window.set_title = async () => ({ ok: true });

  return host;
}

function resetState(cwd) {
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = cwd + SEP + '.git';
  state.gitCommonDir = state.gitDir;
  state.spinnerActive = false;
  state.branch = 'main';
  state.branches = [];
  state.remoteBranches = [];
  state.remotes = [];
  state.stashes = [];
  state.worktrees = [];
  state.operationState = null;
  state.rebaseMessage = '';
  state.committerName = '';
  state.committerEmail = '';
  state.committerNameIsLocal = false;
  state.committerEmailIsLocal = false;
  state.error = null;
}

const OPTIONS = { metadataOnly: true, silent: true };

test('committer config is refreshed even when other metadata is cached', async () => {
  const cwd = 'C:/committer-config-change';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTIONS);
  assert.equal(state.committerName, 'Alice');
  assert.equal(state.committerEmail, 'alice@example.com');

  host.name = 'Bob';
  host.email = 'bob@example.com';
  await refreshAsync(OPTIONS);

  assert.equal(state.committerName, 'Bob');
  assert.equal(state.committerEmail, 'bob@example.com');
  assert.equal(host.refsCalls, 1, 'unrelated metadata should still use its fingerprint cache');
  assert.equal(host.configCalls, 4, 'effective and local config should be read on each refresh');
});

test('a transient config read failure is retried before showing placeholders', async () => {
  const cwd = 'C:/committer-config-retry';
  const host = installHost(cwd);
  host.configFailuresRemaining = 2;
  resetState(cwd);

  await refreshAsync(OPTIONS);

  assert.equal(state.committerName, 'Alice');
  assert.equal(state.committerEmail, 'alice@example.com');
  assert.equal(host.configCalls, 4);
});

test('a persistent config read failure preserves the last known committer', async () => {
  const cwd = 'C:/committer-config-preserve';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTIONS);
  host.configFailuresRemaining = 4;
  await refreshAsync(OPTIONS);

  assert.equal(state.committerName, 'Alice');
  assert.equal(state.committerEmail, 'alice@example.com');
});
