// 진행 중인 작업이 "무엇을 붙잡고 있는가"에 따른 차단 범위 검증.
//
// 배경: 예전에는 진행 여부가 불리언 하나(spinnerActive)였다. 그래서 브랜치 리네임처럼
// ref 만 옮기는 작업이 도는 동안에도 스테이징·커밋·discard 가 전부 함께 막혔다.
// 리네임은 인덱스도 워킹트리도 건드리지 않으므로 겹칠 일이 없는데도 그랬다.
//
// 지금은 작업이 붙잡는 자원(scopes)을 함께 등록하고, 그것과 겹치는 동작만 막는다.
// 여기서 검증할 것은 세 가지다:
//   1. 겹치지 않는 동작은 열어 두고, 겹치는 동작은 그대로 막는다
//   2. 뒷정리 갱신도 원래 작업과 같은 범위만 막는다 (낡는 것은 그 작업이 바꾼 부분뿐)
//   3. 작업 두 개가 겹쳐 돌 때 먼저 끝난 쪽이 남은 작업의 진행 표시를 지우지 않는다
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
const { isEnabled, disabledReason, SCOPE } = actions;
const spinner = require('../spinner');
const { startSpinner, stopSpinner, startSettleOp, endSettleOp, resetOps, isSpinning, releaseSpinner } = spinner;

const { INDEX, WORKTREE, REFS, REMOTE, STASH, CONFIG } = SCOPE;

// 아무 제약이 없는 평범한 저장소. 각 테스트는 여기서 작업 하나만 걸어 본다.
function idle() {
  resetOps();
  state.loading = false;
  state.isGitRepo = true;
  state.indexLocked = false;
  state.operationState = null;
  state.error = null;
  state.refreshing = false;
  state.refreshMessage = '';
  state.minimized = true;   // 화면 출력을 한 줄로 줄인다 — 판정에는 영향이 없다
  state.cwd = 'C:/repo';
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }, { name: 'dev', isCurrent: false, upstream: '' }];
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
  state.commitMsg = 'hello';
  state.commitAmend = false;
  state.logItems = [{ ref: 'abc1234', decoration: '' }];
  state.logSelectables = [0];
  state.logCursor = 0;
  ui.collapsedSections = {};
  ui.pinnedBranches = [];
  ui.mergeChunkSelections = {};
}

test.afterEach(() => {
  resetOps();
  state.error = null;
  while (isSpinning()) releaseSpinner();
});

// ── 1. 겹치지 않으면 막지 않는다 ──

// 사용자가 겪은 그대로의 상황: 리네임이 도는 동안 Stage/Unstage 버튼이 회색이었다.
// `git branch -m` 은 ref 를 옮기고 config 섹션을 따라 옮길 뿐, .git/index 도
// 워킹트리도 건드리지 않는다 — 스테이징과 겹칠 일이 없다.
test('브랜치 리네임 중에도 스테이징은 열려 있다', () => {
  idle();
  startSpinner('Rename branch...', [REFS, CONFIG]);

  for (const id of ['stageAll', 'stageSelected', 'unstageAll', 'file_stage', 'hunk-apply']) {
    assert.equal(isEnabled(id), true, id + ' 는 리네임과 겹치지 않는다');
  }
  // 리모트만 쓰는 것도 그대로다.
  assert.equal(isEnabled('git-fetch'), true);
  assert.equal(isEnabled('git-push'), true);

  stopSpinner();
});

test('브랜치 리네임 중에는 ref 를 건드리는 동작이 막힌다', () => {
  idle();
  startSpinner('Rename branch...', [REFS, CONFIG]);

  for (const id of ['branch_checkout', 'branch_delete', 'new_tag', 'merge', 'reset',
    'commit-submit', 'branch_track', 'committer-name']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 ref/config 를 함께 쓴다');
  }

  stopSpinner();
});

test('fetch/push 중에는 자원을 밝힌 로컬 작업이 열려 있다', () => {
  idle();
  startSpinner('Fetching...', [REMOTE]);

  for (const id of ['stageAll', 'unstageAll', 'branch_rename', 'branch_delete',
    'stash_drop', 'new_tag', 'committer-name']) {
    assert.equal(isEnabled(id), true, id + ' 는 리모트와 겹치지 않는다');
  }
  // 리모트를 쓰는 것끼리는 여전히 막힌다.
  assert.equal(disabledReason('git-push'), actions.REASON.BUSY);
  assert.equal(disabledReason('git-pull'), actions.REASON.BUSY);
  // 커밋·체크아웃은 아직 작업 쪽이 자원을 밝히지 않아 동작 쪽도 전부로 잡아 둔다.
  assert.equal(disabledReason('commit-submit'), actions.REASON.BUSY);

  stopSpinner();
});

