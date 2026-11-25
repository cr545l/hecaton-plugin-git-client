const path = require('path');

// Requests drive polling; no clients requesting means no background Git work.
// Each worktree owns one in-flight query and one shared adaptive cooldown.
//
// 'worktree.snapshot'  는 스냅샷 문자열만 돌려준다(이전 버전 창과의 호환).
// 'worktree.snapshot2' 는 { snapshot, startedAt } 을 돌려준다. startedAt 은 그 스냅샷을 만든
// 조회가 시작된 시각이다 — 대기 구간에는 직전 결과를 다시 내주므로, 받는 쪽이 자기 목록보다
// 새것인지 판단하려면 이 시각이 있어야 한다(refresh.js applyPolledStatus).
//
// 'meta.signature' 는 { sig, shareable } 을 돌려준다 — .git 메타 지문(meta-signature.js)이다.
// 창마다 2초 주기로 따로 계산하던 것을 저장소당 한 번으로 묶는다.
const SNAPSHOT_METHODS = new Set(['worktree.snapshot', 'worktree.snapshot2']);

// ── status 를 띄울지의 판단 ──
//
// 워크트리마다 창을 하나씩 띄우는 쓰임에서는 묶을 중복이 없어, 서비스가 있어도 워크트리
// 수만큼의 status 가 3초마다 돌았다(2026-11-25 실측: 창 15개, 프로세스 생성마다 보안 제품
// 검사가 붙는 환경에서 그 자체가 부하). status 는 워크트리별 index·작업 파일을 읽는 명령이라
// 워크트리끼리 결과를 나눠 쓸 수도 없다. 그래서 띄우는 횟수 자체를 줄인다:
//
//   1. 창이 gitDir 과 idleMs(마지막 입력 뒤 지난 시간)를 함께 보낸다. 보내지 않는 이전 버전
//      창은 종전대로(쿨다운마다 status) 다룬다.
//   2. 최근에 입력이 있던 창의 워크트리는 종전대로 돈다 — 보고 있는 화면은 늦추지 않는다.
//   3. 그 밖의 워크트리는 git 없이 확인한다: 그 워크트리의 index·HEAD 시각과, 직전 status 가
//      변경됐다고 한 파일들의 시각. 달라졌을 때만 status 를 띄운다.
//   4. 그 확인으로 못 잡는 변화(깨끗하던 파일의 첫 수정, 새 파일)를 위해 status 를 드문드문
//      돌린다. 결과가 직전과 같을수록 간격을 늘리고(IDLE_STEPS), 달라지면 처음으로 되돌린다.
const ACTIVE_MS = 30000;
const IDLE_STEPS = [3000, 6000, 12000, 30000, 60000];
const PROBE_INTERVAL_MS = 3000;
// 동시에 떠 있는 status 의 상한. 창들이 한꺼번에 뜨거나 간격이 우연히 겹치면 워크트리 수만큼이
// 같은 순간에 떴다. 넘치는 것은 줄을 서고, 입력이 있던 창의 것이 앞에 선다.
const MAX_CONCURRENT = 2;

function invalid() {
  return new Error('Invalid polling request'); // i18n-ok: internal service protocol diagnostic
}

