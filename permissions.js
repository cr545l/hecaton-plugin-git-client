// permissions.js — 권한 획득과 그때 보여 줄 설명 (호스트 API 1.15)
//
// 호스트는 보호된 API를 처음 부르면 스스로 승인 팝업을 띄운다. 그 팝업에는
// "무엇에 접근하는지"(호스트가 쓴다)와 "왜 필요한지"(플러그인이 쓴다)가 함께 나오는데,
// 후자를 우리가 주지 않으면 목적란 자체가 빠진 채 뜬다 — 사용자는 git-client 가
// 왜 이 프로그램을 실행하려는지 모르는 상태로 예/아니오를 골라야 한다.
//
// 그래서 설명을 두 층으로 붙인다 (dev.hecaton.demo 의 permissions 레시피와 같은 구조).
//   1) plugin.json 의 permission_usage_descriptions — 자동 프롬프트의 기본 설명.
//      호스트가 FormatPermissionPrompt 에서 읽어 목적란에 넣는다.
//   2) permissions.request({ reason }) — 이 작업에 한정한 구체적 설명. 기본값보다 우선한다.
//      사용자가 방금 고른 동작("복사", "탐색기에서 열기")을 그대로 문장에 담을 수 있다.
//
// 규칙 (호스트 계약)
//  - 설명은 권한을 넓히지도 좁히지도 않는다. 결정은 사용자 것이고 granted=false 면 멈춘다.
//  - 경로 기반 권한(fs_read/fs_write/process_exec)은 path 가 필수다. process_exec 의
//    path 는 프로그램 이름이어도 되며 호스트가 실행 파일 경로로 해석한다.
//  - 경로가 없는 권한(clipboard_*, open_tab)에 path 를 넘기면 invalid_params 다.
//  - state 가 prompt 일 때만 request 한다. 이미 허용·거부된 결정은 팝업을 다시 열지 않는다.
//  - 프리플라이트로 받은 승인은 호스트가 이 플러그인 세션 동안 유지해 준다
//    (RememberSessionPathPermission / SessionAllowFlag) — 폴링마다 팝업이 뜨지 않는다.
//
// fs_read / fs_write 는 여기서 프리플라이트하지 않는다. 읽는 경로가 저장소마다
// 수십 개라 경로별로 request 를 걸면 팝업이 쏟아지고, 호스트 자동 프롬프트가
// 이미 같은 시점에 plugin.json 의 기본 설명을 붙여 준다 — 설명을 더할 수단이
// 필요했을 뿐 흐름을 바꿀 이유는 없다.

const { t, translations } = require('./i18n');

// (권한, 경로) → 'granted' | 'denied' | 'unsupported'
// 'prompt' 는 담지 않는다 — 결정 전이라 매번 다시 물어야 한다.
const decided = new Map();
// 거부 안내는 같은 권한에 한 번만 띄운다. 폴링이 계속 두드리는 경로라 토스트가 쌓인다.
const noticed = new Set();

function cacheKey(permission, path) {
  return permission + '\u0000' + (path || '');
}

// 거부 안내는 호출부가 먼저 띄운 "복사했습니다" 류의 낙관적 안내보다 늦게 떠서 그것을
// 덮는다 — 마지막에 남는 말이 실제로 일어난 일이 되도록 TTL 도 조금 길게 잡는다.
function toast(messageKey) {
  if (!messageKey) return;
  try {
    require('./spinner').showToast(t(messageKey), 2000);
  } catch { /* 렌더 준비 전이면 조용히 넘어간다 — 권한 판정 자체를 막을 이유가 없다 */ }
}

