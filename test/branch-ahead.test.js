// Branches 목록의 현재 브랜치(✓) 옆 추적 상태 표기(@리모트 / ↓N / ↑N) 검증.
// 상단 브랜치명 줄에도 ✓가 붙으므로 Branches 섹션 아래에서만 찾는다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel } = require('../render');

const PANEL_W = 40;
const PANEL_H = 60;
const ORANGE = '\x1b[33m'; // colors.orange — Push 버튼의 카운트와 같은 색
const RED = '\x1b[31m';    // colors.red — @리모트이름
const RESET = '\x1b[0m';   // ansi.reset
const CURSOR_BG = '\x1b[100m';              // colors.cursorBg — 선택된 줄
const HOVER_BG = '\x1b[48;2;50;50;50m';     // colors.hoverBg — 마우스 올린 줄
const UNDERLINE = '\x1b[4m';

function plain(lines) {
  return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

function resetState({ branch = 'main', ahead = 0, behind = 0, isLinkedWorktree = false, branches, remotes } = {}) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = branch;
  state.branches = branches || [{ name: branch, isCurrent: true }];
  state.remoteBranches = [];
  state.remotes = remotes || ['origin'];
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

// ── 상단 브랜치명 줄에도 같은 표기가 붙는다 ──

test('상단 브랜치명 줄에도 ↑N을 붙인다', () => {
  resetState({ ahead: 3 });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /^ \u2713 main \u21913\s*$/);
});

test('\uc0c1\ub2e8 \ube0c\ub79c\uce58\uba85 \uc904\uc5d0\ub3c4 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc744 \ubd99\uc778\ub2e4', () => {
  resetState({ ahead: 3, behind: 2, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /^ \u2713 main @origin \u21932 \u21913\s*$/);
});

test('detached HEAD\uba74 \uc0c1\ub2e8 \uc904\uc5d0 \ucd94\uc801 \ud45c\uae30\ub97c \ubd99\uc774\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({ branch: 'HEAD (detached)', ahead: 3, behind: 2, branches: [{ name: 'main', isCurrent: false }] });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(out[0].includes('\u2191'), false);
  assert.equal(out[0].includes('@'), false);
});

test('\uc881\uc740 \ud328\ub110\uc5d0\uc11c \uc0c1\ub2e8 \uc904\ub3c4 \ud3ed\uc744 \ub118\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({
    branch: 'a-very-long-branch-name-that-overflows',
    ahead: 128,
    behind: 64,
    isLinkedWorktree: true,
    branches: [{ name: 'a-very-long-branch-name-that-overflows', isCurrent: true, upstream: 'origin/a-very-long-branch-name-that-overflows' }],
  });
  const narrow = 32;
  assert.ok(plain(buildLeftPanel(narrow, PANEL_H))[0].length <= narrow - 1);
});

test('linked worktree면 상단 줄에도 추적 표기와 [worktree]가 함께 나온다', () => {
  resetState({
    branch: 'feature/login',
    ahead: 4,
    isLinkedWorktree: true,
    branches: [{ name: 'feature/login', isCurrent: true, upstream: 'origin/feature/login' }],
  });
  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  assert.match(plain(raw)[0], /^ ✓ login @origin ↑4 \[worktree\]\s*$/);
  // 현재 브랜치 줄에도 같은 순서로 붙는다
  assert.match(currentRow(raw), /^\s*\u2713 login @origin \u21914 \[worktree\]\s*$/);
});