//
// 'repo.activity' 는 응답 없는 알림이다 — 창이 저장소를 열었을 때와 입력이 있을 때 보낸다.
// 유휴 정리(maintenance.js)가 언제 돌고 멈출지를 여기서 안다.
//
// readOwn({ gitDir })            그 워크트리 git dir 의 지문(문자열). git 을 띄우지 않는다.
// dirtyUnchanged(cwd, snapshot)  스냅샷에 실린 변경 파일들의 시각이 그대로인지.
// 둘 중 하나라도 없으면 위 3·4 를 쓰지 않고 종전대로 돈다.
function createPollingService({
  buildSnapshot, readMeta, readOwn, dirtyUnchanged, maintenance,
  now = Date.now, platform = process.platform, maxConcurrent = MAX_CONCURRENT,
}) {
  const entries = new Map();
  const canGate = typeof readOwn === 'function' && typeof dirtyUnchanged === 'function';

  let running = 0;
  const waiting = [];
  function release() {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
  function runLimited(task, urgent) {
    const start = () => { running++; return Promise.resolve().then(task).finally(release); };
    if (running < maxConcurrent) return start();
    return new Promise(resolve => {
      const go = () => resolve(start());
      if (urgent) waiting.unshift(go); else waiting.push(go);
    });
  }

  function keyFor(cwd) {
    const resolved = path.resolve(cwd);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function runStatus(entry, cwd, gate, urgent) {
    let startedAt = now();
    entry.pending = runLimited(async () => {
      // 줄을 섰다면 실제로 시작한 시각이 조회 시각이다.
      startedAt = now();
      // status 보다 먼저 읽는다 — 도는 사이의 변경은 다음 확인에서 "달라졌다"로 잡힌다.
      const own = gate ? await Promise.resolve().then(() => readOwn(gate)).catch(() => null) : null;
      const snapshot = await buildSnapshot(cwd);
      return { snapshot, own };
    }, urgent).then(({ snapshot, own }) => {
      const ok = snapshot !== null && snapshot !== undefined;
      entry.streak = ok && snapshot === entry.result.snapshot ? entry.streak + 1 : 0;
      entry.own = ok ? own : null;
      entry.result = { snapshot, startedAt };
      return entry.result;
    }).catch(() => {
      entry.streak = 0;
      entry.own = null;
      entry.result = { snapshot: null, startedAt };
      return entry.result;
    }).finally(() => {
      entry.statusAt = now();
      entry.nextAt = entry.statusAt + Math.min(60000, Math.max(3000, (entry.statusAt - startedAt) * 3));
      entry.pending = null;
    });
    return entry.pending;
  }

  function query(linkId, params) {
    const cwd = params.cwd;
    const key = keyFor(cwd);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        clients: new Set(), pending: null, result: { snapshot: null, startedAt: 0 }, nextAt: 0,
        own: null, streak: 0, statusAt: 0, activeAt: -Infinity,
      };
      entries.set(key, entry);
    }
    entry.clients.add(linkId);
    // idleMs 를 보내지 않는 창(이전 버전)은 늘 "보고 있다"로 친다 — 종전 동작이다.
    const idleMs = typeof params.idleMs === 'number' && params.idleMs >= 0 ? params.idleMs : 0;
    entry.activeAt = Math.max(entry.activeAt, now() - idleMs);
    if (entry.pending) return entry.pending;
    if (now() < entry.nextAt) return Promise.resolve(entry.result);

    const gate = canGate && typeof params.gitDir === 'string' && path.isAbsolute(params.gitDir)
      ? { gitDir: params.gitDir } : null;
    const active = now() - entry.activeAt < ACTIVE_MS;
    if (!gate || active || entry.own === null || entry.result.snapshot === null) {
      return runStatus(entry, cwd, gate, active);
    }
    if (now() - entry.statusAt >= IDLE_STEPS[Math.min(entry.streak, IDLE_STEPS.length - 1)]) {
      return runStatus(entry, cwd, gate, false);
    }
    // git 없이 확인한다. 같은 워크트리를 보는 창들은 이 확인도 하나를 나눠 쓴다.
    const previous = entry.result;
    entry.pending = Promise.resolve().then(async () => {
      if (await readOwn(gate) !== entry.own) return false;
      return await dirtyUnchanged(cwd, previous.snapshot) === true;
    }).catch(() => false).then(unchanged => {
      entry.pending = null;
      if (!unchanged) return runStatus(entry, cwd, gate, false);
      entry.nextAt = now() + PROBE_INTERVAL_MS;
      return previous;
    });
    return entry.pending;
  }

  async function request(linkId, method, params) {
    if (method === 'meta.signature') {
      if (typeof readMeta !== 'function' || !params
          || typeof params.gitDir !== 'string' || !path.isAbsolute(params.gitDir)
          || (params.commonDir !== undefined && (typeof params.commonDir !== 'string' || !path.isAbsolute(params.commonDir)))) {
        throw invalid();
      }
      return readMeta({ gitDir: params.gitDir, commonDir: params.commonDir || params.gitDir });
    }
    if (!SNAPSHOT_METHODS.has(method) || !params || typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd)) {
      throw invalid();
    }
    const result = await query(linkId, params);
    return method === 'worktree.snapshot' ? result.snapshot : result;
  }
  function notify(linkId, method, params) {
    if (method === 'repo.activity' && maintenance) maintenance.activity(linkId, params);
  }
  function disconnect(linkId) {
    if (maintenance) maintenance.disconnect(linkId);
    for (const [key, entry] of entries) {
      entry.clients.delete(linkId);
      if (!entry.clients.size) {
        // Keep running work registered until completion, so a reconnect cannot
        // start a duplicate Git process while the old request is still active.
        if (entry.pending) entry.pending.finally(() => {
          if (!entry.clients.size && entries.get(key) === entry) entries.delete(key);
        });
        else entries.delete(key);
      }
    }
  }
  return { request, notify, disconnect };
}

module.exports = { createPollingService, ACTIVE_MS, IDLE_STEPS, PROBE_INTERVAL_MS };
