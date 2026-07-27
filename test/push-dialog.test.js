// Push 단축키(Ctrl+Shift+P)가 upstream 이름 불일치를 감지해 선택 다이얼로그를
// 띄우는지 검증. git 은 실행하지 않고 exec 호출 인자만 기록한다.
const test = require('node:test');
const assert = require('node:assert/strict');

const shownDialogs = [];
const execCalls = [];

// 렌더 출력(ESC 로 시작)이 TAP 스트림을 뒤덮지 않게 걸러낸다
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.charCodeAt(0) === 0x1b) return true;
  return realWrite(chunk, ...rest);
};

global.hecaton = {
  fs: {},
  process: {
    exec: async ({ args }) => {
      execCalls.push(args);
      return { ok: true, exit_code: 0, stdout: '', stderr: '' };
    },
  },
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  terminal: {},
  dialog: { show: (opts) => { shownDialogs.push(opts); return Promise.resolve(); } },
  menu: { show: () => Promise.resolve() },
  on: () => {},
};

const { state } = require('../state');
const { CSI } = require('../ansi');
const { handleKey } = require('../input');

const PUSH_KEY = CSI + '112;6u';

function resetState(branch) {
  shownDialogs.length = 0;
  execCalls.length = 0;
  state.loading = false;
  state.isGitRepo = true;
  state.mode = 'normal';
  state.cwd = 'C:/repo';
  state.branch = branch.name;
  state.branches = [branch];
  state.remotes = ['origin'];
  state.remoteBranches = [];
  state.stashes = [];
  state.worktrees = [];
  state.pendingDialogAction = null;
  state.pendingDialogTarget = null;
}

// 이벤트 루프를 한 바퀴 돌려 비동기 push 경로가 진행되게 한다
const tick = () => new Promise(r => setTimeout(r, 50));

test('리네임으로 upstream 이름이 어긋나면 두 대상 중 하나를 고르게 한다', async () => {
  resetState({ name: 'feature-new', isCurrent: true, upstream: 'origin/feature-old' });
  handleKey(PUSH_KEY);
  await tick();

  assert.equal(shownDialogs.length, 1);
  const dialog = shownDialogs[0];
  assert.deepEqual(dialog.buttons.map(b => b.id), ['push_local', 'push_upstream', 'cancel']);
  assert.match(dialog.message, /'feature-new' tracks 'origin\/feature-old'/);

  assert.equal(state.pendingDialogAction, 'push-name-mismatch');
  assert.deepEqual(state.pendingDialogTarget, {
    remote: 'origin', local: 'feature-new', upstream: 'origin/feature-old', upstreamBranch: 'feature-old',
  });

  // 사용자가 고르기 전에는 아무것도 밀지 않는다
  assert.equal(execCalls.some(a => a.includes('push')), false);
});

test('이름이 일치하는 upstream 은 그대로 push 한다', async () => {
  resetState({ name: 'feature', isCurrent: true, upstream: 'origin/feature' });
  handleKey(PUSH_KEY);
  await tick();

  assert.equal(shownDialogs.length, 0);
  assert.ok(execCalls.some(a => a.length === 1 && a[0] === 'push'), 'push 가 실행되어야 한다');
});

test('upstream 이 없으면 로컬 이름으로 -u push 한다', async () => {
  resetState({ name: 'feature', isCurrent: true, upstream: '' });
  handleKey(PUSH_KEY);
  await tick();

  assert.equal(shownDialogs.length, 0);
  assert.ok(
    execCalls.some(a => a.join(' ') === 'push -u origin feature'),
    'push -u origin feature 가 실행되어야 한다',
  );
});

// 브랜치 이름에 '/' 가 있어도 remote 경계를 정확히 잘라야 한다
test('슬래시가 들어간 브랜치 이름도 정확히 비교한다', async () => {
  resetState({ name: 'hecaton/render', isCurrent: true, upstream: 'origin/hecaton/render' });
  handleKey(PUSH_KEY);
  await tick();
  assert.equal(shownDialogs.length, 0, '같은 이름이므로 다이얼로그가 뜨면 안 된다');

  resetState({ name: 'hecaton/render', isCurrent: true, upstream: 'origin/hecaton/old-name' });
  handleKey(PUSH_KEY);
  await tick();
  assert.equal(shownDialogs.length, 1);
  assert.equal(state.pendingDialogTarget.upstreamBranch, 'hecaton/old-name');
});
