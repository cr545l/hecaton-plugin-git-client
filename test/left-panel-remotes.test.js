// Remotes 섹션 검증 — 원격 브랜치가 아직 없는 리모트(막 추가했거나 fetch/push 전)도
// 목록에 보여야 한다. 원격 브랜치로만 묶으면 리모트가 통째로 사라지고 우클릭할 자리도 없다.
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

// Remotes 섹션 아래 줄들 (다음 섹션 머리 전까지)
function remotesSection(lines) {
  const flat = plain(lines);
  const start = flat.findIndex(l => /^\s*[-+] Remotes/.test(l));
  assert.ok(start >= 0, 'Remotes 섹션이 있어야 한다');
  const rows = [];
  for (let i = start + 1; i < flat.length; i++) {
    if (/^\s*[-+] (Worktrees|Stashes|Tags)/.test(flat[i])) break;
    if (flat[i].trim()) rows.push(flat[i].trim());
  }
  return rows;
}

function resetState({ remotes, remoteBranches }) {
  state.loading = false;
  state.isGitRepo = true;
  state.gitNotFound = false;
  state.operationState = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true }];
  state.remotes = remotes;
  state.remoteBranches = remoteBranches;
  state.stashes = [];
  state.worktrees = [];
  ui.collapsedSections = {};
  ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0;
  ui.leftPanelActiveBranch = null;
  ui.hoveredLeftPanelRow = -1;
  ui.hostScrollRegions = [];
}

test('원격 브랜치가 없는 리모트도 Remotes 에 표시된다', () => {
  resetState({ remotes: ['origin'], remoteBranches: [] });
  const rows = remotesSection(buildLeftPanel(PANEL_W, PANEL_H));
  assert.ok(rows.some(r => /origin$/.test(r)), 'origin 이 보여야 한다: ' + JSON.stringify(rows));
});

test('브랜치 있는 리모트와 없는 리모트가 함께 정렬되어 표시된다', () => {
  resetState({ remotes: ['upstream', 'origin'], remoteBranches: ['origin/main'] });
  const rows = remotesSection(buildLeftPanel(PANEL_W, PANEL_H));
  const originIdx = rows.findIndex(r => /origin$/.test(r));
  const upstreamIdx = rows.findIndex(r => /upstream$/.test(r));
  assert.ok(originIdx >= 0 && upstreamIdx > originIdx, JSON.stringify(rows));
  assert.ok(rows.slice(originIdx + 1, upstreamIdx).some(r => /main$/.test(r)), 'origin/main 이 origin 아래에 있어야 한다');
});

test('빈 리모트 줄은 우클릭 대상(r:<이름> 그룹)으로 잡힌다', () => {
  resetState({ remotes: ['origin'], remoteBranches: [] });
  buildLeftPanel(PANEL_W, PANEL_H);
  // input.js 의 우클릭 처리는 이 그룹 키에서 리모트 이름을 꺼낸다.
  const entries = ui.leftPanelFullClickMap || [];
  assert.ok(entries.some(e => e && e.action === 'toggle-group' && e.group === 'r:origin'));
});
