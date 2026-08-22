const SIXEL_ENABLED = true;
const SIXEL_PALETTE = [
  [224, 108, 118],
  [152, 195, 121],
  [229, 192, 123],
  [97,  175, 239],
  [198, 120, 221],
  [86,  182, 194],
  [80,  80,  80],
  [50,  50,  50],
  [160, 160, 160],
  [64,  64,  64],   // 포커스 없는 선택 줄 — ansi.js 의 cursorBgInactive 와 같은 값
];

function pxSet(buf, w, h, x, y, c) { if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = c; }

// 점선 위상은 버퍼 절대 좌표로 잡는다. 셀마다 패턴을 새로 시작하면 행 경계에서
// 위상이 어긋나 이어진 선이 들쭉날쭉해 보인다. dash 가 0 이면 실선.
function dashSkip(dash, pos) {
  if (!dash) return false;
  const period = dash * 2;
  return (((pos % period) + period) % period) >= dash;
}

function pxVLine(buf, w, h, x, y0, y1, c, t, dash) {
  const half = t >> 1;
  for (let y = y0; y <= y1; y++) {
    if (dashSkip(dash, y)) continue;
    for (let dx = -half; dx < t - half; dx++) pxSet(buf, w, h, x + dx, y, c);
  }
}

function pxHLine(buf, w, h, x0, x1, y, c, t, dash) {
  const half = t >> 1;
  for (let x = x0; x <= x1; x++) {
    if (dashSkip(dash, x)) continue;
    for (let dy = -half; dy < t - half; dy++) pxSet(buf, w, h, x, y + dy, c);
  }
}

function pxCircle(buf, w, h, cx, cy, r, c) {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r2) pxSet(buf, w, h, cx + dx, cy + dy, c);
}

function pxRing(buf, w, h, cx, cy, rOuter, rInner, c) {
  const radius = Math.max(1, Math.floor((rOuter + rInner) / 2));
  const thickness = Math.max(1, rOuter - rInner);
  const steps = Math.max(12, radius * 10);
  for (let i = 0; i < steps; i++) {
    const theta = (Math.PI * 2 * i) / steps;
    const x = Math.round(cx + Math.cos(theta) * radius);
    const y = Math.round(cy + Math.sin(theta) * radius);
    // floor(t/2) 를 양쪽에 쓰면 두께 2와 3이 똑같이 3px 로 그려져 가는 링을 만들 수 없다.
    const lead = Math.floor((thickness - 1) / 2);
    for (let dx = -lead; dx <= thickness - 1 - lead; dx++) {
      for (let dy = -lead; dy <= thickness - 1 - lead; dy++) {
        pxSet(buf, w, h, x + dx, y + dy, c);
      }
    }
  }
}

function pxBezier(buf, w, h, x0, y0, x1, y1, x2, y2, c, t, dash) {
  const half = t >> 1;
  // 제어점 둘레는 호 길이의 상한이다. 가는 선(t=1)은 걸음이 1px 를 넘으면 곡선에
  // 구멍이 생기므로 걸음 수를 그 길이에 맞춘다.
  const steps = Math.max(20,
    Math.abs(x1 - x0) + Math.abs(y1 - y0) + Math.abs(x2 - x1) + Math.abs(y2 - y1));
  let prevX = null;
  let prevY = null;
  let travelled = 0;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const ms = 1 - s;
    const px = Math.round(ms * ms * x0 + 2 * ms * s * x1 + s * s * x2);
    const py = Math.round(ms * ms * y0 + 2 * ms * s * y1 + s * s * y2);
    if (prevX !== null) travelled += Math.hypot(px - prevX, py - prevY);
    prevX = px;
    prevY = py;
    // 곡선은 좌표축이 아니라 지나온 거리로 점선을 끊는다.
    if (dashSkip(dash, Math.round(travelled))) continue;
    for (let bx = -half; bx < t - half; bx++)
      for (let by = -half; by < t - half; by++)
        pxSet(buf, w, h, px + bx, py + by, c);
  }
}

