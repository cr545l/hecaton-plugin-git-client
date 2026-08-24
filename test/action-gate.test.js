// 상황별 동작 활성/비활성 판정 검증.
//
// 배경: 예전에는 "다른 쓰기 작업이 도는 중인가" 하나만 봤다. 그래서 rebase 진행 중
// 체크아웃, 리모트 없는 저장소의 Push, 아무것도 없는 상태의 Stage 처럼 논리적으로
// 성립하지 않는 조합이 평소와 똑같이 활성으로 보였고, 눌러야만 git 이 뱉는 fatal 로
// 드러났다. 지금은 actions.js 한 곳이 판정하고 render / menu / dispatch 가 그 결과를
// 함께 쓴다 — 그래서 여기서 검증할 것은 두 가지다:
//   1. 상황별로 막을 것을 막고, 막지 말아야 할 것(빠져나오는 길)은 열어 둔다
//   2. 메뉴에 실리는 enabled 와 실행 게이트의 판정이 서로 어긋나지 않는다
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

const { state, ui } = require('../state');
const actions = require('../actions');
const { isEnabled, disabledReason, decorateMenuItems } = actions;
const { buildBranchContextMenuItems, buildTabContextMenuItems, buildHistoryContextMenuItems } = require('../context-menu');

// 아무 제약이 없는 평범한 저장소. 각 테스트는 여기서 한 조건씩만 바꾼다.
function idle(over = {}) {
  state.loading = false;
  state.isGitRepo = true;
  state.indexLocked = false;
  state.spinnerActive = false;
  state.settlingWrite = false;
  state.operationState = null;
  state.cwd = 'C:/repo';
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }, { name: 'dev', isCurrent: false, upstream: '' }];
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

const idsOf = (items) => items.filter(i => i.id).map(i => i.id);
const menuEnabled = (items, id) => {
  const found = items.find(i => i.id === id);
  return found ? found.enabled !== false : null;
};

// ── 1. 쓰기 작업 중 ──

test('쓰기 작업 중에는 저장소를 바꾸는 동작이 전부 막힌다', () => {
  idle({ spinnerActive: true });
  for (const id of ['stageAll', 'stageSelected', 'unstageAll', 'unstageSelected',
    'git-fetch', 'git-pull', 'git-push', 'git-stash', 'branch_checkout', 'tab_discard_all',
    'commit-submit', 'hunk-apply']) {
    assert.equal(isEnabled(id), false, id + ' 는 쓰기 작업 중 막혀야 한다');
    assert.equal(disabledReason(id), actions.REASON.BUSY, id);
  }
});

// 실제로 겪은 사고: 커밋이 끝난 직후 창 타이틀은 여전히 "⠸ Committing..." 인데
// Unstage 버튼이 살아 있어 눌렸다. git commit 자체는 끝났지만 그 결과를 다시 읽어오는
// 갱신이 아직 도는 중이라, 화면의 Staged(53)은 커밋 직전 목록 그대로였다 —
// 거기 대고 Unstage 를 쏘면 이미 커밋되어 사라진 대상을 상대하게 된다.
test('git 명령이 끝나도 뒷정리 갱신이 도는 동안은 여전히 막혀 있다', () => {
  idle({ spinnerActive: false, settlingWrite: true });
  for (const id of ['unstageSelected', 'unstageAll', 'stageAll', 'commit-enter',
    'commit-submit', 'git-push', 'branch_checkout', 'committer-name']) {
    assert.equal(disabledReason(id), actions.REASON.BUSY, id + ' 는 뒷정리가 끝날 때까지 막혀야 한다');
  }
  // 탐색/복사는 그동안에도 그대로 — 막을 이유가 없다.
  assert.equal(isEnabled('copy_sha'), true);
  assert.equal(isEnabled('tab-commits'), true);
  state.settlingWrite = false;
});

test('쓰기 작업 중에도 읽기 동작은 열려 있다', () => {
  idle({ spinnerActive: true });
  for (const id of ['copy_sha', 'file_copy_path', 'tab_refresh', 'branch_pin',
    'tab-commits', 'toggleDiff', 'remote_sort_alpha']) {
    assert.equal(isEnabled(id), true, id + ' 는 읽기 동작이라 통과해야 한다');
  }
});

