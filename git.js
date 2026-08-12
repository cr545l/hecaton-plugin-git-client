// Git operations via hecaton host API (exec_process, fs_*)
// No direct child_process or fs usage — all operations go through host permission system.

const nodePath = require('path');

async function gitExec(args, cwd, timeout) {
  const result = await hecaton.process.exec({ program: 'git', args, cwd, timeout_ms: timeout || 5000 });
  if (result && result.ok) {
    return (result.stdout || '').replace(/\r\n/g, '\n');
  } else {
    return '';
  }
}

// gitExec은 실패(타임아웃/spawn 실패/비정상 종료)를 빈 출력으로 뭉갠다. "실제로 0건"과
// "명령이 실패해 아무것도 못 읽었다"를 구분해야 하는 호출자는 이 쪽을 쓴다.
// 예: for-each-ref가 실패했을 때 브랜치 목록을 빈 배열로 덮어쓰면 브랜치가 통째로 사라진다.
async function gitExecChecked(args, cwd, timeout) {
  const result = await hecaton.process.exec({ program: 'git', args, cwd, timeout_ms: timeout || 5000 });
  const ok = !!(result && result.ok);
  return { ok, text: ok ? (result.stdout || '').replace(/\r\n/g, '\n') : '' };
}

async function git(args, cwd, timeout) {
  const result = await hecaton.process.exec({ program: 'git', args, cwd, timeout_ms: timeout || 5000 });
  if (!result || !result.ok) {
    const err = new Error(result ? result.error || 'git failed' : 'exec_process failed');
    err.stderr = result ? (result.stderr || '') : '';
    err.stdout = result ? (result.stdout || '') : '';
    if (result && result.stdout) return result.stdout.replace(/\r\n/g, '\n');
    throw err;
  }
  return (result.stdout || '').replace(/\r\n/g, '\n');
}

async function gitResult(args, cwd, timeout) {
  return await hecaton.process.exec({ program: 'git', args, cwd, timeout_ms: timeout || 5000 });
}

const GIT_MUTATION_TIMEOUT_MS = 30000;
const MAX_GIT_ERROR_DETAIL = 3500;

function resultText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.message) return String(value.message);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function truncateGitDetail(text) {
  if (text.length <= MAX_GIT_ERROR_DETAIL) return text;
  const half = Math.floor((MAX_GIT_ERROR_DETAIL - 40) / 2);
  return text.substring(0, half) + '\n... output truncated ...\n' + text.substring(text.length - half);
}

function formatGitFailure(result, fallback, timeoutMs) {
  const errorText = resultText(result && result.error);
  const rpcErrorText = resultText(result && result.__rpcError);
  const stderrText = resultText(result && result.stderr);
  const stdoutText = resultText(result && result.stdout);
  const combined = [errorText, rpcErrorText, stderrText, stdoutText]
    .filter(Boolean)
    .join('\n')
    .replace(/\r\n/g, '\n')
    .trim();

  let lines = combined.split('\n').map(line => line.trimEnd()).filter(Boolean);
  const nonWarnings = lines.filter(line => !/^warning:/i.test(line));
  if (nonWarnings.length > 0) lines = nonWarnings;

  const exitCode = result && (result.exit_code !== undefined ? result.exit_code : result.code);
  let detail = lines.join('\n').trim();
  if (!detail && exitCode !== undefined && exitCode !== null) detail = 'Git exited with code ' + exitCode + '.';
  if (!detail) detail = 'Git did not return an error message.';
  detail = truncateGitDetail(detail);

  let message = fallback + ':\n' + detail;
  if (/timed?\s*out|timeout/i.test(combined)) {
    message += '\n\nThe Git command exceeded ' + Math.round(timeoutMs / 1000)
      + ' seconds. Wait for any active Git process to finish, then refresh and retry. '
      + 'For a very large selection, stage fewer files at a time.';
  } else if (/index\.lock|another git process seems to be running/i.test(combined)) {
    message += '\n\nAnother Git process may still be using the index. Close or wait for it first. '
      + 'Use the Unlock button only after confirming no Git process is running.';
  }
  return message;
}

async function gitMutation(args, cwd, timeout, fallback) {
  const timeoutMs = timeout || GIT_MUTATION_TIMEOUT_MS;
  let result;
  try {
    result = await gitResult(args, cwd, timeoutMs);
  } catch (e) {
    result = { ok: false, error: e };
  }
  const succeeded = !!(result && result.ok && (result.exit_code === undefined || result.exit_code === 0));
  return succeeded ? null : formatGitFailure(result, fallback, timeoutMs);
}

function unquoteGitPath(p) {
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') {
    const inner = p.slice(1, -1);
    const bytes = [];
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (next >= '0' && next <= '7') {
          let oct = next;
          let j = i + 2;
          while (j < inner.length && j < i + 4 && inner[j] >= '0' && inner[j] <= '7') {
            oct += inner[j];
            j++;
          }
          bytes.push(parseInt(oct, 8));
          i = j;
        } else {
          // Flush pending bytes as UTF-8 before handling escape
          if (bytes.length > 0) {
            // Will be flushed at the end
          }
          switch (next) {
            case 'n': bytes.push(0x0A); break;
            case 't': bytes.push(0x09); break;
            case 'a': bytes.push(0x07); break;
            case 'b': bytes.push(0x08); break;
            case '\\': bytes.push(0x5C); break;
            case '"': bytes.push(0x22); break;
            default: bytes.push(next.charCodeAt(0)); break;
          }
          i += 2;
        }
      } else {
        bytes.push(inner.charCodeAt(i));
        i++;
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return p;
}

// git이 뱉는 파일 경로(status/diff-files/ls-files)는 항상 저장소 루트 기준인데,
// pathspec은 실행 cwd 기준으로 해석된다. 하위 디렉터리에서 열면 두 기준이 어긋나
// 목록에 보이는 경로를 그대로 넘기는 stage/discard/diff가 전부 빗나간다
// ("error: pathspec 'frontend/package.json' did not match any file(s) known to git").
// 저장소를 열 때 워크트리 루트로 cwd를 맞춰 두 기준을 일치시킨다.
// .git이 디렉터리면 일반 저장소, 파일이면 linked worktree/submodule — 어느 쪽이든
// .git을 품은 디렉터리가 워크트리 루트다. 디스크 탐색을 먼저 하는 이유는 시작 경로에서
// git spawn을 늘리지 않기 위해서고, 못 찾은 경우(GIT_WORK_TREE 등)에만 git에 물어본다.
// 끝까지 확정하지 못하면(bare 저장소, 저장소 아님) 원래 경로를 그대로 둔다.
async function resolveWorkTreeRoot(cwd) {
  if (!cwd) return cwd;
  let dir;
  try {
    dir = nodePath.resolve(cwd);
  } catch {
    return cwd;
  }
  let probe = dir;
  while (probe) {
    try {
      const st = await hecaton.fs.stat({ path: nodePath.join(probe, '.git') });
      if (st && st.exists) return probe;
    } catch { /* keep walking */ }
    const parent = nodePath.dirname(probe);
    if (!parent || parent === probe) break;
    probe = parent;
  }
  const top = (await gitExec(['--no-optional-locks', 'rev-parse', '--show-toplevel'], cwd)).trim();
  if (!top) return cwd;
  try {
    return nodePath.resolve(top);
  } catch {
    return top;
  }
}

async function gitIsRepo(cwd) {
  const result = await hecaton.process.exec({ program: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, timeout_ms: 5000 });
  if (result && result.ok) return true;
  // Provide diagnostic detail for troubleshooting
  const detail = {};
  // Dump raw result for diagnosis
  detail.error = 'raw: ' + JSON.stringify(result);
  if (result && result.__rpcError) {
    detail.error = 'RPC error: ' + (result.__rpcError.message || JSON.stringify(result.__rpcError));
  } else if (result) {
    if (result.error) detail.error = result.error;
    if (result.stderr) detail.stderr = result.stderr;
    if (result.exit_code !== undefined) detail.exit_code = result.exit_code;
  } else {
    detail.error = 'exec_process returned null';
  }
  if (detail.error && /not found|cannot find|no such file|ENOENT/i.test(detail.error)) {
    detail.notFound = true;
  }
  return detail;
}

async function gitBranch(cwd) {
  try {
    return (await git(['branch', '--show-current'], cwd)).trim() || 'HEAD (detached)';
  } catch {
    return '???';
  }
}

// git-gui 방식: git status 대신 diff-index + diff-files + ls-files 분리
// - diff-index/diff-files는 index lock 불필요, 빠름
// - ls-files --others는 gui.displayuntracked 설정으로 조건부 실행
// - gui.maxfilesdisplayed로 표시 한도 제한 (untracked 우선 제외)

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d15363bf59a8';

