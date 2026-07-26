// unstage 통합 테스트 — 실제 git을 돌린다.
// 커밋이 하나도 없는 저장소(unborn HEAD)에서는 HEAD를 해석할 수 없어
// 'restore --staged' / 'reset HEAD' 가 fatal로 죽었다. 인자 문자열만 검사해서는
// 이 회귀를 잡을 수 없으므로 실제 저장소를 만들어 결과 상태를 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

global.hecaton = {
  process: {
    exec: async ({ program, args, cwd }) => {
      try {
        const stdout = execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, exit_code: 0, stdout, stderr: '' };
      } catch (e) {
        return {
          ok: false,
          exit_code: typeof e.status === 'number' ? e.status : 1,
          stdout: e.stdout || '',
          stderr: e.stderr || '',
          error: String(e.message),
        };
      }
    },
  },
};

const { gitUnstage, gitUnstageAll, gitUnstageMultiple } = require('../git');

const repos = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// status --short 를 { file: 'XY' } 로. X=인덱스, Y=워킹트리, '??'=untracked
function status(cwd) {
  const out = git(cwd, 'status', '--porcelain');
  const map = {};
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    map[line.substring(3).trim()] = line.substring(0, 2);
  }
  return map;
}

// withCommit=false 면 커밋 없는 저장소(unborn HEAD)
function makeRepo({ withCommit = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitclient-unstage-'));
  repos.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  if (withCommit) {
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(dir, 'add', 'seed.txt');
    git(dir, 'commit', '-q', '-m', 'seed');
  }
  return dir;
}

function write(dir, rel, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

test.after(() => {
  for (const dir of repos) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
  }
});

test('커밋이 없는 저장소에서 파일 하나를 unstage할 수 있다', async () => {
  const dir = makeRepo();
  write(dir, 'a.txt', 'v1\n');
  write(dir, 'b.txt', 'v1\n');
  git(dir, 'add', 'a.txt', 'b.txt');

  const err = await gitUnstage(dir, 'a.txt');

  assert.equal(err, null, '에러 없이 성공해야 한다');
  const st = status(dir);
  assert.equal(st['a.txt'], '??', 'a.txt는 untracked로 돌아가야 한다');
  assert.equal(st['b.txt'], 'A ', 'b.txt는 staged로 남아야 한다');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1\n', '워킹트리 내용은 보존');
});

test('커밋이 없는 저장소에서 add 후 수정된 파일(AM)도 unstage할 수 있다', async () => {
  const dir = makeRepo();
  write(dir, 'a.txt', 'v1\n');
  git(dir, 'add', 'a.txt');
  write(dir, 'a.txt', 'v2-modified\n');
  assert.equal(status(dir)['a.txt'], 'AM', '사전 조건: AM 상태');

  const err = await gitUnstage(dir, 'a.txt');

  assert.equal(err, null);
  assert.equal(status(dir)['a.txt'], '??');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v2-modified\n', '수정 내용이 보존돼야 한다');
});

test('커밋이 없는 저장소에서 Unstage All이 동작한다', async () => {
  const dir = makeRepo();
  write(dir, 'a.txt', 'v1\n');
  write(dir, 'sub/c.txt', 'v1\n');
  git(dir, 'add', '-A');
  write(dir, 'a.txt', 'v2\n');

  const err = await gitUnstageAll(dir);

  assert.equal(err, null);
  const st = status(dir);
  assert.equal(Object.values(st).every(s => s === '??'), true, '모두 untracked여야 한다: ' + JSON.stringify(st));
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
  assert.equal(fs.existsSync(path.join(dir, 'sub/c.txt')), true);
});

test('커밋이 없는 저장소에서 여러 파일을 한 번에 unstage할 수 있다', async () => {
  const dir = makeRepo();
  write(dir, 'a.txt', 'v1\n');
  write(dir, 'b.txt', 'v1\n');
  write(dir, 'c.txt', 'v1\n');
  git(dir, 'add', '-A');

  const err = await gitUnstageMultiple(dir, ['a.txt', 'b.txt']);

  assert.equal(err, null);
  const st = status(dir);
  assert.equal(st['a.txt'], '??');
  assert.equal(st['b.txt'], '??');
  assert.equal(st['c.txt'], 'A ', '지정하지 않은 파일은 staged로 남아야 한다');
});

// ── 커밋이 있는 일반 저장소에서의 기존 동작 회귀 확인 ──

test('커밋이 있는 저장소에서 새 파일 unstage는 untracked로 되돌린다', async () => {
  const dir = makeRepo({ withCommit: true });
  write(dir, 'new.txt', 'v1\n');
  git(dir, 'add', 'new.txt');

  const err = await gitUnstage(dir, 'new.txt');

  assert.equal(err, null);
  assert.equal(status(dir)['new.txt'], '??');
});

test('커밋이 있는 저장소에서 수정 파일 unstage는 변경을 워킹트리에 남긴다', async () => {
  const dir = makeRepo({ withCommit: true });
  write(dir, 'seed.txt', 'changed\n');
  git(dir, 'add', 'seed.txt');
  assert.equal(status(dir)['seed.txt'], 'M ', '사전 조건: staged modification');

  const err = await gitUnstage(dir, 'seed.txt');

  assert.equal(err, null);
  assert.equal(status(dir)['seed.txt'], ' M', 'unstaged modification으로 남아야 한다');
  assert.equal(fs.readFileSync(path.join(dir, 'seed.txt'), 'utf8'), 'changed\n');
});

test('커밋이 있는 저장소에서 Unstage All은 커밋된 내용을 지우지 않는다', async () => {
  const dir = makeRepo({ withCommit: true });
  write(dir, 'seed.txt', 'changed\n');
  write(dir, 'new.txt', 'v1\n');
  git(dir, 'add', '-A');

  const err = await gitUnstageAll(dir);

  assert.equal(err, null);
  const st = status(dir);
  assert.equal(st['seed.txt'], ' M');
  assert.equal(st['new.txt'], '??');
  // 커밋은 그대로
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('삭제 스테이징(D)도 unstage로 되돌린다', async () => {
  const dir = makeRepo({ withCommit: true });
  git(dir, 'rm', '-q', 'seed.txt');
  assert.equal(status(dir)['seed.txt'], 'D ', '사전 조건: staged deletion');

  const err = await gitUnstage(dir, 'seed.txt');

  assert.equal(err, null);
  assert.equal(status(dir)['seed.txt'], ' D', '워킹트리 삭제만 남아야 한다');
});
