const STYLE_NORMAL = 0;
const STYLE_RECOVERY = 1;

function ensureWidth(row, width) {
  while (row.chars.length <= width) {
    row.chars.push(' ');
    row.charColors.push(-1);
    row.charColorsH.push(-1);
    row.charStyles.push(STYLE_NORMAL);
    row.charStylesH.push(-1);
  }
}

function setCell(row, lane, ch, color, style) {
  if (lane < 0) return;
  ensureWidth(row, lane);
  row.chars[lane] = ch;
  row.charColors[lane] = color;
  row.charColorsH[lane] = -1; // 단색 셀 — 수평 전용 색/스타일 초기화
  row.charStylesH[lane] = -1;
  row.charStyles[lane] = style;
}

function addHorizontalConnector(row, lane, color, style, towardRight) {
  if (lane < 0) return;
  ensureWidth(row, lane);
  const existing = row.chars[lane];
  if (existing === ' ') {
    row.chars[lane] = '\u2500';
    row.charColors[lane] = color; // 순수 수평 — 단색
    row.charStyles[lane] = style;
  } else if (existing === '\u2502') {
    // 세로선 위에 수평 스텁 → ├/┤. 세로 획의 색·스타일은 두고 수평 것만 따로 기록한다.
    row.chars[lane] = towardRight ? '\u251c' : '\u2524';
    row.charColorsH[lane] = color;
    row.charStylesH[lane] = style;
  } else if (existing === '\u2500') {
    row.charColors[lane] = color; // already horizontal
    row.charStyles[lane] = style;
  } else if (
    existing === '\u256d' || existing === '\u256e' || existing === '\u256f' || existing === '\u2570' ||
    existing === '\u251c' || existing === '\u2524'
  ) {
    // 코너/기존 T 위에 교차 → ┼. 기존(세로 방향) 색·스타일은 두고 수평 것만 기록.
    row.chars[lane] = '\u253c';
    row.charColorsH[lane] = color;
    row.charStylesH[lane] = style;
  } else {
    row.charColors[lane] = color;
    row.charStyles[lane] = style;
  }
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
      // 수평 병합선이 세로 레인을 관통 → ┼. 세로 획의 색(charColors)과 스타일(charStyles)은
      // 그대로 두고 수평선 것만 charColorsH/charStylesH 에 기록해, sixel 이 두 획을 각각 제
      // 색으로 그린다. 리커버리 합류선이 살아있는 브랜치를 지나가도 그 레인은 제 색을 지킨다.
      row.chars[lane] = '\u253c';
      row.charColorsH[lane] = color;
      row.charStylesH[lane] = style;
    } else if (existing === ' ') {
      row.chars[lane] = '\u2500';
      row.charColors[lane] = color;
      row.charStyles[lane] = style;
    }
  }
}

// 리커버리(reflog 에만 남은 유실) 가지는 살아있는 브랜치보다 항상 오른쪽에 둔다.
// 그러려면 "지금 살아있는 레인보다 오른쪽" 같은 그때그때 규칙으로는 모자란다 — 유실
// 커밋이 로그 위쪽에 먼저 나오면 밀어낼 정상 레인이 아직 없어 왼쪽을 선점해 버리고,
// 뒤늦게 등장한 브랜치 팁이 오른쪽으로 밀린다. 그래서 정상 커밋만으로 레인 폭을 먼저
// 재고 그 바깥을 리커버리 구역으로 예약한다. 도달 가능한 커밋의 부모는 언제나 도달
// 가능하므로, 리커버리를 빼도 정상 서브그래프의 레인 배치는 달라지지 않는다.
function countNormalLanes(commits) {
  const lanes = [];
  let max = 0;
  for (const commit of commits) {
    if (commit.isRecovery) {
      // 정상 커밋이 유실 커밋을 부모로 갖는 일은 없다(도달 가능한 커밋의 부모는 도달
      // 가능하다). 그래도 reflog 스냅숏과 로그가 어긋나 그런 데이터가 들어오면, 그 레인이
      // 영영 닫히지 않아 예약 폭이 끝없이 부푼다 — 여기서 끊어 준다.
      for (let lane = 0; lane < lanes.length; lane++) {
        if (lanes[lane] === commit.hash) lanes[lane] = null;
      }
      while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
      continue;
    }
    const { hash, parents } = commit;

    let base = lanes.indexOf(hash);
    if (base === -1) {
      base = lanes.indexOf(null);
      if (base === -1) { base = lanes.length; lanes.push(hash); }
      else lanes[base] = hash;
    }

    if (parents.length === 0) {
      lanes[base] = null;
    } else {
      lanes[base] = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        if (lanes.indexOf(parentHash) !== -1) continue;
        let newLane = lanes.indexOf(null);
        if (newLane === -1) { newLane = lanes.length; lanes.push(parentHash); }
        else lanes[newLane] = parentHash;
      }
    }

    // 이 행이 실제로 쓴 폭. 아래에서 닫혀 사라질 레인도 이 행에는 그려지므로 먼저 센다.
    if (base + 1 > max) max = base + 1;
    if (lanes.length > max) max = lanes.length;

    for (let lane = 0; lane < lanes.length; lane++) {
      if (lane !== base && lanes[lane] === hash) lanes[lane] = null;
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  }
  return max;
}

