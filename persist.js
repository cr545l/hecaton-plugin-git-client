// UI 상태 영속화 — 프로젝트별 로컬 데이터 디렉토리에 settings.json 저장.
//   <cwd>/.hecaton/.data/<plugin-dir>/settings.json
// (호스트가 프롬프트 없이 쓰기 허용하는 프로젝트 로컬 데이터 경로. note 플러그인과 동일 방식.)
// cwd를 못 구하면 예전 전역 경로(~/.hecaton/data/<plugin-dir>)로 폴백한다.
//
// 모든 UI 설정을 리포(폴더)별로 저장한다.
// 리포별(repos): 레이아웃(탭/diff 뷰·패널 접기·분할 비율·fresh 기간·원격/커밋 정렬 모드),
//               섹션·그룹 접힘, recent 정렬용 사용 기록, 커밋 메시지 드래프트.
// 전역(global): 더 이상 사용하지 않음(빈 객체로 유지, 다음 저장 때 정리).
//
// 예전엔 UI 설정을 global에 저장해 모든 폴더가 같은 배치를 공유했다. 이제 리포별로
// 저장한다. 리포 항목에 값이 없으면 예전 global 값(_layoutFallback)을 초기 기본값으로
// 재사용해 부드럽게 이관한다.
//
// 저장은 render() 경유 디바운스로만 일어난다. 종료 시그널에서는 flushNow()로
// best-effort 플러시한다 (hecaton.fs가 async라 완료 보장은 없음).

const path = require('path');
const { state, ui } = require('./state');

const VERSION = 1;
const DEBOUNCE_MS = 600;
const MAX_WAIT_MS = 5000;        // 연속 render(스피너/호버)로 디바운스가 무한 연장되는 것 방지
const MAX_REPOS = 30;            // repos 맵 LRU 상한
const MAX_BRANCH_USAGE = 50;     // remoteRecentBranchUsage 항목 상한
const FRESH_WINDOW_MAX = 5;      // FRESH_TIME_WINDOWS.length - 1

const PLUGIN_DIR_NAME = (function () {
  const parts = __dirname.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'hecaton-plugin-git-client';
})();

let _file = null;        // settings.json 절대 경로 (load 성공 후 설정)
let _dir = null;
let _loaded = false;
let _data = { version: VERSION, global: {}, repos: {} };
let _repoKey = null;     // 현재 활성 리포 키 (정규화된 cwd)
let _layoutFallback = {}; // 예전 global 레이아웃 — 리포 항목에 값이 없을 때의 기본값(이관용)
let _commitDraft = '';   // 이전 세션에서 복구된 커밋 드래프트 (one-shot)
let _timer = null;
let _lastWritten = '';
let _writing = false;
let _writeQueued = false;

function normalizeRepoKey(cwd) {
  if (!cwd) return null;
  let k = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') k = k.toLowerCase();
  return k || null;
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function pickEnum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 모든 UI 설정을 리포별로 저장하므로 global 섹션은 더 이상 값을 담지 않는다.
// 예전 버전과의 호환을 위해 키만 빈 객체로 유지한다(다음 저장 때 정리됨).
function captureGlobal() {
  return {};
}

// 리포별 레이아웃 값을 검증하며 state/ui에 적용. src는 리포 항목(레이아웃 필드가
// 없으면 _layoutFallback으로 채워진 병합 객체). 누락 필드는 현재 값을 유지한다.
function applyLayout(src) {
  if (!isPlainObject(src)) return;
  state.rightView = pickEnum(src.rightView, ['diff', 'log', 'fresh'], state.rightView);
  state.diffView = pickEnum(src.diffView, ['side', 'unified'], state.diffView);
  state.freshTimeWindow = Math.round(clamp(src.freshTimeWindow, 0, FRESH_WINDOW_MAX, state.freshTimeWindow));
  ui.verticalDividerRatio = clamp(src.verticalDividerRatio, 0.05, 0.5, ui.verticalDividerRatio);
  ui.filesDividerRatio = clamp(src.filesDividerRatio, 0.15, 0.7, ui.filesDividerRatio);
  ui.logListRatio = clamp(src.logListRatio, 0.1, 0.9, ui.logListRatio);
  ui.remoteSortMode = pickEnum(src.remoteSortMode, ['alpha', 'alpha_desc', 'recent'], ui.remoteSortMode);
  ui.logSortMode = pickEnum(src.logSortMode, ['date', 'branch'], ui.logSortMode);
  if (isPlainObject(src.panels)) {
    if (typeof src.panels.left === 'boolean') ui.leftPanelCollapsed = src.panels.left;
    if (typeof src.panels.rightTop === 'boolean') ui.rightTopCollapsed = src.panels.rightTop;
    if (typeof src.panels.rightBottom === 'boolean') ui.rightBottomCollapsed = src.panels.rightBottom;
    if (typeof src.panels.middle === 'boolean') ui.middlePanelCollapsed = src.panels.middle;
    if (typeof src.panels.right === 'boolean') ui.rightPanelCollapsed = src.panels.right;
  }
}

function captureLayout() {
  return {
    rightView: state.rightView,
    diffView: state.diffView,
    freshTimeWindow: state.freshTimeWindow,
    verticalDividerRatio: ui.verticalDividerRatio,
    filesDividerRatio: ui.filesDividerRatio,
    logListRatio: ui.logListRatio,
    remoteSortMode: ui.remoteSortMode,
    logSortMode: ui.logSortMode,
    panels: {
      left: ui.leftPanelCollapsed,
      rightTop: ui.rightTopCollapsed,
      rightBottom: ui.rightBottomCollapsed,
      middle: ui.middlePanelCollapsed,
      right: ui.rightPanelCollapsed,
    },
  };
}

function sanitizeBoolMap(v) {
  if (!isPlainObject(v)) return {};
  const out = {};
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'boolean') out[k] = v[k];
  }
  return out;
}

