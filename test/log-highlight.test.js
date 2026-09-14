const test = require('node:test');
const assert = require('node:assert/strict');
const { relatedHashes, highlightedRows } = require('../log-highlight');
const { calcGraphRows } = require('../graph');
const { renderCombinedGraphPixels } = require('../sixel');

const commits = [
  { hash: 'merge', parents: ['selected', 'sibling'] },
  { hash: 'selected', parents: ['root'] },
  { hash: 'sibling', parents: ['root'] },
  { hash: 'orphan', parents: [] },
  { hash: 'root', parents: [] },
];

test('ancestors and descendants exclude siblings and other merge parents regardless of order', () => {
  for (const list of [commits, [...commits].reverse()]) {
    assert.deepEqual([...relatedHashes(list, 'selected')].sort(), ['merge', 'root', 'selected']);
  }
  assert.equal(relatedHashes(commits, 'merge').has('sibling'), true);
});

test('highlight preserves lanes and dims unrelated edges independently of their row', () => {
  const normal = calcGraphRows(commits, new Set(), new Map());
  const highlighted = highlightedRows(normal, 'selected');
  const rows = [...highlighted.rows.values()];
  assert.deepEqual(rows.map(r => r.chars), normal.map(r => r.chars));
  const sibling = highlighted.rows.get('sibling');
  assert.ok(sibling.charStyles[sibling.commitLane] & 2);
  assert.ok(sibling.charStyles.some((s, i) => sibling.chars[i] === '│' && !(s & 2)),
    'related edge stays bright while passing through sibling row');
  const merge = highlighted.rows.get('merge');
  assert.ok(!(merge.charStyles[merge.commitLane] & 2));
  assert.ok(merge.charStylesH[merge.commitLane] & 2, 'merge edge to unrelated parent is dim');
  const pixels = renderCombinedGraphPixels(rows, rows[0].chars.length, 8, 16);
  assert.ok(pixels.includes(11), 'dim graph uses theme-aware faint palette');
  assert.ok(pixels.some(p => p >= 1 && p <= 6), 'related graph keeps original colors');
  assert.equal(highlightedRows(normal, 'selected'), highlighted, 'same selection uses cache');
  assert.equal(highlightedRows(normal, 'merge').related.has('sibling'), true);
  assert.equal(highlightedRows(normal, null), null);
  assert.deepEqual(normal, calcGraphRows(commits, new Set(), new Map()), 'original graph stays intact');
});