// 정상 레인은 [0, recoveryBase), 리커버리 레인은 [recoveryBase, ...) 안에서만 고른다.
function laneRange(lanes, style, recoveryBase) {
  return style === STYLE_RECOVERY
    ? { from: recoveryBase, to: lanes.length }
    : { from: 0, to: Math.min(lanes.length, recoveryBase) };
}

function findLane(lanes, hash, style, recoveryBase) {
  const { from, to } = laneRange(lanes, style, recoveryBase);
  for (let lane = from; lane < to; lane++) {
    if (lanes[lane] === hash) return lane;
  }
  return -1;
}

function takeLane(lanes, laneStyles, hash, style, recoveryBase) {
  const { from, to } = laneRange(lanes, style, recoveryBase);
  for (let lane = from; lane < to; lane++) {
    if (lanes[lane] === null) {
      lanes[lane] = hash;
      laneStyles[lane] = style;
      return lane;
    }
  }
  // 리커버리 구역이 아직 열리지 않았으면 예약 폭만큼 빈 레인으로 메우고 그 뒤에 붙인다.
  while (lanes.length < from) {
    lanes.push(null);
    laneStyles.push(STYLE_NORMAL);
  }
  lanes.push(hash);
  laneStyles.push(style);
  return lanes.length - 1;
}

function calcGraphRows(commits, stashHashes, stashMap) {
  const rows = [];
  let lanes = [];
  // 간선의 주인은 부모가 아니라 자식 커밋이다. 레인이 가리키는 해시(= 다음에 올 부모)로
  // 리커버리 여부를 판정하면, 유실 커밋의 부모는 대개 도달 가능한 커밋이라 리커버리 가지의
  // 꼬리 구간이 정상 레인색으로 되살아난다. 그래서 레인별로 간선 스타일을 따로 들고 간다.
  let laneStyles = [];
  let maxLanes = 0;
  const recoveryBase = countNormalLanes(commits);

  for (const commit of commits) {
    const { hash, parents } = commit;
    const nodeStyle = commit.isRecovery ? STYLE_RECOVERY : STYLE_NORMAL;

    // 같은 구역 안에서만 제 레인을 찾는다. 유실 커밋이 예약해 둔 레인이 정상 커밋을
    // 가리키고 있어도 그 커밋은 정상 구역에 자리를 잡고, 리커버리 레인은 아래의 코너
    // 처리에서 ╯ 로 합류시킨다.
    let baseLane = findLane(lanes, hash, nodeStyle, recoveryBase);
    if (baseLane === -1) baseLane = takeLane(lanes, laneStyles, hash, nodeStyle, recoveryBase);

    const row = {
      type: 'commit',
      chars: [],
      charColors: [],
      charColorsH: [], // 수평 획 전용 색(-1이면 charColors 사용) — 교차/T 지점 색 유지용
      charStyles: [],
      charStylesH: [], // 수평 획 전용 스타일(-1이면 charStyles 사용)
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

    setCell(row, baseLane, commit.isRecovery ? '\u25cc' : '\u25cf', baseLane, nodeStyle);

    for (let lane = 0; lane < lanes.length; lane++) {
      if (lane === baseLane) continue;
      if (lanes[lane] === null) continue;
      setCell(row, lane, '\u2502', lane, laneStyles[lane]);
    }

    const merges = [];
    if (parents.length === 0) {
      lanes[baseLane] = null;
      laneStyles[baseLane] = STYLE_NORMAL;
    } else {
      lanes[baseLane] = parents[0];
      laneStyles[baseLane] = nodeStyle;
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        const existing = lanes.indexOf(parentHash);
        if (existing !== -1 && existing !== baseLane) {
          merges.push({ lane: existing, isNew: false, hash: parentHash });
        } else if (existing === -1) {
          const newLane = takeLane(lanes, laneStyles, parentHash, nodeStyle, recoveryBase);
          merges.push({ lane: newLane, isNew: true, hash: parentHash });
        }
      }
    }

    for (const merge of merges) {
      const style = nodeStyle;
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
      const priorSH = row.charStylesH[lane];
      const closeStyle = laneStyles[lane];
      setCell(row, lane, lane > baseLane ? '\u256f' : '\u2570', lane, closeStyle);
      if (priorH >= 0) row.charColorsH[lane] = priorH;
      if (priorSH >= 0) row.charStylesH[lane] = priorSH;
      fillHorizontal(row, baseLane, lane, lane, closeStyle);
      lanes[lane] = null;
      laneStyles[lane] = STYLE_NORMAL;
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
      laneStyles.pop();
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
      row.charStylesH.push(-1);
    }
  }

  return rows;
}

module.exports = { calcGraphRows };
