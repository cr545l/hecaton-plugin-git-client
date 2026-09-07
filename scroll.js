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
    _hostOffsets.set(p.id, top);
    applyOffset(p.id, top);
    const left = Math.max(0, (p.left_col ?? p.leftCol ?? 0) | 0);
    _hostLeft.set(p.id, left);
    applyLeft(p.id, left);
    if (p.id === 'logList' && _deps.maybeLoadMoreLog) _deps.maybeLoadMoreLog();
    if (_deps.render) _deps.render();
  });
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

function sliceLine(value, start, width) {
  start = Math.max(0, start);
  width = Math.max(0, width);
  const end = start + width;
  let out = '', col = 0, used = 0;
  const tokens = String(value || '').match(/\x1b\[[0-9;]*m|[\s\S]/gu) || [];
  for (const token of tokens) {
    if (token.startsWith('\x1b')) { out += token; continue; }
    const n = isWide(token.codePointAt(0)) ? 2 : 1;
    if (col >= end) break;
    const overlap = Math.max(0, Math.min(end, col + n) - Math.max(start, col));
    if (overlap) { out += overlap === n ? token : ' '.repeat(overlap); used += overlap; }
    col += n;
  }
  return out + ' '.repeat(Math.max(0, width - used)) + '\x1b[0m';
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
