// Status(왼쪽) 패널의 worktree 표기 검증 — 브랜치명 옆 태그와 Worktrees 루트 노드.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state, ui } = require('../state');
const { buildLeftPanel } = require('../render');

const PANEL_W = 40;
const PANEL_H = 60;

function plain(lines) {
  return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const CYAN = '\x1b[36m';   // colors.cyan — [worktree] 표기와 워크트리 점유 브랜치에 공통으로 쓰는 색
const GREEN = '\x1b[32m';  // colors.green — 현재 브랜치

// raw 줄에서 name이 CYAN으로 칠해졌는지 확인 (name 직전의 마지막 SGR이 CYAN인가)
function isColored(rawLine, name, color) {
  const idx = rawLine.indexOf(name);
  if (idx < 0) return false;
  const before = rawLine.substring(0, idx);
  const codes = before.match(/\x1b\[[0-9;]*m/g);
  return !!codes && codes[codes.length - 1] === color;
}

// Branches 섹션 안에서 해당 브랜치의 raw 줄 찾기.
// 상단 브랜치명 줄이나 Worktrees 하위 줄(브랜치명을 detail로 포함)과 섞이지 않게
// 섹션 범위를 좁히고, 줄 전체가 브랜치명(+선택적 [worktree] 표기)인 것만 고른다.
function branchRow(rawLines, name) {
  const flat = plain(rawLines);
  const start = flat.findIndex(l => /^\s*[-+] Branches/.test(l));
  if (start < 0) return undefined;
  let end = flat.length;
  for (let i = start + 1; i < flat.length; i++) {
    if (/^\s*[-+] (Remotes|Worktrees|Stashes)/.test(flat[i])) { end = i; break; }
  }
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^\\s*(✓ )?' + esc + '( \\[worktree\\])?\\s*$');
  for (let i = start + 1; i < end; i++) {
    if (re.test(flat[i])) return rawLines[i];
  }
  return undefined;
}

function resetState({ branch, branches, worktrees, isLinkedWorktree }) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = branch;
  state.branches = branches;
  state.remoteBranches = [];
  state.stashes = [];
  state.worktrees = worktrees;
  state.isLinkedWorktree = !!isLinkedWorktree;
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

const MAIN_WT = { path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true, isDetached: false, isBare: false, isLocked: false, isPrunable: false };
const FEATURE_WT = { path: 'C:/wt-feature', branch: 'feature/login', isMain: false, isCurrent: false, isDetached: false, isBare: false, isLocked: false, isPrunable: false };
const HOTFIX_WT = { path: 'C:/wt-hotfix', branch: 'hotfix', isMain: false, isCurrent: false, isDetached: false, isBare: false, isLocked: false, isPrunable: false };

test('워크트리가 없으면 Worktrees 루트 노드를 출력하지 않는다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [MAIN_WT],
  });

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(out.some(l => l.includes('Worktrees')), false);
});

test('워크트리가 있으면 Worktrees 루트 노드와 하위 항목을 출력한다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }, { name: 'hotfix', isCurrent: false }],
    worktrees: [MAIN_WT, FEATURE_WT, HOTFIX_WT],
  });

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const headerIdx = out.findIndex(l => l.includes('Worktrees'));
  assert.ok(headerIdx >= 0, 'Worktrees 루트 노드가 있어야 한다');
  assert.match(out[headerIdx], /Worktrees \(3\)/);
  // 하위 노드: 각 워크트리 디렉터리 이름
  const body = out.slice(headerIdx).join('\n');
  assert.match(body, /repo/);
  assert.match(body, /wt-feature/);
  assert.match(body, /wt-hotfix/);
  // 메인 워크트리만 (main) 역할 표기가 붙고, linked worktree에는 붙지 않는다
  assert.match(body, /repo \(main\)/);
  assert.equal(/wt-feature \(main\)/.test(body), false);
  assert.equal(/wt-hotfix \(main\)/.test(body), false);
});

