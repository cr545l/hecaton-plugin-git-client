// 저장소 단위 메타 캐시 — 창이 새로 떠도, 같은 저장소의 다른 워크트리를 열어도
// stash·for-each-ref·remote·worktree·ahead-behind 를 다시 읽지 않는다.
//
// 배경: 메타 캐시가 창의 메모리에만 있어, 호스트를 다시 띄우면 창 열 개가 같은 1초에 이
// 다섯을 각자 띄웠다(2026-11-12 실측: 동시 실행 최대 58개, 60~90ms 짜리 명령이 건당 1초 안팎).
// 다섯 가운데 창마다 다른 것은 "현재"(현재 브랜치 표시, 현재 워크트리, 현재 브랜치의
// ahead/behind)뿐이라, 나머지는 .git 아래 파일 하나로 나눠 쓰고 "현재"만 창이 다시 붙인다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const commands = [];
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
// 실제 디스크를 보는 호스트 대역 — 지문이 진짜 .git 의 변화를 따라가야 한다.
global.hecaton = {
  process: {
    exec: async ({ args, cwd }) => {
      commands.push(args);
      try { return { ok: true, exit_code: 0, stdout: git(cwd, ...args) }; }
      catch (e) { return { ok: true, exit_code: e.status || 1, stdout: '', stderr: String(e.stderr || e.message) }; }
    },
  },
  fs: {
    stat: async ({ path: target }) => {
      try {
        const st = fs.statSync(target);
        return { ok: true, exists: true, is_dir: st.isDirectory(), mtime_ms: st.mtimeMs, size_bytes: st.size };
      } catch { return { ok: true, exists: false }; }
    },
    read_dir: async ({ path: target }) => {
      try {
        return { ok: true, entries: fs.readdirSync(target, { withFileTypes: true }).map(entry => {
          const st = fs.statSync(path.join(target, entry.name));
          return { name: entry.name, is_dir: entry.isDirectory(), mtime_ms: st.mtimeMs, size_bytes: st.size };
        }) };
      } catch { return { ok: false }; }
    },
    read_file: async ({ path: target }) => {
      try { return { ok: true, content: fs.readFileSync(target, 'utf8') }; } catch { return { ok: false, content: '' }; }
    },
    write_file: async ({ path: target, content }) => { fs.writeFileSync(target, content); return { ok: true }; },
    mkdir: async ({ path: target }) => { fs.mkdirSync(target, { recursive: true }); return { ok: true }; },
  },
  window: { set_title: async () => ({ ok: true }) },
  terminal: {},
  initialState: { cols: 120, rows: 40 },
};

const pluginRoot = path.resolve(__dirname, '..');

// 새로 뜬 창 — 모듈 상태(창의 메모리 캐시)가 전부 비어 있다. 디스크의 공유 파일만 남는다.
function newWindow(cwd, gitDir, commonDir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(pluginRoot) && !key.includes(path.sep + 'test' + path.sep)) delete require.cache[key];
  }
  const { state } = require('../state');
  const refresh = require('../refresh');
  require('../coordinate').configure(commonDir, cwd);
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = gitDir;
  state.gitCommonDir = commonDir;
  state.mode = 'normal';
  return { state, refresh };
}

function repo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-meta-shared-'));
  t.after(() => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('git-meta-shared-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', root);
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(root, 'config', k, v);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { base, root, gitDir: path.join(root, '.git') };
}

const META = ['stash', 'for-each-ref', 'remote', 'worktree'];
const metaRuns = () => commands.filter(args => META.some(name => args.includes(name))).map(args => META.find(name => args.includes(name)));
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function refreshMeta(win, options = {}) {
  commands.length = 0;
  await win.refresh.refreshAsync({ metadataOnly: true, silent: true, ...options });
  await settle(); // 공유 파일 쓰기는 기다리지 않고 던진다
  return metaRuns();
}

test('a newly opened window takes the repository metadata from the shared cache', async t => {
  const { root, gitDir } = repo(t);
  // 로컬 커밋 하나 — 현재 브랜치가 upstream 보다 1 앞선다.
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  git(root, 'commit', '-q', '-am', 'local');
  git(root, 'branch', 'feature/x');
  fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');
  git(root, 'stash', 'push', '-q', '--include-untracked');

  const first = newWindow(root, gitDir, gitDir);
  assert.deepEqual((await refreshMeta(first)).sort(), [...META].sort(), 'the first window reads everything once');
  const expected = {
    branch: first.state.branch,
    branches: first.state.branches.map(b => ({ ...b })),
    remoteBranches: [...first.state.remoteBranches],
    remotes: [...first.state.remotes],
    stashes: first.state.stashes.map(s => ({ ...s })),
    worktrees: first.state.worktrees.map(w => ({ ...w })),
    ahead: first.state.ahead, behind: first.state.behind,
  };
  assert.equal(expected.branch, 'main');
  assert.equal(expected.ahead, 1);
  assert.equal(expected.stashes.length, 1);
  assert.ok(fs.existsSync(path.join(gitDir, 'hecaton-git-client', 'metacache.json')));

  const second = newWindow(root, gitDir, gitDir);
  assert.deepEqual(await refreshMeta(second), [], 'no metadata query in the new window');
  assert.deepEqual({
    branch: second.state.branch,
    branches: second.state.branches,
    remoteBranches: second.state.remoteBranches,
    remotes: second.state.remotes,
    stashes: second.state.stashes,
    worktrees: second.state.worktrees,
    ahead: second.state.ahead, behind: second.state.behind,
  }, expected);
  // 그 뒤로는 이 창의 메모리 캐시가 맡는다.
  assert.deepEqual(await refreshMeta(second), []);
});

