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

module.exports = { stripAnsi, isWide, visLen, padRight, truncate };
