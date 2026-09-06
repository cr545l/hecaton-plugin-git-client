'use strict';
// tools/i18n-unjoin.js — i18n-join 이 합친 문장을 원래 연결 표현식으로 되돌린다.
//
//   t('menu.mergeInto', { branch })   →   "Merge into '" + branch + "'..."
//
// join 은 체인 경계를 휴리스틱으로 잡는다. 문법은 통과해도 의미가 달라질 수 있어서
// (key === CSI + '112;6u' 의 비교식을 통째로 삼킨 적이 있다) 되돌릴 수단이 필요하다.
//
//   node tools/i18n-unjoin.js <key> [key...]
//   node tools/i18n-unjoin.js --all-parameterized   (치환이 있는 키 전부)

const fs = require('fs');
const path = require('path');
const { root, sourceFiles } = require('./i18n-lib');

const catalogPath = path.join(root, 'locale/en.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

let keys = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--all-parameterized')) {
  keys = Object.keys(catalog).filter((k) => /\{\w+\}/.test(catalog[k]));
}
if (!keys.length) {
  console.error('usage: node tools/i18n-unjoin.js <key>... | --all-parameterized');
  process.exit(2);
}

function literalFor(value) {
  if (!value) return null;
  if (!value.includes("'") && !/[\n\r\t\\]/.test(value)) return "'" + value + "'";
  return JSON.stringify(value);
}

// t('key', { a: expr, b }) 의 인자 객체를 이름→표현식으로 읽는다. 중첩 괄호를 존중한다.
function parseArgs(text) {
  const out = new Map();
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    const nameMatch = /^([A-Za-z_$][\w$]*)\s*/.exec(text.slice(i));
    if (!nameMatch) break;
    const name = nameMatch[1];
    i += nameMatch[0].length;
    if (text[i] !== ':') { out.set(name, name); continue; }
    i++;
    let depth = 0, start = i;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        i++;
        while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
      }
    }
    out.set(name, text.slice(start, i).trim());
  }
  return out;
}

let reverted = 0;
for (const file of sourceFiles()) {
  let source = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const key of keys) {
    const template = catalog[key];
    if (template === undefined) continue;
    for (;;) {
      const marker = "t('" + key + "'";
      const at = source.indexOf(marker);
      if (at < 0) break;
      // 호출 전체 범위를 찾는다
      let i = at + marker.length, depth = 1;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === '"' || ch === "'" || ch === '`') {
          const quote = ch;
          i++;
          while (i < source.length && source[i] !== quote) { if (source[i] === '\\') i++; i++; }
        }
        i++;
      }
      const call = source.slice(at, i);
      const objectStart = call.indexOf('{');
      const args = objectStart < 0 ? new Map()
        : parseArgs(call.slice(objectStart + 1, call.lastIndexOf('}')));
      // 템플릿을 조각으로 나눠 원래 연결식으로 되돌린다
      const pieces = [];
      let rest = template, guard = 0;
      while (rest.length && guard++ < 64) {
        const m = /\{(\w+)\}/.exec(rest);
        if (!m) { pieces.push(literalFor(rest)); break; }
        if (m.index > 0) pieces.push(literalFor(rest.slice(0, m.index)));
        pieces.push(args.has(m[1]) ? args.get(m[1]) : m[1]);
        rest = rest.slice(m.index + m[0].length);
      }
      const replacement = pieces.filter(Boolean).join(' + ');
      source = source.slice(0, at) + replacement + source.slice(i);
      changed = true;
      reverted++;
    }
  }
  if (changed) fs.writeFileSync(file, source, 'utf8');
}

for (const key of keys) delete catalog[key];
const sorted = {};
for (const k of Object.keys(catalog).sort()) sorted[k] = catalog[k];
fs.writeFileSync(catalogPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
console.log(`되돌림 ${reverted}곳 / 키 ${keys.length}개 삭제, 남은 ${Object.keys(catalog).length}`);
