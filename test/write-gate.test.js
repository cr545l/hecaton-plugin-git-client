// 쓰기 작업 중 인터렉션 분리 검증.
//
// 배경: 예전에는 spinnerActive 가 stdin 전체를 막아, 커밋/페치/푸시가 도는 동안
// 히스토리 조회·리비전 선택·브랜치 확인 같은 읽기 인터렉션까지 전부 죽었다.
// 반대로 menu_activated(우클릭 메뉴)는 그 게이트를 거치지 않아 쓰기 중첩이 가능했다.
// 지금은 전역 차단 대신 각 쓰기 액션 지점의 guardWriteOp 가 막는다:
//   - 쓰기 작업 중에도 탐색/조회 입력은 동작해야 한다
//   - 쓰기 작업 중 새 쓰기 요청(키/메뉴/커밋 제출)은 거부되고 busy 피드백만 남긴다
const test = require('node:test');
const assert = require('node:assert/strict');

// 실행된 git 명령 기록 — 차단 검증의 핵심은 "git 이 스폰되지 않았다"이다.
const execLog = [];

global.hecaton = {
  terminal: {},
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  process: {
    exec: async ({ args }) => {
      execLog.push(args.join(' '));
      return { ok: true, exit_code: 0, stdout: '', stderr: '' };
    },
  },
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
  clipboard: { write: async () => ({ ok: true }), read: async () => ({ text: '' }) },
};

const dialogs = [];
hecaton.dialog = { show: (opts) => { dialogs.push(opts); return Promise.resolve({}); } };
hecaton.menu = { show: () => Promise.resolve({}) };

// render()가 뿜는 이스케이프 시퀀스만 삼키고 테스트 러너 출력은 통과시킨다.
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('\x1b[')) return true;
  return _origWrite(chunk, ...rest);
};

const { CSI } = require('../ansi');
const { state, ui } = require('../state');
const { guardWriteOp, showToast, releaseSpinner, isSpinning } = require('../spinner');
const { handleKey } = require('../input');
const { handleContextMenuAction } = require('../context-menu');

function resetState({ busy = false } = {}) {
  execLog.length = 0;
  dialogs.length = 0;
  state.cwd = 'C:/repo';
  state.isGitRepo = true;
  state.branch = 'main';
  state.mode = 'normal';
  state.rightView = 'diff';
  state.focusPanel = 'status';
  state.cursor = 0;
  state.staged = [];
  state.unstaged = [{ status: 'M', file: 'a.txt' }, { status: 'M', file: 'b.txt' }];
  state.untracked = [];
  state.ignored = [];
  state.selectedFiles = new Set();
  state.operationState = null;
  state.commitMsg = '';
  state.commitCursor = 0;
  state.commitAmend = false;
  state.spinnerActive = busy;
  state.error = busy ? 'Committing...' : null;
  state.busyFlashUntil = 0;
  state.loading = false;
  state.minimized = false;
  ui.termCols = 120; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.remoteSortMode = 'alpha_desc';
}

// 스피너 타이머가 이벤트 루프를 붙잡으면 러너가 끝나지 않는다.
test.afterEach(() => {
  state.spinnerActive = false;
  state.error = null;
  while (isSpinning()) releaseSpinner();
});

test('guardWriteOp: 유휴 상태에서는 통과, 쓰기 작업 중에는 거부하고 busy 피드백을 남긴다', () => {
  resetState();
  assert.equal(guardWriteOp(), true, '유휴 상태의 쓰기 요청은 통과해야 한다');
  assert.equal(state.busyFlashUntil, 0, '통과 시에는 busy 피드백이 없어야 한다');

  resetState({ busy: true });
  assert.equal(guardWriteOp(), false, '쓰기 작업 중의 새 쓰기 요청은 거부해야 한다');
  assert.ok(state.busyFlashUntil > Date.now(), '거부 사유를 힌트바에 잠깐 표시해야 한다');
  assert.equal(state.error, 'Committing...', '진행 중인 작업 메시지를 지우면 안 된다');
});

test('쓰기 작업 중에도 탐색 키는 동작한다', async () => {
  resetState({ busy: true });
  await handleKey(CSI + 'B'); // Down
  assert.equal(state.cursor, 1, '커서 이동(읽기)은 쓰기 작업 중에도 허용되어야 한다');

  await handleKey('\t'); // Tab: 패널 포커스 전환
  assert.equal(state.focusPanel, 'diff');
});

test('쓰기 작업 중 스테이징 키는 git 을 스폰하지 않는다', async () => {
  resetState({ busy: true });
  execLog.length = 0;
  await handleKey('s');
  assert.deepEqual(execLog.filter(c => c.startsWith('add')), [], 'stage 가 실행되면 안 된다');
  assert.ok(state.busyFlashUntil > Date.now(), '차단 피드백이 남아야 한다');
});

test('쓰기 작업 중 커밋 제출은 무시되고 메시지와 모드는 보존된다', async () => {
  resetState({ busy: true });
  state.mode = 'commit';
  state.commitMsg = 'my commit message';
  state.staged = [{ status: 'M', file: 'a.txt' }];
  execLog.length = 0;

  await handleKey(CSI + '13;5u'); // Ctrl+Enter submit

  assert.deepEqual(execLog.filter(c => c.startsWith('commit')), [], '커밋이 실행되면 안 된다');
  assert.equal(state.mode, 'commit', '재시도할 수 있게 커밋 모드가 유지되어야 한다');
  assert.equal(state.commitMsg, 'my commit message', '메시지가 날아가면 안 된다');
});

test('쓰기 작업 중 컨텍스트 메뉴의 쓰기 액션은 차단된다', async () => {
  resetState({ busy: true });
  await handleContextMenuAction('tab_init'); // git init 을 스폰하는 쓰기 액션
  assert.deepEqual(execLog, [], '쓰기 메뉴 액션이 git 을 스폰하면 안 된다');

  await handleContextMenuAction('tab_discard_all'); // 확인 다이얼로그를 띄우는 쓰기 액션
  assert.equal(dialogs.length, 0, '쓰기 확인 다이얼로그도 열리면 안 된다');
  assert.ok(state.busyFlashUntil > Date.now());
});

test('쓰기 작업 중에도 컨텍스트 메뉴의 읽기 액션은 동작한다', async () => {
  resetState({ busy: true });
  await handleContextMenuAction('remote_sort_alpha');
  assert.equal(ui.remoteSortMode, 'alpha', 'UI 상태만 바꾸는 읽기 액션은 허용되어야 한다');
});

test('showToast 는 쓰기 게이트를 잠그지 않고 스스로 사라진다', async () => {
  resetState();
  showToast('Copied: abc123', 50);
  assert.equal(state.error, 'Copied: abc123');
  assert.equal(state.spinnerActive, false, '토스트가 쓰기 작업으로 취급되면 안 된다');
  assert.equal(guardWriteOp(), true, '토스트 표시 중에도 쓰기 요청은 통과해야 한다');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(state.error, null, '토스트는 시간이 지나면 지워져야 한다');
});
