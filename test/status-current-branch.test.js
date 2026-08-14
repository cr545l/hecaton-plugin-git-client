// Status(왼쪽) 패널 상단 브랜치명 줄 검증 — Branches 목록과 같은 ✓/색/클릭 동작.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel } = require('../render');

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
  assert.deepEqual(topEntry, { action: 'goto-branch', branch: 'feature/login' });
  assert.deepEqual(topEntry, branchEntry);
});
