// 같은 저장소를 여러 인스턴스가 동시에 열었을 때 중복 git 실행을 없애는 공유 계층.
//
// 인스턴스마다 2~3초 주기로 폴링을 돌리면 git 프로세스 스폰(Windows에서 60ms 남짓)과
// .git 락 경합이 인스턴스 수만큼 곱해진다. 폴링 결과와 네트워크 작업 진행 상태를
// .git 아래 공유 파일로 주고받아, 실제 git 실행은 한 인스턴스만 하고 나머지는 그
// 결과를 읽는다.
//
// 모든 동작은 best-effort다. 공유 파일을 못 읽거나 못 쓰면 각 인스턴스가 종전대로
// 자기 git을 돌린다 — 느려질 뿐 결과가 틀리지는 않는다.
//
// 그래서 폴링 스냅샷 쪽에는 락도 선점도 두지 않았다. 폴링 타이머가 겹쳐 두 인스턴스가
// 같은 틱에 실행해봐야 최적화 이전과 같을 뿐이고, 다음 틱부터는 먼저 publish한 쪽으로
// 자연히 수렴한다. 반면 네트워크 작업은 겹치면 실제로 서로를 느리게 만들기 때문에
// 진행 상태를 명시적으로 기록해 조율한다.

const nodePath = require('path');

const SHARE_DIR_NAME = 'hecaton-git-client';

// 이 프로세스를 식별한다. pid만으로는 재사용된 pid와 충돌할 수 있어 난수를 덧붙인다.
const INSTANCE_ID = (function () {
  const pid = (typeof process !== 'undefined' && process.pid) ? process.pid : 0;
  return String(pid) + '-' + Math.random().toString(36).slice(2, 8);
})();

let _shareDir = '';       // 공유 파일 디렉터리 (빈 문자열이면 조율 비활성)
let _cwdKey = '';         // 워크트리 구분용 키 — 같은 저장소라도 워크트리가 다르면 스냅샷은 공유 불가
let _dirReady = false;
// Local ownership lasts until completion; elapsed time is not evidence of exit.
let _localNetworkOp = null;

function hashKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {  // i18n-ok: 문자 인덱스(커서·substring) — 표시 폭이 아니다
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// gitCommonDir 기준이라 linked worktree들도 같은 디렉터리를 공유한다. 네트워크 작업은
// 저장소 전체에 영향을 주므로 이 단위가 맞고, 워크트리별로 갈라야 하는 스냅샷은
// _cwdKey를 파일명에 섞어 분리한다.
function configure(gitCommonDir, cwd) {
  const common = String(gitCommonDir || '').trim();
  if (!common) { _shareDir = ''; _dirReady = false; return; }
  const next = nodePath.join(common, SHARE_DIR_NAME);
  // refresh.js 와 main.js 가 각자 rev-parse 결과로 부른다. 드라이브 문자 대소문자만 다른
  // 같은 경로로 번갈아 불려도 매번 디렉터리를 다시 만들지 않게 대소문자를 무시해 견준다.
  if (normalizePath(next) !== normalizePath(_shareDir)) _dirReady = false;
  _shareDir = next;
  const nextKey = hashKey(normalizePath(cwd));
  if (nextKey !== _cwdKey) { _peerSeenAt = {}; _lastPublishAt = {}; }
  _cwdKey = nextKey;
}

// 폴링 스냅샷은 "같은 워크트리를 보는 다른 창"이 있을 때만 쓸모가 있다. 그런데 워크트리마다
// 창을 하나씩 띄우는 쓰임에서는 받아 갈 상대가 없는데도 틱마다 파일을 다시 썼다(2026-11-10
// 실측: 창 9개가 2초마다 각자 12KB). 파일 쓰기 하나하나가 보안 제품 검사를 거치는
// 환경이라 그 자체가 부하다. 그래서 상대를 본 적이 없으면 드문드문만 쓴다 — 그 드문 쓰기가
// 새로 뜬 창에게 "여기 누가 있다"를 알리는 신호가 되고, 서로를 보면 예전처럼 매번 쓴다.
const PEER_WINDOW_MS = 60000;
const SOLO_PUBLISH_INTERVAL_MS = 30000;
let _peerSeenAt = {};
let _lastPublishAt = {};

function peerRecentlySeen(kind) {
  return !!_peerSeenAt[kind] && (Date.now() - _peerSeenAt[kind]) < PEER_WINDOW_MS;
}

function isEnabled() {
  return !!_shareDir && !!hecaton && !!hecaton.fs;
}

async function ensureDir() {
  if (_dirReady || !isEnabled()) return _dirReady;
  try {
    await hecaton.fs.mkdir({ path: _shareDir, recursive: true });
    _dirReady = true;
  } catch { _dirReady = false; }
  return _dirReady;
}

// kind는 파일명이 되므로 호출부가 넘기는 짧은 식별자만 허용한다.
function sharedPath(kind, perWorktree) {
  const name = perWorktree ? (kind + '-' + _cwdKey + '.json') : (kind + '.json');
  return nodePath.join(_shareDir, name);
}

async function readJson(path) {
  try {
    const res = await hecaton.fs.read_file({ path });
    const content = typeof res === 'string' ? res : (res && res.content) ? res.content : '';
    if (!content) return null;
    // 다른 인스턴스가 쓰는 도중이면 잘린 JSON을 읽을 수 있다. 파싱 실패는 그냥 미스로 친다.
    return JSON.parse(content);
  } catch { return null; }
}

async function writeJson(path, value) {
  try {
    await hecaton.fs.write_file({ path, content: JSON.stringify(value) });
    return true;
  } catch { return false; }
}

// 저장소 단위(워크트리 공통) JSON 파일. 히스토리 캐시처럼 같은 저장소의 모든 창이 함께
// 쓰는 것을 둔다. 읽기 실패·깨진 내용은 null, 쓰기 실패는 false — 호출부는 캐시 없이 간다.
async function readRepoJson(kind) {
  if (!isEnabled() || !await ensureDir()) return null;
  return await readJson(sharedPath(kind, false));
}

async function writeRepoJson(kind, value) {
  if (!isEnabled() || !await ensureDir()) return false;
  return await writeJson(sharedPath(kind, false), value);
}

// ── 저장소 단위 조회 결과 공유 ──────────────────────────────────────────────
//
// 같은 저장소의 워크트리마다 창을 하나씩 띄우는 쓰임에서는 한 워크트리의 커밋 하나가 공용
// refs 를 바꾸고, 모든 창이 같은 조회를 동시에 각자 돌렸다(2026-11-18 Com2uX 실측: 워크트리
// 30여 개에 창 14개, 메타 조회 1,356회가 실제로는 303번의 변경이었고 한 번에 최대 13개 창이
// 함께 돌았다 — git 시간의 63%). 결과가 워크트리와 무관한 조회는 여기서 한 번만 돌린다:
//   1. 같은 입력(key)으로 저장된 결과가 있으면 그대로 쓴다.
//   2. 다른 창이 같은 입력으로 조회 중이면 끝나기를 기다렸다가 그 결과를 쓴다.
//   3. 아니면 직접 돌리고, 성공한 결과를 저장한다.
// key 는 그 조회가 읽는 파일들의 지문이다 — 지문이 같으면 결과도 같다는 것이 전제다.
// 기다림은 상대가 살아 있는(heartbeat) 동안, 최대 SHARED_QUERY_MAX_WAIT_MS 까지다. 그 뒤에는
// 남의 조회를 건드리지 않고 내 것을 따로 돌린다 — 기다리다 화면이 묶이는 것보다 낫다.
const SHARED_QUERY_HEARTBEAT_MS = 5000;
const SHARED_QUERY_STALE_MS = 15000;
const SHARED_QUERY_POLL_MS = 300;
const SHARED_QUERY_MAX_WAIT_MS = 60000;

async function readSharedResult(kind, key, maxAgeMs, validate) {
  const cached = await readRepoJson(kind + 'cache');
  if (!cached || cached.key !== key || cached.value === undefined) return undefined;
  if (maxAgeMs > 0) {
    const age = Date.now() - (cached.savedAt || 0);
    // 시계 역행으로 생긴 미래 시각도 신선한 것으로 치지 않는다.
    if (!(age >= 0 && age < maxAgeMs)) return undefined;
  }
  // 다른 버전의 코드가 남긴 모양이 다른 값은 미스로 친다.
  if (validate && !validate(cached.value)) return undefined;
  return cached.value;
}

// run() 은 { value, share } 를 돌려준다. value 는 이 창이 쓸 결과, share 는 다른 창에 넘길
// 결과다 — share 가 undefined 면(실패한 조회) 저장하지 않는다. 실패를 저장하면 지문이 바뀔
// 때까지 모든 창이 빈 목록에 묶인다.
// 반환: { value, shared }. shared 가 true 면 value 는 저장돼 있던(남이 돌린) share 값이다.
// opts.force     저장된 결과와 진행 중인 남의 조회를 무시하고 직접 돌린다(결과는 저장한다).
// opts.maxAgeMs  저장된 결과의 유효 기간 — 지문으로 다 잡을 수 없는 입력이 있는 조회용.
// opts.validate  저장된 값이 쓸 만한 모양인지.
async function sharedRepoQuery(kind, key, run, opts) {
  const force = !!(opts && opts.force);
  const maxAgeMs = (opts && opts.maxAgeMs) || 0;
  const validate = opts && opts.validate;
  if (!key || !isEnabled() || !await ensureDir()) {
    const own = await run();
    return { value: own ? own.value : undefined, shared: false };
  }
  // 진행 기록에는 지문 대신 해시만 적는다 — 지문은 refs 목록이라 수십 KB 가 되고, 진행
  // 기록은 기다리는 창들이 짧은 간격으로 읽는다. 해시가 우연히 겹쳐도 결과를 받을 때
  // 지문 전체를 견주므로 엉뚱한 결과를 쓰지는 않는다(기다린 시간만 버린다).
  const keyHash = hashKey(key);
  if (!force) {
    const hit = await readSharedResult(kind, key, maxAgeMs, validate);
    if (hit !== undefined) return { value: hit, shared: true };
    const deadline = Date.now() + SHARED_QUERY_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const flight = await readRepoJson(kind + 'flight');
      if (!flight || flight.owner === INSTANCE_ID || flight.keyHash !== keyHash) break;
      if (flight.finishedAt) {
        const done = await readSharedResult(kind, key, maxAgeMs, validate);
        if (done !== undefined) return { value: done, shared: true };
        break; // 상대의 조회가 실패로 끝났다 — 직접 돌린다.
      }
      if (Date.now() - (flight.heartbeatAt || 0) >= SHARED_QUERY_STALE_MS) break;
      await new Promise(resolve => setTimeout(resolve, SHARED_QUERY_POLL_MS));
    }
  }
  const record = { owner: INSTANCE_ID, keyHash, startedAt: Date.now(), heartbeatAt: Date.now(), finishedAt: 0 };
  await writeRepoJson(kind + 'flight', record);
  // heartbeat 쓰기를 한 줄로 세운다 — 늦게 끝난 heartbeat 가 완료 기록을 덮으면 기다리는
  // 창들이 만료(SHARED_QUERY_STALE_MS)까지 헛되이 기다린다.
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(() => {
      if (record.finishedAt) return null;
      record.heartbeatAt = Date.now();
      return writeRepoJson(kind + 'flight', record);
    }).catch(() => null);
  }, SHARED_QUERY_HEARTBEAT_MS);
  if (timer && timer.unref) timer.unref();
  let ownResult;
  try {
    ownResult = await run();
    if (ownResult && ownResult.share !== undefined) {
      // 완료 표시보다 먼저 써야 기다리던 창이 결과를 놓치지 않는다.
      await writeRepoJson(kind + 'cache', { key, savedAt: Date.now(), owner: INSTANCE_ID, value: ownResult.share });
    }
  } finally {
    clearInterval(timer);
    record.finishedAt = Date.now();
    await pending;
    await writeRepoJson(kind + 'flight', record);
  }
  return { value: ownResult ? ownResult.value : undefined, shared: false };
}

