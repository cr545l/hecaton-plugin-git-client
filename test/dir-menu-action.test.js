// 폴더 컨텍스트 메뉴가 실제로 무엇을 실행하는지 검증.
//
// 위험한 지점은 하나다: 폴더 줄에는 파일 경로가 없다. 파일 단위 처리부(file_*)가
// 폴더를 그대로 받으면 undefined 경로로 git 을 부르게 되므로, 처리부에 닿기 전에
// 하위 파일로 펼쳐져야 한다. 그리고 폴더에서 뜻이 통하지 않는 file_* 은 아예 실행되지
// 않아야 한다(메뉴에 없더라도 호스트가 흘려보낼 수 있다).
const test = require('node:test');
const assert = require('node:assert/strict');

const CWD = 'C:/repo';
let execCalls = [];
let writtenFiles = [];
let ignoreContent = '';

global.hecaton = {
  initialState: { cols: 120, rows: 40 },
  terminal: {}, overlay: { open: async () => ({}) },
  window: { set_title: async () => ({}) },
  menu: { show: async () => ({}) },
  dialog: { show: async () => ({}) },
  clipboard: { write: async () => ({ ok: true }) },
  process: {
    exec: async (params) => {
      execCalls.push(params.args);
      return { ok: true, exit_code: 0, stdout: '', stderr: '' };
    },
  },
  fs: {
    read_file: async () => ({ ok: true, content: ignoreContent }),
    write_file: async ({ path, content }) => {
      writtenFiles.push({ path, content });
      ignoreContent = content;
      return { ok: true };
    },
  },
};

const { state, ui } = require('../state');
const { buildFileList, setFileTreeView } = require('../refresh');
const { handleContextMenuAction } = require('../context-menu');

function resetState() {
  execCalls = [];
  writtenFiles = [];
  ignoreContent = '';
  state.loading = false;
  state.isGitRepo = true;
  state.branch = 'main';
  state.cwd = CWD;
  state.unstaged = [
    { status: 'M', file: 'src/util/log.js' },
    { status: 'M', file: 'src/util/fmt.js' },
    { status: 'M', file: 'README.md' },
  ];
  state.untracked = [];
  state.staged = [];
  state.ignored = [];
  state.ignoredLoaded = true;
  state.cursor = 0;
  state.selectedFiles.clear();
  state.activeOps = [];
  state.spinnerActive = false;
  state.settlingWrite = false;
  state.operationState = null;
  state.indexLocked = false;
  state.pendingDiscardFiles = null;
  ui.collapsedSections = {};
  ui.collapsedFileDirs = {};
  ui.fileTreeView = false;
}

// 폴더 줄을 우클릭한 상태를 만든다 (input.js 의 handleContextMenuRequest 와 같은 준비).
function openDirMenu(dirPath) {
  setFileTreeView(true);
  const list = buildFileList();
  const dir = list.find(it => it.kind === 'dir' && it.dir === dirPath);
  assert.ok(dir, dirPath + ' 폴더 줄이 있어야 한다');
  state.cursor = list.indexOf(dir);
  state.selectedFiles.clear();
  state.selectedFiles.add(state.cursor);
  ui.contextMenuFileItem = dir;
  ui.contextMenuFileItems = [dir];
  ui.contextMenuFilePath = CWD + '/' + dirPath;
  return dir;
}

test('폴더의 Ignore by Path 는 경로 패턴을 .gitignore 에 적는다', async () => {
  resetState();
  openDirMenu('src/util');

  await handleContextMenuAction('dir_ignore_path');

  assert.equal(writtenFiles.length, 1);
  assert.match(writtenFiles[0].path, /\.gitignore$/);
  assert.equal(writtenFiles[0].content, '/src/util/\n');
});

test('폴더의 Ignore by Name 은 이름 패턴을 적는다', async () => {
  resetState();
  openDirMenu('src/util');

  await handleContextMenuAction('dir_ignore_name');

  assert.equal(writtenFiles[0].content, 'util/\n');
});

test('폴더에 건 Stage 는 하위 파일 경로로 실행된다', async () => {
  resetState();
  openDirMenu('src/util');

  await handleContextMenuAction('file_stage');

  const add = execCalls.find(args => args[0] === 'add');
  assert.ok(add, 'git add 가 실행돼야 한다');
  // 폴더가 그대로 넘어갔다면 여기에 undefined 나 'src/util' 이 들어온다.
  assert.deepEqual(add.slice(-2).sort(), ['src/util/fmt.js', 'src/util/log.js']);
});

test('폴더에 건 Discard 는 하위 파일을 확인창 대상으로 잡는다', async () => {
  resetState();
  openDirMenu('src/util');

  await handleContextMenuAction('file_discard');

  // 트리가 이름순으로 놓으므로 fmt.js 가 먼저다.
  assert.deepEqual((state.pendingDiscardFiles || []).map(f => f.file),
    ['src/util/fmt.js', 'src/util/log.js']);
});

test('폴더에서 뜻이 통하지 않는 file_* 은 실행되지 않는다', async () => {
  resetState();
  openDirMenu('src/util');

  // blame 은 파일 하나를 전제로 한다 — 폴더가 대상이면 대표 파일을 골라 도는 대신
  // 아무것도 하지 않아야 한다.
  await handleContextMenuAction('file_blame');
  assert.deepEqual(execCalls, []);

  await handleContextMenuAction('file_ignore_name');
  assert.deepEqual(writtenFiles, [], '파일용 Ignore 가 폴더에 걸리면 안 된다');
});

test('트리 전환 항목은 어느 메뉴에서 눌러도 같은 동작', async () => {
  resetState();
  assert.equal(ui.fileTreeView, false);

  await handleContextMenuAction('file_tree_view');
  assert.equal(ui.fileTreeView, true);

  await handleContextMenuAction('file_tree_view');
  assert.equal(ui.fileTreeView, false);
});