test('rebase 진행 중에는 추적 표기 뒤에 진행 상태가 붙는다', () => {
  resetState({ ahead: 7, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  state.operationState = { type: 'rebase-merge', step: 2, total: 5 };
  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  assert.match(currentRow(raw), /\u21917/);
  assert.match(plain(raw)[0], /^ \u2713 main @origin \u21917 \(rebasing 2\/5\)\s*$/);
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

// \u2500\u2500 @\ub9ac\ubaa8\ud2b8\uc774\ub984 \u2500\u2500
// \ud654\uc0b4\ud45c\ub294 \ubc00\ub9b0 \ucee4\ubc0b\uc774 \uc788\uc5b4\uc57c\ub9cc \ub098\uc624\ubbc0\ub85c "\ub9ac\ubaa8\ud2b8\uc640 \uac19\ub2e4"\uc640 "\ub9ac\ubaa8\ud2b8\uc5d0 \uc544\uc608 \uc5c6\ub2e4"\ub97c \uad6c\ubd84\ud558\uc9c0
// \ubabb\ud55c\ub2e4. upstream\uc774 \uc788\uc73c\uba74 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc744 \ubd99\uc5ec, \ud45c\uae30\uac00 \uc5c6\ub294 \uc904\uc744 \ub85c\uceec \uc804\uc6a9 \ube0c\ub79c\uce58\ub85c \uc77d\uac8c \ud55c\ub2e4.

test('upstream\uc774 \uc788\uc73c\uba74 \ud604\uc7ac \ube0c\ub79c\uce58\uc5d0 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc744 \ubd99\uc778\ub2e4', () => {
  resetState({ branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @origin\s*$/);
});

test('upstream\uc774 \uc5c6\ub294 \ub85c\uceec \uc804\uc6a9 \ube0c\ub79c\uce58\uc5d0\ub294 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc774 \ubd99\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({ branches: [{ name: 'main', isCurrent: true, upstream: '' }] });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main\s*$/);
});

test('@\ub9ac\ubaa8\ud2b8\uc774\ub984\uc740 red\ub85c \uce60\ud55c\ub2e4', () => {
  resetState({ branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  const raw = currentRawRow(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = raw.indexOf('@origin');
  assert.ok(idx > 0, '@origin\uc774 \uc788\uc5b4\uc57c \ud55c\ub2e4');
  const codes = raw.substring(0, idx).match(/\x1b\[[0-9;]*m/g);
  assert.ok(codes.includes(RED), 'red\uac00 \uc801\uc6a9\ub3fc\uc57c \ud55c\ub2e4');
});

test('origin\uc774 \uc544\ub2cc \ub9ac\ubaa8\ud2b8 \uc774\ub984\ub3c4 \uadf8\ub300\ub85c \uc4f4\ub2e4', () => {
  resetState({
    remotes: ['origin', 'upstream'],
    branches: [{ name: 'main', isCurrent: true, upstream: 'upstream/main' }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @upstream\s*$/);
});

test('upstream \ube0c\ub79c\uce58\uba85\uc5d0 \uc2ac\ub798\uc2dc\uac00 \uc788\uc5b4\ub3c4 \ub9ac\ubaa8\ud2b8 \uc774\ub984\ub9cc \uc798\ub77c \uc4f4\ub2e4', () => {
  resetState({
    branch: 'feature/login',
    branches: [{ name: 'feature/login', isCurrent: true, upstream: 'origin/feature/login' }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 login @origin\s*$/);
});

test('upstream\uc774 \ub85c\uceec \ube0c\ub79c\uce58\uba74 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc744 \ubd99\uc774\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({ branch: 'topic', branches: [{ name: 'topic', isCurrent: true, upstream: 'main' }] });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 topic\s*$/);
});

// upstream \ubbf8\uc124\uc815 + \uac19\uc740 \uc774\ub984\uc758 \uc6d0\uaca9 \ube0c\ub79c\uce58 \uc874\uc7ac \u2014 \ub2e4\ub978 \ub3c4\uad6c\uac00 `git push origin HEAD`\ub85c \uc62c\ub9b0 \uacbd\uc6b0.
// \ucee4\ubc0b \ub370\ucf54\ub808\uc774\uc158\uc5d0\ub294 origin/\u2026\uc774 \ubcf4\uc774\ub294\ub370 \uc67c\ucabd \ud328\ub110\ub9cc \ube44\uc5b4 \ubcf4\uc774\ub358 \ubb38\uc81c.

test('upstream\uc774 \uc5c6\uc5b4\ub3c4 \uac19\uc740 \uc774\ub984\uc758 \uc6d0\uaca9 \ube0c\ub79c\uce58\uac00 \uc788\uc73c\uba74 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc744 \ubd99\uc778\ub2e4', () => {
  resetState({
    branch: 'feature/w1-persona-create',
    branches: [{ name: 'feature/w1-persona-create', isCurrent: true, upstream: '' }],
  });
  state.remoteBranches = ['origin/feature/w1-persona-create', 'origin/main'];
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 w1-persona-create @origin\s*$/);
});

test('\uc774\ub984\uc774 \ub2e4\ub978 \uc6d0\uaca9 \ube0c\ub79c\uce58\ub9cc \uc788\uc73c\uba74 \ubd99\uc774\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({ branch: 'topic', branches: [{ name: 'topic', isCurrent: true, upstream: '' }] });
  state.remoteBranches = ['origin/main', 'origin/topic-old'];
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 topic\s*$/);
});

test('\uc5ec\ub7ec \ub9ac\ubaa8\ud2b8\uc5d0 \uac19\uc740 \uc774\ub984\uc774 \uc788\uc73c\uba74 origin\uc744 \uba3c\uc800 \uc4f4\ub2e4', () => {
  resetState({ remotes: ['gitlab', 'origin'], branches: [{ name: 'main', isCurrent: true, upstream: '' }] });
  state.remoteBranches = ['gitlab/main', 'origin/main'];
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @origin\s*$/);
});

test('origin\uc774 \uc5c6\uc73c\uba74 \ub9ac\ubaa8\ud2b8 \ubaa9\ub85d \uc21c\uc11c\ub300\ub85c \uace0\ub978\ub2e4', () => {
  resetState({ remotes: ['gitlab', 'upstream'], branches: [{ name: 'main', isCurrent: true, upstream: '' }] });
  state.remoteBranches = ['upstream/main', 'gitlab/main'];
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @gitlab\s*$/);
});

test('upstream\uc774 \uc124\uc815\ub3fc \uc788\uc73c\uba74 \uac19\uc740 \uc774\ub984\uc758 \ub2e4\ub978 \ub9ac\ubaa8\ud2b8\ubcf4\ub2e4 upstream\uc744 \uc4f4\ub2e4', () => {
  resetState({
    remotes: ['origin', 'upstream'],
    branches: [{ name: 'main', isCurrent: true, upstream: 'upstream/main' }],
  });
  state.remoteBranches = ['origin/main', 'upstream/main'];
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @upstream\s*$/);
});

test('\uc6d0\uaca9 \ube0c\ub79c\uce58\ub85c \ucc3e\uc740 @\ub9ac\ubaa8\ud2b8\uc774\ub984\ub3c4 \uc0c1\ub2e8 \uc904\uc5d0 \uac19\uc774 \ub098\uc628\ub2e4', () => {
  resetState({ branch: 'topic', branches: [{ name: 'topic', isCurrent: true, upstream: '' }] });
  state.remoteBranches = ['origin/topic'];
  assert.match(plain(buildLeftPanel(PANEL_W, PANEL_H))[0], /^ \u2713 topic @origin\s*$/);
});

test('\ub2e4\ub978 \ube0c\ub79c\uce58\uc5d0\ub294 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc774 \ubd99\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({
    branches: [
      { name: 'main', isCurrent: true, upstream: 'origin/main' },
      { name: 'hotfix', isCurrent: false, upstream: 'origin/hotfix' },
    ],
  });
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const hotfixRow = out.find(l => /^\s*hotfix\s*$/.test(l));
  assert.ok(hotfixRow, 'hotfix \uc904\uc774 \uc788\uc5b4\uc57c \ud55c\ub2e4');
  assert.equal(hotfixRow.includes('@'), false);
});

// \u2500\u2500 @\ub9ac\ubaa8\ud2b8\uc774\ub984 + \ud654\uc0b4\ud45c \u2500\u2500

test('@\ub9ac\ubaa8\ud2b8\uc774\ub984 \ub4a4\uc5d0 \u2193N \u2191N \uc21c\uc73c\ub85c \ubd99\uc778\ub2e4', () => {
  resetState({
    ahead: 3,
    behind: 2,
    branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @origin \u21932 \u21913\s*$/);
});

test('behind\ub9cc \uc788\uc73c\uba74 @\ub9ac\ubaa8\ud2b8\uc774\ub984 \ub4a4\uc5d0 \u2193N\ub9cc \ubd99\uc778\ub2e4', () => {
  resetState({ behind: 4, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main @origin \u21934\s*$/);
});

test('upstream\uc774 \uc5c6\uc73c\uba74 \ud654\uc0b4\ud45c\ub9cc \ubd99\ub294\ub2e4', () => {
  resetState({ ahead: 3, behind: 2, branches: [{ name: 'main', isCurrent: true }] });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 main \u21932 \u21913\s*$/);
});

test('\u2193N\ub3c4 Pull \ubc84\ud2bc\uacfc \uac19\uc740 orange\ub85c \uce60\ud55c\ub2e4', () => {
  resetState({ behind: 2, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  const raw = currentRawRow(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = raw.indexOf('\u2193');
  assert.ok(idx > 0, '\ud654\uc0b4\ud45c\uac00 \uc788\uc5b4\uc57c \ud55c\ub2e4');
  const codes = raw.substring(0, idx).match(/\x1b\[[0-9;]*m/g);
  assert.ok(codes.includes(ORANGE), 'orange\uac00 \uc801\uc6a9\ub3fc\uc57c \ud55c\ub2e4');
});

test('@\ub9ac\ubaa8\ud2b8\uc774\ub984\uacfc \ud654\uc0b4\ud45c, [worktree]\uac00 \uc21c\uc11c\ub300\ub85c \ub098\uc628\ub2e4', () => {
  resetState({
    branch: 'feature/login',
    ahead: 2,
    behind: 1,
    isLinkedWorktree: true,
    branches: [{ name: 'feature/login', isCurrent: true, upstream: 'origin/feature/login' }],
  });
  assert.match(currentRow(buildLeftPanel(PANEL_W, PANEL_H)), /^\s*\u2713 login @origin \u21931 \u21912 \[worktree\]\s*$/);
});

test('Pinned \uc139\uc158\uc758 \ud604\uc7ac \ube0c\ub79c\uce58\uc5d0\ub3c4 \uac19\uc740 \ud45c\uae30\uac00 \ubd99\ub294\ub2e4', () => {
  resetState({ ahead: 3, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  ui.pinnedBranches = ['main'];
  try {
    const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
    const start = out.findIndex(l => /^\s*[-+] Pinned/.test(l));
    assert.ok(start >= 0, 'Pinned \uc139\uc158\uc774 \uc788\uc5b4\uc57c \ud55c\ub2e4');
    assert.match(out[start + 1], /^\s*\u2713 main @origin \u21913\s*$/);
  } finally {
    ui.pinnedBranches = [];
  }
});

test('Remotes \ubaa9\ub85d\uc758 \ube0c\ub79c\uce58\uc5d0\ub294 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uc774 \ubd99\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({ ahead: 4, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  state.remoteBranches = ['origin/main', 'origin/hotfix'];
  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const remoteIdx = out.findIndex(l => /^\s*[-+] Remotes/.test(l));
  assert.ok(remoteIdx >= 0, 'Remotes \uc139\uc158\uc774 \uc788\uc5b4\uc57c \ud55c\ub2e4');
  for (const line of out.slice(remoteIdx)) {
    assert.equal(line.includes('@'), false, '\ub9ac\ubaa8\ud2b8 \uc904\uc5d0 @\ud45c\uae30\uac00 \ubd99\uc74c: [' + line + ']');
  }
});

test('\uc881\uc740 \ud328\ub110\uc5d0\uc11c\ub3c4 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uacfc \ud654\uc0b4\ud45c\uac00 \ud3ed\uc744 \ub118\uc9c0 \uc54a\ub294\ub2e4', () => {
  resetState({
    branch: 'a-very-long-branch-name-that-overflows',
    ahead: 128,
    behind: 64,
    branches: [{ name: 'a-very-long-branch-name-that-overflows', isCurrent: true, upstream: 'origin/a-very-long-branch-name-that-overflows' }],
  });
  const narrow = 32;
  for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
    assert.ok(line.length <= narrow - 1, '\uc904\uc774 \ud328\ub110 \ud3ed\uc744 \ub118\uc74c: [' + line + '] (' + line.length + ' > ' + (narrow - 1) + ')');
  }
});

// \u2500\u2500 \ud589 \ud558\uc774\ub77c\uc774\ud2b8 \u2500\u2500
// \uc904 \uc548\uc758 reset\uc774 \ubc30\uacbd/\ubc11\uc904\uc744 \ub04a\uc5b4 `\u2713 main` \ub4a4(@origin, \ud654\uc0b4\ud45c, \ud0dc\uadf8)\uac00 \ud558\uc774\ub77c\uc774\ud2b8\uc5d0\uc11c
// \ube60\uc9c0\ub358 \ubb38\uc81c. reset \ub4a4\ub9c8\ub2e4 \uc2a4\ud0c0\uc77c\uc744 \ub2e4\uc2dc \uae54\uace0 \ud3ed \ub05d\uae4c\uc9c0 \ucc44\uc6cc \ud55c \uc904\ub85c \uc774\uc5b4\uc838\uc57c \ud55c\ub2e4.

// Branches \uc139\uc158\uc758 \ud604\uc7ac \ube0c\ub79c\uce58 \uc904 \uc778\ub371\uc2a4 \u2014 hover\ub97c \uadf8 \uc904\uc5d0 \uac78\uae30 \uc704\ud574 \ud544\uc694\ud558\ub2e4.
function currentRowIdx(rawLines) {
  const flat = plain(rawLines);
  const start = flat.findIndex(l => /^\s*[-+] Branches/.test(l));
  if (start < 0) return -1;
  for (let i = start + 1; i < flat.length; i++) {
    if (flat[i].includes('\u2713')) return i;
  }
  return -1;
}

// \uc904 \uc2dc\uc791\uacfc \uc904 \uc911\uac04 reset \ub4a4\ub9c8\ub2e4 style\uc774 \ub2e4\uc2dc \uae54\ub838\ub294\uc9c0 \u2014 \ub05d\uc758 \ube48 \uc870\uac01\uc740 \ucd5c\uc885 reset\uc774\ub77c \ube80\ub2e4.
function assertStyleUnbroken(row, style) {
  const segs = row.split(RESET);
  for (let i = 0; i < segs.length - 1; i++) {
    assert.ok(segs[i].startsWith(style), '\ud558\uc774\ub77c\uc774\ud2b8\uac00 \ub04a\uae40: ' + JSON.stringify(segs[i]));
  }
}

test('\ub9c8\uc6b0\uc2a4 \uc62c\ub9b0 \uc904\uc740 \ubc30\uacbd\uacfc \ubc11\uc904\uc774 \uc904 \ub05d\uae4c\uc9c0 \uc774\uc5b4\uc9c4\ub2e4', () => {
  resetState({ ahead: 3, behind: 2, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  const idx = currentRowIdx(buildLeftPanel(PANEL_W, PANEL_H));
  assert.ok(idx > 0, '\ud604\uc7ac \ube0c\ub79c\uce58 \uc904\uc774 \uc788\uc5b4\uc57c \ud55c\ub2e4');
  ui.hoveredLeftPanelRow = idx;
  try {
    const row = buildLeftPanel(PANEL_W, PANEL_H)[idx];
    assert.match(plain([row])[0], /^\s*\u2713 main @origin \u21932 \u21913\s*$/);
    assert.equal(plain([row])[0].length, PANEL_W - 1, '\uc904 \ub05d\uae4c\uc9c0 \ucc44\uc6cc\uc57c \ud55c\ub2e4');
    assertStyleUnbroken(row, HOVER_BG + UNDERLINE);
  } finally {
    ui.hoveredLeftPanelRow = -1;
  }
});

test('\uc120\ud0dd\ub41c \ube0c\ub79c\uce58 \uc904\uc740 \ubc30\uacbd\uc774 \uc904 \ub05d\uae4c\uc9c0 \uc774\uc5b4\uc9c4\ub2e4', () => {
  resetState({ ahead: 3, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  ui.leftPanelActiveBranch = 'main';
  try {
    const row = currentRawRow(buildLeftPanel(PANEL_W, PANEL_H));
    assert.equal(plain([row])[0].length, PANEL_W - 1, '\uc904 \ub05d\uae4c\uc9c0 \ucc44\uc6cc\uc57c \ud55c\ub2e4');
    assertStyleUnbroken(row, CURSOR_BG);
  } finally {
    ui.leftPanelActiveBranch = null;
  }
});

test('\ub9c8\uc6b0\uc2a4 \uc62c\ub9b0 \uc904\uc5d0\uc11c\ub3c4 @\ub9ac\ubaa8\ud2b8\uc774\ub984\uacfc \ud654\uc0b4\ud45c \uc0c9\uc740 \uc720\uc9c0\ub41c\ub2e4', () => {
  resetState({ ahead: 3, behind: 2, branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  const idx = currentRowIdx(buildLeftPanel(PANEL_W, PANEL_H));
  ui.hoveredLeftPanelRow = idx;
  try {
    const row = buildLeftPanel(PANEL_W, PANEL_H)[idx];
    const redIdx = row.indexOf(RED);
    const atIdx = row.indexOf('@origin');
    assert.ok(redIdx >= 0 && redIdx < atIdx, '@origin \uc55e\uc5d0 red\uac00 \ub0a8\uc544\uc57c \ud55c\ub2e4');
    const orangeIdx = row.indexOf(ORANGE);
    assert.ok(orangeIdx > atIdx, '\ud654\uc0b4\ud45c \uc55e\uc5d0 orange\uac00 \ub0a8\uc544\uc57c \ud55c\ub2e4');
  } finally {
    ui.hoveredLeftPanelRow = -1;
  }
});

test('\ub9c8\uc6b0\uc2a4 \uc62c\ub9b0 \uc139\uc158 \ud5e4\ub354\ub3c4 \uc904 \ub05d\uae4c\uc9c0 \uc774\uc5b4\uc9c4\ub2e4', () => {
  resetState({ branches: [{ name: 'main', isCurrent: true, upstream: 'origin/main' }] });
  const idx = plain(buildLeftPanel(PANEL_W, PANEL_H)).findIndex(l => /^\s*[-+] Branches/.test(l));
  assert.ok(idx > 0, 'Branches \ud5e4\ub354\uac00 \uc788\uc5b4\uc57c \ud55c\ub2e4');
  ui.hoveredLeftPanelRow = idx;
  try {
    const row = buildLeftPanel(PANEL_W, PANEL_H)[idx];
    assert.equal(plain([row])[0].length, PANEL_W - 1, '\uc904 \ub05d\uae4c\uc9c0 \ucc44\uc6cc\uc57c \ud55c\ub2e4');
    assertStyleUnbroken(row, HOVER_BG + UNDERLINE);
  } finally {
    ui.hoveredLeftPanelRow = -1;
  }
});