// 동작 시간 기록(timing.js)의 저장. 인스턴스마다 한 파일(suffix 'prev' 는 직전 묶음)이다.
async function writeTimingLog(content, suffix) {
  if (!isEnabled() || !await ensureDir()) return false;
  const name = 'timing-' + INSTANCE_ID + (suffix ? '.' + suffix : '') + '.log';
  try {
    await hecaton.fs.write_file({ path: nodePath.join(_shareDir, name), content });
    return true;
  } catch { return false; }
}

// 다른 인스턴스가 maxAgeMs 안에 올려둔 폴링 결과가 있으면 그대로 쓴다.
// 반환값이 null이면 호출부가 직접 git을 돌려야 한다는 뜻이다.
async function readSharedSnapshot(kind, maxAgeMs) {
  if (!isEnabled() || !await ensureDir()) return null;
  const data = await readJson(sharedPath(kind, true));
  if (!data || typeof data.publishedAt !== 'number') return null;
  const age = Date.now() - data.publishedAt;
  // 쓰기에는 너무 낡았더라도, 남이 최근에 올린 것이면 같은 워크트리에 다른 창이 있다는 뜻이다.
  if (data.owner && data.owner !== INSTANCE_ID && age >= 0 && age < PEER_WINDOW_MS) _peerSeenAt[kind] = Date.now();
  // 시계 역행이나 남의 저장소에서 복사된 파일 같은 이상값은 신선한 것으로 오인하지 않는다.
  if (age < 0 || age > maxAgeMs) return null;
  if (data.value === undefined) return null;
  return { value: data.value, ageMs: age, owner: data.owner || '' };
}

