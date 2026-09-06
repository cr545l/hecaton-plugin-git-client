'use strict';
// tools/i18n-plan.js — 감사 결과에서 치환 계획을 만든다.
//
// 키는 <파일 네임스페이스>.<값 slug> 이고, 같은 문장은 파일이 달라도 한 키를 공유한다.
// 문자열 연결에 참여하는 조각과 `${...}` 보간이 있는 템플릿 리터럴은 키를 비워 둔다.
// 조각마다 번역하면 어순이 깨지고, 보간은 t() 로 감싸는 순간 죽는다 —
// 둘 다 사람이 한 문장 + {name} 치환으로 옮겨야 한다.
//
//   node tools/i18n-plan.js > plan.json

const { execFileSync } = require('child_process');
const path = require('path');

const NAMESPACE = {
  'context-menu.js': 'menu',
  'render.js': 'ui',
  'git.js': 'git',
  'input.js': 'input',
  'refresh.js': 'refresh',
  'actions.js': 'action',
  'graph.js': 'graph',
  'main.js': 'app',
  'queue.js': 'queue',
  'sixel.js': 'sixel',
  'title.js': 'title',
  'text.js': 'text',
  'ansi.js': 'ansi',
  'reap.js': 'reap',
  'state.js': 'state',
  'persist.js': 'persist',
  'coordinate.js': 'coord',
  'scroll.js': 'scroll',
  'spinner.js': 'spinner',
  'highlighter.js': 'highlight',
};

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be']);

function slug(value) {
  const words = value
    .replace(/\\n|\\t|\\r/g, ' ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  const kept = words.slice(0, 6);
  if (!kept.length) return 'text';
  return kept
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

const audit = JSON.parse(execFileSync(process.execPath,
  [path.join(__dirname, 'i18n-audit.js'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

// 줄마다 UI 리터럴이 몇 개인지 미리 센다.
const perLine = new Map();
for (const item of audit.review) {
  if (item.interp || item.code || item.text === null) continue;
  const at = item.file + ':' + item.line;
  perLine.set(at, (perLine.get(at) || 0) + 1);
}

// 이미 카탈로그에 있는 키는 그 값 그대로 재사용하고, 다른 값이면 새 키를 만든다.
const fs = require('fs');
const catalogPath = path.join(__dirname, '..', 'locale/en.json');
const catalog = fs.existsSync(catalogPath)
  ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : {};
const keyByValue = new Map(Object.entries(catalog).map(([k, v]) => [v, k]));
const used = new Set(Object.keys(catalog));
const plan = [];

for (const item of audit.review) {
  // text 가 null 이면 JS 리터럴 표기를 JSON 값으로 풀 수 없다는 뜻이다( 등).
  // code: 비교·분해에 쓰이는 자리 — 값이 곧 로직이라 번역 대상이 아니다.
  // 연결이라도 그 줄에 UI 리터럴이 하나뿐이면 조각이 아니라 완결된 라벨이다
  // (' Branches' + count 처럼). 어순 문제가 없으므로 단독으로 옮긴다.
  // 리터럴이 둘 이상인 연결만 join 이 한 문장으로 합쳐야 한다.
  const uiOnLine = perLine.get(item.file + ':' + item.line) || 0;
  const fragment = item.concat && uiOnLine > 1;
  if (fragment || item.interp || item.code || item.text === null) {
    plan.push({ ...item, key: '' });
    continue;
  }
  let key = keyByValue.get(item.text);
  if (!key) {
    const ns = NAMESPACE[item.file] || slug(item.file.replace(/\.js$/, ''));
    const base = ns + '.' + slug(item.text);
    key = base;
    let n = 2;
    while (used.has(key)) key = base + n++;
    used.add(key);
    keyByValue.set(item.text, key);
  }
  plan.push({ ...item, key });
}

process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
