// 현재 브랜치의 ahead/behind 를 for-each-ref 의 %(upstream:track) 에서 읽는지 검증한다.
//
// 배경(2026-11-18 Com2uX 실측): refresh 마다 `rev-list --left-right --count @{u}...HEAD` 를 따로
// 띄웠는데, upstream 이 있으면 같은 refresh 의 for-each-ref 가 이미 같은 값을 냈고, 없으면 그
// 명령은 실패(exit 128)만 했다 — 1,363회 중 66% 가 실패였다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state } = require('../state');
const { refreshAsync } = require('../refresh');

const SEP = (process.platform === 'win32') ? '\\' : '/';
const HASH = 'a'.repeat(40);

function installHost(cwd, refsRaw) {
  const host = { refsRaw, refsOk: true, revListArgs: [], mtime: 1000 };
  hecaton.process.exec = async ({ args }) => {
    const joined = args.join(' ');
    if (joined.includes('for-each-ref')) {
      if (!host.refsOk) return { ok: false, exit_code: 128, stdout: '', stderr: 'fatal: cannot read refs' };
      return { ok: true, exit_code: 0, stdout: host.refsRaw };
    }
    if (joined.includes('worktree list')) {
      return { ok: true, exit_code: 0, stdout: 'worktree ' + cwd + '\nHEAD ' + HASH + '\nbranch refs/heads/work\n' };
    }
    if (joined.includes('stash list')) return { ok: true, exit_code: 0, stdout: '' };
    if (joined.endsWith(' remote')) return { ok: true, exit_code: 0, stdout: 'origin\n' };
    if (joined.includes('user.')) return { ok: true, exit_code: 0, stdout: 'global\tuser.name T\n' };
    if (joined.includes('rev-list')) {
      host.revListArgs.push(args[args.length - 1]);
      return { ok: true, exit_code: 0, stdout: '3\t1\n' };
    }
    return { ok: true, exit_code: 0, stdout: '' };
  };
  hecaton.fs.stat = async ({ path }) => {
    if (/rebase-merge|rebase-apply|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index\.lock/.test(path)) return { exists: false };
    return { exists: true, mtime_ms: host.mtime };
  };
  const refsDir = cwd + SEP + '.git' + SEP + 'refs';
  hecaton.fs.read_dir = async ({ path }) => {
    if (path === refsDir) return { ok: true, entries: [{ name: 'heads', is_dir: true }] };
    if (path === refsDir + SEP + 'heads') return { ok: true, entries: [{ name: 'work', is_dir: false, mtime_ms: 100, size_bytes: 41 }] };
    return { ok: false };
  };
  hecaton.fs.read_file = async ({ path }) => (path.endsWith('HEAD') ? { content: 'ref: refs/heads/work\n' } : { content: '' });
  hecaton.window.set_title = async () => ({ ok: true });
  return host;
}

function resetState(cwd) {
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = cwd + SEP + '.git';
  state.gitCommonDir = state.gitDir;
  state.spinnerActive = false;
  state.branch = '';
  state.branches = [];
  state.remoteBranches = [];
  state.remotes = [];
  state.stashes = [];
  state.worktrees = [];
  state.unstaged = [];
  state.operationState = null;
  state.rebaseMessage = '';
  state.error = null;
  state.ahead = 0;
  state.behind = 0;
}

const OPTS = { metadataOnly: true, silent: true };

test('upstream 이 있으면 for-each-ref 의 추적 값을 쓰고 rev-list 를 띄우지 않는다', async () => {
  const cwd = 'C:/ahead-upstream';
  const host = installHost(cwd, '*\trefs/heads/work\torigin/work\t[ahead 2, behind 5]\t<>\t' + HASH + '\n');
  resetState(cwd);
  await refreshAsync(OPTS);
  assert.deepEqual({ ahead: state.ahead, behind: state.behind }, { ahead: 2, behind: 5 });
  assert.deepEqual(host.revListArgs, []);
});

test('upstream 이 사라졌으면(gone) 0 으로 두고 rev-list 를 띄우지 않는다', async () => {
  const cwd = 'C:/ahead-gone';
  const host = installHost(cwd, '*\trefs/heads/work\torigin/work\t[gone]\t\t' + HASH + '\n');
  resetState(cwd);
  state.ahead = 9;
  await refreshAsync(OPTS);
  assert.deepEqual({ ahead: state.ahead, behind: state.behind }, { ahead: 0, behind: 0 });
  assert.deepEqual(host.revListArgs, []);
});

test('upstream 도 같은 이름의 원격 브랜치도 없으면 0 이고 rev-list 를 띄우지 않는다', async () => {
  const cwd = 'C:/ahead-local';
  const host = installHost(cwd, '*\trefs/heads/work\t\t\t\t' + HASH + '\n');
  resetState(cwd);
  state.ahead = 9;
  await refreshAsync(OPTS);
  assert.deepEqual({ ahead: state.ahead, behind: state.behind }, { ahead: 0, behind: 0 });
  assert.deepEqual(host.revListArgs, [], '예전에는 여기서 @{u} 조회가 exit 128 로 실패했다');
});

test('upstream 이 없어도 같은 이름의 원격 브랜치가 있으면 그것과 비교하고, 같은 지문 동안 다시 띄우지 않는다', async () => {
  const cwd = 'C:/ahead-fallback';
  const host = installHost(cwd, [
    '*\trefs/heads/work\t\t\t\t' + HASH,
    ' \trefs/remotes/origin/work\t\t\t\t' + HASH,
  ].join('\n') + '\n');
  resetState(cwd);
  await refreshAsync(OPTS);
  assert.deepEqual(host.revListArgs, ['refs/remotes/origin/work...HEAD']);
  assert.deepEqual({ ahead: state.ahead, behind: state.behind }, { ahead: 1, behind: 3 });

  await refreshAsync(OPTS);
  assert.equal(host.revListArgs.length, 1, '메타 캐시 적중 중에는 보조 조회 결과를 다시 쓴다');
  assert.deepEqual({ ahead: state.ahead, behind: state.behind }, { ahead: 1, behind: 3 });

  host.mtime = 2000; // .git 이 바뀌었다 — 다시 센다
  await refreshAsync(OPTS);
  assert.equal(host.revListArgs.length, 2);
});

test('refs 조회가 실패하면 화살표를 0 으로 지우지 않는다', async () => {
  const cwd = 'C:/ahead-refs-fail';
  const host = installHost(cwd, '*\trefs/heads/work\torigin/work\t[ahead 2]\t>\t' + HASH + '\n');
  resetState(cwd);
  await refreshAsync(OPTS);
  assert.equal(state.ahead, 2);

  host.refsOk = false;
  host.mtime = 2000;
  await refreshAsync(OPTS);
  assert.deepEqual({ ahead: state.ahead, behind: state.behind }, { ahead: 2, behind: 0 });
  assert.deepEqual(host.revListArgs, []);
});
