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

// ── 진행 중인 쓰기 작업 등록부 ──
//
// 예전에는 state.spinnerActive 라는 불리언 하나가 "쓰기 작업 진행 중"을 뜻했다.
// 그 하나로는 두 가지를 할 수 없었다:
//   1. 무엇을 붙잡고 있는지 모른다 — 브랜치 리네임(ref 만 건드림)이 도는 동안에도
//      스테이징까지 전부 막혔다. 이제 작업마다 scopes 를 함께 등록하고,
//      actions.js 가 그것과 겹치는 동작만 막는다.
//   2. 두 작업이 겹칠 수 없다 — stopSpinner 가 spinnerActive/error 를 무조건 껐으므로,
//      먼저 끝난 쪽이 남은 작업의 진행 메시지까지 지웠다. 이제 목록에서 자기 것만 빼고
//      남은 작업이 있으면 그 이름이 그대로 타이틀에 남는다.
//
// scopes 는 여기서 해석하지 않고 그대로 들고만 있는다(의미는 actions.js 소관).
// null 이면 "무엇을 붙잡는지 밝히지 않았다" — 판정하는 쪽이 전부로 본다.
let _ops = [];

// 읽기 작업(히스토리 조회, diff 로드, 백그라운드 refresh)은 이 등록부를 쓰지 않고
// state.refreshing / logLoading 계열로만 표시해, 진행 중에도 화면 탐색을 막지 않는다.
function beginOp(label, scopes, phase) {
  const op = { label: label || '', scopes: scopes || null, phase: phase || 'running' };
  _ops.push(op);
  syncOpState(false);
  return op;
}

// 목록에서 빼고 파생 플래그를 다시 계산한다. running 이던 작업이 빠졌다면 진행
// 메시지도 함께 정리한다 — 단, 남은 running 작업이 있으면 그 이름으로 이어진다.
function endOp(op) {
  const idx = _ops.indexOf(op);
  if (idx < 0) return;
  const wasRunning = _ops[idx].phase === 'running';
  _ops.splice(idx, 1);
  syncOpState(wasRunning);
}

function syncOpState(clearMessage) {
  state.activeOps = _ops;
  const running = _ops.filter(o => o.phase === 'running');
  state.spinnerActive = running.length > 0;
  state.settlingWrite = _ops.some(o => o.phase === 'settling');
  // 표시할 이름은 가장 나중에 시작된 작업의 것 — 방금 시킨 일이 앞에 온다.
  // 뒷정리(settling)는 이름을 내지 않는다. 그 구간의 표시는 refreshMessage 몫이라
  // 기존 표시 규칙(title.js)이 그대로 유지된다.
  const top = running[running.length - 1];
  if (top) state.error = top.label;
  else if (clearMessage) state.error = null;
}

// 가장 나중에 시작된 running 작업의 scopes — 뒷정리 갱신이 물려받을 값이다.
function currentOpScopes() {
  for (let i = _ops.length - 1; i >= 0; i--) {
    if (_ops[i].phase === 'running') return _ops[i].scopes;
  }
  return null;
}

// 쓰기 작업의 시작. scopes 는 이 작업이 붙잡는 자원(actions.SCOPE 값들)이며,
// 넘기지 않으면 전부 붙잡는 것으로 취급된다 — 즉 예전과 같은 전면 차단이다.
// 반환값을 stopSpinner 에 넘기면 겹쳐 도는 작업 중 자기 것만 정확히 끝낼 수 있다.
function startSpinner(msg, scopes) {
  const op = beginOp(msg, scopes, 'running');
  acquireSpinner();
  // 동기 블로킹 작업 전에 스피너를 즉시 화면에 표시
  const { render } = require('./render');
  render();
  return op;
}

// 뒷정리 갱신을 원래 작업과 같은 자원을 쥔 채로 이어 등록한다. scopes 를 넘기지
// 않으면 아직 살아 있는 running 작업의 것을 물려받는다 — refreshInBackground 가
// stopSpinner 보다 먼저 불리므로(afterGitOp 순서) 그 시점엔 원래 작업이 남아 있다.
function startSettleOp(label, scopes) {
  return beginOp(label, scopes !== undefined ? scopes : currentOpScopes(), 'settling');
}

function endSettleOp(op) {
  endOp(op);
}

// 여러 Git 명령으로 이어지는 작업은 단계가 바뀐 직후 곧바로 다음 명령을 시작한다.
// 메시지만 바꾸고 80ms 타이머에 맡기면 타이틀은 그동안 직전 단계를 가리키므로,
// 상태 변경과 타이틀 반영을 한 동작으로 묶는다. 화면 전체는 다시 그릴 필요가 없다.
// (다단계 작업이 자원을 좁게 밝히게 되면 op 을 넘겨야 한다 — 그러지 않으면 그사이
//  겹쳐 시작된 다른 작업의 이름을 대신 바꾼다. 지금은 전부 전면 점유라 겹칠 수 없다.)
function updateSpinner(msg, op) {
  const target = op || lastRunningOp();
  if (!target) return;
  target.label = msg;
  syncOpState(false);
  updateTitle();
}

function lastRunningOp() {
  for (let i = _ops.length - 1; i >= 0; i--) {
    if (_ops[i].phase === 'running') return _ops[i];
  }
  return null;
}

// op 을 넘기지 않으면 가장 나중에 시작된 작업을 끝낸다 — 한 번에 하나씩 돌리는
// 기존 호출부는 그대로 맞아떨어진다.
function stopSpinner(op) {
  const target = op || lastRunningOp();
  if (!target) {
    // 짝이 맞지 않는 호출(이미 끝난 작업을 다시 끝내는 경우) — 표시만 정리한다.
    syncOpState(true);
    releaseSpinner();
    return;
  }
  endOp(target);
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

// "쓰기 작업이 하나라도 도는 중인가"만 보는 최소 게이트 — 자원은 구분하지 않는다.
// 상황별(진행 중인 rebase, 리모트 없음, 스테이지 없음 …) 판정과 자원 겹침까지 보는
// 실제 진입점은 actions.guardAction 이며, 호출부는 그쪽을 쓴다 — 화면의 딤 처리와
// 같은 규칙을 봐야 하기 때문이다.
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

// 테스트가 상태를 직접 세팅하고 시작할 수 있도록 등록부를 비운다.
function resetOps() {
  _ops = [];
  state.activeOps = _ops;
  state.spinnerActive = false;
  state.settlingWrite = false;
}

module.exports = {
  BRAILLE_FRAMES, startSpinner, updateSpinner, stopSpinner,
  startSettleOp, endSettleOp, currentOpScopes, resetOps,
  acquireSpinner, releaseSpinner, isSpinning, isWriteOpActive, guardWriteOp,
  flashBusy, showToast, beginPanelLoading, endPanelLoading, panelLoadingLabel,
};
