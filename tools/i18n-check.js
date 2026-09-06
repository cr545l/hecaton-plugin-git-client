'use strict';
// tools/i18n-check.js — 카탈로그 정합성. 커밋 전과 CI 에서 돌린다.
//
//   1. 언어별 키 집합이 영어와 같은가 (번역 누락/고아 키)
//   2. {치환} 자리표시자의 종류가 언어 간 같은가 — 다르면 화면에 {name} 이 그대로 나온다
//   3. 소스가 부르는 t('키') 가 카탈로그에 있는가
//   4. 카탈로그의 키가 실제로 쓰이는가 (오타로 죽은 키)
//   5. t() 를 쓰는 파일에 require 가 있는가
//
//   node tools/i18n-check.js

const fs = require('fs');
const path = require('path');
const { root, sourceFiles, literals } = require('./i18n-lib');

const localeDir = path.join(root, 'locale');
const en = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const tags = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
const problems = [];

const placeholders = (value) =>
  [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const tag of tags) {
  if (tag === 'en') continue;
  const other = JSON.parse(fs.readFileSync(path.join(localeDir, tag + '.json'), 'utf8'));
  for (const key of Object.keys(en)) {
    if (!(key in other)) problems.push(`${tag}: 번역 누락 ${key}`);
    else if (placeholders(en[key]) !== placeholders(other[key])) {
      problems.push(`${tag}: 자리표시자 불일치 ${key} (en=${placeholders(en[key])} ${tag}=${placeholders(other[key])})`);
    }
  }
  for (const key of Object.keys(other)) {
    if (!(key in en)) problems.push(`${tag}: 영어에 없는 키 ${key}`);
  }
}

const called = new Set();
for (const file of sourceFiles()) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (/\bt\(\s*['"`]/.test(source) && !source.includes("require('./i18n')")) {
    problems.push(`${rel}: t() 를 쓰는데 require('./i18n') 가 없다`);
  }
  for (const lit of literals(source)) {
    // t('키') 뿐 아니라 t(조건 ? '키A' : '키B') 도 잡아야 하므로,
    // 카탈로그 키와 정확히 같은 리터럴이면 호출된 것으로 본다.
    if (lit.value in en) { called.add(lit.value); continue; }
    const before = source.slice(Math.max(0, lit.index - 8), lit.index);
    if (!/\bt\(\s*$/.test(before)) continue;
    problems.push(`${rel}:${lit.line}: 카탈로그에 없는 키 ${lit.value}`);
  }
}
for (const key of Object.keys(en)) {
  if (!called.has(key)) problems.push(`쓰이지 않는 키 ${key}`);
}

if (!problems.length) {
  console.log(`정합성 OK — ${tags.join('/')} 각 ${Object.keys(en).length}개 키`);
  process.exit(0);
}
console.error(`문제 ${problems.length}건:`);
for (const line of problems) console.error('  ' + line);
process.exit(1);