// 이웃 셀이 이 셀 쪽으로 수평 획을 뻗는가? (수평 병합선 관통 여부 판정용)
function connectsRight(ch) { // 오른쪽 가장자리까지 획이 닿는 글자
  return ch === '─' || ch === '┄' || ch === '┼' || ch === '╌' ||
         ch === '├' || ch === '╭' || ch === '╰' || ch === '●' || ch === '◌';
}
function connectsLeft(ch) { // 왼쪽 가장자리까지 획이 닿는 글자
  return ch === '─' || ch === '┄' || ch === '┼' || ch === '╌' ||
         ch === '┤' || ch === '╮' || ch === '╯' || ch === '●' || ch === '◌';
}
// 위/아래 이웃 행이 이 셀 쪽으로 세로 획을 뻗는가? "빈 칸이 아니다"로 판정하면
// 수평 병합선(─ ╭ ╮ ╯ ╰)만 지나간 칸도 이어진 것으로 봐서, 빈 레인을 재사용한
// 커밋 노드에 붙을 데 없는 꼬다리가 생긴다.
function connectsDown(ch) { // 아래 가장자리까지 획이 닿는 글자
  return ch === '│' || ch === '┆' || ch === '┼' || ch === '╌' ||
         ch === '├' || ch === '┤' || ch === '╭' || ch === '╮' ||
         ch === '●' || ch === '◌';
}
function connectsUp(ch) { // 위 가장자리까지 획이 닿는 글자
  return ch === '│' || ch === '┆' || ch === '┼' || ch === '╌' ||
         ch === '├' || ch === '┤' || ch === '╯' || ch === '╰' ||
         ch === '●' || ch === '◌';
}

