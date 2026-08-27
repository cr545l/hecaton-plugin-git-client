// 처리상태 표시의 우선순위 검증.
//
// refresh는 대개 다른 작업에 딸려 돌고 그 작업보다 오래 걸린다. 같은 자리를 두고 다투면
// "Rename branch..." 같은 라벨을 "Refreshing..."이 가려, 정작 무슨 작업이 진행 중인지
// 알 수 없게 된다. 그래서 (1) 작업 라벨이 refresh를 이기고, (2) 작업에 딸린 후속 refresh는
// 그 작업의 이름을 이어받는다. 단독으로 도는 refresh는 가릴 것이 없으니 그대로 보인다.
const test = require('node:test');
const assert = require('node:assert/strict');

const titles = [];

global.hecaton = {
  fs: {
    stat: async () => ({ exists: false }),
    read_dir: async () => ({ ok: false }),
    read_file: async () => ({ content: '' }),
  },
  process: { exec: async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' }) },
  terminal: {},
  window: { set_title: async ({ title }) => { titles.push(title); return { ok: true }; } },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  scroll: {
    region: async () => ({ ok: true }),
    set: async () => ({}),
    remove: async () => ({}),
  },
  dialog: { show: () => Promise.resolve({}) },
  menu: { show: () => Promise.resolve({}) },
};

const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('\x1b[')) return true;
  return _origWrite(chunk, ...rest);
};

const { state } = require('../state');
const { formatProgressStatus, applyWindowTitle, BRAILLE_FRAMES } = require('../title');
const { startSpinner, updateSpinner, stopSpinner, releaseSpinner, isSpinning } = require('../spinner');

function resetState() {
  titles.length = 0;
  state.cwd = 'C:/repo';
  state.isGitRepo = true;
  state.branch = 'main';
  state.staged = []; state.unstaged = []; state.untracked = [];
  state.ahead = 0; state.behind = 0;
  state.spinnerActive = false;
  state.error = null;
  state.refreshing = false;
  state.refreshMessage = '';
  state.logLoadingMore = false;
  state.busyFlashUntil = 0;
  state.spinnerFrame = 0;
  state.loading = false;
  state.minimized = false;
}

test.afterEach(() => {
  state.spinnerActive = false;
  state.error = null;
  while (isSpinning()) releaseSpinner();
});

// ── 우선순위 ──

test('단독 refresh는 그대로 Refreshing 으로 보인다', () => {
  resetState();
  state.refreshing = true;
  state.refreshMessage = 'Refreshing...';

  assert.match(formatProgressStatus(), /Refreshing\.\.\./,
    '가릴 작업이 없으면 refresh를 숨길 이유가 없다');
});

test('작업이 진행 중이면 refresh가 겹쳐도 작업 라벨이 보인다', () => {
  resetState();
  // 스테이징 뒤의 뒷정리 refresh가 도는 중에 사용자가 Push를 눌렀다.
  state.refreshing = true;
  state.refreshMessage = 'Refreshing...';
  state.spinnerActive = true;
  state.error = 'Pushing...';

  const progress = formatProgressStatus();
  assert.match(progress, /Pushing\.\.\./, '진행 중인 작업이 앞에 와야 한다');
  assert.ok(!progress.includes('Refreshing'), 'refresh는 뒤로 밀려야 한다');
});

test('작업이 끝나면 아직 도는 refresh가 다시 드러난다', () => {
  resetState();
  state.refreshing = true;
  state.refreshMessage = 'Refreshing...';
  state.spinnerActive = true;
  state.error = 'Pushing...';
  // 작업만 끝나고 refresh는 계속 도는 상태
  state.spinnerActive = false;
  state.error = null;

  assert.match(formatProgressStatus(), /Refreshing\.\.\./,
    '가릴 작업이 사라졌으면 refresh가 보여야 한다');
});

