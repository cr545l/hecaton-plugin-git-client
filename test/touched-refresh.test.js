// 스테이징·언스테이지 뒤의 갱신은 방금 git 에 넘긴 파일만 다시 읽는다.
//
// 배경: 무시 패턴 5,447개 워크트리에서 전체 status 는 3.1초(스테이징 직후 첫 조회는 8.3초)였고,
// Stage All 은 0.3초에 끝났는데 목록이 최종 모습이 되기까지 8.8초가 걸렸다(실측). 같은 82개
// 파일만 읽는 status 는 44ms 다. 폴더 항목(dir/)은 넘기지 않는다 — 폴더를 넘기면 git 이 그
// 안을 무시 패턴과 대조해 전체 조회만큼 걸린다(폴더 24개 3.9초).
// 감시 폴링이 읽은 status 출력이 지금 목록과 같으면 같은 status 를 다시 돌리지 않는다.
require('./helpers/git-mutation-host');
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
global.hecaton = {
  process: {
    exec: async ({ args, cwd }) => {
      commands.push(args);
      try { return { ok: true, exit_code: 0, stdout: git(cwd, ...args) }; }
      catch (e) { return { ok: true, exit_code: e.status || 1, stderr: String(e.stderr || e.message) }; }
    },
  },
  fs: {
    stat: async () => ({ ok: true, exists: false }),
    read_dir: async () => ({ ok: false }),
    read_file: async () => ({ content: '' }),
    write_file: async ({ path: target, content }) => { fs.writeFileSync(target, content); return { ok: true }; },
    delete: async ({ path: target }) => { fs.unlinkSync(target); return { ok: true }; },
  },
  window: { set_title: async () => ({ ok: true }) },
  terminal: {},
  initialState: { cols: 120, rows: 40 },
};

const { gitStatusPorcelain } = require('../git');
const expand = require('../untracked-expand');
const { stageTargets } = require('../stage-targets');
const { state } = require('../state');
const { refreshAsync, applyStageToState, statusOutputMatchesState } = require('../refresh');

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-touched-refresh-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('git-touched-refresh-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(root, 'config', k, v);
  fs.writeFileSync(path.join(root, '.gitignore'), 'evidence/**\n!evidence/**/\n!evidence/**/keep-*.txt\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function write(root, rel, content = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

async function loadStatus(cwd) {
  const snapshot = await gitStatusPorcelain(cwd, {});
  Object.assign(state, {
    cwd, loading: false, isGitRepo: true, error: null, spinnerActive: false, activeOps: [],
    staged: snapshot.staged, unstaged: snapshot.unstaged, untracked: snapshot.untracked, ignored: [],
    untrackedComplete: snapshot.untrackedComplete === true,
  });
}

const list = () => ({
  staged: state.staged.map(e => e.status + ' ' + e.file),
  unstaged: state.unstaged.map(e => e.status + ' ' + e.file),
  untracked: state.untracked.map(e => e.file),
});
const fullStatusRuns = () => commands.filter(args => args.includes('status') && !args.includes('--')).length;

test('after Stage All the refresh reads only the staged files and lists them one by one', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(cwd, 'other.txt'), 'two\n');
  write(cwd, 'evidence/run/keep-a.txt');
  write(cwd, 'evidence/run/deep/keep-b.txt');
  write(cwd, 'evidence/run/deep/noise.log');
  await loadStatus(cwd);
  assert.deepEqual(state.untracked.map(e => e.file), ['evidence/']);
  await expand.prefetch(cwd, ['evidence/']);

  const stageList = ['tracked.txt', 'evidence/'];
  const { err, expandedDirs, touched } = await stageTargets(cwd, stageList, 'stage failed');
  assert.equal(err, null);
  applyStageToState(stageList);
  commands.length = 0;
  await refreshAsync({ statusOnly: true, silent: true, paths: touched, dropEntries: expandedDirs });

  assert.equal(fullStatusRuns(), 0, 'no whole-repository status after the write: ' + JSON.stringify(commands));
  const pathStatus = commands.find(args => args.includes('status'));
  assert.ok(pathStatus && !pathStatus.slice(pathStatus.indexOf('--') + 1).some(p => p.endsWith('/')), 'no folder handed to the path status');
  assert.deepEqual(list(), {
    staged: ['A evidence/run/deep/keep-b.txt', 'A evidence/run/keep-a.txt', 'M tracked.txt'],
    unstaged: ['M other.txt'],
    untracked: [],
  });
  // 같은 저장소를 전체 status 로 읽은 것과 같아야 한다 — 감시 폴링이 같은 출력을 보면 다시 읽지 않는다.
  const raw = git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal');
  assert.equal(statusOutputMatchesState(raw), true);
});

