// 실패·시간 초과한 status 가 변경 목록을 비우지 않는다.
//
// 배경: 무시 패턴이 무거운 워크트리에서는 status 가 20초를 넘는다. 15초 시한에 걸린 조회가
// 빈 목록으로 적용돼, 스테이징 직후 화면이 "Working tree clean"(Local *0)으로 바뀌었다(실측).
// 실패는 이전 목록을 그대로 두고, 성공한 다음 조회가 목록을 바꾼다. 시한도 60초로 늘렸다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {
    stat: async () => ({ ok: true, exists: false }),
    read_dir: async () => ({ ok: false }),
    read_file: async () => ({ content: '' }),
  },
  process: {},
  window: { set_title: async () => ({ ok: true }) },
  terminal: {},
  initialState: { cols: 120, rows: 40 },
};

const { state } = require('../state');
const { refreshAsync } = require('../refresh');
const { gitStatusSplit } = require('../git');

function repoWithChanges() {
  state.cwd = 'C:/repo';
  state.loading = false;
  state.isGitRepo = true;
  state.error = null;
  state.spinnerActive = false;
  state.staged = [{ status: 'A', file: 'staged.txt' }];
  state.unstaged = [{ status: 'M', file: 'changed.txt' }];
  state.untracked = [{ status: '?', file: 'new-folder/' }];
  state.ignored = [];
}

const snapshotOf = () => ({ staged: state.staged.map(e => e.file), unstaged: state.unstaged.map(e => e.file), untracked: state.untracked.map(e => e.file) });

test('a timed-out status keeps the listed changes and asks for the longer deadline', async () => {
  repoWithChanges();
  const before = snapshotOf();
  const timeouts = [];
  hecaton.process.exec = async ({ args, timeout_ms }) => {
    if (args.includes('status')) {
      timeouts.push(timeout_ms);
      return { ok: false, timed_out: true, error: 'timed out', stdout: '' };
    }
    return { ok: true, exit_code: 0, stdout: '' };
  };
  await refreshAsync({ statusOnly: true, silent: true });
  assert.deepEqual(snapshotOf(), before);
  assert.ok(timeouts.length >= 1);
  assert.ok(timeouts.every(ms => ms >= 60000), 'status gets the 60 s deadline by default: ' + timeouts.join(','));
});

test('a failing status in the full refresh keeps the listed changes too', async () => {
  repoWithChanges();
  const before = snapshotOf();
  hecaton.process.exec = async ({ args }) => {
    if (args.includes('status')) return { ok: true, exit_code: 128, stdout: '', stderr: 'fatal: index file corrupt' };
    return { ok: true, exit_code: 0, stdout: '' };
  };
  await refreshAsync({ silent: true });
  assert.deepEqual(snapshotOf(), before);
});

test('a successful status after a failure replaces the list', async () => {
  repoWithChanges();
  hecaton.process.exec = async ({ args }) => {
    if (args.includes('status')) return { ok: true, exit_code: 0, stdout: ' M changed.txt\0' };
    return { ok: true, exit_code: 0, stdout: '' };
  };
  await refreshAsync({ statusOnly: true, silent: true });
  assert.deepEqual(snapshotOf(), { staged: [], unstaged: ['changed.txt'], untracked: [] });
});

// 20초 걸린 status 가 스테이징 직후에 도착해 방금 담은 항목을 다시 Unstaged 로 되돌렸다(실측).
// 쓰기 명령이 조회 도중 끝났으면 그 결과는 버리고, 쓰기 뒤의 저장소를 다시 조회한다.
test('a status that a write finished during is discarded and asked again', async () => {
  repoWithChanges();
  const gitProcess = require('../git-process');
  const original = gitProcess.completedWrites;
  let writes = 0;
  gitProcess.completedWrites = () => writes;
  let calls = 0;
  try {
    hecaton.process.exec = async ({ args }) => {
      if (!args.includes('status')) return { ok: true, exit_code: 0, stdout: '' };
      calls++;
      if (calls === 1) {
        writes++; // Stage All finished while this scan was still walking the tree.
        return { ok: true, exit_code: 0, stdout: '?? new-folder/\0' };
      }
      return { ok: true, exit_code: 0, stdout: 'A  new-folder/a.txt\0' };
    };
    await refreshAsync({ statusOnly: true, silent: true });
    for (let i = 0; i < 50 && calls < 2; i++) await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'the superseded scan is asked again');
    assert.deepEqual(snapshotOf(), { staged: ['new-folder/a.txt'], unstaged: [], untracked: [] });
  } finally {
    gitProcess.completedWrites = original;
  }
});

test('split status reports a failed command as null instead of an empty working tree', async () => {
  hecaton.process.exec = async ({ args }) => {
    if (args.includes('rev-parse')) return { ok: true, exit_code: 0, stdout: 'abc\n' };
    if (args.includes('ls-files')) return { ok: false, timed_out: true, stdout: '' };
    return { ok: true, exit_code: 0, stdout: '' };
  };
  assert.equal(await gitStatusSplit('C:/repo', { nullOnError: true }), null);
  const lenient = await gitStatusSplit('C:/repo', {});
  assert.deepEqual(lenient.untracked, []);
});
