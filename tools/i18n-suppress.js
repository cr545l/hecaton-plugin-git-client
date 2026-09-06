'use strict';
// tools/i18n-suppress.js — 규칙으로 거를 수 없는 자리에 `// i18n-ok: 사유` 를 단다.
//
// 억제는 줄 단위라 **줄 끝**에 달아야 한다. 줄 중간에 끼우면 그 뒤가 통째로 주석이 된다.
// 사유를 적게 강제하는 것이 요점이다 — 나중에 그 판단을 다시 볼 수 있어야 한다.
//
//   node tools/i18n-suppress.js <file:line> <사유>          한 줄
//   node tools/i18n-suppress.js --from <json> <사유>        목록(감사 --json 형식)

const fs = require('fs');
const path = require('path');
const { root } = require('./i18n-lib');

const args = process.argv.slice(2);
let targets = [];
let reason = '';

if (args[0] === '--from') {
  const list = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  targets = (list.review || list).map((x) => x.file + ':' + x.line);
  reason = args.slice(2).join(' ');
} else {
  targets = [args[0]];
  reason = args.slice(1).join(' ');
}
if (!targets.length || !reason) {
  console.error('usage: node tools/i18n-suppress.js <file:line>|--from <json> <사유>');
  process.exit(2);
}

const byFile = new Map();
for (const target of targets) {
  const at = target.lastIndexOf(':');
  const file = target.slice(0, at);
  const line = parseInt(target.slice(at + 1), 10);
  if (!byFile.has(file)) byFile.set(file, new Set());
  byFile.get(file).add(line);
}

let added = 0;
for (const [rel, lineNumbers] of byFile) {
  const full = path.join(root, rel);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  for (const n of lineNumbers) {
    const idx = n - 1;
    if (idx < 0 || idx >= lines.length) continue;
    if (/\/\/\s*i18n-ok:/.test(lines[idx])) continue;
    lines[idx] = lines[idx].replace(/\s*$/, '') + '  // i18n-ok: ' + reason;
    added++;
  }
  fs.writeFileSync(full, lines.join('\n'), 'utf8');
}
console.log(`억제 주석 ${added}줄: ${reason}`);
