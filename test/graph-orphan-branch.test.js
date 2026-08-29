// 끊어진(orphan) 브랜치가 바로 아래 브랜치와 한 줄기로 보이지 않는지 검증.
//
// 부모 없는 root 커밋은 제 레인을 곧바로 비우고, 다음 커밋이 그 레인 인덱스를 재사용한다.
// 그런데 (1) 렌더러가 이웃 행 글자만 보고 "위/아래가 ● 니까 이어진다"로 판정하고,
// (2) 레인 색이 레인 인덱스에서 나오다 보니, 서로 아무 관계도 없는 두 가지가 같은 열에
// 같은 색으로 이어 그려졌다. (예: origin/new-main 의 root 커밋 01f4717 이 그 아래
// origin/main 팁과 한 브랜치처럼 보이던 문제)
const test = require('node:test');
const assert = require('node:assert/strict');

const { calcGraphRows } = require('../graph');
const { renderCombinedGraphPixels } = require('../sixel');

const CELL_W = 8;
const CELL_H = 16;
const H = n => String(n).padStart(40, '0');

// 한 행·한 레인 셀에서 노드(원) 위/아래로 칠해진 픽셀 수와 노드 자체의 색을 센다.
function nodePixels(buf, pw, rowIdx, lane) {
  const cx = lane * CELL_W + (CELL_W >> 1);
  const top = rowIdx * CELL_H;
  const cy = top + (CELL_H >> 1);
  const dotR = Math.max(2, Math.round(CELL_W * 0.375));
  let above = 0, below = 0;
  for (let y = top; y < cy - dotR; y++) if (buf[y * pw + cx]) above++;
  for (let y = cy + dotR + 1; y < top + CELL_H; y++) if (buf[y * pw + cx]) below++;
  return { above, below, color: buf[cy * pw + cx] };
}

// origin/new-main(고아 root) 하나, 그 아래 origin/main 사슬.
function buildRows() {
  return calcGraphRows([
    { hash: H(1), parents: [], subject: 'orphan root' },
    { hash: H(2), parents: [H(3)], subject: 'main 팁' },
    { hash: H(3), parents: [], subject: 'main root' },
  ], new Set(), new Map());
}

test('고아 root 커밋은 위아래 어디로도 세로선을 뻗지 않는다', () => {
  const rows = buildRows();
  assert.equal(rows[0].nodeUp, false, '자식이 없으므로 위로 이어질 획이 없다');
  assert.equal(rows[0].nodeDown, false, '부모가 없으므로 아래로 이어질 획이 없다');
  assert.equal(rows[1].commitLane, 0, '다음 커밋은 비워진 레인0을 재사용한다');

  const buf = renderCombinedGraphPixels(rows, 1, CELL_W, CELL_H);
  const orphan = nodePixels(buf, CELL_W, 0, 0);
  assert.equal(orphan.above, 0, '고아 커밋 위에는 선이 없어야 한다');
  assert.equal(orphan.below, 0, '고아 커밋 아래로 다음 브랜치와 이어지면 안 된다');

  const tip = nodePixels(buf, CELL_W, 1, 0);
  assert.equal(tip.above, 0, '브랜치 팁 위로 앞 커밋과 이어지면 안 된다');
  assert.ok(tip.below > 0, '팁은 제 부모 쪽으로 이어져야 한다');
});

test('레인을 재사용해도 색은 물려받지 않는다', () => {
  const rows = buildRows();
  const buf = renderCombinedGraphPixels(rows, 1, CELL_W, CELL_H);
  const orphan = nodePixels(buf, CELL_W, 0, 0);
  const tip = nodePixels(buf, CELL_W, 1, 0);
  const root = nodePixels(buf, CELL_W, 2, 0);

  assert.notEqual(orphan.color, tip.color, '끊어진 두 가지는 다른 색이어야 한다');
  assert.equal(tip.color, root.color, '한 사슬로 이어진 레인은 같은 색을 유지한다');
});

test('한 가지가 계속 이어지는 동안에는 색이 흔들리지 않는다', () => {
  const rows = calcGraphRows([
    { hash: H(1), parents: [H(2), H(3)], subject: 'merge' },
    { hash: H(3), parents: [H(2)], subject: '갈라진 가지' },
    { hash: H(2), parents: [H(4)], subject: '분기점' },
    { hash: H(4), parents: [], subject: 'root' },
  ], new Set(), new Map());

  const base = rows[0].charColors[0];
  for (const row of rows) {
    assert.equal(row.charColors[row.commitLane === 0 ? 0 : row.commitLane] >= 0, true);
  }
  assert.equal(rows[2].charColors[0], base, '레인0 은 끝까지 같은 색이다');
  assert.equal(rows[3].charColors[0], base, '레인0 은 끝까지 같은 색이다');
  assert.notEqual(rows[1].charColors[1], base, '갈라져 나온 레인1 은 다른 색을 받는다');
});