// ── 2. 진행 중인 작업(rebase/merge/cherry-pick/revert) ──

test('rebase 진행 중에는 체크아웃·병합·스태시가 막히고 사유에 작업 이름이 들어간다', () => {
  idle({ operationState: { type: 'rebase-merge', step: 1, total: 3 } });
  for (const id of ['branch_checkout', 'checkout_branch:dev', 'merge', 'rebase', 'reset',
    'git-pull', 'git-push', 'git-stash', 'stash_apply', 'branch_delete', 'tab_discard_all',
    'worktree_new', 'new_branch']) {
    assert.equal(isEnabled(id), false, id + ' 는 rebase 중 막혀야 한다');
    assert.match(disabledReason(id), /Rebase in progress/, id);
  }
});

test('진행 중인 작업에서 빠져나오는 길은 막지 않는다', () => {
  idle({ operationState: { type: 'merge' } });
  // 충돌 해결에 필요한 것들 — 이걸 막으면 merge 를 끝낼 방법이 사라진다.
  for (const id of ['stageSelected', 'stageAll', 'unstageAll', 'hunk-apply', 'op-abort', 'op-menu']) {
    assert.equal(isEnabled(id), true, id + ' 는 merge 중에도 가능해야 한다');
  }
  state.cursor = 1; // staged 파일로 커서를 옮기면 Unstage 도 살아 있다
  assert.equal(isEnabled('unstageSelected'), true);
  // merge 는 skip 이 없어 화면에도 버튼을 내지 않지만, 판정 자체는 작업 유무만 본다.
  assert.equal(isEnabled('op-skip'), true);
});

test('작업이 없으면 Abort/Skip 이 막힌다', () => {
  idle();
  assert.equal(disabledReason('op-abort'), actions.REASON.NO_OPERATION);
  assert.equal(disabledReason('op-skip'), actions.REASON.NO_OPERATION);
});

test('작업 중이라도 다른 쓰기 작업이 돌면 Abort 는 기다린다', () => {
  idle({ operationState: { type: 'merge' }, spinnerActive: true });
  assert.equal(disabledReason('op-abort'), actions.REASON.BUSY);
});

// ── 3. 충돌 ──

test('해결하지 않은 충돌이 남아 있으면 커밋이 막힌다', () => {
  idle({
    unstaged: [{ status: 'U', file: 'conflict.txt' }],
    mode: 'commit',
    commitMsg: 'resolve',
  });
  assert.equal(disabledReason('commit-submit'), actions.REASON.CONFLICTS);
  assert.equal(disabledReason('commit-enter'), actions.REASON.CONFLICTS);
  // 해결에 필요한 스테이징은 그대로 열려 있어야 한다.
  assert.equal(isEnabled('stageSelected'), true);
});

// ── 4. 리모트 / 업스트림 / detached ──

test('리모트가 없으면 네트워크 동작이 막힌다', () => {
  idle({ remotes: [], remoteBranches: [] });
  for (const id of ['git-fetch', 'git-pull', 'git-push', 'push_to_remote:origin', 'branch_push']) {
    assert.equal(disabledReason(id), actions.REASON.NO_REMOTE, id);
  }
  // 로컬 작업은 리모트와 무관하다.
  assert.equal(isEnabled('git-stash'), true);
  assert.equal(isEnabled('stageAll'), true);
});

test('업스트림이 없으면 Pull 만 막고 Fetch/Push 는 남긴다', () => {
  idle({ branches: [{ name: 'main', isCurrent: true, upstream: '' }] });
  assert.equal(disabledReason('git-pull'), actions.REASON.NO_UPSTREAM);
  assert.equal(isEnabled('git-fetch'), true, '아직 올리지 않은 브랜치도 fetch 는 된다');
  assert.equal(isEnabled('git-push'), true, '첫 push 로 업스트림을 만들 수 있어야 한다');
});

test('detached HEAD 면 Pull/Push 가 막힌다', () => {
  idle({ branch: 'HEAD (detached)', branches: [{ name: 'main', isCurrent: false, upstream: 'origin/main' }] });
  assert.equal(disabledReason('git-push'), actions.REASON.DETACHED);
  assert.equal(disabledReason('git-pull'), actions.REASON.DETACHED);
});

