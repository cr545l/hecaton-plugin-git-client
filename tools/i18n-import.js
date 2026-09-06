'use strict';
// tools/i18n-import.js — t() 를 쓰는데 require 가 없는 파일에 import 를 넣는다.
//
// 치환 도구들은 호출부만 바꾸므로 import 는 따로 맞춰야 한다. 빠지면 런타임에
// "t is not defined" 로 죽는다 — 테스트가 잡지만, 그 전에 이 도구로 채운다.
//
//   node tools/i18n-import.js [--check]

const fs = require('fs');
const path = require('path');
const { root, sourceFiles } = require('./i18n-lib');

const checkOnly = process.argv.includes('--check');
const LINE = "const { t } = require('./i18n');";
const missing = [];
let added = 0;

for (const file of sourceFiles()) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const uses = /\bt\(\s*['"`]/.test(source);
  const has = source.includes("require('./i18n')");
  if (!uses || has) continue;
  missing.push(rel);
  if (checkOnly) continue;
  const lines = source.split('\n');
  // 'use strict' / shebang 다음, 첫 require 앞에 넣는다.
  let idx = 0;
  for (let i = 0; i < Math.min(60, lines.length); i++) {
    if (/^(const|let|var)\s.*require\(/.test(lines[i])) { idx = i; break; }
    if (lines[i].startsWith('#!') || /^['"]use strict['"]/.test(lines[i])) idx = i + 1;
  }
  lines.splice(idx, 0, LINE);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  added++;
}

if (checkOnly) {
  console.log(missing.length ? 'import 누락: ' + missing.join(', ') : 'import 누락 없음');
  process.exit(missing.length ? 1 : 0);
}
console.log(`import 추가 ${added}개 파일` + (added ? ': ' + missing.join(', ') : ''));
