const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: {} };

const { computeRefsTreeSignature } = require('../refresh');

const SEP = (process.platform === 'win32') ? '\\' : '/';
const GIT_DIR = ['C:', 'repo', '.git'].join(SEP);
const REFS = GIT_DIR + SEP + 'refs';

function dir(name) { return { name, is_dir: true }; }
function file(name, mtime, size) { return { name, is_dir: false, mtime_ms: mtime, size_bytes: size || 41 }; }

// tree: { [absolute dir path]: entries[] } — 등록되지 않은 경로는 read_dir 실패로 취급
function mockTree(tree) {
  hecaton.fs.read_dir = async ({ path }) => {
    const entries = tree[path];
    if (!entries) return { ok: false };
    return { ok: true, entries };
  };
}

function remoteTree(originEntries) {
  return {
    [REFS]: [dir('heads'), dir('remotes'), dir('tags')],
    [REFS + SEP + 'heads']: [file('main', 100)],
    [REFS + SEP + 'remotes']: [dir('origin')],
    [REFS + SEP + 'remotes' + SEP + 'origin']: originEntries,
    [REFS + SEP + 'tags']: [],
  };
}

test('deleting a remote-tracking branch changes the signature', async () => {
  mockTree(remoteTree([file('HEAD', 100), file('feat-x', 100), file('main', 100)]));
  const before = await computeRefsTreeSignature(GIT_DIR);

  mockTree(remoteTree([file('HEAD', 100), file('main', 100)]));
  const after = await computeRefsTreeSignature(GIT_DIR);

  assert.notEqual(before, after);
  assert.match(before, /remotes\/origin\/feat-x/);
  assert.doesNotMatch(after, /feat-x/);
});

test('deleting a nested remote-tracking branch changes the signature', async () => {
  const withNested = remoteTree([file('main', 100), dir('feature')]);
  withNested[REFS + SEP + 'remotes' + SEP + 'origin' + SEP + 'feature'] = [file('login', 100)];
  mockTree(withNested);
  const before = await computeRefsTreeSignature(GIT_DIR);

  const pruned = remoteTree([file('main', 100), dir('feature')]);
  pruned[REFS + SEP + 'remotes' + SEP + 'origin' + SEP + 'feature'] = [];
  mockTree(pruned);
  const after = await computeRefsTreeSignature(GIT_DIR);

  assert.notEqual(before, after);
  assert.match(before, /remotes\/origin\/feature\/login/);
  assert.doesNotMatch(after, /login/);
});

test('a tag added at any depth changes the signature', async () => {
  const base = remoteTree([file('main', 100)]);
  mockTree(base);
  const before = await computeRefsTreeSignature(GIT_DIR);

  const tagged = remoteTree([file('main', 100)]);
  tagged[REFS + SEP + 'tags'] = [file('v1.0.0', 200)];
  mockTree(tagged);
  const after = await computeRefsTreeSignature(GIT_DIR);

  assert.notEqual(before, after);
});

test('an in-place ref update (fetch moving origin/main) changes the signature', async () => {
  mockTree(remoteTree([file('main', 100)]));
  const before = await computeRefsTreeSignature(GIT_DIR);

  mockTree(remoteTree([file('main', 999)]));
  const after = await computeRefsTreeSignature(GIT_DIR);

  assert.notEqual(before, after);
});

test('an unchanged tree yields a stable signature regardless of read_dir order', async () => {
  mockTree(remoteTree([file('HEAD', 100), file('feat-x', 100), file('main', 100)]));
  const first = await computeRefsTreeSignature(GIT_DIR);

  mockTree(remoteTree([file('main', 100), file('HEAD', 100), file('feat-x', 100)]));
  const second = await computeRefsTreeSignature(GIT_DIR);

  assert.equal(first, second);
});

test('hosts without read_dir fall back to an empty signature instead of throwing', async () => {
  delete hecaton.fs.read_dir;
  assert.equal(await computeRefsTreeSignature(GIT_DIR), '');
});

test('an unreadable refs directory falls back to an empty signature', async () => {
  mockTree({});
  assert.equal(await computeRefsTreeSignature(GIT_DIR), '');

  hecaton.fs.read_dir = async () => { throw new Error('EPERM'); };
  assert.equal(await computeRefsTreeSignature(GIT_DIR), '');
});

test('an empty refs tree is still distinguishable from a failed scan', async () => {
  mockTree({ [REFS]: [] });
  assert.equal(await computeRefsTreeSignature(GIT_DIR), 'refs\n');
});

test('a huge ref tree is truncated but stays stable and non-throwing', async () => {
  const many = [];
  for (let i = 0; i < 5000; i++) many.push(file('b' + i, 100));
  mockTree({
    [REFS]: [dir('heads')],
    [REFS + SEP + 'heads']: many,
  });
  const first = await computeRefsTreeSignature(GIT_DIR);
  const second = await computeRefsTreeSignature(GIT_DIR);

  assert.equal(first, second);
  assert.match(first, /~truncated$/);
});

test('missing gitDir yields an empty signature', async () => {
  mockTree(remoteTree([file('main', 100)]));
  assert.equal(await computeRefsTreeSignature(''), '');
});
