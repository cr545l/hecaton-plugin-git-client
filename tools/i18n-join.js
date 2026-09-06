'use strict';
// tools/i18n-join.js — 문자열 연결로 조립되는 문장을 한 문장 + {치환}으로 합친다.
//
//   "Merge into '" + branch + "'..."   →   t('menu.mergeInto', { branch })
//   카탈로그:                                "Merge into '{branch}'..."
//
// 조각마다 번역하면 어순이 다른 언어를 만들 수 없다. 그래서 조각을 이어 붙인 자리는
// 자동 치환에서 빼 두었고(i18n-audit 의 concat), 이 도구가 체인 전체를 한 번에 옮긴다.
//
// 다루지 않는 것(수동 목록으로 남긴다):
//   - 삼항이 섞인 체인: 'File' + (n > 1 ? 's' : '')  — 복수형은 언어마다 규칙이 다르다
//   - 체인 안에 이미 t(...) 가 있는 것
//   - 표현식이 너무 복잡해 인자 이름을 지을 수 없는 것
//
//   node tools/i18n-join.js [--dry] [--file <name>]

const fs = require('fs');
const path = require('path');
const { root, sourceFiles, literals, classify, decode } = require('./i18n-lib');

const dryRun = process.argv.includes('--dry');
const fileArg = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1] : null;

const catalogPath = path.join(root, 'locale/en.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be']);
function slug(value) {
  const words = String(value).replace(/\{\w+\}/g, ' ').replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim().split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  if (!words.length) return 'text';
  return words.slice(0, 6)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

// 표현식에서 치환 이름을 짓는다: branchName → branchName, wt.path → path, foo() → value
function argName(expr, taken) {
  const trimmed = expr.trim();
  let base = null;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) base = trimmed;
  else {
    const tail = trimmed.match(/([A-Za-z_$][\w$]*)\s*$/);
    if (tail && !/\)$/.test(trimmed)) base = tail[1];
    else {
      const call = trimmed.match(/([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*$/);
      if (call) base = call[1];
    }
  }
  if (!base) base = 'value';
  base = base.replace(/^_+/, '') || 'value';
  let name = base, n = 2;
  while (taken.has(name)) name = base + n++;
  taken.add(name);
  return name;
}

// literal.index 를 시작점으로 좌우의 `+` 체인을 토큰 단위로 넓힌다.
// 반환: { start, end, parts: [{kind:'lit'|'expr', text, literal?}] } 또는 null
function chainAround(source, target, literalIndex) {
  const byIndex = new Map(literalIndex.map((l) => [l.index, l]));
  const isLiteralStart = (i) => byIndex.has(i);

  // 왼쪽으로: `+` 앞의 피연산자를 계속 흡수
  const scanLeft = (from) => {
    let i = from;
    for (;;) {
      let j = i - 1;
      while (j >= 0 && /\s/.test(source[j])) j--;
      if (source[j] !== '+' || source[j - 1] === '+') break;   // ++ 는 증가 연산자
      let k = j - 1;
      while (k >= 0 && /\s/.test(source[k])) k--;
      // 피연산자의 시작을 찾는다
      let depth = 0, end = k + 1, start = -1;
      for (; k >= 0; k--) {
        const ch = source[k];
        if (ch === ')' || ch === ']') depth++;
        else if (ch === '(' || ch === '[') {
          if (depth === 0) { start = k + 1; break; }
          depth--;
        } else if (depth === 0 && (ch === ',' || ch === ';' || ch === '{' || ch === '}' || ch === '\n' || ch === ':' || ch === '?')) {
          start = k + 1; break;
        } else if (depth === 0 && ch === '=' && source[k - 1] !== '=' && source[k + 1] !== '=') {
          start = k + 1; break;
        } else if (depth === 0 && ch === '+' && source[k - 1] !== '+') {
          start = k + 1; break;
        } else if (ch === '"' || ch === "'" || ch === '`') {
          // 문자열이면 그 시작으로 점프
          const lit = [...byIndex.values()].find((l) => l.end === k + 1);
          if (!lit) return null;
          k = lit.index;
          if (isLiteralStart(k)) { start = k; break; }
        }
      }
      if (start < 0) start = 0;
      const text = source.slice(start, end).trim();
      if (!text) break;
      i = start;
    }
    return i;
  };

  // 오른쪽으로: `+` 뒤의 피연산자를 계속 흡수
  const scanRight = (from) => {
    let i = from;
    for (;;) {
      let j = i;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== '+' || source[j + 1] === '+') break;
      let k = j + 1;
      while (k < source.length && /\s/.test(source[k])) k++;
      let depth = 0, start = k, end = -1;
      for (; k < source.length; k++) {
        const ch = source[k];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') {
          if (depth === 0) { end = k; break; }
          depth--;
        } else if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n' || ch === '}' || ch === ':' || ch === '?')) {
          end = k; break;
        } else if (depth === 0 && ch === '+' && source[k + 1] !== '+' && source[k - 1] !== '+') {
          end = k; break;
        } else if (ch === '"' || ch === "'" || ch === '`') {
          const lit = byIndex.get(k);
          if (!lit) return null;
          k = lit.end - 1;
        }
      }
      if (end < 0) end = source.length;
      if (end <= start) break;
      i = end;
    }
    return i;
  };

  const start = scanLeft(target.index);
  const end = scanRight(target.end);
  if (start === target.index && end === target.end) return null;   // 체인이 아니다

  // 체인을 항으로 쪼갠다
  const parts = [];
  let i = start, depth = 0, buf = '', bufStart = start;
  const flushExpr = (upto) => {
    const text = source.slice(bufStart, upto).trim();
    if (text) parts.push({ kind: 'expr', text });
    buf = '';
  };
  while (i < end) {
    const ch = source[i];
    if (byIndex.has(i) && depth === 0) {
      flushExpr(i);
      const lit = byIndex.get(i);
      parts.push({ kind: 'lit', literal: lit });
      i = lit.end;
      // 다음 `+` 를 건너뛴다
      let j = i;
      while (j < end && /\s/.test(source[j])) j++;
      if (source[j] === '+') i = j + 1;
      bufStart = i;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '+' && depth === 0) {
      flushExpr(i);
      i++;
      bufStart = i;
      continue;
    }
    i++;
  }
  flushExpr(end);
  return { start, end, parts };
}

