// Host-scroll frame cost: one render per scroll.update step.
// Run with Node or hecaton-qjs's plugin runner. No host app is launched.
const write = process.stdout.write.bind(process.stdout);
globalThis.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 200, rows: 60 }, on: () => {},
  scroll: {
    region: async () => ({ scrollbar_cols: 1 }), set: async () => ({}), remove: async () => ({}),
  },
};
const { state, ui } = require('../state');
const { render } = require('../render');
const { buildLogGraphRows } = require('../refresh');
const { applyOffset } = require('../scroll');
const view = (typeof process !== 'undefined' && process.argv && process.argv.find(a => a === 'diff' || a === 'log')) || 'log';
state.loading = false;
state.isGitRepo = true;
state.branch = 'main';
state.branches = [{ name: 'main', isCurrent: true }];
state.worktrees = [{ path: 'repo', branch: 'main', isMain: true, isCurrent: true }];
ui.termCols = 200; ui.termRows = 60; ui.cellW = 9; ui.cellH = 18;
// Synthetic history: a main line with feature branches merging back in.
const commits = [];
const N = 3000;
for (let i = 0; i < N; i++) {
  const hash = ('h' + i).padEnd(40, '0');
  const parents = i + 1 < N ? [('h' + (i + 1)).padEnd(40, '0')] : [];
  if (i % 7 === 0 && i + 5 < N) parents.push(('h' + (i + 5)).padEnd(40, '0'));
  commits.push({ hash, parents, refs: i === 0 ? 'HEAD -> main, origin/main' : (i % 50 === 0 ? 'tag: v' + i : ''),
    subject: 'Commit subject line number ' + i + ' with some text', authorName: 'a', authorDate: '2026-01-01' });
}
const rows = buildLogGraphRows(commits, new Set());
state.logItems = rows; state.logSelectables = [];
rows.forEach((r, i) => { if (r.type === 'commit') state.logSelectables.push(i); });
state.rightView = view === 'diff' ? 'diff' : 'log';
state.logDetailLines = ['diff --git a/x.js b/x.js', '@@ -1,2000 +1,2000 @@',
  ...Array.from({ length: 2000 }, (_, i) => '+const value' + i + ' = compute(' + i + ', "some string");')];
if (view === 'diff') {
  state.unstaged = [{ status: 'M', file: 'x.js' }];
  state.currentDiffFile = 'x.js';
  state.diffLines = state.logDetailLines;
}
let bytes = 0;
process.stdout.write = (s) => { bytes += s.length; return true; };
const samples = [];
const target = view === 'diff' ? 'diff' : 'logList';
(async () => {
try {
  // The first frame registers the regions; banks and the bank-anchored graph
  // are only drawn once the host confirms them.
  render(); await new Promise(r => setTimeout(r, 0)); render();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 40; i++) {
      applyOffset(target, 100 + i);
      const start = performance.now();
      render();
      samples.push(performance.now() - start);
    }
  }
} finally { process.stdout.write = write; }
samples.sort((a, b) => a - b);
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
write(JSON.stringify({ view, frames: samples.length, avgMs: +avg.toFixed(2), p50: +samples[samples.length >> 1].toFixed(2),
  p90: +samples[Math.floor(samples.length * 0.9)].toFixed(2), bytesPerFrame: Math.round(bytes / (samples.length + 2)) }) + '\nDONE\n');
  process.exit(0);
})();
