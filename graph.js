const { ansi, seriePalette } = require('./ansi');

function calcGraphRows(commits, stashHashes, stashMap) {
  const rows = [];
  let lanes = [];
  let maxLanes = 0;

  for (const commit of commits) {
    const { hash, parents } = commit;

    let commitLane = lanes.indexOf(hash);
    if (commitLane === -1) {
      // Reuse a null (empty) lane slot to keep graph compact
      commitLane = lanes.indexOf(null);
      if (commitLane === -1) {
        commitLane = lanes.length;
        lanes.push(hash);
      } else {
        lanes[commitLane] = hash;
      }
    }

    const merges = [];

    if (parents.length === 0) {
      lanes[commitLane] = null;
    } else {
      lanes[commitLane] = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const existing = lanes.indexOf(parents[p]);
        if (existing !== -1 && existing !== commitLane) {
          merges.push({ lane: existing, isNew: false });
        } else if (existing === -1) {
          // Reuse a null lane slot or append
          let newLane = lanes.indexOf(null);
          if (newLane === -1) {
            newLane = lanes.length;
            lanes.push(parents[p]);
          } else {
            lanes[newLane] = parents[p];
          }
          merges.push({ lane: newLane, isNew: true });
        }
      }
    }

    const { chars, charColors } = buildGraphChars(commitLane, lanes, merges);
    maxLanes = Math.max(maxLanes, lanes.length);

    // Handle incoming lanes: other lanes pointing to this commit's hash
    for (let i = 0; i < lanes.length; i++) {
      if (i === commitLane) continue;
      if (lanes[i] !== hash) continue;
      while (chars.length <= i) { chars.push(' '); charColors.push(-1); }
      if (i > commitLane) {
        chars[i] = '\u256f'; // ╯ curve: up → left
      } else {
        chars[i] = '\u2570'; // ╰ curve: up → right
      }
      charColors[i] = i;
      fillHorizontal(chars, charColors, commitLane, i, lanes);
      lanes[i] = null;
      maxLanes = Math.max(maxLanes, i + 1);
    }

    const shortHash = hash.substring(0, 7);
    let decoration = '';
    if (commit.refs) {
      decoration = ' (' + commit.refs + ')';
      const sRef = stashMap.get(shortHash);
      if (sRef) decoration = decoration.replace(/\)$/, ', ' + sRef + ')');
    } else {
      const sRef = stashMap.get(shortHash);
      if (sRef) decoration = ' (' + sRef + ')';
    }

    rows.push({ type: 'commit', chars, charColors, commitLane, ref: shortHash, decoration, subject: commit.subject });

    // Collapse duplicate lanes
    const lastRow = rows[rows.length - 1];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) continue;
      for (let j = i + 1; j < lanes.length; j++) {
        if (lanes[j] === lanes[i]) {
          if (lastRow.chars[j] === '\u25cf') continue;
          maxLanes = Math.max(maxLanes, lanes.length);
          while (lastRow.chars.length < lanes.length) {
            lastRow.chars.push(' ');
            lastRow.charColors.push(-1);
          }
          if (lastRow.chars[j] === '\u2502') {
            lastRow.chars[j] = j > i ? '\u256f' : '\u2570';
            lastRow.charColors[j] = j;
          }
          if (lastRow.chars[i] === '\u2502') {
            lastRow.chars[i] = j > i ? '\u251c' : '\u2524';
            lastRow.charColors[i] = i;
          }
          fillHorizontal(lastRow.chars, lastRow.charColors, i, j, lanes);
          lanes[j] = null;
        }
      }
    }

    // Only remove trailing null lanes
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
  }

  // Post-process: align all rows to same width
  const graphWidth = maxLanes;
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    while (row.chars.length < graphWidth) {
      row.chars.push(' ');
      row.charColors.push(-1);
    }
    row.graphStr = renderGraphCharsFixed(row.chars, row.charColors, graphWidth);
  }

  return rows;
}

function buildGraphChars(commitLane, lanes, merges) {
  const n = lanes.length;
  const width = n;
  const chars = new Array(width).fill(' ');
  const charColors = new Array(width).fill(-1);

  for (let i = 0; i < n; i++) {
    if (i === commitLane) {
      chars[i] = '\u25cf';
      charColors[i] = commitLane;
    } else if (lanes[i] !== null) {
      chars[i] = '\u2502';
      charColors[i] = i;
    }
  }

  for (const merge of merges) {
    const target = merge.lane;
    fillHorizontal(chars, charColors, commitLane, target, lanes);
    if (merge.isNew) {
      chars[target] = target > commitLane ? '\u256e' : '\u256d';
    } else {
      chars[target] = target > commitLane ? '\u2524' : '\u251c';
    }
    charColors[target] = target;
  }

  return { chars, charColors };
}

function fillHorizontal(chars, charColors, fromLane, toLane, lanes) {
  const left = Math.min(fromLane, toLane);
  const right = Math.max(fromLane, toLane);
  const lineColor = toLane;

  for (let col = left + 1; col < right; col++) {
    if (col === fromLane || col === toLane) continue;
    const existing = chars[col];
    if (existing === '\u2502' || existing === '\u251c' || existing === '\u2524' || existing === '\u256e' || existing === '\u256d') {
      chars[col] = '\u253c';
    } else if (existing === ' ') {
      chars[col] = '\u2500';
      charColors[col] = lineColor;
    }
  }
}

function renderGraphCharsFixed(chars, charColors, width) {
  let result = '';
  for (let i = 0; i < width; i++) {
    const ch = i < chars.length ? chars[i] : ' ';
    const cc = i < charColors.length ? charColors[i] : -1;
    if (cc >= 0) {
      result += seriePalette[cc % seriePalette.length] + ch + ansi.reset;
    } else {
      result += ch;
    }
  }
  return result;
}

module.exports = { calcGraphRows };
