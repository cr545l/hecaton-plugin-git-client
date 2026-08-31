// 워킹트리 컨텍스트 메뉴의 Ignore 하위 항목 라벨 검증.
//
// Ignore by Name / Extension / Path 는 이름만 봐서는 .gitignore 에 무엇이 적힐지
// 알 수 없다 — 특히 Path 는 저장소 루트 기준인지, 앞에 슬래시가 붙는지가 결과를
// 가른다. 그래서 실제로 추가될 패턴을 라벨 뒤 괄호에 그대로 보여준다.
const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: { cols: 120, rows: 40 }, terminal: {} };

const { state } = require('../state');
const { buildFileContextMenuItems } = require('../context-menu');

function resetState() {
  state.staged = [];
  state.unstaged = [];
  state.untracked = [];
  state.branch = 'main';
  state.isGitRepo = true;
}

const ignoreChildren = (items) => items.find(i => i.id === 'file_ignore').children;
const labelOf = (children, id) => children.find(c => c.id === id).label;

test('단일 선택이면 추가될 패턴이 그대로 라벨에 붙는다', () => {
  resetState();
  const item = { type: 'untracked', status: '?', file: 'src/util/log.js' };

  const children = ignoreChildren(buildFileContextMenuItems(item, [item]));
  assert.equal(labelOf(children, 'file_ignore_name'), 'Ignore by Name (log.js)');
  assert.equal(labelOf(children, 'file_ignore_ext'), 'Ignore by Extension (*.js)');
  assert.equal(labelOf(children, 'file_ignore_path'), 'Ignore by Path (/src/util/log.js)');
});

test('경로 패턴은 실행부와 같은 형태(앞 슬래시, 정방향 구분자)로 보여준다', () => {
  resetState();
  const item = { type: 'untracked', status: '?', file: 'src\\util\\log.js' };

  const children = ignoreChildren(buildFileContextMenuItems(item, [item]));
  assert.equal(labelOf(children, 'file_ignore_path'), 'Ignore by Path (/src/util/log.js)');
});

test('여러 개가 선택되면 첫 패턴과 나머지 개수를 보여준다', () => {
  resetState();
  const items = [
    { type: 'untracked', status: '?', file: 'a.js' },
    { type: 'untracked', status: '?', file: 'b.js' },
    { type: 'untracked', status: '?', file: 'c.txt' },
  ];

  const children = ignoreChildren(buildFileContextMenuItems(items[0], items));
  assert.equal(labelOf(children, 'file_ignore_name'), 'Ignore by Name (a.js +2)');
  // 확장자는 겹치는 것을 한 번만 세므로 *.js / *.txt 두 개다.
  assert.equal(labelOf(children, 'file_ignore_ext'), 'Ignore by Extension (*.js +1)');
  assert.equal(labelOf(children, 'file_ignore_path'), 'Ignore by Path (/a.js +2)');
});

test('확장자가 없으면 Ignore by Extension 은 잠기고 괄호도 붙지 않는다', () => {
  resetState();
  const item = { type: 'untracked', status: '?', file: 'Makefile' };

  const children = ignoreChildren(buildFileContextMenuItems(item, [item]));
  const ext = children.find(c => c.id === 'file_ignore_ext');
  assert.equal(ext.label, 'Ignore by Extension');
  assert.equal(ext.enabled, false, '누를 수 없는 항목이면 눌러 보기 전에 알아야 한다');
  assert.equal(labelOf(children, 'file_ignore_name'), 'Ignore by Name (Makefile)');
});
