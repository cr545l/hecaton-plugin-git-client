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
| `i18n-eager.js` | **로드 시점에 굳는 t()** — 최상위 상수에서 부르면 영어로 고정된다 |
| `i18n-width.js` | 번역이 영어보다 넓어지는 자리 — 폭이 곧 레이아웃인 곳은 게이트 |
| `i18n-len.js` | **표시 폭을 `.length` 로 재는 자리** — 한글은 두 칸이라 절반으로 센다 |
| `i18n-suppress.js` | 규칙으로 못 거르는 자리에 `// i18n-ok: 사유` 를 줄 끝에 단다 |

```bash
node tools/i18n-audit.js                 # 남은 것 세기
node tools/i18n-plan.js > /tmp/plan.json # 계획
node tools/i18n-apply.js /tmp/plan.json  # 적용
node tools/i18n-import.js                # import 맞추기
node tools/i18n-check.js                 # 정합성
node --test test/                        # 회귀
```

## 🚨 t() 는 그리는 시점에 불러야 한다

최상위 상수 안에서 `t()` 를 부르면 **require 되는 순간 한 번** 평가된다. 그때는 호스트
언어가 정해지기 전(`main()` 의 `setLocale` 보다 먼저)이라 **영어로 굳고, 언어를 바꿔도
따라오지 않는다.** 화면에 `7 days` 가 영문으로 남아 있던 원인이 이것이었다.

```js
const FRESH_TIME_WINDOWS = [{ label: t('refresh.7Days') }];         // ✗ 굳는다
const FRESH_TIME_WINDOWS = [{ get label() { return t('…'); } }];    // ✓ 읽을 때 평가
const REASON = { get LOADING() { return t('…'); } };                // ✓ 호출부 무수정
const lockedFileHint = () => t('a') + t('b');                       // ✓ 부를 때 평가
```

객체·배열 프로퍼티는 **getter** 로 바꾸면 호출부(`REASON.LOADING`, `wt.label`)를 건드리지
않아도 된다. 상수 문자열은 함수로 바꾸고 호출부에 `()` 를 붙인다.
`node tools/i18n-eager.js` 가 이 자리를 전부 찾는다.

## 🚨 폭은 `.length` 가 아니라 `visLen()` 이다

한글은 한 글자가 두 칸이다. `label.length` 는 글자 수라 **폭의 절반**으로 세고,
그만큼 버튼이 잘리거나 클릭 존이 어긋난다. 영어에서는 length == 폭이라 번역을 넣기
전까지 드러나지 않는다 — "전체 스테이…" 로 잘리던 진짜 원인이 이것이었다(22곳).

```js
const totalBtnLen = allBtnLabel.length + 1 + btnLabel.length;   // ✗ 절반으로 센다
const totalBtnLen = visLen(allBtnLabel) + 1 + visLen(btnLabel); // ✓
```

문자열 조작(커서 위치·`substring`)의 `.length` 는 **문자 인덱스가 맞다** — 그 자리는
줄 끝에 `// i18n-ok: 문자 인덱스` 를 단다. `node tools/i18n-len.js` 가 둘을 갈라 준다.

## 폭이 곧 레이아웃이다

한글은 한 글자가 두 칸이라 번역이 길어지면 힌트바·상단 버튼이 그대로 잘린다.
`node tools/i18n-width.js` 가 영어 대비 넓어진 폭을 재고, **폭이 빡빡한 자리**
(상단 바·힌트바·패널 헤더, 도구의 `TIGHT_KEYS`)는 +4칸을 넘으면 실패한다.
새 문자열이 그런 자리에 들어가면 `TIGHT_KEYS` 에 키를 추가하세요.

## 번역하면 안 되는 것

자동 분류가 완벽하지 않아 실제로 몇 번 잘못 옮겼습니다. 규칙(`i18n-lib.js` 의 `NOT_UI`)에
반영해 두었지만, 새로 걸리면 `i18n-revert.js` 로 되돌리고 규칙을 함께 보강하세요.

- **git 어휘**: rebase todo 동사(`pick`, `squash`), config 키(`core.quotePath=false`),
  포맷 문자열(`%(refname)`, `%x01%H`), ref 접두사(`refs/heads/`), `HEAD`, `@{u}`
- **비교·분해에 쓰는 값**: `x === 'pick'`, `line.startsWith('diff --git')`, `s.split(...)` —
  `i18n-lib.js` 의 `codeContext` 가 이런 자리를 자동 치환에서 뺍니다
- **길이 계산에 쓰는 값**: `token.substring('tag: '.length)` — 번역문은 길이가 다릅니다
- 셸 명령, 정규식 소스, 단축키 표기(`Ctrl+C`), 그래프 글리프

## 억제 사유는 한 줄씩 정확히 적는다

`// i18n-ok:` 를 **여러 곳에 같은 사유로 일괄** 달면 그 안에 UI 가 섞여도 알아채지 못한다.
실제로 34곳을 "git 문법·터미널 시퀀스·진단 로그" 하나로 묶었다가, 그 안에 있던
커밋 상세 헤더(`Author: `·`Commit: `)가 화면에 영문으로 남아 사용자가 발견했다.
git 출력을 **파싱**하는 것과 git 출력 형식을 **흉내내 그리는 것**은 다르다 — 후자는 UI다.

지금 쓰는 사유는 이 정도로 갈라져 있다: 터미널 제어 시퀀스 / OSC ack / git 인자·포맷 /
git revision·ref·decoration / 셸 명령 / URL 경로 / console 로그 / stderr 진단 /
진단 필드 이름 / 캐시 지문 / 커밋 메시지 관례 형식 / 기호+숫자 표기 / 문자 인덱스.

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
카탈로그는 en/ko 각 711키이며, 단위 테스트 57개와 실기 E2E(ko/en)가 통과합니다.

새 문자열을 넣을 때는 키를 `locale/en.json`·`ko.json` 에 먼저 넣고 `t('키')` 로 씁니다.
커밋 전에 두 게이트를 돌리세요:

```bash
node tools/i18n-audit.js --gate && node tools/i18n-eager.js && node tools/i18n-len.js   && node tools/i18n-width.js --min 99 && node tools/i18n-check.js && node --test test/
```
