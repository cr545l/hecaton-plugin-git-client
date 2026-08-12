// 컨텍스트 메뉴 payload 크기 검증.
//
// 호스트 menu.show는 한 번에 받는 항목 수에 한계가 있고, 넘치면 뒤쪽 항목을 조용히
// 버린다 — 에러도 없고 잘렸다는 표시도 없다. 그래서 저장소 크기를 따라 커지는 목록을
// 메뉴에 그대로 실으면, 그 뒤에 오는 항목이 저장소마다 나왔다 안 나왔다 한다.
//
// 실제 사례: 리모트 추적 브랜치 45개짜리 저장소에서 브랜치 메뉴가 Tracking에서 끊겨
// Pin / Copy Branch Name이 나오지 않았다(리모트 2개짜리 저장소에선 정상). 창 크기나
// 클릭 위치와 무관했고, 잘린 메뉴 아래에는 빈 공간이 남아 있었다.
//
// 정상 동작이 확인된 payload는 평탄화 22항목 / 1.2KB, 잘린 payload는 59항목 / 4.5KB였다.
// 그 사이 어디에 한계가 있는지는 호스트만 알기에, 저장소 크기와 무관하게 넉넉히 아래로
// 유지하는 쪽을 계약으로 삼는다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const {
  buildBranchContextMenuItems,
  buildBranchTrackingMenuItems,
  buildHistoryBranchMenuItems,
  buildHistoryContextMenuItems,
  buildRemoteBranchContextMenuItems,
} = require('../context-menu');

// 잘린 사례(59)보다 한참 아래, 정상 사례(22)에 가깝게 잡는다.
const ITEM_BUDGET = 40;

function flatCount(items) {
  let n = 0;
  for (const it of items) {
    n++;
    if (it.children) n += flatCount(it.children);
  }
  return n;
}

const idxOf = (items, id) => items.findIndex(i => i.id === id);

function setup({ remoteCount = 2, isCurrent = false, upstream = 'origin/dev', localCount = 2 } = {}) {
  state.branches = [{ name: 'main', isCurrent: !isCurrent, upstream: 'origin/main' }];
  for (let i = 0; i < localCount; i++) {
    state.branches.push({ name: 'local' + i, isCurrent: false, upstream: '' });
  }
  state.branches.push({ name: 'dev', isCurrent, upstream });
  state.remoteBranches = Array.from({ length: remoteCount }, (_, i) => 'origin/b' + i);
  state.remoteBranches.push('origin/dev', 'origin/main');
  state.remotes = ['origin'];
  state.stashes = [];
  state.logItems = [];
  state.logCursor = 0;
  state.logSelectables = [];
  ui.pinnedBranches = [];
}

// ── 회귀: 리모트가 많아도 뒤쪽 항목이 살아남아야 한다 ──

test('리모트가 많아도 브랜치 메뉴에 Pin이 남는다', () => {
  setup({ remoteCount: 200 });
  const items = buildBranchContextMenuItems('dev');
  assert.ok(idxOf(items, 'branch_pin') >= 0, 'Pin 항목이 있어야 한다');
  assert.ok(idxOf(items, 'branch_copy_name') >= 0, 'Copy Branch Name도 있어야 한다');
});

test('리모트 수가 늘어도 브랜치 메뉴 payload는 커지지 않는다', () => {
  setup({ remoteCount: 2 });
  const small = flatCount(buildBranchContextMenuItems('dev'));
  setup({ remoteCount: 500 });
  const big = flatCount(buildBranchContextMenuItems('dev'));
  assert.ok(big <= small + 1,
    '리모트 500개일 때 항목이 ' + big + '개 — 2개일 때(' + small + ')와 같아야 한다');
});

test('어떤 저장소 크기에서도 브랜치 메뉴는 예산 안에 있다', () => {
  for (const remoteCount of [0, 1, 8, 9, 45, 500]) {
    for (const isCurrent of [false, true]) {
      for (const upstream of ['origin/dev', '']) {
        setup({ remoteCount, isCurrent, upstream });
        const n = flatCount(buildBranchContextMenuItems('dev'));
        assert.ok(n <= ITEM_BUDGET,
          'remotes=' + remoteCount + ' current=' + isCurrent + " upstream='" + upstream + "' → " + n + '항목');
      }
    }
  }
});

test('history / 리모트 브랜치 메뉴도 저장소가 커질 때 예산을 넘지 않는다', () => {
  setup({ remoteCount: 500, localCount: 500 });
  const history = flatCount(buildHistoryContextMenuItems());
  assert.ok(history <= ITEM_BUDGET, 'history 메뉴가 ' + history + '항목');
  assert.ok(flatCount(buildRemoteBranchContextMenuItems('origin/b1')) <= ITEM_BUDGET);
});

test('한 커밋에 태그가 몰려 있어도 history 메뉴 뒤쪽이 밀리지 않는다', () => {
  setup({ remoteCount: 500, localCount: 500 });
  const tags = Array.from({ length: 20 }, (_, i) => 'tag: v1.' + i).join(', ');
  state.logItems = [{ ref: 'abc', decoration: tags }];
  state.logSelectables = [0];
  state.logCursor = 0;
  const items = buildHistoryContextMenuItems();
  const n = flatCount(items);
  assert.ok(n <= ITEM_BUDGET, '태그 20개짜리 커밋에서 ' + n + '항목');
  assert.ok(items.some(i => i.id === 'copy_sha'), 'Copy Commit SHA가 남아 있어야 한다');
  assert.ok(items.some(i => i.id === 'copy_info'), 'Copy Commit Info가 남아 있어야 한다');
});

// ── Tracking: 적으면 서브메뉴, 많으면 별도 메뉴 ──

