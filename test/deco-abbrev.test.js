const test = require('node:test');
const assert = require('node:assert/strict');

global.hecaton = { fs: {}, process: {}, window: {}, initialState: {} };

const { state, ui } = require('../state');
const { buildDecoTokens, decoPlainText } = require('../render');

function abbrev(deco) {
  return decoPlainText(buildDecoTokens(deco));
}

function setRepo({ remotes = [], branches = [], current = '' } = {}) {
  state.remotes = remotes;
  state.branch = current;
  state.branches = branches.map(name => ({ name, isCurrent: name === current }));
  ui.pinnedBranches = [];
}

test('history branches are ordered current, pinned, then remaining alphabetically', () => {
  setRepo({
    remotes: ['origin'],
    branches: ['z-current', 'release', 'develop', 'charlie', 'alpha'],
    current: 'z-current',
  });
  ui.pinnedBranches = ['release', 'develop'];

  assert.equal(
    abbrev('charlie, develop, alpha, z-current, release'),
    'z-current, release, develop, alpha, charlie'
  );
});

test('history branch ordering keeps non-branch decorations in their original slots', () => {
  setRepo({ branches: ['main', 'pinned', 'alpha'], current: 'main' });
  ui.pinnedBranches = ['pinned'];

  assert.equal(
    abbrev('alpha, tag: v1.0, pinned, refs/stash, main'),
    'main, tag: v1.0, pinned, refs/stash, alpha'
  );
});

test('history ordering uses the local branch priority for remote decorations', () => {
  setRepo({
    remotes: ['origin'],
    branches: ['main', 'develop', 'alpha'],
    current: 'main',
  });
  ui.pinnedBranches = ['develop'];

  assert.equal(
    abbrev('origin/alpha, origin/develop, main, origin/main'),
    'main@origin, origin/develop, origin/alpha'
  );
});

test('로컬 브랜치와 동명의 리모트 추적 브랜치를 접미로 축약한다', () => {
  setRepo({ remotes: ['origin'], branches: ['main'] });
  assert.equal(abbrev('main, origin/main'), 'main@origin');
});

test('리모트 여러 개가 같은 커밋을 가리키면 모두 접미에 모은다', () => {
  setRepo({ remotes: ['origin', 'upstream'], branches: ['main'] });
  assert.equal(abbrev('main, origin/main, upstream/main'), 'main@origin,upstream');
});

test('푸시되지 않은 로컬 브랜치는 접미가 붙지 않는다', () => {
  setRepo({ remotes: ['origin'], branches: ['main', 'wip'] });
  assert.equal(abbrev('wip'), 'wip');
});

test('로컬에 짝이 없는 리모트 ref는 원래 표기를 유지한다', () => {
  setRepo({ remotes: ['origin'], branches: ['main'] });
  assert.equal(abbrev('origin/feat-x'), 'origin/feat-x');
});

test('슬래시가 들어간 브랜치도 짝을 찾아 축약한다', () => {
  setRepo({ remotes: ['origin'], branches: ['feature/login'] });
  assert.equal(abbrev('feature/login, origin/feature/login'), 'feature/login@origin');
});

test('슬래시 포함 로컬 브랜치를 리모트로 오인하지 않는다', () => {
  setRepo({ remotes: ['origin'], branches: ['feature/login'] });
  const tokens = buildDecoTokens('feature/login');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].kind, 'local');
});

test('HEAD, 태그, stash, recovery 토큰은 축약 대상이 아니다', () => {
  setRepo({ remotes: ['origin'], branches: ['main'] });
  assert.equal(
    abbrev('HEAD, tag: v1.0, main, origin/main, refs/stash, recovery'),
    'HEAD, tag: v1.0, main@origin, refs/stash, recovery'
  );
});

test('origin/HEAD 는 표기에서 제외된다', () => {
  setRepo({ remotes: ['origin'], branches: ['main'] });
  assert.equal(abbrev('main, origin/main, origin/HEAD'), 'main@origin');
});

test('리모트명이 겹치면 더 긴 쪽으로 분리한다', () => {
  setRepo({ remotes: ['origin', 'origin/mirror'], branches: ['main'] });
  assert.equal(abbrev('main, origin/mirror/main'), 'main@origin/mirror');
});

test('remotes 목록이 비어 있으면 첫 슬래시 기준으로 추정한다', () => {
  setRepo({ remotes: [], branches: ['main'] });
  assert.equal(abbrev('main, origin/main'), 'main@origin');
});

test('remotes 목록이 비어 있어도 로컬 브랜치명과 일치하면 로컬로 본다', () => {
  setRepo({ remotes: [], branches: ['feature/login'] });
  const tokens = buildDecoTokens('feature/login');
  assert.equal(tokens[0].kind, 'local');
});

test('deco가 비면 빈 문자열을 돌려준다', () => {
  setRepo({ remotes: ['origin'], branches: ['main'] });
  assert.equal(abbrev(''), '');
});
