// 변경 감지 폴링이 바뀐 곳에 맞게 refresh 범위를 고르는지 검증한다.
//
// 배경(2026-11-18 Com2uX 실측): 워크트리마다 창을 하나씩 띄운 쓰임에서 한 워크트리의 커밋이
// 공용 refs 를 바꾸면, 다른 모든 창이 전체 refresh(status + 메타)를 걸었다. 그 창들의 index·HEAD
// 는 그대로라 status 는 바뀌지 않는다 — 메타 refresh 의 90% 가 쓸모없는 status 를 함께 돌렸다.
const test = require('node:test');
const assert = require('node:assert/strict');

const { onlyIndexChanged, onlySharedChanged, refreshScopeFor, mergeAutoRefreshOptions } = require('../poll-change');

// pollTargets 순서: index, HEAD, logs/HEAD, FETCH_HEAD, refs, refs/heads, packed-refs, worktrees
function sig(times, refs) {
  return times.join('|') + '\x1e' + (refs || 'refs\nheads/main:100:41');
}
const BASE = [10, 20, 30, 40, 50, 60, 70, 80];
const withAt = (index, value) => BASE.map((v, i) => (i === index ? value : v));

test('다른 워크트리의 커밋(공용 refs 만 바뀜)은 메타만 다시 읽는다', () => {
  const before = sig(BASE);
  const after = sig(BASE, 'refs\nheads/main:100:41\nheads/feature:200:41');
  assert.equal(onlySharedChanged(before, after), true);
  assert.deepEqual(refreshScopeFor(before, after), { metadataOnly: true });
});

test('fetch(FETCH_HEAD·refs 디렉터리만 바뀜)도 메타만 다시 읽는다', () => {
  assert.deepEqual(refreshScopeFor(sig(BASE), sig(withAt(3, 41))), { metadataOnly: true });
  assert.deepEqual(refreshScopeFor(sig(BASE), sig(withAt(6, 71))), { metadataOnly: true });
  assert.deepEqual(refreshScopeFor(sig(BASE), sig(withAt(7, 81))), { metadataOnly: true }, '워크트리 추가·삭제');
});

test('이 워크트리의 index·HEAD·HEAD reflog 가 바뀌면 전체 refresh 다', () => {
  for (const i of [0, 1, 2]) {
    const after = sig(withAt(i, BASE[i] + 1), 'refs\nheads/main:300:41');
    assert.equal(onlySharedChanged(sig(BASE), after), false, 'pollTargets[' + i + ']');
    assert.deepEqual(refreshScopeFor(sig(BASE), after), {});
  }
});

test('시그니처 모양이 달라지면(대상 수 변화) 안전하게 전체 refresh 다', () => {
  assert.deepEqual(refreshScopeFor(sig(BASE), sig(BASE.slice(0, 7))), {});
});

test('인덱스만 바뀐 경우의 판정은 종전과 같다', () => {
  assert.equal(onlyIndexChanged(sig(BASE), sig(withAt(0, 11))), true);
  assert.equal(onlyIndexChanged(sig(BASE), sig(withAt(1, 21))), false);
  assert.equal(onlyIndexChanged(sig(BASE), sig(withAt(0, 11), 'refs\nother')), false, 'refs 도 바뀌었으면 아니다');
  assert.equal(onlyIndexChanged(sig(BASE), sig(BASE)), false, '아무것도 안 바뀌었다');
});

test('겹친 자동 refresh 는 같은 한정 범위끼리만 한정을 남긴다', () => {
  assert.deepEqual(mergeAutoRefreshOptions(null, { metadataOnly: true }), { metadataOnly: true });
  assert.deepEqual(mergeAutoRefreshOptions({ metadataOnly: true }, { metadataOnly: true }), { metadataOnly: true });
  assert.deepEqual(mergeAutoRefreshOptions({ statusOnly: true }, { statusOnly: true }), { statusOnly: true });
  assert.deepEqual(mergeAutoRefreshOptions({ metadataOnly: true }, { statusOnly: true }), {}, '둘 다 필요하면 전체');
  assert.deepEqual(mergeAutoRefreshOptions({ metadataOnly: true }, {}), {});
  assert.deepEqual(mergeAutoRefreshOptions({}, { metadataOnly: true }), {});
});