test('리모트가 적으면 예전처럼 Tracking 서브메뉴로 붙는다', () => {
  setup({ remoteCount: 2, upstream: '' });
  const items = buildBranchContextMenuItems('dev');
  const tracking = items[idxOf(items, 'branch_tracking')];
  assert.ok(tracking, 'Tracking 서브메뉴가 있어야 한다');
  assert.equal(idxOf(items, 'branch_tracking_open'), -1, '별도 메뉴로 새지 않아야 한다');
  assert.equal(tracking.children.length, 4);
});

test('리모트가 많으면 Tracking은 별도 메뉴를 여는 항목이 된다', () => {
  setup({ remoteCount: 45 });
  const items = buildBranchContextMenuItems('dev');
  assert.equal(idxOf(items, 'branch_tracking'), -1, '서브메뉴로 붙지 않아야 한다');
  const open = items[idxOf(items, 'branch_tracking_open')];
  assert.ok(open, 'Tracking 별도 메뉴 항목이 있어야 한다');
  assert.equal(open.children, undefined, '자식을 물고 있으면 안 된다');
});

test('Tracking 전용 메뉴도 한 페이지가 예산 안에 있다', () => {
  setup({ remoteCount: 500 });
  for (const page of [0, 1, 5, 33]) {
    assert.ok(flatCount(buildBranchTrackingMenuItems('dev', page)) <= ITEM_BUDGET, 'page=' + page);
  }
});

test('페이지를 넘기면 모든 리모트 브랜치에 닿을 수 있다', () => {
  setup({ remoteCount: 45 });
  const total = state.remoteBranches.length;
  const seen = new Set();
  let page = 0;
  for (let guard = 0; guard < 100; guard++) {
    const items = buildBranchTrackingMenuItems('dev', page);
    for (const it of items) {
      if (it.id && it.id.startsWith('branch_track:')) seen.add(it.id.substring('branch_track:'.length));
    }
    const next = items.find(i => i.id === 'branch_tracking_page:' + (page + 1));
    if (!next) break;
    page++;
  }
  assert.equal(seen.size, total, '리모트 ' + total + '개 중 ' + seen.size + '개만 닿았다');
});

test('현재 업스트림과 같은 이름의 리모트 브랜치가 첫 페이지에 온다', () => {
  setup({ remoteCount: 500 });
  const first = buildBranchTrackingMenuItems('dev', 0);
  const ids = first.filter(i => i.id && i.id.startsWith('branch_track:')).map(i => i.id);
  assert.equal(ids[0], 'branch_track:origin/dev', '지금 업스트림이 맨 위여야 한다');
  assert.match(first[1].label, /\(current\)/);
});

test('업스트림이 없어도 같은 이름의 리모트 브랜치를 맨 위에 올린다', () => {
  setup({ remoteCount: 500, upstream: '' });
  const first = buildBranchTrackingMenuItems('dev', 0);
  const ids = first.filter(i => i.id && i.id.startsWith('branch_track:')).map(i => i.id);
  assert.equal(ids[0], 'branch_track:origin/dev');
});

test('Unset Upstream은 업스트림이 있을 때만 나온다', () => {
  setup({ remoteCount: 45 });
  assert.ok(idxOf(buildBranchTrackingMenuItems('dev', 0), 'branch_untrack') >= 0);
  setup({ remoteCount: 45, upstream: '' });
  assert.equal(idxOf(buildBranchTrackingMenuItems('dev', 0), 'branch_untrack'), -1);
});

// ── history 메뉴의 브랜치 목록도 같은 계약 ──

test('브랜치가 많으면 history 메뉴도 별도 체크아웃 메뉴로 넘긴다', () => {
  setup({ localCount: 100 });
  const items = buildHistoryContextMenuItems();
  assert.equal(idxOf(items, 'branches_submenu'), -1, '서브메뉴로 붙지 않아야 한다');
  assert.ok(idxOf(items, 'history_branch_open') >= 0);
});

test('브랜치가 적으면 history 메뉴는 예전처럼 서브메뉴로 붙는다', () => {
  setup({ localCount: 2 });
  const items = buildHistoryContextMenuItems();
  const sub = items[idxOf(items, 'branches_submenu')];
  assert.ok(sub, '서브메뉴가 있어야 한다');
  assert.equal(idxOf(items, 'history_branch_open'), -1);
});

test('브랜치가 20개를 넘어도 페이지를 넘겨 전부 체크아웃할 수 있다', () => {
  setup({ localCount: 100 });
  const total = state.branches.filter(b => !b.isCurrent).length;
  const seen = new Set();
  let page = 0;
  for (let guard = 0; guard < 200; guard++) {
    const items = buildHistoryBranchMenuItems(page);
    assert.ok(flatCount(items) <= ITEM_BUDGET, 'page=' + page);
    for (const it of items) {
      if (it.id && it.id.startsWith('checkout_branch:')) seen.add(it.id);
    }
    if (!items.some(i => i.id === 'history_branch_page:' + (page + 1))) break;
    page++;
  }
  assert.equal(seen.size, total, '브랜치 ' + total + '개 중 ' + seen.size + '개만 닿았다');
});

test('페이지 번호가 범위를 벗어나도 마지막 페이지로 잡힌다', () => {
  setup({ remoteCount: 45 });
  const items = buildBranchTrackingMenuItems('dev', 9999);
  assert.ok(items.some(i => i.id && i.id.startsWith('branch_track:')), '빈 페이지가 나오면 안 된다');
  assert.ok(!items.some(i => i.id && /^branch_tracking_page:\d+$/.test(i.id) && i.label === 'More...'));
});
