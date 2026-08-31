// 진행 중인 작업과 겹쳐 막힌 동작의 예약(대기열) 검증.
//
// 배경: 판정은 "지금 되는가"에만 답했고, 안 되면 그대로 버렸다. 커밋을 걸고 곧바로
// Push 를 누르면 "busy, action ignored"가 잠깐 뜰 뿐이라, 커밋의 git 명령과 뒷정리
// 갱신이 끝나기를 지켜보다 다시 눌러야 했다 — 이 환경에서는 그 뒷정리가 명령 자체보다
// 오래 걸린다.
//
// 여기서 검증할 것은 네 가지다:
//   1. 막힌 동작이 버려지지 않고 예약된다 — 단, 예약해도 되는 동작만
//   2. 자원이 풀리는 순간 예약이 실행된다
//   3. 뒷정리(settling)는 리모트 동작을 막지 않는다 — 목록이 낡는 것과 무관하다
//   4. 예약과 실행 사이에 상황이 바뀌면 조용히 나가지 않고 취소된다
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  terminal: {},
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  process: { exec: async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' }) },
  fs: { stat: async () => ({ exists: false }), read_dir: async () => ({ ok: false }), read_file: async () => ({ content: '' }) },
  window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({ ok: true }), set: async () => ({}), remove: async () => ({}) },
  clipboard: { write: async () => ({ ok: true }), read: async () => ({ text: '' }) },
  dialog: { show: () => Promise.resolve({}) },
  menu: { show: () => Promise.resolve({}) },
};

const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('\x1b[')) return true;
  return _origWrite(chunk, ...rest);
};

const { state, ui } = require('../state');
const actions = require('../actions');
const { isEnabled, disabledReason, runOrQueue, guardOrQueue, SCOPE } = actions;
const queue = require('../queue');
const spinner = require('../spinner');
const { startSpinner, stopSpinner, startSettleOp, endSettleOp, resetOps, isSpinning, releaseSpinner } = spinner;
const { formatProgressStatus } = require('../title');

const { INDEX, WORKTREE, REFS, REMOTE, CONFIG } = SCOPE;

function idle() {
  resetOps();
  queue.clear();
  state.loading = false;
  state.isGitRepo = true;
  state.indexLocked = false;
  state.operationState = null;
  state.error = null;
  state.refreshing = false;
  state.refreshMessage = '';
  state.minimized = true;
  state.cwd = 'C:/repo';
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main'];
  state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [];
  state.staged = [{ status: 'M', file: 'a.txt' }];
  state.unstaged = [{ status: 'M', file: 'b.txt' }];
  state.untracked = [];
  state.ignored = [];
  state.conflictView = null;
  state.selectedFiles = new Set();
  state.cursor = 0;
  state.mode = 'normal';
  state.commitMsg = 'hello';
  state.commitAmend = false;
  state.logItems = [];
  state.logSelectables = [];
  state.logCursor = 0;
  state.busyFlashUntil = 0;
  state.spinnerFrame = 0;
  ui.collapsedSections = {};
  ui.pinnedBranches = [];
  ui.mergeChunkSelections = {};
  ui.hoveredAction = null;
}

test.afterEach(() => {
  queue.clear();
  resetOps();
  state.error = null;
  while (isSpinning()) releaseSpinner();
});

// scheduleDrain 은 한 틱 뒤에 돈다(작업을 끝내는 도중에 새 작업이 등록부를 건드리지
// 않게 하려고). 테스트는 그 틱을 넘겨준다.
function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── 1. 막힌 동작이 예약된다 ──

test('커밋 중에 누른 Push 는 버려지지 않고 예약된다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  let pushed = 0;
  // 사용자가 겪은 그대로 — 커밋을 걸어 두고 곧바로 Push 를 누른다.
  const ran = runOrQueue('git-push', () => { pushed++; });

  assert.equal(ran, false, '지금 나가지는 않는다');
  assert.equal(pushed, 0);
  assert.equal(queue.has('git-push'), true, '예약으로 남아야 한다');
  assert.equal(queue.summary(), 'Push');

  stopSpinner(commitOp);
});

test('예약은 진행 표시 뒤에 이름으로 붙는다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);
  runOrQueue('git-push', () => {});

  const title = formatProgressStatus();
  assert.ok(title.includes('Committing...'), '무슨 작업이 도는지가 먼저다: ' + title);
  assert.ok(title.includes('→ Push'), '무엇이 이어지는지가 그 뒤에 온다: ' + title);

  stopSpinner(commitOp);
});

