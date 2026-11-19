// 히스토리를 다시 읽어도 보던 자리·고른 커밋·상세가 그대로인지.
//
// 배경(2026-11-19, Com2uX prompt-p1 창 기록):
//   - 다시 읽기(refreshLog)는 커서와 스크롤 위치를 순번으로만 들고 있었다. 팀원 커밋이 fetch 로 들어와
//     맨 위에 끼면 목록이 그 수만큼 밀리고, 선택도 그 순번에 온 다른 커밋으로 바뀌었다.
//   - 더 읽기(loadMoreLog)는 끝날 때 요청할 때의 위치로 되돌렸다 — 목록 끝으로 스크롤하다 시작되므로
//     읽는 동안 더 내려간 만큼 되돌아갔다.
//   - 상태 갱신마다 같은 커밋의 상세를 헤더만 남겼다가 다시 얹었다(상세가 한 줄 올라갔다 돌아오고,
//     스크롤 위치가 0으로 잘리고, 접어 둔 파일이 펼쳐졌다).
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, terminal: {}, initialState: { cols: 120, rows: 40 } };

const { state, ui } = require('../state');
const { refreshLog, loadMoreLog, updateLogDetail } = require('../refresh');
// 그리기는 하지 않는다 — 부르는 쪽은 모두 그때그때 require('./render').render 를 꺼내 쓴다.
// (실제 stdout 은 테스트 결과 보고에 쓰이므로 통째로 막지 않는다.)
require('../render').render = () => {};

const SEP = process.platform === 'win32' ? '\\' : '/';
const hex = n => n.toString(16).padStart(40, '0');

function installHost(cwd) {
  const host = { commits: [], logCalls: 0, showCalls: 0, logGate: null };
  const record = (h, parent, i) => {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
    return '\x01' + [h, parent, '', 'Alice', 'a@x', date, 'Alice', 'a@x', date, 'subject ' + h.slice(-4)].join('\x00') + '\n';
  };
  hecaton.process.exec = async ({ args }) => {
    if (args.includes('reflog')) return { ok: true, exit_code: 0, stdout: '' };
    if (args.includes('show')) {
      host.showCalls++;
      return { ok: true, exit_code: 0, stdout: 'body\x00\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n' };
    }
    if (args.includes('log')) {
      host.logCalls++;
      if (host.logGate) await host.logGate;
      // 최신이 먼저, 직선 이력.
      const n = host.commits.length;
      const out = host.commits.map((h, i) => record(h, i + 1 < n ? host.commits[i + 1] : '', n - i)).join('');
      return { ok: true, exit_code: 0, stdout: out };
    }
    return { ok: true, exit_code: 0, stdout: '' };
  };
  hecaton.fs.stat = async () => ({ exists: true, mtime_ms: 1000 });
  hecaton.fs.read_dir = async () => ({ ok: false });
  hecaton.fs.read_file = async () => ({ content: '' });
  hecaton.window.set_title = async () => ({ ok: true });
  return host;
}

function resetState(cwd) {
  state.cwd = cwd; state.isGitRepo = true;
  state.gitDir = cwd + SEP + '.git'; state.gitCommonDir = state.gitDir;
  state.rightView = 'status';
  state.stashes = []; state.logItems = []; state.logSelectables = [];
  state.logCursor = 0; state.logScrollOffset = 0;
  state.logLoading = false; state.logLoadingMore = false; state.recoveryRefs = {};
  ui.logShowRecovery = false; ui.logScrollPin = undefined;
}

async function settle() {
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (!state.logLoading) return;
  }
}

const hashAt = i => state.logItems[i] && state.logItems[i].hash;
const selectedHash = () => hashAt(state.logSelectables[state.logCursor]);

test('새 커밋이 맨 위에 들어와도 보던 줄과 고른 커밋을 지킨다', async () => {
  const cwd = 'C:/log-anchor-a';
  const host = installHost(cwd);
  resetState(cwd);
  host.commits = Array.from({ length: 100 }, (_, i) => hex(1000 + i));
  refreshLog({ force: true });
  await settle();
  assert.equal(state.logItems.length, 100);

  // 스크롤해서 커서를 화면 밖에 둔 상태(호스트 스크롤이 거는 고정).
  state.logScrollOffset = 40;
  state.logCursor = 10;
  ui.logScrollPin = 10;
  const top = hashAt(40), sel = selectedHash();

  host.commits = [hex(1), hex(2), hex(3), ...host.commits];
  refreshLog({ force: true });
  await settle();
  assert.equal(state.logItems.length, 103);
  assert.equal(hashAt(state.logScrollOffset), top, '보던 맨 윗줄이 그대로여야 한다');
  assert.equal(state.logScrollOffset, 43);
  assert.equal(selectedHash(), sel, '고른 커밋이 그대로여야 한다');
  assert.equal(ui.logScrollPin, state.logCursor, '스크롤 고정도 커서를 따라가야 한다');
});

