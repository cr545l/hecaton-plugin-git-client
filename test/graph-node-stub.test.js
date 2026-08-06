// 커밋 노드에 붙을 데 없는 세로 "꼬다리"가 생기지 않는지 검증.
//
// 그래프는 레인이 비면 그 인덱스를 다음 커밋이 재사용한다. 그런데 바로 위 행에서
// 머지 수평선(─)이 그 빈 레인을 관통하고 지나갔다면, 렌더러가 "빈 칸이 아니다"만
// 보고 위쪽 연결로 오판해 노드 위에 반 칸짜리 세로선을 그린다 — 위에는 이어질 게
// 없으므로 꼬다리로 보인다. (예: origin/gitops/prod 팁 c4343f9)
const test = require('node:test');
const assert = require('node:assert/strict');

const { calcGraphRows } = require('../graph');
const { renderCombinedGraphPixels } = require('../sixel');

const CELL_W = 8;
const CELL_H = 16;
const H = n => String(n).padStart(40, '0');

// 레인1이 빈 상태에서 레인0→레인2 머지 수평선이 그 위를 지나가고,
// 다음 행의 브랜치 팁 커밋이 빈 레인1을 재사용하는 최소 그래프.
function buildRows() {
  const commits = [
    { hash: H(1), parents: [H(2), H(3)], subject: 'merge' },
    { hash: H(2), parents: [H(4), H(5)], subject: 'merge' },
    { hash: H(3), parents: [], subject: 'lane1 종료' },
    { hash: H(4), parents: [H(6), H(5)], subject: '빈 레인1을 관통하는 머지' },
    { hash: H(7), parents: [H(8)], subject: '빈 레인1을 재사용하는 팁' },
    { hash: H(8), parents: [], subject: 'tip 부모' },
  ];
  return calcGraphRows(commits, new Set(), new Map());
}

// 한 행·한 레인 셀에서 노드(원) 위/아래로 칠해진 픽셀이 있는지 센다.
function verticalPixels(buf, pw, rowIdx, lane) {
  const cx = lane * CELL_W + (CELL_W >> 1);
  const top = rowIdx * CELL_H;
  const cy = top + (CELL_H >> 1);
  const dotR = Math.max(2, Math.round(CELL_W * 0.375));
  let above = 0, below = 0;
  for (let y = top; y < cy - dotR; y++) if (buf[y * pw + cx]) above++;
  for (let y = cy + dotR + 1; y < top + CELL_H; y++) if (buf[y * pw + cx]) below++;
  return { above, below };
}

test('빈 레인을 재사용한 노드 위에는 꼬다리가 없다', () => {
  const rows = buildRows();
  assert.equal(rows[3].chars.join(''), '●─┤', '위 행은 빈 레인1을 수평선이 관통해야 한다');
  assert.equal(rows[4].commitLane, 1, '팁 커밋이 빈 레인1을 재사용해야 한다');

  const numCols = 3;
  const buf = renderCombinedGraphPixels(rows, numCols, CELL_W, CELL_H, null, null);
  const { above, below } = verticalPixels(buf, numCols * CELL_W, 4, 1);

  assert.equal(above, 0, '위 행의 수평선은 세로 연결이 아니므로 노드 위 세로선이 없어야 한다');
  assert.ok(below > 0, '부모가 이어지는 아래쪽으로는 세로선이 있어야 한다');
});

test('레인이 실제로 이어지면 노드 위아래 세로선은 그대로 그린다', () => {
  const commits = [
    { hash: H(1), parents: [H(2)], subject: 'a' },
    { hash: H(2), parents: [H(3)], subject: 'b' },
    { hash: H(3), parents: [], subject: 'c' },
  ];
  const rows = calcGraphRows(commits, new Set(), new Map());
  const buf = renderCombinedGraphPixels(rows, 1, CELL_W, CELL_H, null, null);
  const mid = verticalPixels(buf, CELL_W, 1, 0);
  assert.ok(mid.above > 0 && mid.below > 0, '가운데 커밋은 위아래 모두 이어져야 한다');

  const last = verticalPixels(buf, CELL_W, 2, 0);
  assert.equal(last.below, 0, '부모가 없는 마지막 커밋 아래로는 선이 없어야 한다');
});

test('머지로 새로 갈라진 레인의 첫 노드는 코너와 이어진다', () => {
  const commits = [
    { hash: H(1), parents: [H(2), H(3)], subject: 'merge' }, // lane0 ●, lane1 ╮
    { hash: H(2), parents: [], subject: 'first parent' },
    { hash: H(3), parents: [], subject: 'merge parent' },    // lane1 ●
  ];
  const rows = calcGraphRows(commits, new Set(), new Map());
  assert.equal(rows[0].chars.join(''), '●╮');
  assert.equal(rows[2].commitLane, 1);

  const buf = renderCombinedGraphPixels(rows, 2, CELL_W, CELL_H, null, null);
  // ╮ 는 아래 가장자리까지 내려오므로, 그 아래 노드는 위로 이어져야 한다.
  const { above } = verticalPixels(buf, 2 * CELL_W, 2, 1);
  assert.ok(above > 0, '╮ 에서 내려온 레인의 노드는 위쪽 세로선을 그려야 한다');
});
