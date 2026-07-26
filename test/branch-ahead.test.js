// Status(왼쪽) 패널 상단 브랜치명 옆의 푸시 대기 표기(↑N) 검증.
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

function resetState({ branch = 'main', ahead = 0, behind = 0, isLinkedWorktree = false } = {}) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = branch;
  state.branches = [{ name: branch, isCurrent: true }];
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

test('푸시 대기 커밋이 있으면 브랜치명 옆에 ↑N을 표기한다', () => {
  resetState({ ahead: 3 });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /^ main \u21913\s*$/);
});

test('푸시 대기 커밋이 없으면 표기하지 않는다', () => {
  resetState({ ahead: 0 });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /^ main\s*$/);
  assert.equal(out[0].includes('\u2191'), false);
});

test('behind만 있을 때는 ↑ 표기가 붙지 않는다', () => {
  resetState({ ahead: 0, behind: 5 });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(out[0].includes('\u2191'), false);
});

test('↑N은 Push 버튼과 같은 orange로 칠한다', () => {
  resetState({ ahead: 2 });
  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  const idx = raw[0].indexOf('\u2191');
  assert.ok(idx > 0, '화살표가 있어야 한다');
  const codes = raw[0].substring(0, idx).match(/\x1b\[[0-9;]*m/g);
  assert.ok(codes.includes(ORANGE), 'orange가 적용돼야 한다');
});

test('worktree 표기와 함께 나올 때 순서는 브랜치 → ↑N → [worktree]', () => {
  resetState({ branch: 'feature/login', ahead: 4, isLinkedWorktree: true });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /^ login \u21914 \[worktree\]\s*$/);
});

test('rebase 진행 중에도 ↑N과 작업 표기가 함께 보인다', () => {
  resetState({ ahead: 7 });
  state.operationState = { type: 'rebase-merge', step: 2, total: 5 };
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /\u21917/);
  assert.match(out[0], /rebasing 2\/5/);
});

test('좁은 패널에서도 ↑N 때문에 줄 너비가 넘치지 않는다', () => {
  resetState({ branch: 'a-very-long-branch-name-that-overflows', ahead: 128 });
  const narrow = 20;
  for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
    assert.ok(line.length <= narrow - 1, `줄이 패널 폭을 넘음: [${line}] (${line.length} > ${narrow - 1})`);
  }
});

test('좁은 패널에서 ↑N은 잘리지 않고 브랜치명이 먼저 줄어든다', () => {
  resetState({ branch: 'a-very-long-branch-name-that-overflows', ahead: 9 });
  const out = plain(buildLeftPanel(24, PANEL_H));
  assert.match(out[0], /\u21919\s*$/);
});
