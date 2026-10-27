const { state } = require('./state');
const { t } = require('./i18n');
const { stripAnsi } = require('./text');
const { isLongPathFailure, intentToAddFailurePath } = require('./git');

let sequence = 0;
const BUTTON_PREFIX = 'git-error:';
const LONG_PATHS_PREFIX = BUTTON_PREFIX + 'long-paths:';
const MAX_LISTED_PATHS = 10;

function dialogPending() {
  return state.pendingDialogAction || state.pendingRebaseMenu || state.pendingCommitterEdit || state.pendingStash;
}

function current() {
  return state.operationError && state.operationError.cwd === state.cwd ? state.operationError : null;
}

function show(message) {
  // Refresh and spinner cleanup routinely clear state.error. Keep failures apart.
  const detail = stripAnsi(String(message || t('menu.operationFailed'))).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const intentToAdd = intentToAddFailurePath(detail);
  state.operationError = {
    id: ++sequence, cwd: state.cwd,
    message: detail, longPaths: isLongPathFailure(detail),
    intentToAdd: intentToAdd ? [intentToAdd] : null,
  };
  if (intentToAdd) inspectIntentToAdd(state.operationError);
  reopen();
  require('./render').render();
  if (state.operationError.longPaths) {
    // A warning-only exit may already have staged other files. Read the actual
    // index instead of presenting either all paths or none as staged.
    refreshStatus();
  }
}

// git 은 막힌 파일을 하나만 알려 준다. 그 하나만 고치면 다음 파일에서 또 멈추므로,
// 전체 목록을 읽은 뒤에 안내창을 연다.
async function inspectIntentToAdd(error) {
  error.inspecting = true;
  let paths = null;
  try {
    paths = await require('./git').gitIntentToAddPaths(error.cwd);
  } catch { /* 오류 메시지에 나온 경로로 안내한다 */ }
  error.inspecting = false;
  if (paths && paths.length > 0) error.intentToAdd = paths;
  if (current() !== error) return;
  reopen();
  require('./render').render();
}

function intentToAddHelp(error) {
  const paths = error.intentToAdd;
  const lines = paths.slice(0, MAX_LISTED_PATHS).map(file => '  ' + file);
  if (paths.length > MAX_LISTED_PATHS) {
    lines.push('  ' + t('git.intentToAddMore', { count: paths.length - MAX_LISTED_PATHS }));
  }
  return t('git.intentToAddHelp', { files: lines.join('\n'), cwd: error.cwd });
}

function refreshStatus() {
  require('./refresh').refreshInBackground({ statusOnly: true }, {
    settle: true, scopes: [require('./actions').SCOPE.INDEX],
  });
}

function displayDialog(params, owner) {
  const complete = result => {
    owner.opening = false;
    owner.dialogError = result && (result.__rpcError || result.error || result.error_code
      || (result.ok === false ? 'dialog.show returned ok:false' : null)) || null;
    if (owner.dialogError) {
      const reason = owner.dialogError.message || String(owner.dialogError);
      process.stderr.write('[git-client] dialog.show failed: ' + stripAnsi(reason).replace(/[\r\n]/g, ' ') + '\n');  // i18n-ok: stderr 진단(사용자 UI 아님)
    }
  };
  owner.opening = true;
  try {
    Promise.resolve(hecaton.dialog.show(params)).then(complete, error => complete({ error }));
  } catch (error) { complete({ error }); }
}

function reopen() {
  const error = current();
  if (!error) return false;
  // Do not replace a pending confirmation/input with a background failure.
  if (dialogPending()) { error.deferred = true; return true; }
  if (error.configuring || error.opening || error.inspecting) return true;
  error.deferred = false;
  const buttons = [{ id: BUTTON_PREFIX + error.id, label: error.longPaths ? t('menu.cancel') : 'OK',
    default: true, style: error.longPaths ? 'danger' : 'success' }];
  if (error.longPaths) buttons.unshift({ id: LONG_PATHS_PREFIX + error.id, label: t('git.enableLongPaths'), style: 'success' });
  const help = error.longPaths ? t('git.longPathsHelp', { cwd: error.cwd })
    : error.intentToAdd ? intentToAddHelp(error) : '';
  const title = error.longPaths ? t('git.longPathsTitle')
    : error.intentToAdd ? t('git.intentToAddTitle') : t('menu.error');
  const message = [help, error.message, error.configurationError].filter(Boolean).join('\n\n');
  displayDialog({ type: 'message', title, message, buttons }, error);
  return true;
}

function showDeferred() {
  const error = current();
  if (error && error.deferred && !dialogPending()) reopen();
}

async function resolve(params) {
  const button = params && params.button_id;
  if (typeof button !== 'string' || !button.startsWith(BUTTON_PREFIX)) return false;
  const error = current();
  if (error && button === LONG_PATHS_PREFIX + error.id) {
    if (!error.longPaths || error.configuring || dialogPending()) return true;
    const { guardAction, SCOPE } = require('./actions');
    if (!guardAction('enable-long-paths')) return true;
    // Capture the failing repository. Delayed/duplicate dialog replies must
    // never configure a different repository or start a second config write.
    error.configuring = true;
    const { startSpinner, stopSpinner, showToast } = require('./spinner');
    const op = startSpinner(t('git.enablingLongPaths'), [SCOPE.CONFIG]);
    let failure;
    try {
      failure = await require('./git').gitEnableLongPaths(error.cwd);
    } finally {
      error.configuring = false;
      stopSpinner(op);
    }
    if (current() !== error) return true;
    if (failure) {
      error.configurationError = failure;
      reopen();
      require('./render').render();
    } else {
      state.operationError = null;
      // Leave the failed operation to the user to retry against the current
      // selection. Configuring Git must not silently stage any files.
      const message = t('git.longPathsEnabled', { cwd: error.cwd });
      showToast(message.split('\n')[0], 4000);
      // Re-read paths previously omitted by Git's short-path directory scan.
      refreshStatus();
      if (!dialogPending()) {
        displayDialog({
          type: 'message', title: t('git.longPathsEnabledTitle'), message,
          buttons: [{ id: BUTTON_PREFIX + 'configured:' + error.id, label: 'OK', default: true, style: 'success' }],
        }, error);
      }
    }
    return true;
  }
  // An old dialog's OK must not dismiss a newer failure or another confirmation.
  if (error && !error.configuring && button === BUTTON_PREFIX + error.id) {
    state.operationError = null;
    require('./render').render();
  }
  return true;
}

function hint() {
  const error = current();
  if (!error) return '';
  if (error.longPaths) return t('ui.errorDetails') + ' '
    + t(error.configurationError ? 'git.enableLongPathsFailed' : 'git.longPathsFailure');
  if (error.intentToAdd) return t('ui.errorDetails') + ' ' + t('git.intentToAddFailure');
  const lines = error.message.split('\n').map(line => line.trim()).filter(Boolean);
  const reason = lines.find(line => /^(?:remote:\s*)?(?:error:|fatal:)/i.test(line)) || lines[0];
  return t('ui.errorDetails') + ' ' + reason;
}

module.exports = { show, reopen, resolve, hint, current, showDeferred };
