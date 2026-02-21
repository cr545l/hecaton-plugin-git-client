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

module.exports = { stripAnsi, isWide, visLen, padRight, truncate, viewport };
