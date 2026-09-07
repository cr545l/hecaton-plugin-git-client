'use strict';
// tools/i18n-eager.js — 모듈 로드 시점에 굳어 버리는 t() 호출을 찾는다.
//
// t() 는 "그리는 시점"에 불러야 한다. 최상위 상수 안에서 부르면 require 되는 순간
// 한 번 평가되고, 그때는 아직 호스트 언어가 정해지기 전이라 **영어로 굳는다**.
// 화면에는 t() 를 썼는데도 영어가 남고, 언어를 바꿔도 따라오지 않는다.
//
//   const FRESH_TIME_WINDOWS = [{ label: t('refresh.7Days') }];        // ✗ 굳는다
//   const FRESH_TIME_WINDOWS = [{ get label() { return t('...'); } }]; // ✓ 그릴 때 평가
//
// 판정: 들여쓰기 0 의 const/let/var 문장 안에 t() 가 있고, 그 문장에 function/=> 가
// 없으면(=지연 평가 장치가 없으면) 굳는다. 보수적으로 본다 — 함수가 섞이면 넘어간다.
//
//   node tools/i18n-eager.js [--gate]

const fs = require('fs');
const path = require('path');
const { root, sourceFiles } = require('./i18n-lib');

function statements(source) {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(const|let|var)\s/.test(lines[i])) continue;
    let depth = 0, text = '', start = i;
    for (; i < lines.length; i++) {
      const line = lines[i];
      text += line + '\n';
      for (const ch of line) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
      }
      if (depth <= 0 && /[;}\])]\s*$|^\s*$/.test(line)) break;
    }
    out.push({ start: start + 1, end: i + 1, text });
  }
  return out;
}

const findings = [];
for (const file of sourceFiles()) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  for (const stmt of statements(source)) {
    if (!/\bt\(\s*['"`]/.test(stmt.text)) continue;
    // 함수가 섞여 있으면 지연 평가일 수 있다 — 넘어간다(거짓 경보를 만들지 않는다).
    if (/\bfunction\b|=>/.test(stmt.text)) continue;
    // getter 도 지연 평가다: get label() { return t('…'); } 는 읽을 때 평가된다.
    // getter 밖에 남은 t() 만 문제이므로, getter 본문을 지운 뒤 다시 본다.
    const withoutGetters = stmt.text.replace(/\bget\s+(?:'[^']+'|"[^"]+"|[\w$]+)\s*\([^)]*\)\s*\{[^}]*\}/g, '');
    if (!/\bt\(\s*['"`]/.test(withoutGetters)) continue;
    const keys = [...withoutGetters.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
    findings.push({ file: rel, line: stmt.start, keys });
  }
}

if (!findings.length) {
  console.log('로드 시점에 굳는 t() 없음');
  process.exit(0);
}
let total = 0;
console.log('로드 시점에 평가되어 영어로 굳는 자리:');
for (const f of findings) {
  total += f.keys.length;
  console.log(`  ${f.file}:${f.line}  ${f.keys.length}개  ${f.keys.slice(0, 3).join(', ')}${f.keys.length > 3 ? ' …' : ''}`);
}
console.log(`총 ${findings.length}곳 / 키 ${total}개`);
if (process.argv.includes('--gate')) process.exit(1);
