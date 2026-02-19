const SIXEL_ENABLED = true;
const CELL_W = 8;
const CELL_H = 16;
const LINE_W = 2;
const DOT_R = 3;
const SIXEL_PALETTE = [
  [224, 108, 118],
  [152, 195, 121],
  [229, 192, 123],
  [97,  175, 239],
  [198, 120, 221],
  [86,  182, 194],
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

function pxBezier(buf, w, h, x0, y0, x1, y1, x2, y2, c, t) {
  const half = t >> 1;
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps, ms = 1 - s;
    const px = Math.round(ms * ms * x0 + 2 * ms * s * x1 + s * s * x2);
    const py = Math.round(ms * ms * y0 + 2 * ms * s * y1 + s * s * y2);
    for (let bx = -half; bx < t - half; bx++)
      for (let by = -half; by < t - half; by++)
        pxSet(buf, w, h, px + bx, py + by, c);
  }
}

function renderGraphRowInto(buf, pw, ph, yOff, chars, charColors, numCols, prevChars, nextChars) {
  for (let i = 0; i < chars.length && i < numCols; i++) {
    const ch = chars[i];
    const cc = charColors[i];
    if (cc < 0 || ch === ' ') continue;
    const c = (cc % 6) + 1; // 1-6, 0 = transparent
    const cx = i * CELL_W + (CELL_W >> 1); // center x of cell
    const cy = yOff + (CELL_H >> 1);       // center y in combined image
    const top = yOff, bot = yOff + CELL_H - 1;
    const left = i * CELL_W, right = (i + 1) * CELL_W - 1;

    switch (ch) {
      case '\u2502': // │ vertical line
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        break;
      case '\u25cf': { // ● commit dot
        const hasAbove = prevChars && i < prevChars.length && prevChars[i] !== ' ';
        const hasBelow = nextChars && i < nextChars.length && nextChars[i] !== ' ';
        if (hasAbove) pxVLine(buf, pw, ph, cx, top, cy - DOT_R - 1, c, LINE_W);
        if (hasBelow) pxVLine(buf, pw, ph, cx, cy + DOT_R + 1, bot, c, LINE_W);
        pxCircle(buf, pw, ph, cx, cy, DOT_R, c);
        // Bridge to adjacent cells for 1-cell-per-lane connections
        if (i > 0 && chars[i - 1] !== ' ' && chars[i - 1] !== '\u2502' && chars[i - 1] !== '\u25cf') {
          pxHLine(buf, pw, ph, left, cx - DOT_R - 1, cy, c, LINE_W);
        }
        if (i + 1 < numCols && i + 1 < chars.length && chars[i + 1] !== ' ' && chars[i + 1] !== '\u2502' && chars[i + 1] !== '\u25cf') {
          pxHLine(buf, pw, ph, cx + DOT_R + 1, right, cy, c, LINE_W);
        }
        break;
      }
      case '\u251c': // ├ vertical + right (extend 1px into next cell)
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        pxHLine(buf, pw, ph, cx, right + 1, cy, c, LINE_W);
        break;
      case '\u2524': // ┤ vertical + left (extend 1px into prev cell)
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        pxHLine(buf, pw, ph, left - 1, cx, cy, c, LINE_W);
        break;
      case '\u256e': // ╮ bezier: left → down
        pxBezier(buf, pw, ph, left - 1, cy, cx, cy, cx, bot, c, LINE_W);
        break;
      case '\u256d': // ╭ bezier: right → down
        pxBezier(buf, pw, ph, right + 1, cy, cx, cy, cx, bot, c, LINE_W);
        break;
      case '\u256f': // ╯ bezier: up → left
        pxBezier(buf, pw, ph, cx, top, cx, cy, left - 1, cy, c, LINE_W);
        break;
      case '\u2570': // ╰ bezier: up → right
        pxBezier(buf, pw, ph, cx, top, cx, cy, right + 1, cy, c, LINE_W);
        break;
      case '\u2500': // ─ horizontal line (extend 1px each side for cell bridging)
        pxHLine(buf, pw, ph, left - 1, right + 1, cy, c, LINE_W);
        break;
      case '\u253c': // ┼ cross (extend horizontal 1px each side)
        pxVLine(buf, pw, ph, cx, top, bot, c, LINE_W);
        pxHLine(buf, pw, ph, left - 1, right + 1, cy, c, LINE_W);
        break;
    }
  }
}

function renderCombinedGraphPixels(graphRows, numCols) {
  const pw = numCols * CELL_W;
  const ph = graphRows.length * CELL_H;
  if (pw <= 0 || ph <= 0) return null;
  const buf = new Uint8Array(pw * ph);
  for (let r = 0; r < graphRows.length; r++) {
    const row = graphRows[r];
    if (!row) continue;
    const prev = r > 0 && graphRows[r - 1] ? graphRows[r - 1].chars : null;
    const next = r < graphRows.length - 1 && graphRows[r + 1] ? graphRows[r + 1].chars : null;
    renderGraphRowInto(buf, pw, ph, r * CELL_H, row.chars, row.charColors, numCols, prev, next);
  }
  return buf;
}

function encodeSixel(buf, w, h, palette) {
  // DCS header: P0;1;0q  (Ps2=1 → transparent background)
  let out = '\x1bP0;1;0q';
  // Raster attributes
  out += '"1;1;' + w + ';' + h;
  // Palette definitions (RGB 0-100)
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = palette[i];
    out += '#' + (i + 1) + ';2;' + Math.round(r * 100 / 255) + ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255);
  }
  // Pixel data: process 6 rows at a time (one sixel band)
  for (let bandY = 0; bandY < h; bandY += 6) {
    const bandH = Math.min(6, h - bandY);
    let bandHasData = false;
    for (let ci = 1; ci <= palette.length; ci++) {
      // Build sixel row for this color
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
      // Skip color if entirely transparent (all '?' = 63+0)
      if (row.replace(/[!0-9]/g, '').replace(/\?/g, '') === '') continue;
      bandHasData = true;
      out += '#' + ci + row + '$'; // $ = carriage return (same band, next color)
    }
    if (bandHasData) {
      // Remove trailing $ and add - (next band / line feed)
      if (out.endsWith('$')) out = out.slice(0, -1);
    }
    out += '-'; // - = next sixel line (band)
  }
  // Remove trailing -
  if (out.endsWith('-')) out = out.slice(0, -1);
  // String terminator
  out += '\x1b\\';
  return out;
}

module.exports = {
  SIXEL_ENABLED, CELL_W, CELL_H, SIXEL_PALETTE,
  renderCombinedGraphPixels, encodeSixel,
};
