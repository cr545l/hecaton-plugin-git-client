const { state } = require('./state');
// BRAILLE_FRAMES 원본은 title.js에 있다(순환 require 회피) — 기존 사용처를 위해 재수출.
const { applyWindowTitle, BRAILLE_FRAMES } = require('./title');

let spinnerTimer = null;
let refCount = 0;

function acquireSpinner() {
  refCount++;
  if (refCount === 1) {
    state.spinnerFrame = 0;
    updateTitle();
    // 처리상태가 창 타이틀로 옮겨간 뒤로 화면에는 프레임마다 바뀌는 것이 없다.
    // 여기서 render()를 돌리면 백그라운드 refresh가 도는 내내 80ms마다 전체 화면을
    // 다시 그리게 된다 — 타이틀만 갱신한다. 화면은 상태가 실제로 바뀌는 시점에
    // 호출부가 그린다(startSpinner/stopSpinner 전후).
    spinnerTimer = setInterval(() => {
      state.spinnerFrame = (state.spinnerFrame + 1) % BRAILLE_FRAMES.length;
      updateTitle();
      // 패널 안에 그린 스피너는 화면을 다시 그려야 돈다. 떠 있는 동안에만 켜지므로
      // 백그라운드 refresh 내내 재그리기를 피한다는 위 원칙은 그대로다.
      if (panelRefCount > 0) require('./render').render();
    }, 80);
  }
}

function releaseSpinner() {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    state.spinnerFrame = 0;
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    updateTitle();
  }
}

function updateTitle() {
  applyWindowTitle();
}

function isSpinning() {
  return refCount > 0;
}

// startSpinner/stopSpinner 는 저장소를 변경하는 작업(커밋/푸시/스테이징 등)의
// 시작과 끝을 감싼다. 따라서 state.spinnerActive 는 "쓰기 작업 진행 중" 플래그다.
// 읽기 작업(히스토리 조회, diff 로드, 백그라운드 refresh)은 이 플래그를 쓰지 않고
// state.refreshing / logLoading 계열로만 표시해, 진행 중에도 화면 탐색을 막지 않는다.
function startSpinner(msg) {
  state.spinnerActive = true;
  state.error = msg;
  acquireSpinner();
  // 동기 블로킹 작업 전에 스피너를 즉시 화면에 표시
  const { render } = require('./render');
  render();
}

function stopSpinner() {
  state.spinnerActive = false;
  state.error = null;
  releaseSpinner();
}

// ── 패널 안에 그리는 로딩 스피너 ──
// diff/상세는 헤더만 먼저 나오고 본문이 늦게 오는 구간이 있다. 그 사이를 빈 화면이나
// "Select a file..." 안내로 두면 멈춘 것처럼 보이므로 스피너로 대기 중임을 알린다.
// 로드가 한 프레임 안에 끝나면 스피너가 번쩍이기만 하므로 유예를 두되, 그보다 길어지면
// 곧바로 알린다 — 유예가 길면 빈 화면이 먼저 보인다. 스피너 타이머와 같은 80ms 주기의
// 바로 다음 프레임에서 그려지도록 한 프레임보다 조금 짧게 잡는다.
const PANEL_SPINNER_DELAY_MS = 70;

// 키마다 진행 플래그와 시작 시각을 짝지어 둔다 — 켜고 끄는 짝이 어긋나지 않게.
const PANEL_LOADERS = {
  diff: ['diffLoading', 'diffLoadingSince'],
  logDetail: ['logDetailLoading', 'logDetailLoadingSince'],
  freshDetail: ['freshDetailLoading', 'freshDetailLoadingSince'],
};

let panelRefCount = 0;

function beginPanelLoading(key) {
  const [flag, since] = PANEL_LOADERS[key];
  if (state[flag]) return;   // 이미 기다리는 중이면 시작 시각을 새로 잡지 않는다
  state[flag] = true;
  state[since] = Date.now();
  panelRefCount++;
  acquireSpinner();
}

function endPanelLoading(key) {
  const [flag, since] = PANEL_LOADERS[key];
  if (!state[flag]) return;
  state[flag] = false;
  state[since] = 0;
  if (panelRefCount > 0) panelRefCount--;
  releaseSpinner();
}

// 지금 그려야 할 스피너 문자열 — 로딩 중이 아니거나 아직 유예 시간 안이면 null.
// 호출부는 null 이면 원래 그리던 것을 그대로 그린다.
function panelLoadingLabel(key, label) {
  const [flag, since] = PANEL_LOADERS[key];
  if (!state[flag]) return null;
  if (Date.now() - state[since] < PANEL_SPINNER_DELAY_MS) return null;
  return BRAILLE_FRAMES[state.spinnerFrame % BRAILLE_FRAMES.length] + ' ' + label;
}

function isWriteOpActive() {
  return state.spinnerActive;
}

// "다른 쓰기 작업이 도는 중인가"만 보는 최소 게이트. 상황별(진행 중인 rebase, 리모트
// 없음, 스테이지 없음 …) 판정까지 포함한 실제 진입점은 actions.guardAction 이며,
// 호출부는 그쪽을 쓴다 — 화면의 딤 처리와 같은 규칙을 봐야 하기 때문이다.
// 이 함수는 그중 busy 조건만 떼어 놓은 것이다.
function guardWriteOp() {
  if (!state.spinnerActive) return true;
  flashBusy();
  return false;
}

// 차단 피드백 — 창 타이틀의 처리상태 옆에 잠깐 표시한다. 스피너 타이머(80ms)가
// 계속 updateTitle 을 돌리므로 만료 시점의 원복에 별도 타이머가 필요 없다.
const BUSY_FLASH_MS = 1500;
function flashBusy() {
  state.busyFlashUntil = Date.now() + BUSY_FLASH_MS;
  updateTitle();
}

// 힌트바에 잠깐 띄우는 비차단 안내(클립보드 복사 등). 쓰기 작업과 무관하므로
// spinnerActive 를 건드리지 않는다 — 진행 중인 작업 메시지가 있으면 덮지 않는다.
let toastTimer = null;
function showToast(msg, ttlMs = 1000) {
  if (state.spinnerActive) return;
  state.error = msg;
  const { render } = require('./render');
  render();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    if (!state.spinnerActive && state.error === msg) {
      state.error = null;
      render();
    }
  }, ttlMs);
}

module.exports = { BRAILLE_FRAMES, startSpinner, stopSpinner, acquireSpinner, releaseSpinner, isSpinning, isWriteOpActive, guardWriteOp, flashBusy, showToast, beginPanelLoading, endPanelLoading, panelLoadingLabel };
