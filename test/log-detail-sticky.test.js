// 커밋 상세를 스크롤하는 동안 고정 파일 이름 줄(sticky)이 나타나고 사라져도 스크롤 영역이
// 바뀌지 않는지 검증한다.
//
// 배경(2026-11-18): 고정 줄을 필요할 때만 영역 위에 두었더니 파일 경계를 지날 때마다 영역의 위치와
// 높이가 한 줄씩 바뀌었다. 그때마다 호스트에 영역을 다시 등록하고 scroll.set 으로 위치를 덮어써서
// 내용이 한 줄씩 튀었다(호스트가 그리는 스크롤바는 멀쩡했다). 영역 첫 줄에 겹쳐 그리는 방식도 해 봤지만
// 호스트가 줄을 밀 때 같이 밀려 맨 윗줄이 튀었다(host-scroll-consistency.test.js). 이제 상세가 있으면
// 영역 바로 위 한 줄을 고정 줄 자리로 늘 비워 둔다.
const test = require('node:test');
const assert = require('node:assert/strict');
const handlers = new Map();
const calls = [];
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 140, rows: 40 }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => { calls.push(['region', p.id]); return { scrollbar_cols: 1, scrollbar_rows: 0 }; },
    set: async p => { calls.push(['set', p.id, p.top_row]); return {}; },
    remove: async p => { calls.push(['remove', p.id]); return {}; },
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const scroll = require('../scroll');
const { stripAnsi } = require('../text');
// 그리기는 테스트가 frame() 으로 직접 한다 — 콜백을 넘기면 호스트 확인 응답 때의 그리기가 실제
// stdout 으로 새어 나간다.
scroll.init({});

function fileDiff(name, n) {
  const out = ['diff --git a/' + name + ' b/' + name, '--- a/' + name, '+++ b/' + name, '@@ -1,' + n + ' +1,' + n + ' @@'];
  for (let i = 0; i < n; i++) out.push(' ' + name + ' line ' + i);
  return out;
}
const DETAIL = ['commit 1234567', 'Author: a <a@example.com>  2026-11-18 12:00', '\u2500'.repeat(40),
  'subject', '\u2500'.repeat(40),
  ...fileDiff('src/a.js', 30), ...fileDiff('src/b.js', 3), ...fileDiff('src/c.js', 40), ...fileDiff('src/d.js', 2)];

function setup() {
  state.loading = false; state.isGitRepo = true; state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main'; state.branches = [{ name: 'main', isCurrent: true }];
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = []; state.selectedFiles = new Set();
  state.mode = 'normal'; state.commitMsg = ''; state.refreshing = state.spinnerActive = false; state.error = null;
  state.rightView = 'log'; state.diffWrap = false;
  state.logItems = [{ type: 'commit', hash: '1234567', subject: 'subject', graph: '*', decoration: '' }];
  state.logSelectables = [0]; state.logCursor = 0; state.logScrollOffset = 0;
  state.logDetailLines = DETAIL.slice();
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  ui.termCols = 140; ui.termRows = 40; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
  ui.collapsedDetailFiles = new Set();
}

function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setTimeout(r, 30));

test('파일 경계를 지나며 끝까지 스크롤해도 영역을 다시 등록하거나 위치를 덮어쓰지 않는다', async () => {
  setup();
  frame(); await settle(); frame(); await settle();
  const region = () => ui.hostScrollRegions.find(r => r.id === 'logDetail');
  const first = region();
  assert.ok(first, 'logDetail region');
  const maxTop = first.contentRows - first.height;
  assert.ok(maxTop > 40, '여러 파일 경계를 지날 만큼 길어야 한다');
  calls.length = 0;
  const update = handlers.get('scroll.update');
  let sawSticky = 0;
  for (let top = 1; top <= maxTop; top++) {
    update({ id: 'logDetail', top_row: top, left_col: 0 });
    frame();
    const r = region();
    assert.equal(r.relRow, first.relRow, 'top ' + top + ': 영역 위치가 바뀌었다');
    assert.equal(r.height, first.height, 'top ' + top + ': 영역 높이가 바뀌었다');
    assert.equal(r.off, top, 'top ' + top + ': 호스트가 준 위치를 그대로 그려야 한다');
    if (ui.detailFileHeaderMap[0] && !state.logDetailLines[top].startsWith('diff --git')) sawSticky++;
  }
  await settle();
  assert.deepEqual(calls, [], '순수 스크롤 도중에는 region/set 을 보내지 않는다');
  assert.ok(sawSticky > 0, '파일 안에서는 고정 줄이 보여야 한다');
});

test('고정 줄은 영역 위 자기 자리에 지금 파일을 보이고, 끝까지 내리면 마지막 줄이 보인다', async () => {
  setup();
  frame(); await settle(); frame(); await settle();
  // src/c.js 본문 한가운데로 간다.
  const cHeader = DETAIL.findIndex(l => l === 'diff --git a/src/c.js b/src/c.js');
  // 상세 목록은 diff 머리줄(---, +++)을 걷어 내므로 원본 줄 번호로 바로 가지 않고 화면으로 확인한다.
  state.diffScrollOffset = cHeader;
  let out = stripAnsi(frame());
  const r = ui.hostScrollRegions.find(x => x.id === 'logDetail');
  state.diffScrollOffset = r.off + 5;
  out = stripAnsi(frame());
  assert.equal(ui.detailFileHeaderMap[0], 'src/c.js', '첫 줄은 지금 파일의 고정 줄이다');
  assert.ok(out.includes('- src/c.js'), '고정 줄이 그려진다');
  state.diffScrollOffset = 1e9;
  out = stripAnsi(frame());
  assert.ok(out.includes('src/d.js line 1'), '끝까지 내리면 마지막 줄이 보여야 한다');
});

// 2026-11-19 창 기록: 고정 줄 자리를 파일이 있는 커밋에만 비워 두었더니, 커밋을 고를 때마다 패치가
// 오기 전(헤더만 있을 때)에는 자리가 없어 상세가 한 줄 올라갔다가 패치가 오면 내려왔다.
test('패치가 오기 전·온 뒤·파일 없는 커밋 모두 상세 영역 위치가 같다', async () => {
  setup();
  const rowOf = () => {
    frame();
    const r = ui.hostScrollRegions.find(x => x.id === 'logDetail');
    return r ? r.relRow : null;
  };
  state.logDetailLines = DETAIL.slice(0, 3);           // 헤더만(패치 읽는 중)
  const headerOnly = rowOf();
  state.logDetailLines = DETAIL.slice();               // 패치까지
  const full = rowOf();
  state.logDetailLines = DETAIL.slice(0, 5);           // 파일 없는 커밋(빈 병합 등)
  const noFiles = rowOf();
  await settle();
  assert.ok(full !== null, 'logDetail region');
  assert.equal(headerOnly, full, '헤더만 있을 때도 같은 자리여야 한다');
  assert.equal(noFiles, full, '파일 없는 커밋도 같은 자리여야 한다');
});
