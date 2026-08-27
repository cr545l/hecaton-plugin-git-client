// 브랜치 Filter / Hide 검증.
//
// Filter 는 "이 브랜치들만 보기"(화이트리스트), Hide 는 "이 브랜치는 빼고 보기"(블랙리스트)다.
// 둘 다 그리기 단계에서만 걸러 내므로 git 재조회 없이 즉시 되돌릴 수 있어야 하고,
// Hide 로는 "그 브랜치에서만 닿는" 커밋만 사라지고 다른 브랜치와 공유하는 커밋은 남아야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const {
  state, ui,
  localRefKey, remoteRefKey,
  isFilteredRef, isHiddenRef, toggleFilteredRef, toggleHiddenRef,
  clearFilteredRefs, clearHiddenRefs, forgetRef, renameRef,
} = require('../state');
const { buildLogGraphRows } = require('../refresh');
const { buildBranchContextMenuItems, buildRemoteBranchContextMenuItems } = require('../context-menu');
const { buildLeftPanel } = require('../render');

const H = n => String(n).padStart(40, '0');

const FILTERED = '\x1b[93m';  // colors.filtered
const DIM = '\x1b[2m';        // colors.dim
const PINNED = '\x1b[95m';    // colors.pinned
const GREEN = '\x1b[32m';     // colors.green
const RED = '\x1b[31m';       // colors.red

// 공통 그래프:
//
//   main tip(1)   feature tip(5)     develop tip(4)   tagged only(6)
//        \            /                    |               |
//         shared B(2)                      |               |
//               \                          |               |
//                +--------- base(3) -------+---------------+
//
// base(3) 는 모두의 조상이라 어느 한 브랜치를 감춰도 남는다.
function sampleCommits() {
  return [
    { hash: H(1), parents: [H(2)], refs: 'HEAD -> main, origin/main', subject: 'main tip' },
    { hash: H(5), parents: [H(2)], refs: 'feature/login', subject: 'feature tip' },
    { hash: H(4), parents: [H(3)], refs: 'develop, origin/develop, origin/HEAD', subject: 'develop tip' },
    { hash: H(6), parents: [H(3)], refs: 'tag: v0.9', subject: 'tagged only' },
    { hash: H(2), parents: [H(3)], refs: '', subject: 'shared B' },
    { hash: H(3), parents: [], refs: '', subject: 'base' },
  ];
}

function resetRefs() {
  state.branches = [
    { name: 'main', isCurrent: true },
    { name: 'develop', isCurrent: false },
    { name: 'feature/login', isCurrent: false },
  ];
  state.remoteBranches = ['origin/main', 'origin/develop'];
  state.remotes = ['origin'];
  ui.filteredRefs = [];
  ui.hiddenRefs = [];
  ui.logSortMode = 'date';
  ui.logShowRecovery = true;
  ui.stashMap = new Map();
}

function subjectsOf({ filtered = [], hidden = [], commits, stashHashes = new Set() } = {}) {
  ui.filteredRefs = filtered.slice();
  ui.hiddenRefs = hidden.slice();
  return buildLogGraphRows(commits || sampleCommits(), stashHashes).map(r => r.subject);
}

// ── 필터 없음 ──

test('지정이 없으면 커밋을 하나도 걸러내지 않는다', () => {
  resetRefs();
  assert.deepEqual(subjectsOf(), ['main tip', 'feature tip', 'develop tip', 'tagged only', 'shared B', 'base']);
});

// ── Filter (화이트리스트) ──

test('Filter 는 지정 브랜치에서 닿는 커밋만 남긴다', () => {
  resetRefs();
  assert.deepEqual(
    subjectsOf({ filtered: [localRefKey('feature/login')] }),
    ['feature tip', 'shared B', 'base'],
    'feature 조상만 남아야 한다 — main/develop 전용 커밋은 빠진다',
  );
});

test('Filter 를 여러 개 지정하면 합집합이다', () => {
  resetRefs();
  assert.deepEqual(
    subjectsOf({ filtered: [localRefKey('feature/login'), localRefKey('develop')] }),
    ['feature tip', 'develop tip', 'shared B', 'base'],
  );
});

test('Filter 는 현재 브랜치(HEAD -> main)도 이름으로 고를 수 있다', () => {
  resetRefs();
  assert.deepEqual(subjectsOf({ filtered: [localRefKey('main')] }), ['main tip', 'shared B', 'base']);
});

