const { state } = require('./state');

// 점자 스피너 프레임의 원본 정의. spinner.js가 이 파일을 require하므로
// (updateTitle → formatWindowTitle) 순환을 피해 여기 두고 spinner.js가 재수출한다.
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function getLocalChangeCount() {
  return state.staged.length + state.unstaged.length + state.untracked.length;
}

// 진행 중인 처리상태를 "⠹ Committing..." 형태로 만든다. 힌트바는 눈에 잘 띄지
// 않아 처리상태 표시를 창 타이틀로 옮겼다 — 스피너 타이머(80ms)가 매 프레임
// updateTitle을 부르므로 타이틀에서 스피너가 돌고, 멈추면 자동으로 사라진다.
function formatProgressStatus() {
  let msg = '';
  if (state.spinnerActive && state.error) msg = state.error;
  else if (state.refreshing) msg = state.refreshMessage || 'Refreshing...';
  else if (state.logLoadingMore) msg = 'Loading more commits...';
  if (!msg) return '';
  const frame = BRAILLE_FRAMES[state.spinnerFrame % BRAILLE_FRAMES.length];
  // 쓰기 작업 중 차단된 입력의 피드백도 처리상태의 일부로 타이틀에서 잠깐 보여준다.
  const busy = state.spinnerActive && state.busyFlashUntil && Date.now() < state.busyFlashUntil
    ? ' — busy, action ignored' : '';
  return frame + ' ' + msg + busy;
}

function formatWindowTitle() {
  const progress = formatProgressStatus();
  // 저장소 확정 전(clone/init 진행 중 등)에도 처리상태는 타이틀에 보여준다.
  if (!state.branch) return progress;
  const parts = [];
  if (progress) parts.push(progress);
  parts.push(state.branch);
  const totalChanges = getLocalChangeCount();
  if (totalChanges > 0) parts.push(`*${totalChanges}`);
  if (state.behind > 0) parts.push(`↓${state.behind}`);
  if (state.ahead > 0) parts.push(`↑${state.ahead}`);
  return parts.join(' | ');
}

module.exports = { getLocalChangeCount, formatWindowTitle, formatProgressStatus, BRAILLE_FRAMES };
