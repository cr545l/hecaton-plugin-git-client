// 창 타이틀의 처리상태 표시 검증.
//
// 힌트바는 눈에 잘 띄지 않아 처리상태(커밋/푸시/refresh 진행)를 창 타이틀로 옮겼다.
// 진행 중에는 브랜치명 앞에 힌트바에서 쓰던 형태("⠋ Committing...")로 점자 스피너가
// 붙고, 끝나면 스피너 없는 평소 타이틀로 돌아와야 한다.
//
// 변경점 표시(*N)만은 스피너보다도 앞이다 — 타이틀이 잘리는 자리에서 가장 먼저
// 사라지면 안 되는 정보라서, 진행 중이든 아니든 맨 앞자리를 지킨다.
const test = require('node:test');
const assert = require('node:assert/strict');

const { state } = require('../state');
const { formatWindowTitle, BRAILLE_FRAMES } = require('../title');

function resetState() {
  state.branch = 'main';
  state.staged = [{ status: 'M', file: 'a.txt' }];
  state.unstaged = [];
  state.untracked = [];
  state.ahead = 2;
  state.behind = 1;
  state.spinnerActive = false;
  state.error = null;
  state.refreshing = false;
  state.refreshMessage = '';
  state.logLoadingMore = false;
  state.busyFlashUntil = 0;
  state.spinnerFrame = 0;
}

test('유휴 상태의 타이틀은 변경점 표시부터 시작한다', () => {
  resetState();
  assert.equal(formatWindowTitle(), '*1 | main | ↓1 | ↑2');
});

test('변경점이 없으면 타이틀은 브랜치명부터 시작한다', () => {
  resetState();
  state.staged = [];
  assert.equal(formatWindowTitle(), 'main | ↓1 | ↑2');
});

test('쓰기 작업 중에는 브랜치명 앞에 스피너와 진행 메시지가 붙는다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Committing...';
  state.spinnerFrame = 2;

  const title = formatWindowTitle();
  assert.equal(title, '*1 | ' + BRAILLE_FRAMES[2] + ' Committing... | main | ↓1 | ↑2');
});

test('변경점 표시는 스피너보다 앞에 온다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Pushing...';

  const title = formatWindowTitle();
  assert.ok(title.indexOf('*1') < title.indexOf(BRAILLE_FRAMES[0]), title);
});

test('스피너 프레임이 진행되면 타이틀의 스피너 문자도 바뀐다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Pushing...';

  state.spinnerFrame = 0;
  const t0 = formatWindowTitle();
  state.spinnerFrame = 1;
  const t1 = formatWindowTitle();
  assert.notEqual(t0, t1, '프레임마다 다른 스피너 문자가 나와야 애니메이션이 된다');
});

test('쓰기 작업 중 차단된 입력의 피드백이 타이틀에 잠깐 붙는다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Committing...';
  state.busyFlashUntil = Date.now() + 1000;

  assert.match(formatWindowTitle(), /busy, action ignored/);

  state.busyFlashUntil = Date.now() - 1;
  assert.doesNotMatch(formatWindowTitle(), /busy/, '만료되면 사라져야 한다');
});

test('백그라운드 refresh도 타이틀에서 표시한다', () => {
  resetState();
  state.refreshing = true;
  state.refreshMessage = 'Scanning repository...';

  assert.match(formatWindowTitle(), /^\*1 \| ⠋ Scanning repository\.\.\. \| main/);
});

test('브랜치 확정 전(clone 등)에도 처리상태만으로 타이틀을 채운다', () => {
  resetState();
  state.branch = '';
  state.spinnerActive = true;
  state.error = 'Cloning repo...';

  assert.equal(formatWindowTitle(), '⠋ Cloning repo...');
});

test('작업이 끝나면 평소 타이틀로 돌아온다', () => {
  resetState();
  state.spinnerActive = true;
  state.error = 'Fetching...';
  formatWindowTitle();
  state.spinnerActive = false;
  state.error = null;

  assert.equal(formatWindowTitle(), '*1 | main | ↓1 | ↑2');
});
