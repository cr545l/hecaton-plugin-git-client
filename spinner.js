const { state } = require('./state');
// BRAILLE_FRAMES 원본은 title.js에 있다(순환 require 회피) — 기존 사용처를 위해 재수출.
const { formatWindowTitle, BRAILLE_FRAMES } = require('./title');

let spinnerTimer = null;
let refCount = 0;

function acquireSpinner() {
  refCount++;
  if (refCount === 1) {
    state.spinnerFrame = 0;
    updateTitle();
    spinnerTimer = setInterval(() => {
      state.spinnerFrame = (state.spinnerFrame + 1) % BRAILLE_FRAMES.length;
      updateTitle();
      const { render } = require('./render');
      render();
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
  const title = formatWindowTitle();
  if (!title) return;
  hecaton.window.set_title({ title }).catch(() => null);
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

function isWriteOpActive() {
  return state.spinnerActive;
}

// 쓰기 작업의 단일 진입 게이트. 다른 쓰기 작업이 도는 동안 새 쓰기 요청이 오면
// false 를 반환하고 힌트바를 잠깐 강조해 왜 무시됐는지 보여준다.
// 탐색/조회 같은 읽기 인터렉션은 이 게이트를 거치지 않으므로 작업 중에도 동작한다.
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

module.exports = { BRAILLE_FRAMES, startSpinner, stopSpinner, acquireSpinner, releaseSpinner, isSpinning, isWriteOpActive, guardWriteOp, flashBusy, showToast };
