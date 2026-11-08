// 묶여 보이는 추적하지 않는 폴더(dir/)의 실제 파일 목록을 미리 구해 둔다.
//
// 배경: 상태 목록(--untracked-files=normal)은 추적하지 않는 폴더를 'dir/' 한 줄로 보여 준다.
// 스테이징이 그 폴더를 경로로 넘기면 git 이 폴더 안 파일을 무시 패턴과 하나하나 대조한다.
// 무시 패턴 5,447개, 폴더 안 파일 6만여 개인 워크트리(hecaton-260130-1)에서 그 대조만
// 4.8초였다(같은 탐색이 .gitignore 없이 0.75초, 적용하면 5.6초 — 실측). 같은 저장소에서
// Fork 는 첫 조회에 25초를 쓴 뒤 파일 82개를 개별 경로로 들고 있다가 그것만 담는다.
// 여기서도 폴더가 목록에 나타나면 그 안의 파일을 백그라운드에서 한 번 구해 두고(읽기 전용,
// 인덱스 잠금 없음), 스테이징은 그 파일만 넘긴다. 구해 둔 뒤 생긴 파일은 스테이징 직후
// 같은 폴더를 다시 훑어 따라 담는다(catchUp).
const { gitExecChecked } = require('./git');

const EXPAND_TIMEOUT_MS = 120000;
// 명령줄에 싣는 폴더 경로의 상한 — 넘으면 미리 구하지 않고 예전처럼 폴더째 담는다.
const DIR_ARG_BUDGET = 16000;

let _cwd = '';
let _generation = 0;
const _files = new Map(); // 'dir/' → [파일 경로]
let _pending = null;
let _pendingDirs = [];

function isDirEntry(file) {
  return typeof file === 'string' && file.endsWith('/');
}

function reset(cwd) {
  if (cwd === _cwd) return;
  _cwd = cwd;
  _generation++;
  _files.clear();
  _pending = null;
  _pendingDirs = [];
}

// 폴더들 안의 추적하지 않는(무시되지 않은) 파일. 실패하면 null.
async function listUntrackedFiles(cwd, dirs) {
  if (dirs.length === 0) return new Map();
  const argSize = dirs.reduce((size, dir) => size + dir.length * 4 + 3, 256);
  if (argSize > DIR_ARG_BUDGET) return null;
  const result = await gitExecChecked(
    ['--no-optional-locks', '--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...dirs],
    cwd, EXPAND_TIMEOUT_MS);
  if (!result.ok) return null;
  const map = new Map(dirs.map(dir => [dir, []]));
  for (const file of result.text.split('\0')) {
    if (!file) continue;
    const dir = dirs.find(d => file.startsWith(d));
    if (dir) map.get(dir).push(file);
  }
  return map;
}

// 상태 목록이 적용될 때마다 부른다. 아직 모르는 폴더만, 한 번에 하나의 조회로 구한다.
function prefetch(cwd, untrackedEntries) {
  if (!cwd) return null;
  reset(cwd);
  const dirs = (untrackedEntries || []).filter(isDirEntry);
  const listed = new Set(dirs);
  for (const dir of [..._files.keys()]) if (!listed.has(dir)) _files.delete(dir);
  if (_pending) return _pending;
  const missing = dirs.filter(dir => !_files.has(dir));
  if (missing.length === 0) return null;
  const generation = _generation;
  _pendingDirs = missing;
  _pending = listUntrackedFiles(cwd, missing).then(map => {
    if (generation !== _generation || !map) return;
    for (const dir of missing) _files.set(dir, map.get(dir) || []);
  }).catch(() => null).finally(() => {
    if (generation === _generation) { _pending = null; _pendingDirs = []; }
  });
  return _pending;
}

// 스테이징할 추적하지 않는 항목을 파일과 (아직 모르는) 폴더로 나눈다. 구하는 중인
// 폴더가 있으면 그 조회를 기다린다 — 같은 탐색을 git add 로 한 번 더 하는 것보다 빠르다.
async function resolve(cwd, untrackedEntries) {
  const entries = untrackedEntries || [];
  const dirs = entries.filter(isDirEntry);
  if (cwd === _cwd && _pending && dirs.some(dir => _pendingDirs.includes(dir))) await _pending;
  const files = [], unresolvedDirs = [], expandedDirs = [];
  for (const entry of entries) {
    if (!isDirEntry(entry)) { files.push(entry); continue; }
    const known = cwd === _cwd ? _files.get(entry) : undefined;
    if (!known) { unresolvedDirs.push(entry); continue; }
    expandedDirs.push(entry);
    // 중첩 저장소처럼 폴더로만 나오는 항목은 git add 에 맡긴다.
    for (const file of known) (isDirEntry(file) ? unresolvedDirs : files).push(file);
  }
  return { files, unresolvedDirs, expandedDirs };
}

// 스테이징한 폴더를 다시 훑어, 구해 둔 뒤 생긴 파일을 돌려준다. 그 폴더의 기억은 지운다.
async function catchUp(cwd, expandedDirs) {
  for (const dir of expandedDirs) _files.delete(dir);
  const map = await listUntrackedFiles(cwd, expandedDirs);
  if (!map) return [];
  return [...map.values()].flat();
}

function forget(cwd) {
  if (cwd === _cwd) _files.clear();
}

module.exports = { prefetch, resolve, catchUp, forget, listUntrackedFiles, isDirEntry };