test('스테이징 중에는 인덱스를 쓰는 것만 막히고 리네임·fetch 는 열려 있다', () => {
  idle();
  startSpinner('Staging...', [INDEX]);

  for (const id of ['unstageAll', 'unstageSelected', 'commit-submit', 'commit-enter',
    'tab_discard_all', 'git-stash']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 인덱스를 함께 쓴다');
  }
  for (const id of ['git-fetch', 'git-push', 'branch_rename', 'branch_delete',
    'stash_drop', 'new_tag', 'committer-name']) {
    assert.equal(isEnabled(id), true, id + ' 는 인덱스와 겹치지 않는다');
  }

  stopSpinner();
});

test('스태시 이름 변경은 스태시 목록만 붙잡는다', () => {
  idle();
  startSpinner('Rename stash...', [STASH]);

  assert.equal(isEnabled('stageAll'), true);
  assert.equal(isEnabled('git-fetch'), true);
  assert.equal(isEnabled('branch_rename'), true);
  assert.equal(disabledReason('stash_drop'), actions.REASON.BUSY);
  // 스태시 저장/적용은 워킹트리도 오가므로 아직 전부로 잡아 둔다.
  assert.equal(disabledReason('git-stash'), actions.REASON.BUSY);

  stopSpinner();
});

// ── 2. 자원을 밝히지 않은 작업은 예전 그대로 ──

// 아직 스코프를 지정하지 않은 호출부(체크아웃·머지·리베이스 등)는 무엇을 붙잡는지
// 알 수 없다. 판단이 불확실할 때는 막는 쪽이 안전하다 — 예전과 같은 전면 차단이다.
test('자원을 밝히지 않은 작업은 쓰기를 전부 막는다', () => {
  idle();
  startSpinner('Checking out...');

  for (const id of ['stageAll', 'unstageAll', 'commit-submit', 'git-fetch',
    'git-push', 'branch_rename', 'stash_drop']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 막혀야 한다');
  }
  // 읽기 동작은 그때도 그대로다.
  assert.equal(isEnabled('copy_sha'), true);
  assert.equal(isEnabled('tab-commits'), true);

  stopSpinner();
});

// ── 3. 뒷정리 갱신도 같은 범위만 막는다 ──

// 뒷정리를 막는 이유는 자원 충돌이 아니라 "화면의 목록이 아직 낡았다"는 것이다.
// 낡는 것은 그 작업이 바꾼 부분뿐이므로, 범위는 원래 작업과 같아야 한다.
test('뒷정리 갱신은 원래 작업의 자원을 물려받는다', () => {
  idle();
  const op = startSpinner('Rename branch...', [REFS, CONFIG]);
  // afterGitOp 의 순서: 뒷정리를 먼저 걸고, 그다음 원래 작업을 내린다.
  const settle = startSettleOp('Rename branch...');
  stopSpinner(op);

  assert.equal(state.spinnerActive, false, 'git 명령은 끝났다');
  assert.equal(state.settlingWrite, true, '뒷정리는 아직 돈다');
  assert.equal(isEnabled('stageAll'), true, '리네임 뒷정리 중의 파일 목록은 낡지 않았다');
  assert.equal(disabledReason('branch_delete'), actions.REASON.BUSY, 'ref 목록은 아직 낡았다');

  endSettleOp(settle);
  assert.equal(state.settlingWrite, false);
  assert.equal(isEnabled('branch_delete'), true);
});

test('커밋 뒷정리 중에는 인덱스를 쓰는 동작이 그대로 막힌다', () => {
  idle();
  const op = startSpinner('Committing...', [INDEX, REFS]);
  const settle = startSettleOp('Committing...');
  stopSpinner(op);

  // 실제로 겪은 사고 — 커밋이 끝나도 화면의 Staged 목록은 커밋 직전 그대로였고,
  // 거기 대고 Unstage 를 쏘면 이미 사라진 대상을 상대하게 된다.
  for (const id of ['unstageAll', 'unstageSelected', 'stageAll', 'commit-submit']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 뒷정리가 끝날 때까지 막힌다');
  }
  assert.equal(isEnabled('git-fetch'), true, 'fetch 는 커밋과 겹치지 않는다');

  endSettleOp(settle);
});

// ── 4. 겹쳐 도는 두 작업 ──

