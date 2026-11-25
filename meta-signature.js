// .git 메타 상태의 지문 — "브랜치·원격·HEAD·인덱스가 바뀌었는가"를 git 을 띄우지 않고 판정한다.
//
// 창과 서비스가 같은 계산을 쓴다. 예전에는 창마다 2초 주기로 이 지문을 따로 계산했다 —
// stat 8번에 refs 트리 훑기(디렉터리 수만큼 read_dir)라, 창 열 개면 2초마다 호스트 호출이
// 260건쯤 나갔고 그 호출은 git 실행과 같은 워커를 지난다(2026-11-12 실측 저장소: refs
// 디렉터리 17개). 지문의 대부분(refs 트리, packed-refs, worktrees)은 저장소 전체에 공통이고
// 워크트리마다 다른 것은 네 파일(index, HEAD, logs/HEAD, FETCH_HEAD)뿐이다. 서비스가 맡으면
// 저장소당 한 번만 훑고 결과를 창들에 나눠 준다.
//
// UI 모듈에 기대지 않는다 — 서비스 프로세스가 그대로 불러 쓴다.
const nodePath = require('path');

// .git/refs 하위 loose ref 트리의 지문.
// 디렉터리 mtime은 "직접 자식"이 바뀔 때만 갱신된다. refs/remotes/origin/foo를
// 지우면 refs/remotes/origin의 mtime만 바뀌고 refs·refs/remotes는 그대로다.
// 그래서 refs 한 곳만 stat하면 원격 브랜치 삭제/prune, 태그 추가/삭제,
// 중첩 이름(feature/x) 브랜치 변경을 통째로 놓친다. 트리를 직접 훑어
// "경로:mtime:size" 목록을 지문으로 만든다. packed-refs에 묶인 ref는
// packed-refs 파일 mtime으로 별도 추적된다.
const REFS_SCAN_MAX_ENTRIES = 4000;

function separator(platform) {
  return (platform || process.platform) === 'win32' ? '\\' : '/';
}

async function collectRefEntries(api, dirPath, relPath, out, budget, sep) {
  let res = null;
  try {
    res = await api.fs.read_dir({ path: dirPath });
  } catch { return; }
  if (!res || !res.ok || !Array.isArray(res.entries)) return;
  budget.scanned = true;
  const subdirs = [];
  for (const entry of res.entries) {
    if (!entry || !entry.name) continue;
    if (budget.remaining <= 0) { budget.truncated = true; break; }
    budget.remaining--;
    const rel = relPath ? relPath + '/' + entry.name : entry.name;
    if (entry.is_dir) {
      out.push(rel + '/');
      subdirs.push([dirPath + sep + entry.name, rel]);
    } else {
      out.push(rel + ':' + (entry.mtime_ms || 0) + ':' + (entry.size_bytes || 0));
    }
  }
  await Promise.all(subdirs.map(([p, r]) => collectRefEntries(api, p, r, out, budget, sep)));
}

// refs 트리 지문 문자열. read_dir을 제공하지 않는 호스트나 스캔 실패 시 ''를
// 반환해, 호출자가 기존 mtime 지문만으로 판단하도록(= 종전 동작) 폴백한다.
// truncatedMark: 상한을 넘겨 잘렸을 때 끝에 붙이는 표시.
async function computeRefsTreeSignature(api, gitDir, truncatedMark, platform) {
  if (!gitDir) return '';
  if (!api || !api.fs || typeof api.fs.read_dir !== 'function') return '';
  const sep = separator(platform);
  const out = [];
  const budget = { remaining: REFS_SCAN_MAX_ENTRIES, truncated: false, scanned: false };
  await collectRefEntries(api, gitDir + sep + 'refs', '', out, budget, sep);
  if (!budget.scanned) return '';
  // read_dir 순서는 플랫폼/파일시스템마다 다르므로 정렬해 안정화한다.
  out.sort();
  // ref가 상한을 넘는 저장소는 부분 지문만 남는다. 지문 자체는 안정적이므로
  // 오탐은 없고, 잘린 구간의 변경만 놓친다(= 종전 동작 수준).
  if (budget.truncated) out.push(truncatedMark || '(truncated)');  // i18n-ok: 캐시 지문 — 화면에 나가지 않는다
  return "refs\n" + out.join('\n');  // i18n-ok: 캐시 지문 — 화면에 나가지 않는다
}

async function statMtime(api, filePath) {
  try {
    const r = await api.fs.stat({ path: filePath });
    return (r && r.exists && r.mtime_ms) ? r.mtime_ms : 0;
  } catch { return 0; }
}

