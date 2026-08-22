// 리커버리(reflog 에만 남은 유실) 가지가 끝까지 회색으로 그려지는지 검증.
//
// 간선의 주인은 부모가 아니라 자식 커밋이다. 레인이 가리키는 해시는 "다음에 올
// 부모"인데, 유실 커밋의 부모는 대개 도달 가능한 커밋이다. 그래서 레인이 가리키는
// 해시로 리커버리 여부를 판정하면 유실 커밋 아래 꼬리 구간과 본선에 합류하는 코너가
// 정상 레인색(초록/노랑/파랑...)으로 되살아난다.
const test = require('node:test');
const assert = require('node:assert/strict');

const { calcGraphRows } = require('../graph');
const { renderCombinedGraphPixels } = require('../sixel');

const CELL_W = 8;
const CELL_H = 16;
const RECOVERY_COLOR = 9; // sixel 팔레트 #9 (160,160,160) — RECOVERY_TEXT 와 같은 회색
const H = n => String(n).padStart(40, '0');

const styleOf = (rows, r, lane) => rows[r].charStyles[lane];

// M1 ── 유실 가지(R1→R2)가 M4 에서 갈라져 나온 최소 그래프.
// 유실 커밋은 두 개뿐이지만, R2 의 부모 M4 는 M2/M3 아래에 있어 레인1이 세 행을
// 더 살아있다 — 그 구간이 회색을 유지해야 한다.
function buildRows() {
  const commits = [
    { hash: H(1), parents: [H(2)], subject: 'main1' },
    { hash: H(10), parents: [H(11)], subject: 'lost1', isRecovery: true },
    { hash: H(11), parents: [H(4)], subject: 'lost2', isRecovery: true },
    { hash: H(2), parents: [H(3)], subject: 'main2' },
    { hash: H(3), parents: [H(4)], subject: 'main3' },
    { hash: H(4), parents: [H(5)], subject: 'main4' },
    { hash: H(5), parents: [], subject: 'main5' },
  ];
  return calcGraphRows(commits, new Set(), new Map());
}

test('유실 가지의 꼬리 구간과 합류 코너가 리커버리 스타일을 유지한다', () => {
  const rows = buildRows();
  assert.equal(rows.map(r => r.chars.join('').trimEnd()).join('|'), '●|│◌|│◌|●│|●│|●╯|●');

  assert.equal(styleOf(rows, 1, 1), 1, '유실 커밋 노드는 리커버리');
  assert.equal(styleOf(rows, 2, 1), 1, '유실 커밋 노드는 리커버리');
  assert.equal(styleOf(rows, 3, 1), 1, '유실 커밋 아래로 이어지는 세로선도 리커버리');
  assert.equal(styleOf(rows, 4, 1), 1, '유실 커밋 아래로 이어지는 세로선도 리커버리');
  assert.equal(styleOf(rows, 5, 1), 1, '본선에 합류하는 코너도 리커버리');

  for (let r = 0; r < rows.length; r++) {
    assert.equal(styleOf(rows, r, 0), 0, '레인0(본선)은 리커버리로 물들지 않는다: 행 ' + r);
  }
});

test('닫힌 리커버리 레인을 재사용해도 스타일이 남지 않는다', () => {
  const commits = [
    { hash: H(10), parents: [H(1)], subject: 'lost', isRecovery: true }, // lane0
    { hash: H(1), parents: [H(2)], subject: 'main1' },                   // lane0 재사용
    { hash: H(2), parents: [], subject: 'main2' },
  ];
  const rows = calcGraphRows(commits, new Set(), new Map());
  assert.equal(styleOf(rows, 0, 0), 1);
  assert.equal(styleOf(rows, 1, 0), 0, '정상 커밋 노드는 정상 스타일');
  assert.equal(styleOf(rows, 2, 0), 0);
});

test('리커버리 간선이 정상 노드에 닿을 때 위쪽 꼬다리도 회색으로 그린다', () => {
  const commits = [
    { hash: H(10), parents: [H(1)], subject: 'lost', isRecovery: true },
    { hash: H(1), parents: [H(2)], subject: 'main1' },
    { hash: H(2), parents: [], subject: 'main2' },
  ];
  const rows = calcGraphRows(commits, new Set(), new Map());
  const buf = renderCombinedGraphPixels(rows, 1, CELL_W, CELL_H, null, null);

  const cx = CELL_W >> 1;
  const dotR = Math.max(2, Math.round(CELL_W * 0.375));
  const top = CELL_H; // 두 번째 행(main1)
  const cy = top + (CELL_H >> 1);
  let painted = 0;
  for (let y = top; y < cy - dotR; y++) {
    const v = buf[y * CELL_W + cx];
    if (!v) continue;
    painted++;
    assert.equal(v, RECOVERY_COLOR, '위 커밋이 주인인 간선이므로 회색이어야 한다');
  }
  assert.ok(painted > 0, '위쪽 꼬다리 자체는 그려져야 한다');
});
