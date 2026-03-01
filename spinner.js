const { state } = require('./state');

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
  if (!state.branch) return;
  sendRpcNotify('set_title', { title: state.branch });
}

function isSpinning() {
  return refCount > 0;
}

function startSpinner(msg) {
  state.spinnerActive = true;
  state.error = msg;
  acquireSpinner();
}

function stopSpinner() {
  state.spinnerActive = false;
  state.error = null;
  releaseSpinner();
}

module.exports = { BRAILLE_FRAMES, startSpinner, stopSpinner, acquireSpinner, releaseSpinner, isSpinning };
