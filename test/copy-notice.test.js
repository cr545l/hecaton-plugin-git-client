// 클립보드 복사처럼 되돌릴 것도 읽을 것도 없는 성공 알림은 확인창을 띄우지 않는다.
//
// 배경: 복사 성공 안내가 showError 로 나가고 있었다. 제목이 'Error' 인 창이 뜨고
// 사용자가 매번 닫아야 했다 — 성공했는데 실패처럼 보이고 흐름도 끊긴다.
// 지금은 힌트바 토스트(state.error 에 잠깐 머물다 사라짐)로만 알린다.
const test = require('node:test');
const assert = require('node:assert/strict');

const dialogs = [], copies = [];
let patch = '', blame = '', history = '';

global.hecaton = {
  terminal: {}, initialState: { cols: 120, rows: 40 }, on: () => {},
  process: { exec: async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' }) },
  fs: { stat: async () => ({ exists: false }), read_dir: async () => ({ ok: false }), read_file: async () => ({ content: '' }) },
  window: { set_title: async () => ({ ok: true }) },
  scroll: { region: async () => ({ ok: true }), set: async () => ({}), remove: async () => ({}) },
  clipboard: { write: async ({ text }) => { copies.push(text); return { ok: true }; }, read: async () => ({ text: '' }) },
  dialog: { show: opts => { dialogs.push(opts); return Promise.resolve({}); } },
  menu: { show: () => Promise.resolve({}) },
};

const { state, ui } = require('../state');
const rendering = require('../render');
rendering.render = () => {};
const git = require('../git');
git.gitFilePatch = async () => patch;
git.gitBlameFile = async () => blame;
git.gitFileHistory = async () => history;
const { handleContextMenuAction } = require('../context-menu');

const FILE = { file: 'a.txt', type: 'unstaged' };
function setup() {
  dialogs.length = copies.length = 0;
  patch = blame = history = '';
  Object.assign(state, { cwd: 'C:/repo', isGitRepo: true, loading: false, spinnerActive: false,
    settlingWrite: false, indexLocked: false, operationState: null, error: null, mode: 'normal',
    staged: [], unstaged: [FILE], untracked: [], ignored: [], selectedFiles: new Set() });
  Object.assign(ui, { contextMenuFileItem: FILE, contextMenuFilePath: 'C:/repo/a.txt', contextMenuFileItems: [FILE] });
}

const CASES = [
  ['file_external_diff_head', () => { patch = 'diff --git a/a.txt'; }, /Patch copied/],
  ['file_blame', () => { blame = 'deadbeef a.txt'; }, /Blame copied/],
  ['file_history', () => { history = 'deadbeef commit'; }, /History copied/],
  ['file_save_patch', () => { patch = 'diff --git a/a.txt'; }, /Patch copied/],
];

for (const [action, arrange, notice] of CASES) {
  test(action + ' 는 복사 성공을 확인창 없이 힌트바로만 알린다', async () => {
    setup(); arrange();
    await handleContextMenuAction(action);
    assert.equal(copies.length, 1);
    assert.equal(dialogs.length, 0, action + ' 가 확인창을 띄웠다');
    assert.match(state.error, notice);
  });
}

test('복사할 것이 없으면 그대로 오류 창으로 알린다', async () => {
  setup(); // patch 가 비어 있다 — HEAD 와 다른 점이 없는 경우.
  await handleContextMenuAction('file_external_diff_head');
  assert.equal(copies.length, 0);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /No diff/);
});
