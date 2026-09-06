'use strict';
// tools/i18n-lib.js — 감사·치환이 함께 쓰는 리터럴 파서와 분류 규칙.
// 두 도구가 같은 파서를 봐야 "감사에서 본 그 자리"를 정확히 바꿀 수 있다.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.hecaton', 'test', 'tools', 'highlight', 'locale']);
const SKIP_FILES = new Set(['i18n.js']);

function sourceFiles(dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js') && !SKIP_FILES.has(entry.name)) out.push(full);
  }
  return out;
}

// 문자열 리터럴 추출 — 주석과 정규식 리터럴은 건너뛴다.
// index/end 는 따옴표를 포함한 리터럴 전체 범위다(치환이 이 범위를 통째로 바꾼다).
function literals(source) {
  const found = [];
  let i = 0, line = 1;
  const isRegexPosition = (index) => {
    for (let k = index - 1; k >= 0; k--) {
      const ch = source[k];
      if (ch === ' ' || ch === '\t' || ch === '\n') continue;
      return '(,=:[!&|?{};+-*%~^<>'.includes(ch);
    }
    return true;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '/' && isRegexPosition(i)) {
      let k = i + 1, inClass = false, closed = false;
      while (k < source.length && source[k] !== '\n') {
        if (source[k] === '\\') { k += 2; continue; }
        if (source[k] === '[') inClass = true;
        else if (source[k] === ']') inClass = false;
        else if (source[k] === '/' && !inClass) { closed = true; k++; break; }
        k++;
      }
      if (closed) { i = k; continue; }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const startLine = line;
      const start = i;
      let k = i + 1, value = '', depth = 0;
      while (k < source.length) {
        const c = source[k];
        if (c === '\\') { value += source.substr(k, 2); k += 2; continue; }
        if (c === '\n') { line++; if (quote !== '`') break; }
        if (quote === '`' && c === '$' && source[k + 1] === '{') { depth++; k += 2; value += '${'; continue; }
        if (quote === '`' && depth > 0 && c === '}') { depth--; k++; value += '}'; continue; }
        if (c === quote && depth === 0) { k++; break; }
        value += c;
        k++;
      }
      found.push({ value, line: startLine, quote, index: start, end: k });
      i = k;
      continue;
    }
    i++;
  }
  return found;
}

