// 워킹트리 파일 목록의 트리 보기 검증.
//
// 평면 목록에는 디렉토리가 줄로 존재하지 않아, "이 폴더째로 무시" 같은 상위 경로 단위
// 조작을 걸 자리가 없었다. 트리 보기는 그 자리를 만드는 기능이므로, 여기서 지켜야 하는
// 계약은 두 가지다:
//   1. 폴더 줄도 목록(buildFileList)의 한 항목이다 — 커서·다중 선택·클릭 맵이 전부 이
//      목록의 인덱스를 쓰므로, 화면에만 있는 줄을 만들면 커서가 보이는 줄을 건너뛴다.
//   2. 폴더 줄에 걸린 파일 단위 동작은 그 아래 파일 전부로 펼쳐진다 — 폴더에는 경로가
//      없어서, 펼치지 않고 넘기면 존재하지 않는 경로로 git 을 부른다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
};

const { state, ui, isCollapsedFileDir } = require('../state');
const {
  buildFileList, expandFileTargets, sectionRangeAt, setFileTreeView, toggleFileDir,
} = require('../refresh');
const { buildDirContextMenuItems, buildFileContextMenuItems } = require('../context-menu');
const { buildFileListPanel } = require('../render');

function resetState() {
  state.loading = false;
  state.isGitRepo = true;
  state.branch = 'main';
  state.cwd = 'C:/repo';
  state.unstaged = [
    { status: 'M', file: 'src/util/log.js' },
    { status: 'M', file: 'src/app.js' },
    { status: 'M', file: 'README.md' },
  ];
  state.untracked = [{ file: 'src/util/new.js' }];
  state.staged = [{ status: 'A', file: 'src/index.js' }];
  state.ignored = [];
  state.ignoredLoaded = true;
  state.cursor = 0;
  state.selectedFiles.clear();
  state.filesScrollX = 0;
  state.scrollOffset = 0;
  state.activeOps = [];
  state.spinnerActive = false;
  state.settlingWrite = false;
  ui.collapsedSections = {};
  ui.collapsedFileDirs = {};
  ui.fileTreeView = false;
  ui.hoveredFileRow = -1;
  ui.hoveredFileHeaderIdx = -1;
  ui.filesScrollPin = undefined;
}

const rowsOf = (list) => list.map(it =>
  '  '.repeat(it.depth) + it.name + (it.kind === 'dir' ? '/' : ''));

const plain = (lines) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, ''));

test('평면 모드는 예전 그대로 — 경로 전체가 한 줄, 폴더 줄 없음', () => {
  resetState();
  const list = buildFileList();
  assert.ok(list.every(it => it.kind === 'file'), '폴더 줄이 있으면 안 된다');
  assert.deepEqual(list.map(it => it.file), [
    'src/util/log.js', 'src/app.js', 'README.md', 'src/util/new.js', 'src/index.js',
  ]);
  assert.deepEqual(list.map(it => it.name), list.map(it => it.file));
});

test('트리 모드는 폴더 먼저 이름순, 그다음 파일 이름순으로 펼친다', () => {
  resetState();
  setFileTreeView(true);
  assert.deepEqual(rowsOf(buildFileList()), [
    'src/',
    '  util/',
    '    log.js',
    '    new.js',
    '  app.js',
    'README.md',
    'src/',        // Staged 구획의 src/ — 구획이 다르면 같은 경로라도 다른 줄이다
    '  index.js',
  ]);
});

test('폴더 줄은 그 아래 파일 전부를 대표한다', () => {
  resetState();
  setFileTreeView(true);
  const src = buildFileList().find(it => it.kind === 'dir' && it.dir === 'src' && it.section === 'unstaged');
  assert.deepEqual(expandFileTargets([src]).map(f => f.file),
    ['src/util/log.js', 'src/util/new.js', 'src/app.js']);
});

test('폴더와 그 안의 파일을 함께 골라도 대상은 한 번씩만 나온다', () => {
  resetState();
  setFileTreeView(true);
  const list = buildFileList();
  const src = list.find(it => it.kind === 'dir' && it.dir === 'src' && it.section === 'unstaged');
  const inner = list.find(it => it.file === 'src/util/log.js');
  assert.deepEqual(expandFileTargets([src, inner]).map(f => f.file),
    ['src/util/log.js', 'src/util/new.js', 'src/app.js']);
});

test('폴더를 접으면 그 아래 줄이 사라지고, 커서는 접은 폴더에 남는다', () => {
  resetState();
  setFileTreeView(true);
  const before = buildFileList();
  const util = before.find(it => it.kind === 'dir' && it.dir === 'src/util');
  state.cursor = before.indexOf(util);

  toggleFileDir(util, state.cursor);
  assert.equal(isCollapsedFileDir('unstaged', 'src/util'), true);
  const after = buildFileList();
  assert.deepEqual(rowsOf(after), ['src/', '  util/', '  app.js', 'README.md', 'src/', '  index.js']);
  assert.equal(after[state.cursor].dir, 'src/util', '커서는 접은 폴더 줄에 그대로 있어야 한다');
  // 접혀도 대표하는 대상은 그대로다 — 접어 둔 폴더에 무시/담기를 걸 수 있어야 한다.
  assert.deepEqual(expandFileTargets([after[state.cursor]]).map(f => f.file),
    ['src/util/log.js', 'src/util/new.js']);

  toggleFileDir(after[state.cursor], state.cursor);
  assert.equal(isCollapsedFileDir('unstaged', 'src/util'), false);
  assert.equal(buildFileList().length, before.length);
});

