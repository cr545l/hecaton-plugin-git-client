// 변경 파일이 수천 개인 워크트리에서의 렌더 비용 검증.
//
// 플러그인은 QuickJS 에서 돈다. 파일 줄을 매 프레임 전부 꾸미면 호버 한 번에도 수백 ms 가
// 들어 클릭·호버 반응이 밀린다. 그래서 세 가지를 지름길로 둔다:
//   1. visLen/sliceByWidth 는 넓은 문자가 없으면 문자 단위로 돌지 않는다 — 결과는 같아야 한다.
//   2. buildFileList 는 같은 입력이면 같은 배열을 돌려준다 — 입력이 바뀌면 반드시 새로 만든다.
//   3. buildFileListPanel 은 화면에 걸리는 줄만 문자열로 만든다 — 보이는 결과는 같아야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = {
  fs: {}, process: {}, terminal: {},
  window: { set_title: () => Promise.resolve() },
  initialState: { cols: 120, rows: 40 },
};

const { state, ui } = require('../state');
const { buildFileList, toggleFileDir } = require('../refresh');
const { buildFileListPanel } = require('../render');
const text = require('../text');

// 지름길 없이 문자 단위로 센 값 — 비교 기준.
function slowVisLen(s) {
  let w = 0;
  for (const ch of text.stripAnsi(s)) w += text.isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

function resetState() {
  state.loading = false;
  state.isGitRepo = true;
  state.branch = 'main';
  state.cwd = 'C:/repo';
  state.unstaged = [];
  state.untracked = [];
  state.staged = [];
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
  ui.hostScrollRegions = [];
}

test('visLen/sliceByWidth 지름길은 문자 단위 계산과 같은 값을 낸다', () => {
  const samples = [
    '', 'abc', '\x1b[31mred\x1b[0m text', 'tab\there', 'é ñ ü',
    '한글 경로/파일.js', 'mix 한a글b', '\u2500\u2502 box', 'emoji \u{1F600}!', '\u{20000}x',
  ];
  for (const s of samples) {
    assert.equal(text.visLen(s), slowVisLen(s), JSON.stringify(s));
    for (const [start, width] of [[0, 3], [2, 4], [0, 0], [-1, 5], [100, 3]]) {
      const got = text.sliceByWidth(s, start, width);
      assert.ok(slowVisLen(got) <= Math.max(0, width), JSON.stringify([s, start, width, got]));
    }
  }
  assert.equal(text.sliceByWidth('\x1b[1mabcdef\x1b[0m', 2, 3), 'cde');
  assert.equal(text.sliceByWidth('abc', 0, NaN), '');
});

test('buildFileList 는 입력이 같으면 재사용하고, 바뀌면 다시 만든다', () => {
  resetState();
  state.unstaged = [{ status: 'M', file: 'src/a.js' }];
  const first = buildFileList();
  assert.equal(buildFileList(), first, '같은 입력이면 같은 배열');

  // 배열을 갈아 끼운 경우와 같은 배열에 push 한 경우 모두 잡아야 한다.
  state.staged = [{ status: 'A', file: 'src/b.js' }];
  const second = buildFileList();
  assert.notEqual(second, first);
  state.staged.push({ status: 'A', file: 'src/c.js' });
  assert.deepEqual(buildFileList().map(it => it.file), ['src/a.js', 'src/b.js', 'src/c.js']);

  // 보기 모드와 폴더 접힘도 결과를 바꾼다.
  ui.fileTreeView = true;
  const tree = buildFileList();
  assert.ok(tree.some(it => it.kind === 'dir'));
  const srcDir = tree.find(it => it.kind === 'dir' && it.section === 'staged');
  toggleFileDir(srcDir, tree.indexOf(srcDir));
  const collapsed = buildFileList();
  assert.ok(!collapsed.some(it => it.file === 'src/b.js'), '접힌 폴더 안의 파일은 빠진다');

  // 영속 설정을 다시 읽어 접힘 맵이 통째로 바뀐 경우.
  ui.collapsedFileDirs = {};
  assert.ok(buildFileList().some(it => it.file === 'src/b.js'));
});

test('파일이 수천 개여도 보이는 줄은 전부 그렸을 때와 같다', () => {
  resetState();
  for (let i = 0; i < 3000; i++) state.staged.push({ status: 'A', file: 'dir' + (i % 7) + '/file' + i + '.txt' });
  state.unstaged = [{ status: 'M', file: '한글/경로.js' }];
  state.cursor = 1500;
  state.selectedFiles.add(1499);
  ui.hoveredFileRow = 3;

  const lines = buildFileListPanel(60, 20);
  assert.equal(lines.length, 20);
  const plain = lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // 목록은 Unstaged 한 줄 뒤에 Staged 가 온다(인덱스 1500 = file1499). 커서를 따라
  // 스크롤된 화면이 커서 줄과 바로 위 다중 선택 줄을 담고 있어야 한다.
  assert.ok(plain.some(l => l.includes('file1498.txt') && l.includes('✓')), plain.join('\n'));
  assert.ok(plain.some(l => l.includes('file1499.txt') && !l.includes('✓')));
  // 맵은 보이는 줄마다 하나씩, 실제 파일 인덱스를 가리킨다.
  assert.equal(ui.fileLineMap.length, 20);
  assert.ok(ui.fileLineMap.includes(1500));
});
