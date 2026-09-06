'use strict';
// tools/i18n-revert.js — 잘못 옮긴 키를 원래 리터럴로 되돌린다.
//
// 자동 분류는 "사람이 읽는 문장"과 "코드로 쓰이는 문자열"을 완벽히 가르지 못한다.
// git 포맷 문자열(%(refname))이나 셸 명령처럼 번역하면 기능이 깨지는 것을 발견하면
// 이 도구로 되돌리고, 재발하지 않도록 i18n-lib 의 NOT_UI 규칙을 함께 보강한다.
//
//   node tools/i18n-revert.js <key> [key...]
//
// t('key') 호출을 카탈로그의 값으로 되돌리고(따옴표는 값에 맞춰 고른다) 키를 지운다.

const fs = require('fs');
const path = require('path');
const { root, sourceFiles } = require('./i18n-lib');

const keys = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!keys.length) {
  console.error('usage: node tools/i18n-revert.js <key> [key...]');
  process.exit(2);
}

const catalogPath = path.join(root, 'locale/en.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

// 값에 맞는 JS 리터럴 표기를 만든다. 개행·따옴표가 있으면 JSON 표기가 가장 안전하다.
function literalFor(value) {
  const json = JSON.stringify(value);
  if (!value.includes("'") && !/[\n\r\t\\]/.test(value)) return "'" + value + "'";
  return json;
}

let replaced = 0;
const missing = [];
for (const key of keys) {
  if (!(key in catalog)) { missing.push(key); continue; }
  const literal = literalFor(catalog[key]);
  const call = new RegExp("t\\('" + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\)", 'g');
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    if (!call.test(source)) continue;
    call.lastIndex = 0;
    const next = source.replace(call, () => { replaced++; return literal; });
    fs.writeFileSync(file, next, 'utf8');
  }
  delete catalog[key];
}

const sorted = {};
for (const key of Object.keys(catalog).sort()) sorted[key] = catalog[key];
fs.writeFileSync(catalogPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

console.log(`되돌림 ${replaced}곳 / 키 ${keys.length - missing.length}개 삭제, 남은 키 ${Object.keys(catalog).length}`);
if (missing.length) console.log('  카탈로그에 없음: ' + missing.join(', '));