test('워크트리 절대경로는 출력하지 않는다 (디렉터리 이름만 표시)', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [MAIN_WT, FEATURE_WT, HOTFIX_WT],
  });

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const body = out.join('\n');
  // 이름은 남고
  assert.match(body, /wt-feature/);
  // 절대경로 형태는 어디에도 없어야 한다
  assert.equal(body.includes('C:/wt-feature'), false);
  assert.equal(body.includes('C:/wt-hotfix'), false);
  assert.equal(body.includes('C:/repo'), false);
  assert.equal(/[A-Za-z]:\//.test(body), false, '절대경로 패턴이 남아 있음');

  // 워크트리 하나당 한 줄만 차지한다 (헤더 1 + 워크트리 3)
  const headerIdx = out.findIndex(l => l.includes('Worktrees'));
  const rows = out.slice(headerIdx).filter(l => l.trim() !== '');
  assert.equal(rows.length, 4);
});

test('경로를 표시하지 않아도 클릭 맵에는 워크트리 경로가 남는다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [MAIN_WT, FEATURE_WT],
  });

  buildLeftPanel(PANEL_W, PANEL_H);
  const wtEntries = ui.leftPanelClickMap.filter(e => e && e.action === 'goto-worktree');
  // 컨텍스트 메뉴(Copy Path / Show in Explorer)가 경로를 쓰므로 반드시 보존돼야 한다
  assert.equal(wtEntries.length, 2);
  assert.deepEqual(wtEntries.map(e => e.path), ['C:/repo', 'C:/wt-feature']);
});

test('Worktrees 루트 노드를 접으면 하위 항목이 사라진다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [MAIN_WT, FEATURE_WT],
  });
  ui.collapsedSections.worktrees = true;

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const headerIdx = out.findIndex(l => l.includes('Worktrees'));
  assert.ok(headerIdx >= 0);
  assert.match(out[headerIdx], /\+ Worktrees/);
  assert.equal(out.slice(headerIdx).some(l => l.includes('wt-feature')), false);
});

test('다른 워크트리가 점유한 브랜치는 태그 없이 색으로만 구분한다', () => {
  resetState({
    branch: 'main',
    branches: [
      { name: 'main', isCurrent: true },
      { name: 'hotfix', isCurrent: false },
      { name: 'develop', isCurrent: false },
      { name: 'feature/login', isCurrent: false },
    ],
    worktrees: [MAIN_WT, FEATURE_WT, HOTFIX_WT],
  });

  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  const out = plain(raw);

  // 태그 문자열은 완전히 사라졌다
  assert.equal(out.some(l => l.includes('[wt')), false, '[wt...] 태그가 남아 있음');

  // 워크트리가 점유한 브랜치는 cyan
  const hotfixRow = branchRow(raw, 'hotfix');
  assert.ok(hotfixRow, 'hotfix 줄이 있어야 한다');
  assert.ok(isColored(hotfixRow, 'hotfix', CYAN), 'hotfix가 cyan이어야 한다');

  const loginRow = branchRow(raw, 'login');
  assert.ok(loginRow, 'feature/login 줄이 있어야 한다');
  assert.ok(isColored(loginRow, 'login', CYAN), 'login이 cyan이어야 한다');

  // 점유되지 않은 브랜치는 기본색 그대로
  const developRow = branchRow(raw, 'develop');
  assert.ok(developRow);
  assert.equal(isColored(developRow, 'develop', CYAN), false, 'develop은 cyan이면 안 된다');
});

test('현재 브랜치는 워크트리 색이 아니라 초록색 유지 (이미 ✓로 구분됨)', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }, { name: 'hotfix', isCurrent: false }],
    worktrees: [MAIN_WT, HOTFIX_WT],
  });

  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  const mainRow = raw.find(l => l.includes('✓'));
  assert.ok(mainRow, '현재 브랜치 줄이 있어야 한다');
  assert.ok(mainRow.includes(GREEN), '현재 브랜치는 초록색이어야 한다');
  assert.equal(plain([mainRow])[0].includes('[wt'), false);
});

