const STYLE_NORMAL = 0;
const STYLE_RECOVERY = 1;

function ensureWidth(row, width) {
  while (row.chars.length <= width) {
    row.chars.push(' ');
    row.charColors.push(-1);
    row.charColorsH.push(-1);
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
  row.charColorsH[lane] = -1; // 단색 셀 — 수평 전용 색 초기화
  row.charStyles[lane] = style;
}

function addHorizontalConnector(row, lane, color, style, towardRight) {
  if (lane < 0) return;
  ensureWidth(row, lane);
  const existing = row.chars[lane];
  if (existing === ' ') {
    row.chars[lane] = '\u2500';
    row.charColors[lane] = color; // \uc21c\uc218 \uc218\ud3c9 \u2014 \ub2e8\uc0c9
  } else if (existing === '\u2502') {
    // \uc138\ub85c\uc120 \uc704\uc5d0 \uc218\ud3c9 \uc2a4\ud141 \u2192 \u251c/\u2524. \uc138\ub85c\uc0c9\uc740 \uc720\uc9c0\ud558\uace0 \uc218\ud3c9\uc0c9\ub9cc \ub530\ub85c \uae30\ub85d.
    row.chars[lane] = towardRight ? '\u251c' : '\u2524';
    row.charColorsH[lane] = color;
  } else if (existing === '\u2500') {
    row.charColors[lane] = color; // already horizontal
  } else if (
    existing === '\u256d' || existing === '\u256e' || existing === '\u256f' || existing === '\u2570' ||
    existing === '\u251c' || existing === '\u2524'
  ) {
    // \ucf54\ub108/\uae30\uc874 T \uc704\uc5d0 \uad50\ucc28 \u2192 \u253c. \uae30\uc874(\uc138\ub85c \ubc29\ud5a5) \uc0c9\uc740 \ub450\uace0 \uc218\ud3c9\uc0c9\ub9cc \uae30\ub85d.
    row.chars[lane] = '\u253c';
    row.charColorsH[lane] = color;
  } else {
    row.charColors[lane] = color;
  }
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
      // \uc218\ud3c9 \ubcd1\ud569\uc120\uc774 \uc138\ub85c \ub808\uc778\uc744 \uad00\ud1b5 \u2192 \u253c. \uc138\ub85c\uc0c9(charColors)\uc740 \uadf8\ub300\ub85c \ub450\uace0
      // \uc218\ud3c9\uc120 \uc790\uccb4 \uc0c9\uc744 charColorsH\uc5d0 \uae30\ub85d\ud574, sixel\uc774 \ub450 \ud68d\uc744 \uac01\uac01 \uc81c \uc0c9\uc73c\ub85c \uadf8\ub9b0\ub2e4.
      row.chars[lane] = '\u253c';
      row.charColorsH[lane] = color;
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
      charColorsH: [], // 수평 획 전용 색(-1이면 charColors 사용) — 교차/T 지점 색 유지용
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
      // \uc774 \uc140\uc744 \uc774\ubbf8 \uc9c0\ub098\uac00\ub358 \uc218\ud3c9 \ubcd1\ud569\uc120\uc758 \uc0c9(\uc788\uc73c\uba74)\uc744 \ubcf4\uc874\ud55c\ub2e4. setCell\uc774 \ucf54\ub108\ub85c
      // \ub36e\uc73c\uba74\uc11c charColorsH\ub97c \ucd08\uae30\ud654\ud558\ub294\ub370, \uadf8 \uac12\uc744 \ub418\uc0b4\ub824\uc57c \ub80c\ub354\uac00 \uad00\ud1b5 \uc218\ud3c9\uc120\uc744
      // \uc6d0\ub798 \uc0c9\uc73c\ub85c \uc774\uc5b4 \uadf8\ub9b4 \uc218 \uc788\ub2e4(\ucf54\ub108\uac00 \uc218\ud3c9\uc120 \uc911\uac04\uc744 \ub04a\uc9c0 \uc54a\ub3c4\ub85d).
      const priorH = row.charColorsH[lane];
      setCell(row, lane, lane > baseLane ? '\u256f' : '\u2570', lane, laneStyleForHash(hash, recoveryHashes));
      if (priorH >= 0) row.charColorsH[lane] = priorH;
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
      row.charColorsH.push(-1);
      row.charStyles.push(STYLE_NORMAL);
    }
  }

  return rows;
}

module.exports = { calcGraphRows };
