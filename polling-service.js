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

function invalid() {
  return new Error('Invalid polling request'); // i18n-ok: internal service protocol diagnostic
}

//
// 'repo.activity' 는 응답 없는 알림이다 — 창이 저장소를 열었을 때와 입력이 있을 때 보낸다.
// 유휴 정리(maintenance.js)가 언제 돌고 멈출지를 여기서 안다.
function createPollingService({ buildSnapshot, readMeta, maintenance, now = Date.now, platform = process.platform }) {
  const entries = new Map();
  function keyFor(cwd) {
    const resolved = path.resolve(cwd);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  function query(linkId, cwd) {
    const key = keyFor(cwd);
    let entry = entries.get(key);
    if (!entry) {
      entry = { clients: new Set(), pending: null, result: { snapshot: null, startedAt: 0 }, nextAt: 0 };
      entries.set(key, entry);
    }
    entry.clients.add(linkId);
    if (entry.pending) return entry.pending;
    if (now() < entry.nextAt) return Promise.resolve(entry.result);
    const startedAt = now();
    entry.pending = Promise.resolve().then(() => buildSnapshot(cwd)).then(snapshot => {
      entry.result = { snapshot, startedAt };
      return entry.result;
    }).catch(() => {
      entry.result = { snapshot: null, startedAt };
      return entry.result;
    }).finally(() => {
      entry.nextAt = now() + Math.min(60000, Math.max(3000, (now() - startedAt) * 3));
      entry.pending = null;
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
    const result = await query(linkId, params.cwd);
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

module.exports = { createPollingService };