test('linked worktree 저장소면 상단 브랜치명 옆에 [worktree]를 표기한다', () => {
  const currentFeature = { ...FEATURE_WT, isCurrent: true };
  resetState({
    branch: 'feature/login',
    branches: [{ name: 'main', isCurrent: false }, { name: 'feature/login', isCurrent: true }],
    worktrees: [{ ...MAIN_WT, isCurrent: false }, currentFeature],
    isLinkedWorktree: true,
  });

  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  const out = plain(raw);
  assert.match(out[0], /^ login \[worktree\]/);
  // 메인 워크트리가 점유한 main 브랜치는 cyan으로 구분된다
  const mainRow = branchRow(raw, 'main');
  assert.ok(mainRow, 'main 브랜치 줄이 있어야 한다');
  assert.ok(isColored(mainRow, 'main', CYAN), 'main이 cyan이어야 한다');
  // 브랜치 목록의 현재 브랜치(✓)에도 [worktree] 표기가 붙는다
  const currentLine = out.find(l => l.includes('✓'));
  assert.ok(currentLine, '현재 브랜치 줄이 있어야 한다');
  assert.match(currentLine, /✓ login \[worktree\]/);
});

test('메인 저장소면 브랜치 목록의 현재 브랜치에도 [worktree]를 붙이지 않는다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }, { name: 'hotfix', isCurrent: false }],
    worktrees: [MAIN_WT, HOTFIX_WT],
    isLinkedWorktree: false,
  });

  const raw = buildLeftPanel(PANEL_W, PANEL_H);
  const currentLine = plain(raw).find(l => l.includes('✓'));
  assert.ok(currentLine);
  assert.equal(currentLine.includes('[worktree]'), false);
  // 다른 워크트리가 점유한 브랜치의 색 구분은 그대로 유지
  const hotfixRow = branchRow(raw, 'hotfix');
  assert.ok(hotfixRow);
  assert.ok(isColored(hotfixRow, 'hotfix', CYAN));
});

test('중첩 이름(feature/...) 현재 브랜치에도 [worktree]가 붙는다', () => {
  resetState({
    branch: 'feature/login',
    branches: [{ name: 'feature/login', isCurrent: true }, { name: 'feature/signup', isCurrent: false }],
    worktrees: [{ ...MAIN_WT, isCurrent: false }, { ...FEATURE_WT, isCurrent: true }],
    isLinkedWorktree: true,
  });

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const currentLine = out.find(l => l.includes('✓'));
  assert.ok(currentLine, 'feature/ 그룹 안의 현재 브랜치 줄이 있어야 한다');
  assert.match(currentLine, /✓ login \[worktree\]/);
});

test('메인 저장소면 상단 브랜치명에 [worktree]를 붙이지 않는다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [MAIN_WT, FEATURE_WT],
    isLinkedWorktree: false,
  });

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.equal(out[0].includes('[worktree]'), false);
  assert.match(out[0], /^ main\s*$/);
});

test('rebase 진행 중에도 [worktree] 표기와 작업 표기가 함께 보인다', () => {
  resetState({
    branch: 'feature/login',
    branches: [{ name: 'feature/login', isCurrent: true }],
    worktrees: [{ ...MAIN_WT, isCurrent: false }, { ...FEATURE_WT, isCurrent: true }],
    isLinkedWorktree: true,
  });
  state.operationState = { type: 'rebase-merge', step: 2, total: 5 };

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  assert.match(out[0], /\[worktree\]/);
  assert.match(out[0], /rebasing 2\/5/);
});

