// 호스트 툴팁 (hecaton.window.set_tooltip).
//
// 마우스 옆에 짧은 설명을 띄우는 일은 호스트가 창 위에 직접 그린다 — 터미널 격자에
// 얹는 것과 달리 아래 내용을 지우지 않고, 화면 끝에서 알아서 접히며, 마우스를 따라간다.
// 그래서 플러그인은 "무슨 글자를 띄울지"만 정하고 자리 계산은 하지 않는다.
//
// 규칙 두 가지가 이 모듈의 존재 이유다:
//  - 툴팁은 창 전역 상태다. 띄운 채로 플러그인이 죽으면 그대로 남으므로 종료 경로에서
//    반드시 지운다(reset). 종료 중에는 응답을 기다리면 영영 돌아오지 않으므로 던지고 만다.
//  - 마우스가 움직일 때마다 RPC 를 쏘면 IPC 가 폭주한다. 마지막으로 보낸 글자를 기억해
//    실제로 달라질 때만 보낸다.
//
// set_tooltip 이 없는 호스트도 있다. 한 번 실패하면 래치를 세우고 다시 부르지 않으며,
// 부르는 쪽은 isSupported() 로 그것을 알고 자기 나름의 표시로 내려간다
// (render.js 는 프레임 위에 직접 그린다).

let _supported;        // undefined = 아직 프로빙 전
let _applied = '';     // 마지막으로 호스트에 보낸 글자

function isSupported() {
  if (_supported === undefined) {
    const w = globalThis.hecaton && hecaton.window;
    _supported = !!(w && typeof w.set_tooltip === 'function');
  }
  return _supported;
}

// 실패는 한 번만 겪는다 — 이후로는 부르지 않고 부르는 쪽이 폴백으로 내려간다.
function _send(text) {
  try {
    hecaton.window.set_tooltip({ text }).catch(() => { _supported = false; });
  } catch {
    _supported = false;
  }
}

// 띄울 글자. 빈 문자열이면 지운다. 같은 글자를 다시 넣는 것은 값이 없으므로 흘린다.
function show(text) {
  const next = text || '';
  if (!isSupported() || next === _applied) return;
  _applied = next;
  _send(next);
}

function hide() {
  show('');
}

// 종료 경로용 — 지원 여부와 관계없이 한 번 던지고 응답을 기다리지 않는다.
// 래치가 서 있어도 부른다: 래치는 "이번 세션에서 실패했다"일 뿐이고, 남은 툴팁을
// 지우려는 마지막 시도까지 막을 이유는 없다.
function reset() {
  _applied = '';
  const w = globalThis.hecaton && hecaton.window;
  if (!w || typeof w.set_tooltip !== 'function') return;
  try { w.set_tooltip({ text: '' }).catch(() => {}); } catch { /* 종료 중이면 무시 */ }
}

module.exports = { isSupported, show, hide, reset };