test('로컬과 리모트는 따로 지정한다', () => {
  resetRefs();
  // origin/develop 만 골랐으니 develop 줄기가 남는다. 같은 커밋을 가리키므로 결과는 같지만,
  // 키가 섞여 있었다면 refs/heads/develop 로도 걸려 구분이 불가능하다.
  assert.deepEqual(
    subjectsOf({ filtered: [remoteRefKey('origin/develop')] }),
    ['develop tip', 'base'],
  );
  assert.deepEqual(
    subjectsOf({ filtered: [remoteRefKey('origin/feature/login')] }),
    [],
    '없는 리모트 ref 를 고르면 남는 커밋이 없다',
  );
});

// ── Hide (블랙리스트) ──

test('Hide 는 그 브랜치에서만 닿는 커밋을 뺀다', () => {
  resetRefs();
  assert.deepEqual(
    subjectsOf({ hidden: [localRefKey('feature/login')] }),
    ['main tip', 'develop tip', 'tagged only', 'shared B', 'base'],
    'feature 전용 커밋만 사라지고 공유 커밋(shared B)은 남아야 한다',
  );
});

test('Hide 는 HEAD -> 표기가 붙은 현재 브랜치에도 걸린다', () => {
  resetRefs();
  // main tip 의 decoration 은 'HEAD -> main, origin/main' 이다. 'HEAD' 를 main 과 별개의
  // ref 로 보고 루트로 세우면, 두 이름을 다 감춰도 HEAD 때문에 그대로 남는다.
  assert.deepEqual(
    subjectsOf({ hidden: [localRefKey('main'), remoteRefKey('origin/main')] }),
    ['feature tip', 'develop tip', 'tagged only', 'shared B', 'base'],
  );
});

test('Hide 는 리모트 추적 브랜치까지 함께 지정해야 그 줄기가 사라진다', () => {
  resetRefs();
  assert.deepEqual(
    subjectsOf({ hidden: [localRefKey('develop')] }),
    ['main tip', 'feature tip', 'develop tip', 'tagged only', 'shared B', 'base'],
    'origin/develop 이 아직 루트라 develop tip 은 남는다',
  );
  assert.deepEqual(
    subjectsOf({ hidden: [localRefKey('develop'), remoteRefKey('origin/develop')] }),
    ['main tip', 'feature tip', 'tagged only', 'shared B', 'base'],
  );
});

test("'<remote>/HEAD' 는 별칭이라 루트로 세우지 않는다", () => {
  resetRefs();
  // develop tip 에는 origin/HEAD 도 붙어 있다. 이것까지 루트로 보면 위 테스트가 통과할 수 없다.
  const rows = subjectsOf({ hidden: [localRefKey('develop'), remoteRefKey('origin/develop')] });
  assert.ok(!rows.includes('develop tip'));
});

test('태그만 가리키는 커밋은 브랜치를 모두 감춰도 남는다', () => {
  resetRefs();
  const rows = subjectsOf({
    hidden: [
      localRefKey('main'), remoteRefKey('origin/main'),
      localRefKey('develop'), remoteRefKey('origin/develop'),
      localRefKey('feature/login'),
    ],
  });
  assert.deepEqual(rows, ['tagged only', 'base'], '태그가 붙은 커밋은 브랜치와 무관하게 살아 있어야 한다');
});

test('Hide 를 풀면 같은 입력에서 그대로 되살아난다', () => {
  resetRefs();
  const commits = sampleCommits();
  subjectsOf({ hidden: [localRefKey('feature/login')], commits });
  assert.deepEqual(
    subjectsOf({ commits }),
    ['main tip', 'feature tip', 'develop tip', 'tagged only', 'shared B', 'base'],
    '감추기가 원본 목록을 갉아먹으면 안 된다',
  );
});

// ── 스태시 / 유실 커밋 ──

function withStash() {
  const commits = sampleCommits();
  commits.splice(1, 0, { hash: H(20), parents: [H(2)], refs: '', subject: 'stash entry' });
  return commits;
}