// 권한을 확보한다. true 면 호출을 진행해도 된다.
//
// 구형 호스트(1.4 미만)나 permissions 네임스페이스가 없는 실행기에서는 true 를 돌려준다 —
// 게이트가 없다는 이유로 기능을 끄면 안 되고, 그 경우 호스트 자동 프롬프트가 그대로 남는다.
async function ensure(permission, reasonKey, opts) {
  const options = opts || {};
  const path = options.path || '';
  const key = cacheKey(permission, path);
  const cached = decided.get(key);
  if (cached === 'granted' || cached === 'unsupported') return true;
  if (cached === 'denied') {
    if (!noticed.has(permission)) {
      noticed.add(permission);
      toast(options.deniedKey);
    }
    return false;
  }

  const req = { permission };
  if (path) req.path = path;

  let query = null;
  try {
    query = await hecaton.permissions.query(req);
  } catch {
    decided.set(key, 'unsupported');
    return true;
  }
  // ok=false 는 대개 not_found(프로그램 없음)다. 실제 호출이 같은 이유로 실패하며
  // 그쪽 에러가 훨씬 구체적이므로 여기서 가로채지 않는다.
  if (!query || query.ok === false) {
    decided.set(key, 'unsupported');
    return true;
  }
  if (query.state === 'granted' || query.granted === true) {
    decided.set(key, 'granted');
    return true;
  }
  if (query.state === 'denied') {
    decided.set(key, 'denied');
    noticed.add(permission);
    toast(options.deniedKey);
    return false;
  }

  let result = null;
  try {
    result = await hecaton.permissions.request({ ...req, reason: translations(reasonKey) });
  } catch {
    decided.set(key, 'unsupported');
    return true;
  }
  if (result && result.granted === true) {
    decided.set(key, 'granted');
    return true;
  }
  // 거부는 기록한다 — 호스트도 저장하므로 다시 물어도 팝업이 뜨지 않는다.
  decided.set(key, 'denied');
  if (!noticed.has(permission)) {
    noticed.add(permission);
    toast(options.deniedKey);
  }
  return false;
}

// 프리플라이트 이후에도 사용자가 설정에서 권한을 되돌릴 수 있다. 실제 호출이
// access_denied 로 돌아오면 캐시된 'granted' 를 버려 다음 호출이 다시 확인하게 한다.
function forget(permission, path) {
  decided.delete(cacheKey(permission, path));
}

function deniedResult(messageKey) {
  return {
    ok: false, error_code: 'access_denied', stdout: '',
    stderr: messageKey ? t(messageKey) : '', exit_code: null,
  };
}

// hecaton.process.exec 의 자리를 그대로 대신한다 — 반환 형태가 같아 호출부의
// ok/exit_code 처리는 손대지 않는다. 거부는 실패한 실행과 같은 모양으로 돌려준다.
//
// opts.deniedKey 는 거부됐을 때 알릴 문구다. 사용자가 시작하지 않은 배경 작업
// (고아 프로세스 정리 같은)에는 주지 않는다 — 스스로 부른 적 없는 일의 실패를
// 토스트로 받아 볼 이유가 없다.
async function exec(params, reasonKey, opts) {
  const options = opts || {};
  const program = params && params.program;
  const allowed = await ensure('process_exec', reasonKey, { path: program, deniedKey: options.deniedKey });
  if (!allowed) return deniedResult(options.deniedKey);
  const result = await hecaton.process.exec(params);
  if (result && result.error_code === 'access_denied') forget('process_exec', program);
  return result;
}

// git 실행은 모두 같은 사유를 쓴다 — 어느 하위 명령이든 사용자가 연 저장소를 읽거나 바꾼다.
// 사유를 호출부마다 적지 않는 편이 문구를 한 곳에서 고칠 수 있어 낫다.
function execGit(params) {
  return exec(params, 'permission.reason.gitExec', { deniedKey: 'permission.denied.gitExec' });
}

async function clipboardWrite(text, reasonKey, deniedKey) {
  const allowed = await ensure('clipboard_write', reasonKey, { deniedKey });
  if (!allowed) return { ok: false, error_code: 'access_denied' };
  const result = await hecaton.clipboard.write({ text }).catch(() => null);
  if (result && result.error_code === 'access_denied') forget('clipboard_write');
  return result;
}

// 거부와 "빈 클립보드"를 호출부가 구분할 수 있게 결과 모양을 남긴다 — 거부는 이미
// 토스트로 알렸으므로 호출부가 "클립보드에 없다"는 안내를 겹쳐 띄우면 안 된다.
async function clipboardRead(reasonKey, deniedKey) {
  const allowed = await ensure('clipboard_read', reasonKey, { deniedKey });
  if (!allowed) return { ok: false, error_code: 'access_denied' };
  const result = await hecaton.clipboard.read().catch(() => null);
  if (result && result.error_code === 'access_denied') forget('clipboard_read');
  return result;
}

async function openOverlay(params, reasonKey, deniedKey) {
  const allowed = await ensure('open_tab', reasonKey, { deniedKey });
  if (!allowed) return { ok: false, error_code: 'access_denied' };
  const result = await hecaton.overlay.open(params).catch(() => null);
  if (result && result.error_code === 'access_denied') forget('open_tab');
  return result;
}

// 테스트가 세션 사이에 판정을 끌고 가지 않도록.
function reset() {
  decided.clear();
  noticed.clear();
}

module.exports = {
  ensure, exec, execGit, clipboardWrite, clipboardRead, openOverlay, forget, reset,
};
