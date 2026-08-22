// 리커버리(reflog 에만 남은 유실) 가지가 (1) 끝까지 회색으로 그려지는지, (2) 살아있는
// 브랜치보다 항상 오른쪽 레인에 잡히는지 검증.
//
// (1) 간선의 주인은 부모가 아니라 자식 커밋이다. 레인이 가리키는 해시는 "다음에 올
//     부모"인데, 유실 커밋의 부모는 대개 도달 가능한 커밋이다. 그래서 레인이 가리키는
//     해시로 리커버리 여부를 판정하면 유실 커밋 아래 꼬리 구간과 본선에 합류하는 코너가
//     정상 레인색(초록/노랑/파랑...)으로 되살아난다.
// (2) 레인은 먼저 오는 커밋이 왼쪽부터 가져간다. 유실 커밋이 로그 위쪽(최신)에 있으면
//     왼쪽을 선점해, 뒤에 나오는 살아있는 브랜치 팁이 오른쪽으로 밀린다.
const test = require('node:test');
const assert = require('node:assert/strict');

const { calcGraphRows } = require('../graph');
const { renderCombinedGraphPixels } = require('../sixel');

const CELL_W = 8;
const CELL_H = 16;
const RECOVERY_COLOR = 9; // sixel 팔레트 #9 (160,160,160) — RECOVERY_TEXT 와 같은 회색
const H = n => String(n).padStart(40, '0');

const rowsOf = commits => calcGraphRows(commits, new Set(), new Map());
const shape = rows => rows.map(r => r.chars.join('').trimEnd()).join('|');
const styleOf = (rows, r, lane) => rows[r].charStyles[lane];
const hStyleOf = (rows, r, lane) => rows[r].charStylesH[lane];

test('유실 가지의 꼬리 구간과 합류 코너가 리커버리 스타일을 유지한다', () => {
  // 유실 커밋은 둘뿐이지만 R2 의 부모 M4 는 M2/M3 아래에 있어 레인1이 세 행을 더
  // 살아있다 — 그 구간이 회색을 유지해야 한다.
  const rows = rowsOf([
    { hash: H(1), parents: [H(2)], subject: 'main1' },
    { hash: H(10), parents: [H(11)], subject: 'lost1', isRecovery: true },
    { hash: H(11), parents: [H(4)], subject: 'lost2', isRecovery: true },
    { hash: H(2), parents: [H(3)], subject: 'main2' },
    { hash: H(3), parents: [H(4)], subject: 'main3' },
    { hash: H(4), parents: [H(5)], subject: 'main4' },
    { hash: H(5), parents: [], subject: 'main5' },
  ]);
  assert.equal(shape(rows), '●|│◌|│◌|●│|●│|●╯|●');

  assert.equal(styleOf(rows, 1, 1), 1, '유실 커밋 노드는 리커버리');
  assert.equal(styleOf(rows, 2, 1), 1, '유실 커밋 노드는 리커버리');
  assert.equal(styleOf(rows, 3, 1), 1, '유실 커밋 아래로 이어지는 세로선도 리커버리');
  assert.equal(styleOf(rows, 4, 1), 1, '유실 커밋 아래로 이어지는 세로선도 리커버리');
  assert.equal(styleOf(rows, 5, 1), 1, '본선에 합류하는 코너도 리커버리');

  for (let r = 0; r < rows.length; r++) {
    assert.equal(styleOf(rows, r, 0), 0, '레인0(본선)은 리커버리로 물들지 않는다: 행 ' + r);
  }
});

test('유실 커밋이 먼저 나와도 정상 레인을 선점하지 않는다', () => {
  const rows = rowsOf([
    { hash: H(10), parents: [H(1)], subject: 'lost', isRecovery: true },
    { hash: H(1), parents: [H(2)], subject: 'main1' },
    { hash: H(2), parents: [], subject: 'main2' },
  ]);
  assert.equal(shape(rows), ' ◌|●╯|●', '유실 커밋은 레인0을 비우고 레인1로 간다');
  assert.equal(rows[1].commitLane, 0, '살아있는 커밋이 레인0을 쓴다');
  assert.equal(styleOf(rows, 1, 1), 1, '합류 코너는 리커버리');
});

test('리커버리 레인은 살아있는 브랜치보다 항상 오른쪽에 잡힌다', () => {
  // 유실 커밋 셋이 로그 맨 위에 몰려 있고, 브랜치 팁 둘이 그 아래에 온다.
  const rows = rowsOf([
    { hash: H(20), parents: [H(21)], subject: 'lost tip', isRecovery: true },
    { hash: H(21), parents: [H(3)], subject: 'lost 2', isRecovery: true },
    { hash: H(22), parents: [H(3)], subject: 'lost other', isRecovery: true },
    { hash: H(1), parents: [H(2)], subject: 'feat 팁' },
    { hash: H(4), parents: [H(2)], subject: 'main 팁' },
    { hash: H(2), parents: [H(3)], subject: 'main~1' },
    { hash: H(3), parents: [], subject: '분기점' },
  ]);

  // 정상 커밋만으로는 레인 두 개면 충분하므로 리커버리는 레인2부터 시작한다.
  const recoveryLanes = new Set();
  const normalLanes = new Set();
  for (const row of rows) {
    (row.isRecovery ? recoveryLanes : normalLanes).add(row.commitLane);
    for (let lane = 0; lane < row.charStyles.length; lane++) {
      const ch = row.chars[lane];
      // 순수 수평 획은 레인이 아니라 합류선이 지나간 자리다.
      if (ch === ' ' || ch === '─') continue;
      (row.charStyles[lane] === 1 ? recoveryLanes : normalLanes).add(lane);
    }
  }
  const rightmostNormal = Math.max(...normalLanes);
  const leftmostRecovery = Math.min(...recoveryLanes);
  assert.ok(
    leftmostRecovery > rightmostNormal,
    '리커버리 레인(' + [...recoveryLanes].sort() + ')이 정상 레인(' +
      [...normalLanes].sort() + ')보다 오른쪽이어야 한다',
  );
});