test('브랜치 목록을 못 읽었을 때는 detached 로 단정하지 않는다', () => {
  // refs 조회 실패로 목록이 비면 현재 브랜치도 없는 것처럼 보인다.
  // 여기서 detached 로 단정하면 멀쩡한 저장소의 push 까지 막힌다 — 판단 불가면 열어 둔다.
  idle({ branches: [] });
  assert.equal(isEnabled('git-push'), true);
});

// ── 5. 대상이 없는 동작 ──

test('옮길 파일이 없으면 해당 스테이징 버튼만 막힌다', () => {
  idle({ staged: [], unstaged: [], untracked: [] });
  assert.equal(disabledReason('stageAll'), actions.REASON.NO_STAGEABLE);
  assert.equal(disabledReason('unstageAll'), actions.REASON.NO_UNSTAGEABLE);
  assert.equal(disabledReason('git-stash'), actions.REASON.NO_CHANGES);
  assert.equal(disabledReason('tab_discard_all'), actions.REASON.NO_CHANGES);
  assert.equal(disabledReason('tab_clean'), actions.REASON.NO_UNTRACKED);
});

test('커서가 가리키는 파일에 따라 Stage / Unstage 가 갈린다', () => {
  // buildFileList 순서: unstaged → untracked → staged
  idle({ unstaged: [{ status: 'M', file: 'b.txt' }], staged: [{ status: 'M', file: 'a.txt' }] });
  state.cursor = 0; // unstaged 파일
  assert.equal(isEnabled('stageSelected'), true);
  assert.equal(disabledReason('unstageSelected'), actions.REASON.NO_UNSTAGEABLE);
  state.cursor = 1; // staged 파일
  assert.equal(disabledReason('stageSelected'), actions.REASON.NO_STAGEABLE);
  assert.equal(isEnabled('unstageSelected'), true);
});

test('ignored 파일은 스테이징 대상으로 치지 않는다', () => {
  // git add 가 거부하는 대상이라, 버튼이 살아 있으면 눌러도 실패만 한다.
  idle({ staged: [], unstaged: [], untracked: [], ignored: [{ status: '!', file: 'build.log' }] });
  ui.collapsedSections.ignored = false;
  state.cursor = 0;
  assert.equal(disabledReason('stageSelected'), actions.REASON.NO_STAGEABLE);
  ui.collapsedSections = {};
});

test('스태시가 없으면 스태시 항목이 막힌다', () => {
  idle({ stashes: [] });
  for (const id of ['stash_apply', 'stash_drop', 'stash_rename']) {
    assert.equal(disabledReason(id), actions.REASON.NO_STASH, id);
  }
});

test('고른 커밋이 없으면 히스토리 동작이 막힌다', () => {
  idle({ logItems: [], logSelectables: [], logCursor: 0 });
  for (const id of ['merge', 'rebase', 'reset', 'cherry_pick', 'revert', 'drop_commit']) {
    assert.equal(disabledReason(id), actions.REASON.NO_COMMIT, id);
  }
});

// ── 6. 커밋 ──

test('커밋은 메시지와 스테이지가 모두 갖춰져야 가능하다', () => {
  idle({ mode: 'commit', commitMsg: '', staged: [{ status: 'M', file: 'a.txt' }] });
  assert.equal(disabledReason('commit-submit'), actions.REASON.NO_MESSAGE);
  state.commitMsg = 'hello';
  assert.equal(isEnabled('commit-submit'), true);
  state.staged = [];
  assert.equal(disabledReason('commit-submit'), actions.REASON.NO_STAGED);
  // amend 는 스테이지가 없어도 직전 커밋을 고쳐 쓸 수 있다.
  state.commitAmend = true;
  assert.equal(isEnabled('commit-submit'), true);
});

// ── 7. index.lock ──

test('index.lock 이 있으면 인덱스를 건드리는 동작만 막고 해제 버튼은 남긴다', () => {
  idle({ indexLocked: true });
  for (const id of ['stageAll', 'unstageAll', 'commit-submit', 'git-stash', 'branch_checkout']) {
    assert.equal(disabledReason(id), actions.REASON.INDEX_LOCKED, id);
  }
  assert.equal(isEnabled('unlockIndex'), true, '락을 풀 길이 없으면 빠져나올 수 없다');
  assert.equal(isEnabled('git-fetch'), true, 'fetch 는 인덱스를 건드리지 않는다');
});

