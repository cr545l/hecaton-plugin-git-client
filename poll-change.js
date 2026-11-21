// 변경 감지 폴링(main.js setupGitWatcher)이 무엇을 다시 읽을지 정하는 판정.
//
// 시그니처는 pollTargets 의 mtime 을 '|' 로 이은 뒤 '\x1e' 와 refs 트리 지문을 붙인 문자열이다.
// pollTargets 의 앞 세 칸(index·HEAD·HEAD reflog)만 이 워크트리의 status 를 바꾼다 — 나머지
// (FETCH_HEAD, 공용 refs·packed-refs·worktrees)는 브랜치·원격 목록과 히스토리에만 영향을 준다.
const OWN_STATUS_TARGETS = 3;

function splitSignature(sig) {
  const text = String(sig || '');
  const cut = text.indexOf('\x1e');
  return cut === -1
    ? { times: text.split('|'), rest: '' }
    : { times: text.substring(0, cut).split('|'), rest: text.substring(cut + 1) };
}

// 인덱스 시각만 바뀌었다 — 이 창의 쓰기(스테이징 등)가 끝난 직후라면 그 변경은 이 창이 만든
// 것이고, 쓰기 뒤 갱신이 이미 목록을 맞췄다.
function onlyIndexChanged(before, after) {
  const a = splitSignature(before), b = splitSignature(after);
  if (a.rest !== b.rest || a.times.length !== b.times.length) return false;
  return a.times[0] !== b.times[0] && a.times.slice(1).join('|') === b.times.slice(1).join('|');
}

// 이 워크트리의 status 를 바꾸는 칸은 그대로이고 공용 부분만 바뀌었다 — 다른 워크트리의 커밋·
// 브랜치 작업이나 fetch 다. 예전에는 이때도 전체 refresh 를 걸어, 같은 저장소의 창마다 status 를
// 한 번씩 더 돌렸다(2026-11-18 Com2uX 실측: 메타 refresh 의 90% 가 status 를 함께 돌렸다).
function onlySharedChanged(before, after) {
  const a = splitSignature(before), b = splitSignature(after);
  if (a.times.length !== b.times.length) return false;
  return a.times.slice(0, OWN_STATUS_TARGETS).join('|') === b.times.slice(0, OWN_STATUS_TARGETS).join('|');
}

// 바뀐 것에 맞는 refresh 범위.
function refreshScopeFor(before, after) {
  return onlySharedChanged(before, after) ? { metadataOnly: true } : {};
}

// 짧은 간격에 겹친 자동 refresh 요청을 하나로 합친다. 같은 한정 범위끼리만 한정을 남기고,
// 섞이면 전체 refresh 다.
function mergeAutoRefreshOptions(existing, incoming) {
  if (!existing) return { ...incoming };
  if (existing.statusOnly === true && incoming.statusOnly === true) return { statusOnly: true };
  if (existing.metadataOnly === true && incoming.metadataOnly === true) return { metadataOnly: true };
  return {};
}

module.exports = { OWN_STATUS_TARGETS, onlyIndexChanged, onlySharedChanged, refreshScopeFor, mergeAutoRefreshOptions };