function renderGraphRowInto(buf, pw, ph, yOff, chars, charColors, charColorsH, charStyles, charStylesH, numCols, prevChars, nextChars, cellW, cellH, lineW, dotR, thinW, dashLen) {
  for (let i = 0; i < chars.length && i < numCols; i++) {
    const ch = chars[i];
    const cc = charColors[i];
    if (cc < 0 || ch === ' ') continue;
    const style = charStyles && i < charStyles.length ? charStyles[i] : 0;
    const c = style === 1 ? 9 : (cc % 6) + 1;
    // 수평 획 전용 색. -1이면 세로색(cc)과 동일. 교차/T 지점에서 수평(병합)선이
    // 세로 레인색에 묻히지 않고 제 색을 유지하도록 분리해 칠한다.
    const cch = charColorsH && i < charColorsH.length ? charColorsH[i] : -1;
    // 스타일도 같은 이유로 갈라진다. 리커버리 합류선이 살아있는 레인을 관통할 때
    // 세로획까지 회색으로 물들면 그 브랜치가 죽은 것처럼 보인다.
    const csh = charStylesH && i < charStylesH.length ? charStylesH[i] : -1;
    const hStyle = csh >= 0 ? csh : style;
    const hc = hStyle === 1 ? 9 : ((cch >= 0 ? cch : cc) % 6) + 1;
    // 리커버리 획은 가늘고 끊어진 선으로. 색만 회색이면 굵기가 같아 살아있는 레인과
    // 같은 무게로 읽힌다 — 유실 가지가 많은 저장소에서 실제 트리가 묻힌다.
    const lw = style === 1 ? thinW : lineW;
    const dash = style === 1 ? dashLen : 0;
    const hlw = hStyle === 1 ? thinW : lineW;
    const hdash = hStyle === 1 ? dashLen : 0;
    // 코너(╭╮╯╰)가 수평 병합선 중간에 놓이면 관통선이 한쪽만 이어져 끊어져 보인다.
    // 좌우 이웃이 모두 이 셀 쪽으로 수평 획을 뻗으면 병합선이 관통하는 것이므로,
    // 코너 곡선에 더해 수평 브리지를 그려 선을 이어준다.
    const leftCh = i > 0 ? chars[i - 1] : ' ';
    const rightCh = (i + 1 < chars.length && i + 1 < numCols) ? chars[i + 1] : ' ';
    const bridgeH = connectsRight(leftCh) && connectsLeft(rightCh);
    const cx = i * cellW + (cellW >> 1);
    const cy = yOff + (cellH >> 1);
    const top = yOff;
    const bot = yOff + cellH - 1;
    const left = i * cellW;
    const right = (i + 1) * cellW - 1;

    switch (ch) {
      case '\u2502':
      case '\u2506':
        pxVLine(buf, pw, ph, cx, top, bot, c, lw, dash);
        break;
      case '\u25cf':
      case '\u25cc': {
        const hasAbove = prevChars && i < prevChars.length && connectsDown(prevChars[i]);
        const hasBelow = nextChars && i < nextChars.length && connectsUp(nextChars[i]);
        if (hasAbove) pxVLine(buf, pw, ph, cx, top, cy - dotR - 1, c, lw, dash);
        if (hasBelow) pxVLine(buf, pw, ph, cx, cy + dotR + 1, bot, c, lw, dash);
        // 링도 획 굵기를 따른다. 거의 꽉 찬 원으로 그리면 선만 가벼워지고 노드는
        // 살아있는 커밋만큼 무겁게 읽혀 대비가 흐려진다.
        if (ch === '\u25cc' || style === 1) pxRing(buf, pw, ph, cx, cy, dotR, Math.max(0, dotR - thinW), c);
        else pxCircle(buf, pw, ph, cx, cy, dotR, c);
        if (i > 0 && connectsRight(chars[i - 1]) && chars[i - 1] !== '\u25cf' && chars[i - 1] !== '\u25cc') {
          pxHLine(buf, pw, ph, left, cx - dotR - 1, cy, hc, hlw, hdash);
        }
        if (i + 1 < numCols && i + 1 < chars.length && connectsLeft(chars[i + 1]) && chars[i + 1] !== '\u25cf' && chars[i + 1] !== '\u25cc') {
          pxHLine(buf, pw, ph, cx + dotR + 1, right, cy, hc, hlw, hdash);
        }
        break;
      }
      // ├ ┤ 는 머지 대상 부모가 이미 살아있는 레인에 있을 때 생긴다. 부모는 항상
      // 아래쪽이므로 세로선은 그대로 두고, 옆으로 빠지는 연결선만 아래로 둥글게 말아
      // T자 접합 대신 Y자로 합류시킨다.
      case '\u251c':
        pxVLine(buf, pw, ph, cx, top, bot, c, lw, dash);
        pxBezier(buf, pw, ph, right + 1, cy, cx, cy, cx, bot, hc, hlw, hdash);
        break;
      case '\u2524':
        pxVLine(buf, pw, ph, cx, top, bot, c, lw, dash);
        pxBezier(buf, pw, ph, left - 1, cy, cx, cy, cx, bot, hc, hlw, hdash);
        break;
      case '\u256e':
        if (bridgeH) pxHLine(buf, pw, ph, left - 1, right + 1, cy, hc, hlw, hdash);
        pxBezier(buf, pw, ph, left - 1, cy, cx, cy, cx, bot, c, lw, dash);
        break;
      case '\u256d':
        if (bridgeH) pxHLine(buf, pw, ph, left - 1, right + 1, cy, hc, hlw, hdash);
        pxBezier(buf, pw, ph, right + 1, cy, cx, cy, cx, bot, c, lw, dash);
        break;
      case '\u256f':
        if (bridgeH) pxHLine(buf, pw, ph, left - 1, right + 1, cy, hc, hlw, hdash);
        pxBezier(buf, pw, ph, cx, top, cx, cy, left - 1, cy, c, lw, dash);
        break;
      case '\u2570':
        if (bridgeH) pxHLine(buf, pw, ph, left - 1, right + 1, cy, hc, hlw, hdash);
        pxBezier(buf, pw, ph, cx, top, cx, cy, right + 1, cy, c, lw, dash);
        break;
      case '\u2500':
      case '\u2504':
        pxHLine(buf, pw, ph, left - 1, right + 1, cy, c, lw, dash);
        break;
      case '\u253c':
      case '\u254c':
        pxVLine(buf, pw, ph, cx, top, bot, c, lw, dash);
        pxHLine(buf, pw, ph, left - 1, right + 1, cy, hc, hlw, hdash);
        break;
    }
  }
}

