// 브랜치 컨텍스트 메뉴의 삭제 항목 배치 검증.
//
// 원격 삭제(push --delete)를 push 묶음에 두면, 위에서부터 훑을 때 "Delete ..."로 시작하는
// 첫 항목이 원격 삭제가 된다. 로컬 삭제는 8칸 아래 Rename 옆에 있어, 로컬 브랜치를 지우려다
// 보호된 원격 브랜치에 삭제 push를 날리게 된다(GitLab pre-receive 거부). 두 삭제를 한 자리에
// 모으고 로컬을 먼저 두어, 먼저 만나는 "Delete"가 항상 로컬이 되게 한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildBranchContextMenuItems } = require('../context-menu');

function setup({ isCurrent = false, upstream = 'origin/staging' } = {}) {
  state.branches = [
    { name: 'main', isCurrent: !isCurrent, upstream: 'origin/main' },
    { name: 'staging', isCurrent, upstream },
  ];
  state.remoteBranches = ['origin/main', 'origin/staging'];
  state.remotes = ['origin'];
  ui.pinnedBranches = [];
}

const idxOf = (items, id) => items.findIndex(i => i.id === id);

test('로컬 삭제가 원격 삭제보다 먼저 온다', () => {
  setup();
  const items = buildBranchContextMenuItems('staging');
  const local = idxOf(items, 'branch_delete');
  const remote = idxOf(items, 'branch_delete_remote');
  assert.ok(local >= 0, '로컬 삭제 항목이 있어야 한다');
  assert.ok(remote >= 0, '원격 삭제 항목이 있어야 한다');
  assert.ok(local < remote, '로컬 삭제(' + local + ')가 원격 삭제(' + remote + ')보다 위여야 한다');
});

test('두 삭제 항목은 붙어 있고 사이에 다른 항목이 없다', () => {
  setup();
  const items = buildBranchContextMenuItems('staging');
  assert.equal(idxOf(items, 'branch_delete_remote') - idxOf(items, 'branch_delete'), 1);
});

test('원격 삭제 라벨은 "Delete"로 시작하지 않아 로컬과 헷갈리지 않는다', () => {
  setup();
  const items = buildBranchContextMenuItems('staging');
  const remote = items[idxOf(items, 'branch_delete_remote')];
  const local = items[idxOf(items, 'branch_delete')];
  assert.match(remote.label, /^Delete on Remote:/);
  assert.match(local.label, /\(local\)/);
  // 위에서부터 만나는 첫 "Delete ..." 는 반드시 로컬이어야 한다
  const firstDelete = items.find(i => typeof i.label === 'string' && /^Delete '/.test(i.label));
  assert.equal(firstDelete.id, 'branch_delete');
});

test('push 묶음에는 삭제 항목이 남아 있지 않다', () => {
  setup();
  const items = buildBranchContextMenuItems('staging');
  const forcePush = idxOf(items, 'branch_force_push');
  const remote = idxOf(items, 'branch_delete_remote');
  assert.ok(remote > forcePush + 1, '원격 삭제가 Force Push 바로 아래 붙어 있으면 안 된다');
});

// 호스트 menu.show는 위치·스크롤 옵션이 없어 창보다 긴 메뉴는 아래가 잘린다.
// 삭제를 메뉴 끝에 두면 작은 창에서 항목 자체에 닿지 못한다.
test('삭제 항목은 잘려도 닿을 수 있게 메뉴 앞쪽에 있다', () => {
  setup();
  const items = buildBranchContextMenuItems('staging');
  const MAX_ROW = 13; // 작은 창에서도 보이는 대략적인 행 수
  assert.ok(idxOf(items, 'branch_delete') < MAX_ROW,
    '로컬 삭제가 ' + MAX_ROW + '행 안에 있어야 한다: ' + idxOf(items, 'branch_delete'));
  assert.ok(idxOf(items, 'branch_delete_remote') < MAX_ROW,
    '원격 삭제가 ' + MAX_ROW + '행 안에 있어야 한다: ' + idxOf(items, 'branch_delete_remote'));
});

test('Tracking 목록이 길어도 삭제 위치는 밀리지 않는다', () => {
  setup();
  state.remoteBranches = Array.from({ length: 200 }, (_, i) => 'origin/b' + i).concat('origin/staging');
  const items = buildBranchContextMenuItems('staging');
  // Tracking은 하위 메뉴라 본 메뉴 행 수를 늘리지 않아야 한다
  assert.ok(idxOf(items, 'branch_delete') < 13);
});

test('업스트림이 없으면 원격 삭제 항목은 나오지 않는다', () => {
  setup({ upstream: '' });
  const items = buildBranchContextMenuItems('staging');
  assert.equal(idxOf(items, 'branch_delete_remote'), -1);
  assert.ok(idxOf(items, 'branch_delete') >= 0, '로컬 삭제는 그대로 있어야 한다');
});

test('현재 브랜치는 로컬 삭제가 빠지고 원격 삭제만 남는다', () => {
  setup({ isCurrent: true });
  const items = buildBranchContextMenuItems('staging');
  assert.equal(idxOf(items, 'branch_delete'), -1, '체크아웃 중인 브랜치는 로컬 삭제 불가');
  assert.ok(idxOf(items, 'branch_delete_remote') >= 0);
});
