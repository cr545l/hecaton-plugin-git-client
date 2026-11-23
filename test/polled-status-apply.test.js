// 감시 폴링이 읽어 온 status 출력은 목록에 그대로 적용한다 — 같은 status 를 창이 또 띄우지 않는다.
//
// 배경: 밖에서 파일이 바뀌면 폴링(서비스)이 status 를 한 번 돌려 "바뀌었다"를 알리고, 창이 같은
// status 를 다시 돌렸다. 창이 열 개면 변경 한 번에 git 이 열 개 더 떴다. 폴링 결과에는 이미
// status 출력이 들어 있다.
// 다만 서비스는 대기 구간에 직전 결과를 다시 내주므로, 받은 출력이 지금 목록보다 새것일 때만
// 쓴다 — 조회가 시작된 시각이 마지막 목록 적용·마지막 쓰기보다 늦어야 한다.
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
  },
  window: { set_title: async () => ({ ok: true }) },
  terminal: {},
  initialState: { cols: 120, rows: 40 },
};

const gitProcess = require('../git-process');
const { state } = require('../state');
const { refreshAsync, applyPolledStatus, applyStageToState } = require('../refresh');

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-polled-status-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('git-polled-status-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(root, 'config', k, v);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

const polled = cwd => git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal');
const statusRuns = () => commands.filter(args => args.includes('status')).length;
const list = () => ({
  staged: state.staged.map(e => e.status + ' ' + e.file).sort(),
  unstaged: state.unstaged.map(e => e.status + ' ' + e.file).sort(),
  untracked: state.untracked.map(e => e.file).sort(),
});
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function open(cwd) {
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = path.join(cwd, '.git');
  state.gitCommonDir = state.gitDir;
  state.mode = 'normal';
  // 전체 refresh — 표시 설정(gui.*)을 이 저장소 기준으로 읽어 둔다. 설정을 모르는 동안은
  // 폴링 출력을 바로 쓰지 않는다(추적 안 된 파일 표시 여부를 모른다).
  await refreshAsync({ silent: true });
  await tick();
}

test('an outside change read by the poll reaches the list without another status', async t => {
  const cwd = repo(t);
  await open(cwd);
  assert.deepEqual(list(), { staged: [], unstaged: [], untracked: [] });

  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(cwd, 'fresh.txt'), 'new\n');
  const startedAt = Date.now();
  const raw = polled(cwd);
  commands.length = 0;
  assert.equal(applyPolledStatus(raw, startedAt), true);
  assert.equal(statusRuns(), 0, 'the list was updated from the polled output: ' + JSON.stringify(commands));
  assert.deepEqual(list(), { staged: [], unstaged: ['M tracked.txt'], untracked: ['fresh.txt'] });
  assert.equal(state.untrackedComplete, true);
});

test('a polled status that started before the list was last updated is not applied', async t => {
  const cwd = repo(t);
  const beforeOpen = Date.now() - 1;
  const stale = polled(cwd); // 변경 전의 출력 — 서비스가 대기 구간에 다시 내준 직전 결과에 해당한다.
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  await open(cwd);
  assert.deepEqual(list().unstaged, ['M tracked.txt']);
  assert.equal(applyPolledStatus(stale, beforeOpen), false);
  assert.deepEqual(list().unstaged, ['M tracked.txt'], 'the newer list stays');
  // 같은 출력이라도 목록보다 늦게 시작한 조회라면 적용된다 — 막은 이유는 시각뿐이다.
  await tick();
  assert.equal(applyPolledStatus(polled(cwd), Date.now()), true);
  // 조회 시각을 모르는 출력(이전 버전 서비스·공유 파일)도 바로 쓰지 않는다.
  assert.equal(applyPolledStatus(stale, 0), false);
  assert.equal(applyPolledStatus(stale, undefined), false);
});

test('a polled status that started before this window finished a write is not applied', async t => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'two\n');
  await open(cwd);
  await tick();
  const startedAt = Date.now();
  const beforeStage = polled(cwd);
  // 이 창의 쓰기. 스트리밍을 못 쓰는 테스트 호스트라 명령은 실패로 끝나지만, 쓰기가 끝난
  // 시각은 그대로 기록된다 — 여기서 보려는 것은 그 시각과의 비교다.
  git(cwd, 'add', '--', 'tracked.txt');
  applyStageToState(['tracked.txt']);
  await tick();
  await gitProcess.run({ program: 'git', args: ['add', '--', 'tracked.txt'], cwd });
  assert.ok(gitProcess.lastWriteDoneAt() > startedAt);
  assert.equal(applyPolledStatus(beforeStage, startedAt), false);
  assert.deepEqual(list().staged, ['M tracked.txt'], 'the staged file is not thrown back to unstaged');

  // 쓰기 뒤에 시작한 조회는 적용된다.
  await tick();
  const later = Date.now();
  assert.equal(applyPolledStatus(polled(cwd), later), true);
  assert.deepEqual(list(), { staged: ['M tracked.txt'], unstaged: [], untracked: [] });
});

test('nothing is applied while a write is still running', async t => {
  const cwd = repo(t);
  await open(cwd);
  await tick();
  fs.writeFileSync(path.join(cwd, 'other.txt'), 'two\n');
  let release;
  const original = hecaton.process.spawn;
  const onOriginal = hecaton.on;
  // spawn 응답이 돌아오지 않는 동안은 쓰기가 진행 중이다.
  hecaton.on = () => {};
  hecaton.process.spawn = () => new Promise(resolve => { release = () => resolve({ ok: false, error: 'stopped' }); });
  t.after(() => { hecaton.process.spawn = original; hecaton.on = onOriginal; });
  const write = gitProcess.run({ program: 'git', args: ['add', '--', 'other.txt'], cwd });
  await tick();
  assert.equal(gitProcess.writesInFlight(), 1);
  assert.equal(applyPolledStatus(polled(cwd), Date.now()), false);
  release();
  await write;
  assert.equal(gitProcess.writesInFlight(), 0);
});
