// 체크아웃하지 않은 브랜치를 upstream까지 끌어올리는 동작 검증 — 실제 git을 돌린다.
//
// 배경: 브랜치 메뉴의 Pull / Fast-Forward는 `git pull <remote> <branch>` /
// `git merge --ff-only <upstream>`을 쓰고 있었다. 두 명령 모두 결과가 HEAD로 들어가므로,
// 우클릭한 브랜치가 체크아웃 상태가 아니면 엉뚱하게 현재 브랜치를 건드린다.
// 게다가 현재 브랜치가 이미 그 커밋들을 담고 있으면 git은 'Already up to date'로
// 종료 코드 0을 돌려주기 때문에, 화면에는 에러도 변화도 없이 pull 대기 수만 그대로 남았다.
// (실제 사례: dev가 175 behind인데 Pull을 눌러도 아무 일도 일어나지 않음.)
//
// 인자 문자열 검사로는 이 상황을 재현할 수 없어 bare 원격을 만들어 실제 ref 이동을 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 실행된 git 명령을 기록하면서 실제로 돌린다.
const execLog = [];

global.hecaton = {
  terminal: {},
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  process: {
    exec: async ({ program, args, cwd }) => {
      execLog.push(args.join(' '));
      try {
        const stdout = execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, exit_code: 0, stdout, stderr: '' };
      } catch (e) {
        return {
          ok: false,
          exit_code: typeof e.status === 'number' ? e.status : 1,
          stdout: e.stdout || '',
          stderr: e.stderr || '',
          error: String(e.message),
        };
      }
    },
  },
  // afterGitOp이 백그라운드 refresh와 render를 부르므로 최소한만 채워 준다.
  fs: {
    stat: async () => ({ exists: false }),
    read_dir: async () => ({ ok: false }),
    read_file: async () => ({ content: '' }),
  },
  window: { set_title: async () => ({ ok: true }) },
  scroll: {
    region: async () => ({ ok: true }),
    set: async () => ({}),
    remove: async () => ({}),
  },
};

const { releaseSpinner, isSpinning } = require('../spinner');

// afterGitOp은 백그라운드 refresh를 띄우고, 그 동안 80ms 스피너 타이머가 이벤트 루프를
// 붙잡는다(그대로 두면 테스트 러너가 끝나지 않는다). 끝날 때까지 돌려 보내고 정리한다.
async function settle() {
  for (let i = 0; i < 200 && isSpinning(); i++) await new Promise(r => setImmediate(r));
  while (isSpinning()) releaseSpinner();
}

// render()가 그리는 화면은 여기서 볼 일이 없다. stdout을 전역으로 바꾸면 테스트 러너의
// 출력까지 삼키므로, 터미널로 나가는 이스케이프 시퀀스만 버리고 나머지는 통과시킨다.
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('\x1b[')) return true;
  return _origWrite(chunk, ...rest);
};

const { gitPullFromRemoteAsync, gitFetchIntoBranchAsync } = require('../git');
const { state, ui } = require('../state');
const { buildBranchContextMenuItems, handleContextMenuAction, handleDialogResult } = require('../context-menu');

// 다이얼로그 호출을 가로채 무엇을 물었는지 본다.
const dialogs = [];
hecaton.dialog = { show: (opts) => { dialogs.push(opts); return Promise.resolve({}); } };
hecaton.menu = { show: () => Promise.resolve({}) };

const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sha(cwd, ref) {
  return git(cwd, 'rev-parse', ref).trim();
}

function commit(repo, text) {
  fs.writeFileSync(path.join(repo, 'a.txt'), text + '\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-m', text);
}

// 문제 상황 재현:
//   - 로컬 dev 는 origin/dev 보다 뒤처져 있다
//   - HEAD(work)는 origin/dev 의 커밋을 이미 담고 있다 → `git pull origin dev` 는 no-op
function makeBehindBranchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitupd-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const other = path.join(root, 'other');

  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, local);
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test');
  commit(local, 'first');
  git(local, 'push', '-u', 'origin', 'main');
  git(local, 'checkout', '-b', 'dev');
  git(local, 'push', '-u', 'origin', 'dev');
  git(local, 'checkout', 'main');

  // 다른 사람이 dev 에 커밋을 쌓는다
  git(root, 'clone', remote, other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'Test');
  git(other, 'checkout', 'dev');
  commit(other, 'remote-dev-1');
  commit(other, 'remote-dev-2');
  git(other, 'push', 'origin', 'dev');

  git(local, 'fetch', 'origin');
  // 최신 dev 에서 딴 작업 브랜치를 체크아웃 — HEAD 는 origin/dev 를 이미 포함한다
  git(local, 'checkout', '-b', 'work', 'origin/dev');

  return { root, remote, local };
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

// ── 예전 방식이 왜 조용히 실패했는지 ──

