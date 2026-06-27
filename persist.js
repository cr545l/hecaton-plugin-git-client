// UI 상태 영속화 — <cwd>/.hecaton/.data/<plugin-id>/settings.json
//
// note 플러그인과 동일하게 "프로젝트 경로 내부"에 독립적으로 저장한다.
// 프로젝트(리포)마다 별도 settings.json을 가지므로 전역 공유가 없다.
//   global: 탭/diff 뷰/패널 접기/분할 비율/정렬 모드 등 UI 선호 (프로젝트별)
//   repo:   섹션·그룹 접힘, recent 정렬용 사용 기록, 커밋 메시지 드래프트
//
// 디렉토리 이름은 반드시 매니페스트 id(plugin.json의 "id")여야 한다. 호스트는
// 매니페스트 id 기반 경로에 한해 fs 쓰기를 자동 허용하므로, 폴더명을 쓰면
// 저장할 때마다 권한 프롬프트가 뜬다. id는 load()에서 plugin.json을 읽어 캐시.
//
// 경로는 cwd가 확정되는 attachRepo()에서 결정된다. 리포 전환 시 떠나는
// 프로젝트를 먼저 flush하고 새 프로젝트 파일을 읽어 적용한다.
//
// 저장은 render() 경유 디바운스로만 일어난다. 종료 시그널에서는 flushNow()로
// best-effort 플러시한다 (hecaton.fs가 async라 완료 보장은 없음).

const path = require('path');
const { state, ui } = require('./state');

const VERSION = 1;
const DEBOUNCE_MS = 600;
const MAX_WAIT_MS = 5000;        // 연속 render(스피너/호버)로 디바운스가 무한 연장되는 것 방지
const MAX_BRANCH_USAGE = 50;     // remoteRecentBranchUsage 항목 상한
const FRESH_WINDOW_MAX = 5;      // FRESH_TIME_WINDOWS.length - 1
const FALLBACK_PLUGIN_ID = 'git-client'; // plugin.json을 못 읽을 때의 매니페스트 id

let _pluginId = null;    // 매니페스트 id (load()에서 plugin.json을 읽어 캐시)
let _file = null;        // settings.json 절대 경로 (attachRepo 성공 후 설정)
let _dir = null;
let _loaded = false;     // load() 게이트 — true가 되어야 attachRepo/schedule 동작
let _data = { version: VERSION, global: {}, repo: {} };
let _repoKey = null;     // 현재 활성 리포 키 (정규화된 cwd)
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

// 디스크에서 읽은 global 섹션을 검증하며 state/ui에 적용
function applyGlobal(g) {
  if (!isPlainObject(g)) return;
  state.rightView = pickEnum(g.rightView, ['diff', 'log', 'fresh'], state.rightView);
  state.diffView = pickEnum(g.diffView, ['side', 'unified'], state.diffView);
  state.freshTimeWindow = Math.round(clamp(g.freshTimeWindow, 0, FRESH_WINDOW_MAX, state.freshTimeWindow));
  ui.verticalDividerRatio = clamp(g.verticalDividerRatio, 0.05, 0.5, ui.verticalDividerRatio);
  ui.filesDividerRatio = clamp(g.filesDividerRatio, 0.15, 0.7, ui.filesDividerRatio);
  ui.logListRatio = clamp(g.logListRatio, 0.1, 0.9, ui.logListRatio);
  if (isPlainObject(g.panels)) {
    if (typeof g.panels.left === 'boolean') ui.leftPanelCollapsed = g.panels.left;
    if (typeof g.panels.rightTop === 'boolean') ui.rightTopCollapsed = g.panels.rightTop;
    if (typeof g.panels.rightBottom === 'boolean') ui.rightBottomCollapsed = g.panels.rightBottom;
    if (typeof g.panels.middle === 'boolean') ui.middlePanelCollapsed = g.panels.middle;
    if (typeof g.panels.right === 'boolean') ui.rightPanelCollapsed = g.panels.right;
  }
  ui.remoteSortMode = pickEnum(g.remoteSortMode, ['alpha', 'alpha_desc', 'recent'], ui.remoteSortMode);
}

