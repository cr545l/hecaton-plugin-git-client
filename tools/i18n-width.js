'use strict';
// tools/i18n-width.js — 번역이 영어보다 넓어지는 자리를 찾는다.
//
// 터미널 UI 는 폭이 곧 레이아웃이다. 한글은 한 글자가 두 칸이라 번역이 길어지면
// 힌트바·상단 버튼이 잘린다("다국어 처리를 하니 버튼이 잘린다"의 정체).
// 화면 폭은 런타임 값이라 정적으로 단정할 수 없으므로, **얼마나 넓어졌는지**를
// 재서 위험한 것부터 보여 준다. 좁아지는 것은 문제가 되지 않는다.
//
//   node tools/i18n-width.js [--min 4] [--gate 12]

const fs = require('fs');
const path = require('path');
const { root } = require('./i18n-lib');
const { visLen } = require(path.join(root, 'text.js'));

const localeDir = path.join(root, 'locale');
const en = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const tags = fs.readdirSync(localeDir)
  .filter((f) => f.endsWith('.json') && f !== 'en.json')
  .map((f) => f.replace('.json', ''));

const argMin = process.argv.indexOf('--min');
const minDelta = argMin > 0 ? Number(process.argv[argMin + 1]) : 4;
const argGate = process.argv.indexOf('--gate');
const gate = argGate > 0 ? Number(process.argv[argGate + 1]) : null;

// 여러 줄 문장은 다이얼로그 본문이라 폭 제약이 약하다 — 한 줄짜리만 본다.
const singleLine = (value) => !value.includes('\n');

// 폭이 곧 레이아웃인 자리. 상단 바 버튼·힌트바·패널 헤더는 한 줄에 나란히 놓이므로
// 번역이 길어지면 그대로 잘린다(render.js 의 truncate / rightTotalW 계산).
// 여기 있는 키는 영어 대비 +TIGHT_BUDGET 칸을 넘지 않아야 한다.
const TIGHT_KEYS = new Set([
  // 상단 바
  'ui.localChanges', 'ui.commits', 'ui.files', 'ui.status', 'ui.detail', 'ui.sort',
  'ui.sortByDate', 'ui.sortByBranch', 'ui.recovery', 'ui.files3', 'ui.stage',
  'ui.files2', 'ui.diff',
  // 힌트바·프롬프트
  'ui.sTageUNstage', 'ui.tabFocus123Ours', 'ui.wIndowREfreshTabFocus', 'ui.bContinueAbort',
  'ui.rebaseHintLabel', 'ui.newBranchPrompt', 'ui.newTagPrompt', 'ui.renameStashPrompt',
  'ui.remoteNamePrompt', 'ui.remoteUrlPrompt', 'ui.timeWindow', 'ui.selectEnterApply',
  'ui.hintSubmit', 'ui.amend2', 'ui.iInitializeOOpenCClone',
  // 패널 헤더·행 접미
  'ui.branches', 'ui.remotes', 'ui.stashes', 'ui.worktrees', 'ui.pinned',
  'ui.unstaged', 'ui.staged2', 'ui.ignored', 'ui.main', 'ui.worktree',
  // 좌측 패널 헤더는 헤더 + 버튼 둘이 한 줄에 들어간다 — 가장 빡빡한 자리다.
  'ui.stageAllBtn', 'ui.unstageAll', 'menu.stage', 'menu.unstage', 'ui.unlock',
  // 목록의 시각 열
  'ui.timeNow', 'ui.timeMinutes', 'ui.timeHours', 'ui.timeDays', 'ui.timeWeeks',
  'ui.pendingAuthor',
]);
const TIGHT_BUDGET = 4;

let worst = 0;
for (const tag of tags) {
  const other = JSON.parse(fs.readFileSync(path.join(localeDir, tag + '.json'), 'utf8'));
  const rows = [];
  for (const key of Object.keys(en)) {
    if (!(key in other) || !singleLine(en[key]) || !singleLine(other[key])) continue;
    const delta = visLen(other[key]) - visLen(en[key]);
    if (delta >= minDelta) rows.push({ key, delta, en: en[key], other: other[key] });
  }
  rows.sort((a, b) => b.delta - a.delta);
  if (rows.length) worst = Math.max(worst, rows[0].delta);
  console.log(`${tag}: 영어보다 ${minDelta}칸 이상 넓어진 문자열 ${rows.length}개`);
  for (const row of rows) {
    console.log(`  +${String(row.delta).padStart(2)}  ${row.key}`);
    console.log(`        en ${visLen(row.en)}칸  ${JSON.stringify(row.en)}`);
    console.log(`        ${tag} ${visLen(row.other)}칸  ${JSON.stringify(row.other)}`);
  }
}

// 폭이 빡빡한 자리는 따로 강제한다 — 나머지는 정보 표시일 뿐이다.
const over = [];
for (const tag of tags) {
  const other = JSON.parse(fs.readFileSync(path.join(localeDir, tag + '.json'), 'utf8'));
  for (const key of TIGHT_KEYS) {
    if (!(key in en) || !(key in other)) continue;
    const delta = visLen(other[key]) - visLen(en[key]);
    if (delta > TIGHT_BUDGET) {
      over.push(`${tag} ${key}: +${delta}칸 (${JSON.stringify(other[key])})`);
    }
  }
}
if (over.length) {
  console.error(`\n폭이 빡빡한 자리에서 +${TIGHT_BUDGET}칸을 넘겼다 — 잘린다:`);
  for (const line of over) console.error('  ' + line);
  process.exit(1);
}
console.log(`폭 제약 자리 ${TIGHT_KEYS.size}개는 모두 +${TIGHT_BUDGET}칸 이내`);

if (gate !== null && worst > gate) {
  console.error(`\n가장 넓어진 폭 +${worst}칸 > 허용 +${gate}칸`);
  process.exit(1);
}
