// for-each-ref(브랜치/원격 목록)나 worktree list 조회가 일시적으로 실패했을 때
// 목록이 통째로 사라지지 않는지 검증한다.
//
// 배경: gitExec은 실패를 빈 출력으로 뭉갠다. 예전 코드는 그 빈 결과를 그대로 파싱해
// state.branches를 []로 덮어쓰고, 심지어 그 빈 결과를 메타 캐시에 저장했다.
// 캐시는 .git 내부 mtime 지문이 바뀔 때까지 유지되므로, 한 번 실패하면 브랜치가
// 한참 동안 안 보이고 현재 브랜치도 'HEAD (detached)'로 잘못 표시됐다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state } = require('../state');
const { refreshAsync } = require('../refresh');

const SEP = (process.platform === 'win32') ? '\\' : '/';

// for-each-ref --format='%(HEAD)\t%(refname)\t%(upstream:short)\t%(upstream:track)\t%(upstream:trackshort)'
// 브랜치별 추적 상태(ahead/behind/gone)는 이 한 번의 조회에서 함께 받는다 — Pinned 목록과
// 힌트바가 현재 브랜치가 아닌 브랜치에도 push/pull 대기 수를 보여주는 근거다.
const REFS_RAW = [
  '*\trefs/heads/work5\torigin/work5\t[ahead 2]\t>',
  '\trefs/heads/dev\torigin/dev\t[ahead 1, behind 4]\t<>',
  '\trefs/heads/stale\torigin/stale\t[gone]\t',
  '\trefs/heads/solo\t\t\t',
  '\trefs/remotes/origin/dev\t\t\t',
  '\trefs/remotes/origin/HEAD\t\t\t',
].join('\n') + '\n';

function worktreeRaw(cwd) {
  return [
    'worktree ' + cwd,
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/work5',
    '',
    'worktree ' + cwd + '-linked',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/dev',
    '',
  ].join('\n');
}

// refs/worktrees 조회 성공 여부를 런타임에 바꿀 수 있는 호스트 목.
// refreshAsync를 두 번 돌려 "실패 → 성공" 복구를 검증하기 위해서다.
function installHost(cwd) {
  // mtime은 메타 캐시 지문의 재료다. 값을 바꾸면 캐시 미스가 나 git을 실제로 다시 호출한다
  // — 조회 실패는 캐시가 미스일 때만 일어나므로, 실패 시나리오에는 이 조작이 필요하다.
  const host = { refsOk: true, remoteOk: true, worktreeOk: true, refsCalls: 0, remoteCalls: 0, mtime: 1000 };

  hecaton.process.exec = async ({ args }) => {
    const joined = args.join(' ');
    if (joined.includes('for-each-ref')) {
      host.refsCalls++;
      if (!host.refsOk) return { ok: false, stdout: '', stderr: 'error: could not read refs', exit_code: 128 };
      return { ok: true, stdout: REFS_RAW };
    }
    if (joined.includes('worktree list')) {
      if (!host.worktreeOk) return { ok: false, stdout: '', stderr: 'fatal: not a git repository', exit_code: 128 };
      return { ok: true, stdout: worktreeRaw(cwd) };
    }
    if (joined.includes('stash list')) return { ok: true, stdout: '' };
    if (joined.endsWith('remote')) {
      host.remoteCalls++;
      if (!host.remoteOk) return { ok: false, stdout: '', stderr: 'temporary remote read failure', exit_code: 128 };
      return { ok: true, stdout: 'origin\n' };
    }
    if (joined.includes('user.')) return { ok: true, stdout: 'user.name tester\nuser.email t@example.com\n' };
    if (joined.includes('rev-list')) return { ok: true, stdout: '0\t0\n' };
    return { ok: true, stdout: '' };
  };

  // fingerprint 대상은 고정 mtime, 진행 중 작업(rebase/merge/...) 표식은 모두 없음.
  hecaton.fs.stat = async ({ path }) => {
    if (/rebase-merge|rebase-apply|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index\.lock/.test(path)) {
      return { exists: false };
    }
    return { exists: true, mtime_ms: host.mtime };
  };

  const refsDir = cwd + SEP + '.git' + SEP + 'refs';
  const tree = {
    [refsDir]: [{ name: 'heads', is_dir: true }],
    [refsDir + SEP + 'heads']: [{ name: 'work5', is_dir: false, mtime_ms: 100, size_bytes: 41 }],
  };
  hecaton.fs.read_dir = async ({ path }) => {
    const entries = tree[path];
    return entries ? { ok: true, entries } : { ok: false };
  };

  hecaton.fs.read_file = async ({ path }) => {
    if (path.endsWith('HEAD')) return { content: 'ref: refs/heads/work5\n' };
    return { content: '' };
  };

  hecaton.window.set_title = async () => ({ ok: true });

  return host;
}