test('히스토리 추가 로드는 refresh보다도 뒤다', () => {
  resetState();
  state.refreshing = true;
  state.refreshMessage = 'Refreshing...';
  state.logLoadingMore = true;

  assert.match(formatProgressStatus(), /Refreshing\.\.\./);
});

// ── 작업 라벨이 후속 refresh로 이어지는지 ──

test('작업에 딸린 refresh는 그 작업의 이름을 단다', async () => {
  resetState();
  const { refreshInBackground } = require('../refresh');

  // afterGitOp이 하는 일: 작업 스피너를 내리고 이름을 후속 refresh에 넘긴다.
  startSpinner('Rename branch...');
  stopSpinner();
  const p = refreshInBackground({ statusOnly: true }, { message: 'Rename branch...' });

  assert.equal(state.refreshMessage, 'Rename branch...',
    'git 명령이 끝났다고 라벨이 Refreshing으로 바뀌면 안 된다');
  assert.match(formatProgressStatus(), /Rename branch\.\.\./);
  await p;
});

test('이름 없는 refresh가 겹쳐도 이미 걸린 작업 이름을 끌어내리지 않는다', async () => {
  resetState();
  const { refreshInBackground } = require('../refresh');

  const labeled = refreshInBackground({ statusOnly: true }, { message: 'Fetching...' });
  const plain = refreshInBackground({ statusOnly: true });   // 워처가 띄운 뒷정리 갱신

  assert.equal(state.refreshMessage, 'Fetching...',
    '나중에 들어온 이름 없는 refresh가 라벨을 덮으면 안 된다');
  await Promise.all([labeled, plain]);
});

test('모든 refresh가 끝나면 처리상태가 사라진다', async () => {
  resetState();
  const { refreshInBackground } = require('../refresh');

  await refreshInBackground({ statusOnly: true }, { message: 'Rename branch...' });

  assert.equal(state.refreshing, false);
  assert.equal(formatProgressStatus(), '', '끝난 뒤에는 타이틀에 아무것도 남지 않아야 한다');
});

// ── 타이틀 반영 ──

test('applyWindowTitle은 같은 제목을 거듭 내보내지 않는다', () => {
  // 중복 제거 캐시는 모듈 전역이라 앞선 테스트가 남긴 제목이 이미 들어 있다.
  // 먼저 제목을 바꿔 알고 있는 상태로 맞춘 뒤, 그다음부터 아끼는지 본다.
  resetState();
  state.spinnerActive = true;
  state.error = 'Rebasing...';
  applyWindowTitle();

  const emitted = titles.length;
  assert.equal(emitted, 1, '바뀐 제목은 내보내야 한다');
  assert.match(titles[0], /Rebasing\.\.\. \| main/);

  applyWindowTitle();
  applyWindowTitle();
  assert.equal(titles.length, emitted, '바뀐 게 없으면 RPC를 아껴야 한다');
});

test('스피너 프레임이 돌면 타이틀도 따라 바뀐다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Fetching...';

  state.spinnerFrame = 0;
  applyWindowTitle();
  const t0 = titles[titles.length - 1];
  state.spinnerFrame = 1;
  applyWindowTitle();
  const t1 = titles[titles.length - 1];

  assert.notEqual(t0, t1, '프레임이 바뀌면 새 제목이 나가야 애니메이션이 된다');
  assert.equal(t0, BRAILLE_FRAMES[0] + ' Fetching... | main');
  assert.equal(t1, BRAILLE_FRAMES[1] + ' Fetching... | main');
});

test('복합 작업의 단계 변경은 다음 타이머를 기다리지 않고 타이틀에 반영된다', () => {
  resetState();
  startSpinner('Stash & Rebase... (1/3) Stashing');
  const emittedBeforeUpdate = titles.length;

  updateSpinner('Stash & Rebase... (2/3) Rebasing');

  assert.equal(titles.length, emittedBeforeUpdate + 1);
  assert.match(titles[titles.length - 1], /\(2\/3\) Rebasing/);
  stopSpinner();
});