const skipped = [];
const rejected = [];
let converted = 0;

const vm = require('vm');
function parses(code) {
  try { new vm.Script(code); return true; } catch { return false; }
}
function usedElsewhere(source, key) {
  return source.includes("t('" + key + "'");
}

for (const file of sourceFiles()) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (fileArg && rel !== fileArg) continue;
  const source = fs.readFileSync(file, 'utf8');
  // 한 번만 파싱하고 편집을 모아 뒤에서부터 적용한다 — 변환마다 재파싱하면
  // 140KB 파일에서 O(n²) 이 되어 끝나지 않는다.
  const edits = [];
  const claimed = [];
  {
    const found = literals(source);
    const byIndex = found;
    for (const lit of found) {
      if (claimed.some(([s, e]) => lit.index >= s && lit.index < e)) continue;
      const text = decode(lit);
      if (text === null || classify(text)) continue;
      if (lit.quote === '`' && /\$\{/.test(lit.value)) continue;
      const chain = chainAround(source, lit, byIndex);
      if (!chain) continue;
      // 체인 검증
      const exprs = chain.parts.filter((p) => p.kind === 'expr');
      const lits = chain.parts.filter((p) => p.kind === 'lit');
      const raw = source.slice(chain.start, chain.end);
      if (/\?/.test(raw.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ''))) {
        skipped.push(`${rel}:${lit.line} 삼항 포함`);
        continue;
      }
      if (/\bt\(/.test(raw)) { skipped.push(`${rel}:${lit.line} 이미 t()`); continue; }
      if (!exprs.length || !lits.length) continue;
      // 체인 경계는 휴리스틱이라 로직 표현식을 삼킬 수 있다(key === CSI + '112;6u' 를
      // 통째로 먹은 적이 있다). 그래서 "화면에 그리는 값"이 분명한 자리에서만 합친다.
      const lead = source.slice(Math.max(0, chain.start - 30), chain.start);
      if (!/(label|message|title|text|desc|placeholder|tooltip|summary)\s*:\s*$/.test(lead)) {
        skipped.push(`${rel}:${lit.line} UI 속성 자리가 아님`);
        continue;
      }
      const decoded = lits.map((p) => decode(p.literal));
      if (decoded.some((d) => d === null)) { skipped.push(`${rel}:${lit.line} 이스케이프`); continue; }
      // UI 문장이 하나도 없으면(전부 코드성 조각) 건드리지 않는다
      if (!decoded.some((d, i) => !classify(d))) continue;

      const taken = new Set();
      let template = '';
      const args = [];
      for (const part of chain.parts) {
        if (part.kind === 'lit') template += decode(part.literal);
        else {
          const name = argName(part.text, taken);
          template += '{' + name + '}';
          args.push({ name, expr: part.text });
        }
      }
      if (!template.trim()) continue;
      const ns = rel.replace(/\.js$/, '').replace(/[^a-z]/gi, '');
      const nsMap = { contextmenu: 'menu', render: 'ui', git: 'git', input: 'input',
        refresh: 'refresh', actions: 'action', graph: 'graph', main: 'app', title: 'title' };
      const prefix = nsMap[ns.toLowerCase()] || ns.toLowerCase();
      let key = prefix + '.' + slug(template);
      let n = 2;
      while (catalog[key] !== undefined && catalog[key] !== template) key = prefix + '.' + slug(template) + n++;
      catalog[key] = template;
      const argText = args.map((a) => (a.name === a.expr ? a.name : `${a.name}: ${a.expr}`)).join(', ');
      edits.push({ start: chain.start, end: chain.end, call: `t('${key}', { ${argText} })` });
      claimed.push([chain.start, chain.end]);
      converted++;
    }
  }
  if (dryRun || !edits.length) continue;
  edits.sort((a, b) => b.start - a.start);
  // 체인 경계 판정이 틀리면 소스가 깨진다(삼항 안쪽을 가로지르는 경우가 있었다).
  // 그래서 편집마다 파싱해 보고, 통과한 것만 남긴다 — 도구가 자기 결과를 검증한다.
  let next = source;
  for (const edit of edits) {
    const candidate = next.slice(0, edit.start) + edit.call + next.slice(edit.end);
    if (parses(candidate)) next = candidate;
    else {
      rejected.push(`${rel}:${edit.call.slice(0, 48)}`);
      converted--;
      const key = /t\('([^']+)'/.exec(edit.call);
      if (key && !usedElsewhere(next, key[1])) delete catalog[key[1]];
    }
  }
  fs.writeFileSync(file, next, 'utf8');
}

if (!dryRun) {
  const sorted = {};
  for (const key of Object.keys(catalog).sort()) sorted[key] = catalog[key];
  fs.writeFileSync(catalogPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}
console.log(`${dryRun ? '[dry] ' : ''}합침 ${converted}건 / 건너뜀 ${skipped.length} / 파싱 실패로 취소 ${rejected.length}`);
for (const line of skipped.slice(0, 10)) console.log('  - ' + line);
if (skipped.length > 10) console.log(`  … ${skipped.length - 10}건 더`);
for (const line of rejected.slice(0, 10)) console.log('  x ' + line);
if (rejected.length > 10) console.log(`  … ${rejected.length - 10}건 더`);
