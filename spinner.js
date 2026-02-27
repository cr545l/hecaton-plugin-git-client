const { state } = require('./state');

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let spinnerTimer = null;

function startSpinner(msg) {
  state.spinnerActive = true;
  state.spinnerFrame = 0;
  state.error = msg;
  const { render } = require('./render');
  render();
  spinnerTimer = setInterval(() => {
    state.spinnerFrame = (state.spinnerFrame + 1) % BRAILLE_FRAMES.length;
    const { render } = require('./render');
    render();
  }, 80);
}

function stopSpinner() {
  state.spinnerActive = false;
  state.spinnerFrame = 0;
  state.error = null;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

module.exports = { BRAILLE_FRAMES, startSpinner, stopSpinner };
