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
  mouseShape: (shape) => `\x1b]22;${shape}\x07`,
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
  pinned: CSI + '95m',        // bright magenta — 핀 고정 브랜치 (green/red/cyan/yellow와 겹치지 않음)
  border: CSI + '2m',         // SGR dim (faint)
  sectionHeader: CSI + '39m', // default foreground
  cursor: CSI + '39m',        // default foreground
  cursorBg: CSI + '100m',     // bright black bg
  // 포커스가 다른 패널로 가도 목록의 선택은 그대로 두고 이 색으로 흐리게만 그린다.
  // sixel 그래프도 같은 값을 쓰므로 sixel.js 의 BG_CURSOR_INACTIVE 와 함께 바꿔야 한다.
  cursorBgInactive: CSI + '48;2;64;64;64m',
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
