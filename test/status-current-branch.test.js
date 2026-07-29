// Status(왼쪽) 패널 상단 브랜치명 줄 검증 — Branches 목록과 같은 ✓/색 표기,
// 클릭 시 Branches 목록의 현재 브랜치 줄로 스크롤.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel, revealCurrentBranch } = require('../render');

const PANEL_W = 40;
const PANEL_H = 60;
const GREEN = '\x1b[32m';  // colors.green — 현재 브랜치

function plain(lines) {
  return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

function resetState({ branch = 'main', branches, isLinkedWorktree = false } = {}) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = branch;
  state.branches = branches || [{ name: branch, isCurrent: true }];
  state.remoteBranches = [];
  state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch, isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false }];
  state.isLinkedWorktree = isLinkedWorktree;
  state.ahead = 0;
  state.behind = 0;
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.leftRevealCurrentBranch = false;
  ui.leftCurrentBranchLineIdx = -1;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

// 'b0' ... 'b<n-1>' 중 마지막만 현재 브랜치 — 목록 아래쪽에 놓아 스크롤이 필요하게 만든다.
function manyBranches(n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push({ name: 'b' + i, isCurrent: i === n - 1 });
  return list;
}

// ── 표기 ──

test('상단 브랜치명에 Branches 목록과 같은 ✓를 붙인다', () => {
  resetState();
  assert.match(plain(buildLeftPanel(PANEL_W, PANEL_H))[0], /^ ✓ main\s*$/);
});

test('상단 브랜치명은 현재 브랜치 색(green)으로 칠한다', () => {
  resetState();
  const top = buildLeftPanel(PANEL_W, PANEL_H)[0];
  const idx = top.indexOf('✓');
  assert.ok(idx > 0, '✓가 있어야 한다');
  const codes = top.substring(0, idx).match(/\x1b\[[0-9;]*m/g);
  assert.ok(codes.includes(GREEN), 'green이 적용돼야 한다');
});

test('detached HEAD면 ✓도 클릭 액션도 붙지 않는다', () => {
  resetState({ branch: 'HEAD (detached)', branches: [{ name: 'main', isCurrent: false }] });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(out[0].includes('✓'), false);
  assert.equal(ui.leftPanelClickMap[0], null);
  assert.equal(ui.leftCurrentBranchLineIdx, -1);
});

test('rebase 진행 중에도 ✓와 작업 표기가 함께 나온다', () => {
  resetState();
  state.operationState = { type: 'rebase-merge', step: 2, total: 5 };
  const top = plain(buildLeftPanel(PANEL_W, PANEL_H))[0];
  assert.match(top, /^ ✓ main \(rebasing 2\/5\)/);
});

test('좁은 패널에서도 ✓ 때문에 줄이 넘치지 않는다', () => {
  resetState({
    branch: 'a-very-long-branch-name-that-overflows',
    branches: [{ name: 'a-very-long-branch-name-that-overflows', isCurrent: true }],
  });
  const narrow = 20;
  for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
    assert.ok(line.length <= narrow - 1, '줄이 패널 폭을 넘음: [' + line + ']');
  }
});

// ── 클릭 → 스크롤 ──

test('상단 브랜치명 줄에 reveal-current-branch 클릭 액션이 붙는다', () => {
  resetState({ branch: 'feature/login', branches: [{ name: 'feature/login', isCurrent: true }] });
  buildLeftPanel(PANEL_W, PANEL_H);
  assert.deepEqual(ui.leftPanelClickMap[0], { action: 'reveal-current-branch', branch: 'feature/login' });
});

test('현재 브랜치가 화면 밖이면 보이는 위치까지 스크롤한다', () => {
  resetState({ branch: 'b39', branches: manyBranches(40) });
  const h = 10;
  buildLeftPanel(PANEL_W, h);
  const idx = ui.leftCurrentBranchLineIdx;
  assert.ok(idx >= h, '현재 브랜치가 첫 화면 밖에 있어야 하는 테스트다');
  assert.equal(ui.leftPanelScrollOffset, 0);

  revealCurrentBranch('b39');
  buildLeftPanel(PANEL_W, h);
  const off = ui.leftPanelScrollOffset;
  assert.ok(idx >= off && idx < off + h, `현재 브랜치 줄(${idx})이 뷰포트(${off}~${off + h - 1}) 안에 있어야 한다`);
  assert.equal(ui.leftRevealCurrentBranch, false, '플래그는 한 번만 소비된다');
});

test('이미 보이는 상태면 스크롤 위치를 그대로 둔다', () => {
  resetState({ branch: 'b0', branches: manyBranches(40) });
  buildLeftPanel(PANEL_W, PANEL_H);
  const before = ui.leftPanelScrollOffset;

  revealCurrentBranch('b0');
  buildLeftPanel(PANEL_W, PANEL_H);
  assert.equal(ui.leftPanelScrollOffset, before);
});

test('Branches 섹션이 접혀 있으면 펼치고 스크롤한다', () => {
  resetState({ branch: 'b39', branches: manyBranches(40) });
  ui.collapsedSections.branches = true;
  const h = 10;
  buildLeftPanel(PANEL_W, h);
  assert.equal(ui.leftCurrentBranchLineIdx, -1, '접힌 상태에서는 대상 줄이 없다');

  revealCurrentBranch('b39');
  buildLeftPanel(PANEL_W, h);
  assert.equal(ui.collapsedSections.branches, false);
  const idx = ui.leftCurrentBranchLineIdx;
  const off = ui.leftPanelScrollOffset;
  assert.ok(idx >= 0, '펼친 뒤에는 현재 브랜치 줄이 있어야 한다');
  assert.ok(idx >= off && idx < off + h, '펼친 현재 브랜치 줄이 화면 안에 있어야 한다');
});

test('현재 브랜치가 속한 그룹(feature/)이 접혀 있으면 그룹도 펼친다', () => {
  // 현재 브랜치는 feature/login 하나뿐 — 나머지는 스크롤이 필요할 만큼의 채움용
  const branches = manyBranches(30).map(b => ({ ...b, isCurrent: false }));
  branches.push({ name: 'feature/login', isCurrent: true });
  resetState({ branch: 'feature/login', branches });
  ui.collapsedGroups['b:feature'] = true;
  const h = 10;
  buildLeftPanel(PANEL_W, h);
  assert.equal(ui.leftCurrentBranchLineIdx, -1);

  revealCurrentBranch('feature/login');
  buildLeftPanel(PANEL_W, h);
  assert.equal(ui.collapsedGroups['b:feature'], false);
  const idx = ui.leftCurrentBranchLineIdx;
  const off = ui.leftPanelScrollOffset;
  assert.ok(idx >= 0);
  assert.ok(idx >= off && idx < off + h);
});

test('스크롤 후에도 클릭 맵은 화면에 보이는 줄과 맞는다', () => {
  resetState({ branch: 'b39', branches: manyBranches(40) });
  const h = 10;
  revealCurrentBranch('b39');
  const visible = plain(buildLeftPanel(PANEL_W, h));
  const rowInView = ui.leftCurrentBranchLineIdx - ui.leftPanelScrollOffset;
  assert.match(visible[rowInView], /✓ b39/);
  assert.deepEqual(ui.leftPanelClickMap[rowInView], { action: 'goto-branch', branch: 'b39' });
});
