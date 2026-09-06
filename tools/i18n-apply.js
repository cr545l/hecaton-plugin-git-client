'use strict';
// tools/i18n-apply.js — 감사 목록의 문자열을 카탈로그로 옮기고 호출부를 t('키')로 바꾼다.
//
// 손으로 찾아 바꾸지 않는다. i18n-audit 과 같은 파서로 리터럴의 정확한 위치를 잡고,
// 값이 기대와 다르면 그 항목을 건너뛴다(파일이 그 사이 바뀌었다는 뜻이므로).
//
//   node tools/i18n-apply.js plan.json [--dry]
//
// plan.json: [{ file, line, value, key, args? }]
//   args 가 있으면 t('key', {…}) 로 쓴다(자리표시자 있는 문장).
//   key 가 비어 있으면 건너뛴다 — 아직 사람이 판단하지 않은 항목이다.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const planPath = process.argv[2];
const dryRun = process.argv.includes('--dry');
if (!planPath) {
  console.error('usage: node tools/i18n-apply.js <plan.json> [--dry]');
  process.exit(2);
}

const { literals } = require('./i18n-lib');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const catalogPath = path.join(root, 'locale/en.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const byFile = new Map();
for (const item of plan) {
  if (!item.key) continue;
  if (!byFile.has(item.file)) byFile.set(item.file, []);
  byFile.get(item.file).push(item);
}

let applied = 0, skipped = 0;
const conflicts = [];

for (const [rel, items] of byFile) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  const found = literals(source);
  // 한 줄에 같은 문자열이 여러 번 나오고 그중 일부만 대상일 수 있다
  // (token.startsWith('tag: ') 는 제외, token.substring('tag: '.length) 는 대상).
  // 줄+값으로 찾으면 첫 번째 자리를 잘못 잡으므로 파서가 준 문자 오프셋으로 맞춘다.
  // 뒤에서 앞으로 바꿔야 앞쪽 인덱스가 밀리지 않는다.
  const edits = [];
  for (const item of items) {
    const match = found.find((lit) => lit.index === item.index && lit.value === item.value);
    if (!match) {
      skipped++;
      conflicts.push(`${rel}:${item.line} ${JSON.stringify(item.value).slice(0, 60)}`);
      continue;
    }
    const existing = catalog[item.key];
    if (existing !== undefined && existing !== item.text) {
      conflicts.push(`KEY CLASH ${item.key}: ${JSON.stringify(existing)} vs ${JSON.stringify(item.value)}`);
      skipped++;
      continue;
    }
    catalog[item.key] = item.text;
    const call = item.args
      ? `t('${item.key}', ${item.args})`
      : `t('${item.key}')`;
    edits.push({ start: match.index, end: match.end, call });
    applied++;
  }
  if (!edits.length || dryRun) continue;
  edits.sort((a, b) => b.start - a.start);
  let next = source;
  for (const edit of edits) {
    next = next.slice(0, edit.start) + edit.call + next.slice(edit.end);
  }
  fs.writeFileSync(file, next, 'utf8');
}

if (!dryRun) {
  const sorted = {};
  for (const key of Object.keys(catalog).sort()) sorted[key] = catalog[key];
  fs.writeFileSync(catalogPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

console.log(`${dryRun ? '[dry] ' : ''}적용 ${applied} / 건너뜀 ${skipped}`);
for (const line of conflicts.slice(0, 20)) console.log('  ! ' + line);
if (conflicts.length > 20) console.log(`  … ${conflicts.length - 20}건 더`);
