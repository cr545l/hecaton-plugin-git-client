const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: {} };

const reap = require('../reap');

const NOW = Date.parse('2026-08-19T12:00:00Z');
const OLD = NOW - reap.MIN_AGE_MS - 60000;      // 확실히 회수 대상
const FRESH = NOW - 1000;                        // 방금 뜬 정상 폴링

const DIFF_FILES = '"C:\\Program Files\\Git\\cmd\\git.exe" --no-optional-locks diff-files --name-only -z';
const LS_FILES = '"C:\\Program Files\\Git\\cmd\\git.exe" --no-optional-locks ls-files --others --directory --no-empty-directory -z --exclude-standard';

function proc(pid, cmd, created) {
  return { ProcessId: pid, CommandLine: cmd, CreationDate: new Date(created).toISOString() };
}

test('오래 남은 폴링 프로세스를 대상으로 잡는다', () => {
  const targets = reap.selectOrphans([proc(100, DIFF_FILES, OLD), proc(101, LS_FILES, OLD)], NOW);
  assert.deepEqual(targets, [100, 101]);
});

test('방금 뜬 폴링 프로세스는 건드리지 않는다', () => {
  const targets = reap.selectOrphans([proc(100, DIFF_FILES, FRESH), proc(101, LS_FILES, FRESH)], NOW);
  assert.deepEqual(targets, [], '정상 동작 중인 폴링을 죽이면 화면 갱신이 끊긴다');
});

test('이 플러그인이 쓰지 않는 git 명령은 남의 것으로 보고 놔둔다', () => {
  // 실제로 관찰된 좀비들이다. 부모가 같은 다른 git 클라이언트가 띄운 것이라
  // 이름이 git.exe라는 이유만으로 죽이면 안 된다.
  const others = [
    proc(200, 'git status --porcelain=v2 --branch --untracked-files=normal', OLD),
    proc(201, 'git worktree list --porcelain', OLD),
    proc(202, 'git worktree prune', OLD),
    proc(203, 'git fsmonitor--daemon run --detach --ipc-threads=8', OLD),
  ];
  assert.deepEqual(reap.selectOrphans(others, NOW), []);
});

test('사용자가 직접 돌리는 장기 작업은 대상이 아니다', () => {
  const userWork = [
    proc(300, 'git fetch --all --prune --jobs=4', OLD),
    proc(301, 'git push origin main', OLD),
    proc(302, 'git clone https://example.com/big-repo.git', OLD),
    proc(303, 'git gc --aggressive', OLD),
  ];
  assert.deepEqual(reap.selectOrphans(userWork, NOW), []);
});

test('인자가 조금이라도 다르면 대상이 아니다', () => {
  const near = [
    proc(400, 'git diff-files --name-only -z', OLD),                              // --no-optional-locks 없음
    proc(401, 'git --no-optional-locks diff-files --name-only', OLD),             // -z 없음
    proc(402, 'git --no-optional-locks ls-files --others', OLD),                  // 인자 일부
    proc(403, 'git --no-optional-locks diff-files --name-only -z -- src/', OLD),  // 경로 인자가 붙음
  ];
  assert.deepEqual(reap.selectOrphans(near, NOW), []);
});

test('생성 시각을 못 읽으면 건드리지 않는다', () => {
  const unknown = [
    { ProcessId: 500, CommandLine: DIFF_FILES, CreationDate: null },
    { ProcessId: 501, CommandLine: DIFF_FILES, CreationDate: 'not-a-date' },
    { ProcessId: 502, CommandLine: DIFF_FILES },
  ];
  assert.deepEqual(reap.selectOrphans(unknown, NOW), [], '나이를 모르면 판단도 없다');
});

test('시계가 뒤로 간 기록도 나이를 신뢰하지 않는다', () => {
  const future = [proc(600, DIFF_FILES, NOW + 3600000)];
  assert.deepEqual(reap.selectOrphans(future, NOW), []);
});

test('/Date(...) 형식 생성 시각도 읽는다', () => {
  const entries = [{ ProcessId: 700, CommandLine: DIFF_FILES, CreationDate: '/Date(' + OLD + ')/' }];
  assert.deepEqual(reap.selectOrphans(entries, NOW), [700]);
});

test('항목이 하나면 배열이 아닌 객체로 와도 처리한다', () => {
  // ConvertTo-Json은 항목이 하나일 때 배열로 감싸지 않는다.
  assert.deepEqual(reap.selectOrphans(proc(800, DIFF_FILES, OLD), NOW), [800]);
});

test('빈 입력에도 안전하다', () => {
  assert.deepEqual(reap.selectOrphans(null, NOW), []);
  assert.deepEqual(reap.selectOrphans([], NOW), []);
  assert.deepEqual(reap.selectOrphans([null, undefined], NOW), []);
});

test('시스템 PID는 후보에서 제외한다', () => {
  const entries = [
    { ProcessId: 0, CommandLine: DIFF_FILES, CreationDate: new Date(OLD).toISOString() },
    { ProcessId: 4, CommandLine: DIFF_FILES, CreationDate: new Date(OLD).toISOString() },
    { ProcessId: 'abc', CommandLine: DIFF_FILES, CreationDate: new Date(OLD).toISOString() },
  ];
  assert.deepEqual(reap.selectOrphans(entries, NOW), []);
});

test('한 번에 정리하는 개수에 상한이 있다', () => {
  const many = [];
  for (let i = 0; i < reap.MAX_KILLS + 25; i++) many.push(proc(1000 + i, DIFF_FILES, OLD));
  assert.equal(reap.selectOrphans(many, NOW).length, reap.MAX_KILLS);
});

test('섞여 있어도 우리 것만 골라낸다', () => {
  const mixed = [
    proc(23804, 'git status --porcelain=v2 --branch --untracked-files=normal', OLD),
    proc(29892, DIFF_FILES, OLD),
    proc(44772, 'git fsmonitor--daemon run --detach --ipc-threads=8', OLD),
    proc(56196, LS_FILES, FRESH),
    proc(56197, LS_FILES, OLD),
  ];
  assert.deepEqual(reap.selectOrphans(mixed, NOW), [29892, 56197]);
});