// 실제 워크트리의 82개는 경로가 길어 명령줄 한 번에 실리지 않았고, 그래서 전체 status(3.2초)로
// 돌아갔다(실측). 스테이징처럼 나눠 읽는다.
test('touched paths too long for one command line are read in several path statuses', async t => {
  const cwd = repo(t);
  const deep = 'evidence/' + 'long-folder-name-for-a-real-evidence-tree/'.repeat(2);
  const files = Array.from({ length: 60 }, (_, i) => deep + 'keep-' + String(i).padStart(3, '0') + '-' + 'x'.repeat(20) + '.txt');
  for (const file of files) write(cwd, file);
  await loadStatus(cwd);
  git(cwd, 'add', '--', ...files);
  applyStageToState(['evidence/']);
  commands.length = 0;
  await refreshAsync({ statusOnly: true, silent: true, paths: files, dropEntries: ['evidence/'] });
  assert.equal(fullStatusRuns(), 0, 'no whole-repository status');
  assert.ok(commands.filter(args => args.includes('status')).length >= 2, 'split into several path statuses');
  assert.deepEqual(list(), { staged: files.map(f => 'A ' + f).sort(), unstaged: [], untracked: [] });
});

test('after unstaging, the refresh reads only those files and keeps the rest of the list', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(cwd, 'other.txt'), 'two\n');
  write(cwd, 'fresh.txt');
  git(cwd, 'add', 'tracked.txt', 'fresh.txt');
  await loadStatus(cwd);
  git(cwd, 'reset', '-q', '--', 'tracked.txt', 'fresh.txt');
  commands.length = 0;
  await refreshAsync({ statusOnly: true, silent: true, paths: ['tracked.txt', 'fresh.txt'] });
  assert.equal(fullStatusRuns(), 0);
  assert.deepEqual(list(), { staged: [], unstaged: ['M other.txt', 'M tracked.txt'], untracked: ['fresh.txt'] });
});

test('a folder entry among the touched paths falls back to the whole status', async t => {
  const cwd = repo(t);
  write(cwd, 'evidence/fresh/keep-a.txt');
  await loadStatus(cwd);
  git(cwd, 'add', '--', 'evidence/');
  commands.length = 0;
  await refreshAsync({ statusOnly: true, silent: true, paths: ['evidence/'] });
  // 폴더는 경로 status 로 읽지 않고, 다음 차례에 전체 status 를 다시 건다.
  assert.ok(!commands.some(args => args.includes('status') && args.includes('evidence/')), JSON.stringify(commands));
  for (let i = 0; i < 50 && fullStatusRuns() === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fullStatusRuns(), 1);
  for (let i = 0; i < 50 && state.staged.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(list().staged, ['A evidence/fresh/keep-a.txt']);
});

test('a polled status that differs from the list is not taken as a match', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  await loadStatus(cwd);
  const raw = git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal');
  assert.equal(statusOutputMatchesState(raw), true);
  write(cwd, 'new.txt');
  const changed = git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal');
  assert.equal(statusOutputMatchesState(changed), false);
  git(cwd, 'add', 'tracked.txt');
  const staged = git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal');
  assert.equal(statusOutputMatchesState(staged), false, 'the same file moving from unstaged to staged is a change');
});
