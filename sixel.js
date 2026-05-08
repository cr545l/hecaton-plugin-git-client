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
];

function pxSet(buf, w, h, x, y, c) { if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = c; }

function pxVLine(buf, w, h, x, y0, y1, c, t) {
  const half = t >> 1;
  for (let dx = -half; dx < t - half; dx++)
    for (let y = y0; y <= y1; y++) pxSet(buf, w, h, x + dx, y, c);
}

function pxHLine(buf, w, h, x0, x1, y, c, t) {
  const half = t >> 1;
  for (let dy = -half; dy < t - half; dy++)
    for (let x = x0; x <= x1; x++) pxSet(buf, w, h, x, y + dy, c);
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
    for (let dx = -Math.floor(thickness / 2); dx <= Math.floor(thickness / 2); dx++) {
      for (let dy = -Math.floor(thickness / 2); dy <= Math.floor(thickness / 2); dy++) {
        pxSet(buf, w, h, x + dx, y + dy, c);
      }
    }
  }
}

function pxBezier(buf, w, h, x0, y0, x1, y1, x2, y2, c, t) {
  const half = t >> 1;
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const ms = 1 - s;
    const px = Math.round(ms * ms * x0 + 2 * ms * s * x1 + s * s * x2);
    const py = Math.round(ms * ms * y0 + 2 * ms * s * y1 + s * s * y2);
    for (let bx = -half; bx < t - half; bx++)
      for (let by = -half; by < t - half; by++)
        pxSet(buf, w, h, px + bx, py + by, c);
  }
}

function isConnectedChar(ch) {
  return ch && ch !== ' ';
}

function renderGraphRowInto(buf, pw, ph, yOff, chars, charColors, charStyles, numCols, prevChars, nextChars, cellW, cellH, lineW, dotR) {
  for (let i = 0; i < chars.length && i < numCols; i++) {
    const ch = chars[i];
    const cc = charColors[i];
    if (cc < 0 || ch === ' ') continue;
    const style = charStyles && i < charStyles.length ? charStyles[i] : 0;
    const c = style === 1 ? 9 : (cc % 6) + 1;
    const cx = i * cellW + (cellW >> 1);
    const cy = yOff + (cellH >> 1);
    const top = yOff;
    const bot = yOff + cellH - 1;
    const left = i * cellW;
    const right = (i + 1) * cellW - 1;

    switch (ch) {
      case '\u2502':
      case '\u2506':
        pxVLine(buf, pw, ph, cx, top, bot, c, lineW);
        break;
      case '\u25cf':
      case '\u25cc': {
        const hasAbove = prevChars && i < prevChars.length && isConnectedChar(prevChars[i]);
        const hasBelow = nextChars && i < nextChars.length && isConnectedChar(nextChars[i]);
        if (hasAbove) pxVLine(buf, pw, ph, cx, top, cy - dotR - 1, c, lineW);
        if (hasBelow) pxVLine(buf, pw, ph, cx, cy + dotR + 1, bot, c, lineW);
        if (ch === '\u25cc' || style === 1) pxRing(buf, pw, ph, cx, cy, dotR, Math.max(0, dotR - 3), c);
        else pxCircle(buf, pw, ph, cx, cy, dotR, c);
        if (i > 0 && isConnectedChar(chars[i - 1]) && chars[i - 1] !== '\u2502' && chars[i - 1] !== '\u2506' && chars[i - 1] !== '\u25cf' && chars[i - 1] !== '\u25cc') {
          pxHLine(buf, pw, ph, left, cx - dotR - 1, cy, c, lineW);
        }
        if (i + 1 < numCols && i + 1 < chars.length && isConnectedChar(chars[i + 1]) && chars[i + 1] !== '\u2502' && chars[i + 1] !== '\u2506' && chars[i + 1] !== '\u25cf' && chars[i + 1] !== '\u25cc') {
          pxHLine(buf, pw, ph, cx + dotR + 1, right, cy, c, lineW);
        }
        break;
      }
      case '\u251c':
        pxVLine(buf, pw, ph, cx, top, bot, c, lineW);
        pxHLine(buf, pw, ph, cx, right + 1, cy, c, lineW);
        break;
      case '\u2524':
        pxVLine(buf, pw, ph, cx, top, bot, c, lineW);
        pxHLine(buf, pw, ph, left - 1, cx, cy, c, lineW);
        break;
      case '\u256e':
        pxBezier(buf, pw, ph, left - 1, cy, cx, cy, cx, bot, c, lineW);
        break;
      case '\u256d':
        pxBezier(buf, pw, ph, right + 1, cy, cx, cy, cx, bot, c, lineW);
        break;
      case '\u256f':
        pxBezier(buf, pw, ph, cx, top, cx, cy, left - 1, cy, c, lineW);
        break;
      case '\u2570':
        pxBezier(buf, pw, ph, cx, top, cx, cy, right + 1, cy, c, lineW);
        break;
      case '\u2500':
      case '\u2504':
        pxHLine(buf, pw, ph, left - 1, right + 1, cy, c, lineW);
        break;
      case '\u253c':
      case '\u254c':
        pxVLine(buf, pw, ph, cx, top, bot, c, lineW);
        pxHLine(buf, pw, ph, left - 1, right + 1, cy, c, lineW);
        break;
    }
  }
}

const BG_CURSOR = 7;
const BG_HOVER = 8;

function renderCombinedGraphPixels(graphRows, numCols, cellW, cellH, prevBoundary, nextBoundary) {
  const pw = numCols * cellW;
  const ph = graphRows.length * cellH;
  if (pw <= 0 || ph <= 0) return null;
  const lineW = Math.max(1, Math.round(cellW * 0.25));
  const dotR = Math.max(2, Math.round(cellW * 0.375));
  const buf = new Uint8Array(pw * ph);
  for (let r = 0; r < graphRows.length; r++) {
    const row = graphRows[r];
    if (!row) continue;
    const bgIdx = row.isCursor ? BG_CURSOR : row.isHover ? BG_HOVER : 0;
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
    renderGraphRowInto(buf, pw, ph, r * cellH, row.chars, row.charColors, row.charStyles, numCols, prev, next, cellW, cellH, lineW, dotR);
  }
  return buf;
}

function encodeSixel(buf, w, h, palette) {
  let out = '\x1bP0;1;0q';
  out += '"1;1;' + w + ';' + h;
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = palette[i];
    out += '#' + (i + 1) + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255);
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
      out += '#' + ci + row + '$';
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

const SCROLLBAR_PALETTE = [[100, 110, 130]];
const SCROLLBAR_HOVER_PALETTE = [[160, 175, 200]];
const SCROLLBAR_ACTIVE_PALETTE = [[210, 225, 245]];

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
