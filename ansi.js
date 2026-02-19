const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  inverse: CSI + '7m',
  fg: (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg: (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  moveTo: (row, col) => `${CSI}${row};${col}H`,
};

const colors = {
  title: ansi.fg(130, 180, 255),
  label: ansi.fg(180, 180, 200),
  value: ansi.fg(255, 255, 255),
  dim: ansi.fg(100, 100, 120),
  green: ansi.fg(120, 220, 150),
  red: ansi.fg(230, 110, 110),
  yellow: ansi.fg(230, 200, 100),
  cyan: ansi.fg(100, 200, 230),
  orange: ansi.fg(230, 170, 100),
  border: ansi.fg(80, 80, 100),
  sectionHeader: ansi.fg(160, 160, 180),
  cursor: ansi.fg(255, 255, 255),
  cursorBg: ansi.bg(60, 60, 90),
  diffAdd: ansi.fg(120, 220, 150),
  diffDel: ansi.fg(230, 110, 110),
  diffHunk: ansi.fg(100, 200, 230),
  diffHeader: ansi.fg(180, 180, 200),
  inputBg: ansi.bg(40, 40, 60),
};

// Serie-style branch lane colors (6 colors from serie's palette)
const seriePalette = [
  ansi.fg(224, 108, 118),  // red/coral
  ansi.fg(152, 195, 121),  // green
  ansi.fg(229, 192, 123),  // yellow
  ansi.fg(97, 175, 239),   // blue
  ansi.fg(198, 120, 221),  // purple
  ansi.fg(86, 182, 194),   // cyan
];

module.exports = { ESC, CSI, ansi, colors, seriePalette };
