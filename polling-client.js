function createPollingClient(api) {
  let channel = null;
  let unavailable = typeof api.serviceChannel !== 'function';
  let closed = false;
  let retryAt = 0;
  return {
    async snapshot(cwd, fallback) {
      if (closed) return null;
      if (unavailable) return fallback();
      if (Date.now() < retryAt) return null;
      if (!channel) channel = api.serviceChannel({
        protocol: 1, reconnect: false,
        reason: {
          en: 'Share Git status polling across Git Client windows to reduce Git process creation.', // i18n-ok: host-localized permission reason map
          ko: 'Git 프로세스 생성을 줄이기 위해 Git 클라이언트 창들의 상태 조회를 공유합니다.', // i18n-ok: host-localized permission reason map
        },
      });
      try {
        await channel.connect();
      } catch (error) {
        if (['no_service', 'incompatible', 'permission_denied', 'unavailable', 'method_not_found'].includes(error && error.code)) {
          unavailable = true;
          return closed ? null : fallback();
        }
        retryAt = Date.now() + 10000;
        return null;
      }
      if (closed) { await channel.close(); return null; }
      try {
        return await channel.request('worktree.snapshot', { cwd }, 15000);
      } catch {
        // A timeout/disconnect is not proof that the service's Git has exited.
        // Never fall back to a second local process for an uncertain request.
        retryAt = Date.now() + 10000;
        return null;
      }
    },
    close() {
      closed = true;
      if (channel) return channel.close();
      return Promise.resolve();
    },
  };
}

module.exports = { createPollingClient };