test('Hide 만 걸렸을 때 스태시와 유실 커밋은 루트로 살아남는다', () => {
  resetRefs();
  const commits = withStash();
  commits.splice(2, 0, { hash: H(30), parents: [H(2)], refs: '', subject: 'lost', isRecovery: true });
  const rows = subjectsOf({ hidden: [localRefKey('feature/login')], commits, stashHashes: new Set([H(20)]) });
  assert.ok(rows.includes('stash entry'), '어느 브랜치에도 안 매달린 스태시가 사라지면 안 된다');
  assert.ok(rows.includes('lost'), '유실 커밋은 Recovery 토글이 따로 맡는다');
  assert.ok(!rows.includes('feature tip'));
});

test('Filter 를 걸면 스태시와 유실 커밋도 함께 빠진다', () => {
  resetRefs();
  const commits = withStash();
  commits.splice(2, 0, { hash: H(30), parents: [H(2)], refs: '', subject: 'lost', isRecovery: true });
  const rows = subjectsOf({ filtered: [localRefKey('develop')], commits, stashHashes: new Set([H(20)]) });
  assert.deepEqual(rows, ['develop tip', 'base'], "Filter 는 '이 브랜치만 보기'다");
});

// ── 상태 헬퍼 ──

test('Filter 와 Hide 는 한 ref 에 동시에 걸리지 않는다', () => {
  resetRefs();
  const key = localRefKey('develop');
  assert.equal(toggleHiddenRef(key), true);
  assert.equal(isHiddenRef(key), true);

  assert.equal(toggleFilteredRef(key), true, 'Filter 를 켜면');
  assert.equal(isHiddenRef(key), false, 'Hide 는 풀려야 한다');
  assert.equal(isFilteredRef(key), true);

  assert.equal(toggleHiddenRef(key), true, '반대 방향도 마찬가지');
  assert.equal(isFilteredRef(key), false);
});

test('토글은 같은 지정을 두 번 쌓지 않는다', () => {
  resetRefs();
  const key = localRefKey('develop');
  toggleFilteredRef(key);
  assert.equal(toggleFilteredRef(key), false);
  assert.deepEqual(ui.filteredRefs, []);
});

test('전체 해제는 한쪽만 비운다', () => {
  resetRefs();
  toggleFilteredRef(localRefKey('develop'));
  toggleHiddenRef(localRefKey('feature/login'));
  clearFilteredRefs();
  assert.deepEqual(ui.filteredRefs, []);
  assert.deepEqual(ui.hiddenRefs, [localRefKey('feature/login')]);
  clearHiddenRefs();
  assert.deepEqual(ui.hiddenRefs, []);
});

test('사라진 ref 의 지정은 양쪽에서 지운다', () => {
  resetRefs();
  toggleHiddenRef(localRefKey('develop'));
  toggleFilteredRef(localRefKey('feature/login'));
  forgetRef(localRefKey('develop'));
  forgetRef(localRefKey('feature/login'));
  assert.deepEqual(ui.hiddenRefs, []);
  assert.deepEqual(ui.filteredRefs, []);
});

test('리네임하면 지정이 새 이름을 따라간다', () => {
  resetRefs();
  toggleFilteredRef(localRefKey('develop'));
  renameRef(localRefKey('develop'), localRefKey('dev2'));
  assert.deepEqual(ui.filteredRefs, [localRefKey('dev2')]);
});

test('리네임 대상이 이미 지정돼 있으면 중복을 만들지 않는다', () => {
  resetRefs();
  ui.hiddenRefs = [localRefKey('old'), localRefKey('new')];
  renameRef(localRefKey('old'), localRefKey('new'));
  assert.deepEqual(ui.hiddenRefs, [localRefKey('new')]);
});

// ── 컨텍스트 메뉴 ──

function menuSetup() {
  resetRefs();
  state.loading = false;
  state.isGitRepo = true;
  state.spinnerActive = false;
  state.settlingWrite = false;
  state.indexLocked = false;
  state.operationState = null;
  state.staged = []; state.unstaged = []; state.untracked = [];
  state.stashes = [];
  state.logItems = []; state.logSelectables = []; state.logCursor = 0;
  ui.pinnedBranches = [];
}

const ids = (items) => items.map(i => i.id).filter(Boolean);
const labelOf = (items, id) => (items.find(i => i.id === id) || {}).label;