function captureGlobal() {
  return {
    rightView: state.rightView,
    diffView: state.diffView,
    freshTimeWindow: state.freshTimeWindow,
    verticalDividerRatio: ui.verticalDividerRatio,
    filesDividerRatio: ui.filesDividerRatio,
    logListRatio: ui.logListRatio,
    panels: {
      left: ui.leftPanelCollapsed,
      rightTop: ui.rightTopCollapsed,
      rightBottom: ui.rightBottomCollapsed,
      middle: ui.middlePanelCollapsed,
      right: ui.rightPanelCollapsed,
    },
    remoteSortMode: ui.remoteSortMode,
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

// 현재 리포(프로젝트) 상태를 객체로 캡처
function captureRepo() {
  return {
    collapsedSections: { ...ui.collapsedSections },
    collapsedGroups: { ...ui.collapsedGroups },
    remoteRecentBranchUsage: sanitizeUsageMap(ui.remoteRecentBranchUsage),
    // 커밋 모드 중에만 드래프트 저장 — Esc/커밋 완료로 모드를 벗어나면 비워진다
    commitDraft: state.mode === 'commit' ? state.commitMsg : '',
  };
}

// 디스크에서 읽은 repo 섹션을 검증하며 ui/드래프트에 적용
function applyRepo(entry) {
  ui.collapsedSections = sanitizeBoolMap(entry && entry.collapsedSections);
  ui.collapsedGroups = sanitizeBoolMap(entry && entry.collapsedGroups);
  ui.remoteRecentBranchUsage = sanitizeUsageMap(entry && entry.remoteRecentBranchUsage);
  _commitDraft = (entry && typeof entry.commitDraft === 'string') ? entry.commitDraft : '';
}

// 시작 시 1회: 매니페스트 id를 읽어 캐시하고 게이트를 연다.
// 실제 파일 경로/로드는 cwd가 확정되는 attachRepo에서.
async function load() {
  if (!_pluginId) {
    try {
      const r = await hecaton.fs.read_file({ path: path.join(__dirname, 'plugin.json') });
      if (r && r.ok && r.content) {
        const m = JSON.parse(r.content);
        if (m && typeof m.id === 'string' && m.id) _pluginId = m.id;
      }
    } catch { /* 못 읽으면 폴백 */ }
    if (!_pluginId) _pluginId = FALLBACK_PLUGIN_ID;
  }
  _loaded = true;
}

// 현재 _file에서 settings.json을 읽어 _data 채우고 global/repo를 적용
async function loadFile() {
  _data = { version: VERSION, global: {}, repo: {} };
  try {
    const result = await hecaton.fs.read_file({ path: _file });
    if (result && result.ok && result.content) {
      const parsed = JSON.parse(result.content);
      if (isPlainObject(parsed) && parsed.version === VERSION) {
        _data.global = isPlainObject(parsed.global) ? parsed.global : {};
        _data.repo = isPlainObject(parsed.repo) ? parsed.repo : {};
      }
    }
  } catch { /* 파일 없음/손상 — 기본값으로 시작 */ }
  applyGlobal(_data.global);
  applyRepo(_data.repo);
  _lastWritten = JSON.stringify(_data);
}

// 프로젝트 .hecaton 디렉토리를 git에서 통째로 무시 — 1회 보장
async function ensureGitignore(cwd) {
  try {
    const hecatonDir = path.join(cwd, '.hecaton');
    const gi = path.join(hecatonDir, '.gitignore');
    const existing = await hecaton.fs.read_file({ path: gi }).catch(() => null);
    if (existing && existing.ok) return; // 이미 있으면 건드리지 않음
    await hecaton.fs.mkdir({ path: hecatonDir, recursive: true });
    await hecaton.fs.write_file({ path: gi, content: '*\n' });
  } catch { /* 무시 — gitignore 실패가 영속화를 막지 않는다 */ }
}

// cwd 확정/변경 시: 이전 프로젝트를 저장하고 새 프로젝트 파일을 읽어 적용
async function attachRepo(cwd) {
  if (!_loaded) return;
  const key = normalizeRepoKey(cwd);
  if (!key || key === _repoKey) return;
  // 떠나는 프로젝트의 마지막 상태를 현재 _file로 먼저 플러시
  if (_repoKey && _file) await flushNow();
  _repoKey = key;
  // 새 프로젝트 경로 구성 (원본 cwd 사용 — key는 비교 전용이라 lowercase일 수 있음)
  // 디렉토리 이름은 매니페스트 id — 폴더명을 쓰면 호스트 권한 범위를 벗어난다
  _dir = path.join(cwd, '.hecaton', '.data', _pluginId || FALLBACK_PLUGIN_ID);
  _file = path.join(_dir, 'settings.json');
  await loadFile();
  ensureGitignore(cwd); // fire-and-forget
  // global/repo가 새로 적용되었으니 화면 갱신 (순환 회피용 lazy require)
  try { require('./render').render(); } catch { /* render 준비 전이면 다음 render에서 반영 */ }
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
  _data.global = captureGlobal();
  _data.repo = captureRepo();
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

// 종료/리포 전환 시 best-effort 즉시 플러시
function flushNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  return flush();
}

module.exports = { load, attachRepo, takeCommitDraft, schedule, flushNow };
