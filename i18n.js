'use strict';
// i18n.js — 플러그인 UI 문자열의 다국어 조회 (호스트 API 1.11)
//
// 호스트는 "어떤 언어인지"만 알려주고 번역 파일 형식·폴백 규칙에는 관여하지 않는다
// (docs/I18N.md §4). 이 플러그인은 호스트 데스크톱과 같은 규약을 작은 규모로 따른다.
//
//   HECA_LOCALE → hecaton.initialState.locale   첫 렌더 전에 RPC 없이 언어를 안다
//   hecaton.i18n.get_locale()                   {locale, language, system_locale, fallbacks}
//   locale_changed 이벤트                       실행 중 언어 변경 → setLocale() → 다시 그린다
//
// 규칙
//  - 정본은 영어(locale/en.json)다. 다른 언어는 영어의 부분집합이며 없는 키는 영어로 나온다.
//  - 키는 평평한 `화면.항목` 꼴. 서식은 `{name}` 치환뿐이다(어순이 다른 언어를 만들 수 있다).
//  - 문자열을 모듈 로드 시점에 상수로 굳히지 않는다. 언어가 바뀌면 그 값이 첫 언어에
//    고정되기 때문이다 — 반드시 그리는 자리에서 t() 를 부른다.

const CATALOGS = {
  en: require('./locale/en.json'),
  ko: require('./locale/ko.json'),
};
const FALLBACK = 'en';
const listeners = [];

let currentTag = FALLBACK;
let table = CATALOGS[FALLBACK];

// "ko-KR" · "KO" · "ko_KR.UTF-8" → 카탈로그가 있는 태그. 못 맞추면 "en".
function resolve(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return FALLBACK;
  const normalized = raw.replace(/_/g, '-').split('.')[0].toLowerCase();
  if (CATALOGS[normalized]) return normalized;
  const language = normalized.split('-')[0];
  return CATALOGS[language] ? language : FALLBACK;
}

// 바뀌었으면 true. 리스너는 그때만 부른다(불필요한 전체 리렌더 방지).
function setLocale(tag) {
  const next = resolve(tag);
  if (next === currentTag) return false;
  currentTag = next;
  table = CATALOGS[next];
  for (const fn of listeners) {
    try { fn(next); } catch { /* 리스너 실패가 렌더를 막지 않게 */ }
  }
  return true;
}

// 현재 언어 → 영어 → 키. 키를 그대로 돌려주는 것이 마지막 폴백이라 화면이 비지 않는다.
function t(key, args) {
  let value = table[key];
  if (value === undefined) value = CATALOGS[FALLBACK][key];
  if (value === undefined) return key;
  if (!args) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : whole);
}

// 영어 원문을 그대로 얻는다 — 번역된 라벨과 별개로 검색어를 영문으로도 받기 위한 뒷문.
function english(key) {
  const value = CATALOGS[FALLBACK][key];
  return value === undefined ? key : value;
}

function has(key) {
  return table[key] !== undefined || CATALOGS[FALLBACK][key] !== undefined;
}

module.exports = {
  t,
  english,
  has,
  setLocale,
  resolve,
  locale: () => currentTag,
  available: () => Object.keys(CATALOGS),
  onChange: (fn) => { listeners.push(fn); },
};