function parseDiffOutput(raw) {
  const files = [];
  if (!raw) return files;
  const parts = raw.split('\0');
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta || meta[0] !== ':') { i++; continue; }
    // :old_mode new_mode old_hash new_hash status
    const fields = meta.substring(1).split(/\s+/);
    const statusField = fields[4] || '';
    const status = statusField[0] || '?';
    i++;
    const file = parts[i] || '';
    i++;
    if (status === 'R' || status === 'C') {
      const newFile = parts[i] || '';
      i++;
      files.push({ status, file: newFile });
    } else {
      files.push({ status, file });
    }
  }
  return files;
}

function parseLsFilesOutput(raw) {
  if (!raw) return [];
  return raw.split('\0').filter(p => p).map(file => {
    // 디렉토리 끝의 / 제거
    if (file.endsWith('/')) file = file.slice(0, -1);
    return { file };
  });
}

function parseStatusBranchHeader(header) {
  const text = (header || '').trim();
  if (!text) return '';
  const noCommits = text.match(/^No commits yet on (.+)$/);
  if (noCommits) return noCommits[1].trim();
  if (text.startsWith('HEAD ')) return '';
  return text.split('...')[0].replace(/\s+\[.*\]$/, '').trim();
}

function parseStatusPorcelain(raw, includeIgnored) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const ignored = [];
  let branch = '';
  if (!raw) return { staged, unstaged, untracked, ignored, branch };

  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    if (rec.startsWith('## ')) {
      branch = parseStatusBranchHeader(rec.substring(3));
      continue;
    }

    const x = rec[0];
    const y = rec[1];
    const file = rec.substring(3);
    if (!file) continue;

    if (x === '?' && y === '?') {
      untracked.push({ file });
      continue;
    }
    if (x === '!' && y === '!') {
      if (includeIgnored) ignored.push({ file });
      continue;
    }

    // In -z porcelain v1, rename/copy records are "XY new\0old\0".
    if ((x === 'R' || x === 'C') && i + 1 < parts.length) i++;

    const unmerged = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (unmerged) {
      unstaged.push({ status: 'U', file });
      continue;
    }

    if (x && x !== ' ') staged.push({ status: x, file });
    if (y && y !== ' ') unstaged.push({ status: y, file });
  }

  return { staged, unstaged, untracked, ignored, branch };
}

async function gitStatusPorcelain(cwd, opts = {}) {
  const showUntracked = opts.displayUntracked !== false;
  const includeIgnored = opts.includeIgnored === true;
  const maxFiles = opts.maxFilesDisplayed || 0;
  const statusTimeout = opts.timeout || 15000;
  const args = [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    showUntracked ? '--untracked-files=normal' : '--untracked-files=no',
  ];
  if (opts.includeBranch === true) args.push('--branch');
  if (showUntracked && includeIgnored) args.push('--ignored');

  const result = await hecaton.process.exec({ program: 'git', args, cwd, timeout_ms: statusTimeout });
  if (!result || !result.ok) {
    if (opts.nullOnError) return null;
    return { staged: [], unstaged: [], untracked: [], ignored: [], branch: '' };
  }
  const snapshot = parseStatusPorcelain((result.stdout || '').replace(/\r\n/g, '\n'), includeIgnored);
  if (maxFiles > 0) {
    const trackedCount = snapshot.staged.length + snapshot.unstaged.length;
    const untrackedLimit = Math.max(0, maxFiles - trackedCount);
    if (snapshot.untracked.length > untrackedLimit) {
      snapshot.untracked = snapshot.untracked.slice(0, untrackedLimit);
    }
  }
  return snapshot;
}

async function gitStatusSplit(cwd, opts = {}) {
  const showUntracked = opts.displayUntracked !== false;
  const includeIgnored = opts.includeIgnored === true;
  const maxFiles = opts.maxFilesDisplayed || 0;
  const statusTimeout = opts.timeout || 15000;

  // HEAD 존재 여부 확인 → diff-index 대상 결정
  const headRef = await gitExec(['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'], cwd);
  const diffTarget = headRef.trim() || EMPTY_TREE;

  // 1단계: 빠른 명령 병렬 실행
  const promises = [
    gitExec(['--no-optional-locks', 'diff-index', '--cached', '-z', diffTarget], cwd, statusTimeout),
    gitExec(['--no-optional-locks', 'diff-files', '-z'], cwd, statusTimeout),
  ];
  // untracked/ignored는 조건부
  if (showUntracked) {
    promises.push(gitExec(['--no-optional-locks', 'ls-files', '--others', '--directory', '--no-empty-directory', '-z', '--exclude-standard'], cwd, statusTimeout));
    if (includeIgnored) {
      promises.push(gitExec(['--no-optional-locks', 'ls-files', '--others', '--ignored', '--directory', '--no-empty-directory', '-z', '--exclude-standard'], cwd, statusTimeout));
    }
  }

  const results = await Promise.all(promises);
  const staged = parseDiffOutput(results[0]);
  const unstaged = parseDiffOutput(results[1]);
  let untracked = showUntracked ? parseLsFilesOutput(results[2]) : [];
  let ignored = showUntracked && includeIgnored ? parseLsFilesOutput(results[3]) : [];

  // maxFilesDisplayed 적용 — git-gui처럼 untracked 파일부터 제한
  if (maxFiles > 0) {
    const trackedCount = staged.length + unstaged.length;
    const untrackedLimit = Math.max(0, maxFiles - trackedCount);
    if (untracked.length > untrackedLimit) {
      untracked = untracked.slice(0, untrackedLimit);
    }
  }

  return { staged, unstaged, untracked, ignored };
}

// 하위 호환: 기존 gitStatus도 유지 (git-gui 방식으로 내부 변경)
async function gitStatus(cwd) {
  return gitStatusSplit(cwd);
}

async function gitDiff(cwd, file, isStaged) {
  try {
    const args = ['diff'];
    if (isStaged) args.push('--cached');
    args.push('--', file);
    return await git(args, cwd);
  } catch {
    return '';
  }
}

async function gitDiffUntracked(cwd, file) {
  try {
    return await git(['diff', '--no-index', '--', '/dev/null', file], cwd);
  } catch {
    return '';
  }
}

async function gitStage(cwd, file) {
  return await gitMutation(['add', '-f', '--', file], cwd, 10000, 'Could not stage ' + file);
}

// unstage는 커밋 하나 없는 저장소(unborn HEAD)에서도 동작해야 한다.
// 'restore --staged'나 'reset HEAD'는 HEAD를 해석하지 못해 fatal로 죽으므로,
// HEAD를 생략한 'reset'을 쓴다. HEAD가 있으면 'reset HEAD'와 동작이 같고,
// 없으면 인덱스에서 항목을 지워 untracked로 되돌린다. 워킹트리는 어느 쪽이든 그대로다.
async function gitUnstage(cwd, file) {
  return await gitMutation(['reset', '--', file], cwd, 10000, 'Could not unstage ' + file);
}

async function gitStageAll(cwd) {
  // Never force ignored files into the index. `-f -A` can unexpectedly walk
  // large ignored trees such as node_modules/.venv and make Stage All time out.
  return await gitMutation(['add', '-A'], cwd, GIT_MUTATION_TIMEOUT_MS, 'Could not stage all files');
}

async function gitUnstageAll(cwd) {
  return await gitMutation(['reset'], cwd, GIT_MUTATION_TIMEOUT_MS, 'Could not unstage all files');
}

async function gitCommit(cwd, message) {
  try {
    await git(['commit', '-m', message], cwd);
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Commit failed';
  }
}

// git rev-parse --git-dir 절대경로 해석 (worktree 포함)
async function resolveGitDirAbs(cwd) {
  try {
    const gitDir = (await git(['rev-parse', '--git-dir'], cwd)).trim();
    if (!gitDir) return '';
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const isAbsolute = gitDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(gitDir);
    return isAbsolute ? gitDir : (cwd + sep + gitDir);
  } catch {
    return '';
  }
}

async function gitStashRefs(cwd) {
  try {
    const raw = (await git(['stash', 'list', '--format=%H\t%h\t%gd'], cwd)).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      return { hash: parts[0], shortHash: parts[1], ref: parts[2] };
    });
  } catch {
    return [];
  }
}

async function gitShowRef(cwd, ref) {
  try {
    return await git(['show', ref], cwd);
  } catch {
    return '';
  }
}

async function gitStashDiff(cwd, ref) {
  try {
    return await git(['stash', 'show', '-p', ref], cwd);
  } catch {
    return '';
  }
}

