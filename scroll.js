// Host-owned scroll integration (hecaton scroll.region / scroll.update).
//
// The host owns each panel's scroll position: trackpad pixel deltas feed a
// momentum engine host-side (smooth sub-cell movement + macOS-style inertia)
// and the plugin only re-renders at the integer offsets it receives through
// scroll.update. Both axes and their scrollbars belong to the host. Keyboard
// cursor following and explicit jumps are sent with scroll.set after rendering.
// API 1.12 reserves the bottom gutter as well as the right gutter.
//
// Each region renders overscan bank lines at off-screen buffer rows (rows above
// the viewport + rows below) so the host can reveal partial rows during sub-cell
// scrolling, and acknowledges the rendered base offset with an in-band OSC 7741
// so the host keeps stale frames positioned correctly.
//
// Bank depth is fixed at registration and declared to the host through
// overscan_before/after. Adjusting it to the scroll speed was tried and is a net
// loss: every change re-registers the region, and until the host confirms we may
// not write bank rows at all, while the host's buffer resize throws away its
// cell cache — so the banks empty out exactly during the fast scroll they were
// meant to help, and the panel flickers on top of that.
//
// No depth can cover a hard fling anyway (it moves far more rows per round-trip
// than any bank holds); the host handles that case by snapping its base and
// showing briefly stale rows rather than blank ones. The depth here just needs
// to absorb ordinary scrolling.
//
// Hosts without the scroll API (no scroll.set in plugin_api_methods.def) fall
// back to legacy vertical wheel handlers; horizontal regions require API 1.12.

const { t } = require('./i18n');
const { state, ui } = require('./state');
const { isWide } = require('./text');

// Fixed off-screen bank slot per region id: bank rows live at
// termRows + slot*BANK_ROWS (0-based), BANK_ROWS rows each.
const BANK_SLOTS = {
  left: 0,
  files: 1,
  diff: 2,
  logList: 3,
  logDetail: 4,
  freshList: 5,
  freshDetail: 6,
};

// Rows above / below the viewport. Deeper than the original 1+2 so ordinary
// wheel and trackpad scrolling stays covered without the host having to fall
// back to stale rows; every extra row costs the host buffer a row it scans each
// frame, so this stays modest.
const BANK_BEFORE = 2;
const BANK_AFTER = 4;
const BANK_ROWS = BANK_BEFORE + BANK_AFTER;
const BANK_DEPTH = { before: BANK_BEFORE, after: BANK_AFTER };

function depthOf() {
  return BANK_DEPTH;
}

let _supported; // undefined = not probed yet
let _deps = null; // { render, maybeLoadMoreLog }

// ── 스크롤 이상 징후 기록 ──
// 호스트가 스크롤을 맡는 동안 플러그인이 그 위치를 덮어쓰거나(scroll.set) 영역을 다시 등록하면
// (scroll.region) 내용이 튄다. 정상적인 순수 스크롤에서는 둘 다 일어나지 않아야 하므로, 일어나면
// 동작 기록(timing 로그)에 남긴다 — 호스트 내부를 볼 수 없어 실제 창에서 원인을 잡는 유일한 단서다.
// 사용자가 키보드·클릭으로 옮긴 경우도 set 이 나가므로, 직전 호스트 갱신과의 간격을 함께 적는다.
const _lastUpdateAt = new Map();
function traceScroll(kind, fields) {
  try { require('./timing').record(kind, fields); } catch { /* 진단 기록 실패는 무시한다 */ }
}

// id -> last sent geometry signature / last offset the host knows about.
const _sentRegions = new Map();
const _hostOffsets = new Map();
const _hostLeft = new Map();
const _definitions = new Map();
// Region ids whose registration the host has CONFIRMED (RPC result received).
// Bank rows live beyond the screen and may only be written once the host has
// enlarged the buffer — writing earlier would clamp onto the last visible row.
// Also stays empty on hosts/harnesses that expose scroll.* but reject it.
const _confirmed = new Set();

