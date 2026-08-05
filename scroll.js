// Host-owned scroll integration (hecaton scroll.region / scroll.update).
//
// The host owns each panel's scroll position: trackpad pixel deltas feed a
// momentum engine host-side (smooth sub-cell movement + macOS-style inertia)
// and the plugin only re-renders at the integer offsets it receives through
// scroll.update. The plugin keeps ownership of:
//  - horizontal scrolling (field-level: file names / diff content scroll while
//    status prefixes and line numbers stay fixed) by declaring
//    content_cols == width, which makes the host pass horizontal wheel through,
//  - programmatic scrolling (keyboard cursor following, jump-to-top on
//    refresh), pushed to the host via scroll.set after each render.
//
// Each region renders 3 overscan bank lines at off-screen buffer rows
// (row above the viewport + 2 rows below) so the host can reveal partial rows
// during sub-cell scrolling, and acknowledges the rendered base offset with an
// in-band OSC 7741 so the host keeps stale frames positioned correctly.
//
// Hosts without the scroll API (no scroll.set in plugin_api_methods.def) fall
// back to the legacy plugin-side SGR wheel handlers untouched.

const { state, ui } = require('./state');

// Fixed off-screen bank slot per region id: bank rows live at
// termRows + slot*3 (0-based), 3 rows each.
const BANK_SLOTS = {
  left: 0,
  files: 1,
  diff: 2,
  logList: 3,
  logDetail: 4,
  freshList: 5,
  freshDetail: 6,
};

let _supported; // undefined = not probed yet
let _deps = null; // { render, maybeLoadMoreLog }

// id -> last sent geometry signature / last offset the host knows about.
const _sentRegions = new Map();
const _hostOffsets = new Map();
// Region ids whose registration the host has CONFIRMED (RPC result received).
// Bank rows live beyond the screen and may only be written once the host has
// enlarged the buffer — writing earlier would clamp onto the last visible row.
// Also stays empty on hosts/harnesses that expose scroll.* but reject it.
const _confirmed = new Set();

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
    const top = Math.max(0, p.topRow | 0);
    _hostOffsets.set(p.id, top);
    applyOffset(p.id, top);
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

// Called once per render with the regions that exist in the current layout.
// Sends scroll.region for new/changed geometry, scroll.set when the plugin
// moved an offset itself (keyboard, clamp, refresh), and scroll.remove for
// regions that disappeared (mode switches).
function syncRegions(defs) {
  if (!isActive()) return;
  const seen = new Set();
  for (const d of defs) {
    seen.add(d.id);
    const sig = d.row + ',' + d.col + ',' + d.width + ',' + d.height + ','
      + d.contentRows + ',' + d.contentCols + ',' + d.overscanRow;
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
        width: d.width,
        height: d.height,
        content_rows: d.contentRows,
        content_cols: d.contentCols,
        overscan_row: d.overscanRow,
      }).then((res) => {
        if (res && !res.error) {
          const wasConfirmed = _confirmed.has(d.id);
          _confirmed.add(d.id);
          // First confirmation of this geometry: re-render so the now-safe
          // bank rows / anchored sixel actually get drawn. Without this the
          // graph stays hidden until some other event triggers a render.
          if (!wasConfirmed && _deps && _deps.render) _deps.render();
        }
      }).catch(() => {});
      // Geometry (re)registration clamps host-side; make sure the host's
      // position matches what this frame actually rendered.
      _hostOffsets.delete(d.id);
    }
    if (_hostOffsets.get(d.id) !== d.off) {
      _hostOffsets.set(d.id, d.off);
      hecaton.scroll.set({ id: d.id, top_row: d.off }).catch(() => {});
    }
  }
  for (const id of Array.from(_sentRegions.keys())) {
    if (!seen.has(id)) {
      _sentRegions.delete(id);
      _hostOffsets.delete(id);
      _confirmed.delete(id);
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
  return ui.termRows + (BANK_SLOTS[id] || 0) * 3;
}

// In-band render ack: tells the host which content row the buffer currently
// holds at the region's first row. Travels through stdout so it is ordered
// with the frame it describes.
function ackString(id, baseRow) {
  return '\x1b]7741;' + id + ';' + baseRow + ';0\x07';
}

module.exports = { isActive, isReady, init, applyOffset, syncRegions, bankRow, ackString, BANK_SLOTS };
