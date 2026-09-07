// 스크롤바를 호스트에 넘기는 계약 검증 (API 1.10 — scrollbar / scrollbar_gutter).
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
const test = require('node:test');
const assert = require('node:assert/strict');

// 등록 요청을 모으고, 응답의 scrollbar_cols 를 시험마다 바꿔 끼운다.
const regions = [];
let scrollbarCols = 1;   // 1 = 호스트가 그린다, undefined = 구버전 호스트

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

test('등록에 스크롤바 계약을 실어 보내고, 호스트가 맡으면 sixel 을 그리지 않는다', async () => {
  scrollbarCols = 1;
  setup();
  captureRender();

  const first = leftRegions()[0];
  assert.ok(first, '좌패널 region 이 등록돼야 한다');
  assert.equal(first.scrollbar, 'auto');
  assert.equal(first.scrollbar_gutter, 'stable');
  // 글자 폭(content_cols)은 그대로 두고 region 폭에만 스크롤바 한 칸을 얹는다.
  assert.equal(first.width, first.content_cols + 1,
    '스크롤바 칸을 region 에 넣지 않으면 호스트가 그릴 자리가 없다');

  await settle();
  assert.equal(hostScroll.hasHostScrollbar('left'), true);

  captureRender();
  assert.equal(leftBar(), undefined, '호스트가 그리는데 sixel 까지 그리면 두 개가 겹친다');
  // 오버레이가 없으면 드래그 존도 없다 — 둘 다 이 목록에서 나온다.
  assert.ok(!ui.scrollbarOverlays.some(sb => sb.target === 'left'));
});
