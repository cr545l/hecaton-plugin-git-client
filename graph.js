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
    // 노드(●/◌)나 이미 교차(┼)가 된 칸 — 그 칸의 제 색·스타일은 두고 수평 스텁만
    // 따로 기록한다. 노드 색을 머지 상대 레인 색으로 덮으면 커밋 점 하나만 딴 가지
    // 색으로 튄다.
    row.charColorsH[lane] = color;
    row.charStylesH[lane] = style;
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

// 레인 인덱스를 그대로 색으로 쓰면, 닫힌 레인을 뒤 커밋이 재사용할 때 색까지 물려받는다.
// 그러면 아무 관계도 없는 두 가지가 같은 열에 같은 색으로 이어 찍혀 한 줄기로 읽힌다
// (orphan 브랜치의 root 커밋이 바로 아래 main 팁과 한 브랜치처럼 보이던 문제). 레인을
// 새로 열 때마다, 지금 살아있는 레인들이 쓰지 않는 색을 순서대로 골라 준다.
const LANE_COLORS = 6; // sixel 팔레트의 그래프용 색 개수

function pickLaneColor(lanes, laneColors, colorCursor) {
  const used = new Set();
  for (let lane = 0; lane < lanes.length; lane++) {
    if (lanes[lane] !== null) used.add(laneColors[lane]);
  }
  for (let step = 0; step < LANE_COLORS; step++) {
    const color = (colorCursor.next + step) % LANE_COLORS;
    if (!used.has(color)) {
      colorCursor.next = (color + 1) % LANE_COLORS;
      return color;
    }
  }
  // 레인이 색 수보다 많으면 겹칠 수밖에 없다 — 그때는 그냥 다음 순번을 쓴다.
  const color = colorCursor.next % LANE_COLORS;
  colorCursor.next = (color + 1) % LANE_COLORS;
  return color;
}

function takeLane(lanes, laneStyles, laneColors, colorCursor, hash, style, recoveryBase) {
  const { from, to } = laneRange(lanes, style, recoveryBase);
  for (let lane = from; lane < to; lane++) {
    if (lanes[lane] === null) {
      const color = pickLaneColor(lanes, laneColors, colorCursor);
      lanes[lane] = hash;
      laneStyles[lane] = style;
      laneColors[lane] = color;
      return lane;
    }
  }
  // 리커버리 구역이 아직 열리지 않았으면 예약 폭만큼 빈 레인으로 메우고 그 뒤에 붙인다.
  while (lanes.length < from) {
    lanes.push(null);
    laneStyles.push(STYLE_NORMAL);
    laneColors.push(0);
  }
  const color = pickLaneColor(lanes, laneColors, colorCursor);
  lanes.push(hash);
  laneStyles.push(style);
  laneColors.push(color);
  return lanes.length - 1;
}

function calcGraphRows(commits, stashHashes, stashMap) {
  const rows = [];
  let lanes = [];
  // 간선의 주인은 부모가 아니라 자식 커밋이다. 레인이 가리키는 해시(= 다음에 올 부모)로
  // 리커버리 여부를 판정하면, 유실 커밋의 부모는 대개 도달 가능한 커밋이라 리커버리 가지의
  // 꼬리 구간이 정상 레인색으로 되살아난다. 그래서 레인별로 간선 스타일을 따로 들고 간다.
  let laneStyles = [];
  // 레인별 색. 인덱스와 분리해 두어야 레인을 재사용해도 색이 따라오지 않는다.
  let laneColors = [];
  const colorCursor = { next: 0 };
  let maxLanes = 0;
  const recoveryBase = countNormalLanes(commits);

  for (const commit of commits) {
    const { hash, parents } = commit;
    const nodeStyle = commit.isRecovery ? STYLE_RECOVERY : STYLE_NORMAL;

    // 같은 구역 안에서만 제 레인을 찾는다. 유실 커밋이 예약해 둔 레인이 정상 커밋을
    // 가리키고 있어도 그 커밋은 정상 구역에 자리를 잡고, 리커버리 레인은 아래의 코너
    // 처리에서 ╯ 로 합류시킨다.
    let baseLane = findLane(lanes, hash, nodeStyle, recoveryBase);
    // 레인을 물려받았다는 건 위쪽에 이 커밋을 부모로 삼은 자식이 있었다는 뜻이다.
    // 새로 연 레인이면 이 커밋이 가지의 팁이므로 노드 위로 이어질 획이 없다.
    const nodeUp = baseLane !== -1;
    if (baseLane === -1) baseLane = takeLane(lanes, laneStyles, laneColors, colorCursor, hash, nodeStyle, recoveryBase);

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
      // 노드에서 위/아래로 세로 획을 뻗을지. 이웃 행의 글자만 보고 추측하면 빈 레인을
      // 재사용한 노드가 앞 브랜치와 이어져 버린다 — 그래프 구조로 직접 정한다.
      nodeUp,
      nodeDown: parents.length > 0,
    };

    setCell(row, baseLane, commit.isRecovery ? '\u25cc' : '\u25cf', laneColors[baseLane], nodeStyle);

    for (let lane = 0; lane < lanes.length; lane++) {
      if (lane === baseLane) continue;
      if (lanes[lane] === null) continue;
      setCell(row, lane, '\u2502', laneColors[lane], laneStyles[lane]);
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
          const newLane = takeLane(lanes, laneStyles, laneColors, colorCursor, parentHash, nodeStyle, recoveryBase);
          merges.push({ lane: newLane, isNew: true, hash: parentHash });
        }
      }
    }

    for (const merge of merges) {
      const style = nodeStyle;
      const color = laneColors[merge.lane];
      addHorizontalConnector(row, baseLane, color, style, merge.lane > baseLane);
      fillHorizontal(row, baseLane, merge.lane, color, style);
      if (merge.isNew) {
        setCell(row, merge.lane, merge.lane > baseLane ? '\u256e' : '\u256d', color, style);
      } else {
        addHorizontalConnector(row, merge.lane, color, style, baseLane > merge.lane);
      }
    }

    for (let lane = 0; lane < lanes.length; lane++) {
      if (lane === baseLane) continue;
      if (lanes[lane] !== hash) continue;
      // 이 셀을 이미 지나가던 수평 병합선의 색(있으면)을 보존한다. setCell이 코너로
      // 덮으면서 charColorsH를 초기화하는데, 그 값을 되살려야 렌더가 관통 수평선을
      // 원래 색으로 이어 그릴 수 있다(코너가 수평선 중간을 끊지 않도록).
      const priorH = row.charColorsH[lane];
      const priorSH = row.charStylesH[lane];
      const closeStyle = laneStyles[lane];
      const closeColor = laneColors[lane];
      setCell(row, lane, lane > baseLane ? '\u256f' : '\u2570', closeColor, closeStyle);
      if (priorH >= 0) row.charColorsH[lane] = priorH;
      if (priorSH >= 0) row.charStylesH[lane] = priorSH;
      fillHorizontal(row, baseLane, lane, closeColor, closeStyle);
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
      laneColors.pop();
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
