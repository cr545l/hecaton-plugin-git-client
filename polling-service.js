const path = require('path');

// Requests drive polling; no clients requesting means no background Git work.
// Each worktree owns one in-flight query and one shared adaptive cooldown.
function createPollingService({ buildSnapshot, now = Date.now, platform = process.platform }) {
  const entries = new Map();
  function keyFor(cwd) {
    const resolved = path.resolve(cwd);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  async function request(linkId, method, params) {
    if (method !== 'worktree.snapshot' || !params || typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd)) {
      throw new Error('Invalid polling request'); // i18n-ok: internal service protocol diagnostic
    }
    const key = keyFor(params.cwd);
    let entry = entries.get(key);
    if (!entry) {
      entry = { clients: new Set(), pending: null, snapshot: null, nextAt: 0 };
      entries.set(key, entry);
    }
    entry.clients.add(linkId);
    if (entry.pending) return entry.pending;
    if (now() < entry.nextAt) return entry.snapshot;
    const startedAt = now();
    entry.pending = Promise.resolve().then(() => buildSnapshot(params.cwd)).then(snapshot => {
      entry.snapshot = snapshot;
      return snapshot;
    }).catch(() => {
      entry.snapshot = null;
      return null;
    }).finally(() => {
      entry.nextAt = now() + Math.min(60000, Math.max(3000, (now() - startedAt) * 3));
      entry.pending = null;
    });
    return entry.pending;
  }
  function disconnect(linkId) {
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
  return { request, disconnect };
}

module.exports = { createPollingService };
