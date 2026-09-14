const { calcGraphRows } = require('./graph');

// Traverse each direction separately: walking back down from an ancestor would
// incorrectly include sibling branches and other parents of descendant merges.
function relatedHashes(commits, selected) {
  const parents = new Map();
  const children = new Map();
  for (const c of commits) {
    parents.set(c.hash, c.parents || []);
    for (const p of c.parents || []) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(c.hash);
    }
  }
  const related = new Set();
  for (const links of [parents, children]) {
    const seen = new Set();
    const pending = [selected];
    while (pending.length) {
      const hash = pending.pop();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      related.add(hash);
      pending.push(...(links.get(hash) || []));
    }
  }
  return related;
}

let cachedItems, cachedHash, cachedResult;
function highlightedRows(items, hash) {
  if (!hash) return null;
  if (items === cachedItems && hash === cachedHash) return cachedResult;
  const commits = items.filter(c => c.type === 'commit');
  const related = relatedHashes(commits, hash);
  const rows = calcGraphRows(commits, new Set(), new Map(), related);
  cachedItems = items;
  cachedHash = hash;
  return cachedResult = { related, rows: new Map(rows.map(r => [r.hash, r])) };
}

module.exports = { relatedHashes, highlightedRows };
