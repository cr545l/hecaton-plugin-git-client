// Git operations via hecaton host API (exec_process, fs_*)
// No direct child_process or fs usage — all operations go through host permission system.

async function gitExec(args, cwd, timeout) {
  const result = await hecaton.exec_process({ program: 'git', args, cwd, timeout: timeout || 5000 });
  if (result && result.ok) {
    return (result.stdout || '').replace(/\r\n/g, '\n');
  } else {
    return '';
  }
}

async function git(args, cwd, timeout) {
  const result = await hecaton.exec_process({ program: 'git', args, cwd, timeout: timeout || 5000 });
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
  return await hecaton.exec_process({ program: 'git', args, cwd, timeout: timeout || 5000 });
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

async function gitIsRepo(cwd) {
  const result = await hecaton.exec_process({ program: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, timeout: 5000 });
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
    if (result.exitCode !== undefined) detail.exitCode = result.exitCode;
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

async function gitStatus(cwd) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const ignored = [];
  try {
    const output = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal', '--ignored'], cwd, 15000);
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
  try {
    await git(['add', '-f', '--', file], cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitUnstage(cwd, file) {
  try {
    await git(['restore', '--staged', '--', file], cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitStageAll(cwd) {
  try {
    await git(['add', '-f', '-A'], cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitUnstageAll(cwd) {
  try {
    await git(['reset', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitCommit(cwd, message) {
  try {
    await git(['commit', '-m', message], cwd);
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Commit failed';
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
    const rmStat = await hecaton.fs_stat({ path: rebaseMerge });
    if (rmStat && rmStat.exists && rmStat.isDir) {
      const stepRes = await hecaton.fs_read_file({ path: rebaseMerge + sep + 'msgnum' });
      const totalRes = await hecaton.fs_read_file({ path: rebaseMerge + sep + 'end' });
      const step = stepRes && stepRes.content ? stepRes.content.trim() : '0';
      const total = totalRes && totalRes.content ? totalRes.content.trim() : '0';
      return { type: 'rebase-merge', step: parseInt(step), total: parseInt(total) };
    }
    // Check rebase-apply
    const rebaseApply = base + sep + 'rebase-apply';
    const raStat = await hecaton.fs_stat({ path: rebaseApply });
    if (raStat && raStat.exists && raStat.isDir) {
      const stepRes = await hecaton.fs_read_file({ path: rebaseApply + sep + 'next' });
      const totalRes = await hecaton.fs_read_file({ path: rebaseApply + sep + 'last' });
      const step = stepRes && stepRes.content ? stepRes.content.trim() : '0';
      const total = totalRes && totalRes.content ? totalRes.content.trim() : '0';
      return { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
    }
    // Check merge
    const mergeHead = base + sep + 'MERGE_HEAD';
    const mhStat = await hecaton.fs_stat({ path: mergeHead });
    if (mhStat && mhStat.exists) return { type: 'merge' };
    // Check cherry-pick
    const cherryHead = base + sep + 'CHERRY_PICK_HEAD';
    const chStat = await hecaton.fs_stat({ path: cherryHead });
    if (chStat && chStat.exists) return { type: 'cherry-pick' };
    // Check revert
    const revertHead = base + sep + 'REVERT_HEAD';
    const rvStat = await hecaton.fs_stat({ path: revertHead });
    if (rvStat && rvStat.exists) return { type: 'revert' };
  } catch { /* not in operation */ }
  return null;
}
const gitRebaseState = gitOperationState; // backward compat

async function gitRunOrError(args, cwd, timeout, errorMsg) {
  const r = await gitResult(args, cwd, timeout || 30000);
  if (r && r.ok && r.exitCode === 0) return null;
  return (r && r.stderr ? r.stderr.replace(/\r\n/g, '\n').trim() : '') || errorMsg;
}

async function gitRebase(cwd, ref) { return await gitRunOrError(['rebase', ref], cwd, 30000, 'Rebase failed'); }
async function gitRebaseContinue(cwd) { return await gitRunOrError(['rebase', '--continue'], cwd, 30000, 'Rebase continue failed'); }
async function gitRebaseAbort(cwd) { return await gitRunOrError(['rebase', '--abort'], cwd, 30000, 'Rebase abort failed'); }
async function gitRebaseSkip(cwd) { return await gitRunOrError(['rebase', '--skip'], cwd, 30000, 'Rebase skip failed'); }
async function gitMergeContinue(cwd) { return await gitRunOrError(['commit', '--no-edit'], cwd, 30000, 'Merge commit failed'); }
async function gitMergeAbort(cwd) { return await gitRunOrError(['merge', '--abort'], cwd, 30000, 'Merge abort failed'); }
async function gitCherryPickContinue(cwd) { return await gitRunOrError(['cherry-pick', '--continue'], cwd, 30000, 'Cherry-pick continue failed'); }
async function gitCherryPickAbort(cwd) { return await gitRunOrError(['cherry-pick', '--abort'], cwd, 30000, 'Cherry-pick abort failed'); }
async function gitCherryPickSkip(cwd) { return await gitRunOrError(['cherry-pick', '--skip'], cwd, 30000, 'Cherry-pick skip failed'); }
async function gitRevertContinue(cwd) { return await gitRunOrError(['revert', '--continue'], cwd, 30000, 'Revert continue failed'); }
async function gitRevertAbort(cwd) { return await gitRunOrError(['revert', '--abort'], cwd, 30000, 'Revert abort failed'); }
async function gitRevertSkip(cwd) { return await gitRunOrError(['revert', '--skip'], cwd, 30000, 'Revert skip failed'); }

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

async function gitBranches(cwd) {
  try {
    const raw = (await git(['branch', '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)'], cwd)).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      return { name: parts[0], isCurrent: parts[1] === '*', upstream: parts[2] || '' };
    });
  } catch {
    return [];
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
  if (r && r.ok && r.exitCode === 0) return null;
  return (r && r.stderr ? r.stderr.replace(/\r\n/g, '\n').trim() : '') || 'Operation failed';
}

async function gitFetchAsync(cwd) { return await gitAsyncWrap(['fetch', '--all', '--prune'], cwd); }
async function gitPullAsync(cwd) { return await gitAsyncWrap(['pull'], cwd); }
async function gitPushAsync(cwd) { return await gitAsyncWrap(['push'], cwd); }
async function gitRebaseAsync(cwd, ref) { return await gitAsyncWrap(['rebase', ref], cwd); }
async function gitRebaseContinueAsync(cwd) { return await gitAsyncWrap(['rebase', '--continue'], cwd); }
async function gitRebaseAbortAsync(cwd) { return await gitAsyncWrap(['rebase', '--abort'], cwd); }
async function gitRebaseSkipAsync(cwd) { return await gitAsyncWrap(['rebase', '--skip'], cwd); }
async function gitMergeAsync(cwd, ref) { return await gitAsyncWrap(['merge', ref], cwd); }
async function gitResetAsync(cwd, ref) { return await gitAsyncWrap(['reset', '--hard', ref], cwd); }
async function gitCheckoutRefAsync(cwd, ref) { return await gitAsyncWrap(['checkout', ref], cwd, 10000); }
async function gitCherryPickAsync(cwd, ref) { return await gitAsyncWrap(['cherry-pick', ref], cwd); }
async function gitRevertAsync(cwd, ref) { return await gitAsyncWrap(['revert', '--no-edit', ref], cwd); }
async function gitStashSaveAsync(cwd) { return await gitAsyncWrap(['stash', 'push'], cwd, 10000); }
async function gitCommitAsync(cwd, message) { return await gitAsyncWrap(['commit', '-m', message], cwd, 30000); }
async function gitStashPopAsync(cwd) { return await gitAsyncWrap(['stash', 'pop'], cwd, 10000); }
async function gitStageAsync(cwd, file) {
  const r = await gitResult(['add', '-f', '--', file], cwd, 5000);
  return r && r.ok && r.exitCode === 0;
}
async function gitUnstageAsync(cwd, file) {
  const r = await gitResult(['restore', '--staged', '--', file], cwd, 5000);
  return r && r.ok && r.exitCode === 0;
}
async function gitStageMultiple(cwd, files) {
  if (files.length === 0) return true;
  if (files.length === 1) return gitStage(cwd, files[0]);
  try { await git(['add', '-f', '--', ...files], cwd); return true; } catch { return false; }
}
async function gitUnstageMultiple(cwd, files) {
  if (files.length === 0) return true;
  if (files.length === 1) return gitUnstage(cwd, files[0]);
  try { await git(['restore', '--staged', '--', ...files], cwd); return true; } catch { return false; }
}

async function gitRenameBranch(cwd, oldName, newName) { return await gitRunOrError(['branch', '-m', oldName, newName], cwd, 10000, 'Rename branch failed'); }
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
async function gitPullFromRemoteAsync(cwd, remote, branch) { return await gitAsyncWrap(['pull', remote, branch], cwd); }

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

async function gitRemoteAdd(cwd, name, url) { return await gitRunOrError(['remote', 'add', name, url], cwd, 10000, 'Remote add failed'); }

async function gitDiscardFile(cwd, item) {
  if (!item || !item.file) return 'No file selected';
  if (item.type === 'untracked') return await gitRunOrError(['clean', '-f', '--', item.file], cwd, 10000, 'Discard failed');
  if (item.type === 'staged') return await gitRunOrError(['restore', '--staged', '--worktree', '--source=HEAD', '--', item.file], cwd, 10000, 'Discard failed');
  return await gitRunOrError(['restore', '--', item.file], cwd, 10000, 'Discard failed');
}

async function gitStashFile(cwd, file) {
  if (!file) return 'No file selected';
  return await gitRunOrError(['stash', 'push', '-u', '--', file], cwd, 10000, 'Stash file failed');
}

async function gitIgnorePattern(cwd, pattern) {
  if (!pattern) return 'No ignore pattern';
  try {
    const sep = (typeof process !== 'undefined' && process.platform === 'win32') ? '\\' : '/';
    const ignorePath = cwd + sep + '.gitignore';
    const normalized = pattern.replace(/\\/g, '/');
    let lines = [];
    const readRes = await hecaton.fs_read_file({ path: ignorePath });
    if (readRes && readRes.content) {
      lines = readRes.content.replace(/\r\n/g, '\n').split('\n');
    }
    if (lines.some(line => line.trim() === normalized)) return null;
    const content = (lines.length > 0 ? lines.join('\n').replace(/\n*$/, '\n') : '') + normalized + '\n';
    const writeRes = await hecaton.fs_write_file({ path: ignorePath, content });
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

module.exports = {
  git,
  gitExec,
  unquoteGitPath,
  gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked,
  gitStage, gitUnstage, gitStageAll, gitUnstageAll, gitCommit,
  gitStashRefs, gitShowRef, gitStashDiff, gitLogCommits,
  gitRebaseState, gitOperationState, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitMergeContinue, gitMergeAbort, gitCherryPickContinue, gitCherryPickAbort, gitCherryPickSkip,
  gitRevertContinue, gitRevertAbort, gitRevertSkip,
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
  gitStageMultiple, gitUnstageMultiple,
  gitMergeFastForwardAsync, gitPushToRemoteAsync, gitPullFromRemoteAsync,
};
