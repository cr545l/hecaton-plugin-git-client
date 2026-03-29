const STYLE_NORMAL = 0;
const STYLE_RECOVERY = 1;

function ensureWidth(row, width) {
  while (row.chars.length <= width) {
    row.chars.push(' ');
    row.charColors.push(-1);
    row.charStyles.push(STYLE_NORMAL);
  }
}

function laneStyleForHash(hash, recoveryHashes) {
  return recoveryHashes.has(hash) ? STYLE_RECOVERY : STYLE_NORMAL;
}

function setCell(row, lane, ch, color, style) {
  if (lane < 0) return;
  ensureWidth(row, lane);
  row.chars[lane] = ch;
  row.charColors[lane] = color;
  row.charStyles[lane] = style;
}

function addHorizontalConnector(row, lane, color, style, towardRight) {
  if (lane < 0) return;
  ensureWidth(row, lane);
  const existing = row.chars[lane];
  if (existing === ' ') {
    row.chars[lane] = '\u2500';
  } else if (existing === '\u2502') {
    row.chars[lane] = towardRight ? '\u251c' : '\u2524';
  } else if (existing === '\u2500') {
    // already horizontal
  } else if (
    existing === '\u256d' || existing === '\u256e' || existing === '\u256f' || existing === '\u2570' ||
    existing === '\u251c' || existing === '\u2524'
  ) {
    row.chars[lane] = '\u253c';
  }
  row.charColors[lane] = color;
  row.charStyles[lane] = style;
}

function fillHorizontal(row, fromLane, toLane, color, style) {
  const left = Math.min(fromLane, toLane);
  const right = Math.max(fromLane, toLane);
  for (let lane = left + 1; lane < right; lane++) {
    ensureWidth(row, lane);
    const existing = row.chars[lane];
    if (
      existing === '\u2502' || existing === '\u251c' || existing === '\u2524' ||
      existing === '\u256e' || existing === '\u256d'
    ) {
      row.chars[lane] = '\u253c';
    } else if (existing === ' ') {
      row.chars[lane] = '\u2500';
      row.charColors[lane] = color;
    }
    row.charStyles[lane] = style;
  }
}

function calcGraphRows(commits, stashHashes, stashMap) {
  const rows = [];
  let lanes = [];
  let maxLanes = 0;
  const recoveryHashes = new Set(commits.filter(c => c.isRecovery).map(c => c.hash));

  for (const commit of commits) {
    const { hash, parents } = commit;

    let baseLane = lanes.indexOf(hash);
    if (baseLane === -1) {
      baseLane = lanes.indexOf(null);
      if (baseLane === -1) {
        baseLane = lanes.length;
        lanes.push(hash);
      } else {
        lanes[baseLane] = hash;
      }
    }

    const row = {
      type: 'commit',
      chars: [],
      charColors: [],
      charStyles: [],
      commitLane: baseLane,
      hash,
      ref: hash.substring(0, 7),
      decoration: '',
      subject: commit.subject,
      body: commit.body,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authorDate: commit.authorDate,
      committerName: commit.committerName,
      committerEmail: commit.committerEmail,
      committerDate: commit.committerDate,
      isRecovery: !!commit.isRecovery,
      recoveryRef: commit.recoveryRef || null,
    };

    const nodeStyle = commit.isRecovery ? STYLE_RECOVERY : STYLE_NORMAL;
    setCell(row, baseLane, commit.isRecovery ? '\u25cc' : '\u25cf', baseLane, nodeStyle);

    for (let lane = 0; lane < lanes.length; lane++) {
      if (lane === baseLane) continue;
      if (lanes[lane] === null) continue;
      setCell(row, lane, '\u2502', lane, laneStyleForHash(lanes[lane], recoveryHashes));
    }

    const merges = [];
    if (parents.length === 0) {
      lanes[baseLane] = null;
    } else {
      lanes[baseLane] = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        const existing = lanes.indexOf(parentHash);
        if (existing !== -1 && existing !== baseLane) {
          merges.push({ lane: existing, isNew: false, hash: parentHash });
        } else if (existing === -1) {
          let newLane = lanes.indexOf(null);
          if (newLane === -1) {
            newLane = lanes.length;
            lanes.push(parentHash);
          } else {
            lanes[newLane] = parentHash;
          }
          merges.push({ lane: newLane, isNew: true, hash: parentHash });
        }
      }
    }

    for (const merge of merges) {
      const style = commit.isRecovery || recoveryHashes.has(merge.hash) ? STYLE_RECOVERY : STYLE_NORMAL;
      addHorizontalConnector(row, baseLane, baseLane, style, merge.lane > baseLane);
      fillHorizontal(row, baseLane, merge.lane, merge.lane, style);
      if (merge.isNew) {
        setCell(row, merge.lane, merge.lane > baseLane ? '\u256e' : '\u256d', merge.lane, style);
      } else {
        addHorizontalConnector(row, merge.lane, merge.lane, style, baseLane > merge.lane);
      }
    }

    for (let lane = 0; lane < lanes.length; lane++) {
      if (lane === baseLane) continue;
      if (lanes[lane] !== hash) continue;
      setCell(row, lane, lane > baseLane ? '\u256f' : '\u2570', lane, laneStyleForHash(hash, recoveryHashes));
      fillHorizontal(row, baseLane, lane, lane, laneStyleForHash(hash, recoveryHashes));
      lanes[lane] = null;
    }

    let decoration = '';
    if (commit.refs) {
      decoration = ' (' + commit.refs + ')';
      const sRef = stashMap.get(row.ref);
      if (sRef) decoration = decoration.replace(/\)$/, ', ' + sRef + ')');
    } else {
      const sRef = stashMap.get(row.ref);
      if (sRef) decoration = ' (' + sRef + ')';
    }
    if (commit.isRecovery) {
      decoration = decoration
        ? decoration.replace(/\)$/, ', recovery)')
        : ' (recovery)';
    }
    row.decoration = decoration;
    rows.push(row);

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
    maxLanes = Math.max(maxLanes, lanes.length, row.chars.length);
  }

  for (const row of rows) {
    let nw = 1;
    for (let i = row.chars.length - 1; i >= 0; i--) {
      if (row.chars[i] !== ' ') { nw = i + 1; break; }
    }
    row.naturalWidth = nw;
  }

  for (const row of rows) {
    while (row.chars.length < maxLanes) {
      row.chars.push(' ');
      row.charColors.push(-1);
      row.charStyles.push(STYLE_NORMAL);
    }
  }

  return rows;
}

module.exports = { calcGraphRows };