test('같은 동작을 두 번 눌러도 예약은 하나다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  runOrQueue('git-push', () => {});
  assert.equal(queue.size(), 1);
  // 두 번째 클릭은 취소로 읽는다 — 예약을 걷어낼 다른 길이 없다.
  runOrQueue('git-push', () => {});
  assert.equal(queue.size(), 0, '다시 누르면 예약이 풀린다');

  stopSpinner(commitOp);
});

test('여러 동작을 예약하면 개수까지 알려 준다', () => {
  idle();
  // fetch 가 리모트를 붙잡는 동안에는 push 도 다음 fetch 도 함께 막힌다.
  const fetchOp = startSpinner('Fetching...', [REMOTE]);

  runOrQueue('git-push', () => {});
  runOrQueue('git-fetch', () => {});
  assert.equal(queue.size(), 2);
  assert.equal(queue.summary(), 'Push +1');

  stopSpinner(fetchOp);
});

// Push 버튼은 리모트가 여럿이면 메뉴를 거쳐 'push_to_remote:<remote>' 로 갈라진다.
// 사용자에게는 같은 버튼이므로, 갈라진 이름으로 예약해도 버튼이 그것을 알아야 한다.
test('리모트를 고른 뒤의 Push 도 같은 버튼의 예약으로 읽힌다', () => {
  idle();
  const fetchOp = startSpinner('Fetching...', [REMOTE]);

  runOrQueue('push_to_remote:origin', () => {});
  assert.equal(queue.hasFor('git-push'), true, 'Push 버튼이 예약 상태로 보여야 한다');
  // 같은 버튼을 다시 눌러 취소할 수 있어야 한다 — 못 하면 물릴 방법이 없는 예약이 남는다.
  assert.equal(queue.cancelFor('git-push'), true);
  assert.equal(queue.size(), 0);

  stopSpinner(fetchOp);
});

// ── 2. 예약할 수 없는 동작 ──

// 예약이 사고가 되는 지점은 정확히 여기다. 커밋 뒤의 Staged 목록은 이미 비어 있는데,
// 예약된 Unstage 는 커밋 직전 화면에서 고른 파일들을 상대로 나간다.
test('화면에서 대상을 고르는 동작은 예약되지 않는다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  for (const id of ['unstageAll', 'stageAll', 'file_discard', 'tab_discard_all', 'reset']) {
    let ran = 0;
    runOrQueue(id, () => { ran++; });
    assert.equal(ran, 0, id + ' 는 실행되지 않는다');
    assert.equal(queue.has(id), false, id + ' 는 예약 대상이 아니다');
  }
  assert.equal(queue.size(), 0);

  stopSpinner(commitOp);
});

// 기다린다고 풀리는 사유가 아니면 예약해 봐야 같은 자리에 머문다.
test('자원 겹침이 아닌 사유는 예약하지 않고 그대로 알린다', () => {
  idle();
  state.remotes = [];   // 리모트가 없다 — 작업이 끝나도 push 는 성립하지 않는다

  let ran = 0;
  runOrQueue('git-push', () => { ran++; });
  assert.equal(ran, 0);
  assert.equal(queue.size(), 0, '기다려도 풀리지 않는 사유다');
  assert.equal(disabledReason('git-push'), actions.REASON.NO_REMOTE);
});

// ── 3. 자원이 풀리면 실행된다 ──

test('커밋이 끝나면 예약된 Push 가 나간다', async () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  let pushed = 0;
  runOrQueue('git-push', () => { pushed++; });
  assert.equal(pushed, 0);

  stopSpinner(commitOp);
  await nextTick();

  assert.equal(pushed, 1, '자원이 풀리는 순간 실행돼야 한다');
  assert.equal(queue.size(), 0, '실행된 예약은 남지 않는다');
});

// 실제 흐름은 이렇다: 커밋의 git 명령이 끝나면서 뒷정리 갱신이 이어 등록되고,
// 그다음 원래 작업이 내려간다(afterGitOp 의 순서). 예약은 그 사이에 풀려야 한다 —
// 뒷정리까지 기다리면 기다림의 대부분이 그대로 남는다.
test('뒷정리 갱신이 남아 있어도 예약된 Push 는 나간다', async () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  let pushed = 0;
  runOrQueue('git-push', () => { pushed++; });

  const settle = startSettleOp('Committing...');
  stopSpinner(commitOp);
  await nextTick();

  assert.equal(state.settlingWrite, true, '목록 갱신은 아직 돈다');
  assert.equal(pushed, 1, 'push 는 그 옆에서 나간다');

  endSettleOp(settle);
});