const BG_CURSOR = 7;
const BG_HOVER = 8;
const BG_CURSOR_INACTIVE = 10;

function renderCombinedGraphPixels(graphRows, numCols, cellW, cellH, prevBoundary, nextBoundary) {
  const pw = numCols * cellW;
  const ph = graphRows.length * cellH;
  if (pw <= 0 || ph <= 0) return null;
  const lineW = Math.max(1, Math.round(cellW * 0.25));
  const dotR = Math.max(2, Math.round(cellW * 0.375));
  // 리커버리 획: 한 단계 가늘게, 셀 높이의 1/6 길이로 끊어 그린다.
  const thinW = Math.max(1, lineW - 1);
  const dashLen = Math.max(2, Math.round(cellH / 6));
  const buf = new Uint8Array(pw * ph);
  for (let r = 0; r < graphRows.length; r++) {
    const row = graphRows[r];
    if (!row) continue;
    const bgIdx = row.isCursor ? BG_CURSOR
      : row.isCursorInactive ? BG_CURSOR_INACTIVE
      : row.isHover ? BG_HOVER : 0;
    if (bgIdx > 0) {
      const yStart = r * cellH;
      for (let y = yStart; y < yStart + cellH && y < ph; y++) {
        for (let x = 0; x < pw; x++) buf[y * pw + x] = bgIdx;
      }
    }
  }
  for (let r = 0; r < graphRows.length; r++) {
    const row = graphRows[r];
    if (!row) continue;
    const prev = r > 0
      ? (graphRows[r - 1] ? graphRows[r - 1].chars : null)
      : (prevBoundary ? prevBoundary.chars : null);
    const next = r < graphRows.length - 1
      ? (graphRows[r + 1] ? graphRows[r + 1].chars : null)
      : (nextBoundary ? nextBoundary.chars : null);
    renderGraphRowInto(buf, pw, ph, r * cellH, row.chars, row.charColors, row.charColorsH, row.charStyles, row.charStylesH, numCols, prev, next, cellW, cellH, lineW, dotR, thinW, dashLen);
  }
  return buf;
}

function encodeSixel(buf, w, h, palette) {
  let out = '\x1bP0;1;0q';
  out += '"1;1;' + w + ';' + h;
  // 팔레트 항목이 숫자면 호스트 예약 팔레트 인덱스를 그대로 참조하고 색을 정의하지
  // 않는다. RGB 를 적어 보내면 그 순간의 색이 박제돼 터미널 색 구성표를 따라가지
  // 못한다 — 밝은 구성표에서 스크롤바가 배경에 묻히던 원인이다.
  const slots = [];
  for (let i = 0; i < palette.length; i++) {
    const entry = palette[i];
    if (typeof entry === 'number') {
      slots.push(entry);
      continue;
    }
    const [r, g, b] = entry;
    out += '#' + (i + 1) + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255);
    slots.push(i + 1);
  }
  for (let bandY = 0; bandY < h; bandY += 6) {
    const bandH = Math.min(6, h - bandY);
    let bandHasData = false;
    for (let ci = 1; ci <= palette.length; ci++) {
      let row = '';
      let runChar = '';
      let runLen = 0;
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let dy = 0; dy < bandH; dy++) {
          const y = bandY + dy;
          if (buf[y * w + x] === ci) bits |= (1 << dy);
        }
        const ch = String.fromCharCode(63 + bits);
        if (ch === runChar) {
          runLen++;
        } else {
          if (runLen > 0) {
            if (runLen >= 4) row += '!' + runLen + runChar;
            else row += runChar.repeat(runLen);
          }
          runChar = ch;
          runLen = 1;
        }
      }
      if (runLen > 0) {
        if (runLen >= 4) row += '!' + runLen + runChar;
        else row += runChar.repeat(runLen);
      }
      if (row.replace(/[!0-9]/g, '').replace(/\?/g, '') === '') continue;
      bandHasData = true;
      out += '#' + slots[ci - 1] + row + '$';
    }
    if (bandHasData && out.endsWith('$')) out = out.slice(0, -1);
    out += '-';
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  out += '\x1b\\';
  return out;
}