async function gitOperationState(cwd) {
  try {
    const gitDir = (await git(['rev-parse', '--git-dir'], cwd)).trim();
    // Use path separators that work cross-platform
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const base = cwd + sep + gitDir;
    // Check rebase-merge via fs_stat
    const rebaseMerge = base + sep + 'rebase-merge';
    const rmStat = await hecaton.fs.stat({ path: rebaseMerge });
    if (rmStat && rmStat.exists && rmStat.is_dir) {
      const stepRes = await hecaton.fs.read_file({ path: rebaseMerge + sep + 'msgnum' });
      const totalRes = await hecaton.fs.read_file({ path: rebaseMerge + sep + 'end' });
      const step = stepRes && stepRes.content ? stepRes.content.trim() : '0';
      const total = totalRes && totalRes.content ? totalRes.content.trim() : '0';
      return { type: 'rebase-merge', step: parseInt(step), total: parseInt(total) };
    }
    // Check rebase-apply
    const rebaseApply = base + sep + 'rebase-apply';
    const raStat = await hecaton.fs.stat({ path: rebaseApply });
    if (raStat && raStat.exists && raStat.is_dir) {
      const stepRes = await hecaton.fs.read_file({ path: rebaseApply + sep + 'next' });
      const totalRes = await hecaton.fs.read_file({ path: rebaseApply + sep + 'last' });
      const step = stepRes && stepRes.content ? stepRes.content.trim() : '0';
      const total = totalRes && totalRes.content ? totalRes.content.trim() : '0';
      return { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
    }
    // Check merge
    const mergeHead = base + sep + 'MERGE_HEAD';
    const mhStat = await hecaton.fs.stat({ path: mergeHead });
    if (mhStat && mhStat.exists) return { type: 'merge' };
    // Check cherry-pick
    const cherryHead = base + sep + 'CHERRY_PICK_HEAD';
    const chStat = await hecaton.fs.stat({ path: cherryHead });
    if (chStat && chStat.exists) return { type: 'cherry-pick' };
    // Check revert
    const revertHead = base + sep + 'REVERT_HEAD';
    const rvStat = await hecaton.fs.stat({ path: revertHead });
    if (rvStat && rvStat.exists) return { type: 'revert' };
  } catch { /* not in operation */ }
  return null;
}
const gitRebaseState = gitOperationState; // backward compat

async function gitRunOrError(args, cwd, timeout, errorMsg) {
  const r = await gitResult(args, cwd, timeout || 30000);
  if (r && r.ok && r.exit_code === 0) return null;
  const stderr = r && r.stderr ? r.stderr.replace(/\r\n/g, '\n').trim() : '';
  const stdout = r && r.stdout ? r.stdout.replace(/\r\n/g, '\n').trim() : '';
  return stderr || stdout || errorMsg;
}

async function gitCheckoutOurs(cwd, file) { return await gitRunOrError(['checkout', '--ours', '--', file], cwd, 10000, 'Checkout ours failed'); }
async function gitCheckoutTheirs(cwd, file) { return await gitRunOrError(['checkout', '--theirs', '--', file], cwd, 10000, 'Checkout theirs failed'); }

async function gitRebase(cwd, ref) { return await gitRunOrError(['rebase', ref], cwd, 30000, 'Rebase failed'); }
async function gitRebaseContinue(cwd) { return await gitRunOrError(['-c', 'core.editor=true', 'rebase', '--continue'], cwd, 30000, 'Rebase continue failed'); }
async function gitRebaseAbort(cwd) { return await gitRunOrError(['rebase', '--abort'], cwd, 30000, 'Rebase abort failed'); }
async function gitRebaseSkip(cwd) { return await gitRunOrError(['-c', 'core.editor=true', 'rebase', '--skip'], cwd, 30000, 'Rebase skip failed'); }
async function gitMergeContinue(cwd) { return await gitRunOrError(['commit', '--no-edit'], cwd, 30000, 'Merge commit failed'); }
async function gitMergeAbort(cwd) { return await gitRunOrError(['merge', '--abort'], cwd, 30000, 'Merge abort failed'); }
async function gitCherryPickContinue(cwd) { return await gitRunOrError(['-c', 'core.editor=true', 'cherry-pick', '--continue'], cwd, 30000, 'Cherry-pick continue failed'); }
async function gitCherryPickAbort(cwd) { return await gitRunOrError(['cherry-pick', '--abort'], cwd, 30000, 'Cherry-pick abort failed'); }
async function gitCherryPickSkip(cwd) { return await gitRunOrError(['-c', 'core.editor=true', 'cherry-pick', '--skip'], cwd, 30000, 'Cherry-pick skip failed'); }
async function gitRevertContinue(cwd) { return await gitRunOrError(['-c', 'core.editor=true', 'revert', '--continue'], cwd, 30000, 'Revert continue failed'); }
async function gitRevertAbort(cwd) { return await gitRunOrError(['revert', '--abort'], cwd, 30000, 'Revert abort failed'); }
async function gitRevertSkip(cwd) { return await gitRunOrError(['-c', 'core.editor=true', 'revert', '--skip'], cwd, 30000, 'Revert skip failed'); }

async function gitLogCommits(cwd, extraRefs, maxCount) {
  try {
    const args = ['log', '--all', '--topo-order', '--format=%x01%H%x00%P%x00%D%x00%an%x00%aI%x00%cn%x00%cI%x00%B'];
    if (extraRefs && extraRefs.length > 0) args.push(...extraRefs);
    if (maxCount) args.push('-' + maxCount);
    const raw = (await git(args, cwd, 30000)).replace(/\r/g, '').trim();
    if (!raw) return [];
    return raw.split('\x01').filter(r => r.trim()).map(record => {
      const trimmed = record.trim();
      const parts = [];
      let pos = 0;
      for (let i = 0; i < 7; i++) {
        const next = trimmed.indexOf('\x00', pos);
        if (next === -1) break;
        parts.push(trimmed.substring(pos, next));
        pos = next + 1;
      }
      parts.push(trimmed.substring(pos));
      const fullBody = (parts[7] || '').trim();
      const firstLine = fullBody.split('\n')[0];
      return {
        hash: parts[0] || '',
        parents: parts[1] ? parts[1].split(' ') : [],
        refs: parts[2] || '',
        authorName: parts[3] || '',
        authorDate: parts[4] || '',
        committerName: parts[5] || '',
        committerDate: parts[6] || '',
        subject: firstLine.replace(/[\r\n]/g, ''),
        body: fullBody,
      };
    });
  } catch {
    return [];
  }
}

// Split an upstream ref such as "origin/hecaton/render" into its remote and
// branch parts. Remote names never contain '/' but branch names do, so match
// against the known remotes first and fall back to the leading segment.
function splitUpstreamRef(upstream, remotes) {
  if (!upstream) return { remote: '', branch: '' };
  for (const r of (remotes || [])) {
    if (r && upstream.startsWith(r + '/')) return { remote: r, branch: upstream.substring(r.length + 1) };
  }
  const idx = upstream.indexOf('/');
  if (idx < 0) return { remote: '', branch: upstream };
  return { remote: upstream.substring(0, idx), branch: upstream.substring(idx + 1) };
}

// upstream 대비 밀림/뒤처짐은 track(개수)과 trackshort(방향)를 함께 읽는다.
// track 문자열("[ahead 2, behind 1]")은 로케일에 따라 번역될 수 있어 숫자만 뽑고,
// 어느 쪽이 ahead인지는 번역되지 않는 trackshort(>, <, <>, =)로 판별한다.
function parseUpstreamTrack(track, trackShort) {
  const info = { ahead: 0, behind: 0, gone: false };
  if (!track && !trackShort) return info;
  if (/\bgone\b/.test(track)) { info.gone = true; return info; }
  const nums = (track.match(/\d+/g) || []).map(Number);
  if (trackShort === '>') info.ahead = nums[0] || 0;
  else if (trackShort === '<') info.behind = nums[0] || 0;
  else if (trackShort === '<>') { info.ahead = nums[0] || 0; info.behind = nums[1] || 0; }
  return info;
}

async function gitBranches(cwd) {
  try {
    const raw = (await git(['branch', '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)\t%(upstream:trackshort)'], cwd)).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      const track = parseUpstreamTrack(parts[3] || '', parts[4] || '');
      return {
        name: parts[0],
        isCurrent: parts[1] === '*',
        upstream: parts[2] || '',
        ahead: track.ahead,
        behind: track.behind,
        upstreamGone: track.gone,
      };
    });
  } catch {
    return [];
  }
}