test('예약이 실행되며 시작한 작업은 뒤의 예약을 다시 막는다', async () => {
  idle();
  // 리모트를 붙잡는 작업이라야 push 도 fetch 도 함께 막힌다 — 커밋만으로는 fetch 가
  // 겹치지 않아 그 자리에서 나간다(그것이 자원 판정의 본래 목적이다).
  const runningFetch = startSpinner('Fetching...', [REMOTE]);

  const order = [];
  let pushOp = null;
  runOrQueue('git-push', () => {
    order.push('push');
    pushOp = startSpinner('Pushing...', [REMOTE]);
  });
  runOrQueue('git-fetch', () => { order.push('fetch'); });

  stopSpinner(runningFetch);
  await nextTick();

  assert.deepEqual(order, ['push'], 'push 가 리모트를 잡은 동안 fetch 는 기다린다');
  assert.equal(queue.has('git-fetch'), true);

  stopSpinner(pushOp);
  await nextTick();
  assert.deepEqual(order, ['push', 'fetch'], '리모트가 풀리면 이어서 나간다');
});

// ── 4. 뒷정리는 리모트 동작을 막지 않는다 ──

// 뒷정리가 막는 것은 자원 경합이 아니라 "화면의 목록이 아직 낡았다"는 사실이다.
// push/pull/fetch 는 대상을 화면에서 고르지 않으므로 그 낡음과 무관하다.
test('커밋 뒷정리 중에도 리모트 동작은 열려 있다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);
  const settle = startSettleOp('Committing...');
  stopSpinner(commitOp);

  assert.equal(state.spinnerActive, false, 'git 명령은 끝났다');
  assert.equal(state.settlingWrite, true, '뒷정리는 아직 돈다');
  for (const id of ['git-push', 'git-pull', 'git-fetch', 'push_to_remote:origin']) {
    assert.equal(isEnabled(id), true, id + ' 는 목록이 낡은 것과 무관하다');
  }

  endSettleOp(settle);
});

// 위 완화가 넘치지 않았는지 — 뒷정리를 두는 본래 이유는 그대로 지켜져야 한다.
test('뒷정리 중에도 화면 목록을 보는 동작은 그대로 막힌다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);
  const settle = startSettleOp('Committing...');
  stopSpinner(commitOp);

  for (const id of ['unstageAll', 'unstageSelected', 'stageAll', 'commit-submit']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 커밋 직전 목록을 본다');
  }

  endSettleOp(settle);
});

test('git 명령이 도는 동안(running)에는 리모트 동작도 그대로 막힌다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  // 여기서 열어 주면 커밋이 끝나기 전에 push 가 나가 방금 만든 커밋이 빠진 채 올라간다.
  assert.equal(disabledReason('git-push'), actions.REASON.BUSY);
  assert.equal(disabledReason('push_to_remote:origin'), actions.REASON.BUSY);

  stopSpinner(commitOp);
});

// ── 5. 예약과 실행 사이에 상황이 바뀌면 ──

// 예약의 가장 위험한 실패는 이것이다: 체크아웃이 도는 동안 Push 를 예약해 두면,
// 풀려날 때 올라가는 것은 사용자가 누를 때 보던 브랜치가 아니다.
//
// 실행 시점에 브랜치를 다시 보는 것만으로는 이걸 잡을 수 없다. afterGitOp 은 갱신을
// 걸고 그다음 stopSpinner 를 부르므로, 예약이 풀리는 시점의 state.branch 는 아직 옛
// 이름이다. 그래서 애초에 예약을 받지 않는다.
test('워킹트리를 갈아엎는 작업 중에는 Push 를 예약하지 않는다', () => {
  idle();
  const coOp = startSpinner('Checking out...', [INDEX, WORKTREE, REFS]);

  let pushed = 0;
  runOrQueue('git-push', () => { pushed++; });
  assert.equal(pushed, 0);
  assert.equal(queue.size(), 0, '체크아웃 뒤의 push 는 다른 브랜치를 올린다');

  stopSpinner(coOp);
});

test('브랜치를 옮기지 않는 작업 중에는 예약을 받는다', () => {
  idle();
  // 커밋은 인덱스를 트리로 굳히고 HEAD 를 앞으로 옮길 뿐, 브랜치를 바꾸지 않는다.
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);
  runOrQueue('git-push', () => {});
  assert.equal(queue.has('git-push'), true);
  stopSpinner(commitOp);
  queue.clear();

  // fetch 도 마찬가지다 — 리모트 쪽만 건드린다.
  const fetchOp = startSpinner('Fetching...', [REMOTE]);
  runOrQueue('git-push', () => {});
  assert.equal(queue.has('git-push'), true);
  stopSpinner(fetchOp);
});

