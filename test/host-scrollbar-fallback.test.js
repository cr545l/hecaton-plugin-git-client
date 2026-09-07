// 스크롤바 계약의 폴백 쪽 — 응답에 scrollbar_cols 에코가 없는 구버전 호스트.
//
// 호스트가 그리는 스크롤바는 관성과 같은 프레임에 픽셀 단위로 움직이므로 플러그인이
// sixel 로 따라 그리는 것보다 언제나 부드럽고, 드래그·hover 도 호스트가 맡는다.
// 지원 여부는 등록 응답의 scrollbar_cols 에코로만 알 수 있어서 이렇게 간다:
//
//   모름   → 스크롤바 한 칸(gutter)을 region 폭에 얹고 물어본다
//   지원   → 그 영역의 sixel 스크롤바를 그리지 않는다 (드래그 존도 함께 사라진다)
//   미지원 → gutter 를 도로 뺀 폭으로 재등록한다. 그 칸이 region 밖이라야 sixel
//            스크롤바가 스크롤에 딸려 올라가지 않는다(sixel 은 셀이 아니라 픽셀이다).
//
// 재등록이 한 번으로 끝나는 것(무한 루프가 아닌 것)까지 함께 본다.
//
// 지원 쪽은 host-scrollbar.test.js 에 있다 — 판정이 모듈 수준 캐시라 한 프로세스
// 안에서 지원/미지원을 번갈아 시험할 수 없어 파일을 나눴다.
const test = require('node:test');
const assert = require('node:assert/strict');

// 등록 요청을 모으고, 응답의 scrollbar_cols 를 시험마다 바꿔 끼운다.
const regions = [];
const scrollbarCols = undefined;   // 응답에 에코 없음 = 구버전 호스트

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  scroll: {
    region: (p) => {
      regions.push(p);
      const res = { ok: true };
      if (scrollbarCols !== undefined) res.scrollbar_cols = scrollbarCols;
      return Promise.resolve(res);
    },
    set: () => Promise.resolve({}),
    remove: () => Promise.resolve({}),
  },
};

const { state, ui } = require('../state');
const { render } = require('../render');
const hostScroll = require('../scroll');

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const frame = [];
  process.stdout.write = (s) => { frame.push(String(s)); return true; };
  try { render(); } finally { process.stdout.write = _origWrite; }
  return frame.join('');
}

// 등록 응답은 Promise 라 마이크로태스크 한 바퀴 뒤에 반영된다.
const settle = () => new Promise(r => setImmediate(r));

function setup() {
  regions.length = 0;
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.mode = 'normal'; state.spinnerActive = false;
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.cwd = 'C:/repo'; state.branch = 'main';
  // 좌패널이 넘치도록 브랜치를 넉넉히 — 스크롤바가 나오는 조건을 만든다.
  state.branches = [{ name: 'main', isCurrent: true }];
  for (let i = 0; i < 60; i++) state.branches.push({ name: 'feature/b' + i });
  state.remoteBranches = []; state.remotes = []; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set(); state.rightView = 'diff';
  state.logItems = []; state.logSelectables = []; state.diffView = 'unified';
  ui.termCols = 120; ui.termRows = 30; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.pinnedBranches = [];
  ui.leftPanelCollapsed = false; ui.middlePanelCollapsed = false;
  ui.rightPanelCollapsed = false; ui.fileTreeView = false;
  ui.leftPanelScrollOffset = 0; ui.leftPanelActiveBranch = null;
  ui.branchDragSource = null; ui.branchDropTarget = null; ui.branchDragCursor = null;
}

const leftRegions = () => regions.filter(r => r.id === 'left');
const leftBar = () => ui.scrollbarOverlays.find(sb => sb.target === 'left');

test('구버전 호스트면 gutter 를 도로 빼고 재등록해 sixel 로 돌아간다', async () => {
  setup();
  captureRender();

  const probe = leftRegions()[0];
  assert.equal(probe.width, probe.content_cols + 1, '모를 때는 일단 얹고 물어본다');

  await settle();
  assert.equal(hostScroll.hasHostScrollbar('left'), false);

  // 미지원이 확인됐으니 gutter 를 뺀 폭으로 다시 등록된다.
  captureRender();
  await settle();
  const reprobe = leftRegions().at(-1);
  assert.equal(reprobe.width, reprobe.content_cols,
    'gutter 가 region 안에 남으면 sixel 스크롤바가 스크롤에 딸려 올라간다');

  // 그리고 스크롤바는 예전처럼 플러그인이 그린다.
  captureRender();
  assert.ok(leftBar(), '미지원 호스트에서 스크롤바가 사라지면 안 된다');

  // 폭이 안정됐으므로 더는 재등록되지 않는다 — 여기서 계속 돌면 매 프레임 RPC 가 나간다.
  const before = leftRegions().length;
  captureRender();
  await settle();
  captureRender();
  await settle();
  assert.equal(leftRegions().length, before, '재등록은 한 번으로 끝나야 한다');
});