// ── 스크롤바를 누가 그리는가 (API 1.10) ──
// scrollbar:'auto' + scrollbar_gutter:'stable' 을 얹어 등록하면 호스트가 스크롤바를
// 직접 그린다 — 관성과 같은 프레임에 픽셀 단위로 움직이므로 플러그인이 sixel 로
// 따라 그리는 것보다 언제나 부드럽고, 드래그·hover 도 호스트가 맡는다.
// 지원 여부는 등록 응답의 scrollbar_cols 에코로만 알 수 있어서 이렇게 간다:
//   모름  → gutter 한 칸을 region 에 얹고 물어본다(호스트가 그리면 그 칸이 스크롤바다)
//   지원  → 그 영역의 sixel 스크롤바를 그리지 않는다
//   미지원 → gutter 를 도로 빼고 재등록한다. 그 칸은 region 밖이라야 sixel 스크롤바가
//           스크롤에 딸려 올라가지 않는다(sixel 은 셀이 아니라 픽셀 오버레이다).
// id -> true(호스트가 그림) | false(직접 그려야 함). 없으면 아직 모름.
const _hostScrollbar = new Map();

// 아직 모르거나 호스트가 그리면 한 칸을 내주고, 미지원이 확인되면 도로 뺀다.
function gutterCols(id) {
  return _hostScrollbar.get(id) === false ? 0 : 1;
}

// 이 영역의 스크롤바를 호스트가 그리는가 — true 면 플러그인은 그리지 않는다.
function hasHostScrollbar(id) {
  return _hostScrollbar.get(id) === true;
}

function isActive() {
  if (_supported === undefined) {
    const s = globalThis.hecaton && hecaton.scroll;
    _supported = !!(s && typeof s.region === 'function' && typeof s.set === 'function'
      && typeof s.remove === 'function');
  }
  return _supported;
}

function init(deps) {
  _deps = deps;
  if (!isActive()) return;
  hecaton.on('scroll.update', (p) => {
    if (!p || typeof p.id !== 'string' || !(p.id in BANK_SLOTS)) return;
    // 페이로드 키는 신규 스네이크(top_row)가 정본이고 camelCase(topRow)는 구 별칭이다.
    // 한쪽만 보면 다른 쪽 호스트에서 undefined|0 === 0 이 되어, 스크롤할 때마다
    // 목록이 맨 위로 튄다 — 둘 다 받는다.
    const raw = p.top_row !== undefined ? p.top_row : p.topRow;
    const top = Math.max(0, raw | 0);
    if (_hostOffsets.get(p.id) !== top) clearHoverFor(p.id);
    _hostOffsets.set(p.id, top);
    applyOffset(p.id, top);
    const left = Math.max(0, (p.left_col ?? p.leftCol ?? 0) | 0);
    _hostLeft.set(p.id, left);
    applyLeft(p.id, left);
    _lastUpdateAt.set(p.id, Date.now());
    if (p.id === 'logList' && _deps.maybeLoadMoreLog) _deps.maybeLoadMoreLog();
    // 곧바로 그린다. 호스트는 받아 둔 여분 줄(bank)로 버티며 이 프레임을 기다린다 — 그리기를 미루면
    // 빠른 스크롤에서 여분을 넘어서 내용이 튈 수 있다(2026-11-18 묶어 그리기를 시도했다 되돌림).
    if (_deps.render) _deps.render();
  });
}

// 호버 강조는 내용이 아니라 화면 위치(마우스 아래 줄)에 붙는다. 호스트가 세로로 스크롤하면 직전
// 프레임의 강조 줄을 내용과 함께 밀었다가, 새 프레임이 제자리에 다시 그려 — 스크롤하는 내내 강조 줄이
// 한 줄씩 튀었다(2026-11-18 재현: 포인터를 목록 위에 둔 채 한 줄 내릴 때마다 두 줄이 바뀜. 휠로 내릴
// 때는 포인터가 늘 목록 위에 있다). 그래서 그 영역의 호버를 걷는다. 마우스가 다시 움직이면 입력 처리가
// 그 자리의 호버를 되살린다.
function clearHoverFor(id) {
  switch (id) {
    case 'left': ui.hoveredLeftPanelRow = -1; break;
    case 'files': ui.hoveredFileRow = -1; break;
    case 'logList': ui.hoveredLogRow = -1; break;
    case 'freshList': ui.hoveredFreshRow = -1; break;
    case 'diff': case 'logDetail': case 'freshDetail':
      ui.hoveredDetailCopyZone = null;
      ui.hoveredFileHeaderIdx = -1;
      ui.hoveredDiffHunkIdx = -1;
      ui.hoveredMergeZoneIndex = -1;
      break;
  }
}