test('리커버리 합류선이 관통해도 살아있는 레인은 제 색을 지킨다', () => {
  const rows = rowsOf([
    { hash: H(1), parents: [H(2)], subject: 'main 팁' },
    { hash: H(4), parents: [H(3)], subject: 'feat 팁' },   // 레인1에서 계속 살아있다
    { hash: H(20), parents: [H(2)], subject: 'lost', isRecovery: true },
    { hash: H(2), parents: [H(3)], subject: '리커버리가 합류하는 행' },
    { hash: H(3), parents: [], subject: '분기점' },
  ]);
  assert.equal(shape(rows), '●|│●|││◌|●┼╯|●╯');

  const crossRow = 3;
  assert.equal(styleOf(rows, crossRow, 1), 0, '관통당한 레인의 세로획은 정상');
  assert.equal(hStyleOf(rows, crossRow, 1), 1, '관통하는 수평획만 리커버리');

  // 픽셀로도 확인: 같은 칸에서 세로획은 레인색, 수평획은 회색.
  const numCols = 3;
  const pw = numCols * CELL_W;
  const buf = renderCombinedGraphPixels(rows, numCols, CELL_W, CELL_H, null, null);
  const cx = CELL_W + (CELL_W >> 1);
  const top = crossRow * CELL_H;
  const cy = top + (CELL_H >> 1);

  const laneColor = (rows[crossRow].charColors[1] % 6) + 1;
  assert.notEqual(laneColor, RECOVERY_COLOR);
  assert.equal(buf[top * pw + cx], laneColor, '칸 위쪽 세로획은 레인색이어야 한다');
  // 점선이라 특정 x 한 점은 비어 있을 수 있어 칸을 훑어서 본다. 칸 한가운데는 세로획이
  // 지나가므로, 수평획만 남는 왼쪽 구간만 센다.
  const hRun = [];
  for (let x = CELL_W; x <= cx - 2; x++) hRun.push(buf[cy * pw + x]);
  assert.ok(hRun.includes(RECOVERY_COLOR), '칸을 지나는 수평획은 회색이어야 한다');
  assert.ok(!hRun.includes(laneColor), '수평획이 레인색으로 새어 나오면 안 된다');
});

test('리커버리가 없으면 레인 배치는 그대로다', () => {
  const commits = [
    { hash: H(1), parents: [H(2), H(3)], subject: 'merge' },
    { hash: H(2), parents: [H(4)], subject: 'first parent' },
    { hash: H(3), parents: [H(4)], subject: 'merge parent' },
    { hash: H(4), parents: [], subject: 'base' },
  ];
  assert.equal(shape(rowsOf(commits)), '●╮|●│|│●|●╯');
});

test('리커버리 세로선은 살아있는 레인보다 가늘고 끊어져 있다', () => {
  // rows[1] = "│◌" (레인0 = 살아있는 통과선), rows[3] = "●│" (레인1 = 리커버리 통과선)
  const rows = rowsOf([
    { hash: H(1), parents: [H(2)], subject: 'main1' },
    { hash: H(10), parents: [H(11)], subject: 'lost1', isRecovery: true },
    { hash: H(11), parents: [H(4)], subject: 'lost2', isRecovery: true },
    { hash: H(2), parents: [H(3)], subject: 'main2' },
    { hash: H(3), parents: [H(4)], subject: 'main3' },
    { hash: H(4), parents: [], subject: 'main4' },
  ]);
  const numCols = 2;
  const pw = numCols * CELL_W;
  const buf = renderCombinedGraphPixels(rows, numCols, CELL_W, CELL_H, null, null);

  // 한 행 안에서 그 레인 칸이 몇 줄이나 칠해졌는지(=연속성), 가장 두꺼운 줄이 몇 px 인지.
  const measure = (rowIdx, lane) => {
    let painted = 0;
    let width = 0;
    for (let y = rowIdx * CELL_H; y < (rowIdx + 1) * CELL_H; y++) {
      let w = 0;
      for (let x = lane * CELL_W; x < (lane + 1) * CELL_W; x++) if (buf[y * pw + x]) w++;
      if (w > 0) painted++;
      if (w > width) width = w;
    }
    return { painted, width };
  };

  const live = measure(1, 0);
  const lost = measure(3, 1);
  assert.equal(live.painted, CELL_H, '살아있는 레인은 행 전체가 이어진 실선');
  assert.ok(lost.painted > 0, '리커버리 레인도 그려지긴 해야 한다');
  assert.ok(lost.painted < live.painted, '리커버리 레인은 끊어져 있어야 한다: ' + lost.painted);
  assert.ok(lost.width < live.width, '리커버리 레인이 더 가늘어야 한다: ' + lost.width + ' vs ' + live.width);
});
