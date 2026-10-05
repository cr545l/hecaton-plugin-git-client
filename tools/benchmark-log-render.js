// Run with Node or hecaton-qjs's plugin runner. No host app is launched.
const write = process.stdout.write.bind(process.stdout);
globalThis.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 120, rows: 40 }, on: () => {},
};
const { state, ui } = require('../state');
const { render } = require('../render');
state.loading = false;
state.isGitRepo = true;
state.branch = 'main';
state.branches = [{ name: 'main', isCurrent: true }];
state.worktrees = [{ path: 'repo', branch: 'main', isMain: true, isCurrent: true }];
state.rightView = 'log';
state.logItems = [{ type: 'commit', hash: '1234567', subject: 'Large diff', decoration: '' }];
state.logSelectables = [0];
state.logDetailLines = ['diff --git a/large.txt b/large.txt', '@@ -1,12000 +1,12000 @@',
  ...Array.from({ length: 12000 }, (_, i) => '+' + 'sample text '.repeat(12) + i)];
ui.termCols = 120; ui.termRows = 40;
const samples = [];
process.stdout.write = () => true;
try {
  for (let i = 0; i < 7; i++) {
    // Hover/spinner redraws change UI state, but not the diff source.
    state.spinnerFrame = i;
    const start = performance.now();
    render();
    samples.push(Math.round((performance.now() - start) * 100) / 100);
  }
} finally { process.stdout.write = write; }
write(JSON.stringify({ lines: state.logDetailLines.length, milliseconds: samples }) + '\nDONE\n');