// 워크트리마다 다른 대상. linked worktree면 index/HEAD/logs는 per-worktree git dir에 있다.
// 순서를 바꾸지 않는다 — 첫 칸이 index 라는 것에 기대는 판정이 있다(main.js onlyIndexChanged).
function ownTargets(gitDir, sep) {
  return [
    gitDir + sep + 'index',
    gitDir + sep + 'HEAD',
    gitDir + sep + 'logs' + sep + 'HEAD',
    gitDir + sep + 'FETCH_HEAD',
  ];
}

// 저장소 전체에 공통인 대상. refs 하위는 mtime만으로 변경을 잡을 수 없어 트리 지문으로 따로
// 본다. 여기 남긴 refs/refs/heads는 read_dir을 제공하지 않는 호스트에서의 폴백이다.
function commonTargets(commonDir, sep) {
  return [
    commonDir + sep + 'refs',
    commonDir + sep + 'refs' + sep + 'heads',
    commonDir + sep + 'packed-refs',
    commonDir + sep + 'worktrees',
  ];
}

// read({ gitDir, commonDir }) → { sig, shareable }
//   sig        같은 상태에서 같은 값이 나오는 문자열. "index|HEAD|logs/HEAD|FETCH_HEAD|refs|
//              refs/heads|packed-refs|worktrees" + '\x1e' + refs 트리 지문.
//   shareable  refs 훑기가 예외로 실패한 틱은 직전 값으로 때우는데 그 값은 읽는 쪽마다 다를 수
//              있다 — 그때만 false.
// ttlMs 동안은 같은 대상의 결과를 다시 내주고, 도는 중인 계산에는 합류한다. 그래서 창이
// 몇 개든 한 주기에 공용 부분은 저장소당 한 번, 워크트리 부분은 워크트리당 한 번만 읽는다.
function createMetaReader(api, opts = {}) {
  const now = opts.now || Date.now;
  const ttlMs = opts.ttlMs || 0;
  const platform = opts.platform || process.platform;
  const sep = separator(platform);
  const truncatedMark = opts.truncatedMark;
  const cache = new Map();
  const lastRefsSig = new Map();

  function keyOf(dir) {
    const resolved = nodePath.resolve(dir);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function cached(key, compute) {
    let entry = cache.get(key);
    if (entry && entry.pending) return entry.pending;
    if (entry && ttlMs > 0 && now() - entry.at < ttlMs) return Promise.resolve(entry.value);
    if (!entry) { entry = { at: 0, value: null, pending: null, usedAt: 0 }; cache.set(key, entry); }
    entry.usedAt = now();
    entry.pending = compute().then(value => {
      entry.value = value;
      entry.at = now();
      return value;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }

  function readCommon(commonDir) {
    const key = keyOf(commonDir);
    return cached('common\0' + key, async () => {  // i18n-ok: 내부 캐시 키
      let refsFailed = false;
      const [mtimes, refsSig] = await Promise.all([
        Promise.all(commonTargets(commonDir, sep).map(p => statMtime(api, p))),
        // 스캔 실패 시 직전 값을 그대로 써서 오탐 refresh를 만들지 않는다.
        computeRefsTreeSignature(api, commonDir, truncatedMark, platform)
          .catch(() => { refsFailed = true; return lastRefsSig.get(key) || ''; }),
      ]);
      lastRefsSig.set(key, refsSig);
      return { mtimes, refsSig, shareable: !refsFailed };
    });
  }

  function readOwn(gitDir) {
    return cached('own\0' + keyOf(gitDir), () =>  // i18n-ok: 내부 캐시 키
      Promise.all(ownTargets(gitDir, sep).map(p => statMtime(api, p))));
  }

  async function read({ gitDir, commonDir }) {
    const [own, common] = await Promise.all([readOwn(gitDir), readCommon(commonDir || gitDir)]);
    return {
      sig: own.concat(common.mtimes).join('|') + '\x1e' + common.refsSig,
      shareable: common.shareable,
    };
  }

  // 오래 쓰이지 않은 대상을 버린다(닫힌 저장소). 서비스가 주기적으로 부른다.
  function prune(maxIdleMs) {
    const cutoff = now() - maxIdleMs;
    for (const [key, entry] of cache) {
      if (!entry.pending && entry.usedAt < cutoff) cache.delete(key);
    }
    if (cache.size === 0) lastRefsSig.clear();
  }

  // 워크트리 쪽 네 파일의 시각만(index, HEAD, logs/HEAD, FETCH_HEAD 순). 공용 부분을 훑지 않는다.
  return { read, readOwn, prune };
}

module.exports = { computeRefsTreeSignature, createMetaReader, REFS_SCAN_MAX_ENTRIES };