function sanitizeUsageMap(v) {
  if (!isPlainObject(v)) return {};
  const entries = Object.entries(v).filter(([, t]) => Number.isFinite(t));
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_BRANCH_USAGE));
}

function captureRepo() {
  if (!_repoKey) return;
  const prev = _data.repos[_repoKey];
  _data.repos[_repoKey] = {
    ...captureLayout(),
    collapsedSections: { ...ui.collapsedSections },
    collapsedGroups: { ...ui.collapsedGroups },
    remoteRecentBranchUsage: sanitizeUsageMap(ui.remoteRecentBranchUsage),
    // 커밋 모드 중에만 드래프트 저장 — Esc/커밋 완료로 모드를 벗어나면 비워진다
    commitDraft: state.mode === 'commit' ? state.commitMsg : '',
    _lastUsed: (prev && prev._lastUsed) || 0,
  };
}

function pruneRepos() {
  const keys = Object.keys(_data.repos);
  if (keys.length <= MAX_REPOS) return;
  keys.sort((a, b) => (_data.repos[b]._lastUsed || 0) - (_data.repos[a]._lastUsed || 0));
  for (const k of keys.slice(MAX_REPOS)) delete _data.repos[k];
}

// 환경변수 헬퍼 — 값이 있으면 반환, 미제공/실패 시 null
async function envValue(name) {
  try {
    const r = await hecaton.env.get({ name });
    return (r && r.value) ? r.value : null;
  } catch { return null; }
}

// 데이터 디렉토리 해석 — 프로젝트별 로컬 디렉토리 우선.
//   1) $HECA_PLUGIN_LOCAL_DATA_DIR  <cwd>/.hecaton/.data/<plugin-id>    ← 프로젝트별
//   2) $HECA_PLUGIN_DATA_DIR        ~/.hecaton/plugin_data/<plugin-id>  ← CWD 없을 때 전역
//   3) ~/.hecaton/data/<plugin-dir>                                    ← 구버전 호스트
async function resolveDataDir() {
  return (await envValue('HECA_PLUGIN_LOCAL_DATA_DIR'))
      || (await envValue('HECA_PLUGIN_DATA_DIR'))
      || (await legacyHomeDir());
}

async function legacyHomeDir() {
  try {
    const home = await hecaton.env.get_home();
    if (home && home.path) return path.join(home.path, '.hecaton', 'data', PLUGIN_DIR_NAME);
  } catch { /* ignore */ }
  return null;
}

// 새 위치에 파일이 없을 때 읽어올 예전 저장 후보 (경로 이전 시 1회 이관용)
async function legacyDataFiles() {
  const dirs = [
    await envValue('HECA_PLUGIN_DATA_DIR'),
    await legacyHomeDir(),
  ];
  return dirs.filter(Boolean).map((d) => path.join(d, 'settings.json'));
}

