// 확인창을 거쳐 미뤄진 동작의 재검사 검증.
//
// 배경: 확인 다이얼로그를 여는 시점에는 guardAction 이 걸렸지만, 사용자가 확인 버튼을
// 누르는 시점에는 아무 검사도 없었다. 그 사이에 다른 작업이 시작되거나 인덱스가 잠기면
// 이미 지나간 판정만 믿고 실행됐다. 특히 index.lock 삭제는 "작업이 끝난 뒤에만"이라고
// 코드에 적어 두고도 확인 버튼 시점 검사가 없었다.
//
// 재검사가 봐야 할 것과 보지 말아야 할 것이 갈린다:
//   - 봐야 할 것: 지금 시작해도 되는 상황인가 (로딩·락·진행 중인 작업·자원 겹침)
//   - 보지 말아야 할 것: 대상 조건. 무엇에 대고 실행할지는 창을 열 때 이미 정해져
//     pending 상태로 보관된다. 지금 화면의 선택을 다시 보면 엉뚱하게 막힌다.
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
const { startBlockedReason, disabledReason, SCOPE } = actions;
const { startSpinner, stopSpinner, resetOps } = require('../spinner');

const { INDEX, WORKTREE, REFS, REMOTE, STASH } = SCOPE;

function idle(over = {}) {
  resetOps();
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
  state.stashes = [{ ref: 'stash@{0}' }];
  state.worktrees = [];
  state.staged = [{ status: 'M', file: 'a.txt' }];
  state.unstaged = [{ status: 'M', file: 'b.txt' }];
  state.untracked = [];
  state.ignored = [];
  state.conflictView = null;
  state.selectedFiles = new Set();
  state.cursor = 0;
  state.mode = 'normal';
  state.commitMsg = '';
  state.commitAmend = false;
  state.logItems = [{ ref: 'abc1234', decoration: '' }];
  state.logSelectables = [0];
  state.logCursor = 0;
  ui.collapsedSections = {};
  ui.pinnedBranches = [];
  ui.mergeChunkSelections = {};
  Object.assign(state, over);
}

// ── 재검사가 보는 축 ──

test('확인창이 떠 있는 사이 시작된 작업과 겹치면 실행하지 않는다', () => {
  idle();
  // discard 확인창을 띄운 뒤 체크아웃이 시작된 상황.
  startSpinner('Checking out...', [INDEX, WORKTREE, REFS]);
  assert.equal(startBlockedReason('file_discard'), actions.REASON.BUSY);
  assert.equal(startBlockedReason('reset'), actions.REASON.BUSY);
  // 겹치지 않는 것은 그대로 실행된다.
  assert.equal(startBlockedReason('remote_add'), null);
  assert.equal(startBlockedReason('stash_drop'), null);
  stopSpinner();
});

test('확인창이 떠 있는 사이 인덱스가 잠기면 인덱스를 쓰는 것만 막는다', () => {
  idle({ indexLocked: true });
  assert.equal(startBlockedReason('file_discard'), actions.REASON.INDEX_LOCKED);
  assert.equal(startBlockedReason('reset'), actions.REASON.INDEX_LOCKED);
  // 인덱스와 무관한 것은 락과 상관없이 실행된다.
  assert.equal(startBlockedReason('branch_delete'), null);
  assert.equal(startBlockedReason('stash_drop'), null);
  // 락을 지우는 자신은 언제나 열려 있어야 한다 — 아니면 빠져나올 수 없다.
  assert.equal(startBlockedReason('unlockIndex'), null);
});

test('확인창이 떠 있는 사이 rebase 가 걸리면 새 통합 작업을 시작하지 않는다', () => {
  idle({ operationState: { type: 'rebase-merge' } });
  assert.equal(startBlockedReason('branch_delete'), 'Rebase in progress');
  assert.equal(startBlockedReason('reset'), 'Rebase in progress');
  assert.equal(startBlockedReason('stash_apply'), 'Rebase in progress');
});

// ── 재검사가 보지 않는 축 ──

test('대상 조건은 다시 보지 않는다', () => {
  // 확인창이 대상을 이미 들고 있는 상황을 흉내낸다: 화면에는 고른 파일도 없고,
  // 스태시 목록도 비었고, 커밋 선택도 없다. 창을 열 때는 다 있었다.
  idle({ staged: [], unstaged: [], untracked: [], stashes: [], logItems: [], logSelectables: [] });

  // 평소 판정으로는 대상이 없어 막힌다.
  assert.equal(disabledReason('tab_discard_all'), actions.REASON.NO_CHANGES);
  assert.equal(disabledReason('stash_drop'), actions.REASON.NO_STASH);
  assert.equal(disabledReason('reset'), actions.REASON.NO_COMMIT);

  // 확인창 시점에는 그 조건을 보지 않는다 — 대상은 창이 들고 있다.
  assert.equal(startBlockedReason('tab_discard_all'), null);
  assert.equal(startBlockedReason('stash_drop'), null);
  assert.equal(startBlockedReason('reset'), null);
});

test('중단된 작업을 걷어내고 다시 시도하는 길은 그 작업을 이유로 막지 않는다', () => {
  idle({ operationState: { type: 'rebase-merge' } });
  // 평소에는 rebase 중 새 rebase 를 막는다.
  assert.equal(startBlockedReason('rebase'), 'Rebase in progress');
  // Abort & Retry 는 그 rebase 를 스스로 걷어낸다 — 막으면 빠져나올 방법이 없다.
  assert.equal(startBlockedReason('rebase', null, { allowDuringOperation: true }), null);
  // 자원 겹침은 그 예외에서도 그대로 본다.
  startSpinner('Staging...', [INDEX]);
  assert.equal(startBlockedReason('rebase', null, { allowDuringOperation: true }), actions.REASON.BUSY);
  stopSpinner();
});

