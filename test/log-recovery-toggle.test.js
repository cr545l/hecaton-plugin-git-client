// 히스토리 헤더의 Recovery 토글 검증.
//
// 유실(reflog 전용) 커밋은 amend/rebase 를 많이 한 저장소에서 살아있는 커밋 수만큼
// 붙어 목록과 그래프를 채운다. Sort 오른쪽 토글로 통째로 감출 수 있어야 하고, 끌 때는
// 그리기 단계에서만 걸러 다시 켤 때 git 재조회 없이 되살아나야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
  on: () => {},
  scroll: {
    region: () => Promise.resolve({ ok: true }),
    set: () => Promise.resolve({}),
    remove: () => Promise.resolve({}),
  },
};

const { state, ui } = require('../state');
const { render } = require('../render');
const { buildLogGraphRows } = require('../refresh');
const { stripAnsi } = require('../text');

const TERM_ROWS = 40;
const H = n => String(n).padStart(40, '0');

// 살아있는 사슬 M1→M2→M3 에, M2 에서 갈라진 유실 사슬 L1→L2 가 붙은 그래프.
function sampleCommits() {
  return [
    { hash: H(1), parents: [H(2)], subject: 'live 1' },
    { hash: H(10), parents: [H(11)], subject: 'lost 1', isRecovery: true },
    { hash: H(11), parents: [H(2)], subject: 'lost 2', isRecovery: true },
    { hash: H(2), parents: [H(3)], subject: 'live 2' },
    { hash: H(3), parents: [], subject: 'live 3' },
  ];
}

function buildWith(showRecovery, commits) {
  ui.logSortMode = 'date';
  ui.logShowRecovery = showRecovery;
  ui.stashMap = new Map();
  return buildLogGraphRows(commits || sampleCommits(), new Set());
}

test('기본값은 보이기다', () => {
  const { ui: freshUi } = require('../state');
  assert.equal(typeof freshUi.logShowRecovery, 'boolean');
});

test('토글을 끄면 유실 커밋이 목록에서 빠진다', () => {
  const shown = buildWith(true);
  assert.equal(shown.length, 5);
  assert.equal(shown.filter(r => r.isRecovery).length, 2);

  const hidden = buildWith(false);
  assert.equal(hidden.length, 3);
  assert.ok(!hidden.some(r => r.isRecovery), '유실 커밋이 남아 있으면 안 된다');
  assert.deepEqual(hidden.map(r => r.subject), ['live 1', 'live 2', 'live 3']);
});

test('감춘 그래프는 애초에 유실 커밋이 없던 그래프와 같다', () => {
  const hidden = buildWith(false);
  const liveOnly = buildWith(true, sampleCommits().filter(c => !c.isRecovery));
  assert.deepEqual(
    hidden.map(r => r.chars.join('').trimEnd()),
    liveOnly.map(r => r.chars.join('').trimEnd()),
    '유실 커밋을 감춰도 살아있는 커밋의 레인은 그대로여야 한다',
  );
});

test('다시 켜면 같은 입력에서 유실 커밋이 되살아난다', () => {
  const commits = sampleCommits();
  buildWith(false, commits);
  const back = buildWith(true, commits);
  assert.equal(back.filter(r => r.isRecovery).length, 2, '감추기가 원본 목록을 갉아먹으면 안 된다');
});

const _origWrite = process.stdout.write.bind(process.stdout);
function captureRender() {
  const frame = [];
  process.stdout.write = (s) => { frame.push(String(s)); return true; };
  try {
    render();
  } finally {
    process.stdout.write = _origWrite;
  }
  return frame.join('');
}

function setupLogView() {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.operationState = null; state.minimized = false; state.error = null;
  state.conflictView = null; state.mode = 'normal';
  state.refreshing = false; state.logLoading = false; state.logLoadingMore = false;
  state.freshTimeWindowMode = false;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin'];
  state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = []; state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'log';
  state.logItems = buildWith(true);
  state.logSelectables = state.logItems.map((_, i) => i);
  state.logCursor = 0;
  state.logScrollOffset = 0;
  state.logDetailLines = [];
  ui.termCols = 120; ui.termRows = TERM_ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {};
  ui.leftPanelScrollOffset = 0; ui.hoveredLeftPanelRow = -1;
  ui.hoveredLogRow = -1; ui.hoveredTitleZoneIndex = -1;
}

function titleLine(frame) {
  return stripAnsi(frame).split('\n').find(l => l.includes('Sort:')) || '';
}

test('헤더의 Sort 오른쪽에 Recovery 토글이 있고 상태를 반영한다', () => {
  setupLogView();
  ui.logShowRecovery = true;
  const on = titleLine(captureRender());
  assert.match(on, /Sort: date\s+Recovery: on/, 'Sort 바로 오른쪽에 놓여야 한다');

  ui.logShowRecovery = false;
  const off = titleLine(captureRender());
  assert.match(off, /Recovery: off/);

  const zone = ui.titleClickZones.find(z => z.action === 'toggleLogRecovery');
  assert.ok(zone, '클릭 영역이 등록돼야 한다');
  assert.ok(zone.colEnd > zone.colStart, '클릭 영역에 폭이 있어야 한다');
});

test('Commits 탭이 아니면 Recovery 토글을 내보내지 않는다', () => {
  setupLogView();
  state.rightView = 'diff';
  const frame = stripAnsi(captureRender());
  assert.ok(!frame.includes('Recovery:'), '히스토리 전용 옵션이 다른 탭에 새면 안 된다');
  assert.ok(!ui.titleClickZones.some(z => z.action === 'toggleLogRecovery'));
});