// opts.soloThrottle: 받아 갈 상대를 본 적이 없으면 SOLO_PUBLISH_INTERVAL_MS 에 한 번만 쓴다.
async function publishSharedSnapshot(kind, value, opts) {
  if (!isEnabled() || !await ensureDir()) return false;
  if (opts && opts.soloThrottle && !peerRecentlySeen(kind)
      && _lastPublishAt[kind] && (Date.now() - _lastPublishAt[kind]) < SOLO_PUBLISH_INTERVAL_MS) {
    return false;
  }
  _lastPublishAt[kind] = Date.now();
  return await writeJson(sharedPath(kind, true), {
    publishedAt: Date.now(),
    owner: INSTANCE_ID,
    value,
  });
}

// ── 네트워크 작업(fetch/pull/push) 조율 ──────────────────────────────────────
//
// 같은 저장소에 두 인스턴스가 동시에 fetch를 걸면 .git 락을 서로 기다리느라 둘 다
// 느려진다. 진행 중인 작업이 있으면 새로 걸지 않고 그 결과를 기다린 뒤 화면만
// 갱신하는 편이 빠르다.

const NETOP_KIND = 'netop';
// Shared records expire by heartbeat, not by total operation duration.
const NETOP_STALE_MS = 30 * 60 * 1000 + 30000;

function keepNetworkOpAlive() {
  const target = isEnabled() ? sharedPath(NETOP_KIND, false) : '';
  let pending = Promise.resolve(), stopped = false;
  const timer = target ? setInterval(() => {
    pending = pending.then(async () => {
      if (stopped) return;
      const data = await readJson(target);
      if (!data || data.owner !== INSTANCE_ID || data.finishedAt) return;
      data.heartbeatAt = Date.now();
      await writeJson(target, data);
    }).catch(() => {});
  }, 10000) : null;
  if (timer && timer.unref) timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    // Drain the heartbeat before publishing completion.
    await pending;
  };
}

async function readNetOp() {
  if (!isEnabled() || !await ensureDir()) return null;
  return await readJson(sharedPath(NETOP_KIND, false));
}

// 다른 인스턴스가 지금 네트워크 작업 중인지. 기다릴 대상이 있는지 판정한다.
// 내 기록은 제외해야 한다 — 내 대기 플래그까지 세면 자기 자신을 기다리다 타임아웃한다.
async function isRemoteNetworkOpInFlight() {
  const data = await readNetOp();
  if (!data || typeof data.startedAt !== 'number') return false;
  if (data.owner === INSTANCE_ID) return false;
  if (data.finishedAt && data.finishedAt >= data.startedAt) return false;
  return (Date.now() - (data.heartbeatAt || data.startedAt)) < NETOP_STALE_MS;
}

