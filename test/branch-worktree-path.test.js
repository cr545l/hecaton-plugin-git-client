// 브랜치 메뉴에서 그 브랜치를 체크아웃해 작업 중인 워크트리의 경로를 보고 복사한다.
//
// 왼쪽 목록은 절대경로를 그리지 않아(패널이 넘친다) 어떤 브랜치가 어느 폴더에서 작업 중인지 알 길이
// 워크트리 줄을 하나씩 우클릭해 보는 것뿐이었다. 이제 브랜치(로컬·리모트 추적) 메뉴의 "작업 중인
// 워크트리" 서브메뉴가 경로를 라벨로 보여 주고, 누르면 복사한다. 리모트 추적 브랜치는 같은 이름의 로컬
// 브랜치를 본다(origin/develop → develop).
require('./helpers/git-mutation-host');
const test = require('node:test');
const assert = require('node:assert/strict');

const menus = [], commands = [], copies = [];
let clipboardDenied = false;
global.hecaton = {
  initialState: { cols: 120, rows: 40 }, terminal: {}, on() {},
  fs: {}, window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({}), set: async () => ({}), remove: async () => ({}) },
  dialog: { show: async () => ({}) },
  menu: { show: async opts => { menus.push(opts); return {}; } },
  clipboard: { write: async ({ text }) => {
    if (clipboardDenied) return { ok: false, error_code: 'access_denied' };
    copies.push(text); return {};
  } },
  process: { exec: async ({ args }) => { commands.push(args); return { ok: true, exit_code: 0, stdout: '', stderr: '' }; } },
};

const { state, ui, localRefKey, remoteRefKey } = require('../state');
const selection = require('../branch-selection');
const rendering = require('../render');
rendering.render = () => {};
const refresh = require('../refresh');
refresh.refreshAsync = async () => {};
refresh.refreshLog = () => {};
refresh.updateLogDetail = () => {};
const { buildBranchesContextMenuItems, handleContextMenuAction } = require('../context-menu');
const { startSpinner, stopSpinner } = require('../spinner');
const { SCOPE } = require('../actions');

const local = name => ({ action: 'goto-branch', branch: name, refKey: localRefKey(name) });
const remote = name => ({ action: 'goto-branch', branch: name, refKey: remoteRefKey(name) });
function setup() {
  Object.assign(state, { cwd: 'C:/work/repo', branch: 'main', loading: false, isGitRepo: true,
    gitNotFound: false, indexLocked: false, spinnerActive: false, settlingWrite: false, operationState: null,
    minimized: false, error: null, conflictView: null, mode: 'normal', refreshing: false,
    logLoading: false, logLoadingMore: false,
    branches: [{ name: 'main', isCurrent: true }, { name: 'develop', upstream: 'origin/develop' },
      { name: 'feature/x', upstream: 'origin/develop' }, { name: 'idle' }],
    remoteBranches: ['origin/main', 'origin/develop', 'origin/fix_hide'], remotes: ['origin'], stashes: [],
    worktrees: [
      { path: 'C:/work/repo', branch: 'main', isMain: true, isCurrent: true },
      { path: 'C:/work/repo-develop', branch: 'develop' },
      { path: 'C:/work/repo-feature', branch: 'feature/x' },
      { path: 'C:/work/detached', branch: '', isDetached: true },
    ],
    rightView: 'log', logItems: [], logSelectables: [], logCursor: 0, logScrollOffset: 0,
    logDetailLines: [], pendingDialogAction: null, pendingDialogTarget: null, operationError: null });
  Object.assign(ui, { pinnedBranches: [], filteredRefs: [], hiddenRefs: [] });
  selection.reset();
  menus.length = commands.length = copies.length = 0;
  clipboardDenied = false;
}
// 브랜치 하나(또는 여럿)를 골라 우클릭했을 때와 같은 대상(input.js 의 우클릭이 하는 일과 같다).
function open(...entries) {
  selection.select(entries[0]);
  for (const entry of entries.slice(1)) selection.select(entry, 'toggle');
  ui.contextMenuBranch = ui.contextMenuRemoteBranch = entries[0].branch;
  return buildBranchesContextMenuItems(selection.capture(entries[0]));
}
const worktreesItem = (items, prefix = 'branch_') => items.find(i => i.id === prefix + 'worktrees');

