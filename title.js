const { state } = require('./state');

// 점자 스피너 프레임의 원본 정의. spinner.js가 이 파일을 require하므로
// (updateTitle → formatWindowTitle) 순환을 피해 여기 두고 spinner.js가 재수출한다.
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function getLocalChangeCount() {
  return state.staged.length + state.unstaged.length + state.untracked.length;
}

// 진행 중인 처리상태를 "⠹ Committing..." 형태로 만든다. 힌트바는 눈에 잘 띄지
// 않아 처리상태 표시를 창 타이틀로 옮겼다 — 스피너 타이머(80ms)가 매 프레임
// applyWindowTitle을 부르므로 타이틀에서 스피너가 돌고, 멈추면 자동으로 사라진다.
//
// 여러 표시가 겹칠 때의 우선순위. 사용자가 시킨 작업일수록 앞에 온다:
//   1. 진행 중인 쓰기 작업 (Pushing / Rebasing / Rename branch ...)
//   2. 백그라운드 refresh
//   3. 히스토리 추가 로드
// refresh 는 대개 다른 작업에 딸려 돌고 그 작업보다 오래 걸린다. 같은 자리를 두고
// 다투면 정작 무슨 작업인지 알려 주는 라벨을 가리므로 항상 뒤로 미룬다.
// 단독으로 도는 refresh(자동 갱신, [r], 시작 스캔)는 가릴 것이 없으니 그대로 보인다.
function formatProgressStatus() {
  let msg = '';
  if (state.spinnerActive && state.error) msg = state.error;
  else if (state.refreshing) msg = state.refreshMessage || 'Refreshing...';
  else if (state.logLoadingMore) msg = 'Loading more commits...';
  // 지금 도는 작업 때문에 막혀 예약해 둔 동작 — 무엇이 이어질지를 진행 표시 뒤에
  // 덧붙인다("⠹ Committing... → Push"). 눌린 것이 무시되지 않았다는 신호이므로,
  // 진행 표시가 없는 찰나(작업이 끝나고 예약이 실행되기 직전)에도 남겨 둔다.
  const queued = require('./queue').summary();
  if (!msg && !queued) return '';
  const frame = BRAILLE_FRAMES[state.spinnerFrame % BRAILLE_FRAMES.length];
  // 쓰기 작업 중 차단된 입력의 피드백도 처리상태의 일부로 타이틀에서 잠깐 보여준다.
  const busy = state.spinnerActive && state.busyFlashUntil && Date.now() < state.busyFlashUntil
    ? ' — busy, action ignored' : '';
  return frame + ' ' + (msg || 'Queued') + busy + (queued ? ' → ' + queued : '');
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

// 창 타이틀 반영의 유일한 통로. 스피너가 80ms마다 부르는데 처리상태가 없는 동안에는
// 같은 문자열이 계속 나오므로, 바뀐 경우에만 호스트로 내보내 RPC를 아낀다.
let _lastTitle = null;
function applyWindowTitle() {
  const title = formatWindowTitle();
  if (!title || title === _lastTitle) return;
  _lastTitle = title;
  hecaton.window.set_title({ title }).catch(() => null);
}

module.exports = { getLocalChangeCount, formatWindowTitle, formatProgressStatus, applyWindowTitle, BRAILLE_FRAMES };