test('브랜치 메뉴에 Filter 와 Hide 가 있다', () => {
  menuSetup();
  const items = buildBranchContextMenuItems('develop');
  assert.equal(labelOf(items, 'branch_filter'), "Filter 'develop'");
  assert.equal(labelOf(items, 'branch_hide'), "Hide 'develop'");
});

test('지정한 브랜치의 메뉴는 해제 문구로 바뀐다', () => {
  menuSetup();
  toggleFilteredRef(localRefKey('develop'));
  assert.equal(labelOf(buildBranchContextMenuItems('develop'), 'branch_filter'), "Unfilter 'develop'");
  toggleHiddenRef(localRefKey('develop'));
  assert.equal(labelOf(buildBranchContextMenuItems('develop'), 'branch_hide'), "Unhide 'develop'");
});

test('현재 브랜치에는 Hide 를 내지 않는다', () => {
  menuSetup();
  const items = buildBranchContextMenuItems('main');
  assert.ok(ids(items).includes('branch_filter'), 'Filter 는 현재 브랜치에도 쓸모가 있다');
  assert.ok(!ids(items).includes('branch_hide'), '지금 체크아웃한 브랜치를 감추면 HEAD 를 잃는다');
});

test('전체 해제 항목은 지정이 있을 때만 나온다', () => {
  menuSetup();
  let items = buildBranchContextMenuItems('develop');
  assert.ok(!ids(items).includes('branch_clear_filters'));
  assert.ok(!ids(items).includes('branch_show_all'));

  toggleFilteredRef(localRefKey('develop'));
  items = buildBranchContextMenuItems('develop');
  assert.equal(labelOf(items, 'branch_clear_filters'), 'Clear All Filters (1)');
  assert.ok(!ids(items).includes('branch_show_all'), '숨김이 없으면 그쪽 해제는 안 나온다');

  toggleHiddenRef(localRefKey('feature/login'));
  items = buildBranchContextMenuItems('develop');
  assert.equal(labelOf(items, 'branch_show_all'), 'Show All Branches (1)');
});

test('다른 브랜치를 우클릭해도 전체 해제로 빠져나올 수 있다', () => {
  menuSetup();
  toggleHiddenRef(localRefKey('feature/login'));
  // 감춘 브랜치가 접힌 그룹 안에 있어도 아무 브랜치 메뉴에서 되돌릴 수 있어야 한다.
  assert.ok(ids(buildBranchContextMenuItems('main')).includes('branch_show_all'));
});

test('리모트 브랜치 메뉴에도 같은 항목이 있다', () => {
  menuSetup();
  const items = buildRemoteBranchContextMenuItems('origin/develop');
  assert.equal(labelOf(items, 'remotebranch_filter'), "Filter 'origin/develop'");
  assert.equal(labelOf(items, 'remotebranch_hide'), "Hide 'origin/develop'");
});

test('리모트 지정은 동명 로컬 브랜치를 건드리지 않는다', () => {
  menuSetup();
  toggleFilteredRef(remoteRefKey('origin/develop'));
  assert.equal(labelOf(buildRemoteBranchContextMenuItems('origin/develop'), 'remotebranch_filter'), "Unfilter 'origin/develop'");
  assert.equal(labelOf(buildBranchContextMenuItems('develop'), 'branch_filter'), "Filter 'develop'");
});

test('Filter / Hide 는 다른 작업이 도는 중에도 열려 있다', () => {
  menuSetup();
  state.spinnerActive = true;
  const items = buildBranchContextMenuItems('develop');
  const filterItem = items.find(i => i.id === 'branch_filter');
  const hideItem = items.find(i => i.id === 'branch_hide');
  assert.notEqual(filterItem.enabled, false, '저장소를 건드리지 않으므로 막을 이유가 없다');
  assert.notEqual(hideItem.enabled, false);
  state.spinnerActive = false;
});

// ── 좌측 패널 표시 ──

function panelSetup() {
  resetRefs();
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = 'main';
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false }];
  state.isLinkedWorktree = false;
  state.ahead = 0; state.behind = 0;
  ui.pinnedBranches = [];
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

