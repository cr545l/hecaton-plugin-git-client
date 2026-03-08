// Git operations via hecaton host API (exec_process, fs_*)
// No direct child_process or fs usage — all operations go through host permission system.

function gitExec(args, cwd, timeout) {
  return new Promise((resolve) => {
    const result = hecaton.exec_process({ program: 'git', args, cwd, timeout: timeout || 5000 });
    if (result && result.ok) {
      resolve((result.stdout || '').replace(/\r\n/g, '\n'));
    } else {
      resolve('');
    }
  });
}

function git(args, cwd, timeout) {
  const result = hecaton.exec_process({ program: 'git', args, cwd, timeout: timeout || 5000 });
  if (!result || !result.ok) {
    const err = new Error(result ? result.error || 'git failed' : 'exec_process failed');
    err.stderr = result ? (result.stderr || '') : '';
    err.stdout = result ? (result.stdout || '') : '';
    if (result && result.stdout) return result.stdout.replace(/\r\n/g, '\n');
    throw err;
  }
  return (result.stdout || '').replace(/\r\n/g, '\n');
}

function gitResult(args, cwd, timeout) {
  return hecaton.exec_process({ program: 'git', args, cwd, timeout: timeout || 5000 });
}

function unquoteGitPath(p) {
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') {
    return p.slice(1, -1).replace(/\\([ntab\\""])|\\([0-7]{1,3})/g, (_, esc, oct) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8));
      switch (esc) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'a': return '\x07';
        case 'b': return '\b';
        case '\\': return '\\';
        case '"': return '"';
        default: return esc;
      }
    });
  }
  return p;
}

function gitIsRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitBranch(cwd) {
  try {
    return git(['branch', '--show-current'], cwd).trim() || 'HEAD (detached)';
  } catch {
    return '???';
  }
}

function gitStatus(cwd) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const ignored = [];
  try {
    const output = git(['status', '--porcelain=v1', '-uall', '--ignored'], cwd);
    for (const line of output.split('\n')) {
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      const file = unquoteGitPath(line.substring(3));
      if (x === '!' && y === '!') {
        ignored.push({ file });
      } else if (x === '?') {
        untracked.push({ file });
      } else {
        if (x !== ' ' && x !== '?') {
          staged.push({ status: x, file });
        }
        if (y !== ' ' && y !== '?') {
          unstaged.push({ status: y, file });
        }
      }
    }
  } catch { /* empty */ }
  return { staged, unstaged, untracked, ignored };
}

function gitDiff(cwd, file, isStaged) {
  try {
    const args = ['diff'];
    if (isStaged) args.push('--cached');
    args.push('--', file);
    return git(args, cwd);
  } catch {
    return '';
  }
}

function gitDiffUntracked(cwd, file) {
  try {
    return git(['diff', '--no-index', '--', '/dev/null', file], cwd);
  } catch {
    return '';
  }
}

