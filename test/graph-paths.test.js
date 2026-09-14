const test = require('node:test');
const assert = require('node:assert/strict');
const { calcGraphRows } = require('../graph');
const { relatedHashes } = require('../log-highlight');
const { renderCombinedGraphPixels } = require('../sixel');

function draw(commits, selected, cellW = 12, cellH = 20) {
  const related = selected ? relatedHashes(commits, selected) : null;
  const rows = calcGraphRows(commits, new Set(), new Map(), related);
  const width = rows[0].chars.length * cellW;
  const pixels = renderCombinedGraphPixels(rows, rows[0].chars.length, cellW, cellH);
  const at = (row, x, y) => pixels[(row * cellH + y) * width + x];
  return { rows, pixels, width, at };
}

test('faint join keeps its style all the way to the node across intermediate lanes', () => {
  const commits = [
    { hash: 'left', parents: ['root'] },
    { hash: 'middle', parents: ['far'] },
    { hash: 'right', parents: ['root'] },
    { hash: 'root', parents: ['far'] },
    { hash: 'far', parents: [] },
  ];
  const { rows, at } = draw(commits, 'left', 16);
  assert.equal(rows[3].commitLane, 0);
  assert.equal(at(3, 15, 10), 11, 'join next to the node must not borrow the node color');
  for (let x = 15; x <= 32; x++) assert.equal(at(3, x, 10), 11, 'continuous faint horizontal edge');
  assert.equal(at(3, 8, 10), 1, 'node retains its own color');
});

test('bright merge lights the shared tail but leaves the unrelated incoming edge faint', () => {
  const commits = [
    { hash: 'unrelated', parents: ['parent'] },
    { hash: 'merge', parents: ['selectedBranch', 'parent'] },
    { hash: 'selectedBranch', parents: ['root'] },
    { hash: 'parent', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  const { at } = draw(commits, 'merge');
  assert.equal(at(1, 6, 0), 11, 'incoming unrelated edge stays faint');
  assert.equal(at(1, 6, 19), 1, 'shared lane below merge is bright');
  assert.equal(at(2, 6, 0), 1, 'brightness continues across the next row');
  assert.equal(at(3, 6, 0), 1, 'connection remains bright up to the parent node');
});

test('multiple parents keep curved endpoints without phantom vertical stubs', () => {
  const commits = [
    { hash: 'merge', parents: ['a', 'b', 'c'] },
    { hash: 'a', parents: ['root'] },
    { hash: 'b', parents: ['root'] },
    { hash: 'c', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  for (const cellW of [7, 8, 12]) {
    const { rows, at } = draw(commits, null, cellW, 16);
    const lane1 = cellW + (cellW >> 1);
    assert.equal(at(0, lane1, 0), 0, 'new branch has no upward stub');
    assert.ok(at(0, lane1, 15), 'new branch reaches bottom of row');
    assert.ok(at(1, lane1, 0), 'next row continues the same lane');
    assert.equal(at(4, lane1, 15), 0, 'closed branch has no downward stub');
    assert.equal(rows[0].paths.filter(p => p.kind === 'branch').length, 2);
    assert.equal(rows[4].paths.filter(p => p.kind === 'join').length, 2);
  }
});

test('graph crop matches the same rows in the full graph, including highlighted paths', () => {
  const commits = [
    { hash: 'merge', parents: ['a', 'b'] },
    { hash: 'a', parents: ['root'] },
    { hash: 'b', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  const { rows, pixels, width } = draw(commits, 'a');
  const crop = renderCombinedGraphPixels(rows.slice(1, 3), rows[0].chars.length, 12, 20);
  assert.deepEqual(crop, pixels.slice(width * 20, width * 60));
});
