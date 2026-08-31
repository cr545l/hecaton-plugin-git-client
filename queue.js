// ── 지금은 못 하는 동작의 대기열 ──
//
// 배경: 판정(actions.js)은 "지금 되는가"에만 답했고, 안 되면 그대로 버렸다. 커밋을
// 걸고 곧바로 Push 를 누르면 "busy, action ignored"가 잠깐 뜰 뿐이라, 커밋의 git
// 명령과 뒷정리 갱신이 모두 끝나는 것을 지켜보다 다시 눌러야 했다. 커밋하고 푸시하는
// 것은 사실상 한 번에 시키는 일인데도 그랬다.
//
// 여기서는 자원이 겹쳐 막힌 동작을 버리지 않고 예약해 둔다. 붙잡고 있던 작업이
// 끝나는 순간(spinner.endOp → scheduleDrain) 다시 판정하고, 통과하면 그때 실행한다.
//
// 판정을 예약할 때가 아니라 실행할 때 한 번 더 하는 것이 이 구조의 핵심이다. 예약과
// 실행 사이에 상황이 바뀌어 성립하지 않게 된 동작은 조용히 나가지 않고, 사유와 함께
// 취소된다 — 리모트가 사라졌다면 "Push cancelled — No remote configured"다.
//
// 예약 대상은 좁다(actions.QUEUEABLE_ACTIONS). 무엇에 대고 실행할지가 화면의 선택이
// 아니라 실행 시점의 저장소에서 정해지는 동작만 넣는다. 화면에서 대상을 고르는 동작
// (파일 스테이징, 고른 커밋으로 reset)을 예약하면 풀려날 때쯤 그 목록이 이미 다른
// 것으로 바뀌어 있다 — 예약이 사고가 되는 지점이 정확히 거기다.
const { state } = require('./state');

// 예약이 영영 남지 않게 하는 안전망. 정상 흐름에서는 붙잡던 작업이 끝나는 순간
// 비워지므로 여기 걸릴 일이 없다 — 확인 다이얼로그가 열린 채 방치되는 등, 작업이
// 끝나지 않는 경우에만 만료된다.
const TTL_MS = 90000;

// 타이틀과 토스트에 내보낼 이름. 액션 id 를 그대로 쓰면 'git-push' 같은 내부 이름이
// 사용자 눈에 보인다.
const LABELS = {
  'git-push': 'Push',
  'git-pull': 'Pull',
  'git-fetch': 'Fetch',
  stageSelected: 'Stage',
  unstageSelected: 'Unstage',
  stageAll: 'Stage all',
  unstageAll: 'Unstage all',
};
const LABEL_PREFIXES = [['push_to_remote:', 'Push']];

function labelOf(id) {
  if (LABELS[id]) return LABELS[id];
  for (const [prefix, label] of LABEL_PREFIXES) {
    if (id.startsWith(prefix)) return label;
  }
  return 'Action';
}

// [{ id, run, label, at, branch }] — branch 는 예약할 때의 현재 브랜치이며,
// null 이면 브랜치와 무관한 동작(fetch)이라 검사하지 않는다는 뜻이다.
let _queue = [];
let _drainTimer = null;
let _draining = false;

function has(id) {
  return _queue.some(e => e.id === id);
}

// ── 버튼 하나가 대표하는 예약 ──
// Push 버튼은 리모트가 여럿이면 메뉴를 거쳐 'push_to_remote:<remote>' 로 갈라진다.
// 사용자에게는 같은 버튼이므로 한 이름으로 모아 본다 — 갈라진 이름으로 예약해 두고
// 버튼은 평범하게 그리면, 눌러도 취소되지 않는 예약이 남는다. 두 번 예약되어 push 가
// 두 번 나가는 것도 여기서 막힌다.
function groupOf(id) {
  return id && id.startsWith('push_to_remote:') ? 'git-push' : id;
}

// 이 버튼/동작이 대표하는 예약 — 없으면 null.
function findFor(action) {
  if (!action) return null;
  const group = groupOf(action);
  return _queue.find(e => groupOf(e.id) === group) || null;
}

function hasFor(action) {
  return findFor(action) !== null;
}

function cancelFor(action) {
  const entry = findFor(action);
  return entry ? cancel(entry.id) : false;
}

function size() {
  return _queue.length;
}

function pending() {
  return _queue.map(e => ({ id: e.id, label: e.label, branch: e.branch, payload: e.payload }));
}

// 타이틀에 덧붙일 요약 — "Push" / "Stage 3" / "Stage 3 +1".
// 대상을 들고 가는 예약은 개수까지 보여 준다. 파일을 연달아 고르는 동안 몇 개가 실려
// 있는지가 곧 "내가 누른 것이 다 들어갔는가"에 대한 답이다.
function summary() {
  if (_queue.length === 0) return '';
  const head = _queue[0];
  const count = Array.isArray(head.payload) ? head.payload.length : 0;
  const first = count > 0 ? head.label + ' ' + count : head.label;
  return _queue.length > 1 ? first + ' +' + (_queue.length - 1) : first;
}