// 예전에는 stopSpinner 가 진행 표시를 무조건 껐다. 그래서 두 작업이 겹치면 먼저 끝난
// 쪽이 남은 작업의 이름까지 지워, 아직 돌고 있는데 타이틀은 맨 상태가 됐다.
test('한 작업이 끝나도 남은 작업의 진행 표시는 그대로다', () => {
  idle();
  const fetchOp = startSpinner('Fetching...', [REMOTE]);
  const stageOp = startSpinner('Staging...', [INDEX]);
  assert.equal(state.error, 'Staging...', '방금 시킨 일이 앞에 온다');

  stopSpinner(stageOp);
  assert.equal(state.spinnerActive, true, 'fetch 는 아직 돈다');
  assert.equal(state.error, 'Fetching...', '남은 작업의 이름으로 이어져야 한다');
  // 끝난 쪽의 자원은 풀린다.
  assert.equal(isEnabled('unstageAll'), true);
  assert.equal(disabledReason('git-push'), actions.REASON.BUSY);

  stopSpinner(fetchOp);
  assert.equal(state.spinnerActive, false);
  assert.equal(state.error, null);
  assert.equal(isEnabled('git-push'), true);
});

test('겹쳐 도는 두 작업의 자원은 함께 막힌다', () => {
  idle();
  const fetchOp = startSpinner('Fetching...', [REMOTE]);
  const stageOp = startSpinner('Staging...', [INDEX]);

  assert.equal(disabledReason('git-push'), actions.REASON.BUSY);
  assert.equal(disabledReason('unstageAll'), actions.REASON.BUSY);
  // 둘 다와 겹치지 않는 것은 그대로 열려 있다.
  assert.equal(isEnabled('branch_rename'), true);
  assert.equal(isEnabled('stash_drop'), true);

  stopSpinner(stageOp);
  stopSpinner(fetchOp);
});

// ── 5. 자원을 밝히지 않은 동작은 무엇과도 겹친다 ──

// 이것이 안전의 뿌리다. 동작 쪽만 좁게 적고 작업 쪽이 전부를 붙잡으면, 좁은 판정을
// 통과해 시작된 전면 점유 작업이 이미 돌던 작업과 나란히 서고 — 그러면 끝낼 때
// 서로를 잘못 끝낸다. 그래서 표에 없는 동작은 어떤 작업과도 겹치는 것으로 본다.
test('표에 없는 동작은 아무리 좁은 작업이 돌아도 막힌다', () => {
  idle();
  // 가장 좁은 작업 하나만 걸어 둔다.
  startSpinner('Rename stash...', [STASH]);

  for (const id of ['branch_checkout', 'merge', 'rebase', 'reset', 'commit-submit',
    'tab_discard_all', 'git-pull', 'worktree_new']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY,
      id + ' 는 자원을 밝히지 않았으므로 전부와 겹쳐야 한다');
  }
  // 진행 중인 작업에서 빠져나오는 길도 마찬가지다 — 단, 나갈 작업이 있어야 판정에 닿는다.
  state.operationState = { type: 'merge' };
  assert.equal(disabledReason('op-abort'), actions.REASON.BUSY);
  state.operationState = null;

  stopSpinner();
});

test('자원을 밝힌 동작의 목록은 전부 알려진 자원 이름만 쓴다', () => {
  const known = new Set(Object.values(SCOPE));
  for (const [id, scopes] of Object.entries(require('../actions').ACTION_SCOPES || {})) {
    for (const sc of scopes) {
      assert.ok(known.has(sc), id + ' 에 알 수 없는 자원 이름이 있다: ' + sc);
    }
  }
  // scopesOf 는 모르는 id 에 대해 전체를 돌려준다.
  assert.deepEqual(actions.scopesOf('무엇인지-모를-동작'), actions.ALL_SCOPES);
});

// ── 6. 메뉴 표시와 실행 판정이 같은 규칙을 본다 ──

test('리네임 중 메뉴의 enabled 도 자원 기준으로 갈린다', () => {
  idle();
  startSpinner('Rename branch...', [REFS, CONFIG]);

  const items = actions.decorateMenuItems([
    { id: 'file_stage', label: 'Stage' },
    { id: 'branch_delete', label: 'Delete' },
    { id: 'branch_copy_name', label: 'Copy' },
  ]);
  assert.equal(items[0].enabled, undefined, '스테이징은 잠기지 않는다');
  assert.equal(items[1].enabled, false, 'ref 를 쓰는 항목은 잠긴다');
  assert.equal(items[2].enabled, undefined, '복사는 언제나 열려 있다');

  stopSpinner();
});