const plainOf = l => l.replace(/\x1b\[[0-9;]*m/g, '');
const SECTION_RE = /^\s*[-+] (Pinned|Branches|Remotes|Worktrees|Stashes)/;

// 한 섹션 안의 행만 잘라 낸다. 로컬 'develop' 과 리모트 'origin/develop' 은 트리에서
// 똑같이 'develop' 으로 그려지므로, 섹션을 나누지 않으면 어느 쪽 색인지 알 수 없다.
function sectionRows(lines, title) {
  const plain = lines.map(plainOf);
  const start = plain.findIndex(l => new RegExp('^\\s*[-+] ' + title + '\\s*$').test(l));
  if (start < 0) return [];
  let end = plain.length;
  for (let i = start + 1; i < plain.length; i++) {
    if (SECTION_RE.test(plain[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

// 브랜치 행 찾기 — 이름 뒤에 ' @origin' 이나 ahead/behind 화살표가 붙을 수 있고,
// 현재 브랜치에는 '✓ ' 가 앞에 붙는다.
function branchRow(lines, name, section) {
  const rows = section ? sectionRows(lines, section) : lines;
  const re = new RegExp('^\\s*(✓ )?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
  return rows.find(l => re.test(plainOf(l)));
}

test('Filter 지정 브랜치는 색으로 드러난다', () => {
  panelSetup();
  toggleFilteredRef(localRefKey('develop'));
  const row = branchRow(buildLeftPanel(40, 60), 'develop', 'Branches');
  assert.ok(row.includes(FILTERED), 'bright yellow 로 그려야 한다');
});

test('Hide 지정 브랜치는 목록에 흐리게 남는다', () => {
  panelSetup();
  toggleHiddenRef(localRefKey('develop'));
  const row = branchRow(buildLeftPanel(40, 60), 'develop', 'Branches');
  assert.ok(row, '목록에서 지워 버리면 되돌릴 길이 사라진다');
  assert.ok(row.includes(DIM));
});

test('Hide 는 핀 강조보다 앞선다', () => {
  panelSetup();
  ui.pinnedBranches = ['develop'];
  toggleHiddenRef(localRefKey('develop'));
  const lines = buildLeftPanel(40, 60);
  // 핀 고정 브랜치는 Pinned 섹션과 Branches 트리 양쪽에 나온다 — 둘 다 확인한다.
  for (const section of ['Pinned', 'Branches']) {
    const row = branchRow(lines, 'develop', section);
    assert.ok(row, section + ' 섹션에 줄이 있어야 한다');
    assert.ok(row.includes(DIM), '지금 히스토리에서 빠졌다는 표시가 먼저다');
    assert.ok(!row.includes(PINNED));
  }
});

test('지정이 없으면 브랜치 색은 그대로다', () => {
  panelSetup();
  const row = branchRow(buildLeftPanel(40, 60), 'develop', 'Branches');
  assert.ok(row.includes('\x1b[39m'), '기본 전경색이어야 한다');
  assert.ok(!row.includes(FILTERED));
  assert.ok(!row.includes(DIM));
});

test('현재 브랜치를 Filter 하면 ✓ 는 두고 색만 바뀐다', () => {
  panelSetup();
  toggleFilteredRef(localRefKey('main'));
  const row = branchRow(buildLeftPanel(40, 60), 'main', 'Branches');
  assert.ok(plainOf(row).trim().startsWith('✓ main'), '현재 브랜치 표시(✓)는 그대로 있어야 한다');
  assert.ok(row.includes(FILTERED));
  assert.ok(!row.includes(GREEN));
});

test('리모트 브랜치를 지정해도 동명 로컬 브랜치의 색은 그대로다', () => {
  panelSetup();
  toggleFilteredRef(remoteRefKey('origin/develop'));
  const lines = buildLeftPanel(40, 60);
  const remoteRow = branchRow(lines, 'develop', 'Remotes');
  assert.ok(remoteRow.includes(FILTERED), 'origin/develop 줄이 강조돼야 한다');
  const localRow = branchRow(lines, 'develop', 'Branches');
  assert.ok(!localRow.includes(FILTERED), '로컬 develop 은 지정한 적이 없다');
});

test('로컬 브랜치를 Hide 해도 리모트 추적 브랜치는 그대로다', () => {
  panelSetup();
  toggleHiddenRef(localRefKey('develop'));
  const lines = buildLeftPanel(40, 60);
  assert.ok(branchRow(lines, 'develop', 'Branches').includes(DIM));
  assert.ok(!branchRow(lines, 'develop', 'Remotes').includes(DIM), '핀과 달리 둘은 따로 지정한다');
});
