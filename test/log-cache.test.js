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

test('recovery spinner remains active after base log loads until reflog finishes', async () => {
  const cwd = 'C:/log-recovery-spinner';
  installHost(cwd);
  resetState(cwd);
  const originalExec = hecaton.process.exec;
  let finishRecovery;
  const pending = new Promise(resolve => { finishRecovery = resolve; });
  hecaton.process.exec = async request => {
    if (request.args.includes('reflog')) await pending;
    return originalExec(request);
  };
  refreshLog({ force: true });
  assert.equal(state.logRecoveryLoading, true, 'immediate feedback');
  try {
    await settle();
    assert.equal(state.logLoading, false, 'base log has finished');
    assert.equal(state.logRecoveryLoading, true, 'recovery is still pending');
  } finally {
    finishRecovery();
    for (let i = 0; i < 50 && state.logRecoveryLoading; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  assert.equal(state.logRecoveryLoading, false, 'empty reflog also clears spinner');
});

test('failed recovery request clears its spinner', async () => {
  const cwd = 'C:/log-recovery-spinner-failure';
  installHost(cwd);
  resetState(cwd);
  const originalExec = hecaton.process.exec;
  hecaton.process.exec = async request => {
    if (request.args.includes('reflog')) throw new Error('reflog unavailable');
    return originalExec(request);
  };
  refreshLog({ force: true });
  for (let i = 0; i < 50 && state.logRecoveryLoading; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(state.logRecoveryLoading, false);
  assert.equal(state.logLoading, false);
});

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

// 2026-11-10 실측: 저장소 정리가 밀려 git log 가 매번 30초 타임아웃으로 죽었고, 그 실패가
// 빈 목록으로 적용되어 화면에 "아직 커밋이 없습니다"가 떴다.
test('실패한 log 조회는 목록을 지우지 않고 실패로 표시한다', async () => {
  const cwd = 'C:/log-load-failure';
  const host = installHost(cwd);
  resetState(cwd);
  ui.logShowRecovery = false;

  refreshLog();
  await settle();
  const shown = state.logItems.length;
  assert.ok(shown > 0);
  assert.equal(state.logLoadFailed, false);

  const okExec = hecaton.process.exec;
  hecaton.process.exec = async request => {
    if (request.args.includes('log')) {
      host.logCalls++;
      return { ok: false, exit_code: 1, timed_out: true, stdout: '' };
    }
    return okExec(request);
  };
  refreshLog({ force: true });
  await settle();
  assert.equal(state.logItems.length, shown, '직전 목록을 빈 결과로 덮지 않는다');
  assert.equal(state.logLoadFailed, true);
  assert.equal(state.logLoading, false);

  // 실패는 캐시되지 않는다 — 다음 조회가 성공하면 표시가 풀린다.
  hecaton.process.exec = okExec;
  const before = host.logCalls;
  refreshLog();
  await settle();
  assert.ok(host.logCalls > before, '실패 뒤에는 캐시 없이 다시 조회한다');
  assert.equal(state.logLoadFailed, false);
});

// 스트리밍을 쓸 수 있는 호스트에서는 log 가 마감 없이 돈다. 걸린 시간이 보이고,
// 사용자가 끊으면 프로세스가 실제로 끝나며 직전 목록은 그대로 남는다.
test('오래 걸리는 log 는 기다리고, 경과 시간을 내고, 중단하면 프로세스를 끝낸다', async () => {
  const cwd = 'C:/log-streaming';
  installHost(cwd);
  resetState(cwd);
  ui.logShowRecovery = false;
  const { cancelLogLoad, logLoadElapsedSeconds } = require('../refresh');

  const handlers = new Map();
  const spawned = [];
  const killed = [];
  const saved = { on: hecaton.on, spawn: hecaton.process.spawn, kill: hecaton.process.kill };
  hecaton.on = (name, handler) => handlers.set(name, handler);
  hecaton.process.spawn = async params => {
    spawned.push(params);
    return { ok: true, process_id: 'p' + spawned.length };
  };
  hecaton.process.kill = async ({ process_id }) => { killed.push(process_id); return { ok: true }; };
  const realNow = Date.now;
  try {
    // 1) 완주: exec 의 30초 마감을 한참 넘겨도 죽이지 않고, 끝나면 목록이 뜬다.
    refreshLog({ force: true });
    for (let i = 0; i < 20 && spawned.length === 0; i++) await new Promise(r => setImmediate(r));
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].timeout_ms, undefined, 'log 조회에는 마감이 없다');
    assert.equal(logLoadElapsedSeconds(), -1, '막 시작한 조회는 경과 표시를 내지 않는다');
    assert.equal(cancelLogLoad(), false, '안내가 나오기 전의 Esc 는 조회를 죽이지 않는다');

    const startedAt = realNow();
    Date.now = () => startedAt + 95000;
    assert.equal(logLoadElapsedSeconds(), 95);
    assert.equal(state.logLoading, true);
    assert.deepEqual(killed, []);
    handlers.get('process_output')({ process_id: 'p1', stream: 'stdout', data: logRecord('b'.repeat(40), 'slow') });
    handlers.get('process_exited')({ process_id: 'p1', exit_code: 0 });
    await settle();
    Date.now = realNow;
    assert.equal(state.logLoading, false);
    const shown = state.logItems.length;
    assert.ok(shown > 0);

    // 2) 중단: 프로세스를 끝내고, 목록은 그대로 두고, 다시 조회할 수 있는 상태로 돌아온다.
    refreshLog({ force: true });
    for (let i = 0; i < 20 && spawned.length === 1; i++) await new Promise(r => setImmediate(r));
    assert.equal(spawned.length, 2);
    const again = realNow();
    Date.now = () => again + 10000;
    assert.equal(cancelLogLoad(), true);
    Date.now = realNow;
    assert.deepEqual(killed, ['p2']);
    assert.equal(state.logLoading, false);
    assert.equal(state.logLoadCancelled, true);
    assert.equal(state.logLoadFailed, false);
    assert.equal(state.logItems.length, shown, '중단해도 직전 목록은 남는다');

    // 뒤늦게 도착한 출력이 화면을 건드리지 않는다.
    handlers.get('process_output')({ process_id: 'p2', stream: 'stdout', data: logRecord('c'.repeat(40), 'late') });
    handlers.get('process_exited')({ process_id: 'p2', exit_code: 0 });
    await settle();
    assert.equal(state.logItems.length, shown);

    // 3) 저장소가 바뀌면 앞 저장소의 조회는 버리고 새로 시작한다.
    refreshLog({ force: true });
    for (let i = 0; i < 20 && spawned.length === 2; i++) await new Promise(r => setImmediate(r));
    assert.equal(spawned.length, 3);
    const other = 'C:/log-streaming-other';
    installHost(other);
    state.cwd = other;
    state.gitDir = other + SEP + '.git';
    state.gitCommonDir = state.gitDir;
    refreshLog({ force: true });
    for (let i = 0; i < 20 && spawned.length === 3; i++) await new Promise(r => setImmediate(r));
    assert.deepEqual(killed, ['p2', 'p3'], '앞 저장소의 git 을 끝낸다');
    assert.equal(spawned.length, 4);
    assert.equal(spawned[3].cwd, other);
    handlers.get('process_exited')({ process_id: 'p4', exit_code: 0 });
    await settle();
  } finally {
    Date.now = realNow;
    hecaton.on = saved.on;
    hecaton.process.spawn = saved.spawn;
    hecaton.process.kill = saved.kill;
  }
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