// 이 저장소에서 네트워크 작업이 도는 중인지. 폴링 억제 판단에 쓴다.
// 남의 작업뿐 아니라 내가 실행/대기 중인 경우도 폴링을 멈춰야 하므로 로컬 플래그를 함께 본다.
async function isNetworkOpInFlight() {
  if (_localNetworkOp) return true; // Only real completion releases our operation.
  return await isRemoteNetworkOpInFlight();
}

// 네트워크 작업을 시작해도 되는지 판정한다.
//   'run'      — 내가 실행한다 (시작을 공유 파일에 기록)
//   'inflight' — 다른 인스턴스가 같은 작업을 하는 중이다. 기다렸다 새로고침만 하면 된다.
//   'reuse'    — 방금 다른 인스턴스가 끝냈다. 다시 돌릴 필요가 없다.
// reuseWindowMs를 0으로 주면 'reuse' 판정을 하지 않는다(pull/push처럼 결과를 남이
// 대신 내줄 수 없는 작업용).
async function beginNetworkOp(op, reuseWindowMs) {
  _localNetworkOp = { op, startedAt: Date.now() };
  if (!isEnabled() || !await ensureDir()) return 'run';
  const data = await readNetOp();
  const now = Date.now();
  if (data && typeof data.startedAt === 'number') {
    const running = (!data.finishedAt || data.finishedAt < data.startedAt)
      && (now - (data.heartbeatAt || data.startedAt)) < NETOP_STALE_MS
      && data.owner !== INSTANCE_ID;
    if (running) return 'inflight';
    const reusable = reuseWindowMs > 0
      && data.op === op
      && data.ok === true
      && typeof data.finishedAt === 'number'
      && (now - data.finishedAt) >= 0
      && (now - data.finishedAt) < reuseWindowMs;
    if (reusable) return 'reuse';
  }
  await writeJson(sharedPath(NETOP_KIND, false), {
    op, owner: INSTANCE_ID, startedAt: now, finishedAt: 0, ok: false,
  });
  return 'run';
}

// 남의 진행 기록을 밀어내고 내 작업으로 표시한다. 기다려도 끝나지 않아 직접
// 실행하기로 한 경우에만 쓴다 — 그냥 실행하면 내 작업이 아무 기록 없이 돌아가고,
// 다른 인스턴스는 그 사이 같은 작업을 또 걸게 된다.
async function claimNetworkOp(op) {
  _localNetworkOp = { op, startedAt: Date.now() };
  if (!isEnabled() || !await ensureDir()) return;
  await writeJson(sharedPath(NETOP_KIND, false), {
    op, owner: INSTANCE_ID, startedAt: Date.now(), finishedAt: 0, ok: false,
  });
}

async function endNetworkOp(op, ok) {
  _localNetworkOp = null;
  if (!isEnabled() || !_dirReady) return;
  const data = await readNetOp();
  // 내가 시작한 기록일 때만 닫는다. 남의 작업 기록을 덮으면 그쪽이 inflight 판정을 잃는다.
  if (!data || data.owner !== INSTANCE_ID) return;
  data.op = op;
  data.finishedAt = Date.now();
  data.ok = !!ok;
  await writeJson(sharedPath(NETOP_KIND, false), data);
}

// 진행 중인 남의 작업이 끝날 때까지 기다린다. 끝났으면 true.
async function waitForNetworkOp(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    if (!await isRemoteNetworkOpInFlight()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

module.exports = {
  INSTANCE_ID,
  keepNetworkOpAlive,
  // 테스트용: 응답이 돌아오지 않은 작업을 흉내내기 위해 시작 시각만 되돌린다.
  __setLocalNetworkOpStartedAt(ms) { if (_localNetworkOp) _localNetworkOp.startedAt = ms; },
  configure,
  isEnabled,
  readSharedSnapshot,
  publishSharedSnapshot,
  readRepoJson,
  writeRepoJson,
  sharedRepoQuery,
  hashKey,
  beginNetworkOp,
  claimNetworkOp,
  endNetworkOp,
  isNetworkOpInFlight,
  waitForNetworkOp,
  writeTimingLog,
};
