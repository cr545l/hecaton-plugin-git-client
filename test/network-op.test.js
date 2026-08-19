const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');

const files = new Map();
let execCalls = [];
let execResult = { ok: true, exit_code: 0, stdout: '', stderr: '' };

global.hecaton = {
  fs: {
    async mkdir() { return { ok: true }; },
    async read_file({ path }) {
      if (!files.has(path)) return { ok: false };
      return { ok: true, content: files.get(path) };
    },
    async write_file({ path, content }) { files.set(path, content); return { ok: true }; },
    async stat({ path }) { return { exists: files.has(path) }; },
  },
  process: {
    async exec(params) {
      execCalls.push(params);
      return execResult;
    },
  },
  window: {},
  initialState: {},
};

const coordinate = require('../coordinate');
const git = require('../git');

const COMMON_DIR = ['C:', 'repo', '.git'].join(nodePath.sep);
const CWD = ['C:', 'repo'].join(nodePath.sep);
const NETOP = nodePath.join(COMMON_DIR, 'hecaton-git-client', 'netop.json');

function reset() {
  files.clear();
  execCalls = [];
  execResult = { ok: true, exit_code: 0, stdout: '', stderr: '' };
  coordinate.configure(COMMON_DIR, CWD);
}

function netop() {
  const raw = files.get(NETOP);
  return raw ? JSON.parse(raw) : null;
}

function gitArgsOf(call) { return (call.args || []).join(' '); }

test('fetch는 원격을 병렬로 가져온다', async () => {
  reset();
  const err = await git.gitFetchAsync(CWD);
  assert.equal(err, null);
  assert.equal(execCalls.length, 1);
  assert.equal(gitArgsOf(execCalls[0]), 'fetch --all --prune --jobs=4');
});

test('fetch가 끝나면 진행 기록이 성공으로 닫힌다', async () => {
  reset();
  await git.gitFetchAsync(CWD);
  const rec = netop();
  assert.equal(rec.op, 'fetch');
  assert.equal(rec.ok, true);
  assert.ok(rec.finishedAt >= rec.startedAt);
});

test('fetch가 실패하면 진행 기록도 실패로 남아 재사용되지 않는다', async () => {
  reset();
  execResult = { ok: true, exit_code: 1, stdout: '', stderr: 'could not read from remote' };
  const err = await git.gitFetchAsync(CWD);
  assert.match(err, /could not read from remote/);
  assert.equal(netop().ok, false);
});

test('방금 다른 인스턴스가 끝낸 fetch는 git을 다시 돌리지 않는다', async () => {
  reset();
  const now = Date.now();
  files.set(NETOP, JSON.stringify({ op: 'fetch', owner: 'other', startedAt: now - 1500, finishedAt: now - 50, ok: true }));
  const err = await git.gitFetchAsync(CWD);
  assert.equal(err, null, '호출부 입장에서는 성공과 같아야 한다');
  assert.equal(execCalls.length, 0, 'git을 새로 스폰하면 최적화가 무의미하다');
});

test('다른 인스턴스가 fetch 중이면 기다렸다가 그 결과를 쓴다', async () => {
  reset();
  const now = Date.now();
  files.set(NETOP, JSON.stringify({ op: 'fetch', owner: 'other', startedAt: now, finishedAt: 0, ok: false }));
  setTimeout(() => {
    files.set(NETOP, JSON.stringify({ op: 'fetch', owner: 'other', startedAt: now, finishedAt: Date.now(), ok: true }));
  }, 300);
  const err = await git.gitFetchAsync(CWD);
  assert.equal(err, null);
  assert.equal(execCalls.length, 0);
});

test('push는 남이 방금 끝냈어도 내가 다시 실행한다', async () => {
  reset();
  const now = Date.now();
  files.set(NETOP, JSON.stringify({ op: 'push', owner: 'other', startedAt: now - 1500, finishedAt: now - 50, ok: true }));
  await git.gitPushAsync(CWD);
  assert.equal(execCalls.length, 1, '브랜치가 다르면 남의 push는 내 커밋을 올려주지 않는다');
  assert.equal(gitArgsOf(execCalls[0]), 'push');
});

test('pull도 남의 결과로 대체하지 않는다', async () => {
  reset();
  const now = Date.now();
  files.set(NETOP, JSON.stringify({ op: 'pull', owner: 'other', startedAt: now - 1500, finishedAt: now - 50, ok: true }));
  await git.gitPullAsync(CWD);
  assert.equal(execCalls.length, 1);
  assert.equal(gitArgsOf(execCalls[0]), 'pull');
});

test('멈춘 인스턴스의 기록에 발이 묶이지 않는다', async () => {
  reset();
  files.set(NETOP, JSON.stringify({ op: 'fetch', owner: 'dead', startedAt: Date.now() - 120000, finishedAt: 0, ok: false }));
  const err = await git.gitFetchAsync(CWD);
  assert.equal(err, null);
  assert.equal(execCalls.length, 1);
});

test('조율이 꺼져 있어도 fetch는 평소대로 동작한다', async () => {
  reset();
  coordinate.configure('', CWD);
  const err = await git.gitFetchAsync(CWD);
  assert.equal(err, null);
  assert.equal(execCalls.length, 1);
  assert.equal(gitArgsOf(execCalls[0]), 'fetch --all --prune --jobs=4');
});

test('브랜치로 끌어오는 fetch는 남의 결과로 대체하지 않는다', async () => {
  reset();
  const now = Date.now();
  files.set(NETOP, JSON.stringify({ op: 'fetch', owner: 'other', startedAt: now - 1500, finishedAt: now - 50, ok: true }));
  await git.gitFetchIntoBranchAsync(CWD, 'origin', 'main', 'main');
  assert.equal(execCalls.length, 1, '특정 ref만 옮기는 fetch는 --all 결과로 대체할 수 없다');
  assert.equal(gitArgsOf(execCalls[0]), 'fetch origin main:main');
});

test('force push도 진행 중인 작업과 겹치지 않게 조율된다', async () => {
  reset();
  const now = Date.now();
  files.set(NETOP, JSON.stringify({ op: 'push', owner: 'other', startedAt: now, finishedAt: 0, ok: false }));
  setTimeout(() => {
    files.set(NETOP, JSON.stringify({ op: 'push', owner: 'other', startedAt: now, finishedAt: Date.now(), ok: true }));
  }, 250);
  await git.gitForcePushAsync(CWD, 'origin', 'main');
  assert.equal(execCalls.length, 0);
});
