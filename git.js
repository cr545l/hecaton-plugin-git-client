const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function gitExec(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }, (err, stdout) => {
      if (err && !stdout) resolve(err.stdout ? err.stdout.replace(/\r\n/g, '\n') : '');
      else resolve((stdout || '').replace(/\r\n/g, '\n'));
    });
  });
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).replace(/\r\n/g, '\n');
  } catch (e) {
    if (e.stdout) return e.stdout.replace(/\r\n/g, '\n');
    throw e;
  }
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
  try {
    const output = git(['status', '--porcelain=v1'], cwd);
    for (const line of output.split('\n')) {
      if (!line) continue;
      const x = line[0]; // index status
      const y = line[1]; // worktree status
      const file = line.substring(3);
      if (x === '?') {
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
  return { staged, unstaged, untracked };
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
    git(['add', '--', file], cwd);
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
    git(['add', '-A'], cwd);
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
  const fs = require('fs');
  const path = require('path');
  try {
    const gitDir = git(['rev-parse', '--git-dir'], cwd).trim();
    const base = path.resolve(cwd, gitDir);
    // interactive rebase (rebase-merge)
    const rebaseMerge = path.join(base, 'rebase-merge');
    if (fs.existsSync(rebaseMerge)) {
      const step = fs.readFileSync(path.join(rebaseMerge, 'msgnum'), 'utf-8').trim();
      const total = fs.readFileSync(path.join(rebaseMerge, 'end'), 'utf-8').trim();
      return { type: 'rebase-merge', step: parseInt(step), total: parseInt(total) };
    }
    // am-style rebase (rebase-apply)
    const rebaseApply = path.join(base, 'rebase-apply');
    if (fs.existsSync(rebaseApply)) {
      const step = fs.readFileSync(path.join(rebaseApply, 'next'), 'utf-8').trim();
      const total = fs.readFileSync(path.join(rebaseApply, 'last'), 'utf-8').trim();
      return { type: 'rebase-apply', step: parseInt(step), total: parseInt(total) };
    }
  } catch { /* not in rebase */ }
  return null;
}

function gitRebase(cwd, ref) {
  try {
    execFileSync('git', ['rebase', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Rebase failed';
  }
}

function gitRebaseContinue(cwd) {
  try {
    execFileSync('git', ['rebase', '--continue'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
      env: { ...process.env, GIT_EDITOR: 'true' },
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Rebase continue failed';
  }
}

function gitRebaseAbort(cwd) {
  try {
    execFileSync('git', ['rebase', '--abort'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Rebase abort failed';
  }
}

function gitRebaseSkip(cwd) {
  try {
    execFileSync('git', ['rebase', '--skip'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Rebase skip failed';
  }
}

function gitLogCommits(cwd, extraRefs, maxCount) {
  try {
    // %x01 as record separator to handle multi-line %B
    const args = ['log', '--all', '--topo-order', '--format=%x01%H%x00%P%x00%D%x00%B'];
    if (extraRefs && extraRefs.length > 0) args.push(...extraRefs);
    if (maxCount) args.push('-' + maxCount);
    const raw = execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    }).replace(/\r\n/g, '\n').replace(/\r/g, '').trim();
    if (!raw) return [];
    return raw.split('\x01').filter(r => r.trim()).map(record => {
      const trimmed = record.trim();
      // Split only first 3 null bytes; the rest (after 3rd) is full body with newlines
      const parts = [];
      let pos = 0;
      for (let i = 0; i < 3; i++) {
        const next = trimmed.indexOf('\x00', pos);
        if (next === -1) break;
        parts.push(trimmed.substring(pos, next));
        pos = next + 1;
      }
      parts.push(trimmed.substring(pos)); // rest is full body
      const fullBody = (parts[3] || '').trim();
      const firstLine = fullBody.split('\n')[0];
      return {
        hash: parts[0] || '',
        parents: parts[1] ? parts[1].split(' ') : [],
        refs: parts[2] || '',
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
    const raw = git(['branch', '--format=%(refname:short)\t%(HEAD)'], cwd).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\t');
      return { name: parts[0], isCurrent: parts[1] === '*' };
    });
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

function gitCherryPick(cwd, ref) {
  try {
    execFileSync('git', ['cherry-pick', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Cherry-pick failed';
  }
}

function gitRevert(cwd, ref) {
  try {
    execFileSync('git', ['revert', '--no-edit', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Revert failed';
  }
}

function gitCheckoutRef(cwd, ref) {
  try {
    execFileSync('git', ['checkout', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Checkout failed';
  }
}

function gitCreateBranch(cwd, name, startPoint) {
  try {
    const args = ['checkout', '-b', name];
    if (startPoint) args.push(startPoint);
    execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Create branch failed';
  }
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

function gitReset(cwd, ref) {
  try {
    execFileSync('git', ['reset', '--hard', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Reset failed';
  }
}

function gitMerge(cwd, ref) {
  try {
    execFileSync('git', ['merge', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Merge failed';
  }
}

function gitFetch(cwd) {
  try {
    execFileSync('git', ['fetch', '--all', '--prune'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Fetch failed';
  }
}

function gitPull(cwd) {
  try {
    execFileSync('git', ['pull'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Pull failed';
  }
}

function gitPush(cwd) {
  try {
    execFileSync('git', ['push'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Push failed';
  }
}

function gitStashSave(cwd) {
  try {
    execFileSync('git', ['stash', 'push'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash failed';
  }
}

function gitStashPop(cwd) {
  try {
    execFileSync('git', ['stash', 'pop'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash pop failed';
  }
}

function gitStashApply(cwd, ref) {
  try {
    execFileSync('git', ['stash', 'apply', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash apply failed';
  }
}

function gitStashDrop(cwd, ref) {
  try {
    execFileSync('git', ['stash', 'drop', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash drop failed';
  }
}

function gitStashRename(cwd, ref, newMessage) {
  try {
    const hash = git(['rev-parse', ref], cwd).trim();
    execFileSync('git', ['stash', 'drop', ref], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    execFileSync('git', ['stash', 'store', '-m', newMessage, hash], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
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

function gitDiscardFile(cwd, item) {
  if (!item || !item.file) return 'No file selected';
  try {
    if (item.type === 'untracked') {
      execFileSync('git', ['clean', '-f', '--', item.file], {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
      });
      return null;
    }
    if (item.type === 'staged') {
      execFileSync('git', ['restore', '--staged', '--worktree', '--source=HEAD', '--', item.file], {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
      });
      return null;
    }
    execFileSync('git', ['restore', '--', item.file], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Discard failed';
  }
}

function gitStashFile(cwd, file) {
  if (!file) return 'No file selected';
  try {
    execFileSync('git', ['stash', 'push', '-u', '--', file], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    return null;
  } catch (e) {
    return e.stderr || e.message || 'Stash file failed';
  }
}

function gitIgnorePattern(cwd, pattern) {
  if (!pattern) return 'No ignore pattern';
  try {
    const ignorePath = path.join(cwd, '.gitignore');
    const normalized = pattern.replace(/\\/g, '/');
    let lines = [];
    if (fs.existsSync(ignorePath)) {
      lines = fs.readFileSync(ignorePath, 'utf-8').replace(/\r\n/g, '\n').split('\n');
    }
    if (lines.some(line => line.trim() === normalized)) return null;
    const content = (lines.length > 0 ? lines.join('\n').replace(/\n*$/, '\n') : '') + normalized + '\n';
    fs.writeFileSync(ignorePath, content, 'utf-8');
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
  gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked,
  gitStage, gitUnstage, gitStageAll, gitUnstageAll, gitCommit,
  gitStashRefs, gitShowRef, gitStashDiff, gitLogCommits,
  gitRebaseState, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitBranches, gitRemoteBranches,
  gitCherryPick, gitRevert, gitCheckoutRef, gitCreateBranch, gitCreateTag,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
  gitFetch, gitPull, gitPush, gitStashSave, gitStashPop,
  gitStashApply, gitStashDrop, gitStashRename,
  gitDiscardFile, gitStashFile, gitIgnorePattern,
  gitFileHistory, gitBlameFile, gitFilePatch,
};