test('접힌 안쪽으로 사라진 다중 선택은 정리된다', () => {
  resetState();
  setFileTreeView(true);
  const list = buildFileList();
  const util = list.find(it => it.kind === 'dir' && it.dir === 'src/util');
  const logIdx = list.findIndex(it => it.file === 'src/util/log.js');
  const readmeIdx = list.findIndex(it => it.file === 'README.md');
  state.selectedFiles.add(logIdx);
  state.selectedFiles.add(readmeIdx);

  toggleFileDir(util, list.indexOf(util));
  const after = buildFileList();
  const stillSelected = Array.from(state.selectedFiles).map(i => after[i] && after[i].file);
  assert.deepEqual(stillSelected, ['README.md'], '보이지 않는 줄이 선택에 남으면 안 된다');
});

test('구획 범위는 목록에서 직접 구한다 — 트리에서도 Unstaged 와 Staged 가 섞이지 않는다', () => {
  resetState();
  setFileTreeView(true);
  const list = buildFileList();
  const stagedStart = list.findIndex(it => it.section === 'staged');
  assert.deepEqual(sectionRangeAt(list, 0), [0, stagedStart]);
  assert.deepEqual(sectionRangeAt(list, stagedStart), [stagedStart, list.length]);
});

test('트리 ↔ 평면 전환은 보던 파일에 커서를 남긴다', () => {
  resetState();
  const flat = buildFileList();
  state.cursor = flat.findIndex(it => it.file === 'src/app.js');

  setFileTreeView(true);
  assert.equal(buildFileList()[state.cursor].file, 'src/app.js');

  setFileTreeView(false);
  assert.equal(buildFileList()[state.cursor].file, 'src/app.js');
});

// ── 폴더 컨텍스트 메뉴 ──

const childLabels = (items, id) => items.find(i => i.id === id).children.map(c => c.label);

test('폴더 메뉴의 Ignore 는 디렉토리 패턴을 보여준다', () => {
  resetState();
  setFileTreeView(true);
  const util = buildFileList().find(it => it.kind === 'dir' && it.dir === 'src/util');
  const menu = buildDirContextMenuItems(util, [util]);
  // 끝의 '/' 가 "디렉토리만"을 뜻한다 — 같은 이름의 파일까지 사라지지 않게.
  assert.deepEqual(childLabels(menu, 'dir_ignore'), [
    'Ignore by Name (util/)',
    'Ignore by Path (/src/util/)',
  ]);
});

test('폴더 메뉴의 파일 동작은 하위 파일 개수로 라벨이 붙는다', () => {
  resetState();
  setFileTreeView(true);
  const src = buildFileList().find(it => it.kind === 'dir' && it.dir === 'src' && it.section === 'unstaged');
  const menu = buildDirContextMenuItems(src, [src]);
  const label = (id) => menu.find(i => i.id === id).label;
  const enabled = (id) => menu.find(i => i.id === id).enabled;
  assert.equal(label('file_stage'), 'Stage 3 Files');
  assert.equal(enabled('file_stage'), true);
  assert.equal(enabled('file_unstage'), false, 'Unstaged 구획의 폴더에는 내릴 것이 없다');
  assert.equal(label('file_discard'), "Discard changes in 'src'...");
});

test('폴더가 섞인 다중 선택이면 파일 메뉴도 펼친 개수를 센다', () => {
  resetState();
  setFileTreeView(true);
  const list = buildFileList();
  const util = list.find(it => it.kind === 'dir' && it.dir === 'src/util');
  const readme = list.find(it => it.file === 'README.md');
  const menu = buildFileContextMenuItems(readme, [util, readme]);
  // util 아래 2개 + README.md = 3개
  assert.equal(menu.find(i => i.id === 'file_stash_one').label, 'Stash 3 Files...');
});

test('트리/평면 전환 항목이 파일 메뉴와 폴더 메뉴 양쪽에 있다', () => {
  resetState();
  setFileTreeView(true);
  const list = buildFileList();
  const util = list.find(it => it.kind === 'dir' && it.dir === 'src/util');
  const readme = list.find(it => it.file === 'README.md');
  for (const menu of [buildDirContextMenuItems(util, [util]), buildFileContextMenuItems(readme, [readme])]) {
    const toggle = menu.find(i => i.id === 'file_tree_view');
    assert.ok(toggle, '전환 항목이 있어야 한다');
    assert.equal(toggle.checked, true);
  }
});

// ── 렌더 ──

test('트리 줄은 상태 글자 자리에 접힘 표시(+/-)를 놓고 이름을 들여쓴다', () => {
  resetState();
  setFileTreeView(true);
  const lines = plain(buildFileListPanel(40, 30));
  const body = lines.filter(l => l && !/Unstaged|Staged|Ignored/.test(l));
  assert.deepEqual(body, [
    '   - src/',
    '   -   util/',
    '   M     log.js',
    '   ?     new.js',
    '   M   app.js',
    '   M README.md',
    '   - src/',
    '   A   index.js',
  ]);
});

test('평면 모드 렌더는 예전과 같은 모양이다', () => {
  resetState();
  const lines = plain(buildFileListPanel(40, 30));
  const body = lines.filter(l => l && !/Unstaged|Staged|Ignored/.test(l));
  assert.deepEqual(body, [
    '   M src/util/log.js',
    '   M src/app.js',
    '   M README.md',
    '   ? src/util/new.js',
    '   A src/index.js',
  ]);
});
