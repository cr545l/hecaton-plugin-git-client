// 브랜치 핀 검증 — Branches 위 Pinned 섹션 고정 표시, 목록/history의 하이라이트 색,
// 그리고 핀 목록 유지(토글/리네임/삭제).
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui, isPinnedBranch, togglePinnedBranch, unpinBranch, renamePinnedBranch } = require('../state');
const { buildLeftPanel, colorizeDecoration } = require('../render');

const PANEL_W = 40;
const PANEL_H = 60;
const PINNED = '\x1b[95m';  // colors.pinned — 핀 고정 브랜치
const GREEN = '\x1b[32m';   // colors.green — 현재 브랜치
const CYAN = '\x1b[36m';    // colors.cyan — 일반 로컬 브랜치(history) / 워크트리 점유(목록)
const RED = '\x1b[31m';     // colors.red — 리모트 추적 브랜치 / @리모트 표기
const ORANGE = '\x1b[33m';  // colors.orange — push/pull 대기 화살표

function plain(lines) {
  return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

function resetState({ branch = 'main', branches, pinned = [], worktrees, remoteBranches = [], ahead = 0, behind = 0 } = {}) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = branch;
  state.branches = branches || [
    { name: 'main', isCurrent: branch === 'main' },
    { name: 'develop', isCurrent: branch === 'develop' },
    { name: 'feature/login', isCurrent: branch === 'feature/login' },
  ];
  state.remoteBranches = remoteBranches;
  state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = worktrees || [{ path: 'C:/repo', branch, isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false }];
  state.isLinkedWorktree = false;
  state.ahead = ahead;
  state.behind = behind;
  ui.pinnedBranches = pinned.slice();
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.leftRevealCurrentBranch = false;
  ui.leftCurrentBranchLineIdx = -1;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

function sectionIdx(flat, title) {
  return flat.findIndex(l => new RegExp('^\\s*[-+] ' + title + '\\s*$').test(l));
}

// ── Pinned 섹션 ──

test('핀이 없으면 Pinned 섹션을 만들지 않는다', () => {
  resetState();
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(sectionIdx(flat, 'Pinned'), -1);
});

test('핀을 지정하면 Branches 위에 Pinned 섹션이 생긴다', () => {
  resetState({ pinned: ['develop'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const pinnedIdx = sectionIdx(flat, 'Pinned');
  const branchesIdx = sectionIdx(flat, 'Branches');
  assert.ok(pinnedIdx >= 0, 'Pinned 섹션이 있어야 한다');
  assert.ok(pinnedIdx < branchesIdx, 'Pinned가 Branches보다 위에 있어야 한다');
  assert.match(flat[pinnedIdx + 1], /^\s+develop\s*$/);
});

test('핀 지정 순서대로 나열한다', () => {
  resetState({ pinned: ['feature/login', 'develop'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = sectionIdx(flat, 'Pinned');
  assert.match(flat[idx + 1], /feature\/login/);
  assert.match(flat[idx + 2], /develop/);
});

test('Pinned 항목에도 goto-branch 클릭 액션이 붙는다', () => {
  resetState({ pinned: ['develop'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = sectionIdx(flat, 'Pinned');
  assert.deepEqual(ui.leftPanelClickMap[idx + 1], { action: 'goto-branch', branch: 'develop' });
});

test('없는 브랜치의 핀은 표시하지 않는다', () => {
  resetState({ pinned: ['gone', 'develop'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = sectionIdx(flat, 'Pinned');
  assert.match(flat[idx + 1], /^\s+develop\s*$/);
  assert.equal(sectionIdx(flat, 'Branches'), idx + 2, '핀 항목은 하나만 그려져야 한다');
});

test('모든 핀이 사라진 브랜치면 섹션 자체가 안 나온다', () => {
  resetState({ pinned: ['gone'] });
  assert.equal(sectionIdx(plain(buildLeftPanel(PANEL_W, PANEL_H)), 'Pinned'), -1);
});

test('Pinned 섹션은 접을 수 있다', () => {
  resetState({ pinned: ['develop'] });
  ui.collapsedSections.pinned = true;
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = flat.findIndex(l => /^\s*\+ Pinned\s*$/.test(l));
  assert.ok(idx >= 0, '접힌 Pinned 헤더가 있어야 한다');
  assert.equal(sectionIdx(flat, 'Branches'), idx + 1, '접히면 항목이 안 나온다');
  assert.deepEqual(ui.leftPanelClickMap[idx], { action: 'toggle-section', section: 'pinned' });
});

test('핀 고정 브랜치는 Branches 트리에도 그대로 남는다', () => {
  resetState({ pinned: ['develop'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const branchesIdx = sectionIdx(flat, 'Branches');
  assert.ok(flat.slice(branchesIdx).some(l => /^\s+develop\s*$/.test(l)));
});

test('현재 브랜치를 핀하면 Pinned 섹션에도 ✓가 붙는다', () => {
  resetState({ branch: 'main', pinned: ['main'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const idx = sectionIdx(flat, 'Pinned');
  assert.match(flat[idx + 1], /✓ main/);
});

test('핀이 있어도 줄이 패널 폭을 넘지 않는다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }, { name: 'a-very-long-branch-name-that-overflows', isCurrent: false }],
    pinned: ['a-very-long-branch-name-that-overflows'],
  });
  const narrow = 20;
  for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
    assert.ok(line.length <= narrow - 1, '줄이 패널 폭을 넘음: [' + line + ']');
  }
});

// ── 추적 상태 표기 ──
//
// 핀은 자주 보는 브랜치를 모아 둔 목록이라, 거기까지 가지 않고도 push/pull 할 게
// 있는지 알 수 있어야 한다. 현재 브랜치 줄과 같은 표기(@리모트 + ↓behind ↑ahead)를 쓴다.

function pinnedLines(w = PANEL_W) {
  const lines = buildLeftPanel(w, PANEL_H);
  const idx = plain(lines).findIndex(l => /^\s*[-+] Pinned\s*$/.test(l));
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s*[-+] /.test(plain(lines)[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function trackedBranches(branch) {
  return [
    { name: 'main', isCurrent: branch === 'main', upstream: 'origin/main', ahead: 0, behind: 0 },
    { name: 'develop', isCurrent: branch === 'develop', upstream: 'origin/develop', ahead: 2, behind: 3 },
    { name: 'local-only', isCurrent: branch === 'local-only', upstream: '', ahead: 0, behind: 0 },
  ];
}

test('핀 브랜치에 @리모트를 붙인다', () => {
  resetState({ branches: trackedBranches('main'), pinned: ['develop'], remoteBranches: ['origin/develop'] });
  const line = pinnedLines()[0];
  assert.match(plain([line])[0], /develop @origin/);
  assert.ok(codesBefore(line, '@origin').includes(RED), '@리모트는 red');
});

test('핀 브랜치에 push/pull 대기 수를 붙인다', () => {
  resetState({ branches: trackedBranches('main'), pinned: ['develop'], remoteBranches: ['origin/develop'] });
  const line = pinnedLines()[0];
  assert.match(plain([line])[0], /↓3 ↑2/, 'behind 먼저, ahead 다음');
  assert.ok(codesBefore(line, '↓3').includes(ORANGE), '화살표는 orange');
});

test('밀리거나 뒤처진 게 없으면 화살표를 붙이지 않는다', () => {
  resetState({ branches: trackedBranches('develop'), pinned: ['main'], remoteBranches: ['origin/main'] });
  assert.match(plain(pinnedLines())[0], /^\s+main @origin\s*$/);
});

test('리모트에 없는 브랜치는 아무 표기도 붙지 않는다', () => {
  resetState({ branches: trackedBranches('main'), pinned: ['local-only'] });
  assert.match(plain(pinnedLines())[0], /^\s+local-only\s*$/);
});

test('upstream이 없어도 같은 이름의 리모트 브랜치가 있으면 @리모트를 붙인다', () => {
  resetState({ branches: trackedBranches('main'), pinned: ['local-only'], remoteBranches: ['origin/local-only'] });
  assert.match(plain(pinnedLines())[0], /^\s+local-only @origin\s*$/);
});

test('현재 브랜치를 핀하면 상단 줄과 같은 값(state.ahead/behind)을 쓴다', () => {
  resetState({
    branch: 'main',
    branches: trackedBranches('main'),
    pinned: ['main'],
    remoteBranches: ['origin/main'],
    ahead: 5,
    behind: 7,
  });
  assert.match(plain(pinnedLines())[0], /✓ main @origin ↓7 ↑5/);
});

// 핀은 Pinned 목록과 Branches 트리 양쪽에 그려진다. 어느 쪽을 보고 있든 같은 정보가
// 있어야 하므로 트리에서도 추적 상태를 붙인다.
test('Branches 트리의 핀 고정 브랜치에도 추적 표기를 붙인다', () => {
  resetState({ branches: trackedBranches('main'), pinned: ['develop'], remoteBranches: ['origin/develop'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const flat = plain(lines);
  const branchesIdx = sectionIdx(flat, 'Branches');
  const i = flat.findIndex((l, idx) => idx > branchesIdx && /^\s+develop/.test(l));
  assert.match(flat[i], /^\s+develop @origin ↓3 ↑2\s*$/);
  assert.ok(codesBefore(lines[i], '@origin').includes(RED));
  assert.ok(codesBefore(lines[i], '↓3').includes(ORANGE));
});

test('핀이 아닌 브랜치는 트리에서 이름만 둔다', () => {
  resetState({ branches: trackedBranches('main'), pinned: ['develop'], remoteBranches: ['origin/develop', 'origin/main'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const branchesIdx = sectionIdx(flat, 'Branches');
  const line = flat.slice(branchesIdx).find(l => /^\s+local-only/.test(l));
  assert.equal(line.trim(), 'local-only', '줄마다 붙이면 트리가 넓어진다');
});

test('그룹(feature/) 안의 핀 고정 브랜치에도 붙는다', () => {
  resetState({
    branch: 'main',
    branches: [
      { name: 'main', isCurrent: true, upstream: 'origin/main', ahead: 0, behind: 0 },
      { name: 'feature/login', isCurrent: false, upstream: 'origin/feature/login', ahead: 1, behind: 0 },
      { name: 'feature/other', isCurrent: false, upstream: 'origin/feature/other', ahead: 9, behind: 9 },
    ],
    pinned: ['feature/login'],
    remoteBranches: ['origin/feature/login', 'origin/feature/other'],
  });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const branchesIdx = sectionIdx(flat, 'Branches');
  const rest = flat.slice(branchesIdx);
  assert.ok(rest.some(l => /^\s+login @origin ↑1\s*$/.test(l)), '핀 걸린 그룹 항목: ' + rest.join(' / '));
  assert.ok(rest.some(l => /^\s+other\s*$/.test(l)), '핀이 아닌 그룹 항목은 이름만');
});

test('추적 표기가 붙어도 줄이 패널 폭을 넘지 않는다', () => {
  resetState({
    branch: 'main',
    branches: [
      { name: 'main', isCurrent: true, upstream: 'origin/main', ahead: 0, behind: 0 },
      { name: 'a-very-long-branch-name-that-overflows', isCurrent: false, upstream: 'origin/a-very-long-branch-name-that-overflows', ahead: 12, behind: 34 },
    ],
    pinned: ['a-very-long-branch-name-that-overflows'],
    remoteBranches: ['origin/a-very-long-branch-name-that-overflows'],
  });
  for (const narrow of [16, 20, 28]) {
    for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
      assert.ok(line.length <= narrow - 1, 'w=' + narrow + ' 줄이 폭을 넘음: [' + line + ']');
    }
  }
});

// ── 하이라이트 색 ──

// 브랜치명 앞에 적용된 SGR 코드들
function codesBefore(line, name) {
  const idx = line.indexOf(name);
  assert.ok(idx > 0, name + '이(가) 줄에 있어야 한다: [' + line + ']');
  return line.substring(0, idx).match(/\x1b\[[0-9;]*m/g) || [];
}

test('핀 고정 브랜치는 목록에서 pinned 색으로 칠한다', () => {
  resetState({ pinned: ['develop'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const idx = plain(lines).findIndex(l => /^\s*[-+] Pinned\s*$/.test(l));
  assert.ok(codesBefore(lines[idx + 1], 'develop').includes(PINNED));
});

test('핀이 없는 브랜치는 기존 색을 유지한다', () => {
  resetState({ pinned: ['develop'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const flat = plain(lines);
  const branchesIdx = sectionIdx(flat, 'Branches');
  const mainLine = lines.slice(branchesIdx).find((_, i) => /^\s*✓ main\s*$/.test(flat[branchesIdx + i]));
  assert.ok(codesBefore(mainLine, 'main').includes(GREEN), '현재 브랜치는 green 유지');
});

test('다른 워크트리가 점유한 브랜치는 핀을 걸어도 cyan을 유지한다', () => {
  resetState({
    branch: 'main',
    pinned: ['develop'],
    worktrees: [
      { path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false },
      { path: 'C:/repo-dev', branch: 'develop', isMain: false, isCurrent: false, isDetached: false, isBare: false, isLocked: false, isPrunable: false },
    ],
  });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const idx = plain(lines).findIndex(l => /^\s*[-+] Pinned\s*$/.test(l));
  const codes = codesBefore(lines[idx + 1], 'develop');
  assert.ok(codes.includes(CYAN), '워크트리 점유 표시(cyan)가 우선한다');
  assert.ok(codes.includes('\x1b[1m'), '핀은 bold로 드러난다');
});

test('동명의 리모트 추적 브랜치도 로컬 핀을 따라 pinned 색이 된다', () => {
  resetState({ pinned: ['develop'], remoteBranches: ['origin/develop', 'origin/main'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const flat = plain(lines);
  const originIdx = flat.findIndex(l => /^\s*[-+] origin\s*$/.test(l));
  const devLine = lines[flat.findIndex((l, i) => i > originIdx && /^\s+develop\s*$/.test(l))];
  const mainLine = lines[flat.findIndex((l, i) => i > originIdx && /^\s+main\s*$/.test(l))];
  assert.ok(codesBefore(devLine, 'develop').includes(PINNED), '핀 걸린 origin/develop은 pinned 색');
  assert.ok(codesBefore(mainLine, 'main').includes(RED), '핀 없는 origin/main은 red 유지');
});

test('슬래시가 들어간 브랜치도 리모트 짝을 찾아 하이라이트한다', () => {
  resetState({ pinned: ['feature/login'], remoteBranches: ['origin/feature/login'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const flat = plain(lines);
  const originIdx = flat.findIndex(l => /^\s*[-+] origin\s*$/.test(l));
  const loginLine = lines[flat.findIndex((l, i) => i > originIdx && /^\s+login\s*$/.test(l))];
  assert.ok(codesBefore(loginLine, 'login').includes(PINNED));
});

test('로컬 짝이 없는 리모트 브랜치는 red를 유지한다', () => {
  resetState({ pinned: ['develop'], remoteBranches: ['origin/hotfix'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const flat = plain(lines);
  const originIdx = flat.findIndex(l => /^\s*[-+] origin\s*$/.test(l));
  const line = lines[flat.findIndex((l, i) => i > originIdx && /^\s+hotfix\s*$/.test(l))];
  assert.ok(codesBefore(line, 'hotfix').includes(RED));
});

test('history decoration에서도 핀 고정 브랜치를 pinned 색으로 칠한다', () => {
  resetState({ pinned: ['develop'] });
  const out = colorizeDecoration('develop, feature/login', 'main', false);
  assert.ok(codesBefore(out, 'develop').includes(PINNED));
  assert.ok(codesBefore(out, 'feature/login').includes(CYAN), '핀이 아닌 로컬은 cyan 유지');
});

test('history에서 현재 브랜치는 핀을 걸어도 green을 유지한다', () => {
  resetState({ pinned: ['main'] });
  const out = colorizeDecoration('main', 'main', true);
  assert.ok(codesBefore(out, 'main').includes(GREEN));
});

test('history에서 로컬 짝이 다른 커밋에 있는 리모트 브랜치도 핀을 따라간다', () => {
  resetState({ pinned: ['develop'] });
  const out = colorizeDecoration('origin/develop, origin/hotfix', 'main', false);
  assert.ok(codesBefore(out, 'origin/develop').includes(PINNED));
  assert.ok(codesBefore(out, 'origin/hotfix').includes(RED), '핀 없는 리모트는 red 유지');
});

test('history에서 축약된 @origin 접미도 로컬 핀 색을 따른다', () => {
  resetState({ pinned: ['develop'] });
  const out = colorizeDecoration('develop, origin/develop', 'main', false);
  assert.equal(out.replace(/\x1b\[[0-9;]*m/g, ''), 'develop@origin');
  assert.ok(codesBefore(out, '@origin').includes(PINNED));
});

test('핀이 없으면 @origin 접미는 red를 유지한다', () => {
  resetState({ pinned: [] });
  const out = colorizeDecoration('develop, origin/develop', 'main', false);
  assert.ok(codesBefore(out, '@origin').includes(RED));
});

// ── 핀 목록 유지 ──

test('토글은 지정/해제를 오간다', () => {
  ui.pinnedBranches = [];
  assert.equal(togglePinnedBranch('develop'), true);
  assert.equal(isPinnedBranch('develop'), true);
  assert.equal(togglePinnedBranch('develop'), false);
  assert.equal(isPinnedBranch('develop'), false);
});

test('새 핀은 목록 끝에 붙는다', () => {
  ui.pinnedBranches = ['a'];
  togglePinnedBranch('b');
  assert.deepEqual(ui.pinnedBranches, ['a', 'b']);
});

test('브랜치를 리네임하면 핀도 새 이름으로 따라간다', () => {
  ui.pinnedBranches = ['a', 'old', 'b'];
  renamePinnedBranch('old', 'new');
  assert.deepEqual(ui.pinnedBranches, ['a', 'new', 'b']);
});

test('리네임 대상 이름이 이미 핀에 있으면 중복을 만들지 않는다', () => {
  ui.pinnedBranches = ['old', 'new'];
  renamePinnedBranch('old', 'new');
  assert.deepEqual(ui.pinnedBranches, ['new']);
});

test('핀이 없는 브랜치의 리네임은 목록을 건드리지 않는다', () => {
  ui.pinnedBranches = ['a'];
  renamePinnedBranch('other', 'renamed');
  assert.deepEqual(ui.pinnedBranches, ['a']);
});

test('브랜치를 지우면 핀도 없어진다', () => {
  ui.pinnedBranches = ['a', 'b'];
  unpinBranch('a');
  assert.deepEqual(ui.pinnedBranches, ['b']);
});
