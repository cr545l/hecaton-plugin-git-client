// 유휴 시간의 저장소 정리 — 서비스 프로세스가 맡는다.
//
// 배경: 이 플러그인의 쓰기 명령은 전부 자동 정리를 끄고 돈다(git-process.js NO_AUTO_MAINTENANCE).
// 사용자 동작 안에서 정리가 돌면 그 동작이 정리가 끝날 때까지 돌아오지 않기 때문이다(커밋 한
// 번 139초 실측). 그런데 꺼 두기만 하고 대신 돌려 주는 곳이 없어, 플러그인으로만 쓰는
// 저장소는 정리가 영영 돌지 않았다(2026-11-12 실측: loose object 57,155개, pack 21개 —
// git 의 자동 정리 기준은 6,700개다). 객체가 흩어져 있으면 모든 git 명령이 그만큼 느려진다.
//
// 그래서 사용자가 쓰지 않는 동안 정리를 돌린다:
//   - 그 저장소를 연 창 어디에서도 idleMs 동안 입력이 없을 때만 시작한다.
//   - 도는 중에 입력이 들어오면 곧바로 중단한다. git 의 정리는 도중에 끊겨도 저장소를 해치지
//     않는다(새 pack 은 다 쓴 뒤에 제자리로 옮긴다) — 남는 임시 파일은 다음 정리가 치운다.
//   - 한 번에 저장소 하나만 돌린다. 정리는 디스크를 많이 쓴다.
//   - 끝까지 돈 뒤에는 minIntervalMs 동안 다시 돌리지 않는다. 그 시각은 저장소에 남겨,
//     서비스가 다시 떠도(호스트 재시작) 이어진다.
//
// 창 쪽은 'repo.activity' 알림만 보낸다: 창이 저장소를 열었을 때와 입력이 있을 때(드문드문).
// 무엇을 돌릴지는 run 이 정한다 — 이 모듈은 언제 돌리고 언제 멈출지만 안다.
const path = require('path');

const DEFAULT_IDLE_MS = 3 * 60 * 1000;
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 입력 때문에 끊긴 정리를 다시 시도하기까지의 최소 간격. 쓰다 말다 하는 동안 정리를 계속
// 시작했다 끊는 일을 막는다.
const DEFAULT_RETRY_MS = 15 * 60 * 1000;

function createMaintenance({
  run, readMark, writeMark,
  now = Date.now, platform = process.platform,
  idleMs = DEFAULT_IDLE_MS, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, retryMs = DEFAULT_RETRY_MS,
}) {
  const repos = new Map();
  let running = null;

  function keyOf(dir) {
    const resolved = path.resolve(dir);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function valid(params) {
    return !!params && typeof params.cwd === 'string' && path.isAbsolute(params.cwd)
      && typeof params.commonDir === 'string' && path.isAbsolute(params.commonDir);
  }

  // 창의 알림. 저장소를 등록하고, 도는 정리가 있으면 멈춘다.
  function activity(linkId, params) {
    if (!valid(params)) return false;
    const key = keyOf(params.commonDir);
    let repo = repos.get(key);
    if (!repo) {
      repo = {
        key, commonDir: params.commonDir, cwd: params.cwd, clients: new Set(),
        lastActivity: 0, nextAllowedAt: 0, markLoaded: false, job: null,
      };
      repos.set(key, repo);
    }
    repo.clients.add(linkId);
    repo.cwd = params.cwd;
    repo.lastActivity = now();
    if (repo.job) repo.job.cancel();
    return true;
  }

  // 창이 닫혔다. 그 저장소를 연 창이 더 없으면 정리도 멈추고 잊는다 — 보는 사람이 없는
  // 저장소를 뒤에서 만지지 않는다.
  function disconnect(linkId) {
    for (const [key, repo] of repos) {
      if (!repo.clients.delete(linkId) || repo.clients.size) continue;
      if (repo.job) repo.job.cancel();
      repos.delete(key);
    }
  }

  function due(repo, at) {
    return repos.get(repo.key) === repo && !repo.job
      && at - repo.lastActivity >= idleMs && at >= repo.nextAllowedAt;
  }

  // 주기적으로 부른다. 조건이 맞는 저장소가 있으면 하나를 시작한다. 시작했으면 그 저장소의
  // 공용 git dir 을, 아니면 null 을 돌려준다.
  async function tick() {
    if (running) return null;
    // 가장 오래 조용했던 저장소부터 본다.
    const candidates = [...repos.values()].filter(repo => due(repo, now()))
      .sort((a, b) => a.lastActivity - b.lastActivity);
    for (const repo of candidates) {
      if (!repo.markLoaded) {
        // 지난 실행 시각을 저장소에서 읽는다 — 서비스가 새로 떴어도 간격을 지킨다.
        repo.markLoaded = true;
        let mark = null;
        try { mark = await readMark(repo.commonDir); } catch { mark = null; }
        if (mark && typeof mark.at === 'number' && mark.at <= now()) {
          repo.nextAllowedAt = Math.max(repo.nextAllowedAt, mark.at + minIntervalMs);
        }
      }
      // 표시를 읽는 사이 입력이 들어왔거나 다른 정리가 시작됐을 수 있다.
      if (running) return null;
      if (!due(repo, now())) continue;
      start(repo);
      return repo.commonDir;
    }
    return null;
  }

  function start(repo) {
    running = repo;
    const startedAt = now();
    let cancelled = false;
    let job;
    try {
      job = run(repo.cwd);
    } catch {
      running = null;
      repo.nextAllowedAt = now() + minIntervalMs;
      return;
    }
    repo.job = {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        try { job.cancel(); } catch { /* 이미 끝났다 */ }
      },
    };
    Promise.resolve(job.promise).then(result => {
      if (cancelled) {
        repo.nextAllowedAt = now() + retryMs;
        return;
      }
      // 끝까지 돌았다(성공이든 실패든). 실패를 금방 되풀이하지 않는다 — 원인이 그대로일
      // 가능성이 높다(오래된 git, 잠긴 저장소).
      repo.nextAllowedAt = now() + minIntervalMs;
      if (result && result.ok) {
        Promise.resolve(writeMark(repo.commonDir, { at: now(), ms: now() - startedAt })).catch(() => null);
      }
    }, () => {
      repo.nextAllowedAt = now() + (cancelled ? retryMs : minIntervalMs);
    }).finally(() => {
      repo.job = null;
      if (running === repo) running = null;
    });
  }

  return {
    activity, disconnect, tick,
    // 테스트·진단용
    isRunning: () => !!running,
    repoCount: () => repos.size,
  };
}

module.exports = { createMaintenance, DEFAULT_IDLE_MS, DEFAULT_MIN_INTERVAL_MS, DEFAULT_RETRY_MS };
