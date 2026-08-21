// Status(왼쪽) 패널 상단 브랜치명 줄 검증 — Branches 목록과 같은 ✓/색/클릭 동작.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel, revealBranch } = require('../render');

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
  ui.leftRevealBranch = null;
  ui.leftPanelActiveBranch = null;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
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

// ── 클릭 동작 ──

test('상단 브랜치명 줄은 Branches 항목과 같은 goto-branch 액션을 사용한다', () => {
  resetState({ branch: 'feature/login', branches: [{ name: 'feature/login', isCurrent: true }] });
  buildLeftPanel(PANEL_W, PANEL_H);
  const topEntry = ui.leftPanelClickMap[0];
  const branchEntry = ui.leftPanelClickMap.find((entry, row) => row > 0 && entry && entry.branch === 'feature/login');
  // reveal은 상단 줄에만 붙는다 — 목록 줄은 눌린 자리가 곧 그 줄이라 스크롤할 이유가 없다.
  assert.deepEqual(topEntry, { action: 'goto-branch', branch: 'feature/login', reveal: true });
  assert.deepEqual(branchEntry, { action: 'goto-branch', branch: 'feature/login' });
});

// ── 접힌 토글 펼치기 + 스크롤 ──

test('접혀 있으면 Branches 섹션과 prefix 그룹을 모두 펼친다', () => {
  resetState({ branch: 'feature/login', branches: [{ name: 'feature/login', isCurrent: true }] });
  ui.collapsedSections.branches = true;
  ui.collapsedGroups['b:feature'] = true;
  revealBranch('feature/login');
  assert.equal(ui.collapsedSections.branches, false);
  assert.equal(ui.collapsedGroups['b:feature'], false);
});

test('접힌 상태에서도 펼친 뒤 그 브랜치 줄이 화면 안으로 들어온다', () => {
  const branches = [];
  for (let i = 0; i < 40; i++) branches.push({ name: 'feature/b' + i, isCurrent: false });
  branches.push({ name: 'feature/login', isCurrent: true });
  resetState({ branch: 'feature/login', branches });
  ui.collapsedSections.branches = true;
  ui.collapsedGroups['b:feature'] = true;

  revealBranch('feature/login');
  buildLeftPanel(PANEL_W, 12);

  const visible = ui.leftPanelClickMap.some(e => e && e.action === 'goto-branch' && e.branch === 'feature/login' && !e.reveal);
  assert.ok(visible, '펼친 뒤 현재 브랜치 줄이 보이는 범위 안에 있어야 한다');
  assert.equal(ui.leftRevealBranch, null, '스크롤한 뒤에는 요청이 소모돼야 한다');
});

test('스크롤 요청이 없으면 좌측 패널 오프셋을 건드리지 않는다', () => {
  const branches = [];
  for (let i = 0; i < 40; i++) branches.push({ name: 'feature/b' + i, isCurrent: false });
  branches.push({ name: 'main', isCurrent: true });
  resetState({ branch: 'main', branches });
  ui.leftPanelScrollOffset = 3;
  buildLeftPanel(PANEL_W, 12);
  assert.equal(ui.leftPanelScrollOffset, 3);
});
