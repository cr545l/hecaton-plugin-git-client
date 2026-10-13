const { state } = require('./state');
const { t } = require('./i18n');
const { stripAnsi } = require('./text');

let sequence = 0;
const BUTTON_PREFIX = 'git-error:';

function current() {
  return state.operationError && state.operationError.cwd === state.cwd ? state.operationError : null;
}

function show(message) {
  // Refresh and spinner cleanup routinely clear state.error. Keep failures apart.
  state.operationError = {
    id: ++sequence, cwd: state.cwd,
    message: stripAnsi(String(message || t('menu.operationFailed'))).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''),
  };
  reopen();
  require('./render').render();
}

function reopen() {
  const error = current();
  if (!error) return false;
  // Do not replace a pending confirmation/input with a background failure.
  if (state.pendingDialogAction || state.pendingRebaseMenu || state.pendingCommitterEdit || state.pendingStash) return true;
  try {
    Promise.resolve(hecaton.dialog.show({
      type: 'message', title: t('menu.error'), message: error.message,
      buttons: [{ id: BUTTON_PREFIX + error.id, label: 'OK', default: true }],
    })).catch(() => null); // The in-app notice remains if the host modal fails.
  } catch { /* same fallback for synchronous host errors */ }
  return true;
}

function resolve(params) {
  const button = params && params.button_id;
  if (typeof button !== 'string' || !button.startsWith(BUTTON_PREFIX)) return false;
  // An old dialog's OK must not dismiss a newer failure or another confirmation.
  if (state.operationError && button === BUTTON_PREFIX + state.operationError.id) {
    state.operationError = null;
    require('./render').render();
  }
  return true;
}

function hint() {
  const error = current();
  if (!error) return '';
  const lines = error.message.split('\n').map(line => line.trim()).filter(Boolean);
  const reason = lines.find(line => /^(?:remote:\s*)?(?:error:|fatal:)/i.test(line)) || lines[0];
  return t('ui.errorDetails') + ' ' + reason;
}

module.exports = { show, reopen, resolve, hint, current };