// Single mapping between region ids and the plugin's scroll state. Pins keep
// the renderers' cursor-follow logic from snapping the viewport back to the
// cursor while the host is driving the position.
function applyOffset(target, offset) {
  switch (target) {
    case 'left': ui.leftPanelScrollOffset = offset; break;
    case 'files': state.scrollOffset = offset; ui.filesScrollPin = state.cursor; break;
    case 'diff': state.diffScrollOffset = offset; break;
    case 'logList': state.logScrollOffset = offset; ui.logScrollPin = state.logCursor; break;
    case 'logDetail': state.diffScrollOffset = offset; break;
    case 'freshList': state.freshScrollOffset = offset; ui.freshScrollPin = state.freshCursor; break;
    case 'freshDetail': state.diffScrollOffset = offset; break;
  }
}

function applyLeft(id, left) {
  if (id === 'files') state.filesScrollX = left;
  else if (['diff', 'logDetail', 'freshDetail'].includes(id)) state.diffScrollX = left;
}

function moveHorizontal(id, delta) {
  const d = _definitions.get(id);
  if (!isActive() || !d) return;
  const current = id === 'files' ? state.filesScrollX : state.diffScrollX;
  const left = Math.max(0, Math.min(d.contentCols - d.width, current + delta));
  applyLeft(id, left);
  _hostLeft.set(id, left);
  hecaton.scroll.set({ id, left_col: left }).catch(() => {});
}

// 보이는 칸이 끝나면 멈춘다 — 줄 전체를 글자 단위로 쪼개지 않는다. 예전에는 줄 전체를 정규식으로
// 토큰 배열로 만든 뒤 앞쪽만 썼다. 한 줄짜리 생성 파일(2026-11-18 Com2uX 의 adminScreenMessages.json,
// 55만 자)을 건드린 커밋을 고르면 상세 패널의 줄이 모두 그 폭까지 채워져, 그리기 한 번에 보이는
// 줄 수 × 55만 개의 토큰을 만들었다(JIT 없는 Node 로 한 프레임 250ms, QuickJS 는 그보다 느리다).
// 결과는 종전과 같다: SGR(ESC[…m)과 홀로 선 ESC 는 칸을 차지하지 않고, 보이는 칸이 끝난 뒤의
// 첫 글자에서 멈추며(그 앞의 ESC 시퀀스는 담는다), 넓은 글자가 경계에 걸리면 공백으로 채운다.
function sliceLine(value, start, width) {
  start = Math.max(0, start);
  width = Math.max(0, width);
  const end = start + width;
  const text = String(value || '');
  let out = '', col = 0, used = 0, i = 0;
  while (i < text.length) {  // i18n-ok: 문자 인덱스(커서·substring) — 표시 폭이 아니다
    if (text.charCodeAt(i) === 0x1b) {
      const seqEnd = sgrEnd(text, i);
      out += text.substring(i, seqEnd);
      i = seqEnd;
      continue;
    }
    if (col >= end) break;
    const cp = text.codePointAt(i);
    const units = cp > 0xFFFF ? 2 : 1;
    const n = isWide(cp) ? 2 : 1;
    const overlap = Math.max(0, Math.min(end, col + n) - Math.max(start, col));
    if (overlap) { out += overlap === n ? text.substring(i, i + units) : ' '.repeat(overlap); used += overlap; }
    col += n;
    i += units;
  }
  return out + ' '.repeat(Math.max(0, width - used)) + '\x1b[0m';
}

