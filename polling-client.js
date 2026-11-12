function createPollingClient(api) {
  let channel = null;
  let unavailable = typeof api.serviceChannel !== 'function';
  let closed = false;
  let retryAt = 0;
  // 이 창보다 먼저 뜬 이전 버전 서비스는 'worktree.snapshot2' 를 모른다. 그때는 문자열만
  // 주는 예전 메서드로 내려간다 — 조회 시작 시각을 모르므로 startedAt 은 0 이다.
  let legacyService = false;
  const NONE = { snapshot: null, startedAt: 0 };

  // { snapshot, startedAt, viaService } 를 돌려준다. startedAt 은 스냅샷을 만든 조회가 시작된
  // 시각(모르면 0), viaService 는 서비스가 답했는지(= 창끼리의 파일 공유가 필요 없는지)다.
  async function read(cwd, fallback) {
    const local = async () => {
      const startedAt = Date.now();
      return { snapshot: await fallback(), startedAt, viaService: false };
    };
    if (closed) return NONE;
    if (unavailable) return local();
    if (Date.now() < retryAt) return { ...NONE, viaService: true };
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
        return closed ? NONE : local();
      }
      retryAt = Date.now() + 10000;
      return { ...NONE, viaService: true };
    }
    if (closed) { await channel.close(); return NONE; }
    try {
      if (!legacyService) {
        try {
          const result = await channel.request('worktree.snapshot2', { cwd }, 15000);
          if (result && typeof result === 'object') {
            return { snapshot: result.snapshot === undefined ? null : result.snapshot, startedAt: result.startedAt || 0, viaService: true };
          }
          return { ...NONE, viaService: true };
        } catch (error) {
          if (!/Invalid polling request/.test(String(error && error.message))) throw error;
          legacyService = true;
        }
      }
      const snapshot = await channel.request('worktree.snapshot', { cwd }, 15000);
      return { snapshot: snapshot === undefined ? null : snapshot, startedAt: 0, viaService: true };
    } catch {
      // A timeout/disconnect is not proof that the service's Git has exited.
      // Never fall back to a second local process for an uncertain request.
      retryAt = Date.now() + 10000;
      return { ...NONE, viaService: true };
    }
  }

  // 이전 버전 서비스는 'meta.signature' 를 모른다 — 그때는 이 창이 직접 계산한다.
  let metaUnsupported = false;

  // .git 메타 지문. { sig, shareable, viaService } 를 돌려준다(닫힌 뒤에는 null).
  // 서비스가 답하지 못하면 fallback() 으로 이 창이 직접 계산한다 — 지문은 파일 시각을 읽을
  // 뿐이라, 스냅샷과 달리 직접 읽어도 겹쳐 도는 git 이 생기지 않는다.
  async function metaSignature(gitDir, commonDir, fallback) {
    const local = async () => ({ ...(await fallback()), viaService: false });
    if (closed) return null;
    if (unavailable || metaUnsupported) return local();
    if (Date.now() < retryAt || !channel) {
      // 연결은 스냅샷 쪽(read)이 맡는다. 아직 붙지 않았으면 이번 틱은 직접 계산한다.
      return local();
    }
    try {
      await channel.connect();
    } catch {
      return local();
    }
    if (closed) return null;
    try {
      const result = await channel.request('meta.signature', { gitDir, commonDir }, 10000);
      if (result && typeof result.sig === 'string') {
        return { sig: result.sig, shareable: result.shareable !== false, viaService: true };
      }
      return local();
    } catch (error) {
      if (/Invalid polling request/.test(String(error && error.message))) {
        metaUnsupported = true;
        return local();
      }
      return local();
    }
  }

  // 이 창이 저장소를 열었거나 입력이 있었다는 알림(유휴 정리용). 응답을 기다리지 않고, 서비스에
  // 붙어 있지 않으면 아무것도 하지 않는다 — 알리려고 연결을 열지는 않는다.
  function activity(cwd, commonDir) {
    if (closed || unavailable || !channel || typeof channel.notify !== 'function') return;
    if (channel.connected === false) return;
    try {
      Promise.resolve(channel.notify('repo.activity', { cwd, commonDir })).catch(() => null);
    } catch { /* 알림 실패는 무시한다 — 정리가 조금 일찍 돌 수 있을 뿐이다 */ }
  }

  return {
    read,
    metaSignature,
    activity,
    async snapshot(cwd, fallback) {
      return (await read(cwd, fallback)).snapshot;
    },
    // 서비스가 스냅샷을 맡고 있는지. 연결을 시도해 본 뒤에만 의미가 있다.
    usesService() { return !unavailable; },
    close() {
      closed = true;
      if (channel) return channel.close();
      return Promise.resolve();
    },
  };
}

module.exports = { createPollingClient };
