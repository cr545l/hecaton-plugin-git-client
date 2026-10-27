const path = require('path');

async function readText(file) {
  try {
    const result = await hecaton.fs.read_file({ path: file });
    return result && result.ok !== false && typeof result.content === 'string'
      ? result.content.trim() : null;
  } catch { return null; }
}

function number(text) {
  return text !== null && /^\d+$/.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text) : null;
}

async function readRebaseProgress(directory, apply = false) {
  const [stepText, totalText] = await Promise.all([
    readText(path.join(directory, apply ? 'next' : 'msgnum')),
    readText(path.join(directory, apply ? 'last' : 'end')),
  ]);
  const step = number(stepText), total = number(totalText);
  if (step !== null && total !== null && step <= total) return { step, total };
  if (!apply) {
    const [done, todo] = await Promise.all([
      readText(path.join(directory, 'done')),
      readText(path.join(directory, 'git-rebase-todo')),
    ]);
    if (done !== null && todo !== null) {
      const commands = (done + '\n' + todo).split('\n')
        .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      if (commands.length && commands.every(line => line === 'noop')) return { step: 0, total: 0 };
    }
  }
  // Missing/corrupt counters must not masquerade as zero completed commits.
  return { step: null, total: null };
}

module.exports = { readRebaseProgress };