// ── 대상 합치기 ──
// 파일을 하나씩 고르며 s 를 연달아 누르는 흐름에서, 뒤에 누른 것이 앞의 예약을
// 덮어쓰거나 별개 예약으로 쌓이면 git 을 그만큼 여러 번 부른다. 프로세스 하나 띄우는
// 값이 비싼 환경이라 그 차이가 그대로 기다림이 된다 — 한 예약으로 합쳐 한 번에 부른다.
const MERGE = {
  union: (a, b) => {
    const prev = Array.isArray(a) ? a : [];
    const next = Array.isArray(b) ? b : [];
    const seen = new Set(prev);
    return prev.concat(next.filter(x => !seen.has(x)));
  },
};

// 이미 예약된 항목에 대상을 보탠다.
function mergePayload(entry, payload, strategy) {
  const merge = MERGE[strategy];
  if (!entry || !merge) return false;
  entry.payload = merge(entry.payload, payload);
  renderNow();
  return true;
}

// 예약. opts 는 actions.QUEUEABLE_ACTIONS 의 값 그대로다.
//   branch  — 실행 시점의 현재 브랜치가 예약할 때와 같아야 한다.
//   payload — 실행할 때 run(payload) 로 되돌려 줄 대상.
// 이미 같은 동작이 예약돼 있으면 그대로 둔다 — 두 번 누른 것이 두 번 실행이 되면
// 안 된다(취소와 합치기는 actions.guardOrQueue 가 갈라 맡는다).
function enqueue(id, run, opts, payload) {
  if (typeof run !== 'function') return false;
  if (findFor(id)) return false;
  _queue.push({
    id,
    run,
    payload,
    label: labelOf(id),
    at: Date.now(),
    branch: opts && opts.branch ? (state.branch || '') : null,
  });
  // 버튼이 "예약됨"으로 바뀌고 타이틀에 이름이 붙는다 — 눌린 것이 무시되지 않았다는
  // 유일한 신호이므로 여기서 직접 그린다. 호출부는 막힌 경로에서 대개 그리지 않는다.
  renderNow();
  return true;
}

function cancel(id) {
  const idx = _queue.findIndex(e => e.id === id);
  if (idx < 0) return false;
  _queue.splice(idx, 1);
  renderNow();
  return true;
}

function clear() {
  _queue = [];
  if (_drainTimer) {
    clearTimeout(_drainTimer);
    _drainTimer = null;
  }
}

// 예약을 유지할 수 없게 된 사유 — 없으면 null.
function staleReason(entry, now) {
  if (now - entry.at > TTL_MS) return 'waited too long';
  // 체크아웃이 도는 동안 Push 를 예약해 두면, 풀려날 때는 사용자가 누를 때 보고 있던
  // 브랜치가 아니라 새로 옮겨 간 브랜치가 올라간다. 그건 시킨 일이 아니다.
  if (entry.branch !== null && entry.branch !== (state.branch || '')) return 'branch changed';
  return null;
}

function notifyCancelled(entry, reason) {
  require('./spinner').showToast(entry.label + ' cancelled — ' + reason, 2400);
}

function renderNow() {
  require('./render').render();
}

// 자원이 풀렸는지 다시 보고, 통과한 예약을 실행한다.
// 앞에서부터 하나씩 본다 — 실행한 동작이 새 작업을 시작하면 뒤의 것은 그 작업과 다시
// 겹쳐 BUSY 로 남고, 그 작업이 끝날 때 또 판정된다.
function drain() {
  if (_draining || _queue.length === 0) return;
  _draining = true;
  let changed = false;
  try {
    const actions = require('./actions');
    const now = Date.now();
    let i = 0;
    while (i < _queue.length) {
      const entry = _queue[i];
      const stale = staleReason(entry, now);
      if (stale) {
        _queue.splice(i, 1);
        changed = true;
        notifyCancelled(entry, stale);
        continue;
      }
      const reason = actions.disabledReason(entry.id);
      // 아직 풀리지 않았다 — 다음 작업이 끝날 때 다시 본다. 첫 스캔 중(LOADING)도
      // 곧 끝나는 상태이므로 기다린다.
      if (reason === actions.REASON.BUSY || reason === actions.REASON.LOADING) {
        i++;
        continue;
      }
      _queue.splice(i, 1);
      changed = true;
      if (reason !== null) {
        notifyCancelled(entry, reason);
        continue;
      }
      try {
        entry.run(entry.payload);
      } catch (e) {
        notifyCancelled(entry, (e && e.message) || 'failed to start');
      }
    }
  } finally {
    _draining = false;
  }
  if (changed) renderNow();
}

// 작업이 끝나는 순간 곧바로 부르면, 그 작업을 끝내는 도중(endOp 안)에 새 작업이
// 시작되어 등록부를 다시 건드린다. 한 틱 미뤄 끝내는 일이 다 끝난 뒤에 본다.
function scheduleDrain() {
  if (_queue.length === 0 || _drainTimer) return;
  _drainTimer = setTimeout(() => {
    _drainTimer = null;
    drain();
  }, 0);
  // 예약이 남아 있다는 이유로 프로세스가 살아 있을 이유는 없다.
  if (_drainTimer && typeof _drainTimer.unref === 'function') _drainTimer.unref();
}

module.exports = {
  enqueue, mergePayload, cancel, cancelFor, clear, has, hasFor, findFor,
  size, pending, summary, labelOf, drain, scheduleDrain,
};
