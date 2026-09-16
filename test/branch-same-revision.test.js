// 현재 브랜치와 같은 리비전에 놓인 로컬 브랜치 표기 검증.
// 핀 고정 브랜치로 리베이스하면 두 브랜치가 같은 커밋에 서게 되는데, 이름만 봐서는
// 그걸 알 수 없다. 체크아웃 표시(굵은 ✓)와 같은 열에 흐린 ✓ 를 두어 한 단계 약하게 알린다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel } = require('../render');

const PANEL_W = 40;
const PANEL_H = 60;
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const PINNED = '\x1b[95m';
const CYAN = '\x1b[36m';
const VALUE = '\x1b[39m';   // colors.value — 기본 전경색
const RED = '\x1b[31m';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';

function plain(lines) {
  return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

// 기본 배치: main(현재) 과 hotfix 가 같은 커밋 H1, develop 만 다른 커밋 H2.
function resetState({ branches, pinned = [], remoteBranches = [], worktrees, hidden = [] } = {}) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = 'main';
  state.branches = branches || [
    { name: 'main', isCurrent: true, hash: H1 },
    { name: 'hotfix', isCurrent: false, hash: H1 },
    { name: 'develop', isCurrent: false, hash: H2 },
  ];
  state.remoteBranches = remoteBranches;
  state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = worktrees || [{ path: 'C:/repo', branch: state.branch, isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false }];
  state.isLinkedWorktree = false;
  state.ahead = 0;
  state.behind = 0;
  ui.pinnedBranches = pinned.slice();
  ui.filteredRefs = [];
  ui.hiddenRefs = hidden.slice();
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

// 이름 앞에 적용된 SGR 코드들
function codesBefore(line, name) {
  const idx = line.indexOf(name);
  assert.ok(idx > 0, name + '이(가) 줄에 있어야 한다: [' + line + ']');
  return line.substring(0, idx).match(/\x1b\[[0-9;]*m/g) || [];
}

function sectionIdx(flat, title) {
  return flat.findIndex(l => new RegExp('^\\s*[-+] ' + title + '\\s*$').test(l));
}

// Branches 섹션의 줄만 — 상단 브랜치명 줄이나 Remotes 쪽과 섞이지 않게 한다.
function branchesLines(w = PANEL_W) {
  const lines = buildLeftPanel(w, PANEL_H);
  const flat = plain(lines);
  const start = sectionIdx(flat, 'Branches');
  assert.ok(start >= 0, 'Branches 섹션이 있어야 한다');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*[-+] \S/.test(flat[i]) && !/^\s+[-+] /.test(flat[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function lineWith(lines, re) {
  const flat = plain(lines);
  const i = flat.findIndex(l => re.test(l));
  assert.ok(i >= 0, '해당 줄을 못 찾음(' + re + '): ' + flat.join(' / '));
  return { raw: lines[i], text: flat[i], idx: i };
}

// ── 마커 ──

test('현재 브랜치와 같은 커밋의 로컬 브랜치에 ✓를 붙인다', () => {
  resetState();
  assert.match(lineWith(branchesLines(), /hotfix/).text, /✓ hotfix/);
});

test('커밋이 다른 브랜치에는 붙이지 않는다', () => {
  resetState();
  assert.equal(lineWith(branchesLines(), /develop/).text.trim(), 'develop');
});

test('같은 커밋 마커는 그 줄의 이름 색을 그대로 쓴다 — 초록·bold 는 체크아웃한 브랜치만', () => {
  resetState();
  const lines = branchesLines();
  const same = codesBefore(lineWith(lines, /✓ hotfix/).raw, '✓');
  assert.ok(same.includes(VALUE), '이름이 기본색인 줄이면 마커도 기본색: ' + same.join(''));
  assert.ok(!same.includes(DIM), '흐리게 하면 마커가 안 보인다');
  assert.ok(!same.includes(GREEN), '초록은 체크아웃한 브랜치에만 쓴다');
  assert.ok(!same.includes(BOLD), '굵게 하지 않는다');

  const cur = codesBefore(lineWith(lines, /✓ main/).raw, '✓');
  assert.ok(cur.includes(GREEN) && cur.includes(BOLD), '체크아웃한 브랜치는 green + bold');
  assert.ok(!cur.includes(DIM), '체크아웃한 브랜치는 흐리지 않다');
});

test('마커가 붙어도 이름은 체크아웃한 브랜치와 같은 열에서 시작한다', () => {
  resetState();
  const flat = plain(branchesLines());
  const nameCol = (re) => {
    const line = flat.find(l => re.test(l));
    assert.ok(line, '줄을 못 찾음: ' + re);
    return line.indexOf(line.trim().replace(/^✓ /, ''));
  };
  assert.equal(nameCol(/✓ hotfix/), nameCol(/✓ main/), '마커 줄끼리 이름 열이 같아야 한다');
  assert.equal(nameCol(/✓ main/), nameCol(/develop/), '마커 없는 줄과도 이름 열이 같아야 한다');
});

// ── 이름 색은 건드리지 않는다 ──
//
// 핀·워크트리 점유는 "이 줄이 무엇인가"를 말하는 더 강한 제약이다. 같은 리비전 표시가
// 그 색을 덮어쓰면 정보가 사라지므로, 마커만 얹고 이름 색은 원래 규칙 그대로 둔다.

test('핀 고정 브랜치가 같은 커밋이면 마커만 붙고 이름은 핀 색을 유지한다', () => {
  resetState({ pinned: ['hotfix'] });
  const { raw } = lineWith(branchesLines(), /✓ hotfix/);
  assert.ok(codesBefore(raw, 'hotfix').includes(PINNED), '이름은 pinned 색');
  assert.ok(codesBefore(raw, '✓').includes(PINNED), '마커도 이름과 같은 핀 색');
  assert.ok(!codesBefore(raw, '✓').includes(DIM), '마커를 흐리게 묻어 두지 않는다');
});

test('다른 워크트리가 점유한 브랜치가 같은 커밋이어도 이름은 cyan을 유지한다', () => {
  resetState({
    worktrees: [
      { path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false },
      { path: 'C:/repo-fix', branch: 'hotfix', isMain: false, isCurrent: false, isDetached: false, isBare: false, isLocked: false, isPrunable: false },
    ],
  });
  const { raw } = lineWith(branchesLines(), /✓ hotfix/);
  assert.ok(codesBefore(raw, 'hotfix').includes(CYAN));
  assert.ok(codesBefore(raw, '✓').includes(CYAN), '마커도 같은 cyan — 한 줄 안에서 색이 갈리지 않는다');
});

test('감춘 브랜치는 이름이 dim 이므로 마커도 같이 dim 이 된다', () => {
  resetState({ hidden: ['refs/heads/hotfix'] });
  const codes = codesBefore(lineWith(branchesLines(), /✓ hotfix/).raw, '✓');
  assert.ok(codes.includes(DIM), '이름 색(dim)을 그대로 따른다');
  assert.ok(!codes.includes(GREEN), '감춘 줄에서 마커만 튀지 않는다');
});

// ── 적용 범위 ──

test('리모트 추적 브랜치에는 붙이지 않는다', () => {
  resetState({ remoteBranches: ['origin/hotfix'] });
  const lines = buildLeftPanel(PANEL_W, PANEL_H);
  const flat = plain(lines);
  const originIdx = sectionIdx(flat, 'origin');
  assert.ok(originIdx >= 0, 'origin 섹션이 있어야 한다');
  const i = flat.findIndex((l, idx) => idx > originIdx && /hotfix/.test(l));
  assert.ok(i >= 0, '리모트 줄이 있어야 한다');
  assert.ok(!flat[i].includes('✓'), '리모트 줄에는 마커가 없다: [' + flat[i] + ']');
  assert.ok(codesBefore(lines[i], 'hotfix').includes(RED), '리모트 색은 그대로');
});

test('detached HEAD면 아무 줄에도 붙지 않는다', () => {
  resetState({
    branches: [
      { name: 'main', isCurrent: false, hash: H1 },
      { name: 'hotfix', isCurrent: false, hash: H1 },
    ],
  });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.ok(!flat.some(l => l.includes('✓')), '✓ 가 없어야 한다: ' + flat.join(' / '));
});

test('해시를 못 받은 경우에도 마커 없이 그린다', () => {
  resetState({
    branches: [
      { name: 'main', isCurrent: true },
      { name: 'hotfix', isCurrent: false },
    ],
  });
  const flat = plain(branchesLines());
  assert.ok(flat.some(l => /✓ main/.test(l)), '현재 브랜치 표시는 남는다');
  assert.ok(!flat.some(l => /✓ hotfix/.test(l)), '해시가 없으면 같은 리비전 판정을 하지 않는다');
});

// ── 목록 전반 ──

test('Pinned 섹션과 Branches 트리 양쪽에 같은 마커가 붙는다', () => {
  resetState({ pinned: ['hotfix'] });
  const flat = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(flat.filter(l => /✓ hotfix/.test(l)).length, 2, 'Pinned + Branches 두 줄: ' + flat.join(' / '));
});

test('그룹(release/) 안의 브랜치에도 붙고 이름 열이 어긋나지 않는다', () => {
  resetState({
    branches: [
      { name: 'main', isCurrent: true, hash: H1 },
      { name: 'release/1.2', isCurrent: false, hash: H1 },
      { name: 'release/1.1', isCurrent: false, hash: H2 },
    ],
  });
  const flat = plain(branchesLines());
  const same = flat.find(l => /1\.2/.test(l));
  const other = flat.find(l => /1\.1/.test(l));
  assert.match(same, /✓ 1\.2/);
  assert.equal(other.trim(), '1.1', '다른 커밋의 그룹 항목은 이름만');
  assert.equal(same.indexOf('1.2'), other.indexOf('1.1'), '그룹 안에서도 이름 열이 같아야 한다');
});

test('마커가 붙어도 줄이 패널 폭을 넘지 않는다', () => {
  resetState({
    branches: [
      { name: 'main', isCurrent: true, hash: H1 },
      { name: 'a-very-long-branch-name-that-overflows', isCurrent: false, hash: H1 },
    ],
    pinned: ['a-very-long-branch-name-that-overflows'],
    remoteBranches: ['origin/a-very-long-branch-name-that-overflows'],
  });
  for (const narrow of [16, 20, 28, PANEL_W]) {
    for (const line of plain(buildLeftPanel(narrow, PANEL_H))) {
      assert.ok(line.length <= narrow - 1, 'w=' + narrow + ' 줄이 폭을 넘음: [' + line + ']');
    }
  }
});
