const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state } = require('../state');
const { refreshAsync, invalidateCommitterCache, __expireCommitterCache } = require('../refresh');

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
      // --show-scope 는 "<scope>\t<key> <value>" 로 낸다. 미지정 조회는 종전대로 "<key> <value>".
      const prefix = args.includes('--show-scope') ? (host.local ? 'local\t' : 'global\t') : '';
      const lines = [];
      if (host.name) lines.push(prefix + 'user.name ' + host.name);
      if (host.email) lines.push(prefix + 'user.email ' + host.email);
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
  // 테스트마다 cwd가 달라 캐시는 어차피 미스지만, 순서에 기대지 않도록 명시적으로 비운다.
  invalidateCommitterCache();
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
  // 밖에서 바꾼 글로벌 설정은 TTL 이 지나면 따라온다. 테스트에서 10초를 기다릴 수는 없으므로
  // 캐시 나이만 되돌려 만료를 흉내낸다.
  __expireCommitterCache();
  await refreshAsync(OPTIONS);

  assert.equal(state.committerName, 'Bob');
  assert.equal(state.committerEmail, 'bob@example.com');
  assert.equal(host.refsCalls, 1, 'unrelated metadata should still use its fingerprint cache');
  // 다시 읽을 때 쓰는 프로세스는 하나뿐이다 — effective 값과 local 지정 여부를
  // --show-scope 한 번으로 함께 받는다.
  assert.equal(host.configCalls, 2, 'committer config should be read with a single process');
});

test('연달아 도는 refresh 는 committer config 를 다시 읽지 않는다', async () => {
  const cwd = 'C:/committer-config-ttl';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTIONS);
  const afterFirst = host.configCalls;
  assert.ok(afterFirst > 0);

  // fetch 직후처럼 refresh 가 몰려 도는 구간. TTL 안이므로 프로세스를 더 쓰지 않는다.
  await refreshAsync(OPTIONS);
  await refreshAsync(OPTIONS);

  assert.equal(host.configCalls, afterFirst, 'TTL 안에서는 캐시된 값을 쓴다');
  assert.equal(state.committerName, 'Alice', '캐시를 써도 표시 값은 유지된다');
});

test('invalidateCommitterCache 는 TTL 을 기다리지 않고 다시 읽게 한다', async () => {
  const cwd = 'C:/committer-config-invalidate';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTIONS);
  const afterFirst = host.configCalls;

  // 사용자가 플러그인에서 committer 를 직접 고친 직후를 흉내낸다.
  host.name = 'Bob';
  invalidateCommitterCache();
  await refreshAsync(OPTIONS);

  assert.ok(host.configCalls > afterFirst, '무효화 뒤에는 곧바로 다시 읽는다');
  assert.equal(state.committerName, 'Bob');
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
  // 실패한 조회는 캐시에 들어가지 않아야 한다 — 확인하려면 캐시를 먼저 만료시켜야 한다.
  __expireCommitterCache();
  await refreshAsync(OPTIONS);

  assert.equal(state.committerName, 'Alice');
  assert.equal(state.committerEmail, 'alice@example.com');
});