// 캐시(_metaCache)는 모듈 전역이고 cwd가 바뀌면 무효화된다 — 테스트마다 다른 cwd로 격리한다.
function resetState(cwd) {
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = cwd + SEP + '.git';
  state.gitCommonDir = cwd + SEP + '.git';
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

test('조회에 성공하면 브랜치/원격/워크트리를 채운다', async () => {
  const cwd = 'C:/repo-ok';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTS);

  assert.deepEqual(state.branches.map(b => b.name), ['work5', 'dev', 'stale', 'solo']);
  assert.deepEqual(state.remoteBranches, ['origin/dev']);   // origin/HEAD는 제외
  assert.deepEqual(state.remotes, ['origin']);
  assert.equal(state.branch, 'work5');
  assert.equal(state.worktrees.length, 2);
  assert.equal(host.refsCalls, 1);
});

test('브랜치별 ahead/behind/gone을 같은 조회에서 받아 둔다', async () => {
  const cwd = 'C:/repo-track';
  installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTS);
  const by = name => state.branches.find(b => b.name === name);

  assert.deepEqual(
    { ahead: by('work5').ahead, behind: by('work5').behind, upstreamGone: by('work5').upstreamGone },
    { ahead: 2, behind: 0, upstreamGone: false });
  assert.deepEqual(
    { ahead: by('dev').ahead, behind: by('dev').behind, upstreamGone: by('dev').upstreamGone },
    { ahead: 1, behind: 4, upstreamGone: false },
    '현재 브랜치가 아니어도 대기 수를 알아야 한다');
  assert.equal(by('stale').upstreamGone, true, '원격에서 사라진 upstream');
  assert.deepEqual(
    { ahead: by('solo').ahead, behind: by('solo').behind, upstreamGone: by('solo').upstreamGone },
    { ahead: 0, behind: 0, upstreamGone: false },
    'upstream이 없으면 비교 기준이 없다');
});

test('for-each-ref가 실패해도 기존 브랜치 목록을 지우지 않는다', async () => {
  const cwd = 'C:/repo-keep';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTS);
  assert.equal(state.branches.length, 4);

  host.refsOk = false;
  host.mtime = 2000;   // .git이 바뀌어 캐시 미스 → 실제로 for-each-ref를 다시 호출한다
  await refreshAsync(OPTS);

  assert.equal(host.refsCalls, 2, '캐시 미스라 재조회해야 실패 경로를 탄다');
  assert.deepEqual(state.branches.map(b => b.name), ['work5', 'dev', 'stale', 'solo']);
  assert.deepEqual(state.remoteBranches, ['origin/dev']);
  assert.equal(state.branch, 'work5', 'detached로 잘못 표시하면 안 된다');
});

test('for-each-ref 실패 결과는 캐시하지 않아 다음 refresh에서 복구된다', async () => {
  const cwd = 'C:/repo-recover';
  const host = installHost(cwd);
  resetState(cwd);

  // 첫 refresh부터 실패 — 캐시에 빈 결과가 남으면 지문이 그대로인 한 영영 복구되지 않는다.
  host.refsOk = false;
  await refreshAsync(OPTS);
  assert.equal(state.branches.length, 0);
  assert.equal(state.branch, 'work5', '.git/HEAD 폴백으로 현재 브랜치는 유지한다');

  // 지문(.git mtime)은 그대로 둔 채 git 호출만 복구시킨다.
  host.refsOk = true;
  await refreshAsync(OPTS);

  assert.equal(host.refsCalls, 2, '실패분이 캐시됐다면 재조회하지 않는다');
  assert.deepEqual(state.branches.map(b => b.name), ['work5', 'dev', 'stale', 'solo']);
});

test('remote 조회가 일시 실패해도 기존 목록을 지우거나 실패 결과를 캐시하지 않는다', async () => {
  const cwd = 'C:/remote-keep';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTS);
  assert.deepEqual(state.remotes, ['origin']);
  assert.equal(host.remoteCalls, 1);

  host.remoteOk = false;
  host.mtime = 2000;   // 캐시 미스 → remote 조회와 즉시 재시도가 모두 실패
  await refreshAsync(OPTS);

  assert.equal(host.remoteCalls, 3);
  assert.deepEqual(state.remotes, ['origin'], '조회 실패를 리모트 0개로 오인하면 안 된다');

  host.remoteOk = true;
  await refreshAsync(OPTS);

  assert.equal(host.remoteCalls, 4, '실패 결과가 캐시됐다면 같은 지문에서 다시 조회하지 않는다');
  assert.deepEqual(state.remotes, ['origin']);
});

test('worktree list가 실패해도 기존 워크트리 목록을 지우지 않는다', async () => {
  const cwd = 'C:/repo-wt';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTS);
  assert.equal(state.worktrees.length, 2);

  host.worktreeOk = false;
  host.mtime = 2000;   // 캐시 미스를 만들어 worktree list를 실제로 다시 호출시킨다
  await refreshAsync(OPTS);

  assert.equal(state.worktrees.length, 2);
});

test('조회에 성공하면 지문이 같은 다음 refresh는 캐시를 쓴다', async () => {
  const cwd = 'C:/repo-cache';
  const host = installHost(cwd);
  resetState(cwd);

  await refreshAsync(OPTS);
  await refreshAsync(OPTS);

  assert.equal(host.refsCalls, 1, '성공 결과는 지문이 같은 동안 재사용해야 한다');
  assert.equal(state.branches.length, 4);
});