// 위 방어가 뚫린 경우를 대비한 두 번째 검사. 예약이 여러 번 판정을 거치는 사이
// 갱신이 끝나 브랜치가 바뀌어 있다면, 그때라도 나가지 않아야 한다.
test('실행 직전에 브랜치가 달라져 있으면 예약된 Push 는 취소된다', async () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  let pushed = 0;
  runOrQueue('git-push', () => { pushed++; });
  assert.equal(queue.has('git-push'), true);

  state.branch = 'dev';
  state.branches = [{ name: 'dev', isCurrent: true, upstream: 'origin/dev' }];
  stopSpinner(commitOp);
  await nextTick();

  assert.equal(pushed, 0, '다른 브랜치를 올리면 안 된다');
  assert.equal(queue.size(), 0);
});

test('브랜치와 무관한 Fetch 는 브랜치가 바뀌어도 나간다', async () => {
  idle();
  const coOp = startSpinner('Checking out...', [INDEX, WORKTREE, REFS, REMOTE]);

  let fetched = 0;
  runOrQueue('git-fetch', () => { fetched++; });

  state.branch = 'dev';
  state.branches = [{ name: 'dev', isCurrent: true, upstream: 'origin/dev' }];
  stopSpinner(coOp);
  await nextTick();

  assert.equal(fetched, 1);
});

test('성립하지 않게 된 예약은 조용히 나가지 않고 취소된다', async () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  let pushed = 0;
  runOrQueue('git-push', () => { pushed++; });

  // 예약해 둔 사이에 리모트가 사라졌다.
  state.remotes = [];
  stopSpinner(commitOp);
  await nextTick();

  assert.equal(pushed, 0);
  assert.equal(queue.size(), 0, '남겨 두면 영영 기다린다');
});

// ── 6. 스테이징 ──
// 이 구조에서 가장 자주 씹히던 흐름. git add 는 프로세스를 새로 띄우는 일이고 이
// 환경에서는 그 자체가 느려서, 파일을 하나씩 고르며 s 를 누르면 중간이 통째로 버려졌다.

test('스테이징 중에 고른 다음 파일은 예약된다', () => {
  idle();
  const stageOp = startSpinner('Staging...', [INDEX]);

  let staged = null;
  runOrQueue('stageSelected', list => { staged = list; }, { payload: ['b.txt'] });

  assert.equal(staged, null, '지금 나가지는 않는다');
  assert.equal(queue.has('stageSelected'), true);

  stopSpinner(stageOp);
});

test('연달아 고른 파일은 한 예약으로 합쳐진다', async () => {
  idle();
  const stageOp = startSpinner('Staging...', [INDEX]);

  const runs = [];
  const stage = list => { runs.push(list); };
  runOrQueue('stageSelected', stage, { payload: ['b.txt'] });
  runOrQueue('stageSelected', stage, { payload: ['c.txt'] });
  // 이미 실린 파일을 또 골라도 중복으로 쌓이지 않는다.
  runOrQueue('stageSelected', stage, { payload: ['b.txt', 'd.txt'] });

  assert.equal(queue.size(), 1, '예약은 하나로 남아야 한다');
  assert.ok(queue.summary().startsWith('Stage 3'), '실린 개수를 알려 준다: ' + queue.summary());

  stopSpinner(stageOp);
  await nextTick();

  assert.equal(runs.length, 1, 'git 은 한 번만 부른다');
  assert.deepEqual(runs[0], ['b.txt', 'c.txt', 'd.txt']);
});

// 예약이 실행될 때 화면의 선택을 다시 읽으면, 그때는 사용자가 이미 다른 파일을 고른
// 뒤다. 대상은 누른 그 순간에 확정해 실어 보내야 한다.
test('예약된 스테이징은 예약할 때 고른 파일을 그대로 들고 간다', async () => {
  idle();
  const stageOp = startSpinner('Staging...', [INDEX]);

  let staged = null;
  runOrQueue('stageSelected', list => { staged = list; }, { payload: ['b.txt'] });

  // 그사이 사용자가 다른 파일로 커서를 옮겼다.
  state.unstaged = [{ status: 'M', file: 'zzz.txt' }];
  state.cursor = 0;

  stopSpinner(stageOp);
  await nextTick();

  assert.deepEqual(staged, ['b.txt'], '나중에 고른 파일이 아니라 누를 때 고른 파일이다');
});

