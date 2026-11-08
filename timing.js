// 동작 시간 기록 — "눌렀는데 한참 걸렸다"를 나중에 재구성하기 위한 기록.
//
// 남기는 것: 사용자 동작의 판정(실행·막힘·예약), 예약이 풀린 시각, 자원을 쥔 작업의
// 시작·끝, git 실행 한 번 한 번의 시간. 커밋 메시지나 파일 이름은 남기지 않는다 —
// git 은 하위 명령과 옵션 이름만, 나머지 인자는 개수만 적는다.
//
// 파일은 저장소의 .git/hecaton-git-client/timing-<인스턴스>.log 다. 이미 조율 파일을 쓰는
// 폴더라 새 권한을 묻지 않는다. 한 번에 쓰는 양을 묶음 하나(CHUNK_LINES 줄)로 묶고,
// 묶음이 차면 .prev.log 로 한 번 옮겨 둔다 — 창마다 최근 두 묶음만 남는다.
const CHUNK_LINES = 500;
const FLUSH_MS = 3000;

let chunk = [];
let dirty = false;
let timer = null;
let flushing = false;

function blockingOps() {
  try {
    const { state } = require('./state');
    return (state.activeOps || []).map(op => (op.label || '?') + ':' + (op.phase || '?'));
  } catch { return []; }
}

function gitCommandOf(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const out = [];
  let rest = 0;
  let sub = false;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!sub && (a === '-c' || a === '-C')) { out.push(a + ' ' + String(list[i + 1] || '').split('=')[0]); i++; continue; }
    if (a === '--') { rest += list.length - i - 1; break; }
    if (a.startsWith('-')) { out.push(a.split('=')[0]); continue; }
    if (!sub) { out.push(a); sub = true; continue; }
    rest++;
  }
  return out.join(' ') + (rest ? ' +' + rest : '');
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

async function flush() {
  timer = null;
  if (!dirty || flushing) return;
  flushing = true;
  dirty = false;
  try {
    const coordinate = require('./coordinate');
    if (chunk.length >= CHUNK_LINES) {
      const full = chunk;
      chunk = [];
      await coordinate.writeTimingLog(full.join('\n') + '\n', 'prev');
    }
    await coordinate.writeTimingLog(chunk.join('\n') + (chunk.length ? '\n' : ''), '');
  } catch { /* 기록은 진단용이다 — 실패해도 동작에 영향을 주지 않는다 */ } finally {
    flushing = false;
    if (dirty) schedule();
  }
}

function record(kind, fields) {
  try {
    chunk.push(JSON.stringify({ t: Date.now(), k: kind, ...fields }));
    dirty = true;
    schedule();
  } catch { /* 진단 기록 실패는 무시한다 */ }
}

module.exports = { record, blockingOps, gitCommandOf, flush };