// 시작 시 1회: settings.json 로드 후 레이아웃 적용. 실패하면 기본값 유지.
async function load() {
  _dir = await resolveDataDir();
  if (!_dir) return; // 경로를 못 구하면 영속화 비활성 (플러그인은 정상 동작)
  _file = path.join(_dir, 'settings.json');
  try {
    let content = '';
    let fromNew = false;
    const result = await hecaton.fs.read_file({ path: _file });
    if (result && result.ok && result.content) {
      content = result.content;
      fromNew = true;
    } else {
      // 새 위치에 없으면 예전 위치들에서 1회 이관 (경로가 바뀐 기존 사용자 보존)
      for (const legacyFile of await legacyDataFiles()) {
        if (legacyFile === _file) continue;
        const lr = await hecaton.fs.read_file({ path: legacyFile }).catch(() => null);
        if (lr && lr.ok && lr.content) { content = lr.content; break; }
      }
    }
    if (content) {
      const parsed = JSON.parse(content);
      if (isPlainObject(parsed) && parsed.version === VERSION) {
        _data = {
          version: VERSION,
          global: isPlainObject(parsed.global) ? parsed.global : {},
          repos: isPlainObject(parsed.repos) ? parsed.repos : {},
        };
      }
      // 예전 버전은 모든 UI 설정을 global에 저장했다 — 리포별 값이 없을 때의 기본값으로 재사용.
      // 리포 부착 전 첫 render에도 이관된 설정이 보이도록 잠정 적용한다.
      _layoutFallback = isPlainObject(_data.global) ? _data.global : {};
      applyLayout(_layoutFallback);
      // 새 위치에서 읽었으면 해시를 채워 무변경 flush를 건너뛰게 한다.
      // 예전 위치에서 이관한 경우엔 비워 둬 첫 flush가 새 위치에 기록하도록 한다.
      _lastWritten = fromNew ? JSON.stringify(_data) : '';
    }
  } catch { /* 손상된 파일 등 — 기본값으로 시작 */ }
  _loaded = true;
}

// cwd 확정/변경 시: 이전 리포 상태를 캡처하고 새 리포 상태를 적용
function attachRepo(cwd) {
  if (!_loaded) return;
  const key = normalizeRepoKey(cwd);
  if (!key || key === _repoKey) return;
  captureRepo(); // 떠나는 리포의 마지막 상태 보존
  _repoKey = key;
  const entry = _data.repos[key];
  // 리포 항목의 레이아웃 우선 적용, 누락 필드는 예전 global(_layoutFallback)로 이관.
  // 리포에 저장된 값(entry)이 fallback을 덮어쓴다.
  applyLayout({ ..._layoutFallback, ...(entry || {}) });
  ui.collapsedSections = sanitizeBoolMap(entry && entry.collapsedSections);
  ui.collapsedGroups = sanitizeBoolMap(entry && entry.collapsedGroups);
  ui.remoteRecentBranchUsage = sanitizeUsageMap(entry && entry.remoteRecentBranchUsage);
  _commitDraft = (entry && typeof entry.commitDraft === 'string') ? entry.commitDraft : '';
  _data.repos[key] = { ...(entry || {}), _lastUsed: Date.now() };
  schedule();
}

// 이전 세션 커밋 드래프트 — 커밋 모드 진입 시 1회 소비
function takeCommitDraft() {
  const draft = _commitDraft;
  _commitDraft = '';
  return draft;
}

// render()마다 호출 — 디바운스 후 변경분만 기록
let _firstScheduledAt = 0;
function schedule() {
  if (!_loaded || !_file) return;
  const now = Date.now();
  if (_timer) {
    if (now - _firstScheduledAt >= MAX_WAIT_MS) return; // 상한 도달 — 예약된 flush 그대로 실행
    clearTimeout(_timer);
  } else {
    _firstScheduledAt = now;
  }
  _timer = setTimeout(() => { _timer = null; flush(); }, DEBOUNCE_MS);
}

async function flush() {
  if (!_loaded || !_file) return;
  if (_writing) { _writeQueued = true; return; }
  captureRepo();
  _data.global = captureGlobal();
  pruneRepos();
  const json = JSON.stringify(_data);
  if (json === _lastWritten) return;
  _writing = true;
  try {
    await hecaton.fs.mkdir({ path: _dir, recursive: true });
    await hecaton.fs.write_file({ path: _file, content: json });
    _lastWritten = json;
  } catch { /* 쓰기 실패는 무시 — 다음 변경 때 재시도 */ }
  _writing = false;
  if (_writeQueued) { _writeQueued = false; flush(); }
}

// 종료 시 best-effort 즉시 플러시
function flushNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  return flush();
}

module.exports = { load, attachRepo, takeCommitDraft, schedule, flushNow };