test('읽기 동작은 확인창 시점에도 그대로 통과한다', () => {
  idle();
  startSpinner('Committing...', [INDEX, WORKTREE, REFS]);
  assert.equal(startBlockedReason('copy_sha'), null);
  assert.equal(startBlockedReason('file_open'), null);
  stopSpinner();
});

// ── index.lock 판정을 자원 표에서 유도한다 (예전에는 수기 목록이었다) ──

test('락이 걸려도 인덱스를 쓰지 않는 동작은 열려 있다', () => {
  idle({ indexLocked: true });
  // 예전 수기 목록에서 빠져 있던 것들 — 인덱스와 아무 상관이 없는데 함께 막혔다.
  for (const id of ['git-push', 'branch_push', 'branch_force_push', 'remote_push_tags',
    'branch_delete', 'branch_delete_remote', 'new_tag', 'stash_drop', 'stash_rename',
    'file_ignore_name', 'push_to_remote:origin', 'tag_push:v1', 'tag_delete:v1']) {
    assert.notEqual(disabledReason(id), actions.REASON.INDEX_LOCKED,
      id + ' 는 인덱스를 쓰지 않으므로 락과 무관하다');
  }
});

test('락이 걸리면 인덱스를 쓰는 동작은 그대로 막힌다', () => {
  idle({ indexLocked: true });
  for (const id of ['stageAll', 'unstageAll', 'commit-submit', 'file_discard',
    'branch_checkout', 'merge', 'git-stash', 'git-pull']) {
    assert.equal(disabledReason(id), actions.REASON.INDEX_LOCKED, id + ' 는 인덱스를 쓴다');
  }
  // 저장소를 갈아 끼우는 길과 락 해제 자신은 예외다.
  for (const id of ['unlockIndex', 'tab_clone', 'tab_change_repo', 'worktree_open']) {
    assert.notEqual(disabledReason(id), actions.REASON.INDEX_LOCKED, id + ' 는 예외다');
  }
});

// ── 동작이 요구하는 자원은 그 동작이 시작하는 작업의 자원을 덮어야 한다 ──
// 좁게 적힌 동작이 넓게 점유하는 작업을 시작하면, 판정하지 않은 자원 위에서 두 작업이
// 나란히 서고 끝낼 때 서로를 잘못 끝낸다. 실행부와 표가 함께 바뀌었는지 지킨다.
test('스태시 재시도가 딸린 동작은 스태시까지 미리 요구한다', () => {
  idle();
  startSpinner('Rename stash...', [STASH]);
  // 이들은 실패 시 stash 로 워킹트리를 비우고 다시 시도한다 — 그 재시도가 STASH 를 쓴다.
  for (const id of ['new_branch', 'branch_new_branch', 'rebase', 'branch_rebase_onto']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 스태시 재시도를 품는다');
  }
  // 그런 재시도가 없는 체크아웃·머지는 스태시와 무관하다.
  for (const id of ['branch_checkout', 'merge', 'reset', 'revert']) {
    assert.equal(disabledReason(id), null, id + ' 는 스태시를 쓰지 않는다');
  }
  stopSpinner();
});

// ── 확인창이 하나도 빠지지 않았는지 ──
// 재검사는 대응표(DIALOG_ACTION_IDS)에 적힌 확인창에만 걸린다. 새 확인창을 만들면서
// 표에 넣는 것을 잊으면 그 창만 조용히 무방비가 된다 — 눈에 띄지 않으므로 여기서 잡는다.
test('모든 확인창이 재검사 대응표에 올라 있다', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'context-menu.js'), 'utf8')
    + fs.readFileSync(path.join(root, 'input.js'), 'utf8');

  // pendingDialogAction 에 실리는 이름을 전부 모은다. 삼항으로 갈라 세팅하는 곳이
  // 있으므로(pull-other-branch) 대입 오른쪽에 나오는 문자열을 모두 본다.
  const assigned = new Set();
  for (const m of src.matchAll(/pendingDialogAction = ([^;]+);/g)) {
    for (const lit of m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)) assigned.add(lit[1]);
  }
  assert.ok(assigned.size > 20, '확인창 이름을 제대로 모으지 못했다: ' + assigned.size);

  // 대응표에 적힌 이름.
  const tableBlock = src.match(/const DIALOG_ACTION_IDS = \{([\s\S]*?)\n\};/);
  assert.ok(tableBlock, 'DIALOG_ACTION_IDS 를 찾지 못했다');
  const mapped = new Map();
  for (const m of tableBlock[1].matchAll(/'([a-z][a-z0-9-]*)':\s*'([^']+)'/g)) {
    mapped.set(m[1], m[2]);
  }

  const missing = [...assigned].filter(a => !mapped.has(a)).sort();
  assert.deepEqual(missing, [], '재검사 대응표에 빠진 확인창: ' + missing.join(', '));

  // 표가 가리키는 동작 id 도 실재해야 한다 — 오타면 재검사가 조용히 통과한다.
  for (const [dialog, id] of mapped) {
    assert.notEqual(startBlockedReason(id), undefined, dialog + ' 의 대상 id 가 이상하다: ' + id);
    assert.ok(actions.scopesOf(id).length > 0, dialog + ' 의 대상 id 에 자원이 없다: ' + id);
  }
});