// 사람이 읽는 문장이 아닌 것들. 규칙은 좁게 — 애매하면 "검토 필요"로 남긴다.
const NOT_UI = [
  [/^\s*$/, 'empty'],
  [/^.{1,2}$/s, 'too short'],
  [/\\x1b|\\u001b|\\033/, 'ansi escape'],
  [/^#[0-9a-fA-F]{3,8}$/, 'color'],
  [/^[a-z0-9_]+$/, 'identifier'],
  [/^[A-Z0-9_]+$/, 'constant'],
  [/^[a-z][a-zA-Z0-9]*$/, 'camelCase identifier'],
  [/^[a-z0-9]+([.-][a-z0-9]+)+$/, 'dotted/kebab identifier'],
  [/^--?[a-zA-Z0-9][\w-]*(=.*)?$/, 'cli flag'],
  [/^[^a-zA-Z]*$/s, 'no letters'],
  [/^[\w./\\-]+\.(js|json|md|txt|png|exe|sh|lock|gitignore)$/i, 'filename'],
  [/^(https?|file|git|ssh):/i, 'url'],
  [/^\/[\w./-]*$/, 'path'],
  [/^\.{1,2}\//, 'require path'],
  [/^\d+(;\d+)*m?$/, 'sgr parameters'],
  [/^[a-z][a-z0-9_]*(:[a-z0-9_]*)+$/, 'action id'],
  [/^[a-z][a-z0-9_]*:$/, 'action prefix'],
  [/^[A-Za-z][\w-]*(\/[\w.-]+)+$/, 'ref path'],
  // git 자체의 어휘 — 번역하면 명령이 깨진다.
  [/^(pick|squash|fixup|edit|reword|drop|noop|break|label|reset|merge|exec|revert)\s*$/i, 'rebase todo verb'],
  [/^(core|alias|user|remote|branch|push|pull|fetch|diff|status|commit|log|gc|init)\.[\w.-]+/, 'git config key'],
  [/^git\s+[a-z][\w-]*/, 'git command'],
  [/^(diff --git|index |--- |\+\+\+ |@@ )/, 'diff marker'],
  [/^HEAD\b/, 'git revision'],
  [/^@\{/, 'git revision'],
  [/^ref:\s/, 'git ref line'],
  [/^\.git\b/, 'git dir'],
  [/^(Ctrl|Alt|Shift|Meta|Cmd)\+/, 'shortcut label'],
  [/^<\/?[a-zA-Z][^>]*>$/, 'markup tag'],
  [/^\^|\$$/, 'regex source'],
  [/^refs\//, 'git ref prefix'],
  [/^\.[a-z][a-z0-9]*$/, 'dot directory'],
  [/%\(|%x[0-9a-fA-F]{2}|%[HPDsan]\b/, 'git format string'],
  [/^(Select-Object|Get-\w+|Where-Object|ConvertTo-\w+|ForEach-Object)\b/, 'shell command'],
  // 터미널 시퀀스 조각. ESC 만 보던 규칙이 레코드 구분자(U+001E)나 OSC 종결,
  // CSI 조립 템플릿, 키 코드를 놓쳤다.
  [/\\x1[0-9a-fA-F]|\\u00[0-1][0-9a-fA-F]/, 'control character'],
  [/^\$\{CSI\}/, 'csi template'],
  [/^\d+;\d+[a-zA-Z~]$/, 'key code'],
  [/^:\d+:/, 'git stage spec'],
  [/^branch\.$/, 'git config section'],
];

function classify(value) {
  for (const [re, why] of NOT_UI) if (re.test(value)) return why;
  return null;
}

// 리터럴이 "값"이 아니라 "코드"로 쓰이는 자리인가 — 비교·분해 대상은 번역하면 로직이 깨진다.
// 예: cmd === 'pick', line.startsWith('diff --git'), text.split(구분자)
const CODE_CONTEXT = /(===|!==|==|!=)\s*$|\.(includes|startsWith|endsWith|indexOf|lastIndexOf|split|replace|replaceAll|match|search|localeCompare)\(\s*$|\bcase\s+$/;
function codeContext(source, literal) {
  const before = source.slice(Math.max(0, literal.index - 40), literal.index);
  return CODE_CONTEXT.test(before);
}

// 템플릿 리터럴의 `${...}` 보간 — t('키') 로 감싸면 보간이 죽고 문자열이 그대로 나온다.
// 이런 자리는 자동 치환에서 빼고, 사람이 인자를 뽑아 {name} 치환으로 옮긴다.
function interpolated(literal) {
  return literal.quote === '`' && /\$\{/.test(literal.value);
}

// JS 리터럴 표기를 실제 문자열 값으로 푼다. 카탈로그는 JSON 이므로 '\u25cf' 가 아니라
// 그 글자 자체를 담아야 한다 — 안 그러면 화면에 백슬래시가 그대로 나온다.
// 풀 수 없는 표기(, 잘못된 이스케이프)는 null 을 돌려주고 자동 치환에서 빠진다.
function decode(literal) {
  let body = literal.value;
  if (literal.quote !== '"') {
    // 작은따옴표/백틱 리터럴을 JSON 문자열 본문으로 옮긴다:
    // \' 는 그냥 ' 이고, 감싸지 않은 " 는 이스케이프해야 한다.
    body = body.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"');
  }
  try {
    const value = JSON.parse('"' + body + '"');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

// 리터럴이 문자열 연결에 참여하는가 — 조각을 따로 번역하면 어순이 깨지므로
// 이런 자리는 자동 치환에서 빼고 사람이 한 문장으로 합친다.
function concatenated(source, literal) {
  const before = source.slice(Math.max(0, literal.index - 3), literal.index);
  const after = source.slice(literal.end, literal.end + 3);
  return /\+\s*$/.test(before) || /^\s*\+/.test(after);
}

module.exports = { root, sourceFiles, literals, classify, concatenated, interpolated, decode, codeContext, NOT_UI };