test('a window on a linked worktree reuses the cache with its own branch and worktree marked current', async t => {
  const { base, root, gitDir } = repo(t);
  const linked = path.join(base, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'topic', linked);

  const main = newWindow(root, gitDir, gitDir);
  await refreshMeta(main);
  assert.equal(main.state.branch, 'main');
  assert.equal(main.state.isLinkedWorktree, false);

  const linkedGitDir = path.join(gitDir, 'worktrees', 'linked');
  const other = newWindow(linked, linkedGitDir, gitDir);
  // topic 은 upstream 이 없다 — 같은 이름의 원격 브랜치도 없으니 ahead/behind 조회도 없다.
  assert.deepEqual(await refreshMeta(other), []);
  assert.equal(other.state.branch, 'topic');
  assert.deepEqual(other.state.branches.filter(b => b.isCurrent).map(b => b.name), ['topic']);
  assert.equal(other.state.isLinkedWorktree, true);
  assert.deepEqual(other.state.worktrees.filter(w => w.isCurrent).map(w => path.basename(w.path)), ['linked']);
  assert.equal(other.state.ahead, 0);
  assert.equal(other.state.behind, 0);
});

test('a change in the repository is read again and replaces the shared cache', async t => {
  const { root, gitDir } = repo(t);
  const first = newWindow(root, gitDir, gitDir);
  await refreshMeta(first);

  git(root, 'branch', 'later');
  const second = newWindow(root, gitDir, gitDir);
  const runs = await refreshMeta(second);
  assert.ok(runs.includes('for-each-ref'), 'the stale cache is not used: ' + JSON.stringify(runs));
  assert.ok(second.state.branches.some(b => b.name === 'later'));

  // 방금 다시 읽은 결과가 공유 캐시가 됐다.
  const third = newWindow(root, gitDir, gitDir);
  assert.deepEqual(await refreshMeta(third), []);
  assert.ok(third.state.branches.some(b => b.name === 'later'));
});

test('forceMeta bypasses the shared cache; a detached HEAD has no current branch', async t => {
  const { root, gitDir } = repo(t);
  const first = newWindow(root, gitDir, gitDir);
  await refreshMeta(first);

  const forced = newWindow(root, gitDir, gitDir);
  assert.ok((await refreshMeta(forced, { forceMeta: true })).includes('for-each-ref'));

  git(root, 'checkout', '-q', '--detach');
  const before = newWindow(root, gitDir, gitDir);
  await refreshMeta(before); // HEAD 가 바뀌었으니 다시 읽고 공유 캐시를 갈아 끼운다
  const detached = newWindow(root, gitDir, gitDir);
  assert.deepEqual(await refreshMeta(detached), []);
  assert.deepEqual(detached.state.branches.filter(b => b.isCurrent), []);
  assert.equal(detached.state.ahead, 0);
});

// 창이 뜰 때마다 rev-parse 를 띄우지 않도록 공용 git dir 을 디스크에서 구한다. git 이 답하는
// 것과 같아야 한다.
test('the common git dir read from disk matches what git reports', async t => {
  const { base, root, gitDir } = repo(t);
  const linked = path.join(base, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'topic', linked);
  const { commonDirFromDisk } = require('../git');
  const same = (a, b) => assert.equal(fs.realpathSync(a).toLowerCase(), fs.realpathSync(b).toLowerCase());
  const reported = cwd => path.resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir').trim());

  same(await commonDirFromDisk(gitDir), reported(root));
  same(await commonDirFromDisk(path.join(gitDir, 'worktrees', 'linked')), reported(linked));
  // 판단할 수 없으면 '' — 호출부가 rev-parse 로 넘어간다.
  assert.equal(await commonDirFromDisk(''), '');
  fs.writeFileSync(path.join(gitDir, 'worktrees', 'linked', 'commondir'), '../../missing' + String.fromCharCode(10));
  assert.equal(await commonDirFromDisk(path.join(gitDir, 'worktrees', 'linked')), '');
});
