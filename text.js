function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) ||
    cp === 0x2329 || cp === 0x232A ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3040 && cp <= 0x33BF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xAC00 && cp <= 0xD7AF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE19) ||
    (cp >= 0xFE30 && cp <= 0xFE6F) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x20000 && cp <= 0x3134F);
}

function visLen(text) {
  const plain = stripAnsi(text);
  let w = 0;
  for (const ch of plain) {
    w += isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return w;
}

function padRight(text, width) {
  const pad = Math.max(0, width - visLen(text));
  return text + ' '.repeat(pad);
}

// 탭 들여쓰기 폭. 터미널 기본 tab stop은 8이지만 side-by-side diff는 한 칸이 좁아
// 4가 실용적이다 — 여기만 바꾸면 모든 diff 뷰에 함께 적용된다.
const TAB_WIDTH = 4;

// 탭을 다음 tab stop까지의 공백으로 바꾼다.
//
// 터미널에서 탭은 "공백 출력"이 아니라 "커서 이동"이라 지나간 칸의 이전 내용이 그대로
// 남는다. 게다가 visLen/sliceByWidth는 탭을 1칸으로 세므로, 확장하지 않으면 계산 폭과
// 실제 그려지는 폭이 어긋나 diff 셀이 옆 칸을 침범하고 앞 프레임 잔상이 겹쳐 보인다.
// (탭 들여쓰기를 쓰는 파일의 diff에서 줄이 깨져 보이던 원인)
//
// ANSI 시퀀스가 섞이지 않은 raw 텍스트에만 쓴다 — 색이 붙은 뒤에는 열 계산이 어긋난다.
function expandTabs(text, tabWidth) {
  if (typeof text !== 'string' || text.indexOf('\t') === -1) return text;
  const w = tabWidth || TAB_WIDTH;
  let out = '';
  let col = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const fill = w - (col % w);
      out += ' '.repeat(fill);
      col += fill;
    } else {
      out += ch;
      col += isWide(ch.codePointAt(0)) ? 2 : 1;
    }
  }
  return out;
}

function truncate(text, maxLen) {
  if (visLen(text) <= maxLen) return text;
  // Walk through text, counting visible width
  let vis = 0;
  let i = 0;
  while (i < text.length && vis < maxLen - 1) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i);
      if (end !== -1) { i = end + 1; continue; }
    }
    const cp = text.codePointAt(i);
    const cw = isWide(cp) ? 2 : 1;
    if (vis + cw > maxLen - 1) break;
    vis += cw;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return text.substring(0, i) + '\u2026';
}

function viewport(text, cursorPos, maxWidth) {
  cursorPos = Math.max(0, Math.min(cursorPos, text.length));
  const before = text.substring(0, cursorPos);
  const after = text.substring(cursorPos);
  const beforeVis = visLen(before);
  const afterVis = visLen(after);
  const totalVis = beforeVis + 1 + afterVis; // +1 for cursor block

  if (totalVis <= maxWidth) {
    return before + '\u2588' + after;
  }

  const hasLeft = beforeVis > 0;
  const hasRight = afterVis > 0;

  // Reserve 1 col for each ellipsis indicator
  const leftEllipsis = hasLeft ? 1 : 0;
  const rightEllipsis = hasRight ? 1 : 0;
  const contentWidth = maxWidth - leftEllipsis - rightEllipsis;

  // Scroll so cursor stays visible within content area
  const scrollOff = Math.max(0, beforeVis + 1 - contentWidth);

  // Build combined string with cursor character inserted
  const combined = before + '\u2588' + after;

  // Skip scrollOff visual columns from the left
  let vis = 0;
  let i = 0;
  while (i < combined.length && vis < scrollOff) {
    const cp = combined.codePointAt(i);
    const cw = isWide(cp) ? 2 : 1;
    if (vis + cw > scrollOff) break;
    vis += cw;
    i += cp > 0xFFFF ? 2 : 1;
  }

  // Collect up to contentWidth visual columns
  const startI = i;
  let displayVis = 0;
  while (i < combined.length && displayVis < contentWidth) {
    const cp = combined.codePointAt(i);
    const cw = isWide(cp) ? 2 : 1;
    if (displayVis + cw > contentWidth) break;
    displayVis += cw;
    i += cp > 0xFFFF ? 2 : 1;
  }

  const showLeftEllipsis = vis > 0;
  const showRightEllipsis = i < combined.length;

  return (showLeftEllipsis ? '\u2026' : '') + combined.substring(startI, i) + (showRightEllipsis ? '\u2026' : '');
}

function sliceByWidth(text, startCol, maxWidth) {
  const plain = stripAnsi(text);
  let vis = 0, i = 0;
  // Skip startCol visual columns
  while (i < plain.length && vis < startCol) {
    const cp = plain.codePointAt(i);
    const cw = isWide(cp) ? 2 : 1;
    if (vis + cw > startCol) break;
    vis += cw;
    i += cp > 0xFFFF ? 2 : 1;
  }
  // Collect up to maxWidth visual columns
  const begin = i;
  let w = 0;
  while (i < plain.length && w < maxWidth) {
    const cp = plain.codePointAt(i);
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > maxWidth) break;
    w += cw;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return plain.substring(begin, i);
}

// ── git diff 파일 헤더 ──
// git은 파일마다 `diff --git a/x b/x` / `index <blob>..<blob> <mode>` / `--- a/x` /
// `+++ b/x` 네 줄을 앞에 붙인다. 여기서 a/ b/ 는 실제 경로가 아니라 "변경 전/후"를
// 가리키는 git의 관례적 접두사이고(diff.srcPrefix/dstPrefix 기본값), 패치를 어디서
// 적용하든 -p1 로 떼어 내라는 뜻이다. 화면에 그대로 내보내면 없는 경로처럼 보이는 데다
// 파일명은 파일 목록·상세 헤더가 이미 보여 주고 blob 해시는 이 UI에서 쓸 데가 없다.
//
// 걷어내는 건 화면뿐이다. state.diffLines 원본은 손대지 않는다 — hunk 단위 스테이징이
// 이 헤더로 적용 가능한 패치를 만든다(git.js buildHunkPatchText).
// new file / deleted file / rename / similarity / Binary 처럼 정보가 있는 줄은 남긴다.
function isDiffFileHeaderLine(line) {
  return line.startsWith('diff --git ') || line.startsWith('index ') ||
    line.startsWith('--- ') || line.startsWith('+++ ');
}

// 위 판정을 diff 텍스트 전체에 적용한다. hunk 본문(@@ 이후)에서는 걸러내지 않는데,
// '--'로 시작하는 줄을 지운 diff 줄이 '--- ...' 로 보여 파일 헤더와 구분되지 않기
// 때문이다. 위치로 갈라야 본문을 잃지 않는다.
function stripDiffFileHeaders(lines) {
  const out = [];
  let inHunk = false;
  for (const raw of lines) {
    const line = raw.replace(/[\r\n]/g, '');
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; out.push(raw); continue; }
    if (!inHunk && isDiffFileHeaderLine(line)) continue;
    out.push(raw);
  }
  return out;
}

module.exports = { stripAnsi, isWide, visLen, padRight, truncate, viewport, sliceByWidth, expandTabs, TAB_WIDTH, isDiffFileHeaderLine, stripDiffFileHeaders };
