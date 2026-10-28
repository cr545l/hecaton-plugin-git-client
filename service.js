const { createPollingService } = require('./polling-service');
const { buildWorktreeSnapshot } = require('./worktree-snapshot');
const perms = require('./permissions');

const polling = createPollingService({
  buildSnapshot: cwd => buildWorktreeSnapshot(cwd, hecaton, perms.execGit),
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
