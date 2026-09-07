const test = require('node:test');
const assert = require('node:assert/strict');
const calls = [], handlers = new Map();
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 160, rows: 32 }, on: (id, fn) => handlers.set(id, fn),
  scroll: {
    region: async p => { calls.push(['region', p]); return {scrollbar_cols:1, scrollbar_rows:p.content_cols > p.width - 1 ? 1 : 0}; },
    set: async p => { calls.push(['set', p]); return {}; },
    remove: async p => { calls.push(['remove', p]); return {}; },
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const scroll = require('../scroll');
const { stripAnsi, visLen } = require('../text');
scroll.init({});
const COLS = 160, ROWS = 32, FILE = 'src/' + 'long-name-'.repeat(25) + '.js';
const DIFF = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1 +1 @@',
  '-' + 'old'.repeat(90), '+' + 'new'.repeat(90) + 'END'];
function setup(diffView) {
  state.loading = false; state.isGitRepo = true; state.gitNotFound = false;
  state.minimized = false; state.operationState = null; state.conflictView = null;
  state.branch = 'main';
  state.branches = [{ name: 'main', isCurrent: true, upstream: 'origin/main' }];
  state.remoteBranches = ['origin/main']; state.remotes = ['origin']; state.stashes = [];
  state.worktrees = [{ path: 'C:/repo', branch: 'main', isMain: true, isCurrent: true }];
  state.isLinkedWorktree = false; state.ahead = 0; state.behind = 0;
  state.staged = [{ file: FILE, status: 'M' }];
  state.unstaged = []; state.untracked = []; state.ignored = [];
  state.selectedFiles = new Set();
  state.rightView = 'diff'; state.diffView = diffView;
  state.currentDiffFile = FILE;
  state.diffLines = DIFF.slice();
  state.cursor = 0; state.scrollOffset = 0;
  state.diffScrollOffset = 0; state.diffScrollX = 0;
  state.mode = 'normal'; state.commitMsg = '';
  ui.termCols = COLS; ui.termRows = ROWS; ui.cellW = 8; ui.cellH = 16;
  ui.collapsedSections = {}; ui.collapsedGroups = {}; ui.leftPanelScrollOffset = 0;
}


function frame() {
  let out = ''; const old = process.stdout.write;
  process.stdout.write = s => { out += s; return true; };
  try { render(); } finally { process.stdout.write = old; }
  return out;
}
const settle = () => new Promise(r => setImmediate(r));
for (const view of ['unified', 'side', 'log', 'fresh']) {
  test(view + ' uses native two-axis regions, banks and a separate bottom row', async () => {
    setup(view === 'side' ? 'side' : 'unified');
    state.loading = state.refreshing = state.spinnerActive = false;
    state.error = null;
    if (view === 'log') { state.rightView = 'log'; state.logItems = [{type:'commit',hash:'1234567',message:'test',subject:'test',graph:'*',decoration:''}]; state.logSelectables = [0]; state.logCursor = 0; state.logDetailLines = DIFF; }
    if (view === 'fresh') { state.rightView = 'fresh'; state.freshItems = [{file:FILE,status:'M',author:'author',date:'2026-09-07'}]; state.freshDetailLines = DIFF; }
    const id = view === 'log' ? 'logDetail' : view === 'fresh' ? 'freshDetail' : 'diff';
    frame(); await settle();
    const r = ui.hostScrollRegions.find(r => r.id === id);
    assert.ok(r, id);
    assert.ok(r.contentCols > r.width);
    const request = calls.filter(([type,p]) => type === 'region' && p.id === id).at(-1)[1];
    assert.equal(request.height, r.height + 1);
    assert.equal(request.content_cols, r.contentCols);
    assert.equal(request.overscan_col, scroll.bankCol(id));
    assert.ok(request.row + request.height <= ui.termRows);
    handlers.get('scroll.update')({id,top_row:0,left_col:7});
    assert.equal(state.diffScrollX, 7);
    const output = frame();
    assert.ok(output.includes('\x1b]7741;' + id + ';0;7\x07'));
    assert.ok(output.includes(';' + (scroll.bankCol(id) + 1) + 'H'));
    scroll.moveHorizontal(id, 100000);
    assert.equal(state.diffScrollX, r.contentCols - r.width);
    assert.equal(calls.at(-1)[1].left_col, state.diffScrollX);
    frame();
    const end = ui.hostScrollRegions.find(r => r.id === id);
    const rows = Array.from({length:end.contentRows}, (_,i) => end.getLine(i));
    assert.ok(rows.some(line => stripAnsi(line || '').includes('END')), 'full raw row retains the end of source');
    assert.equal(ui.hScrollbarZones, undefined);
  });
}
test('file names, header hit zones and host offsets move together', async () => {
  setup('unified'); frame(); await settle();
  const r = ui.hostScrollRegions.find(r => r.id === 'files');
  assert.ok(r.contentCols > r.width);
  const start = ui.fileHeaderZones.map(z => ({...z}));
  handlers.get('scroll.update')({id:'files',top_row:0,left_col:9}); frame();
  assert.equal(state.filesScrollX,9);
  assert.equal(ui.fileHeaderZones[0].btnColEnd, start[0].btnColEnd - 9);
  scroll.moveHorizontal('files',100000); frame();
  const end = ui.hostScrollRegions.find(r => r.id === 'files');
  const line = Array.from({length:end.contentRows}, (_,i)=>end.getLine(i)).find(l=>stripAnsi(l || '').includes('.js'));
  assert.ok(stripAnsi(line).includes(FILE));
  assert.ok(stripAnsi(scroll.sliceLine(line,state.filesScrollX,end.width)).includes('.js'));
});
test('cell clipping keeps SGR and pads partial wide characters at either edge', () => {
  const line = '\x1b[31mA\uac00B\x1b[0m';
  assert.equal(stripAnsi(scroll.sliceLine(line,2,2)), ' B');
  assert.equal(stripAnsi(scroll.sliceLine(line,0,2)), 'A ');
  assert.ok(scroll.sliceLine(line,2,2).includes('\x1b[31m'));
  assert.equal(visLen(scroll.sliceLine(line,2,2)),2);
});