// text[i] 가 ESC 일 때 그 시퀀스가 끝나는 위치. SGR(ESC [ 숫자·; m)이면 m 다음, 아니면 ESC 한 글자.
function sgrEnd(text, i) {
  if (text.charCodeAt(i + 1) !== 0x5b) return i + 1;
  let j = i + 2;
  while (j < text.length) {  // i18n-ok: 문자 인덱스(커서·substring) — 표시 폭이 아니다
    const c = text.charCodeAt(j);
    if ((c >= 0x30 && c <= 0x39) || c === 0x3b) j++;
    else break;
  }
  return text.charCodeAt(j) === 0x6d ? j + 1 : i + 1;
}

function bankCol(id) { return ui.termCols + (BANK_SLOTS[id] || 0) * BANK_ROWS; }

// Called once per render with the regions that exist in the current layout.
// Sends scroll.region for new/changed geometry, scroll.set when the plugin
// moved an offset itself (keyboard, clamp, refresh), and scroll.remove for
// regions that disappeared (mode switches).
function syncRegions(defs) {
  if (!isActive()) return;
  const seen = new Set();
  for (const d of defs) {
    seen.add(d.id);
    _definitions.set(d.id, d);
    // d.width 는 글자가 들어가는 폭이다. 스크롤바 한 칸(gutter)은 여기서 얹는다 —
    // 얹느냐 마느냐가 지오메트리를 바꾸므로 시그니처에도 함께 넣어야, 미지원이
    // 확인됐을 때 도로 뺀 폭으로 재등록이 걸린다.
    const gutter = gutterCols(d.id);
    const gutterRows = d.contentCols > d.width ? 1 : 0;
    const sig = d.row + ',' + d.col + ',' + d.width + ',' + d.height + ','
      + d.contentRows + ',' + d.contentCols + ',' + d.overscanRow + ',' + gutter + ',' + gutterRows + ',' + d.overscanCol;
    if (_sentRegions.get(d.id) !== sig) {
      const prevSig = _sentRegions.get(d.id);
      if (prevSig !== undefined) {
        const since = _lastUpdateAt.has(d.id) ? Date.now() - _lastUpdateAt.get(d.id) : -1;
        traceScroll('scroll-region', { id: d.id, from: prevSig, to: sig, sinceUpdateMs: since });
      }
      _sentRegions.set(d.id, sig);
      // Geometry changed (resize/font/layout): the previous confirmation no
      // longer describes the buffer the host holds. Drop it so isReady() is
      // false until the host confirms the NEW geometry — otherwise bank rows
      // and the bank-anchored graph sixel get written to off-screen buffer
      // rows the host hasn't enlarged yet, and the graph vanishes.
      _confirmed.delete(d.id);
      hecaton.scroll.region({
        id: d.id,
        row: d.row,
        col: d.col,
        width: d.width + gutter,
        height: d.height + gutterRows,
        content_rows: d.contentRows,
        content_cols: d.contentCols,
        overscan_row: d.overscanRow,
        overscan_col: d.overscanCol,
        overscan_before_col: BANK_BEFORE,
        overscan_after_col: BANK_AFTER,
        overscan_before: BANK_BEFORE,
        overscan_after: BANK_AFTER,
        // 스크롤바는 호스트가 그리는 편이 언제나 부드럽다. 모르는 필드는 무시되므로
        // 구버전 호스트에 보내도 해가 없고, 응답의 에코로 지원 여부를 가린다.
        scrollbar: 'auto',
        scrollbar_gutter: 'stable',
      }).then((res) => {
        if (res && !res.error) {
          const wasConfirmed = _confirmed.has(d.id);
          _confirmed.add(d.id);
          // 스크롤바를 호스트가 맡았는지 — 에코된 scrollbar_cols 로만 알 수 있다.
          // 미지원으로 판정되면 다음 sync 에서 gutter 를 뺀 폭으로 재등록되고,
          // 그 칸은 region 밖이 되어 예전처럼 sixel 스크롤바를 그릴 수 있다.
          const hostDraws = res.scrollbar_cols === 1;
          const wasHost = _hostScrollbar.get(d.id);
          _hostScrollbar.set(d.id, hostDraws);
          if ((!wasConfirmed || wasHost !== hostDraws) && _deps && _deps.render) _deps.render();
          return;
        }
      }).catch(() => {});
      // Geometry (re)registration clamps host-side; make sure the host's
      // position matches what this frame actually rendered.
      _hostOffsets.delete(d.id);
      _hostLeft.delete(d.id);
    }
    const left = d.left || 0;
    if (_hostOffsets.get(d.id) !== d.off || _hostLeft.get(d.id) !== left) {
      // 호스트가 알던 위치를 바꾼다. 방금(1초 안) 호스트가 스크롤을 갱신한 영역이면 튐의 후보다.
      if (_hostOffsets.has(d.id) && _lastUpdateAt.has(d.id) && Date.now() - _lastUpdateAt.get(d.id) < 1000) {
        traceScroll('scroll-set', { id: d.id, top: d.off, host: _hostOffsets.get(d.id), left, hostLeft: _hostLeft.get(d.id),
          sinceUpdateMs: Date.now() - _lastUpdateAt.get(d.id) });
      }
      _hostOffsets.set(d.id, d.off);
      _hostLeft.set(d.id, left);
      hecaton.scroll.set({ id: d.id, top_row: d.off, left_col: left }).catch(() => {});
    }
  }
  for (const id of Array.from(_sentRegions.keys())) {
    if (!seen.has(id)) {
      _sentRegions.delete(id);
      _hostOffsets.delete(id);
      _hostLeft.delete(id);
      _definitions.delete(id);
      _confirmed.delete(id);
      // _hostScrollbar 는 남겨 둔다 — 호스트가 스크롤바를 그리는지는 세션 내내 같은
      // 답이므로, 탭을 오갈 때마다 다시 물어보면 그때마다 재등록이 한 번씩 더 돈다.
      // 제거는 프레임(stdout)과 순서가 보장되지 않는 비동기 RPC다. 제거가 확정되기 전에
      // 호스트가 region을 한 번 더 합성하면 방금 그린 화면 위에 이전 내용이 덮인다
      // (특히 bank 앵커 그래프 sixel — Commits → Local 전환 후 브랜치 트리 잔상).
      // 제거가 끝난 뒤 한 프레임 다시 그려 그 영역을 확실히 덮는다.
      hecaton.scroll.remove({ id }).then(() => {
        if (_deps && _deps.render) _deps.render();
      }).catch(() => {});
    }
  }
}

