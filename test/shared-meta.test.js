// 같은 저장소의 워크트리마다 창을 하나씩 띄운 쓰임에서 메타 조회(stash·for-each-ref·remote·
// worktree list)와 config 조회를 저장소 단위로 한 번만 돌리는지 검증한다.
//
// 배경(2026-11-18 Com2uX 실측): 워크트리 30여 개에 창 14개가 떠 있었고, 한 워크트리의 커밋이
// 공용 refs 를 바꿀 때마다 모든 창이 같은 조회를 각자 돌렸다 — 메타 조회 1,356회가 실제로는
// 303번의 변경이었다. 결과는 어느 워크트리에서 읽어도 같고, 다른 것은 for-each-ref 의 현재
// 브랜치 표시(%(HEAD))와 worktree list 의 "현재 워크트리" 판정뿐이다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state } = require('../state');
const { refreshAsync } = require('../refresh');

const SEP = (process.platform === 'win32') ? '\\' : '/';
const MAIN = 'C:' + SEP + 'shared-repo';
const COMMON = MAIN + SEP + '.git';
const LINKED = 'C:' + SEP + 'shared-repo-wt';
const LINKED_GITDIR = COMMON + SEP + 'worktrees' + SEP + 'wt';

const HASH_MAIN = 'a'.repeat(40);
const HASH_FEATURE = 'b'.repeat(40);

function installHost() {
  const host = {
    calls: {},
    files: new Map(),
    refMtime: { main: 100, feature: 100 },
    refsOk: true,
    heads: { [COMMON]: 'ref: refs/heads/main\n', [LINKED_GITDIR]: 'ref: refs/heads/feature\n' },
  };
  const count = name => { host.calls[name] = (host.calls[name] || 0) + 1; };

  // for-each-ref 의 %(HEAD) 는 실행한 워크트리 기준이다 — 진짜 git 처럼 cwd 에 따라 다르게 낸다.
  const refsFor = cwd => {
    const current = cwd === LINKED ? 'feature' : 'main';
    const line = (name, hash) => (name === current ? '*' : ' ') + '\trefs/heads/' + name + '\torigin/' + name + '\t\t=\t' + hash;
    return [line('main', HASH_MAIN), line('feature', HASH_FEATURE), ' \trefs/remotes/origin/main\t\t\t\t' + HASH_MAIN].join('\n') + '\n';
  };
  const worktreeList = [
    'worktree ' + MAIN.replace(/\\/g, '/'), 'HEAD ' + HASH_MAIN, 'branch refs/heads/main', '',
    'worktree ' + LINKED.replace(/\\/g, '/'), 'HEAD ' + HASH_FEATURE, 'branch refs/heads/feature', '',
  ].join('\n');

  hecaton.process.exec = async ({ args, cwd }) => {
    const joined = args.join(' ');
    if (joined.includes('for-each-ref')) {
      count('for-each-ref');
      if (!host.refsOk) return { ok: false, exit_code: 128, stdout: '', stderr: 'fatal: cannot read refs' };
      return { ok: true, exit_code: 0, stdout: refsFor(cwd) };
    }
    if (joined.includes('worktree list')) { count('worktree'); return { ok: true, exit_code: 0, stdout: worktreeList }; }
    if (joined.includes('stash list')) { count('stash'); return { ok: true, exit_code: 0, stdout: '' }; }
    if (joined.endsWith(' remote')) { count('remote'); return { ok: true, exit_code: 0, stdout: 'origin\n' }; }
    if (joined.includes('^user')) {
      count('user-config');
      return { ok: true, exit_code: 0, stdout: 'global\tuser.name Tester\nglobal\tuser.email t@example.com\n' };
    }
    if (joined.includes('^gui')) { count('gui-config'); return { ok: false, exit_code: 1, stdout: '' }; }
    if (joined.includes('rev-list')) { count('rev-list'); return { ok: true, exit_code: 0, stdout: '0\t0\n' }; }
    count('other');
    return { ok: true, exit_code: 0, stdout: '' };
  };

  hecaton.fs.mkdir = async () => ({ ok: true });
  hecaton.fs.write_file = async ({ path, content }) => { host.files.set(path, content); return { ok: true }; };
  hecaton.fs.read_file = async ({ path }) => {
    if (host.files.has(path)) return { ok: true, content: host.files.get(path) };
    for (const [dir, head] of Object.entries(host.heads)) {
      if (path === dir + SEP + 'HEAD') return { ok: true, content: head };
    }
    return { ok: false };
  };
  hecaton.fs.stat = async ({ path }) => {
    if (/rebase-merge|rebase-apply|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index\.lock|config\.worktree/.test(path)) {
      return { exists: false };
    }
    if (host.files.has(path)) return { exists: true, mtime_ms: 1, size: host.files.get(path).length };
    return { exists: true, mtime_ms: 1000 };
  };
  hecaton.fs.read_dir = async ({ path }) => {
    if (path === COMMON + SEP + 'refs') return { ok: true, entries: [{ name: 'heads', is_dir: true }] };
    if (path === COMMON + SEP + 'refs' + SEP + 'heads') {
      return {
        ok: true,
        entries: [
          { name: 'main', is_dir: false, mtime_ms: host.refMtime.main, size_bytes: 41 },
          { name: 'feature', is_dir: false, mtime_ms: host.refMtime.feature, size_bytes: 41 },
        ],
      };
    }
    if (path === COMMON + SEP + 'worktrees') return { ok: true, entries: [{ name: 'wt', is_dir: true }] };
    return { ok: false };
  };
  hecaton.window.set_title = async () => ({ ok: true });
  return host;
}

