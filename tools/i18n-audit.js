'use strict';
// tools/i18n-audit.js — 화면에 나가는 문자열이 카탈로그로 옮겨졌는지 전수 검사한다.
//
// 눈으로 세지 않는다. 소스의 모든 문자열 리터럴을 세 갈래로 나누고,
// "검토 필요"가 0이어야 한다.
//
//   이관됨      t('키') 안에 있는 것
//   UI 아님     git 인자·ANSI·색·식별자·경로처럼 사람이 읽는 문장이 아닌 것
//   검토 필요   그 외 전부 — 카탈로그로 옮기거나 // i18n-ok: <사유> 를 단다
//
// 억제 주석은 줄 단위다: 그 줄 끝에 `// i18n-ok: 사유`.
// 목록은 절대 자르지 않는다 — 잘라서 보다가 놓친 적이 있다.
//
//   node tools/i18n-audit.js            요약
//   node tools/i18n-audit.js --json     전체 목록(치환 계획의 입력)
//   node tools/i18n-audit.js --gate     검토 필요가 있으면 실패 (CI/커밋 전)

const fs = require('fs');
const path = require('path');
const { root, sourceFiles, literals, classify, concatenated, interpolated, decode, codeContext } = require('./i18n-lib');

// 카탈로그 키 자체가 소스에 리터럴로 나오는 자리(삼항으로 키를 고르는 경우)를 알아보기 위해 읽는다.
const catalogFile = path.join(root, 'locale/en.json');
const catalog = fs.existsSync(catalogFile)
  ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : null;

function auditFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const result = { migrated: 0, notUi: 0, review: [] };
  for (const literal of literals(source)) {
    const lineText = lines[literal.line - 1] || '';
    const before = source.slice(Math.max(0, literal.index - 24), literal.index);
    if (/\bt\(\s*$/.test(before)) { result.migrated++; continue; }
    // t(조건 ? '키A' : '키B') 처럼 t( 바로 뒤가 아닌 키도 있다 — 카탈로그 키면 이관된 것이다.
    if (catalog && literal.value in catalog) { result.migrated++; continue; }
    if (/\/\/\s*i18n-ok:/.test(lineText)) { result.notUi++; continue; }
    const text = decode(literal);
    if (classify(text === null ? literal.value : text)) { result.notUi++; continue; }
    // 비교·분해에 쓰이는 자리는 값이 곧 로직이다 — 번역 대상이 아니므로 목록에서 뺀다.
    if (codeContext(source, literal)) { result.notUi++; continue; }
    result.review.push({
      file: rel,
      line: literal.line,
      index: literal.index,
      value: literal.value,
      concat: concatenated(source, literal),
      interp: interpolated(literal),
      text,
      code: codeContext(source, literal),
      context: lineText.trim().slice(0, 160),
    });
  }
  return result;
}

const files = sourceFiles();
let migrated = 0, notUi = 0;
const review = [];
for (const file of files) {
  const r = auditFile(file);
  migrated += r.migrated;
  notUi += r.notUi;
  review.push(...r.review);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ migrated, notUi, review }, null, 2));
} else {
  const byFile = new Map();
  for (const item of review) byFile.set(item.file, (byFile.get(item.file) || 0) + 1);
  const concat = review.filter((r) => r.concat).length;
  const interp = review.filter((r) => r.interp).length;
  console.log(`리터럴 ${migrated + notUi + review.length}개 → 이관 ${migrated} / UI 아님 ${notUi} / 검토 필요 ${review.length}`);
  if (review.length) console.log(`  (그중 연결 ${concat}건 · 템플릿 보간 ${interp}건 — 한 문장으로 합쳐야 한다)`);
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${file}`);
  }
}

if (process.argv.includes('--gate') && review.length) {
  console.error(`\n검토 필요 ${review.length}건 — 카탈로그로 옮기거나 // i18n-ok: <사유> 를 달아야 한다.`);
  process.exit(1);
}
