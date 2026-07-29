// Branches 목록의 현재 브랜치(✓) 옆 푸시 대기 표기(↑N) 검증.
// 상단 브랜치명 줄에도 ✓가 붙으므로 Branches 섹션 아래에서만 찾는다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel } = require('../render');

const PANEL_W = 40;
const PANEL_H = 60;
const ORANGE = '\x1b[33m'; // colors.orange — Push 버튼의 카운트와 같은 색

function plain(lines) {
  return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

function resetState({ branch = 'main', ahead = 0, behind = 0, isLinkedWorktree = false, branches } = {}) {
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
  state.ahead = ahead;
  state.behind = behind;
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

// ── Branches 섹션(✓ 표시된 현재 브랜치) ──

// 상단 브랜치명 줄에도 ✓가 붙으므로 Branches 섹션 아래에서만 찾는다.
function currentRawRow(rawLines) {
  const flat = plain(rawLines);
  const start = flat.findIndex(l => /^\s*[-+] Branches/.test(l));
  if (start < 0) return undefined;
  for (let i = start + 1; i < flat.length; i++) {
    if (flat[i].includes('\u2713')) return rawLines[i];
  }
  return undefined;
}

function currentRow(rawLines) {
  const raw = currentRawRow(rawLines);
  return raw === undefined ? undefined : plain([raw])[0];
}

test('Branches의 현재 브랜치에도 ↑N을 표기한다', () => {
  resetState({
    ahead: 3,
    branches: [{ name: 'main', isCurrent: true }, { name: 'hotfix', isCurrent: false }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main \u21913\s*$/);
});

test('Branches의 다른 브랜치에는 ↑N이 붙지 않는다', () => {
  resetState({
    ahead: 3,
    branches: [{ name: 'main', isCurrent: true }, { name: 'hotfix', isCurrent: false }],
  });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const hotfixRow = out.find(l => /^\s*hotfix\s*$/.test(l));
  assert.ok(hotfixRow, 'hotfix 줄이 있어야 한다');
  assert.equal(hotfixRow.includes('\u2191'), false);
});

test('그룹(feature/) 안의 현재 브랜치에도 ↑N을 표기한다', () => {
  resetState({
    branch: 'feature/login',
    ahead: 5,
    branches: [{ name: 'feature/login', isCurrent: true }, { name: 'feature/signup', isCurrent: false }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 login \u21915\s*$/);
});

test('현재 브랜치의 ↑N과 [worktree]가 함께 나온다', () => {
  resetState({
    branch: 'feature/login',
    ahead: 2,
    isLinkedWorktree: true,
    branches: [{ name: 'feature/login', isCurrent: true }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 login \u21912 \[worktree\]\s*$/);
});

test('Remotes 목록의 브랜치에는 ↑N이 붙지 않는다', () => {
  resetState({ ahead: 4 });
  state.remoteBranches = ['origin/main', 'origin/hotfix'];
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const remoteIdx = out.findIndex(l => /^\s*[-+] Remotes/.test(l));
  assert.ok(remoteIdx >= 0, 'Remotes 섹션이 있어야 한다');
  for (const line of out.slice(remoteIdx)) {
    assert.equal(line.includes('\u2191'), false, '리모트 줄에 화살표가 붙음: [' + line + ']');
  }
});

test('ahead가 0이면 Branches의 현재 브랜치도 그대로다', () => {
  resetState({ ahead: 0, branches: [{ name: 'main', isCurrent: true }] });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main\s*$/);
});

test('좁은 패널에서 현재 브랜치 줄도 폭을 넘지 않는다', () => {
  resetState({
    branch: 'a-very-long-branch-name-that-overflows',
    ahead: 128,
    branches: [{ name: 'a-very-long-branch-name-that-overflows', isCurrent: true }],
  });
  const narrow = 20;
  for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
    assert.ok(line.length <= narrow - 1, '줄이 패널 폭을 넘음: [' + line + '] (' + line.length + ' > ' + (narrow - 1) + ')');
  }
});

// ── 상단 브랜치명 줄에는 붙지 않는다 ──

test('상단 브랜치명 줄에는 ↑N을 붙이지 않는다', () => {
  resetState({ ahead: 3 });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /^ \u2713 main\s*$/);
  assert.equal(out[0].includes('\u2191'), false);
});

test('linked worktree여도 상단 줄은 [worktree]만 유지한다', () => {
  resetState({
    branch: 'feature/login',
    ahead: 4,
    isLinkedWorktree: true,
    branches: [{ name: 'feature/login', isCurrent: true }],
  });
  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  assert.match(plain(raw)[0], /^ ✓ login \[worktree\]\s*$/);
  // 현재 브랜치 줄에는 그대로 붙는다
  assert.match(currentRow(raw), /^\s*\u2713 login \u21914 \[worktree\]\s*$/);
});

test('rebase 진행 중에도 현재 브랜치에만 ↑N이 붙는다', () => {
  resetState({ ahead: 7 });
  state.operationState = { type: 'rebase-merge', step: 2, total: 5 };
  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  assert.match(currentRow(raw), /\u21917/);
  const top = plain(raw)[0];
  assert.match(top, /rebasing 2\/5/);
  assert.equal(top.includes('\u2191'), false);
});

// ── 색상 / behind ──

test('behind만 있을 때는 ↑ 표기가 어디에도 붙지 않는다', () => {
  resetState({ ahead: 0, behind: 5 });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(out.some(l => l.includes('\u2191')), false);
});

test('↑N은 Push 버튼과 같은 orange로 칠한다', () => {
  resetState({ ahead: 2 });
  const raw = currentRawRow(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = raw.indexOf('\u2191');
  assert.ok(idx > 0, '화살표가 있어야 한다');
  const codes = raw.substring(0, idx).match(/\x1b\[[0-9;]*m/g);
  assert.ok(codes.includes(ORANGE), 'orange가 적용돼야 한다');
});

test('좁은 패널에서 ↑N은 잘리지 않고 브랜치명이 먼저 줄어든다', () => {
  resetState({
    branch: 'a-very-long-branch-name-that-overflows',
    ahead: 9,
    branches: [{ name: 'a-very-long-branch-name-that-overflows', isCurrent: true }],
  });
  assert.match(currentRow(buildLeftPanel(24, PANEL_H)), /\u21919\s*$/);
});