test('잠기지 않았으면 Unlock 자체가 의미 없다', () => {
  idle();
  assert.equal(disabledReason('unlockIndex'), actions.REASON.NOT_LOCKED);
});

// ── 8. 저장소가 아닐 때 ──

test('저장소가 아니면 쓰기는 막히되 Init/Clone/저장소 변경은 열려 있다', () => {
  idle({ isGitRepo: false });
  assert.equal(disabledReason('git-fetch'), actions.REASON.NO_REPO);
  assert.equal(disabledReason('stageAll'), actions.REASON.NO_REPO);
  for (const id of ['tab_init', 'tab_clone', 'tab_change_repo']) {
    assert.equal(isEnabled(id), true, id + ' 까지 막으면 저장소를 열 방법이 없다');
  }
});

// ── 9. 메뉴에 실리는 enabled 와 실행 게이트가 같은 판정을 본다 ──

test('메뉴 항목의 enabled 는 실행 게이트의 판정과 일치한다', () => {
  idle({ operationState: { type: 'rebase-merge', step: 1, total: 2 } });
  ui.contextMenuBranch = 'dev';
  const items = buildBranchContextMenuItems('dev');
  for (const id of idsOf(items)) {
    assert.equal(menuEnabled(items, id), isEnabled(id),
      id + ' — 메뉴 표시와 실행 판정이 어긋난다');
  }
});

test('rebase 중 브랜치 메뉴의 체크아웃은 딤 처리되고 복사는 살아 있다', () => {
  idle({ operationState: { type: 'rebase-apply', step: 1, total: 2 } });
  const items = buildBranchContextMenuItems('dev');
  assert.equal(menuEnabled(items, 'branch_checkout'), false);
  assert.equal(menuEnabled(items, 'branch_copy_name'), true);
  assert.equal(menuEnabled(items, 'branch_pin'), true);
});

test('저장소가 아닐 때 탭 메뉴는 Init 만 살아 있다', () => {
  idle({ isGitRepo: false });
  const items = buildTabContextMenuItems();
  assert.equal(menuEnabled(items, 'tab_init'), true);
  assert.equal(menuEnabled(items, 'tab_clone'), true);
  assert.equal(menuEnabled(items, 'tab_apply_patch'), false);
  assert.equal(menuEnabled(items, 'tab_clean'), false);
});

test('자식이 전부 막힌 서브메뉴는 부모도 함께 막는다', () => {
  idle({ operationState: { type: 'cherry-pick' } });
  const items = buildHistoryContextMenuItems();
  const rebaseMenu = items.find(i => i.id === 'interactive_rebase');
  assert.ok(rebaseMenu, 'Interactive Rebase 서브메뉴가 있어야 한다');
  assert.ok(rebaseMenu.children.every(c => c.enabled === false), '자식이 모두 막혀야 한다');
  assert.equal(rebaseMenu.enabled, false, '열어 봐야 소용없는 서브메뉴는 부모도 막는다');
});

test('평범한 저장소에서는 메뉴가 원래대로 다 살아 있다', () => {
  idle();
  const items = buildBranchContextMenuItems('dev');
  for (const id of ['branch_checkout', 'branch_merge_into', 'branch_rename', 'branch_delete',
    'branch_copy_name', 'branch_new_branch']) {
    assert.equal(menuEnabled(items, id), true, id + ' 가 이유 없이 막히면 안 된다');
  }
});

// ── 10. 호출부가 이미 잠근 항목은 건드리지 않는다 ──

test('빌더가 enabled:false 로 낸 항목은 그대로 둔다', () => {
  idle();
  const items = decorateMenuItems([
    { id: 'branch_copy_name', label: 'Copy', enabled: false },
    { id: 'remote_sort_title', label: 'Sort:', enabled: false },
  ]);
  assert.equal(items[0].enabled, false, '읽기 동작이라도 빌더가 잠갔으면 잠긴 채로');
  assert.equal(items[1].enabled, false);
});
