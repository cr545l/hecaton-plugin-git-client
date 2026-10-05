const test = require('node:test');
const assert = require('node:assert/strict');
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 120, rows: 40 }, on: () => {},
};
const { state, ui } = require('../state');
const { render } = require('../render');

function setup(lines) {
  Object.assign(state, {
    loading: false, isGitRepo: true, gitNotFound: false, minimized: false,
    branch: 'main', branches: [{ name: 'main', isCurrent: true }],
    worktrees: [{ path: 'repo', branch: 'main', isMain: true, isCurrent: true }],
    rightView: 'log', logItems: [{ type: 'commit', hash: '1234567', subject: 'test', decoration: '' }],
    logSelectables: [0], logCursor: 0, logScrollOffset: 0, logDetailLines: lines,
    diffScrollOffset: 0, diffScrollX: 0, logDetailLoading: false,
  });
  ui.termCols = 120; ui.termRows = 40;
  ui.collapsedDetailFiles.clear();
}
function frame() {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = s => { output += s; return true; };
  try { render(); } finally { process.stdout.write = write; }
  return output;
}
function patch(file, text) {
  return [`diff --git a/${file} b/${file}`, '@@ -1 +1 @@', '+' + text];
}
function counted(lines) {
  let reads = 0;
  return {
    source: new Proxy(lines, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } }),
    reads: () => reads,
  };
}

test('redraws and spinner animation reuse an unchanged large patch', () => {
  const input = counted(['diff --git a/large.txt b/large.txt', '@@ -1,2000 +1,2000 @@',
    ...Array.from({ length: 2000 }, (_, i) => '+line ' + i)]);
  setup(input.source);
  frame();
  const firstReads = input.reads();
  assert.ok(firstReads >= 2002);
  const count = ui.filteredDetailCount;
  for (let i = 0; i < 4; i++) {
    state.logDetailLoading = true;
    state.logDetailLoadingSince = Date.now() - 1000;
    state.spinnerFrame = i;
    frame();
    assert.equal(ui.filteredDetailCount, count + 2);
  }
  state.logDetailLoading = false;
  frame();
  assert.equal(ui.filteredDetailCount, count);
  assert.equal(input.reads(), firstReads, 'animation must not reread the source patch');
});

test('same-length source replacement recalculates the horizontal extent', () => {
  setup(patch('a.txt', 'short'));
  frame();
  const narrow = ui.logDetailMaxScrollX;
  state.logDetailLines = patch('a.txt', '\t' + '\uD55C'.repeat(200));
  frame();
  assert.ok(ui.logDetailMaxScrollX > narrow + 200);
  state.logDetailLines = patch('a.txt', 'short');
  state.diffScrollX = 999;
  frame();
  assert.equal(ui.logDetailMaxScrollX, narrow);
  assert.equal(state.diffScrollX, narrow);
});

test('same-size collapse changes invalidate the layout and expanding restores it', () => {
  setup([...patch('wide.txt', 'w'.repeat(300)), ...patch('small.txt', 's')]);
  ui.collapsedDetailFiles.add('wide.txt');
  frame();
  const collapsedWidth = ui.logDetailMaxScrollX;
  assert.equal(ui.filteredDetailCount, 4);
  ui.collapsedDetailFiles.delete('wide.txt');
  ui.collapsedDetailFiles.add('small.txt');
  frame();
  assert.equal(ui.filteredDetailCount, 4);
  assert.ok(ui.logDetailMaxScrollX > collapsedWidth);
  ui.collapsedDetailFiles.clear();
  frame();
  assert.equal(ui.filteredDetailCount, 6);
});

test('appending patch lines invalidates the cached layout', () => {
  const lines = patch('a.txt', 'short');
  setup(lines); frame();
  const count = ui.filteredDetailCount;
  lines.push('+' + 'x'.repeat(400));
  frame();
  assert.equal(ui.filteredDetailCount, count + 1);
  assert.ok(ui.logDetailMaxScrollX > 200);
});
