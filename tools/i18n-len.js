'use strict';
// tools/i18n-len.js — 표시 폭을 .length 로 재는 자리를 찾는다.
//
// 터미널에서 한글은 한 글자가 두 칸이다. `label.length` 는 글자 수라서 폭의 절반으로
// 세고, 그만큼 버튼이 잘리거나 옆 칸을 침범한다. 영어에서는 length == 폭이라
// 번역을 넣기 전까지 드러나지 않는다("전체 스테이…" 로 잘리던 원인).
//
// UI 문자열을 담는 변수(…Label, label, title, text, hint, header …)의 .length 만 본다.
// 배열·컬렉션의 .length 는 정상이므로 이름으로 가른다.
//
//   node tools/i18n-len.js [--gate]

const fs = require('fs');
const path = require('path');
const { root, sourceFiles } = require('./i18n-lib');

// 문자열을 담는 이름들. 복수형(labels, lines)은 배열일 수 있어 제외한다.
const TEXT_NAME = /\b([A-Za-z_$][\w$]*(?:Label|Text|Title|Hint|Header|Msg|Message|Prompt|Caption|Suffix|Prefix)|label|title|text|hint|header|msg|message|prompt)\.length\b/g;

const findings = [];
for (const file of sourceFiles()) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (/\/\/\s*i18n-ok:/.test(line)) return;
    let m;
    TEXT_NAME.lastIndex = 0;
    while ((m = TEXT_NAME.exec(line))) {
      findings.push({ file: rel, line: i + 1, expr: m[1] + '.length', text: line.trim().slice(0, 120) });
    }
  });
}

if (!findings.length) {
  console.log('표시 폭을 .length 로 재는 자리 없음');
  process.exit(0);
}
console.log('표시 폭을 .length 로 재는 자리 (visLen 을 써야 한다):');
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  ${f.expr}`);
  console.log(`      ${f.text}`);
}
console.log(`총 ${findings.length}곳`);
if (process.argv.includes('--gate')) process.exit(1);
