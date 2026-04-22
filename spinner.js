const { state } = require('./state');
const { formatWindowTitle } = require('./title');

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
  const { sendRpcNotify } = require('./rpc');
  const title = formatWindowTitle();
  if (!title) return;
  sendRpcNotify('window.set_title', { title });
}

function isSpinning() {
  return refCount > 0;
}

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

module.exports = { BRAILLE_FRAMES, startSpinner, stopSpinner, acquireSpinner, releaseSpinner, isSpinning };
