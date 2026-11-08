// 스크롤 한 칸의 렌더 비용이 diff 길이에 비례하지 않아야 한다.
//
// 호스트가 스크롤 위치를 먼저 옮기고 플러그인은 scroll.update 마다 다시 그린다. 프레임이
// 느리면 스크롤바는 즉시 움직이는데 내용은 한참 뒤에 따라온다. 그래서:
//   1. diff 패널은 화면에 걸리는 줄만 하이라이트한다 (side-by-side 도 마찬가지).
//   2. 패치 파싱 결과는 diffLines 가 바뀌기 전까지 재사용한다.
//   3. 그래프 sixel 인코더는 색마다 밴드를 다시 훑지 않는다 — 출력은 예전과 같아야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');
global.hecaton = {
  fs: {}, process: {}, terminal: {}, window: { set_title: async () => ({}) },
  initialState: { cols: 160, rows: 40 }, on: () => {},
};
// render.js 가 require 시점에 구조 분해하므로 그 전에 감싼다.
const highlighter = require('../highlighter');
let highlightCalls = 0;
const realHighlight = highlighter.highlightCode;
highlighter.highlightCode = (...args) => { highlightCalls++; return realHighlight(...args); };
const { state, ui } = require('../state');
const { render } = require('../render');
const { encodeSixel, SIXEL_PALETTE, SCROLLBAR_PALETTE } = require('../sixel');
const { stripAnsi } = require('../text');

function counted(lines) {
  let reads = 0;
  return {
    source: new Proxy(lines, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } }),
    reads: () => reads,
  };
}

function setup(lines, diffView) {
  Object.assign(state, {
    loading: false, isGitRepo: true, gitNotFound: false, minimized: false,
    branch: 'main', branches: [{ name: 'main', isCurrent: true }],
    worktrees: [{ path: 'repo', branch: 'main', isMain: true, isCurrent: true }],
    sideDiffWrap: false,
    rightView: 'diff', diffView, unstaged: [{ status: 'M', file: 'x.js' }], staged: [], untracked: [],
    cursor: 0, currentDiffFile: 'x.js', diffLines: lines, diffScrollOffset: 0, diffScrollX: 0,
  });
  ui.termCols = 160; ui.termRows = 40;
}

function frame() {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = s => { output += s; return true; };
  try { render(); } finally { process.stdout.write = write; }
  return output;
}

function bigPatch() {
  const lines = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1,3000 +1,3000 @@'];
  for (let i = 0; i < 3000; i++) {
    lines.push('-const old' + i + ' = compute(' + i + ');');
    lines.push('+const value' + i + ' = compute(' + i + ', "text");');
  }
  return lines;
}

for (const diffView of ['side', 'unified']) {
  test(`${diffView} diff 스크롤은 보이는 줄만 하이라이트하고 패치를 다시 훑지 않는다`, () => {
    const input = counted(bigPatch());
    setup(input.source, diffView);
    frame();
    const firstFrame = frame();
    assert.ok(ui.diffMaxScroll > 1000, '스크롤할 만큼 길어야 검증이 된다');
    assert.match(stripAnsi(firstFrame), /value1 /);
    const readsAfterLayout = input.reads();
    for (let i = 1; i <= 10; i++) {
      state.diffScrollOffset = 500 + i * 3;
      highlightCalls = 0;
      frame();
      assert.ok(highlightCalls <= ui.termRows * 3,
        `프레임당 하이라이트 ${highlightCalls}회 — 화면 높이(${ui.termRows})에 묶여야 한다`);
    }
    assert.equal(input.reads(), readsAfterLayout, '같은 패치면 파싱 결과를 재사용한다');
    // 스크롤한 자리의 내용이 실제로 그려진다. side-by-side 는 -/+ 를 한 행에 짝지으므로
    // 같은 행 번호라도 가리키는 줄이 다르다.
    state.diffScrollOffset = 1200;
    assert.match(stripAnsi(frame()), diffView === 'side' ? /old1197 = compute/ : /value599 = compute/);
  });
}

test('새 패치가 오면 레이아웃을 다시 만든다', () => {
  setup(bigPatch(), 'side');
  frame();
  state.diffLines = ['diff --git a/x.js b/x.js', '@@ -1 +1 @@', '-before', '+after only'];
  state.diffScrollOffset = 0;
  const out = frame();
  assert.match(stripAnsi(out), /after only/);
  assert.equal(ui.diffMaxScroll, 0);
});

// 예전 인코더 그대로 — 바이트 단위로 같은 출력을 내야 한다.
function referenceEncodeSixel(buf, w, h, palette) {
  let out = '\x1bP0;1;0q' + '"1;1;' + w + ';' + h;
  const slots = [];
  for (let i = 0; i < palette.length; i++) {
    const entry = palette[i];
    if (typeof entry === 'number') { slots.push(entry); continue; }
    const [r, g, b] = entry;
    out += '#' + (i + 1) + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255);
    slots.push(i + 1);
  }
  for (let bandY = 0; bandY < h; bandY += 6) {
    const bandH = Math.min(6, h - bandY);
    let bandHasData = false;
    for (let ci = 1; ci <= palette.length; ci++) {
      let row = '', runChar = '', runLen = 0;
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let dy = 0; dy < bandH; dy++) if (buf[(bandY + dy) * w + x] === ci) bits |= (1 << dy);
        const ch = String.fromCharCode(63 + bits);
        if (ch === runChar) { runLen++; continue; }
        if (runLen > 0) row += runLen >= 4 ? '!' + runLen + runChar : runChar.repeat(runLen);
        runChar = ch; runLen = 1;
      }
      if (runLen > 0) row += runLen >= 4 ? '!' + runLen + runChar : runChar.repeat(runLen);
      if (row.replace(/[!0-9]/g, '').replace(/\?/g, '') === '') continue;
      bandHasData = true;
      out += '#' + slots[ci - 1] + row + '$';
    }
    if (bandHasData && out.endsWith('$')) out = out.slice(0, -1);
    out += '-';
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out + '\x1b\\';
}

test('encodeSixel 은 예전 인코더와 같은 바이트를 낸다', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 500; t++) {
    const w = 1 + Math.floor(rand() * 40), h = 1 + Math.floor(rand() * 40);
    const buf = new Uint8Array(w * h);
    const density = rand();
    // 팔레트 밖 값(> palette.length)도 섞는다 — 둘 다 무시해야 한다.
    for (let i = 0; i < buf.length; i++) if (rand() < density) buf[i] = Math.floor(rand() * 15);
    const palette = t % 2 ? SIXEL_PALETTE : SCROLLBAR_PALETTE;
    assert.equal(encodeSixel(buf, w, h, palette), referenceEncodeSixel(buf, w, h, palette), `w=${w} h=${h}`);
  }
});
