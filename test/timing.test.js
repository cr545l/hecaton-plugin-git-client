// 동작 시간 기록(timing.js): 느린 동작을 나중에 재구성할 수 있게 남기되, 커밋 메시지나
// 파일 이름은 남기지 않는다. 한 번에 쓰는 양은 묶음 하나로 제한한다.
const test = require('node:test');
const assert = require('node:assert/strict');

const writes = [];
global.hecaton = {
  on: () => {},
  fs: {
    mkdir: async () => ({ ok: true }),
    write_file: async ({ path, content }) => { writes.push({ path, content }); return { ok: true }; },
    read_file: async () => ({ content: '' }),
  },
  process: { exec: async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' }) },
};

const timing = require('../timing');
const coordinate = require('../coordinate');

test('git commands keep the subcommand and option names, never messages or paths', () => {
  assert.equal(timing.gitCommandOf(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'commit', '-m', 'secret message']),
    '-c gc.auto -c maintenance.auto commit -m +1');
  assert.equal(timing.gitCommandOf(['--literal-pathspecs', 'add', '-f', '--', 'a/secret.txt', 'b.txt']),
    '--literal-pathspecs add -f +2');
  assert.equal(timing.gitCommandOf(['push', '-u', 'origin', 'main']), 'push -u +2');
  assert.equal(timing.gitCommandOf(undefined), '');
});

test('records go to this instance file in the shared folder, one chunk at a time', async () => {
  coordinate.configure('C:/repo/.git', 'C:/repo');
  writes.length = 0;
  timing.record('action', { id: 'git-push', result: 'queued' });
  await timing.flush();
  const current = writes.filter(w => /timing-[^/\\]+\.log$/.test(w.path) && !/\.prev\.log$/.test(w.path));
  assert.equal(current.length, 1);
  assert.match(current[0].path.replace(/\\/g, '/'), /^C:\/repo\/\.git\/hecaton-git-client\/timing-/);
  const lines = current[0].content.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.at(-1).k, 'action');
  assert.equal(lines.at(-1).id, 'git-push');

  for (let i = 0; i < 520; i++) timing.record('git', { via: 'exec', cmd: 'status', ms: i });
  writes.length = 0;
  await timing.flush();
  const prev = writes.find(w => /\.prev\.log$/.test(w.path));
  assert.ok(prev, 'a full chunk moves to the .prev file');
  assert.ok(prev.content.trim().split('\n').length >= 500);
  const fresh = writes.find(w => !/\.prev\.log$/.test(w.path));
  assert.equal(fresh.content, '', 'the new chunk starts empty');
});

test('a gate decision is recorded with what was holding the resources', async () => {
  coordinate.configure('C:/repo/.git', 'C:/repo');
  const { state } = require('../state');
  state.activeOps = [{ label: 'Committing', phase: 'running' }];
  assert.deepEqual(timing.blockingOps(), ['Committing:running']);
  state.activeOps = [];
});