test('git pull은 HEAD로 병합하므로 다른 브랜치를 갱신하지 못한다', async () => {
  const { local } = makeBehindBranchRepo();
  const before = sha(local, 'dev');
  assert.notEqual(before, sha(local, 'origin/dev'), '준비: dev 는 뒤처져 있어야 한다');

  const err = await gitPullFromRemoteAsync(local, 'origin', 'dev');

  assert.equal(err, null, 'git은 Already up to date로 성공을 돌려준다 — 에러가 안 뜬 이유');
  assert.equal(sha(local, 'dev'), before, 'dev 는 그대로 — pull 대기 수가 안 줄던 이유');
  assert.equal(sha(local, 'HEAD'), sha(local, 'origin/dev'), '실제 대상은 HEAD 였다');
});

// ── 고친 방식 ──

test('refspec fetch는 체크아웃하지 않은 브랜치의 ref를 옮긴다', async () => {
  const { local } = makeBehindBranchRepo();
  const headBefore = sha(local, 'HEAD');

  const err = await gitFetchIntoBranchAsync(local, 'origin', 'dev', 'dev');

  assert.equal(err, null);
  assert.equal(sha(local, 'dev'), sha(local, 'origin/dev'), 'dev 가 upstream까지 올라와야 한다');
  assert.equal(sha(local, 'HEAD'), headBefore, '현재 브랜치는 건드리지 않아야 한다');
  assert.equal(git(local, 'status', '--porcelain').trim(), '', '작업 트리도 그대로여야 한다');
});

// 원격 추적 ref(origin/dev)까지 같이 올라가지 않으면 dev 가 origin/dev 를 앞선 꼴이 돼
// 패널에 ↑N 이 잘못 뜬다. fetch 는 설정된 remote 라면 추적 ref 도 함께 갱신한다.
test('아직 fetch하지 않은 커밋까지 받아 원격 추적 ref도 함께 올린다', async () => {
  const { root, local } = makeBehindBranchRepo();
  const other = path.join(root, 'other');
  git(other, 'checkout', 'dev');
  commit(other, 'remote-dev-3');
  git(other, 'push', 'origin', 'dev');
  const remoteTip = sha(other, 'dev');
  assert.notEqual(sha(local, 'origin/dev'), remoteTip, '준비: 로컬 추적 ref 는 낡아 있어야 한다');

  const err = await gitFetchIntoBranchAsync(local, 'origin', 'dev', 'dev');

  assert.equal(err, null);
  assert.equal(sha(local, 'dev'), remoteTip, '원격 최신까지 받아야 한다');
  assert.equal(sha(local, 'origin/dev'), remoteTip, '추적 ref 가 뒤처지면 ↑N 이 잘못 뜬다');
});

test('fast-forward가 아니면 거절하고 이유를 돌려준다', async () => {
  const { local } = makeBehindBranchRepo();
  // dev 에만 있는 커밋을 만들어 갈라놓는다 (체크아웃하지 않은 채로).
  const base = sha(local, 'dev');
  git(local, 'checkout', 'dev');
  fs.writeFileSync(path.join(local, 'side.txt'), 'side\n');
  git(local, 'add', 'side.txt');
  git(local, 'commit', '-m', 'local-only');
  git(local, 'checkout', 'work');
  assert.notEqual(sha(local, 'dev'), base, '준비: dev 가 갈라져야 한다');
  const diverged = sha(local, 'dev');

  const err = await gitFetchIntoBranchAsync(local, 'origin', 'dev', 'dev');

  assert.ok(err, '조용히 성공하면 안 된다');
  assert.match(err, /non-fast-forward|rejected/i, '거절 사유가 그대로 와야 한다: ' + err);
  assert.equal(sha(local, 'dev'), diverged, '거절됐으면 ref 도 그대로여야 한다');
});

test('다른 워크트리가 체크아웃 중인 브랜치는 거절하고 이유를 돌려준다', async () => {
  const { root, local } = makeBehindBranchRepo();
  const wt = path.join(root, 'wt');
  git(local, 'worktree', 'add', wt, 'dev');
  const before = sha(local, 'dev');

  const err = await gitFetchIntoBranchAsync(local, 'origin', 'dev', 'dev');

  assert.ok(err, '점유 중인 브랜치를 조용히 옮기면 안 된다');
  assert.match(err, /refusing to fetch into branch|checked out at/i, '거절 사유: ' + err);
  assert.equal(sha(local, 'dev'), before);
});

// ── 메뉴 구성 ──

function setupMenu({ isCurrent }) {
  state.branches = [
    { name: 'work', isCurrent: !isCurrent, upstream: '' },
    { name: 'dev', isCurrent, upstream: 'origin/dev' },
  ];
  state.remoteBranches = ['origin/dev'];
  state.remotes = ['origin'];
  ui.pinnedBranches = [];
  return buildBranchContextMenuItems('dev');
}

