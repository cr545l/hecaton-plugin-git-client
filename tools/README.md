# 다국어 도구

화면에 나가는 문자열의 정본은 `locale/en.json` 이고, 다른 언어는 그 부분집합입니다.
런타임은 `i18n.js` (`t('키')`, `t('키', { 값 })`, `{name}` 치환) 이며 호스트 언어를 따릅니다
(API 1.11 — `initialState.locale` 로 시작, `locale_changed` 로 전환).

**눈으로 세지 않습니다.** 18,000줄에서 무엇이 남았는지는 도구가 셉니다.

| 도구 | 하는 일 |
|---|---|
| `i18n-audit.js` | 모든 문자열 리터럴을 `이관됨 / UI 아님 / 검토 필요` 로 분류. `--gate` 로 CI 검사 |
| `i18n-plan.js` | 감사 결과에 키를 붙여 치환 계획(JSON)을 만든다 |
| `i18n-apply.js` | 계획대로 리터럴을 `t('키')` 로 바꾸고 카탈로그에 넣는다 |
| `i18n-join.js` | 연결로 조립되는 문장(`"A" + x + "B"`)을 한 문장 + `{치환}` 으로 합친다 |
| `i18n-unjoin.js` | 합친 것을 원래 연결식으로 되돌린다 |
| `i18n-revert.js` | 잘못 옮긴 키를 원래 리터럴로 되돌린다 |
| `i18n-import.js` | `t()` 를 쓰는데 `require('./i18n')` 가 없는 파일에 넣는다 |
| `i18n-check.js` | 키 집합·자리표시자 일치, 없는 키 호출, 죽은 키, import 누락 |

```bash
node tools/i18n-audit.js                 # 남은 것 세기
node tools/i18n-plan.js > /tmp/plan.json # 계획
node tools/i18n-apply.js /tmp/plan.json  # 적용
node tools/i18n-import.js                # import 맞추기
node tools/i18n-check.js                 # 정합성
node --test test/                        # 회귀
```

## 번역하면 안 되는 것

자동 분류가 완벽하지 않아 실제로 몇 번 잘못 옮겼습니다. 규칙(`i18n-lib.js` 의 `NOT_UI`)에
반영해 두었지만, 새로 걸리면 `i18n-revert.js` 로 되돌리고 규칙을 함께 보강하세요.

- **git 어휘**: rebase todo 동사(`pick`, `squash`), config 키(`core.quotePath=false`),
  포맷 문자열(`%(refname)`, `%x01%H`), ref 접두사(`refs/heads/`), `HEAD`, `@{u}`
- **비교·분해에 쓰는 값**: `x === 'pick'`, `line.startsWith('diff --git')`, `s.split(...)` —
  `i18n-lib.js` 의 `codeContext` 가 이런 자리를 자동 치환에서 뺍니다
- **길이 계산에 쓰는 값**: `token.substring('tag: '.length)` — 번역문은 길이가 다릅니다
- 셸 명령, 정규식 소스, 단축키 표기(`Ctrl+C`), 그래프 글리프

## 함정

- **지역 변수 `t` 가 `t()` 를 가립니다.** `const t = ...` 가 같은 함수에 있으면 TypeError.
  도입 전에 `grep "const t ="` 로 확인하고 지역 변수를 rename 하세요.
- **템플릿 리터럴의 `${...}`** 는 `t()` 로 감싸는 순간 죽습니다. 자동 치환에서 제외되며,
  인자를 뽑아 `{name}` 치환으로 옮겨야 합니다.
- **이스케이프 표기**: 카탈로그는 JSON 이라 `●` 가 아니라 `●` 를 담아야 합니다
  (`decode`). 풀 수 없는 표기(`\x1b`)는 자동 치환에서 빠집니다.
- **`// i18n-ok:` 는 줄 끝에** 답니다. 줄 중간에 끼우면 그 뒤가 통째로 주석이 됩니다.
- 같은 줄에 같은 문자열이 여러 번 나오면 줄+값으로는 자리를 못 찾습니다 — 도구는
  파서가 준 문자 오프셋으로 맞춥니다.

## 현재 상태

`node tools/i18n-audit.js` 기준 **검토 필요 0**, `node tools/i18n-check.js` 정합성 OK.
카탈로그는 en/ko 각 698키이며, 단위 테스트 57개와 실기 E2E(ko/en)가 통과합니다.

새 문자열을 넣을 때는 키를 `locale/en.json`·`ko.json` 에 먼저 넣고 `t('키')` 로 씁니다.
커밋 전에 두 게이트를 돌리세요:

```bash
node tools/i18n-audit.js --gate && node tools/i18n-check.js && node --test test/
```
