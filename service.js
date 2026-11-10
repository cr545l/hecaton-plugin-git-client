const { createPollingService } = require('./polling-service');
const { buildWorktreeSnapshot } = require('./worktree-snapshot');
const gitProcess = require('./git-process');

// status 는 마감 없이 돈다(git-process "읽기 실행의 단일 창구"). 5초 마감을 두던 때에는 status 가
// 7~19초 걸리는 저장소에서 스냅샷이 매번 실패로 돌아와, 서비스가 git 만 띄우고 결과는 못 냈다.
// 겹침은 polling-service 가 워크트리당 하나로 묶고, 걸린 시간의 3배만큼 다음 실행을 늦춘다.
const polling = createPollingService({
  buildSnapshot: cwd => buildWorktreeSnapshot(cwd, hecaton, gitProcess.read),
});
const host = hecaton.serviceHost({
  protocol: 1,
  onRequest: polling.request,
  onClientGone: polling.disconnect,
});
host.listen().then(result => {
  if (!result || result.ok === false) throw new Error('Git polling service could not listen'); // i18n-ok: service startup diagnostic
}).catch(error => {
  console.error('[git-client service] ' + error.message); // i18n-ok: service log diagnostic
  process.exit(1);
});