const idsOf = items => items.map(i => i.id).filter(Boolean);

test('Pull 계열 항목은 체크아웃 여부와 무관하게 그대로 낸다', () => {
  for (const isCurrent of [true, false]) {
    const ids = idsOf(setupMenu({ isCurrent }));
    assert.ok(ids.includes('branch_ff'), 'isCurrent=' + isCurrent);
    assert.ok(ids.includes('branch_pull'), 'isCurrent=' + isCurrent);
    assert.ok(ids.includes('branch_pull_rebase'), 'isCurrent=' + isCurrent);
  }
});

// ── 조용한 무동작 대신 선택 다이얼로그 ──

function setupPullDialog({ ahead = 0, behind = 5, worktrees } = {}) {
  dialogs.length = 0;
  // 실행 게이트(actions.js)가 보는 전제 — 저장소가 열려 있고 초기 로딩이 끝난 상태
  state.loading = false;
  state.isGitRepo = true;
  state.cwd = 'C:/repo';
  state.branch = 'work';
  state.branches = [
    { name: 'work', isCurrent: true, upstream: '', ahead: 0, behind: 0 },
    { name: 'dev', isCurrent: false, upstream: 'origin/dev', ahead, behind },
  ];
  state.remoteBranches = ['origin/dev'];
  state.remotes = ['origin'];
  state.worktrees = worktrees || [{ path: 'C:/repo', branch: 'work', isCurrent: true, isMain: true }];
  state.pendingDialogAction = null;
  state.pendingDialogTarget = null;
  ui.pinnedBranches = [];
  ui.contextMenuBranch = 'dev';
}

test('비현재 브랜치의 Pull은 바로 실행하지 않고 대체 명령을 묻는다', async () => {
  setupPullDialog();
  await handleContextMenuAction('branch_pull');

  assert.equal(dialogs.length, 1, '조용히 지나가면 안 된다');
  const d = dialogs[0];
  assert.match(d.message, /git pull always merges into the checked-out branch/i, '왜 그대로는 안 되는지 알려야 한다');
  assert.match(d.message, /'work'/, '실제로 갱신될 뻔한 브랜치를 짚어야 한다');
  assert.deepEqual(d.buttons.map(b => b.id), ['ff', 'checkout_pull', 'cancel']);
  assert.equal(state.pendingDialogAction, 'pull-other-branch');
  assert.equal(state.pendingDialogTarget, 'dev');
});

test('뒤처지기만 했으면 Fast-Forward를 기본 선택으로 둔다', async () => {
  setupPullDialog({ ahead: 0, behind: 5 });
  await handleContextMenuAction('branch_pull');
  const d = dialogs[0];
  assert.equal(d.buttons.find(b => b.id === 'ff').default, true);
  assert.match(d.message, /↓5 behind/);
});

test('갈라졌으면 Fast-Forward가 거절될 것을 알리고 Checkout & Pull을 기본으로 둔다', async () => {
  setupPullDialog({ ahead: 2, behind: 5 });
  await handleContextMenuAction('branch_pull');
  const d = dialogs[0];
  assert.match(d.message, /diverged/i);
  assert.match(d.message, /Fast-Forward will be refused/i);
  assert.equal(d.buttons.find(b => b.id === 'checkout_pull').default, true);
  assert.equal(d.buttons.find(b => b.id === 'ff').default, false);
});

test('Rebase 항목은 Checkout & Pull (Rebase)를 제안한다', async () => {
  setupPullDialog();
  await handleContextMenuAction('branch_pull_rebase');
  assert.match(dialogs[0].buttons.find(b => b.id === 'checkout_pull').label, /Rebase/);
  assert.equal(state.pendingDialogAction, 'pull-other-branch-rebase');
});

test('다른 워크트리가 잡고 있으면 고르게 하지 않고 그 사실을 알린다', async () => {
  setupPullDialog({
    worktrees: [
      { path: 'C:/repo', branch: 'work', isCurrent: true, isMain: true },
      { path: 'C:/repo-dev', branch: 'dev', isCurrent: false, isMain: false },
    ],
  });
  await handleContextMenuAction('branch_pull');

  const d = dialogs[0];
  assert.match(d.message, /checked out in another worktree/i);
  assert.match(d.message, /C:\/repo-dev/, '어느 워크트리인지 짚어야 한다');
  assert.deepEqual(d.buttons.map(b => b.id), ['ok'], '실패가 뻔한 선택지를 주면 안 된다');
  assert.equal(state.pendingDialogAction, null);
});

test('취소하면 아무 git 명령도 돌지 않는다', async () => {
  setupPullDialog();
  await handleContextMenuAction('branch_pull');
  execLog.length = 0;
  await handleDialogResult({ button_id: 'cancel' });
  assert.deepEqual(execLog, []);
});

