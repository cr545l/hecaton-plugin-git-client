const { createPollingService } = require('./polling-service');
const { buildWorktreeSnapshot } = require('./worktree-snapshot');
const gitProcess = require('./git-process');
const { createMetaReader } = require('./meta-signature');
const { createMaintenance } = require('./maintenance');
const path = require('path');

// 메타 지문은 창들이 2초 주기로 묻는다. 그보다 조금 짧게 묶어 두면 같은 주기에 온 요청은
// 전부 한 번의 계산을 나눠 쓰고, 다음 주기에는 새로 읽는다.
const META_SHARE_MS = 1500;
const META_IDLE_DROP_MS = 10 * 60 * 1000;
const metaReader = createMetaReader(hecaton, { ttlMs: META_SHARE_MS });
const pruneTimer = setInterval(() => metaReader.prune(META_IDLE_DROP_MS), META_IDLE_DROP_MS);
if (pruneTimer && typeof pruneTimer.unref === 'function') pruneTimer.unref();

// ── 유휴 정리 ──
// 자동 정리 기준을 넘었을 때만 실제로 일한다(--auto). 넘지 않았으면 객체 수만 세고 끝난다.
// 읽기 경로(startRead)로 띄운다 — 중단할 수 있어야 하고, 창들의 "쓰기가 끝났다" 집계와는
// 상관없는 일이다. maintenance 가 없는 옛 git(2.30 미만)에서는 gc --auto 로 내려간다.
function runMaintenance(cwd) {
  let cancelled = false;
  let current = gitProcess.startRead({ program: 'git', args: ['maintenance', 'run', '--auto'], cwd });
  const succeeded = result => !!(result && result.ok && result.exit_code === 0);
  const promise = current.promise.then(result => {
    if (cancelled || succeeded(result)) return result;
    if (!/is not a git command/i.test(String((result && result.stderr) || ''))) return result;
    current = gitProcess.startRead({ program: 'git', args: ['gc', '--auto'], cwd });
    return current.promise;
  }).then(result => ({ ok: succeeded(result) }));
  return { promise, cancel() { cancelled = true; current.cancel(); } };
}

const SHARE_DIR_NAME = 'hecaton-git-client';
const maintenanceMarkPath = commonDir => path.join(commonDir, SHARE_DIR_NAME, 'maintenance.json');

const maintenance = createMaintenance({
  run: runMaintenance,
  readMark: async commonDir => {
    const res = await hecaton.fs.read_file({ path: maintenanceMarkPath(commonDir) });
    const content = typeof res === 'string' ? res : (res && res.content) ? res.content : '';
    return content ? JSON.parse(content) : null;
  },
  writeMark: async (commonDir, mark) => {
    await hecaton.fs.mkdir({ path: path.join(commonDir, SHARE_DIR_NAME), recursive: true });
    await hecaton.fs.write_file({ path: maintenanceMarkPath(commonDir), content: JSON.stringify(mark) });
  },
});
const MAINTENANCE_CHECK_MS = 60 * 1000;
const maintenanceTimer = setInterval(() => { maintenance.tick().catch(() => null); }, MAINTENANCE_CHECK_MS);
if (maintenanceTimer && typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();

// status 는 마감 없이 돈다(git-process "읽기 실행의 단일 창구"). 5초 마감을 두던 때에는 status 가
// 7~19초 걸리는 저장소에서 스냅샷이 매번 실패로 돌아와, 서비스가 git 만 띄우고 결과는 못 냈다.
// 겹침은 polling-service 가 워크트리당 하나로 묶고, 걸린 시간의 3배만큼 다음 실행을 늦춘다.
const polling = createPollingService({
  buildSnapshot: cwd => buildWorktreeSnapshot(cwd, hecaton, gitProcess.read),
  readMeta: metaReader.read,
  maintenance,
});
const host = hecaton.serviceHost({
  protocol: 1,
  onRequest: polling.request,
  onNotify: polling.notify,
  onClientGone: polling.disconnect,
});
host.listen().then(result => {
  if (!result || result.ok === false) throw new Error('Git polling service could not listen'); // i18n-ok: service startup diagnostic
}).catch(error => {
  console.error('[git-client service] ' + error.message); // i18n-ok: service log diagnostic
  process.exit(1);
});