// 창을 바꾸는 것을 흉내낸다 — 같은 프로세스라 메모리 캐시는 cwd 가 바뀌면 비워진다.
function openWindow(cwd, gitDir) {
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = gitDir;
  state.gitCommonDir = COMMON;
  state.spinnerActive = false;
  state.branch = '';
  state.branches = [];
  state.remoteBranches = [];
  state.remotes = [];
  state.stashes = [];
  state.worktrees = [];
  state.isLinkedWorktree = false;
  state.unstaged = [];
  state.operationState = null;
  state.rebaseMessage = '';
  state.error = null;
}

const OPTS = { metadataOnly: true, silent: true };
const META = ['for-each-ref', 'worktree', 'stash', 'remote'];
const metaCalls = host => META.map(name => host.calls[name] || 0);

test('한 창이 읽은 메타는 다른 워크트리 창이 git 없이 받아 쓴다', async () => {
  const host = installHost();
  openWindow(MAIN, COMMON);
  await refreshAsync(OPTS);
  assert.deepEqual(metaCalls(host), [1, 1, 1, 1]);
  assert.equal(state.branch, 'main');

  openWindow(LINKED, LINKED_GITDIR);
  await refreshAsync(OPTS);
  assert.deepEqual(metaCalls(host), [1, 1, 1, 1], '같은 저장소의 두 번째 창은 메타 조회를 다시 돌리지 않는다');
  assert.equal((host.calls['user-config'] || 0), 1, 'committer 설정도 다시 읽지 않는다');

  // 받아 쓴 목록이라도 현재 브랜치·현재 워크트리는 이 창 기준이어야 한다.
  assert.equal(state.branch, 'feature');
  assert.deepEqual(state.branches.filter(b => b.isCurrent).map(b => b.name), ['feature']);
  assert.deepEqual(state.branches.map(b => b.name), ['main', 'feature']);
  assert.deepEqual(state.remoteBranches, ['origin/main']);
  assert.deepEqual(state.remotes, ['origin']);
  assert.equal(state.worktrees.length, 2);
  assert.equal(state.worktrees.find(w => w.isCurrent).branch, 'feature');
  assert.equal(state.isLinkedWorktree, true);
});

test('공용 refs 가 바뀌면 받아 쓰지 않고 다시 읽는다', async () => {
  const host = installHost();
  openWindow(MAIN, COMMON);
  await refreshAsync(OPTS);

  host.refMtime.feature = 200; // 다른 워크트리에서 feature 에 커밋했다
  openWindow(LINKED, LINKED_GITDIR);
  await refreshAsync(OPTS);
  assert.deepEqual(metaCalls(host), [2, 2, 2, 2]);
});

test('분리된 HEAD 창은 받아 쓴 목록에서 어느 브랜치도 현재로 표시하지 않는다', async () => {
  const host = installHost();
  openWindow(MAIN, COMMON);
  await refreshAsync(OPTS);

  host.heads[LINKED_GITDIR] = HASH_FEATURE + '\n';
  openWindow(LINKED, LINKED_GITDIR);
  await refreshAsync(OPTS);
  assert.deepEqual(metaCalls(host), [1, 1, 1, 1]);
  assert.deepEqual(state.branches.filter(b => b.isCurrent), []);
});

test('실패가 섞인 조회는 저장하지 않아 다른 창이 직접 읽는다', async () => {
  const host = installHost();
  host.refsOk = false;
  openWindow(MAIN, COMMON);
  await refreshAsync(OPTS);

  host.refsOk = true;
  openWindow(LINKED, LINKED_GITDIR);
  await refreshAsync(OPTS);
  assert.equal(host.calls['for-each-ref'], 2, '실패를 받아 쓰면 브랜치 목록이 비어 보인다');
  assert.equal(state.branch, 'feature');
});

test('forceMeta 는 저장된 결과를 쓰지 않고 직접 읽는다', async () => {
  const host = installHost();
  openWindow(MAIN, COMMON);
  await refreshAsync(OPTS);

  openWindow(LINKED, LINKED_GITDIR);
  await refreshAsync({ ...OPTS, forceMeta: true });
  assert.deepEqual(metaCalls(host), [2, 2, 2, 2]);
});