test('좁은 패널에서도 줄 너비가 넘치지 않고 색 구분은 유지된다', () => {
  resetState({
    branch: 'main',
    branches: [
      { name: 'main', isCurrent: true },
      { name: 'a-very-long-branch-name-that-overflows', isCurrent: false },
    ],
    worktrees: [
      MAIN_WT,
      { ...FEATURE_WT, path: 'C:/an-extremely-long-worktree-directory-name', branch: 'a-very-long-branch-name-that-overflows' },
    ],
  });

  const narrow = 24;
  const rawNarrow = buildLeftPanel(narrow, PANEL_H);
  for (const line of plain(rawNarrow)) {
    assert.ok(line.length <= narrow - 1, `줄이 패널 폭을 넘음: [${line}] (${line.length} > ${narrow - 1})`);
  }
  // 색으로만 구분하므로 폭에 상관없이 태그가 브랜치명을 잡아먹지 않는다
  const longRow = rawNarrow.find(l => l.includes('a-very-long'));
  assert.ok(longRow, '긴 브랜치 줄이 있어야 한다');
  assert.ok(isColored(longRow, 'a-very-long', CYAN), '좁은 폭에서도 cyan 유지');

  // 넓은 폭에서도 동일 — 폭에 따라 표기가 달라지지 않는다
  const rawWide = buildLeftPanel(60, PANEL_H);
  const wideRow = rawWide.find(l => l.includes('a-very-long'));
  assert.ok(isColored(wideRow, 'a-very-long', CYAN));
  assert.equal(plain(rawWide).some(l => l.includes('[wt')), false);
});

test('폴더명이 겹치는 워크트리는 부모 디렉터리까지 붙여 구분한다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [
      MAIN_WT,
      { ...FEATURE_WT, path: 'C:/proj/dirA/shared', branch: 'b1' },
      { ...HOTFIX_WT, path: 'C:/proj/dirB/shared', branch: 'b2' },
    ],
  });

  const out = plain(buildLeftPanel(60, PANEL_H));
  const body = out.join('\n');
  assert.match(body, /dirA\/shared/);
  assert.match(body, /dirB\/shared/);
  // 겹치지 않는 메인 워크트리는 폴더명만 유지 (부모를 붙이지 않는다)
  assert.match(body, /repo \(main\)/);
  assert.equal(/\/repo \(main\)/.test(body), false);
});

test('폴더명이 겹치지 않으면 폴더명만 표시한다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    // 브랜치명에 '/'가 없어야 라벨의 '/'만 검사할 수 있다
    worktrees: [
      MAIN_WT,
      { ...FEATURE_WT, path: 'C:/proj/dirA/alpha', branch: 'b1' },
      { ...HOTFIX_WT, path: 'C:/proj/dirB/beta', branch: 'b2' },
    ],
  });

  const out = plain(buildLeftPanel(60, PANEL_H));
  const headerIdx = out.findIndex(l => l.includes('Worktrees'));
  const rows = out.slice(headerIdx + 1).filter(l => l.trim() !== '');
  assert.equal(rows.length, 3);
  // 라벨(행 앞부분, detail 구분자 '  ' 이전)에 부모 경로가 붙지 않는다
  for (const r of rows) {
    const label = r.replace(/^\s*(✓ )?/, '').split('  ')[0].replace(' (main)', '');
    assert.equal(label.includes('/'), false, `불필요한 부모 경로가 붙음: [${label}]`);
  }
  assert.ok(rows.some(r => r.includes('alpha')));
  assert.ok(rows.some(r => r.includes('beta')));
});

test('detached / locked / prunable 워크트리 상태가 하위 노드에 표시된다', () => {
  resetState({
    branch: 'main',
    branches: [{ name: 'main', isCurrent: true }],
    worktrees: [
      MAIN_WT,
      { path: 'C:/wt-det', branch: '', isMain: false, isCurrent: false, isDetached: true, isBare: false, isLocked: true, isPrunable: true },
    ],
  });

  const out = plain(buildLeftPanel(PANEL_W, PANEL_H));
  const body = out.join('\n');
  assert.match(body, /detached/);
  assert.match(body, /locked/);
  assert.match(body, /prunable/);
});
