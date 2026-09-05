const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isUnnameablePath,
  gitDiscardFile,
  gitCleanUntrackedAsync,
  gitDiscardAllChangesAsync,
} = require('../git');

const CWD = 'C:\\repo';

// exec 호출을 인자 배열로 매칭해 응답을 돌려주는 목. 각 호출은 calls 에 순서대로 쌓인다.
function mockGit(routes) {
  const calls = [];
  global.hecaton = {
    process: {
      exec: async params => {
        calls.push(params.args);
        for (const [match, reply] of routes) {
          if (match(params.args)) return typeof reply === 'function' ? reply(params.args) : reply;
        }
        return { ok: true, exit_code: 0, stdout: '', stderr: '' };
      },
    },
  };
  return calls;
}

const has = (...needles) => args => needles.every(n => args.indexOf(n) !== -1);
const ok = (stdout = '') => ({ ok: true, exit_code: 0, stdout, stderr: '' });
const cleanBlocked = (...paths) => ({
  ok: true,
  exit_code: 1,
  stdout: '',
  stderr: paths.map(p => 'warning: failed to remove ' + p + ': Permission denied').join('\n'),
});
// git 별칭으로 부르는 MSYS rm 호출만 골라 인자를 뽑는다.
const rmTargets = calls => calls
  .filter(args => args.indexOf('hecaton-force-remove') !== -1)
  .map(args => args.slice(args.indexOf('hecaton-force-remove') + 1));

test('Win32가 가리킬 수 없는 이름만 골라낸다', () => {
  for (const name of ['nul', 'NUL', 'con', 'aux', 'prn', 'com1', 'LPT9', 'nul.txt',
                      'sub/dir/nul', 'sub\\dir\\con.log', 'trailing.', 'trailing ']) {
    assert.equal(isUnnameablePath(name), true, name + ' 은 막힌 이름이어야 한다');
  }
  for (const name of ['null', 'nulfile', 'conf', 'auxiliary', 'com', 'com10', 'lpt',
                      'src/console.js', 'a.nul', '']) {
    assert.equal(isUnnameablePath(name), false, name + ' 은 평범한 이름이어야 한다');
  }
});

test('예약 이름 파일은 번들 rm 으로 치우고 clean 을 다시 돌려 discard 를 끝낸다', async () => {
  let cleanCount = 0;
  const calls = mockGit([
    [has('clean', 'nul'), () => (++cleanCount === 1 ? cleanBlocked('nul') : ok())],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'untracked', file: 'nul' });

  assert.equal(err, null);
  assert.equal(cleanCount, 2);
  assert.deepEqual(rmTargets(calls), [['nul']]);
  // 경로가 8진 이스케이프로 뭉개지면 rm 대상으로 되돌릴 수 없다.
  assert.ok(calls[0].indexOf('core.quotePath=false') !== -1);
});

test('rm 까지 막히면 프로세스 잠금이 아니라 예약 이름이라고 알린다', async () => {
  const calls = mockGit([
    [has('clean'), cleanBlocked('nul')],
    [has('hecaton-force-remove'), { ok: true, exit_code: 1, stdout: '', stderr: 'rm: cannot remove' }],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'untracked', file: 'nul' });

  assert.match(err, /failed to remove nul/);
  assert.match(err, /Windows keeps this name for a device/);
  assert.doesNotMatch(err, /Another process is holding/);
  assert.equal(rmTargets(calls).length, 1);
});

test('예약 이름이 아닌 잠긴 파일은 rm 을 부르지 않고 잠금 안내를 유지한다', async () => {
  const calls = mockGit([
    [has('clean'), cleanBlocked('build/output.dll')],
  ]);

  const err = await gitDiscardFile(CWD, { type: 'untracked', file: 'build/output.dll' });

  assert.match(err, /Another process is holding the file open/);
  assert.doesNotMatch(err, /Windows keeps this name/);
  assert.deepEqual(rmTargets(calls), []);
});

test('Remove All Untracked 는 막힌 예약 이름만 골라 치운다', async () => {
  let cleanCount = 0;
  const calls = mockGit([
    [has('clean'), () => (++cleanCount === 1 ? cleanBlocked('nul', 'sub dir/nul', 'held.dll') : ok())],
  ]);

  const err = await gitCleanUntrackedAsync(CWD);

  assert.equal(err, null);
  assert.deepEqual(rmTargets(calls), [['nul', 'sub dir/nul']]);
});

test('Discard All 도 clean 단계에서 막힌 예약 이름을 치우고 마무리한다', async () => {
  let cleanCount = 0;
  const calls = mockGit([
    [has('rev-parse', 'HEAD'), ok('abc123\n')],
    [has('reset', '--hard'), ok()],
    [has('clean'), () => (++cleanCount === 1 ? cleanBlocked('nul') : ok())],
  ]);

  const err = await gitDiscardAllChangesAsync(CWD);

  assert.equal(err, null);
  assert.equal(cleanCount, 2);
  assert.deepEqual(rmTargets(calls), [['nul']]);
});
