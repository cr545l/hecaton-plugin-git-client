// 권한 팝업은 "무엇에 접근하는지"(호스트가 씀)와 "왜 필요한지"(우리가 씀)를 함께 보여준다.
// 후자를 주지 않으면 목적란 자체가 빠진 채 뜬다 — 사용자는 git-client 가 왜 git 을
// 실행하려는지 모르는 상태로 예/아니오를 고르게 된다.
//
// 여기서 지키는 것:
//   - prompt 상태에서만 request 하고, reason 은 번역을 통째로(en+ko) 보낸다.
//     호스트에 설정된 플러그인 언어가 우리 화면 언어와 다를 수 있어 한 언어만 보내면 안 된다.
//   - 거부는 결정으로 받아들인다. 실제 호출을 하지 않고, 같은 권한으로 팝업을 다시 열지 않는다.
//   - 승인은 기억한다. 3초마다 도는 폴링이 매번 query 를 왕복하면 안 된다.
//   - permissions 네임스페이스가 없는 호스트에서는 게이트가 없다는 이유로 기능을 끄지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const calls = { query: [], request: [], exec: [], clipboard: [] };
let queryState = 'prompt';
let grant = true;
let permissionsApi = true;

global.hecaton = {
  terminal: {}, initialState: { cols: 120, rows: 40 }, on: () => {},
  process: {
    exec: async (params) => { calls.exec.push(params); return { ok: true, exit_code: 0, stdout: 'out', stderr: '' }; },
  },
  clipboard: {
    write: async ({ text }) => { calls.clipboard.push(text); return { ok: true }; },
    read: async () => ({ text: 'pasted' }),
  },
  fs: {}, window: {}, dialog: { show: () => Promise.resolve({}) }, menu: { show: () => Promise.resolve({}) },
  get permissions() {
    if (!permissionsApi) return undefined;
    return {
      query: async (req) => { calls.query.push(req); return { ok: true, state: queryState, granted: queryState === 'granted' }; },
      request: async (req) => {
        calls.request.push(req);
        return { ok: true, state: grant ? 'granted' : 'denied', granted: grant };
      },
    };
  },
};

const perms = require('../permissions');
const { state } = require('../state');
const rendering = require('../render');
rendering.render = () => {};

function setup(opts = {}) {
  calls.query.length = calls.request.length = calls.exec.length = calls.clipboard.length = 0;
  queryState = opts.state || 'prompt';
  grant = opts.grant !== false;
  permissionsApi = opts.permissionsApi !== false;
  state.error = null;
  state.spinnerActive = false;
  perms.reset();
}

test('프롬프트 상태면 실행 전에 사유를 붙여 요청한다', async () => {
  setup();
  const result = await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo', timeout_ms: 5000 });

  assert.deepEqual(calls.query[0], { permission: 'process_exec', path: 'git' });
  assert.equal(calls.request.length, 1);
  assert.equal(calls.request[0].permission, 'process_exec');
  // 경로 기반 권한이라 path 가 빠지면 호스트가 invalid_params 로 돌려준다.
  assert.equal(calls.request[0].path, 'git');

  const reason = calls.request[0].reason;
  assert.equal(typeof reason, 'object', '한 언어만 고르지 말고 번역 전체를 넘긴다');
  assert.ok(reason.en && reason.ko, 'en/ko 가 모두 있어야 호스트가 자기 언어를 고른다');
  assert.notEqual(reason.en, reason.ko);
  assert.ok(!reason.en.includes('permission.reason'), '키가 그대로 새어 나가면 안 된다');

  assert.equal(calls.exec.length, 1, '승인 뒤에는 실제로 실행한다');
  assert.equal(result.stdout, 'out');
});

test('이미 승인된 권한은 팝업을 열지 않는다', async () => {
  setup({ state: 'granted' });
  await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });
  assert.equal(calls.request.length, 0);
  assert.equal(calls.exec.length, 1);
});

test('승인은 기억한다 — 폴링이 매번 호스트를 왕복하지 않는다', async () => {
  setup();
  await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });
  await perms.execGit({ program: 'git', args: ['log'], cwd: 'C:/repo' });
  await perms.execGit({ program: 'git', args: ['diff'], cwd: 'C:/repo' });
  assert.equal(calls.query.length, 1);
  assert.equal(calls.request.length, 1);
  assert.equal(calls.exec.length, 3);
});

test('거부하면 실행하지 않고 실패한 실행과 같은 모양으로 돌려준다', async () => {
  setup({ grant: false });
  const result = await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });

  assert.equal(calls.exec.length, 0, '거부된 뒤에 실행하면 결정을 무시하는 것이다');
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'access_denied');
  // 호출부는 gitProcessSucceeded(result) 로 판정한다 — ok:false 면 그대로 실패로 읽힌다.
  assert.ok(result.stderr, '왜 실패했는지 남긴다');
  assert.ok(!result.stderr.includes('permission.denied'));
  assert.equal(state.error, result.stderr, '힌트바 토스트로도 알린다');
});

test('거부된 권한으로 다시 두드리지 않는다', async () => {
  setup({ grant: false });
  await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });
  await perms.execGit({ program: 'git', args: ['log'], cwd: 'C:/repo' });
  assert.equal(calls.request.length, 1, '결정은 한 번만 묻는다');
  assert.equal(calls.exec.length, 0);
});