// True once the host has confirmed the region: only then is the enlarged
// buffer guaranteed, so bank rows / acks / bank-anchored sixels are safe.
function isReady(id) {
  return _confirmed.has(id);
}

// 0-based buffer row of a region's first bank line.
function bankRow(id) {
  return ui.termRows + (BANK_SLOTS[id] || 0) * BANK_ROWS;
}

// Bank lines for a region, in the order the host expects: BANK_BEFORE rows above
// the viewport (topmost first) then BANK_AFTER rows below it.
//   getLine(contentIndex) -> rendered line (may be undefined past the ends)
function buildBank(id, getLine, off, height) {
  const out = [];
  for (let i = BANK_BEFORE; i >= 1; i--) out.push(getLine(off - i) || '');
  for (let i = 0; i < BANK_AFTER; i++) out.push(getLine(off + height + i) || '');
  return out;
}

// In-band render ack: tells the host which content row the buffer currently
// holds at the region's first row. Travels through stdout so it is ordered
// with the frame it describes.
function ackString(id, baseRow, baseCol = 0) {
  return '\x1b]7741;' + id + ';' + baseRow + ';' + baseCol + '\x07';  // i18n-ok: OSC ack 시퀀스
}

module.exports = {
  isActive, isReady, hasHostScrollbar, init, applyOffset, syncRegions,
  bankCol, sliceLine, moveHorizontal, bankRow, buildBank, depthOf, ackString, BANK_SLOTS,
};