function normalizePathForCompare(path) {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function gitWorktrees(cwd) {
  try {
    const raw = (await git(['worktree', 'list', '--porcelain'], cwd)).replace(/\r/g, '').trim();
    if (!raw) return [];
    const currentPath = normalizePathForCompare(cwd);
    const blocks = raw.split(/\n\s*\n/).filter(Boolean);
    const items = blocks.map((block, idx) => {
      const item = {
        path: '',
        head: '',
        branch: '',
        isCurrent: false,
        isMain: idx === 0,   // porcelain 출력의 첫 블록은 항상 메인 워크트리
        isDetached: false,
        isBare: false,
        isLocked: false,
        isPrunable: false,
      };
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) item.path = line.substring(9).trim();
        else if (line.startsWith('HEAD ')) item.head = line.substring(5).trim();
        else if (line.startsWith('branch ')) item.branch = line.substring(7).trim().replace(/^refs\/heads\//, '');
        else if (line === 'detached') item.isDetached = true;
        else if (line === 'bare') item.isBare = true;
        else if (line.startsWith('locked')) item.isLocked = true;
        else if (line.startsWith('prunable')) item.isPrunable = true;
      }
      return item;
    });
    // cwd가 워크트리 하위 디렉터리일 수 있으므로 가장 긴 경로 접두사를 현재 워크트리로 본다.
    let bestIdx = -1, bestLen = -1;
    for (let i = 0; i < items.length; i++) {
      const p = normalizePathForCompare(items[i].path);
      if (!p) continue;
      if ((currentPath === p || currentPath.startsWith(p + '/')) && p.length > bestLen) {
        bestLen = p.length;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) items[bestIdx].isCurrent = true;
    return items;
  } catch {
    return [];
  }
}

async function gitReflogRecoveries(cwd, maxEntries, maxCandidates, maxDepth) {
  try {
    const entryLimit = maxEntries || 200;
    const candidateLimit = maxCandidates || 64;
    const depthLimit = maxDepth || 256;
    const raw = (await git([
      '--no-optional-locks',
      'reflog',
      '--all',
      '-n',
      String(entryLimit),
      '--format=%H%x00%gd%x00%gs',
    ], cwd, 30000)).replace(/\r/g, '').trim();
    if (!raw) return { hashes: [], refsByHash: {} };

    const refsByHash = {};
    const candidates = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const parts = line.split('\x00');
      const hash = (parts[0] || '').trim();
      if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
      if (!refsByHash[hash]) {
        refsByHash[hash] = {
          selector: (parts[1] || '').trim(),
          subject: (parts[2] || '').trim(),
        };
        candidates.push(hash);
        if (candidates.length >= candidateLimit) break;
      }
    }
    if (candidates.length === 0) return { hashes: [], refsByHash: {} };

    const lostRaw = (await git([
      '--no-optional-locks',
      'rev-list',
      '--date-order',
      '--max-count',
      String(depthLimit),
      ...candidates,
      '--not',
      '--all',
    ], cwd, 30000)).replace(/\r/g, '').trim();
    if (!lostRaw) return { hashes: [], refsByHash: {} };

    const hashes = [];
    const seen = new Set();
    for (const hash of lostRaw.split('\n')) {
      if (hash && !seen.has(hash)) {
        seen.add(hash);
        hashes.push(hash);
      }
    }
    const filteredRefs = {};
    for (const hash of hashes) {
      if (refsByHash[hash]) filteredRefs[hash] = refsByHash[hash];
    }
    return { hashes, refsByHash: filteredRefs };
  } catch {
    return { hashes: [], refsByHash: {} };
  }
}