test('로컬 브랜치 메뉴는 그 브랜치를 체크아웃한 워크트리의 경로를 보여 주고, 누르면 복사한다', async () => {
  setup();
  const item = worktreesItem(open(local('develop')));
  assert.equal(item.label, 'Worktrees Using This Branch (1)');
  assert.notEqual(item.enabled, false);
  assert.deepEqual(item.children.map(c => [c.id, c.label]),
    [['branch_worktree_path:C:/work/repo-develop', 'C:/work/repo-develop']]);

  await handleContextMenuAction('branch_worktree_path:C:/work/repo-develop');
  assert.deepEqual(copies, ['C:/work/repo-develop']);
  assert.equal(state.error, 'Copied: C:/work/repo-develop', '복사했다고 알린다');
  assert.equal(commands.length, 0, 'git 을 부르지 않는다');
});

test('이 창의 워크트리에는 표시를 붙이고, 아무 데도 없으면 그렇다고 막아 둔다', () => {
  setup();
  const current = worktreesItem(open(local('main')));
  assert.equal(current.children[0].label, 'C:/work/repo (this window)');

  const idle = worktreesItem(open(local('idle')));
  assert.equal(idle.label, 'Not Checked Out in Any Worktree');
  assert.equal(idle.enabled, false);
  assert.deepEqual(idle.children, []);

  const multiple = worktreesItem(open(local('develop'), local('main')));
  assert.equal(multiple.enabled, false, '여럿을 고르면 어느 브랜치의 워크트리인지 가릴 수 없다');
});

test('리모트 추적 브랜치는 같은 이름의 로컬 브랜치가 작업 중인 곳을 보여 준다 — 업스트림만 같은 브랜치는 아니다', async () => {
  setup();
  const item = worktreesItem(open(remote('origin/develop')), 'remotebranch_');
  // feature/x 도 origin/develop 을 업스트림으로 두지만 develop 의 작업 공간이 아니다.
  assert.deepEqual(item.children.map(c => c.label), ['C:/work/repo-develop']);
  await handleContextMenuAction('remotebranch_worktree_path:C:/work/repo-develop');
  assert.deepEqual(copies, ['C:/work/repo-develop']);

  assert.equal(worktreesItem(open(remote('origin/fix_hide')), 'remotebranch_').enabled, false);
});

test('메뉴를 연 뒤 그 워크트리가 브랜치를 놓았으면 낡은 경로를 복사하지 않는다', async () => {
  setup();
  open(local('develop'));
  state.worktrees[1].branch = 'other';
  await handleContextMenuAction('branch_worktree_path:C:/work/repo-develop');
  assert.deepEqual(copies, []);
  assert.equal(state.operationError.message, require('../i18n').t('menu.branches.changed'), '바뀌었다고 알린다');
});

test('경로가 "_hide" 처럼 끝나도 Hide 같은 묶음 동작으로 새지 않는다', async () => {
  setup();
  state.worktrees[1].path = 'C:/work/repo_hide';
  open(local('develop'));
  await handleContextMenuAction('branch_worktree_path:C:/work/repo_hide');
  assert.deepEqual(copies, ['C:/work/repo_hide']);
  assert.deepEqual(ui.hiddenRefs, []);
});

test('리모트 브랜치 이름이 "_hide" 로 끝나도 Tracking 은 업스트림 지정이다(예전에는 Hide 로 처리됐다)', async () => {
  setup();
  open(local('idle'));
  await handleContextMenuAction('branch_track:origin/fix_hide');
  assert.deepEqual(ui.hiddenRefs, []);
  assert.ok(commands.some(args => args.includes('--set-upstream-to=origin/fix_hide') || args.includes('origin/fix_hide')),
    'git 에 업스트림 지정을 보낸다: ' + JSON.stringify(commands));
});

test('복사는 읽기 동작이라 다른 작업 중에도 되고, 거부되면 복사했다고 말하지 않는다', async () => {
  setup();
  open(local('develop'));
  const op = startSpinner('test', [SCOPE.REFS, SCOPE.WORKTREE, SCOPE.INDEX]);
  try {
    const item = worktreesItem(buildBranchesContextMenuItems(ui.contextMenuBranches));
    assert.notEqual(item.enabled, false);
    assert.notEqual(item.children[0].enabled, false);
    await handleContextMenuAction('branch_worktree_path:C:/work/repo-develop');
    assert.deepEqual(copies, ['C:/work/repo-develop']);
  } finally { stopSpinner(op); }

  state.error = null;
  clipboardDenied = true;
  await handleContextMenuAction('branch_worktree_path:C:/work/repo-develop');
  assert.ok(!/^Copied/.test(state.error || ''), '거부됐는데 복사했다고 하면 안 된다');
});
