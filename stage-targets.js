// 화면에서 스테이징하는 경로를 상태 목록의 종류로 나눠 담는다.
//
// - 무시 목록에서 명시적으로 고른 것만 add -f 로 담는다. 추적하지 않는 폴더 항목(dir/)을
//   -f 로 넘기면 그 안의 무시된 파일까지 전부 담긴다(예전 선택 스테이징이 그랬다).
// - 추적하지 않는 폴더는 미리 구해 둔 파일 목록(untracked-expand)으로 바꿔 넘긴다. 폴더째
//   넘기면 git 이 폴더 안 파일 전부를 무시 패턴과 대조한다 — 무거운 워크트리에서 5~6초.
const { state } = require('./state');
const { gitStageEntries, gitAddExplicitFiles } = require('./git');
const expand = require('./untracked-expand');

async function stageTargets(cwd, files, fallback) {
  const untracked = new Set((state.untracked || []).map(entry => entry.file));
  const ignored = new Set((state.ignored || []).map(entry => entry.file));
  const tracked = [], untrackedEntries = [], ignoredPicked = [];
  for (const file of files || []) {
    if (ignored.has(file)) ignoredPicked.push(file);
    else if (untracked.has(file)) untrackedEntries.push(file);
    else tracked.push(file);
  }
  const resolved = await expand.resolve(cwd, untrackedEntries);
  const err = await gitStageEntries(cwd, {
    tracked,
    untrackedFiles: resolved.files,
    untrackedDirs: resolved.unresolvedDirs,
    ignored: ignoredPicked,
  }, fallback);
  return { err, expandedDirs: err ? [] : resolved.expandedDirs };
}

// 미리 구한 목록으로 폴더를 담은 뒤 그 사이 생긴 파일을 따라 담는다. 다른 쓰기 작업이
// 돌고 있으면 건드리지 않는다 — 남은 파일은 다음 상태 조회에 추적하지 않는 항목으로 보인다.
async function catchUpExpanded(cwd, expandedDirs, onDone) {
  if (!expandedDirs || expandedDirs.length === 0) return;
  let late = [];
  try { late = await expand.catchUp(cwd, expandedDirs); } catch { late = []; }
  if (late.length === 0 || state.cwd !== cwd) return;
  const spinner = require('./spinner');
  if ((state.activeOps || []).some(op => op.phase === 'running')) return;
  const { SCOPE } = require('./actions');
  const op = spinner.startSpinner(require('./i18n').t('menu.staging'), [SCOPE.INDEX]);
  try {
    await gitAddExplicitFiles(cwd, late, require('./i18n').t('git.couldNotStageAllFiles'));
  } finally {
    spinner.stopSpinner(op);
    if (typeof onDone === 'function') onDone();
  }
}

module.exports = { stageTargets, catchUpExpanded };