// 커밋은 인덱스를 트리로 굳힌다 — 그 뒤에 예약된 Unstage 가 나가면 이미 커밋된
// 파일을 상대하게 된다. blockedBy 가 이걸 예약 단계에서 끊는다.
test('커밋 중에는 스테이징을 예약하지 않는다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  let ran = 0;
  runOrQueue('unstageSelected', () => { ran++; }, { payload: ['a.txt'] });
  runOrQueue('stageAll', () => { ran++; });

  assert.equal(ran, 0);
  assert.equal(queue.size(), 0, '커밋이 대상의 상태를 갈아엎는다');

  stopSpinner(commitOp);
});

test('discard 가 도는 동안에도 스테이징을 예약하지 않는다', () => {
  idle();
  // 워킹트리의 파일 내용을 되돌린다 — 예약해 둔 대상이 그 대상일 수 있다.
  const discardOp = startSpinner('Discarding...', [INDEX, WORKTREE]);

  runOrQueue('stageSelected', () => {}, { payload: ['b.txt'] });
  assert.equal(queue.size(), 0);

  stopSpinner(discardOp);
});

// ── 7. 게이트의 반환 규약 ──

test('guardOrQueue 는 통과할 때만 true 다', () => {
  idle();
  assert.equal(guardOrQueue('git-push', () => {}), true, '막을 것이 없으면 그대로 진행한다');

  const commitOp = startSpinner('Committing...', [INDEX, REFS]);
  assert.equal(guardOrQueue('git-push', () => {}), false, '예약했을 때도 지금 실행하지는 않는다');
  assert.equal(queue.has('git-push'), true);

  stopSpinner(commitOp);
  queue.clear();
});

test('다시 태우는 길을 주지 않으면 예약하지 않는다', () => {
  idle();
  const commitOp = startSpinner('Committing...', [INDEX, REFS]);

  // retry 없이 부르는 호출부(판정만 필요한 곳)는 예전 guardAction 과 똑같이 동작한다.
  assert.equal(guardOrQueue('git-push'), false);
  assert.equal(queue.size(), 0);

  stopSpinner(commitOp);
});

// ── 7. 예약 대상 표의 무결성 ──

// 두 표는 뜻이 다르다. 예약은 "조금 기다렸다 하겠다"이고, 뒷정리 통과는 "목록이 낡은
// 것과 무관하니 지금 해도 된다"이다. 리모트 동작만 둘 다에 해당한다 — 실행 순간의
// 저장소에서 대상이 정해지기 때문이다.
test('리모트 동작은 예약도 되고 뒷정리도 지나친다', () => {
  for (const id of ['git-push', 'git-pull', 'git-fetch', 'push_to_remote:origin']) {
    assert.equal(actions.isQueueable(id), true, id + ' 는 예약할 수 있어야 한다');
    assert.equal(actions.ignoresSettling(id), true, id + ' 는 뒷정리를 지나쳐야 한다');
  }
});

// 스테이징은 예약되지만 뒷정리는 지나치지 않는다. 대상을 들고 가더라도 Stage All 의
// 대상은 "그때의 화면 전부"이고, 뒷정리 중의 그 화면은 아직 작업 직전 상태다.
// (뒷정리를 도는 작업은 REFS 를 잡고 있어 blockedBy 에도 걸리므로, 두 규칙이 같은
//  답을 낸다 — 어느 한쪽만 고쳐도 다른 쪽이 받쳐 준다.)
test('스테이징은 예약 대상이지만 뒷정리는 지나치지 않는다', () => {
  for (const id of ['stageSelected', 'unstageSelected', 'stageAll', 'unstageAll']) {
    assert.equal(actions.isQueueable(id), true, id + ' 는 예약할 수 있어야 한다');
    assert.equal(actions.ignoresSettling(id), false, id + ' 는 뒷정리를 지나칠 수 없다');
  }
});

test('되돌리기 어렵거나 대상이 화면에 매인 동작은 예약 대상이 아니다', () => {
  for (const id of ['commit-submit', 'reset', 'branch_delete', 'file_discard',
    'tab_discard_all', 'git-stash', 'hunk-apply', 'merge', 'rebase']) {
    assert.equal(actions.isQueueable(id), false, id + ' 는 예약 대상이 아니다');
    assert.equal(actions.ignoresSettling(id), false, id + ' 는 뒷정리를 지나칠 수 없다');
  }
});

test('자원을 밝히지 않은 작업은 뒷정리 완화의 대상이 아니다', () => {
  idle();
  // 저장소를 통째로 바꾸는 길(clone/init)은 무엇을 붙잡는지도 어느 단계인지도 밝히지
  // 않는다 — 판단이 불확실할 때는 막는 쪽이다.
  startSpinner('Cloning...');
  assert.equal(disabledReason('git-push'), actions.REASON.BUSY);
  assert.equal(disabledReason('git-fetch'), actions.REASON.BUSY);
  stopSpinner();
});