// ── 고른 선택지가 실제로 그 일을 하는지 (진짜 git) ──

// 실제 저장소를 대상으로 다이얼로그 → 선택 → 실행까지 태운다.
function attachRepo(local, { branch = 'dev', upstream = 'origin/dev' } = {}) {
  dialogs.length = 0;
  state.loading = false;
  state.isGitRepo = true;
  state.cwd = local;
  state.gitDir = ''; state.gitCommonDir = '';
  state.branch = git(local, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  state.branches = [
    { name: state.branch, isCurrent: true, upstream: '', ahead: 0, behind: 0 },
    { name: branch, isCurrent: false, upstream, ahead: 0, behind: 2 },
  ];
  state.remoteBranches = [upstream];
  state.remotes = ['origin'];
  state.worktrees = [{ path: local, branch: state.branch, isCurrent: true, isMain: true }];
  state.pendingDialogAction = null; state.pendingDialogTarget = null;
  state.spinnerActive = false; state.error = null;
  ui.pinnedBranches = []; ui.contextMenuBranch = branch;
  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
}

test('Fast-Forward를 고르면 그 브랜치만 올라가고 현재 브랜치는 그대로다', async () => {
  const { local } = makeBehindBranchRepo();
  attachRepo(local);
  const headBefore = sha(local, 'HEAD');
  await handleContextMenuAction('branch_pull');
  execLog.length = 0;
  await handleDialogResult({ button_id: 'ff' });
  await settle();

  assert.ok(execLog.some(c => c === 'fetch origin dev:dev'), '실행된 명령: ' + execLog.join(' | '));
  assert.equal(sha(local, 'dev'), sha(local, 'origin/dev'));
  assert.equal(sha(local, 'HEAD'), headBefore);
});

test('Checkout & Pull을 고르면 그 브랜치로 옮겨 간 뒤 pull한다', async () => {
  const { local } = makeBehindBranchRepo();
  attachRepo(local);
  await handleContextMenuAction('branch_pull');
  execLog.length = 0;
  await handleDialogResult({ button_id: 'checkout_pull' });
  await settle();

  const coAt = execLog.findIndex(c => c === 'checkout dev');
  const pullAt = execLog.findIndex(c => c === 'pull origin dev');
  assert.ok(coAt >= 0 && pullAt > coAt, '체크아웃 후 pull이어야 한다: ' + execLog.join(' | '));
  assert.equal(git(local, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'dev');
  assert.equal(sha(local, 'dev'), sha(local, 'origin/dev'));
});

test('체크아웃이 실패하면 pull은 시도하지 않는다', async () => {
  const { local } = makeBehindBranchRepo();
  // work 와 dev 에서 내용이 다른 파일을 수정 중이면 git 이 체크아웃을 거부한다.
  git(local, 'checkout', 'dev');
  fs.writeFileSync(path.join(local, 'a.txt'), 'dev-side\n');
  git(local, 'commit', '-am', 'dev-side');
  git(local, 'checkout', 'work');
  fs.writeFileSync(path.join(local, 'a.txt'), 'dirty\n');

  attachRepo(local);
  await handleContextMenuAction('branch_pull');
  execLog.length = 0;
  await handleDialogResult({ button_id: 'checkout_pull' });
  await settle();

  assert.ok(!execLog.some(c => c.startsWith('pull ')), 'pull을 시도하면 안 된다: ' + execLog.join(' | '));
  assert.equal(git(local, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'work', '현재 브랜치가 유지돼야 한다');
});

test('슬래시가 들어간 upstream도 refspec을 바르게 만든다', async () => {
  const { local } = makeBehindBranchRepo();
  git(local, 'branch', 'feature/x', 'dev');
  git(local, 'push', '-u', 'origin', 'feature/x');
  attachRepo(local, { branch: 'feature/x', upstream: 'origin/feature/x' });
  await handleContextMenuAction('branch_pull');
  execLog.length = 0;
  await handleDialogResult({ button_id: 'ff' });
  await settle();

  assert.ok(execLog.some(c => c === 'fetch origin feature/x:feature/x'),
    'origin 뒤 전부가 원격 브랜치명이어야 한다: ' + execLog.join(' | '));
});

test('upstream이 없으면 받아오기 항목 자체가 없다', () => {
  state.branches = [
    { name: 'work', isCurrent: true, upstream: '' },
    { name: 'scratch', isCurrent: false, upstream: '' },
  ];
  state.remoteBranches = [];
  state.remotes = ['origin'];
  ui.pinnedBranches = [];
  const ids = idsOf(buildBranchContextMenuItems('scratch'));
  assert.ok(!ids.includes('branch_ff'));
  assert.ok(!ids.includes('branch_pull'));
});