test('맨 위(첫 커밋을 고른 채 첫 줄)에 있으면 새 커밋을 보이고 선택도 맨 위를 따른다', async () => {
  const cwd = 'C:/log-anchor-b';
  const host = installHost(cwd);
  resetState(cwd);
  host.commits = Array.from({ length: 50 }, (_, i) => hex(2000 + i));
  refreshLog({ force: true });
  await settle();
  host.commits = [hex(9), ...host.commits];
  refreshLog({ force: true });
  await settle();
  assert.equal(state.logScrollOffset, 0);
  assert.equal(selectedHash(), hex(9));
});

test('더 읽는 동안 더 내려간 위치를 되돌리지 않는다', async () => {
  const cwd = 'C:/log-anchor-c';
  const host = installHost(cwd);
  resetState(cwd);
  host.commits = Array.from({ length: 120 }, (_, i) => hex(3000 + i));
  refreshLog({ force: true });
  await settle();
  state.logHasMore = true;
  state.logScrollOffset = 60;
  state.logCursor = 5; ui.logScrollPin = 5;

  let open;
  host.logGate = new Promise(r => { open = r; });
  assert.equal(loadMoreLog() !== false, true, '더 읽기가 시작돼야 한다');
  // 읽는 동안 호스트 스크롤로 더 내려갔다.
  state.logScrollOffset = 80;
  const top = hashAt(80);
  host.commits = [...host.commits, ...Array.from({ length: 30 }, (_, i) => hex(5000 + i))];
  open();
  for (let i = 0; i < 100 && state.logLoadingMore; i++) await new Promise(r => setImmediate(r));
  host.logGate = null;
  assert.equal(state.logItems.length, 150);
  assert.equal(state.logScrollOffset, 80, '읽는 동안 옮긴 위치가 남아야 한다');
  assert.equal(hashAt(80), top);
});

test('같은 커밋의 상세는 갱신이 다시 불러도 헤더만 남기지 않고, 접은 파일·위치를 지킨다', async () => {
  const cwd = 'C:/log-anchor-d';
  const host = installHost(cwd);
  resetState(cwd);
  host.commits = Array.from({ length: 5 }, (_, i) => hex(7000 + i));
  refreshLog({ force: true });
  await settle();
  state.rightView = 'log';
  state.logCursor = 2;
  updateLogDetail();
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  const full = state.logDetailLines;
  assert.ok(full.some(l => l.startsWith('diff --git')), '패치까지 올라와야 한다');
  ui.collapsedDetailFiles.add('a.txt');
  state.diffScrollX = 4;

  // 상태 갱신이 로그 캐시 적중으로 다시 부른다(refresh.js 의 cacheHit 경로).
  const shows = host.showCalls;
  updateLogDetail();
  assert.equal(state.logDetailLines, full, '같은 커밋이면 상세를 갈아 끼우지 않는다');
  updateLogDetail({ headerOnly: true });
  assert.equal(state.logDetailLines, full, '헤더만으로 되돌리지 않는다');
  assert.ok(ui.collapsedDetailFiles.has('a.txt'), '접어 둔 파일을 펼치지 않는다');
  assert.equal(state.diffScrollX, 4);
  assert.equal(host.showCalls, shows, '다시 읽지 않는다');

  // 다른 커밋을 고르면 예전처럼 헤더부터 보이고 패치를 읽는다.
  state.logCursor = 3;
  updateLogDetail();
  assert.notEqual(state.logDetailLines, full);
  assert.ok(!state.logDetailLines.some(l => l.startsWith('diff --git')), '헤더부터 보인다');
  assert.equal(ui.collapsedDetailFiles.size, 0);
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.ok(state.logDetailLines.some(l => l.startsWith('diff --git')));
});