function encodeSixelClear(w, h) {
  w = Math.max(0, Math.floor(w));
  h = Math.max(0, Math.floor(h));
  if (w <= 0 || h <= 0) return '';
  let out = '\x1bP0;0;0q';
  out += '"1;1;' + w + ';' + h;
  const emptyRow = w >= 4 ? '!' + w + '?' : '?'.repeat(w);
  for (let y = 0; y < h; y += 6) {
    if (y > 0) out += '-';
    out += emptyRow;
  }
  out += '\x1b\\';
  return out;
}

// 호스트 예약 팔레트 인덱스(hecaton SIXEL_PALETTE_UI_*). 터미널 전경색을 각각
// 40% / 80% / 100% 알파로 쓴다. 색을 옮기지 않고 알파만 올리므로 밝은 구성표든
// 어두운 구성표든 상호작용할수록 배경에서 멀어진다.
const SCROLLBAR_PALETTE = [16];
const SCROLLBAR_HOVER_PALETTE = [17];
const SCROLLBAR_ACTIVE_PALETTE = [18];

function renderScrollbarPixels(cellW, cellH, viewportRows, scrollOffset, maxScroll) {
  if (maxScroll <= 0) return null;
  const w = cellW;
  const trackH = viewportRows * cellH;
  if (w <= 0 || trackH <= 0) return null;
  const totalItems = viewportRows + maxScroll;
  const handleH = Math.max(cellH, Math.floor(trackH * viewportRows / totalItems));
  const handleY = Math.floor((trackH - handleH) * scrollOffset / maxScroll);
  const buf = new Uint8Array(w * trackH);
  const padX = 2;
  const roundY = 1;
  for (let y = handleY; y < handleY + handleH && y < trackH; y++) {
    const dy = y - handleY;
    const dyEnd = handleY + handleH - 1 - y;
    for (let x = padX; x < w - padX; x++) {
      if (dy < roundY && (x === padX || x === w - padX - 1)) continue;
      if (dyEnd < roundY && (x === padX || x === w - padX - 1)) continue;
      buf[y * w + x] = 1;
    }
  }
  return buf;
}

function renderHScrollbarPixels(cW, cH, trackCols, viewportCols, offset, maxScrollX) {
  if (maxScrollX <= 0) return null;
  const w = trackCols * cW;
  const h = cH;
  if (w <= 0 || h <= 0) return null;
  const totalContent = viewportCols + maxScrollX;
  const handleW = Math.max(cW, Math.floor(w * viewportCols / totalContent));
  const handleX = Math.floor((w - handleW) * offset / maxScrollX);
  const buf = new Uint8Array(w * h);
  const barThickness = Math.max(1, cW - 4);
  const padY = Math.max(0, Math.floor((h - barThickness) / 2));
  const roundX = 1;
  for (let x = handleX; x < handleX + handleW && x < w; x++) {
    const dx = x - handleX;
    const dxEnd = handleX + handleW - 1 - x;
    for (let y = padY; y < h - padY; y++) {
      if (dx < roundX && (y === padY || y === h - padY - 1)) continue;
      if (dxEnd < roundX && (y === padY || y === h - padY - 1)) continue;
      buf[y * w + x] = 1;
    }
  }
  return buf;
}

module.exports = {
  SIXEL_ENABLED,
  SIXEL_PALETTE,
  SCROLLBAR_PALETTE, SCROLLBAR_HOVER_PALETTE, SCROLLBAR_ACTIVE_PALETTE,
  renderScrollbarPixels, renderHScrollbarPixels,
  renderCombinedGraphPixels, encodeSixel, encodeSixelClear,
};
