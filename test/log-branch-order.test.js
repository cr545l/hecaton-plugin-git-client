const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { initialState: { cols: 120, rows: 40 } };

const { ui } = require('../state');
const { buildLogGraphRows } = require('../refresh');
const { renderCombinedGraphPixels } = require('../sixel');

function build(commits, mode = 'branch') {
  ui.logSortMode = mode;
  ui.logShowRecovery = true;
  ui.filteredRefs = [];
  ui.hiddenRefs = [];
  ui.stashMap = new Map();
  return buildLogGraphRows(commits, new Set());
}

function assertTopology(rows, commits) {
  assert.equal(rows.length, commits.length, 'every commit appears exactly once');
  const positions = new Map(rows.map((row, index) => [row.hash, index]));
  assert.equal(positions.size, commits.length);
  for (const commit of commits) {
    assert.ok(positions.has(commit.hash));
    for (const parent of commit.parents) {
      if (!positions.has(parent)) continue;
      assert.ok(positions.get(commit.hash) < positions.get(parent),
        `${commit.hash} must appear above parent ${parent}`);
    }
  }
}

function assertNoTrailingEdges(rows) {
  const last = rows[rows.length - 1];
  assert.equal(last.nodeDown, false);
  assert.ok(!last.paths.some(path => path.kind === 'vertical'), 'no lanes remain past the root');
  const columns = last.chars.length;
  const pixels = renderCombinedGraphPixels([last], columns, 8, 16);
  assert.ok(pixels.slice(columns * 8 * 15).every(pixel => pixel === 0),
    'no graph pixels continue below the last commit');
}

test('large branch history places a merge above HEAD when HEAD is its second parent', () => {
  const trunk = Array.from({ length: 1500 }, (_, i) => ({
    hash: `trunk-${i}`,
    parents: [i === 1499 ? 'root' : `trunk-${i + 1}`],
    refs: i === 0 ? 'HEAD -> feature' : '',
  }));
  const commits = [
    { hash: 'merge', parents: ['side', 'trunk-0'] },
    { hash: 'side', parents: ['root'] },
    ...trunk,
    { hash: 'root', parents: [] },
  ];
  const rows = build(commits);
  assertTopology(rows, commits);
  assert.equal(rows[0].hash, 'merge');
  assert.equal(rows.find(row => row.hash === 'trunk-0').nodeUp, true,
    'the merge connects to the checked-out revision');
  assertNoTrailingEdges(rows);
});

test('recursive branch groups preserve parents across nested merges', () => {
  const commits = [
    { hash: 'outer-merge', parents: ['inner-merge', 'base'] },
    { hash: 'inner-merge', parents: ['root', 'head'] },
    { hash: 'head', parents: ['base'], refs: 'HEAD -> feature' },
    { hash: 'base', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  const rows = build(commits);
  assertTopology(rows, commits);
  assertNoTrailingEdges(rows);
});

test('valid branch grouping stays grouped and date mode keeps Git order', () => {
  const commits = [
    { hash: 'side-tip', parents: ['side-base'] },
    { hash: 'head', parents: ['base'], refs: 'HEAD -> feature' },
    { hash: 'side-base', parents: ['root'] },
    { hash: 'base', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  assert.deepEqual(build(commits).map(row => row.hash),
    ['head', 'base', 'side-tip', 'side-base', 'root']);
  assert.deepEqual(build(commits, 'date').map(row => row.hash), commits.map(commit => commit.hash));
});

test('branch sorting retains edges to parents beyond the loaded history', () => {
  const commits = [
    { hash: 'merge', parents: ['side', 'head'] },
    { hash: 'side', parents: ['unloaded-side'] },
    { hash: 'head', parents: ['base'], refs: 'HEAD -> feature' },
    { hash: 'base', parents: ['unloaded-trunk'] },
  ];
  const rows = build(commits);
  assertTopology(rows, commits);
  assert.equal(rows.find(row => row.hash === 'side').nodeDown, true);
  assert.equal(rows.find(row => row.hash === 'base').nodeDown, true);
});