async function gitRemotes(cwd) {
  try {
    const raw = (await git(['remote'], cwd)).trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function gitRemoteBranches(cwd) {
  try {
    const raw = (await git(['branch', '-r', '--format=%(refname:short)'], cwd)).trim();
    if (!raw) return [];
    return raw.split('\n').filter(b => !b.includes('/HEAD'));
  } catch {
    return [];
  }
}

async function gitCherryPick(cwd, ref) { return await gitRunOrError(['cherry-pick', ref], cwd, 30000, 'Cherry-pick failed'); }
async function gitCherryPickNoCommit(cwd, ref) { return await gitRunOrError(['cherry-pick', '--no-commit', ref], cwd, 30000, 'Cherry-pick failed'); }
async function gitRevert(cwd, ref) { return await gitRunOrError(['revert', '--no-edit', ref], cwd, 30000, 'Revert failed'); }
async function gitCheckoutRef(cwd, ref) { return await gitRunOrError(['checkout', ref], cwd, 10000, 'Checkout failed'); }

async function gitCreateBranch(cwd, name, startPoint) {
  const args = ['checkout', '-b', name];
  if (startPoint) args.push(startPoint);
  return await gitRunOrError(args, cwd, 10000, 'Create branch failed');
}

async function gitCreateTag(cwd, name, ref) {
  try {
    const args = ['tag', name];
    if (ref) args.push(ref);
    await git(args, cwd);
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Create tag failed';
  }
}

async function gitReset(cwd, ref) { return await gitRunOrError(['reset', '--hard', ref], cwd, 30000, 'Reset failed'); }
async function gitMerge(cwd, ref) { return await gitRunOrError(['merge', ref], cwd, 30000, 'Merge failed'); }

async function gitAheadBehind(cwd) {
  try {
    const output = await git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
    const parts = output.trim().split(/\s+/);
    return { behind: parseInt(parts[0]) || 0, ahead: parseInt(parts[1]) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

async function gitFetch(cwd) { return await gitRunOrError(['fetch', '--all', '--prune'], cwd, 30000, 'Fetch failed'); }
async function gitPull(cwd) { return await gitRunOrError(['pull'], cwd, 30000, 'Pull failed'); }
async function gitPush(cwd) { return await gitRunOrError(['push'], cwd, 30000, 'Push failed'); }

// Async helpers — in Deno runner, exec_process is synchronous RPC,
// but we wrap in Promise to keep the same API for spinner-compatible callers.
async function gitAsyncWrap(args, cwd, timeout) {
  const r = await gitResult(args, cwd, timeout || 30000);
  if (r && r.ok && r.exit_code === 0) return null;
  // rebase/merge 계열은 실패 사유를 stdout 으로만 내보내는 경우가 있다.
  // stderr 가 비었다고 'Operation failed' 로 뭉개지 말고 stdout 을 쓴다.
  const stderr = r && r.stderr ? r.stderr.replace(/\r\n/g, '\n').trim() : '';
  const stdout = r && r.stdout ? r.stdout.replace(/\r\n/g, '\n').trim() : '';
  return stderr || stdout || 'Operation failed';
}

async function gitCheckRebaseConflicts(cwd, targetRef) {
  // Use merge-tree to predict conflicts without actually rebasing
  // merge-tree --write-tree HEAD targetRef returns exit code 1 if there are conflicts
  const r = await gitResult(['merge-tree', '--write-tree', 'HEAD', targetRef], cwd, 10000);
  if (!r || !r.ok) return { willConflict: false };
  if (r.exit_code === 0) return { willConflict: false };
  // Parse conflict info from stdout
  const stdout = (r.stdout || '').replace(/\r\n/g, '\n');
  const conflictFiles = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const m = line.match(/^CONFLICT \([^)]+\): .* in (.+)$/);
    if (m) conflictFiles.push(m[1]);
    else if (line.startsWith('CONFLICT')) conflictFiles.push(line);
  }
  return { willConflict: true, files: conflictFiles };
}

async function gitFetchAsync(cwd) { return await gitAsyncWrap(['fetch', '--all', '--prune'], cwd); }
async function gitPullAsync(cwd) { return await gitAsyncWrap(['pull'], cwd); }
async function gitPushAsync(cwd) { return await gitAsyncWrap(['push'], cwd); }
async function gitRebaseAsync(cwd, ref) { return await gitAsyncWrap(['rebase', ref], cwd); }
// ref 가 이미 HEAD 의 조상이면 옮길 커밋이 없어 rebase 는 아무 일도 하지 않는다.
// 이때 git 은 "Current branch X is up to date." 를 stdout 에 찍고 exit 0 으로 끝내므로
// 호출부에서 성공과 구분되지 않는다. 실행 전에 미리 판별해 안내에 쓴다.
async function gitIsRebaseNoop(cwd, ref) {
  const r = await gitResult(['merge-base', '--is-ancestor', ref, 'HEAD'], cwd, 10000);
  return !!(r && r.ok && r.exit_code === 0);
}
async function gitRebaseContinueAsync(cwd) { return await gitAsyncWrap(['-c', 'core.editor=true', 'rebase', '--continue'], cwd); }
async function gitRebaseAbortAsync(cwd) { return await gitAsyncWrap(['rebase', '--abort'], cwd); }
async function gitRebaseSkipAsync(cwd) { return await gitAsyncWrap(['-c', 'core.editor=true', 'rebase', '--skip'], cwd); }
async function gitMergeAsync(cwd, ref) { return await gitAsyncWrap(['merge', ref], cwd); }
async function gitResetAsync(cwd, ref) { return await gitAsyncWrap(['reset', '--hard', ref], cwd); }
async function gitCheckoutRefAsync(cwd, ref) { return await gitAsyncWrap(['checkout', ref], cwd, 10000); }
async function gitCherryPickAsync(cwd, ref) { return await gitAsyncWrap(['cherry-pick', ref], cwd); }
async function gitCherryPickNoCommitAsync(cwd, ref) { return await gitAsyncWrap(['cherry-pick', '--no-commit', ref], cwd); }
async function gitRevertAsync(cwd, ref) { return await gitAsyncWrap(['revert', '--no-edit', ref], cwd); }
async function gitStashSaveAsync(cwd) { return await gitAsyncWrap(['stash', 'push'], cwd, 10000); }
async function gitCommitAsync(cwd, message) { return await gitAsyncWrap(['commit', '-m', message], cwd, 30000); }
// 일반 amend: staged 변경을 포함해 마지막 커밋을 재작성
async function gitCommitAmendAsync(cwd, message) { return await gitAsyncWrap(['commit', '--amend', '-m', message], cwd, 30000); }
// 메시지만 amend: staged 변경은 그대로 두고 메시지만 교체 (--amend --only, pathspec 없음)
async function gitCommitAmendMessageOnlyAsync(cwd, message) { return await gitAsyncWrap(['commit', '--amend', '--only', '-m', message], cwd, 30000); }
async function gitResetModeAsync(cwd, ref, mode) {
  const m = mode === 'soft' || mode === 'mixed' || mode === 'hard' ? mode : 'mixed';
  return await gitAsyncWrap(['reset', '--' + m, ref], cwd);
}

// ── Hunk 단위 스테이징 ──
// 단일 파일 diff 출력(rawLines)을 파일 헤더 + hunk 목록으로 분해
function parseDiffHunks(rawLines) {
  const headerLines = [];
  const hunks = [];
  let current = null;
  let inHeader = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = (rawLines[i] || '').replace(/[\r\n]/g, '');
    if (i === rawLines.length - 1 && line === '') continue;
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      current = null;
      headerLines.length = 0;
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('@@ ')) {
      inHeader = false;
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (inHeader) { headerLines.push(line); continue; }
    if (current) current.lines.push(line);
  }
  return { headerLines, hunks };
}

// hunkIdx번째 hunk만 담은 독립 패치 텍스트 생성
function buildHunkPatchText(rawLines, hunkIdx) {
  const { headerLines, hunks } = parseDiffHunks(rawLines);
  const hunk = hunks[hunkIdx];
  if (!hunk || headerLines.length === 0) return '';
  let patch = headerLines.join('\n') + '\n' + hunk.header + '\n';
  if (hunk.lines.length > 0) patch += hunk.lines.join('\n') + '\n';
  return patch;
}

// 패치 텍스트를 임시 파일로 저장 후 git apply (stdin 미지원 호스트 대응)
async function gitApplyPatchText(cwd, patchText, opts = {}) {
  try {
    const gitDirAbs = await resolveGitDirAbs(cwd);
    if (!gitDirAbs) return 'Failed to resolve git directory';
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const patchPath = gitDirAbs + sep + 'hecaton-hunk.patch';
    await hecaton.fs.write_file({ path: patchPath, content: patchText });
    const args = ['apply', '--whitespace=nowarn'];
    if (opts.cached) args.push('--cached');
    if (opts.reverse) args.push('-R');
    args.push(patchPath);
    return await gitRunOrError(args, cwd, 10000, 'Apply patch failed');
  } catch (e) {
    return (e && e.message) || 'Apply patch failed';
  }
}

// ── 인터랙티브 리베이스 (todo 자동 생성) ──
// git이 editor를 shell로 실행할 때 'cp "<src>" <대상파일>' 형태가 되도록 복사 명령 구성
function buildCopyEditorCommand(srcPath) {
  if (typeof process !== 'undefined' && process.platform === 'win32') {
    return 'cmd /c copy /y "' + srcPath + '"';
  }
  return 'cp "' + srcPath.replace(/(["\\$`])/g, '\\$1') + '"';
}

// baseRef..HEAD 커밋을 오래된 순으로 나열 (baseRef가 null이면 루트부터 전체)
async function listRebaseCommits(cwd, baseRef) {
  const args = ['rev-list', '--reverse'];
  if (baseRef) args.push(baseRef + '..HEAD'); else args.push('HEAD');
  const raw = (await gitExec(args, cwd, 15000)).trim();
  return raw ? raw.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

// 준비된 todo 내용으로 rebase -i 실행. sequence.editor를 복사 명령으로 바꿔치기해
// 에디터 상호작용 없이 진행한다. core.editor=true로 기본 메시지를 그대로 수용
// (squash의 결합 메시지 등). 참고: reword는 일부 git 버전에서 비대화형 실행 시
// 에디터를 호출하지 않으므로 edit + amend + continue 방식을 사용해야 한다.
async function gitRunRebaseTodo(cwd, baseRef, todoContent) {
  const gitDirAbs = await resolveGitDirAbs(cwd);
  if (!gitDirAbs) return 'Failed to resolve git directory';
  const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
  const todoPath = gitDirAbs + sep + 'hecaton-rebase-todo.txt';
  try {
    await hecaton.fs.write_file({ path: todoPath, content: todoContent });
  } catch (e) {
    return (e && e.message) || 'Failed to write rebase todo';
  }
  const args = [
    '-c', 'sequence.editor=' + buildCopyEditorCommand(todoPath),
    '-c', 'core.editor=true',
    'rebase', '-i',
  ];
  if (baseRef) args.push(baseRef); else args.push('--root');
  return await gitAsyncWrap(args, cwd, 60000);
}

// 커밋 메시지 변경. HEAD면 amend --only.
// 과거 커밋이면 edit로 해당 커밋에서 멈춘 뒤 amend --only → continue.
// (reword todo는 비대화형 환경에서 에디터가 호출되지 않아 사용 불가)
async function gitRewordCommitAsync(cwd, ref, message) {
  const full = (await gitExec(['rev-parse', ref], cwd)).trim();
  if (!full) return 'Cannot resolve commit ' + ref;
  const head = (await gitExec(['rev-parse', 'HEAD'], cwd)).trim();
  if (head && head === full) {
    return await gitCommitAmendMessageOnlyAsync(cwd, message);
  }
  const parent = (await gitExec(['rev-parse', '--verify', '--quiet', full + '^'], cwd)).trim();
  const base = parent ? full + '^' : null;
  const commits = await listRebaseCommits(cwd, base);
  if (!commits.includes(full)) return 'Commit is not an ancestor of HEAD';
  const todo = commits.map(h => (h === full ? 'edit ' : 'pick ') + h).join('\n') + '\n';
  const startErr = await gitRunRebaseTodo(cwd, base, todo);
  if (startErr) return startErr;
  const amendErr = await gitCommitAmendMessageOnlyAsync(cwd, message);
  if (amendErr) {
    await gitAsyncWrap(['rebase', '--abort'], cwd, 30000);
    return amendErr;
  }
  return await gitAsyncWrap(['-c', 'core.editor=true', 'rebase', '--continue'], cwd, 60000);
}

// 커밋을 부모로 합치기. discardMessage=true면 fixup(메시지 버림), 아니면 squash(메시지 결합).
async function gitSquashIntoParentAsync(cwd, ref, discardMessage) {
  const full = (await gitExec(['rev-parse', ref], cwd)).trim();
  if (!full) return 'Cannot resolve commit ' + ref;
  const parent = (await gitExec(['rev-parse', '--verify', '--quiet', full + '^'], cwd)).trim();
  if (!parent) return 'Commit has no parent to squash into';
  const grandparent = (await gitExec(['rev-parse', '--verify', '--quiet', parent + '^'], cwd)).trim();
  const base = grandparent ? full + '^^' : null;
  const commits = await listRebaseCommits(cwd, base);
  if (!commits.includes(full)) return 'Commit is not an ancestor of HEAD';
  const todo = commits.map(h => (h === full ? (discardMessage ? 'fixup ' : 'squash ') : 'pick ') + h).join('\n') + '\n';
  return await gitRunRebaseTodo(cwd, base, todo);
}

// 커밋을 히스토리에서 제거
async function gitDropCommitAsync(cwd, ref) {
  const full = (await gitExec(['rev-parse', ref], cwd)).trim();
  if (!full) return 'Cannot resolve commit ' + ref;
  const parent = (await gitExec(['rev-parse', '--verify', '--quiet', full + '^'], cwd)).trim();
  const base = parent ? full + '^' : null;
  const commits = await listRebaseCommits(cwd, base);
  if (!commits.includes(full)) return 'Commit is not an ancestor of HEAD';
  const remaining = commits.filter(h => h !== full);
  const todo = remaining.length > 0 ? remaining.map(h => 'pick ' + h).join('\n') + '\n' : 'noop\n';
  return await gitRunRebaseTodo(cwd, base, todo);
}

// 해당 커밋에서 리베이스를 멈춰 내용 수정(amend) 가능 상태로 만든다
async function gitEditCommitAsync(cwd, ref) {
  const full = (await gitExec(['rev-parse', ref], cwd)).trim();
  if (!full) return 'Cannot resolve commit ' + ref;
  const parent = (await gitExec(['rev-parse', '--verify', '--quiet', full + '^'], cwd)).trim();
  const base = parent ? full + '^' : null;
  const commits = await listRebaseCommits(cwd, base);
  if (!commits.includes(full)) return 'Commit is not an ancestor of HEAD';
  const todo = commits.map(h => (h === full ? 'edit ' : 'pick ') + h).join('\n') + '\n';
  return await gitRunRebaseTodo(cwd, base, todo);
}
async function gitStashPopAsync(cwd) { return await gitAsyncWrap(['stash', 'pop'], cwd, 10000); }
async function gitStageAsync(cwd, file) {
  return await gitStage(cwd, file);
}
async function gitUnstageAsync(cwd, file) {
  return await gitUnstage(cwd, file);
}
async function gitStageMultiple(cwd, files) {
  if (files.length === 0) return null;
  if (files.length === 1) return gitStage(cwd, files[0]);
  return await gitMutation(
    ['add', '-f', '--', ...files],
    cwd,
    GIT_MUTATION_TIMEOUT_MS,
    'Could not stage ' + files.length + ' selected files'
  );
}
async function gitUnstageMultiple(cwd, files) {
  if (files.length === 0) return null;
  if (files.length === 1) return gitUnstage(cwd, files[0]);
  return await gitMutation(
    ['reset', '--', ...files],
    cwd,
    GIT_MUTATION_TIMEOUT_MS,
    'Could not unstage ' + files.length + ' selected files'
  );
}

// git config --get-regexp 에 넘길 값 이스케이프 — 브랜치 이름의 '.' '+' 등이
// 메타문자로 해석되지 않게 한다 (v1.0, feat+x 같은 이름).
function escapeConfigRegex(value) {
  return String(value).replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
}

async function branchRefExists(cwd, name) {
  const r = await gitResult(['show-ref', '--verify', '--quiet', 'refs/heads/' + name], cwd, 5000);
  return !!(r && r.ok && r.exit_code === 0);
}

// branch.<name>.* 키가 남아 있는지. --rename-section 은 대상 섹션이 없으면 fatal 을
// 내는데 그 메시지는 로케일에 따라 번역되므로, 문자열 대신 존재 여부로 판단한다.
async function hasBranchConfigSection(cwd, name) {
  const r = await gitResult(
    ['config', '--local', '--get-regexp', '^branch\\.' + escapeConfigRegex(name) + '\\.'],
    cwd, 5000,
  );
  return !!(r && r.ok && r.exit_code === 0 && (r.stdout || '').trim());
}

// `git branch -m` 은 (1) ref 이름 변경 → (2) reflog 이동 → (3) config 의 branch.<old>.*
// 섹션 이름 변경 순으로 진행하고, .git/config.lock 은 (3)에서만 잡는다. 다른 클라이언트가
// config 를 쓰는 중이거나 죽은 프로세스가 남긴 stale lock 이 있으면 (1)(2)가 이미 끝난 뒤라
// git 은 fatal 을 내면서도 리네임 자체는 완료해 놓는다:
//   error: could not lock config file .git/config
//   fatal: branch is renamed, but update of config-file failed
// 옮길 섹션이 하나도 없는 브랜치(upstream 미설정)도 lock 부터 잡으므로 똑같이 실패하고,
// worktree 는 config 를 메인 리포와 공유하므로 같은 lock 을 탄다.
// 이걸 그대로 올리면 "에러가 떴는데 이름은 바뀌어 있다"가 되므로, ref 가 실제로 옮겨졌는지
// 확인하고 남은 config 섹션을 직접 옮겨 마무리한다.
// 반환: { renamed, error } — renamed 는 ref 가 새 이름으로 옮겨졌는지.
async function gitRenameBranch(cwd, oldName, newName) {
  const err = await gitRunOrError(['branch', '-m', oldName, newName], cwd, 10000, 'Rename branch failed');
  if (!err) return { renamed: true, error: null };
  // ref 가 그대로면 이름 충돌·없는 브랜치 같은 평범한 실패다.
  if (!(await branchRefExists(cwd, newName)) || await branchRefExists(cwd, oldName)) {
    return { renamed: false, error: err };
  }
  // 옮길 설정이 애초에 없으면 config 갱신 실패로 잃은 것이 없다 — 성공으로 끝낸다.
  if (!(await hasBranchConfigSection(cwd, oldName))) return { renamed: true, error: null };
  const moveErr = await gitRunOrError(
    ['config', '--local', '--rename-section', 'branch.' + oldName, 'branch.' + newName],
    cwd, 10000, 'Could not move branch config',
  );
  if (!moveErr) return { renamed: true, error: null };
  return {
    renamed: true,
    error: "Branch was renamed to '" + newName + "', but .git/config could not be updated.\n"
      + "Upstream settings are still stored under '" + oldName + "'.\n\n" + moveErr,
  };
}
async function gitDeleteBranch(cwd, name, force) { return await gitRunOrError(['branch', force ? '-D' : '-d', name], cwd, 10000, 'Delete branch failed'); }
async function gitSetUpstream(cwd, branch, upstream) { return await gitRunOrError(['branch', '--set-upstream-to=' + upstream, branch], cwd, 10000, 'Set upstream failed'); }
async function gitUnsetUpstream(cwd, branch) { return await gitRunOrError(['branch', '--unset-upstream', branch], cwd, 10000, 'Unset upstream failed'); }

async function gitGetRemoteUrl(cwd, remote) {
  try {
    return (await git(['remote', 'get-url', remote], cwd)).trim();
  } catch {
    return '';
  }
}

async function gitMergeFastForwardAsync(cwd, ref) { return await gitAsyncWrap(['merge', '--ff-only', ref], cwd); }
async function gitPushToRemoteAsync(cwd, remote, branch) { return await gitAsyncWrap(['push', '-u', remote, branch], cwd); }
// Push HEAD onto a differently named remote branch. Needed when a local branch
// was renamed: its upstream still points at the old name and plain `git push`
// refuses that under push.default=simple.
async function gitPushHeadToBranchAsync(cwd, remote, remoteBranch) { return await gitAsyncWrap(['push', remote, 'HEAD:refs/heads/' + remoteBranch], cwd); }
async function gitPullFromRemoteAsync(cwd, remote, branch) { return await gitAsyncWrap(['pull', remote, branch], cwd); }
// 체크아웃하지 않은 로컬 브랜치를 upstream까지 끌어올린다. `git pull`/`git merge`는 무엇을
// 인자로 주든 결과가 HEAD에 들어가므로 다른 브랜치를 갱신할 수 없다 — refspec fetch만이
// 작업 트리를 건드리지 않고 그 브랜치의 ref를 옮긴다.
// fast-forward가 아니면 git이 (non-fast-forward)로 거절하고, 다른 워크트리가 체크아웃 중이면
// refusing to fetch into branch로 거절한다. 둘 다 그대로 사용자에게 보여주면 된다.
async function gitFetchIntoBranchAsync(cwd, remote, remoteBranch, localBranch) {
  return await gitAsyncWrap(['fetch', remote, remoteBranch + ':' + localBranch], cwd);
}
async function gitPullRebaseAsync(cwd, remote, branch) { return await gitAsyncWrap(['pull', '--rebase', remote, branch], cwd); }
async function gitForcePushAsync(cwd, remote, branch) { return await gitAsyncWrap(['push', '--force-with-lease', remote, branch], cwd); }
async function gitPushDeleteBranchAsync(cwd, remote, branch) { return await gitAsyncWrap(['push', remote, '--delete', branch], cwd); }
async function gitPushTagsAsync(cwd, remote) { return await gitAsyncWrap(['push', remote, '--tags'], cwd); }
async function gitPushTagAsync(cwd, remote, tag) { return await gitAsyncWrap(['push', remote, 'refs/tags/' + tag], cwd); }
async function gitPushDeleteTagAsync(cwd, remote, tag) { return await gitAsyncWrap(['push', remote, '--delete', 'refs/tags/' + tag], cwd); }

async function gitRemoteRemove(cwd, name) { return await gitRunOrError(['remote', 'remove', name], cwd, 10000, 'Remote remove failed'); }
async function gitRemoteRename(cwd, oldName, newName) { return await gitRunOrError(['remote', 'rename', oldName, newName], cwd, 30000, 'Remote rename failed'); }
async function gitRemoteSetUrl(cwd, name, url) { return await gitRunOrError(['remote', 'set-url', name, url], cwd, 10000, 'Remote set-url failed'); }
async function gitRemotePruneAsync(cwd, name) { return await gitAsyncWrap(['remote', 'prune', name], cwd); }

// ── Worktree 관리 ──
async function gitWorktreeAdd(cwd, path, branch, createBranch) {
  const args = ['worktree', 'add'];
  if (createBranch) args.push('-b', branch, path);
  else args.push(path, branch);
  return await gitRunOrError(args, cwd, 30000, 'Worktree add failed');
}
async function gitWorktreeRemove(cwd, path, force) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  return await gitRunOrError(args, cwd, 30000, 'Worktree remove failed');
}
async function gitWorktreePruneAsync(cwd) { return await gitAsyncWrap(['worktree', 'prune'], cwd, 30000); }
async function gitBranchExists(cwd, name) {
  const r = await gitResult(['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], cwd, 5000);
  return !!(r && r.ok && r.exit_code === 0);
}

// 미추적 파일/디렉터리 일괄 삭제 (.gitignore 대상 제외)
async function gitCleanUntrackedAsync(cwd) { return await gitAsyncWrap(['clean', '-fd'], cwd, 30000); }

// Restore every tracked path to HEAD, then remove untracked files/directories.
// Ignored paths are intentionally preserved. An unborn repository has no HEAD,
// so clear its index first; the following clean then removes those former entries.
async function gitDiscardAllChangesAsync(cwd) {
  const head = await gitResult(['rev-parse', '--verify', 'HEAD'], cwd, 5000);
  const hasHead = !!(head && head.ok && head.exit_code === 0);
  const trackedErr = hasHead
    ? await gitAsyncWrap(['reset', '--hard', '--recurse-submodules', 'HEAD'], cwd, 30000)
    : await gitAsyncWrap(['read-tree', '--empty'], cwd, 30000);
  if (trackedErr) return 'Failed to discard tracked changes: ' + trackedErr;

  // A second force is required for untracked directories that are Git repos.
  // Before the first commit there is no committed ignore configuration to
  // restore, so ignored paths must also be removed to guarantee a clean tree.
  const cleanErr = await gitAsyncWrap(hasHead ? ['clean', '-ffd'] : ['clean', '-ffdx'], cwd, 30000);
  if (cleanErr) return 'Tracked changes were discarded, but untracked cleanup failed: ' + cleanErr;
  if (hasHead) {
    const submoduleCleanErr = await gitAsyncWrap(['submodule', 'foreach', '--recursive', 'git clean -ffd'], cwd, 30000);
    if (submoduleCleanErr) return 'Top-level changes were discarded, but submodule cleanup failed: ' + submoduleCleanErr;
  }
  return null;
}

// ── 저장소 생성 ──
async function gitInit(cwd) { return await gitRunOrError(['init'], cwd, 10000, 'Init failed'); }
async function gitCloneAsync(parentDir, url, dirName) {
  const args = ['clone', url];
  if (dirName) args.push(dirName);
  return await gitAsyncWrap(args, parentDir, 600000);
}

async function gitDeleteTag(cwd, name) { return await gitRunOrError(['tag', '-d', name], cwd, 10000, 'Delete tag failed'); }
async function gitCreateTagAnnotated(cwd, name, message, ref) {
  const args = ['tag', '-a', name, '-m', message];
  if (ref) args.push(ref);
  return await gitRunOrError(args, cwd, 10000, 'Create tag failed');
}

// 클립보드 등 텍스트 패치를 워크트리에 적용. format-patch(mbox) 형식이면 git am으로
// 커밋까지 복원하고, 일반 diff면 git apply로 워크트리에만 반영한다.
async function gitApplyPatchFromText(cwd, patchText) {
  const isMbox = /^From [0-9a-f]{40} /m.test(patchText);
  const gitDirAbs = await resolveGitDirAbs(cwd);
  if (!gitDirAbs) return 'Failed to resolve git directory';
  const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
  const patchPath = gitDirAbs + sep + 'hecaton-apply.patch';
  try {
    await hecaton.fs.write_file({ path: patchPath, content: patchText.endsWith('\n') ? patchText : patchText + '\n' });
  } catch (e) {
    return (e && e.message) || 'Failed to write patch file';
  }
  if (isMbox) {
    const err = await gitAsyncWrap(['am', '--whitespace=nowarn', patchPath], cwd, 30000);
    if (err) {
      await gitAsyncWrap(['am', '--abort'], cwd, 10000);
      return err;
    }
    return null;
  }
  return await gitRunOrError(['apply', '--whitespace=nowarn', patchPath], cwd, 10000, 'Apply patch failed');
}

async function gitStashSave(cwd) { return await gitRunOrError(['stash', 'push'], cwd, 10000, 'Stash failed'); }
async function gitStashPop(cwd) { return await gitRunOrError(['stash', 'pop'], cwd, 10000, 'Stash pop failed'); }
async function gitStashApply(cwd, ref) { return await gitRunOrError(['stash', 'apply', ref], cwd, 10000, 'Stash apply failed'); }
async function gitStashDrop(cwd, ref) { return await gitRunOrError(['stash', 'drop', ref], cwd, 10000, 'Stash drop failed'); }

async function gitStashRename(cwd, ref, newMessage) {
  try {
    const hash = (await git(['rev-parse', ref], cwd)).trim();
    const r1 = await gitResult(['stash', 'drop', ref], cwd, 10000);
    if (!r1 || !r1.ok) return 'Stash drop failed';
    const r2 = await gitResult(['stash', 'store', '-m', newMessage, hash], cwd, 10000);
    if (!r2 || !r2.ok) return 'Stash store failed';
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash rename failed';
  }
}

async function gitWriteRebaseMessage(cwd, message, opType) {
  try {
    const gitDir = (await git(['rev-parse', '--git-dir'], cwd)).trim();
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const isAbsolute = gitDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(gitDir);
    const base = isAbsolute ? gitDir : (cwd + sep + gitDir);
    const msgPath = opType === 'rebase-merge'
      ? base + sep + 'rebase-merge' + sep + 'message'
      : base + sep + 'rebase-apply' + sep + 'final-commit';
    await hecaton.fs.write_file({ path: msgPath, content: message + '\n' });
    return null;
  } catch (e) {
    return e.message || 'Failed to write rebase message';
  }
}

async function gitFormatPatch(cwd, ref) {
  try {
    return await git(['format-patch', '-1', ref, '--stdout'], cwd);
  } catch {
    return '';
  }
}

async function gitCommitInfo(cwd, ref) {
  try {
    return (await git(['log', '-1', '--format=%H%n%s%n%an <%ae>%n%ai', ref], cwd)).trim();
  } catch {
    return '';
  }
}

async function gitCommitMessage(cwd, ref) {
  try {
    return (await git(['log', '-1', '--format=%B', ref], cwd)).replace(/\r\n/g, '\n').trim();
  } catch {
    return '';
  }
}

async function gitRemoteAdd(cwd, name, url) { return await gitRunOrError(['remote', 'add', name, url], cwd, 10000, 'Remote add failed'); }

async function gitDiscardFile(cwd, item) {
  if (!item || !item.file) return 'No file selected';
  if (item.type === 'untracked') return await gitRunOrError(['clean', '-f', '--', item.file], cwd, 10000, 'Discard failed');
  if (item.type === 'staged') return await gitRunOrError(['restore', '--staged', '--worktree', '--source=HEAD', '--', item.file], cwd, 10000, 'Discard failed');
  return await gitRunOrError(['restore', '--', item.file], cwd, 10000, 'Discard failed');
}

// 버전관리에서 제외 (TortoiseGit의 Delete / Delete keep local)
// keepLocal=true  → git rm --cached : 추적 중단, 로컬 파일 유지 (이후 untracked가 됨)
// keepLocal=false → git rm          : 추적 중단 + 로컬 파일 삭제
async function gitRemoveFromRepo(cwd, file, keepLocal) {
  if (!file) return 'No file selected';
  const args = keepLocal
    ? ['rm', '--cached', '-r', '-f', '--', file]
    : ['rm', '-r', '-f', '--', file];
  return await gitRunOrError(args, cwd, 10000, keepLocal ? 'Remove from repository failed' : 'Delete failed');
}

async function gitStashFile(cwd, file) {
  if (!file) return 'No file selected';
  return await gitRunOrError(['stash', 'push', '-u', '--', file], cwd, 10000, 'Stash file failed');
}

async function gitStashFiles(cwd, files) {
  if (!files || files.length === 0) return 'No files selected';
  return await gitRunOrError(['stash', 'push', '-u', '--', ...files], cwd, 10000, 'Stash files failed');
}

async function gitIgnorePattern(cwd, pattern) {
  if (!pattern) return 'No ignore pattern';
  try {
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const ignorePath = cwd + sep + '.gitignore';
    const normalized = pattern.replace(/\\/g, '/');
    let lines = [];
    const readRes = await hecaton.fs.read_file({ path: ignorePath });
    if (readRes && readRes.content) {
      lines = readRes.content.replace(/\r\n/g, '\n').split('\n');
    }
    if (lines.some(line => line.trim() === normalized)) return null;
    const content = (lines.length > 0 ? lines.join('\n').replace(/\n*$/, '\n') : '') + normalized + '\n';
    const writeRes = await hecaton.fs.write_file({ path: ignorePath, content });
    if (!writeRes || !writeRes.ok) return 'Failed to write .gitignore';
    return null;
  } catch (e) {
    return e.message || 'Ignore update failed';
  }
}

async function gitFileHistory(cwd, file) {
  try {
    return (await git(['log', '--follow', '--decorate', '--oneline', '--', file], cwd)).trim();
  } catch {
    return '';
  }
}

async function gitBlameFile(cwd, file) {
  try {
    return (await git(['blame', '--', file], cwd)).trim();
  } catch {
    return '';
  }
}

async function gitGetConfig(cwd, key) { try { return (await git(['config', key], cwd)).trim(); } catch { return ''; } }
async function gitGetConfigLocal(cwd, key) { try { return (await git(['config', '--local', key], cwd)).trim(); } catch { return ''; } }
async function gitGetConfigGlobal(cwd, key) { try { return (await git(['config', '--global', key], cwd)).trim(); } catch { return ''; } }
async function gitSetConfig(cwd, key, value) { try { await git(['config', key, value], cwd); return null; } catch (e) { return e.stderr || e.message || 'Config set failed'; } }
async function gitUnsetConfigLocal(cwd, key) { try { await git(['config', '--local', '--unset', key], cwd); return null; } catch (e) { return e.stderr || e.message || 'Config unset failed'; } }

async function gitFreshLog(cwd, days) {
  try {
    const raw = await git(
      ['log', '--max-count=1000', '--since=' + days + '.days.ago', '--name-status', '--pretty=format:__COMMIT__%h|%an|%aI|%s'],
      cwd
    );
    const items = [];
    const seen = new Set();
    let currentCommit = null;

    for (const line of raw.split('\n')) {
      if (line.startsWith('__COMMIT__')) {
        const parts = line.substring(10).split('|');
        currentCommit = {
          hash: parts[0] || '',
          author: parts[1] || '',
          date: parts[2] || '',
          msg: parts.slice(3).join('|'),
        };
        continue;
      }
      if (!currentCommit || !line.trim()) continue;
      const tabs = line.split('\t');
      if (tabs.length < 2) continue;
      const status = tabs[0].charAt(0);
      let file;
      if (status === 'R' && tabs.length >= 3) {
        file = tabs[2];
      } else {
        file = tabs[1];
      }
      if (seen.has(file)) continue;
      seen.add(file);
      items.push({
        file,
        status,
        author: currentCommit.author,
        date: currentCommit.date,
        commitHash: currentCommit.hash,
        commitMsg: currentCommit.msg,
        isPending: false,
        isDeleted: status === 'D',
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function gitShowCommitFile(cwd, commitHash, file) {
  try {
    return await git(['show', commitHash, '--', file], cwd);
  } catch {
    return '';
  }
}

async function gitFilePatch(cwd, item) {
  if (!item || !item.file) return '';
  try {
    if (item.type === 'staged') {
      return await git(['diff', '--cached', '--', item.file], cwd);
    }
    if (item.type === 'untracked') {
      return await gitDiffUntracked(cwd, item.file);
    }
    return await git(['diff', '--', item.file], cwd);
  } catch {
    return '';
  }
}

function repoFilePath(cwd, file) {
  const sep = cwd.includes('\\') ? '\\' : '/';
  return cwd.replace(/[\\\/]+$/, '') + sep + file.split('/').join(sep);
}

function normalizeLineEndings(text) {
  return (text || '').replace(/\r\n/g, '\n');
}

function splitTextLines(text) {
  const normalized = normalizeLineEndings(text);
  const hasTrailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hasTrailingNewline) lines.pop();
  return { lines, hasTrailingNewline };
}

function parseConflictMarkerContent(text) {
  const { lines, hasTrailingNewline } = splitTextLines(text);
  const chunks = [];
  let context = [];
  let i = 0;

  function flushContext() {
    if (context.length > 0) {
      chunks.push({ type: 'context', lines: context });
      context = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('<<<<<<< ')) {
      context.push(line);
      i++;
      continue;
    }

    flushContext();
    i++;
    const ours = [];
    while (i < lines.length && lines[i] !== '=======') {
      ours.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      context.push('<<<<<<<');
      context.push(...ours);
      break;
    }

    i++;
    const theirs = [];
    while (i < lines.length && !lines[i].startsWith('>>>>>>> ')) {
      theirs.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++;

    chunks.push({ type: 'conflict', ours, theirs });
  }

  flushContext();
  return { chunks, hasTrailingNewline };
}

async function gitReadConflictFile(cwd, file) {
  if (!cwd || !file) return null;
  const stageRaw = await gitExec(['ls-files', '-u', '--', file], cwd, 10000);
  const stageEntries = [];
  for (const line of normalizeLineEndings(stageRaw).split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+)\s+([0-9a-f]{40})\s+(\d)\t(.+)$/);
    if (m) stageEntries.push({ mode: m[1], hash: m[2], stage: parseInt(m[3], 10), file: m[4] });
  }

  let worktree = '';
  try {
    const res = await hecaton.fs.read_file({ path: repoFilePath(cwd, file) });
    worktree = typeof res === 'string' ? res : (res && res.content) ? res.content : '';
  } catch {
    worktree = '';
  }

  const [base, ours, theirs] = await Promise.all([
    gitExec(['show', `:1:${file}`], cwd, 10000),
    gitExec(['show', `:2:${file}`], cwd, 10000),
    gitExec(['show', `:3:${file}`], cwd, 10000),
  ]);

  const parsed = parseConflictMarkerContent(worktree);
  const oursStage = stageEntries.find(entry => entry.stage === 2);
  const theirsStage = stageEntries.find(entry => entry.stage === 3);
  const baseStage = stageEntries.find(entry => entry.stage === 1);

  return {
    file,
    base: normalizeLineEndings(base),
    ours: normalizeLineEndings(ours),
    theirs: normalizeLineEndings(theirs),
    worktree: normalizeLineEndings(worktree),
    chunks: parsed.chunks,
    hasTrailingNewline: parsed.hasTrailingNewline,
    stages: {
      base: baseStage || null,
      ours: oursStage || null,
      theirs: theirsStage || null,
    },
  };
}

async function gitWriteConflictResolution(cwd, file, content) {
  try {
    await hecaton.fs.write_file({ path: repoFilePath(cwd, file), content });
    return null;
  } catch (e) {
    return e && e.message ? e.message : 'Failed to write conflict resolution';
  }
}

module.exports = {
  git,
  gitExec,
  gitExecChecked,
  unquoteGitPath,
  resolveWorkTreeRoot,
  gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked,
  gitStage, gitUnstage, gitStageAll, gitUnstageAll, gitCommit,
  gitStashRefs, gitShowRef, gitStashDiff, gitLogCommits,
  gitRebaseState, gitOperationState, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitCheckoutOurs, gitCheckoutTheirs,
  gitMergeContinue, gitMergeAbort, gitCherryPickContinue, gitCherryPickAbort, gitCherryPickSkip,
  gitRevertContinue, gitRevertAbort, gitRevertSkip, gitWriteRebaseMessage,
  gitBranches, parseUpstreamTrack, gitRemoteBranches, gitRemotes, gitWorktrees, gitReflogRecoveries, gitRemoteAdd,
  gitRenameBranch, gitDeleteBranch, gitSetUpstream, gitUnsetUpstream, gitGetRemoteUrl,
  gitCherryPick, gitCherryPickNoCommit, gitRevert, gitCheckoutRef, gitCreateBranch, gitCreateTag,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo, gitCommitMessage,
  gitAheadBehind, gitFetch, gitPull, gitPush, gitStashSave, gitStashPop,
  gitStashApply, gitStashDrop, gitStashRename,
  gitDiscardFile, gitRemoveFromRepo, gitStashFile, gitStashFiles, gitIgnorePattern,
  gitFileHistory, gitBlameFile, gitFilePatch,
  gitReadConflictFile, gitWriteConflictResolution,
  gitFreshLog, gitShowCommitFile,
  gitStatusSplit, gitStatusPorcelain, parseDiffOutput, parseLsFilesOutput,
  gitGetConfig, gitGetConfigLocal, gitGetConfigGlobal, gitSetConfig, gitUnsetConfigLocal,
  gitFetchAsync, gitPullAsync, gitPushAsync,
  gitCheckRebaseConflicts,
  gitRebaseAsync, gitRebaseContinueAsync, gitRebaseAbortAsync, gitRebaseSkipAsync,
  gitIsRebaseNoop,
  gitMergeAsync, gitResetAsync, gitCheckoutRefAsync, gitCherryPickAsync, gitCherryPickNoCommitAsync, gitRevertAsync,
  gitCommitAsync, gitStashSaveAsync, gitStashPopAsync,
  gitCommitAmendAsync, gitCommitAmendMessageOnlyAsync, gitResetModeAsync,
  parseDiffHunks, buildHunkPatchText, gitApplyPatchText,
  gitRewordCommitAsync, gitSquashIntoParentAsync, gitDropCommitAsync, gitEditCommitAsync,
  gitStageAsync, gitUnstageAsync,
  gitStageMultiple, gitUnstageMultiple,
  gitMergeFastForwardAsync, gitPushToRemoteAsync, gitPushHeadToBranchAsync, gitPullFromRemoteAsync, gitFetchIntoBranchAsync,
  gitPullRebaseAsync, gitForcePushAsync, gitPushDeleteBranchAsync,
  splitUpstreamRef,
  gitPushTagsAsync, gitPushTagAsync, gitPushDeleteTagAsync,
  gitRemoteRemove, gitRemoteRename, gitRemoteSetUrl, gitRemotePruneAsync,
  gitDeleteTag, gitCreateTagAnnotated, gitApplyPatchFromText,
  gitWorktreeAdd, gitWorktreeRemove, gitWorktreePruneAsync, gitBranchExists,
  gitInit, gitCloneAsync, gitCleanUntrackedAsync, gitDiscardAllChangesAsync,
};