test('denied 상태는 요청조차 하지 않는다', async () => {
  setup({ state: 'denied' });
  const result = await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });
  assert.equal(calls.request.length, 0, '저장된 거부는 팝업을 다시 열 수 없다');
  assert.equal(calls.exec.length, 0);
  assert.equal(result.error_code, 'access_denied');
});

test('permissions 를 모르는 호스트에서는 그대로 실행한다', async () => {
  setup({ permissionsApi: false });
  const result = await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });
  assert.equal(calls.exec.length, 1);
  assert.equal(result.ok, true);
});

test('경로 없는 권한에는 path 를 붙이지 않는다', async () => {
  setup();
  await perms.clipboardWrite('abc', 'permission.reason.clipboardWrite', 'permission.denied.clipboardWrite');
  assert.equal(calls.query[0].permission, 'clipboard_write');
  assert.ok(!('path' in calls.query[0]), 'clipboard 에 path 를 넘기면 invalid_params 다');
  assert.ok(!('path' in calls.request[0]));
  assert.deepEqual(calls.clipboard, ['abc']);
});

test('클립보드 읽기 거부는 "클립보드가 비었다" 와 구분된다', async () => {
  setup({ grant: false });
  const result = await perms.clipboardRead('permission.reason.clipboardRead', 'permission.denied.clipboardRead');
  assert.equal(result.error_code, 'access_denied');
  assert.ok(!result.text, '붙여 넣을 것이 없다');
  // 호출부는 이 표시를 보고 "클립보드에 패치가 없다" 같은 안내를 겹쳐 띄우지 않는다.
});

test('권한이 도중에 회수되면 다음 호출이 다시 확인한다', async () => {
  setup({ state: 'granted' });
  await perms.execGit({ program: 'git', args: ['status'], cwd: 'C:/repo' });
  assert.equal(calls.query.length, 1);

  // 호스트가 access_denied 로 돌려주는 순간 캐시된 승인은 더 이상 사실이 아니다.
  global.hecaton.process.exec = async () => ({ ok: false, error_code: 'access_denied' });
  await perms.execGit({ program: 'git', args: ['log'], cwd: 'C:/repo' });
  await perms.execGit({ program: 'git', args: ['diff'], cwd: 'C:/repo' });
  assert.equal(calls.query.length, 2, '회수된 뒤에는 상태를 다시 묻는다');

  global.hecaton.process.exec = async (params) => { calls.exec.push(params); return { ok: true, exit_code: 0, stdout: 'out' }; };
});

// plugin.json 의 기본 설명은 호스트 자동 프롬프트(우리가 request 를 걸지 않는 fs_read 등)가
// 읽는 유일한 목적 문구다. 키가 표준 ID 가 아니면 매니페스트 전체가 거부된다.
test('plugin.json 이 쓰는 권한마다 기본 설명을 선언한다', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf-8'));
  const descriptions = manifest.permission_usage_descriptions;
  assert.ok(descriptions, 'permission_usage_descriptions 가 없으면 목적란이 빈 채로 뜬다');

  const CANONICAL = new Set(['terminal_input', 'clipboard_write', 'clipboard_read', 'fs_read', 'fs_write',
    'fs_delete', 'fs_rename', 'process_exec', 'open_tab', 'list_plugins', 'network_serve', 'notification',
    'terminal_list', 'cross_terminal', 'terminal_status']);
  // 실제로 쓰는 권한 — 선언이 빠지면 그 팝업만 목적 없이 뜬다.
  for (const permission of ['process_exec', 'fs_read', 'fs_write', 'clipboard_read', 'clipboard_write', 'open_tab']) {
    assert.ok(descriptions[permission], permission + ' 설명이 없다');
  }
  for (const [permission, text] of Object.entries(descriptions)) {
    assert.ok(CANONICAL.has(permission), '표준 권한 ID 가 아니다: ' + permission);
    assert.ok(text.en && text.ko, permission + ' 에 en/ko 가 모두 있어야 한다');
    for (const value of Object.values(text)) {
      assert.ok(value.trim(), permission + ' 설명이 공백뿐이다');
      assert.ok(Buffer.byteLength(value, 'utf-8') <= 2048, permission + ' 설명이 2048바이트를 넘는다');
      assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), permission + ' 설명에 제어 문자가 있다');
    }
  }

  // 1.15 미만을 선언하면 이 필드를 쓸 수 없다.
  const [major, minor] = manifest.apiVersion.split('.').map(Number);
  assert.ok(major > 1 || minor >= 15, 'permission_usage_descriptions 는 API 1.15 필드다');
});

test('권한 문구는 두 로케일에 모두 있다', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locale', name), 'utf-8'));
  const en = read('en.json');
  const ko = read('ko.json');
  const used = new Set();
  for (const file of ['permissions.js', 'context-menu.js', 'input.js', 'reap.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf-8');
    for (const m of source.matchAll(/'(permission\.(?:reason|denied)\.\w+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 6, '권한 문구를 쓰는 곳을 못 찾았다');
  for (const key of used) {
    assert.ok(en[key], 'en.json 에 ' + key + ' 가 없다');
    assert.ok(ko[key], 'ko.json 에 ' + key + ' 가 없다');
    assert.notEqual(en[key], ko[key], key + ' 가 번역되지 않았다');
  }
});
