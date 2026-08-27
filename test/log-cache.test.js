// refreshLog 결과 캐시 — 그래프 입력이 그대로면 git 을 한 번도 부르지 않는다.
// refreshLog 한 번은 log/reflog 로 프로세스를 최대 5개까지 직렬로 쓰므로,
// 커밋이 바뀌지 않은 갱신에서 이걸 건너뛰는지가 체감 속도를 좌우한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state, ui } = require('../state');
const { refreshLog } = require('../refresh');

const SEP = process.platform === 'win32' ? '\\' : '/';

// 커밋 하나짜리 로그. refreshLog 가 파싱하는 형식 그대로.
function logRecord(hash, subject) {
  return '\x01' + [hash, '', '', 'Alice', 'a@x', '2026-01-01T00:00:00+00:00',
    'Alice', 'a@x', '2026-01-01T00:00:00+00:00', subject].join('\x00') + '\n';
}

function installHost(cwd) {
  const host = {
    logCalls: 0,
    reflogCalls: 0,
    // refs/heads/main 의 mtime — 브랜치가 움직인 상황을 흉내낼 때 바꾼다.
    mainRefMtime: 1000,
    subject: 'first',
  };

  hecaton.process.exec = async ({ args }) => {
    const joined = args.join(' ');
    if (joined.includes('reflog')) {
      host.reflogCalls++;
      return { ok: true, exit_code: 0, stdout: '' };
    }
    if (joined.includes('log')) {
      host.logCalls++;
      return { ok: true, exit_code: 0, stdout: logRecord('a'.repeat(40), host.subject) };
    }
    return { ok: true, exit_code: 0, stdout: '' };
  };

  hecaton.fs.stat = async () => ({ exists: true, mtime_ms: 1000 });
  hecaton.fs.read_dir = async ({ path }) => {
    const refsDir = cwd + SEP + '.git' + SEP + 'refs';
    if (path === refsDir) return { ok: true, entries: [{ name: 'heads', is_dir: true }] };
    if (path === refsDir + SEP + 'heads') {
      return {
        ok: true,
        entries: [{ name: 'main', is_dir: false, mtime_ms: host.mainRefMtime, size_bytes: 41 }],
      };
    }
    return { ok: false };
  };
  hecaton.fs.read_file = async () => ({ content: '' });
  hecaton.window.set_title = async () => ({ ok: true });

  return host;
}

function resetState(cwd) {
  state.cwd = cwd;
  state.isGitRepo = true;
  state.gitDir = cwd + SEP + '.git';
  state.gitCommonDir = state.gitDir;
  state.rightView = 'status';
  state.stashes = [];
  state.logItems = [];
  state.logSelectables = [];
  state.logCursor = 0;
  state.logLoading = false;
  state.logLoadingMore = false;
  state.recoveryRefs = {};
  ui.logShowRecovery = true;
}

// refreshLog 는 동기 함수 안에서 async IIFE 를 띄운다. 끝날 때까지 기다린다.
async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (!state.logLoading) return;
  }
}

test('두 번째 refreshLog 는 입력이 그대로면 git 을 부르지 않는다', async () => {
  const cwd = 'C:/log-cache-hit';
  const host = installHost(cwd);
  resetState(cwd);

  refreshLog();
  await settle();
  const afterFirst = host.logCalls;
  assert.ok(afterFirst > 0, '첫 조회는 실제로 git 을 불러야 한다');
  assert.equal(state.logItems.length > 0, true);

  refreshLog();
  await settle();
  assert.equal(host.logCalls, afterFirst, '입력이 같으면 log 를 다시 부르지 않는다');
  assert.equal(state.logItems.length > 0, true, '캐시 적중이어도 화면 내용은 유지된다');
});

test('ref 가 움직이면 캐시를 버리고 다시 읽는다', async () => {
  const cwd = 'C:/log-cache-invalidate';
  const host = installHost(cwd);
  resetState(cwd);

  refreshLog();
  await settle();
  const afterFirst = host.logCalls;

  host.mainRefMtime = 2000;
  host.subject = 'second';
  refreshLog();
  await settle();

  assert.ok(host.logCalls > afterFirst, 'ref 변경 뒤에는 다시 읽어야 한다');
  assert.equal(state.logItems.some(r => r.subject === 'second'), true);
});

test('stash 가 추가되면 다시 읽는다', async () => {
  const cwd = 'C:/log-cache-stash';
  const host = installHost(cwd);
  resetState(cwd);

  refreshLog();
  await settle();
  const afterFirst = host.logCalls;

  state.stashes = [{ hash: 'b'.repeat(40), shortHash: 'bbbbbbb', ref: 'stash@{0}', message: 'wip' }];
  refreshLog();
  await settle();

  assert.ok(host.logCalls > afterFirst, 'stash 목록이 바뀌면 다시 읽어야 한다');
});

test('force 는 캐시를 건너뛴다 — 사용자가 직접 누른 새로고침용', async () => {
  const cwd = 'C:/log-cache-force';
  const host = installHost(cwd);
  resetState(cwd);

  refreshLog();
  await settle();
  const afterFirst = host.logCalls;

  refreshLog({ force: true });
  await settle();

  assert.ok(host.logCalls > afterFirst, 'force 면 지문이 같아도 다시 읽는다');
});

test('refs 트리를 읽지 못하면 캐시하지 않는다', async () => {
  const cwd = 'C:/log-cache-no-refs';
  const host = installHost(cwd);
  resetState(cwd);
  // read_dir 미지원 호스트를 흉내낸다 — 지문을 만들 근거가 없으므로 매번 다시 읽어야 한다.
  hecaton.fs.read_dir = async () => ({ ok: false });

  refreshLog();
  await settle();
  const afterFirst = host.logCalls;

  refreshLog();
  await settle();

  assert.ok(host.logCalls > afterFirst, '지문을 못 만들면 종전대로 매번 조회한다');
});