function gitStage(cwd, file) {
  try {
    git(['add', '-f', '--', file], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitUnstage(cwd, file) {
  try {
    git(['restore', '--staged', '--', file], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitStageAll(cwd) {
  try {
    git(['add', '-f', '-A'], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitUnstageAll(cwd) {
  try {
    git(['reset', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

function gitCommit(cwd, message) {
  try {
    git(['commit', '-m', message], cwd);
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Commit failed';
  }
}

function gitStashRefs(cwd) {
  try {
    const raw = git(['stash', 'list', '--format=%H\t%h\t%gd'], cwd).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      return { hash: parts[0], shortHash: parts[1], ref: parts[2] };
    });
  } catch {
    return [];
  }
}

function gitShowRef(cwd, ref) {
  try {
    return git(['show', ref], cwd);
  } catch {
    return '';
  }
}

function gitStashDiff(cwd, ref) {
  try {
    return git(['stash', 'show', '-p', ref], cwd);
  } catch {
    return '';
  }
}

function gitRebaseState(cwd) {
  try {
    const gitDir = git(['rev-parse', '--git-dir'], cwd).trim();
    // Use path separators that work cross-platform
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const base = cwd + sep + gitDir;
    // Check rebase-merge via fs_stat
    const rebaseMerge = base + sep + 'rebase-merge';
    const rmStat = hecaton.fs_stat({ path: rebaseMerge });
    if (rmStat && rmStat.exists && rmStat.isDir) {
      const stepRes = hecaton.fs_read_file({ path: rebaseMerge + sep + 'msgnum' });
      const totalRes = hecaton.fs_read_file({ path: rebaseMerge + sep + 'end' });
      const step = stepRes && stepRes.content ? stepRes.content.trim() : '0';
      const total = totalRes && totalRes.content ? totalRes.content.trim() : '0';
      return { type: 'rebase-merge', step: parseInt(step), total: parseInt(total) };
    }
    // Check rebase-apply
    const rebaseApply = base + sep + 'rebase-apply';
    const raStat = hecaton.fs_stat({ path: rebaseApply });
    if (raStat && raStat.exists && raStat.isDir) {
      const stepRes = hecaton.fs_read_file({ path: rebaseApply + sep + 'next' });
      const totalRes = hecaton.fs_read_file({ path: rebaseApply + sep + 'last' });
      const step = stepRes && stepRes.content ? stepRes.content.trim() : '0';
      const total = totalRes && totalRes.content ? totalRes.content.trim() : '0';
      return { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
    }
  } catch { /* not in rebase */ }
  return null;
}

function gitRunOrError(args, cwd, timeout, errorMsg) {
  const r = gitResult(args, cwd, timeout || 30000);
  if (r && r.ok && r.exitCode === 0) return null;
  return (r && r.stderr ? r.stderr.replace(/\r\n/g, '\n').trim() : '') || errorMsg;
}

function gitRebase(cwd, ref) { return gitRunOrError(['rebase', ref], cwd, 30000, 'Rebase failed'); }
function gitRebaseContinue(cwd) { return gitRunOrError(['rebase', '--continue'], cwd, 30000, 'Rebase continue failed'); }
function gitRebaseAbort(cwd) { return gitRunOrError(['rebase', '--abort'], cwd, 30000, 'Rebase abort failed'); }
function gitRebaseSkip(cwd) { return gitRunOrError(['rebase', '--skip'], cwd, 30000, 'Rebase skip failed'); }

function gitLogCommits(cwd, extraRefs, maxCount) {
  try {
    const args = ['log', '--all', '--topo-order', '--format=%x01%H%x00%P%x00%D%x00%an%x00%aI%x00%cn%x00%cI%x00%B'];
    if (extraRefs && extraRefs.length > 0) args.push(...extraRefs);
    if (maxCount) args.push('-' + maxCount);
    const raw = git(args, cwd, 30000).replace(/\r/g, '').trim();
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

function gitBranches(cwd) {
  try {
    const raw = git(['branch', '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)'], cwd).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      return { name: parts[0], isCurrent: parts[1] === '*', upstream: parts[2] || '' };
    });
  } catch {
    return [];
  }
}

function gitRemotes(cwd) {
  try {
    const raw = git(['remote'], cwd).trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function gitRemoteBranches(cwd) {
  try {
    const raw = git(['branch', '-r', '--format=%(refname:short)'], cwd).trim();
    if (!raw) return [];
    return raw.split('\n').filter(b => !b.includes('/HEAD'));
  } catch {
    return [];
  }
}

function gitCherryPick(cwd, ref) { return gitRunOrError(['cherry-pick', ref], cwd, 30000, 'Cherry-pick failed'); }
function gitRevert(cwd, ref) { return gitRunOrError(['revert', '--no-edit', ref], cwd, 30000, 'Revert failed'); }
function gitCheckoutRef(cwd, ref) { return gitRunOrError(['checkout', ref], cwd, 10000, 'Checkout failed'); }

function gitCreateBranch(cwd, name, startPoint) {
  const args = ['checkout', '-b', name];
  if (startPoint) args.push(startPoint);
  return gitRunOrError(args, cwd, 10000, 'Create branch failed');
}

function gitCreateTag(cwd, name, ref) {
  try {
    const args = ['tag', name];
    if (ref) args.push(ref);
    git(args, cwd);
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Create tag failed';
  }
}

function gitReset(cwd, ref) { return gitRunOrError(['reset', '--hard', ref], cwd, 30000, 'Reset failed'); }
function gitMerge(cwd, ref) { return gitRunOrError(['merge', ref], cwd, 30000, 'Merge failed'); }

function gitAheadBehind(cwd) {
  try {
    const output = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
    const parts = output.trim().split(/\s+/);
    return { behind: parseInt(parts[0]) || 0, ahead: parseInt(parts[1]) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function gitFetch(cwd) { return gitRunOrError(['fetch', '--all', '--prune'], cwd, 30000, 'Fetch failed'); }
function gitPull(cwd) { return gitRunOrError(['pull'], cwd, 30000, 'Pull failed'); }
function gitPush(cwd) { return gitRunOrError(['push'], cwd, 30000, 'Push failed'); }

// Async helpers — in Deno runner, exec_process is synchronous RPC,
// but we wrap in Promise to keep the same API for spinner-compatible callers.
function gitAsyncWrap(args, cwd, timeout) {
  return new Promise((resolve) => {
    const r = gitResult(args, cwd, timeout || 30000);
    if (r && r.ok && r.exitCode === 0) resolve(null);
    else resolve((r && r.stderr ? r.stderr.replace(/\r\n/g, '\n').trim() : '') || 'Operation failed');
  });
}

function gitFetchAsync(cwd) { return gitAsyncWrap(['fetch', '--all', '--prune'], cwd); }
function gitPullAsync(cwd) { return gitAsyncWrap(['pull'], cwd); }
function gitPushAsync(cwd) { return gitAsyncWrap(['push'], cwd); }
function gitRebaseAsync(cwd, ref) { return gitAsyncWrap(['rebase', ref], cwd); }
function gitRebaseContinueAsync(cwd) { return gitAsyncWrap(['rebase', '--continue'], cwd); }
function gitRebaseAbortAsync(cwd) { return gitAsyncWrap(['rebase', '--abort'], cwd); }
function gitRebaseSkipAsync(cwd) { return gitAsyncWrap(['rebase', '--skip'], cwd); }
function gitMergeAsync(cwd, ref) { return gitAsyncWrap(['merge', ref], cwd); }
function gitResetAsync(cwd, ref) { return gitAsyncWrap(['reset', '--hard', ref], cwd); }
function gitCheckoutRefAsync(cwd, ref) { return gitAsyncWrap(['checkout', ref], cwd, 10000); }
function gitCherryPickAsync(cwd, ref) { return gitAsyncWrap(['cherry-pick', ref], cwd); }
function gitRevertAsync(cwd, ref) { return gitAsyncWrap(['revert', '--no-edit', ref], cwd); }
function gitStashSaveAsync(cwd) { return gitAsyncWrap(['stash', 'push'], cwd, 10000); }
function gitCommitAsync(cwd, message) { return gitAsyncWrap(['commit', '-m', message], cwd, 30000); }
function gitStashPopAsync(cwd) { return gitAsyncWrap(['stash', 'pop'], cwd, 10000); }
function gitStageAsync(cwd, file) {
  return new Promise((resolve) => {
    const r = gitResult(['add', '-f', '--', file], cwd, 5000);
    resolve(r && r.ok && r.exitCode === 0);
  });
}
function gitUnstageAsync(cwd, file) {
  return new Promise((resolve) => {
    const r = gitResult(['restore', '--staged', '--', file], cwd, 5000);
    resolve(r && r.ok && r.exitCode === 0);
  });
}

function gitRenameBranch(cwd, oldName, newName) { return gitRunOrError(['branch', '-m', oldName, newName], cwd, 10000, 'Rename branch failed'); }
function gitDeleteBranch(cwd, name, force) { return gitRunOrError(['branch', force ? '-D' : '-d', name], cwd, 10000, 'Delete branch failed'); }
function gitSetUpstream(cwd, branch, upstream) { return gitRunOrError(['branch', '--set-upstream-to=' + upstream, branch], cwd, 10000, 'Set upstream failed'); }
function gitUnsetUpstream(cwd, branch) { return gitRunOrError(['branch', '--unset-upstream', branch], cwd, 10000, 'Unset upstream failed'); }

function gitGetRemoteUrl(cwd, remote) {
  try {
    return git(['remote', 'get-url', remote], cwd).trim();
  } catch {
    return '';
  }
}

function gitMergeFastForwardAsync(cwd, ref) { return gitAsyncWrap(['merge', '--ff-only', ref], cwd); }
function gitPushToRemoteAsync(cwd, remote, branch) { return gitAsyncWrap(['push', '-u', remote, branch], cwd); }
function gitPullFromRemoteAsync(cwd, remote, branch) { return gitAsyncWrap(['pull', remote, branch], cwd); }

function gitStashSave(cwd) { return gitRunOrError(['stash', 'push'], cwd, 10000, 'Stash failed'); }
function gitStashPop(cwd) { return gitRunOrError(['stash', 'pop'], cwd, 10000, 'Stash pop failed'); }
function gitStashApply(cwd, ref) { return gitRunOrError(['stash', 'apply', ref], cwd, 10000, 'Stash apply failed'); }
function gitStashDrop(cwd, ref) { return gitRunOrError(['stash', 'drop', ref], cwd, 10000, 'Stash drop failed'); }

function gitStashRename(cwd, ref, newMessage) {
  try {
    const hash = git(['rev-parse', ref], cwd).trim();
    const r1 = gitResult(['stash', 'drop', ref], cwd, 10000);
    if (!r1 || !r1.ok) return 'Stash drop failed';
    const r2 = gitResult(['stash', 'store', '-m', newMessage, hash], cwd, 10000);
    if (!r2 || !r2.ok) return 'Stash store failed';
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash rename failed';
  }
}

function gitFormatPatch(cwd, ref) {
  try {
    return git(['format-patch', '-1', ref, '--stdout'], cwd);
  } catch {
    return '';
  }
}

function gitCommitInfo(cwd, ref) {
  try {
    return git(['log', '-1', '--format=%H%n%s%n%an <%ae>%n%ai', ref], cwd).trim();
  } catch {
    return '';
  }
}

function gitRemoteAdd(cwd, name, url) { return gitRunOrError(['remote', 'add', name, url], cwd, 10000, 'Remote add failed'); }

function gitDiscardFile(cwd, item) {
  if (!item || !item.file) return 'No file selected';
  if (item.type === 'untracked') return gitRunOrError(['clean', '-f', '--', item.file], cwd, 10000, 'Discard failed');
  if (item.type === 'staged') return gitRunOrError(['restore', '--staged', '--worktree', '--source=HEAD', '--', item.file], cwd, 10000, 'Discard failed');
  return gitRunOrError(['restore', '--', item.file], cwd, 10000, 'Discard failed');
}

function gitStashFile(cwd, file) {
  if (!file) return 'No file selected';
  return gitRunOrError(['stash', 'push', '-u', '--', file], cwd, 10000, 'Stash file failed');
}

function gitIgnorePattern(cwd, pattern) {
  if (!pattern) return 'No ignore pattern';
  try {
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const ignorePath = cwd + sep + '.gitignore';
    const normalized = pattern.replace(/\\/g, '/');
    let lines = [];
    const readRes = hecaton.fs_read_file({ path: ignorePath });
    if (readRes && readRes.content) {
      lines = readRes.content.replace(/\r\n/g, '\n').split('\n');
    }
    if (lines.some(line => line.trim() === normalized)) return null;
    const content = (lines.length > 0 ? lines.join('\n').replace(/\n*$/, '\n') : '') + normalized + '\n';
    const writeRes = hecaton.fs_write_file({ path: ignorePath, content });
    if (!writeRes || !writeRes.ok) return 'Failed to write .gitignore';
    return null;
  } catch (e) {
    return e.message || 'Ignore update failed';
  }
}

function gitFileHistory(cwd, file) {
  try {
    return git(['log', '--follow', '--decorate', '--oneline', '--', file], cwd).trim();
  } catch {
    return '';
  }
}

function gitBlameFile(cwd, file) {
  try {
    return git(['blame', '--', file], cwd).trim();
  } catch {
    return '';
  }
}

function gitGetConfig(cwd, key) { try { return git(['config', key], cwd).trim(); } catch { return ''; } }
function gitGetConfigLocal(cwd, key) { try { return git(['config', '--local', key], cwd).trim(); } catch { return ''; } }
function gitGetConfigGlobal(cwd, key) { try { return git(['config', '--global', key], cwd).trim(); } catch { return ''; } }
function gitSetConfig(cwd, key, value) { try { git(['config', key, value], cwd); return null; } catch (e) { return e.stderr || e.message || 'Config set failed'; } }
function gitUnsetConfigLocal(cwd, key) { try { git(['config', '--local', '--unset', key], cwd); return null; } catch (e) { return e.stderr || e.message || 'Config unset failed'; } }

function gitFreshLog(cwd, days) {
  try {
    const raw = git(
      ['log', '--since=' + days + '.days.ago', '--name-status', '--pretty=format:__COMMIT__%h|%an|%aI|%s'],
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

function gitShowCommitFile(cwd, commitHash, file) {
  try {
    return git(['show', commitHash, '--', file], cwd);
  } catch {
    return '';
  }
}

function gitFilePatch(cwd, item) {
  if (!item || !item.file) return '';
  try {
    if (item.type === 'staged') {
      return git(['diff', '--cached', '--', item.file], cwd);
    }
    if (item.type === 'untracked') {
      return gitDiffUntracked(cwd, item.file);
    }
    return git(['diff', '--', item.file], cwd);
  } catch {
    return '';
  }
}

module.exports = {
  git,
  gitExec,
  unquoteGitPath,
  gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked,
  gitStage, gitUnstage, gitStageAll, gitUnstageAll, gitCommit,
  gitStashRefs, gitShowRef, gitStashDiff, gitLogCommits,
  gitRebaseState, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitBranches, gitRemoteBranches, gitRemotes, gitRemoteAdd,
  gitRenameBranch, gitDeleteBranch, gitSetUpstream, gitUnsetUpstream, gitGetRemoteUrl,
  gitCherryPick, gitRevert, gitCheckoutRef, gitCreateBranch, gitCreateTag,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitAheadBehind, gitFetch, gitPull, gitPush, gitStashSave, gitStashPop,
  gitStashApply, gitStashDrop, gitStashRename,
  gitDiscardFile, gitStashFile, gitIgnorePattern,
  gitFileHistory, gitBlameFile, gitFilePatch,
  gitFreshLog, gitShowCommitFile,
  gitGetConfig, gitGetConfigLocal, gitGetConfigGlobal, gitSetConfig, gitUnsetConfigLocal,
  gitFetchAsync, gitPullAsync, gitPushAsync,
  gitRebaseAsync, gitRebaseContinueAsync, gitRebaseAbortAsync, gitRebaseSkipAsync,
  gitMergeAsync, gitResetAsync, gitCheckoutRefAsync, gitCherryPickAsync, gitRevertAsync,
  gitCommitAsync, gitStashSaveAsync, gitStashPopAsync,
  gitStageAsync, gitUnstageAsync,
  gitMergeFastForwardAsync, gitPushToRemoteAsync, gitPullFromRemoteAsync,
};
