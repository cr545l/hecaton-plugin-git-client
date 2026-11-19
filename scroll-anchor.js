// 목록 내용이 바뀌어도 보던 줄을 그 자리에 둔다.
//
// 스크롤 위치는 줄 번호다. 보던 위치보다 위에 줄이 끼거나 빠지면, 위치는 그대로인데 그 번호에 오는
// 내용이 바뀌어 화면이 통째로 한 줄씩 밀린다. 스크롤바는 거의 그대로라 "내용만 튄다"로 보인다.
// 2026-11-19 Com2uX: 팀원이 올린 원격 브랜치가 자동 fetch 로 들어올 때마다 브랜치 패널 줄이 하나씩
// 늘었다(11:20:22·11:24:20·11:27:29 — 열린 창 모두가 같은 초에, fetch 로 refs/remotes 가 생긴 시각과
// 1~4초 차이). 히스토리 목록은 새 커밋이 맨 위에 들어오며 같은 일이 생긴다.
//
// 그래서 줄마다 그 줄이 무엇인지 나타내는 키를 두고, 내용이 바뀌면 예전 위치의 맨 윗줄을 새 목록에서
// 찾아 위치를 옮긴다. 맨 위(위치 0)에 있었으면 그대로 둔다 — 새로 들어온 줄을 보여 준다.

// keyOf(항목) → 문자열 또는 null(이 줄로는 위치를 잡지 않는다). 같은 키가 또 나오면 차례를 붙인다
// (같은 브랜치가 Pinned 와 Branches 에 함께 있는 경우).
function lineKeys(items, keyOf) {
  const keys = new Array(items.length);
  const seen = new Map();
  for (let i = 0; i < items.length; i++) {
    const k = keyOf(items[i]);
    if (k === null || k === undefined) { keys[i] = null; continue; }
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    keys[i] = n === 0 ? k : k + '#' + n;
  }
  return keys;
}

function sameKeys(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// prevKeys 목록에서 off 에 있던 화면을 keys 목록에서 같은 내용이 보이는 위치로 옮긴다.
// span: 화면 높이 — 이만큼 아래까지 키가 있는 줄을 찾는다(맨 윗줄이 사라졌으면 그 아래 줄로 맞춘다).
function anchorOffset(prevKeys, keys, off, span) {
  if (!prevKeys || !keys || !(off > 0) || sameKeys(prevKeys, keys)) return off;
  const end = Math.min(prevKeys.length, off + Math.max(1, span | 0));
  let at = null;
  for (let i = off; i < end; i++) {
    const k = prevKeys[i];
    if (k === null) continue;
    if (!at) {
      at = new Map();
      for (let j = 0; j < keys.length; j++) if (keys[j] !== null) at.set(keys[j], j);
    }
    const j = at.get(k);
    if (j !== undefined) return Math.max(0, j - (i - off));
  }
  return off;
}

module.exports = { lineKeys, sameKeys, anchorOffset };
