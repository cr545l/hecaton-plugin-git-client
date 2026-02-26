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
  title: CSI + '94m',         // bright blue
  label: CSI + '39m',         // default foreground
  value: CSI + '39m',         // default foreground
  dim: CSI + '2m',            // SGR dim (faint)
  green: CSI + '32m',         // green
  red: CSI + '31m',           // red
  yellow: CSI + '33m',        // yellow
  cyan: CSI + '36m',          // cyan
  orange: CSI + '33m',        // yellow (dark gold on light themes)
  border: CSI + '2m',         // SGR dim (faint)
  sectionHeader: CSI + '39m', // default foreground
  cursor: CSI + '39m',        // default foreground
  cursorBg: CSI + '100m',     // bright black bg
  hoverBg: CSI + '48;2;50;50;50m', // dark gray bg (hover)
  diffAdd: CSI + '32m',       // green text
  diffDel: CSI + '31m',       // red text
  diffAddBg: CSI + '48;2;34;78;28m',   // dark green bg (like crush)
  diffDelBg: CSI + '48;2;90;30;30m',   // dark red bg (like crush)
  diffHunk: CSI + '36m',      // cyan
  diffHeader: CSI + '39m',    // default foreground
  inputBg: CSI + '100m',      // bright black bg
  selectedBg: CSI + '44m',    // blue bg (multi-select)
};

// Branch lane colors (ANSI bright palette)
const seriePalette = [
  CSI + '91m',  // bright red
  CSI + '92m',  // bright green
  CSI + '93m',  // bright yellow
  CSI + '94m',  // bright blue
  CSI + '95m',  // bright magenta
  CSI + '96m',  // bright cyan
];

module.exports = { ESC, CSI, ansi, colors, seriePalette };
