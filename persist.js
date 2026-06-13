// UI 상태 영속화 — ~/.hecaton/data/<plugin-dir>/settings.json
//
// 전역(global): 탭/diff 뷰/패널 접기/분할 비율/정렬 모드 등 리포 무관 선호.
// 리포별(repos): 섹션·그룹 접힘, recent 정렬용 사용 기록, 커밋 메시지 드래프트.
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

function captureRepo() {
  if (!_repoKey) return;
  const prev = _data.repos[_repoKey];
  _data.repos[_repoKey] = {
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

// 시작 시 1회: settings.json 로드 후 global 적용. 실패하면 기본값 유지.
async function load() {
  try {
    const home = await hecaton.env.get_home();
    if (!home || !home.path) return;
    _dir = path.join(home.path, '.hecaton', 'data', PLUGIN_DIR_NAME);
    _file = path.join(_dir, 'settings.json');
  } catch {
    return; // 경로를 못 구하면 영속화 비활성 (플러그인은 정상 동작)
  }
  try {
    const result = await hecaton.fs.read_file({ path: _file });
    if (result && result.ok && result.content) {
      const parsed = JSON.parse(result.content);
      if (isPlainObject(parsed) && parsed.version === VERSION) {
        _data = {
          version: VERSION,
          global: isPlainObject(parsed.global) ? parsed.global : {},
          repos: isPlainObject(parsed.repos) ? parsed.repos : {},
        };
      }
      applyGlobal(_data.global);
      _lastWritten = JSON.stringify(_data);
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
