const { execFileSync, execFile } = require('child_process');

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
    const args = ['log', '--all', '--topo-order', '--format=%H%x00%P%x00%D%x00%s'];
    if (extraRefs && extraRefs.length > 0) args.push(...extraRefs);
    if (maxCount) args.push('-' + maxCount);
    const raw = execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    }).replace(/\r\n/g, '\n').trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const parts = line.split('\0');
      return {
        hash: parts[0],
        parents: parts[1] ? parts[1].split(' ') : [],
        refs: parts[2] || '',
        subject: (parts[3] || '').replace(/[\r\n]+/g, ' '),
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

module.exports = {
  gitExec,
  gitIsRepo, gitBranch, gitStatus, gitDiff, gitDiffUntracked,
  gitStage, gitUnstage, gitStageAll, gitUnstageAll, gitCommit,
  gitStashRefs, gitShowRef, gitStashDiff, gitLogCommits,
  gitRebaseState, gitRebase, gitRebaseContinue, gitRebaseAbort, gitRebaseSkip,
  gitBranches, gitRemoteBranches,
  gitCherryPick, gitRevert, gitCheckoutRef, gitCreateBranch, gitCreateTag,
  gitReset, gitMerge, gitFormatPatch, gitCommitInfo,
};
