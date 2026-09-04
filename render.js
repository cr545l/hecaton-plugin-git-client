const { CSI, ansi, colors, seriePalette } = require('./ansi');
const { SIXEL_ENABLED, SIXEL_PALETTE, SCROLLBAR_PALETTE, SCROLLBAR_HOVER_PALETTE, SCROLLBAR_ACTIVE_PALETTE, renderScrollbarPixels, renderHScrollbarPixels, renderCombinedGraphPixels, encodeSixel, encodeSixelClear } = require('./sixel');
const { visLen, padRight, truncate, viewport, sliceByWidth, stripAnsi, expandTabs, isDiffFileHeaderLine } = require('./text');
const { state, ui, isPinnedBranch, localRefKey, remoteRefKey, isFilteredRef, isHiddenRef } = require('./state');
const { buildFileList, selectedItem, selectedLogRef, FRESH_TIME_WINDOWS, currentBranchRemote, branchRemoteFor, formatDateTime } = require('./refresh');
const { highlightCode, getLanguage } = require('./highlighter');
const hostScroll = require('./scroll');
const persist = require('./persist');
const { panelLoadingLabel } = require('./spinner');
const actions = require('./actions');
const queue = require('./queue');

// ── 버튼 스타일의 단일 규칙 ──
// 지금 눌러도 되는 버튼만 평상시 기본 전경색으로 그리고, 막힌 버튼은 흐리게(dim) 둔다.
// hover 강조도 활성일 때만 얹는다 — 딤드인데 마우스에 반응하면 눌리는 것처럼 읽힌다.
// enabledStyle 을 넘기면 활성 평상시 색을 그걸로 바꾼다(카운트가 붙은 Pull/Push 등).
function buttonStyle(enabled, hovered, enabledStyle, hoverStyle) {
  if (!enabled) return colors.disabled;
  if (hovered) return hoverStyle || (colors.value + ansi.bold + CSI + '4m');
  return enabledStyle || colors.value;
}

// ── 예약까지 함께 보는 버튼 ──
// 상태가 셋이다: 지금 눌리는가(평상시 색), 눌러 뒀고 곧 나가는가(cyan), 아예 안 되는가
// (dim). 예약된 것을 dim 으로 그리면 무시된 것처럼 읽히고, 예약으로 받아질 것을 dim 으로
// 그리면 "못 누르는 줄 알았는데 되더라"가 된다 — 그래서 판정도 isActionable 쪽을 본다.
function actionStyle(action, hovered, enabledStyle, hoverStyle) {
  if (queue.hasFor(action)) {
    return hovered ? colors.cursorBg + colors.cyan + ansi.bold + CSI + '4m' : colors.cyan + ansi.bold;
  }
  return buttonStyle(caps().isActionable(action), hovered, enabledStyle, hoverStyle);
}

// 클릭존에 실을 값 — 예약으로 받아지는 버튼은 클릭을 계속 받아야 한다.
function actionClickable(action) {
  return caps().isActionable(action) || queue.hasFor(action);
}

// 목록의 선택 줄 배경. 포커스가 diff/detail 쪽으로 가도 선택 자체는 그대로 두고 흐리게만
// 그린다 — 고른 대상이 바뀐 게 아니므로 표시가 사라지면 "선택이 풀렸다"로 읽힌다.
function listCursorBg() {
  return state.focusPanel === 'status' ? colors.cursorBg : colors.cursorBgInactive;
}

const RECOVERY_TEXT = ansi.dim + ansi.fg(160, 160, 160);
const STASH_TEXT = CSI + '38;5;249m'; // ANSI 256 palette #249 (~#b2b2b2)

function buildCommitterHint(maxWidth) {
  if (!state.isGitRepo || maxWidth < 12) return { content: '', width: 0, zones: [] };

  const name = state.committerName || '(no name)';
  const email = state.committerEmail || '(no email)';
  const nameTag = state.committerNameIsLocal ? '[L] ' : '';
  const emailTag = state.committerEmailIsLocal ? '[L] ' : '';
  const prefix = maxWidth >= 32 ? ' Committer: ' : ' ';
  const nameReset = state.committerNameIsLocal ? '\u00D7' : '';
  const emailReset = state.committerEmailIsLocal ? '\u00D7' : '';
  const fixedWidth = visLen(prefix) + visLen(nameTag) + visLen(nameReset)
    + 1 + 2 + visLen(emailTag) + visLen(emailReset);
  const fieldBudget = maxWidth - fixedWidth;
  if (fieldBudget < 4) return { content: '', width: 0, zones: [] };

  const nameWidth = visLen(name);
  const emailWidth = visLen(email);
  let nameBudget = Math.min(nameWidth, Math.max(2, Math.floor(fieldBudget * 0.4)));
  let emailBudget = Math.min(emailWidth, Math.max(2, fieldBudget - nameBudget));
  let remaining = fieldBudget - nameBudget - emailBudget;
  if (remaining > 0) {
    const nameExtra = Math.min(remaining, nameWidth - nameBudget);
    nameBudget += nameExtra;
    remaining -= nameExtra;
    emailBudget += Math.min(remaining, emailWidth - emailBudget);
  }

  const shownName = truncate(name, nameBudget);
  const shownEmail = truncate(email, emailBudget);
  const zones = [];
  let content = colors.dim + prefix + ansi.reset;
  let offset = visLen(prefix);

  // 이름/이메일 편집과 초기화는 git config 를 고치는 쓰기 동작이다 — 다른 작업이 도는
  // 동안에는 다른 버튼과 같은 규칙으로 흐려지고 hover 에도 반응하지 않아야 한다.
  function appendZone(label, action, normalStyle, hoverStyle) {
    const labelWidth = visLen(label);
    const on = caps().isEnabled(action);
    const style = buttonStyle(on, ui.hoveredCommitterAction === action, normalStyle, hoverStyle);
    zones.push({ offset, width: labelWidth, action, enabled: on });
    content += style + label + ansi.reset;
    offset += labelWidth;
  }

  // 리포 로컬 설정은 cyan 으로 구분하고, 전역 설정을 그대로 쓰는 값은 기본 전경색으로 둔다.
  // 예전에는 이쪽도 dim 이라 "지금 못 누른다"와 구분이 되지 않았다 — 비활성 표시가 dim 인 이상
  // 활성 평상시 색은 dim 보다 진해야 한다. 앞의 ' Committer: ' 라벨은 그대로 dim 이라
  // 이 줄이 부가 정보라는 인상은 유지된다.
  appendZone(
    nameTag + shownName,
    'committer-name',
    state.committerNameIsLocal ? colors.cyan : colors.value,
    colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
  );
  if (nameReset) {
    appendZone(nameReset, 'reset-committer-name', colors.red, colors.cursorBg + colors.red + ansi.bold);
  }
  content += ' ';
  offset += 1;
  appendZone(
    '<' + emailTag + shownEmail + '>',
    'committer-email',
    state.committerEmailIsLocal ? colors.cyan : colors.value,
    colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
  );
  if (emailReset) {
    appendZone(emailReset, 'reset-committer-email', colors.red, colors.cursorBg + colors.red + ansi.bold);
  }

  return { content, width: offset, zones };
}

// 힌트바 왼쪽 조각 잇기 — 앞에서부터 폭이 허용하는 만큼만 붙인다.
// alt를 주면 원래 표기가 안 들어갈 때 더 짧은 표기로 물러난다(예: 이름+이메일 → 이름).
// 첫 조각(식별자)조차 못 들어가면 힌트 자체를 포기해 반쪽짜리 문구를 남기지 않는다.
function joinHintParts(parts, maxWidth) {
  let content = '';
  let width = 0;
  for (const part of parts) {
    if (!part) continue;
    const sep = width > 0 ? '  ' : ' ';
    for (const text of [part.text, ...(part.alt || [])]) {
      if (!text) continue;
      const need = visLen(sep) + visLen(text);
      if (width + need > maxWidth) continue;
      content += sep + (part.style || '') + text + ansi.reset;
      width += need;
      break;
    }
  }
  return width > 0 ? content : null;
}

// 히스토리 힌트 — 마우스를 올린 리비전(없으면 현재 선택된 리비전)의 요약을
// 힌트바 왼쪽에 해시 / 커밋일시 / 커미터 순으로 미리 보여준다.
function buildRevisionHint(maxWidth) {
  if (state.rightView !== 'log') return null;

  let item = null;
  const hoverRow = ui.hoveredLogRow;
  if (hoverRow >= 0) {
    const hovered = state.logItems[state.logScrollOffset + hoverRow];
    if (hovered && hovered.type === 'commit') item = hovered;
  }
  if (!item) item = selectedLogRef();
  if (!item) return null;

  const hash = item.ref || (item.hash || '').substring(0, 7);
  if (!hash) return null;
  const dateStr = item.committerDate || item.authorDate;
  const name = item.committerName || item.authorName || '';
  const email = item.committerEmail || item.authorEmail || '';

  return joinHintParts([
    { text: hash, style: item.isRecovery ? RECOVERY_TEXT : colors.yellow },
    { text: dateStr ? formatDateTime(dateStr) : '', style: colors.dim },
    { text: email ? name + ' <' + email + '>' : name, alt: [name], style: colors.dim },
  ], maxWidth);
}

// Status 힌트 — 좌측 패널에서 마우스를 올린 줄의 정보를 힌트바에 편다.
// 패널은 폭이 좁아 표기를 접어두는 곳이 많다(추적 리모트, 밀린/뒤처진 커밋 수,
// 워크트리 경로). 그 접힌 정보를 여기서 풀어 보여준다.
function buildStatusHint(maxWidth) {
  if (!state.isGitRepo) return null;
  const row = ui.hoveredLeftPanelRow;
  if (row < 0 || row >= ui.leftPanelClickMap.length) return null;
  const entry = ui.leftPanelClickMap[row];
  if (!entry) return null;

  if (entry.action === 'goto-branch') {
    return buildBranchHint(entry.branch, maxWidth);
  }
  if (entry.action === 'goto-worktree') {
    const wt = state.worktrees.find(w => w.path === entry.path);
    if (!wt) return null;
    const label = wt.isDetached ? 'detached' : wt.branch ? wt.branch : '';
    const flags = [wt.isMain ? 'main' : '', wt.isLocked ? 'locked' : '', wt.isPrunable ? 'prunable' : '']
      .filter(Boolean).join(', ');
    return joinHintParts([
      { text: label, style: wt.isDetached ? colors.dim : colors.value + ansi.bold },
      { text: wt.path, style: colors.dim },
      { text: flags ? '[' + flags + ']' : '', style: colors.dim },
    ], maxWidth);
  }
  if (entry.action === 'goto-stash') {
    const s = state.stashes.find(x => x.shortHash === entry.shortHash);
    if (!s) return null;
    return joinHintParts([
      { text: s.shortHash || '', style: colors.yellow },
      { text: s.ref || '', style: STASH_TEXT },
      { text: s.message || '', style: colors.dim },
    ], maxWidth);
  }
  return null;
}

// 브랜치 한 줄 요약 — 이름 / 추적 리모트 / push·pull 대기 커밋 순으로 놓는다.
function buildBranchHint(name, maxWidth) {
  if (!name) return null;
  const local = state.branches.find(b => b.name === name);

  if (!local) {
    // 리모트 추적 브랜치 — 이 리모트를 따라가는 로컬 브랜치가 있으면 함께 보여준다.
    if (!state.remoteBranches.includes(name)) return null;
    const tracker = state.branches.find(b => b.upstream === name);
    return joinHintParts([
      { text: name, style: colors.red + ansi.bold },
      { text: tracker ? '← ' + tracker.name : '', style: colors.value },
      { text: tracker ? '' : 'not tracked by a local branch', style: colors.dim },
    ], maxWidth);
  }

  // 현재 브랜치의 ahead/behind는 push/pull 직후 낙관적으로 갱신되는 state 쪽이 더 최신이다.
  const ahead = local.isCurrent ? state.ahead : local.ahead || 0;
  const behind = local.isCurrent ? state.behind : local.behind || 0;
  // upstream을 지정하지 않았어도 같은 이름의 리모트 브랜치가 있으면 패널이 @리모트로
  // 표시한다(currentBranchRemote). 힌트에서도 같은 기준으로 짚어준다.
  const guessedRemote = local.isCurrent && !local.upstream ? currentBranchRemote() : '';
  const upstream = local.upstream || (guessedRemote ? guessedRemote + '/' + local.name : '');
  const holder = state.worktrees.find(w => !w.isCurrent && w.branch === local.name);

  let track;
  if (local.upstreamGone) track = { text: '[gone]', style: colors.red + ansi.bold };
  else if (ahead > 0 || behind > 0) {
    track = {
      text: (ahead > 0 ? 'push ↑' + ahead + (behind > 0 ? '  ' : '') : '') + (behind > 0 ? 'pull ↓' + behind : ''),
      style: colors.orange + ansi.bold,
    };
  } else if (upstream) track = { text: 'up to date', style: colors.dim };
  else track = { text: 'local only', style: colors.dim };

  return joinHintParts([
    { text: name, style: local.isCurrent ? colors.green + ansi.bold : colors.value },
    { text: upstream ? '→ ' + upstream + (local.upstream ? '' : ' (not set)') : '', style: colors.red },
    track,
    { text: holder ? '[worktree: ' + holder.path + ']' : '', style: colors.cyan },
  ], maxWidth);
}

// Layout 전환 감지 — sixel은 텍스트 redraw로 지워지지 않아 잔상이 남는다.
// rightView/minimize/패널 collapse/터미널 크기 변화 시점에 한 번 화면을 erase해서
// 이전 sixel(그래프, 스크롤바)을 강제로 제거한다. 일반 redraw는 그대로 둬 깜빡임을 피한다.
let _lastLayoutSig = '';
function computeLayoutSig() {
  return [
    state.minimized ? 'mini' : 'norm',
    state.rightView || 'diff',
    ui.leftPanelCollapsed ? '1' : '0',
    ui.middlePanelCollapsed ? '1' : '0',
    ui.rightPanelCollapsed ? '1' : '0',
    ui.rightTopCollapsed ? '1' : '0',
    ui.rightBottomCollapsed ? '1' : '0',
    ui.logSortMode,
    ui.logShowRecovery ? '1' : '0',
    ui.fileTreeView ? '1' : '0',
    ui.termCols,
    ui.termRows,
  ].join('|');
}

function appendLogSixelClear(buf) {
  if (!SIXEL_ENABLED || !ui.logSixelRegion) return;
  const r = ui.logSixelRegion;
  // bank 행은 호스트가 버퍼를 늘려 둔 동안에만 쓸 수 있다. 확인이 풀린 뒤에 쓰면 마지막
  // 보이는 행으로 클램프돼 화면 하단에 지우개 자국이 남으므로, 그때는 기록만 버린다.
  if (r.anchorBank && !hostScroll.isReady('logList')) { ui.logSixelRegion = null; return; }
  buf.push(ansi.reset + ansi.moveTo(r.screenRow, r.screenCol) + encodeSixelClear(r.pixelW, r.pixelH));
  ui.logSixelRegion = null;
}

// 한 프레임 안에서 재사용하는 활성/비활성 판정. 버튼이 열 개 남짓이라 상황 스냅샷을
// 매번 새로 계산할 이유가 없다. 프레임이 끝나면 비워, 패널 빌더를 단독 호출할 때는
// 항상 최신 상태로 다시 계산되게 한다.
let frameCaps = null;
function caps() {
  if (!frameCaps) frameCaps = actions.context();
  return frameCaps;
}

function render() {
  // 모든 상태 변경은 render를 거치므로 여기서 영속화 디바운스를 건다
  persist.schedule();
  frameCaps = actions.context();
  try {
    renderBody();
  } finally {
    frameCaps = null;
  }
}

function renderBody() {
  if (state.minimized) {
    const clearBuf = [];
    appendLogSixelClear(clearBuf);
    if (clearBuf.length > 0) process.stdout.write(clearBuf.join(''));
    renderMinimized();
    _lastLayoutSig = computeLayoutSig();
    hostScroll.syncRegions([]); // minimized: drop regions so wheel reaches the terminal
    return;
  }

  const cols = ui.termCols;
  const rows = ui.termRows;
  const width = cols;
  const height = rows;
  const startCol = 1;
  const startRow = 1;

  const buf = [];
  buf.push(ansi.hideCursor + CSI + '?7l');

  // Host-owned scroll: panel builders register their scrollable areas (plus
  // overscan bank content) here; banks/acks/regions are emitted after the body.
  ui.hostScrollRegions = [];

  // Layout 전환 시 화면 강제 erase — sixel 잔상 제거.
  // 단 2J는 "보이는 화면"만 지운다. host-scroll이 켜져 있으면 그래프 sixel은 화면 밖
  // overscan bank 행에 그려두고 호스트가 그걸 region 안으로 합성하는 구조라, 2J로는
  // 원본 픽셀이 지워지지 않는다. region 해제(scroll.remove)는 프레임과 순서가 보장되지
  // 않는 비동기 RPC라 그 사이 호스트가 한 번 더 합성하면 새 화면 위에 그래프가 그대로
  // 남는다(Commits → Local 전환 후 브랜치 트리 잔상). bank 앵커일 때는 영역 기록을
  // 남겨 뒤의 sixel emit에서 bank 행에 지우개를 쏘게 한다.
  //
  // 화면 안에 앵커한 그래프(스크롤이 불가능한 짧은 목록)도 2J로는 지워지지 않는다 —
  // 2J가 비우는 건 텍스트 셀이고, 호스트가 들고 있는 sixel 이미지는 그대로 남는다.
  // 여기서 같은 자리에 지우개를 먼저 쏘고 그 위에 새 화면 텍스트를 그린다. 뒤의 sixel
  // emit 단계에 맡기지 않는 건 그쪽은 본문 텍스트 뒤라, 지우개가 새 화면 위에 얹히기
  // 때문이다.
  const layoutSig = computeLayoutSig();
  if (layoutSig !== _lastLayoutSig) {
    buf.push(CSI + '2J');
    _lastLayoutSig = layoutSig;
    if (ui.logSixelRegion && !ui.logSixelRegion.anchorBank) appendLogSixelClear(buf);
  }
  // 매 프레임 무조건 이전 graph sixel을 지우던 코드는 제거했다. 지우개→텍스트→새 sixel을
  // 프레임마다 반복하면 호스트가 중간 상태를 그릴 때 그래프가 깜빡인다. 실제로 이전 영역을
  // 지워야 하는 경우(그래프 폭/높이 축소·위치 이동·그래프 사라짐)만 아래 sixel emit에서
  // 새 지오메트리와 비교해 targeted clear를 쏜다.

  const H = '\u2500', V = '\u2502', CROSS = '\u253c';
  const T_DOWN = '\u252c', T_UP = '\u2534', T_RIGHT = '\u251c', T_LEFT = '\u2524';

  const repoSetupMode = !state.loading && !state.isGitRepo;
  const leftW = repoSetupMode
    ? 0
    : ui.leftPanelCollapsed
    ? 0
    : Math.max(1, Math.min(width - 4, Math.floor(width * ui.verticalDividerRatio)));
  const divider1W = repoSetupMode || ui.leftPanelCollapsed ? 0 : 1;
  const remaining = width - leftW - divider1W;

  // Layout depends on view mode
  let middleW, divider2W, rightW;
  if (repoSetupMode) {
    // 저장소를 고르기 전에는 패널 레이아웃 대신 전체 폭의 설정 화면을 쓴다.
    middleW = 0;
    divider2W = 0;
    rightW = width;
  } else if (state.rightView === 'log' || state.rightView === 'fresh') {
    // 2-column: left | right (history+detail top/bottom)
    middleW = 0;
    divider2W = 0;
    rightW = remaining;
  } else if (ui.middlePanelCollapsed && ui.rightPanelCollapsed) {
    middleW = 0; divider2W = 0; rightW = 0;
  } else if (ui.middlePanelCollapsed) {
    middleW = 0; divider2W = 0; rightW = remaining;
  } else if (ui.rightPanelCollapsed) {
    middleW = remaining; divider2W = 0; rightW = 0;
  } else {
    // 3-column: left | middle (files) | right (diff+commit)
    middleW = Math.max(1, Math.min(remaining - 2, Math.floor(remaining * ui.filesDividerRatio)));
    divider2W = 1;
    rightW = Math.max(1, remaining - middleW - divider2W);
  }

  const titleRows = 1;
  const bodyH = height - (titleRows + 1);  // title row + separator
  const contentH = Math.max(0, bodyH - 2);
  const hintRow = startRow + height - 1;
  const sepRow = startRow + height - 2;
  const titleDividerOffsets = [];

  // -- Title row (rendered after body so scrollPct is available) --
  function buildTitleRows() {
    ui.titleClickZones = [];
    let zoneIdx = 0;

    const zoneStyle = (idx, collapsed) => {
      if (idx === ui.hoveredTitleZoneIndex) return colors.value + ansi.bold + CSI + '4m';
      return collapsed ? colors.dim : colors.title + ansi.bold;
    };

    if (repoSetupMode) {
      let row = ansi.moveTo(startRow, startCol);
      let col = startCol;
      const heading = ' Git Setup ';
      row += colors.cyan + ansi.bold + ansi.inverse + heading + ansi.reset;
      col += visLen(heading);

      const setupActions = [
        { label: ' Initialize Here ', action: 'tab_init' },
        { label: ' Open Repository... ', action: 'tab_change_repo' },
        { label: ' Clone Repository... ', action: 'tab_clone' },
      ];
      for (const item of setupActions) {
        if (col + visLen(item.label) > startCol + width) break;
        const idx = zoneIdx++;
        const on = caps().isEnabled(item.action);
        ui.titleClickZones.push({
          row: startRow,
          colStart: col,
          colEnd: col + visLen(item.label) - 1,
          action: item.action,
          enabled: on,
        });
        row += buttonStyle(on, idx === ui.hoveredTitleZoneIndex,
          colors.value, colors.cursorBg + colors.value + ansi.bold + CSI + '4m')
          + item.label + ansi.reset;
        col += visLen(item.label);
      }
      return row + ' '.repeat(Math.max(0, startCol + width - col));
    }

    // Build right-side panel buttons string first to know its width
    let rightParts = []; // { label, action, collapsed }
    rightParts.push({ label: (ui.leftPanelCollapsed ? ' + ' : ' - ') + 'Status', action: 'toggleStatus', collapsed: ui.leftPanelCollapsed });
    if (state.rightView === 'log' || state.rightView === 'fresh') {
      // 접기 버튼(Status/Detail)을 먼저, 모드 토글(Sort)은 Diff 토글과 같이 맨 뒤에 둔다.
      if (state.rightView === 'fresh') {
        rightParts.push({ label: (ui.rightTopCollapsed ? '  + ' : '  - ') + 'Files', action: 'toggleHistory', collapsed: ui.rightTopCollapsed });
      }
      rightParts.push({ label: (ui.rightBottomCollapsed ? '  + ' : '  - ') + 'Detail', action: 'toggleDetail', collapsed: ui.rightBottomCollapsed });
      if (state.rightView === 'log') {
        rightParts.push({ label: '  Sort: ' + (ui.logSortMode === 'date' ? 'date' : 'branch'), action: 'toggleLogSort', collapsed: false });
        // 꺼져 있으면 흐리게 — 목록에서 뭔가 빠진 상태라는 걸 버튼만 보고 알 수 있어야 한다.
        rightParts.push({
          label: '  Recovery: ' + (ui.logShowRecovery ? 'on' : 'off'),
          action: 'toggleLogRecovery',
          collapsed: !ui.logShowRecovery,
        });
      }
    } else {
      rightParts.push({ label: (ui.middlePanelCollapsed ? '  + ' : '  - ') + 'Stage', action: 'toggleFiles', collapsed: ui.middlePanelCollapsed });
      // 파일 목록을 트리로 볼지 — Diff 토글과 같은 성격(보는 방식)이라 나란히 둔다.
      rightParts.push({ label: '  Files: ' + (ui.fileTreeView ? 'tree' : 'flat'), action: 'toggleFileTree', collapsed: false });
      rightParts.push({ label: '  Diff: ' + (state.diffView === 'side' ? 'side' : 'unified'), action: 'toggleDiff', collapsed: false });
    }
    let rightTotalW = 0;
    for (const p of rightParts) rightTotalW += visLen(p.label);

    // === Left side: Local / Commits tabs ===
    let row1 = ansi.moveTo(startRow, startCol);
    let col1 = startCol;
    function appendTitleDivider() {
      titleDividerOffsets.push(col1 + 1 - startCol);
      row1 += colors.border + ' ' + V + ' ' + ansi.reset;
      col1 += 3;
    }
    {
      const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;
      const isLocal = state.rightView === 'diff';
      const isCommits = state.rightView === 'log';
      const isFresh = state.rightView === 'fresh';
      const localLabel = state.loading ? ' Local ... ' : ` Local *${totalChanges} `;
      const commitsLabel = ' Commits ';
      const freshLabel = ' Files ';

      const localIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(localLabel) - 1, action: 'tab-local' });
      const localHighlight = !state.loading && totalChanges > 0;
      const localColor = localHighlight ? colors.orange + ansi.bold : colors.cyan;
      const localStyle = localIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isLocal ? localColor + ansi.inverse : localColor;
      row1 += localStyle + localLabel + ansi.reset;
      col1 += visLen(localLabel);

      const commitsIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(commitsLabel) - 1, action: 'tab-commits' });
      const commitsStyle = commitsIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isCommits ? colors.cyan + ansi.bold + ansi.inverse : colors.cyan;
      row1 += commitsStyle + commitsLabel + ansi.reset;
      col1 += visLen(commitsLabel);

      const freshIdx = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(freshLabel) - 1, action: 'tab-fresh' });
      const freshStyle = freshIdx === ui.hoveredTitleZoneIndex
        ? colors.cursorBg + colors.value + ansi.bold + CSI + '4m'
        : isFresh ? colors.cyan + ansi.bold + ansi.inverse : colors.cyan;
      row1 += freshStyle + freshLabel + ansi.reset;
      col1 += visLen(freshLabel);
    }

    // === Action buttons or Rebase progress bar ===
    {
      appendTitleDivider();

      const op = state.operationState;
      const isRebaseOp = op && (op.type === 'rebase-merge' || op.type === 'rebase-apply');
      if (op) {
        // 진행 중인 작업: 상태 라벨 + Abort (+ Skip). rebase뿐 아니라
        // merge/cherry-pick/revert도 동일하게 상단에서 취소/건너뛰기를 노출한다.
        let progressLabel;
        if (isRebaseOp) {
          // Rebase progress bar (Fork-style)
          const branch = state.branch || 'HEAD';
          const rebasedStep = Math.max(0, (op.step || 1) - 1);
          const totalSteps = op.total || '?';
          const rebaseBranch = op.headName || branch;
          progressLabel = " Rebasing '" + rebaseBranch + "' (rebased " + rebasedStep + '/' + totalSteps + ' commits) ';
        } else {
          const opName = op.type === 'merge' ? 'Merging' : op.type === 'cherry-pick' ? 'Cherry-picking' : 'Reverting';
          progressLabel = ' ' + opName + ' ';
        }
        row1 += colors.yellow + ansi.bold + progressLabel + ansi.reset;
        col1 += visLen(progressLabel);

        // Abort button (모든 작업)
        const abortLabel = ' Abort ';
        const abortIdx = zoneIdx++;
        const abortOn = caps().isEnabled('op-abort');
        ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(abortLabel) - 1, action: 'op-abort', enabled: abortOn });
        const abortStyle = buttonStyle(abortOn, abortIdx === ui.hoveredTitleZoneIndex,
          colors.red + ansi.bold, colors.cursorBg + colors.red + ansi.bold + CSI + '4m');
        row1 += abortStyle + abortLabel + ansi.reset;
        col1 += visLen(abortLabel);

        // Skip button (merge는 skip이 없으므로 제외)
        if (op.type !== 'merge') {
          const skipLabel = ' Skip ';
          const skipIdx = zoneIdx++;
          const skipOn = caps().isEnabled('op-skip');
          ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(skipLabel) - 1, action: 'op-skip', enabled: skipOn });
          const skipStyle = buttonStyle(skipOn, skipIdx === ui.hoveredTitleZoneIndex,
            colors.orange, colors.cursorBg + colors.orange + ansi.bold + CSI + '4m');
          row1 += skipStyle + skipLabel + ansi.reset;
          col1 += visLen(skipLabel);
        }
      } else {
        const pullLabel = state.behind > 0 ? 'Pull \u2193' + state.behind : 'Pull';
        const pushLabel = state.ahead > 0 ? 'Push \u2191' + state.ahead : 'Push';
        const actionBtns = [
          { label: 'Fetch', action: 'git-fetch' },
          { label: pullLabel, action: 'git-pull' },
          { label: pushLabel, action: 'git-push' },
          { label: 'Stash', action: 'git-stash' },
        ];
        for (let i = 0; i < actionBtns.length; i++) {
          const btn = actionBtns[i];
          const label = ' ' + btn.label + ' ';
          const si = zoneIdx++;
          ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(label) - 1, action: btn.action, enabled: actionClickable(btn.action) });
          const hasCount = (btn.action === 'git-pull' && state.behind > 0)
            || (btn.action === 'git-push' && state.ahead > 0);
          const style = actionStyle(btn.action, si === ui.hoveredTitleZoneIndex,
            hasCount ? colors.orange + ansi.bold : colors.value,
            colors.cursorBg + colors.value + ansi.bold + CSI + '4m');
          row1 += style + label + ansi.reset;
          col1 += visLen(label);
        }
      }
    }

    // === Right side: panel toggle buttons (right-aligned) ===
    const rightStartCol = startCol + width - rightTotalW;
    const gap = Math.max(0, rightStartCol - col1);
    row1 += ' '.repeat(gap);
    col1 += gap;

    for (const p of rightParts) {
      const si = zoneIdx++;
      ui.titleClickZones.push({ row: startRow, colStart: col1, colEnd: col1 + visLen(p.label) - 1, action: p.action });
      row1 += zoneStyle(si, p.collapsed) + p.label + ansi.reset;
      col1 += visLen(p.label);
    }

    return row1;
  }

  function horizontalConnectsRight(ch) {
    return ch === H || ch === CROSS || ch === T_DOWN || ch === T_UP || ch === T_RIGHT;
  }

  function horizontalConnectsLeft(ch) {
    return ch === H || ch === CROSS || ch === T_DOWN || ch === T_UP || ch === T_LEFT;
  }

  function visibleFirstChar(s) {
    const plain = stripAnsi(s || '');
    return plain.length > 0 ? plain[0] : ' ';
  }

  function visibleCharAt(s, idx) {
    if (idx < 0) return ' ';
    const plain = stripAnsi(s || '');
    return idx < plain.length ? plain[idx] : ' ';
  }

  function dividerJoinChar(leftContent, leftWidth, rightContent) {
    const leftJoins = horizontalConnectsRight(visibleCharAt(leftContent, leftWidth - 1));
    const rightJoins = horizontalConnectsLeft(visibleFirstChar(rightContent));
    if (leftJoins && rightJoins) return CROSS;
    if (leftJoins) return T_LEFT;
    if (rightJoins) return T_RIGHT;
    return V;
  }

  function activeDividerOffsets() {
    const offsets = [];
    if (!ui.leftPanelCollapsed && leftW > 0) offsets.push(leftW);
    if (state.rightView !== 'log' && state.rightView !== 'fresh' && middleW > 0 && rightW > 0) {
      offsets.push((!ui.leftPanelCollapsed && leftW > 0 ? leftW + divider1W : 0) + middleW);
    }
    return offsets.filter(offset => offset >= 0 && offset < width);
  }

  function buildFullWidthSeparator(aboveOffsets, belowOffsets) {
    const chars = new Array(width).fill(H);
    const hasAbove = new Set((aboveOffsets || []).filter(offset => offset >= 0 && offset < width));
    const hasBelow = new Set((belowOffsets || []).filter(offset => offset >= 0 && offset < width));
    for (const offset of hasAbove) {
      chars[offset] = hasBelow.has(offset) ? CROSS : T_UP;
    }
    for (const offset of hasBelow) {
      if (!hasAbove.has(offset)) chars[offset] = T_DOWN;
    }
    return colors.border + chars.join('') + ansi.reset;
  }

  // -- Separator line (with scroll percentages) --
  function buildSeparator() {
    return ansi.moveTo(startRow + titleRows, startCol) + buildFullWidthSeparator(titleDividerOffsets, activeDividerOffsets());
  }

  // Vertical divider colors (used in body)
  const vDiv1Color = ui.hoveredDivider === 'vertical' ? colors.value : colors.border;
  const vDiv2Color = ui.hoveredDivider === 'vertical2' ? colors.value : colors.border;

  // Reset scroll pct (will be set by panel builders)
  ui.scrollPct = { status: -1, files: -1, diff: -1, history: -1, detail: -1 };

  function buildRepositorySetupPanel(w, h) {
    const lines = new Array(Math.max(0, h)).fill('');
    const zones = [];
    if (w <= 0 || h <= 0) return { lines, zones };

    const entries = state.gitNotFound
      ? []
      : [
          { label: '[I] Initialize Repository Here', action: 'tab_init' },
          { label: '[O] Open Existing Repository...', action: 'tab_change_repo' },
          { label: '[C] Clone Repository...', action: 'tab_clone' },
        ];
    const contentHeight = state.gitNotFound ? 5 : 9;
    const top = Math.max(0, Math.floor((h - contentHeight) / 2));

    function centerLine(row, text, style) {
      if (row < 0 || row >= lines.length) return;
      const shown = truncate(text, Math.max(1, w - 2));
      const col = Math.max(0, Math.floor((w - visLen(shown)) / 2));
      lines[row] = ' '.repeat(col) + (style || '') + shown + ansi.reset;
    }

    centerLine(top, state.gitNotFound ? 'Git executable not found' : 'This folder is not a Git repository',
      state.gitNotFound ? colors.red + ansi.bold : colors.cyan + ansi.bold);
    centerLine(top + 2, truncate(state.cwd || '', Math.max(1, w - 4)), colors.dim);

    if (state.gitNotFound) {
      centerLine(top + 4, 'Install Git and reopen this plugin to continue.', colors.dim);
      return { lines, zones };
    }

    centerLine(top + 4, 'Set up version control even when this folder has no files yet.', colors.dim);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const row = top + 6 + i;
      if (row >= lines.length) break;
      const shown = truncate(entry.label, Math.max(1, w - 2));
      const col = Math.max(0, Math.floor((w - visLen(shown)) / 2));
      const on = caps().isEnabled(entry.action);
      const style = buttonStyle(on, ui.hoveredRepoSetupAction === entry.action,
        colors.value, colors.cursorBg + colors.value + ansi.bold + CSI + '4m');
      lines[row] = ' '.repeat(col) + style + shown + ansi.reset;
      zones.push({ lineIdx: row, colStart: col, colEnd: col + visLen(shown) - 1, action: entry.action, enabled: on });
    }
    return { lines, zones };
  }

  // -- Body --
  if (repoSetupMode) {
    const setup = buildRepositorySetupPanel(width, contentH);
    const bodyTop = startRow + titleRows + 1;
    ui.repoSetupClickZones = setup.zones.map(zone => ({
      row: bodyTop + zone.lineIdx,
      colStart: startCol + zone.colStart,
      colEnd: startCol + zone.colEnd,
      action: zone.action,
      enabled: zone.enabled,
    }));
    ui.fileLineMap = [];
    ui.fileHeaderZones = [];
    ui.leftTabZones = [];
    ui.leftPanelClickMap = [];
    ui.rightDiffH = 0;
    ui.filesMaxScroll = 0;
    ui.diffMaxScroll = 0;
    ui.logListMaxScroll = 0;
    ui.logDetailMaxScroll = 0;
    ui.freshListMaxScroll = 0;
    ui.freshDetailMaxScroll = 0;
    for (let i = 0; i < bodyH; i++) {
      const row = bodyTop + i;
      buf.push(ansi.moveTo(row, startCol) + padRight(i < setup.lines.length ? setup.lines[i] : '', width));
    }
  } else if (state.rightView === 'fresh') {
    ui.repoSetupClickZones = [];
    // 2-column body: left | right (fresh panel with top/bottom split)
    ui.fileLineMap = [];
    const rightLines = buildFreshPanel(rightW, contentH);

    if (ui.leftPanelCollapsed) {
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(ansi.moveTo(row, startCol) + padRight(rContent, width));
      }
      ui.leftTabZones = [];
      ui.leftPanelClickMap = [];
    } else {
      const leftLines = buildLeftPanel(leftW, contentH);
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
        const lContent = i < leftLines.length ? leftLines[i] : '';
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(
          ansi.moveTo(row, startCol) +
          padRight(lContent, leftW) +
          vDiv1Color + dividerJoinChar(lContent, leftW, rContent) + ansi.reset +
          padRight(rContent, rightW)
        );
      }
    }
  } else if (state.rightView === 'log') {
    ui.repoSetupClickZones = [];
    // 2-column body: left | right (log panel with top/bottom split)
    ui.fileLineMap = [];
    const rightLines = buildLogPanel(rightW, contentH);

    if (ui.leftPanelCollapsed) {
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(ansi.moveTo(row, startCol) + padRight(rContent, width));
      }
      ui.leftTabZones = [];
      ui.leftPanelClickMap = [];
    } else {
      const leftLines = buildLeftPanel(leftW, contentH);
      for (let i = 0; i < bodyH; i++) {
        const row = startRow + titleRows + 1 + i;
        const lContent = i < leftLines.length ? leftLines[i] : '';
        const rContent = i < rightLines.length ? rightLines[i] : '';
        buf.push(
          ansi.moveTo(row, startCol) +
          padRight(lContent, leftW) +
          vDiv1Color + dividerJoinChar(lContent, leftW, rContent) + ansi.reset +
          padRight(rContent, rightW)
        );
      }
    }
  } else {
    ui.repoSetupClickZones = [];
    // 3-column body: left | middle (files) | right (diff+commit)
    const middleLines = middleW > 0 ? buildFileListPanel(middleW, contentH) : [];
    const rightLines = rightW > 0 ? buildDiffCommitPanel(rightW, contentH) : [];
    if (middleW === 0) { ui.fileLineMap = []; ui.fileHeaderZones = []; }

    const hasLeft = !ui.leftPanelCollapsed && leftW > 0;
    const leftLines = hasLeft ? buildLeftPanel(leftW, contentH) : [];
    if (!hasLeft) { ui.leftTabZones = []; ui.leftPanelClickMap = []; }

    for (let i = 0; i < bodyH; i++) {
      const row = startRow + titleRows + 1 + i;
      let line = ansi.moveTo(row, startCol);
      if (hasLeft) {
        line += padRight(i < leftLines.length ? leftLines[i] : '', leftW);
        line += vDiv1Color + dividerJoinChar(i < leftLines.length ? leftLines[i] : '', leftW, i < middleLines.length ? middleLines[i] : '') + ansi.reset;
      }
      if (middleW > 0) {
        line += padRight(i < middleLines.length ? middleLines[i] : '', middleW);
      }
      if (middleW > 0 && rightW > 0) {
        line += vDiv2Color + dividerJoinChar(i < middleLines.length ? middleLines[i] : '', middleW, i < rightLines.length ? rightLines[i] : '') + ansi.reset;
      }
      if (rightW > 0) {
        line += padRight(i < rightLines.length ? rightLines[i] : '', rightW);
      }
      // Fill remaining if both middle and right collapsed
      if (middleW === 0 && rightW > 0) {
        // rightW takes full remaining — already handled
      } else if (middleW > 0 && rightW === 0) {
        // middleW takes full remaining — already handled
      } else if (middleW === 0 && rightW === 0) {
        line += ' '.repeat(remaining);
      }
      buf.push(line);
    }
  }

  // -- Title row + separator (after body so scrollPct is computed) --
  buf.push(buildTitleRows());
  buf.push(buildSeparator());

  // -- Bottom separator --
  buf.push(
    ansi.moveTo(sepRow, startCol) +
    buildFullWidthSeparator(activeDividerOffsets(), [])
  );

  // -- Hint bar --
  // 오른쪽(committer)을 먼저 확정해야 왼쪽에 남는 폭을 알 수 있다.
  // 리비전 힌트가 그 폭에 맞춰 표시 항목을 줄이기 때문에 순서가 중요하다.
  // 처리상태 스피너는 힌트바에서 빼고 창 타이틀에서 돌린다 (title.js 참고).
  const committerMaxWidth = Math.max(0, Math.min(72, Math.floor(width * 0.55)));
  const committerHint = buildCommitterHint(committerMaxWidth);
  const rightContent = committerHint.content;
  const rightWidth = visLen(rightContent);
  const leftMaxWidth = Math.max(0, width - rightWidth - (rightWidth > 0 ? 1 : 0));

  let hintContent;
  if (state.mode === 'rebase-menu') {
    hintContent = colors.yellow + ' Rebase: ' + ansi.reset
      + colors.value + '[c]ontinue' + ansi.reset + '  '
      + colors.value + '[a]bort' + ansi.reset + '  '
      + colors.value + '[s]kip' + ansi.reset;
  } else if (state.mode === 'commit') {
    const commitOpRebase = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    const commitHintLabel = commitOpRebase ? ' Continue Rebase: ' : (state.commitAmend && !state.operationState) ? ' Amend: ' : ' Commit: ';
    const modKey = (typeof process !== 'undefined' && process.platform === 'darwin') ? 'Cmd' : 'Ctrl';
    const amendHint = state.operationState ? '' : '[' + modKey + '+A]amend  ';
    hintContent = colors.yellow + commitHintLabel + ansi.reset
      + colors.dim + '[' + modKey + '+Enter]submit  ' + amendHint + '[Esc]cancel' + ansi.reset;
  } else if (state.mode === 'new-branch') {
    hintContent = colors.yellow + ' New Branch: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create' + ansi.reset;
  } else if (state.mode === 'new-tag') {
    hintContent = colors.yellow + ' New Tag: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create' + ansi.reset;
  } else if (state.mode === 'rename-stash') {
    hintContent = colors.yellow + ' Rename Stash: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]rename' + ansi.reset;
  } else if (state.mode === 'new-remote') {
    hintContent = colors.yellow + ' Remote Name: ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]next' + ansi.reset;
  } else if (state.mode === 'new-remote-url') {
    hintContent = colors.yellow + ' Remote URL (' + state.inputTarget + '): ' + ansi.reset
      + colors.value + state.inputBuffer + '\u2588' + ansi.reset + '  '
      + colors.dim + '[Enter]create' + ansi.reset;
  } else if (state.freshTimeWindowMode) {
    const tw = FRESH_TIME_WINDOWS;
    let windowHint = colors.yellow + ' Time Window: ' + ansi.reset;
    for (let i = 0; i < tw.length; i++) {
      if (i === state.freshTimeWindow) {
        windowHint += colors.cursorBg + colors.cyan + ansi.bold + ' ' + tw[i].label + ' ' + ansi.reset + ' ';
      } else {
        windowHint += colors.dim + ' ' + tw[i].label + ' ' + ansi.reset + ' ';
      }
    }
    windowHint += colors.dim + '  [\u2190\u2192]select  [Enter]apply' + ansi.reset;
    hintContent = windowHint;
  } else if (!state.isGitRepo && (state.error || state.cwd)) {
    // 비저장소는 오류가 아니라 설정 가능한 시작 상태다. 자세한 진단 문자열 대신 사용자가
    // 지금 할 수 있는 동작을 안내하고, 실제 오류(git 실행 파일 없음)만 빨간색으로 남긴다.
    if (state.spinnerActive) {
      hintContent = ' ' + colors.dim + 'cwd: ' + state.cwd + ansi.reset;
    } else if (state.gitNotFound) {
      hintContent = ' ' + colors.red + 'Git executable not found' + ansi.reset;
    } else {
      hintContent = ' ' + colors.dim + '[I] initialize  [O] open  [C] clone' + ansi.reset;
    }
  } else if (state.error && !state.spinnerActive) {
    // 쓰기 작업 진행 메시지(spinnerActive 중의 state.error)와 refresh 스피너는
    // 창 타이틀에서 점자 스피너와 함께 표시한다 — 힌트바는 에러/토스트만 맡아
    // 작업 중에도 일반 힌트(리비전/브랜치 정보)가 그대로 보인다.
    const isInProgress = state.error.endsWith('...');
    const msgColor = isInProgress ? colors.yellow : colors.red;
    hintContent = ' ' + msgColor + state.error + ansi.reset;
  } else if (ui.hoveredAction && queue.hasFor(ui.hoveredAction)) {
    // 예약된 버튼 — 왜 안 나갔는지가 아니라 언제 나가는지, 그리고 물릴 방법을 알린다.
    // 대상을 들고 가는 예약은 무엇을 실었는지가 더 중요하다(또 누르면 거기에 보탠다).
    const entry = queue.findFor(ui.hoveredAction);
    const count = entry && Array.isArray(entry.payload) ? entry.payload.length : 0;
    hintContent = ' ' + colors.cyan + 'Queued' + (count > 0 ? ' (' + count + ' file' + (count > 1 ? 's' : '') + ')' : '')
      + ansi.reset + colors.dim
      + (count > 0
        ? ' — runs when the current operation finishes; click again to add'
        : ' — runs when the current operation finishes (click to cancel)')
      + ansi.reset;
  } else if (ui.hoveredAction && caps().disabledReason(ui.hoveredAction)) {
    // 딤드 버튼에 마우스를 올린 동안만 사유를 보여 준다 — 색만으로는 "왜"를 알 수 없다.
    // 눌러도 버려지지 않고 예약될 버튼이라면 그 점을 함께 알린다 — 사유만 보여 주면
    // 흐리지도 않은 버튼에 "다른 작업이 도는 중"이라고만 적혀 눌러도 되는지 알 수 없다.
    const reason = caps().disabledReason(ui.hoveredAction);
    const willQueue = caps().isActionable(ui.hoveredAction);
    hintContent = ' ' + colors.dim + reason + (willQueue ? ' — click to queue' : '') + ansi.reset;
  } else if (state.rightView === 'fresh') {
    hintContent = ' ' + colors.dim + '[w]indow  [r]efresh  [Tab]focus' + ansi.reset;
  } else if (state.operationState) {
    const op = state.operationState;
    const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
    const label = isRebase ? 'Rebase' : op.type === 'merge' ? 'Merge' : op.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
    const progress = isRebase && op.step ? ' (' + op.step + '/' + op.total + ')' : '';
    const hasUnmerged = state.unstaged.some(f => f.status === 'U');
    if (hasUnmerged) {
      hintContent = colors.yellow + ' ' + label + progress + ansi.reset + '  '
        + colors.dim + '[Tab]focus  [1/2/3] ours/theirs/both  [v]iew  [m] apply  [b] continue' + ansi.reset;
    } else {
      hintContent = colors.yellow + ' ' + label + progress + ansi.reset + '  '
        + colors.dim + '[b] continue/abort' + (op.type !== 'merge' ? '/skip' : '') + ansi.reset;
    }
  } else {
    hintContent = buildStatusHint(leftMaxWidth)
      || buildRevisionHint(leftMaxWidth)
      || (' ' + buildHintText());
  }
  const leftContent = leftMaxWidth <= 0
    ? ''
    : visLen(hintContent) > leftMaxWidth
      ? truncate(hintContent, leftMaxWidth) + ansi.reset
      : hintContent;
  const hintGap = Math.max(0, width - visLen(leftContent) - rightWidth);
  const rightStartCol = startCol + visLen(leftContent) + hintGap;
  buf.push(ansi.moveTo(hintRow, startCol) + leftContent + ' '.repeat(hintGap) + rightContent);

  const committerStartCol = rightStartCol;
  ui.committerClickZones = committerHint.zones.map(zone => ({
    row: hintRow,
    colStart: committerStartCol + zone.offset,
    colEnd: committerStartCol + zone.offset + zone.width - 1,
    action: zone.action,
    enabled: zone.enabled,
  }));

  // Host-owned scroll: emit overscan banks (off-screen buffer rows the host
  // reveals during sub-cell scrolling), in-band render acks, and collect the
  // region definitions for the post-write RPC sync. The banks/acks ride in the
  // same stdout write as the frame so the host applies them atomically.
  // Must come BEFORE the sixel overlays: the logList bank text shares buffer
  // rows with the bank-anchored graph sixel, and text written after a sixel
  // invalidates it (PutChar overlap), exactly like the visible list rows.
  let hostScrollDefs = null;
  if (hostScroll.isActive()) {
    hostScrollDefs = [];
    const midStartCol = startCol + leftW + divider1W;
    const rightPanelCol = (state.rightView === 'log' || state.rightView === 'fresh')
      ? midStartCol
      : midStartCol + middleW + divider2W;
    const bodyTopRow = startRow + titleRows + 1;
    for (const r of ui.hostScrollRegions) {
      if (r.height <= 0 || r.width <= 0) continue;
      const absCol = r.panel === 'left' ? startCol : r.panel === 'middle' ? midStartCol : rightPanelCol;
      const absRow = bodyTopRow + r.relRow;
      const bankTop = hostScroll.bankRow(r.id); // 0-based buffer row
      // Bank rows live beyond the screen: write them only after the host has
      // confirmed the region (enlarged buffer); earlier writes would clamp
      // onto the bottom visible row.
      if (hostScroll.isReady(r.id)) {
        const bankDepth = hostScroll.depthOf(r.id);
        const bankLines = bankDepth.before + bankDepth.after;
        for (let i = 0; i < bankLines; i++) {
          buf.push(ansi.reset + ansi.moveTo(bankTop + 1 + i, absCol) + padRight(r.bank[i] || '', r.width) + ansi.reset);
        }
        buf.push(hostScroll.ackString(r.id, r.off));
      }
      hostScrollDefs.push({
        id: r.id,
        row: absRow - 1,
        col: absCol - 1,
        width: r.width,
        height: r.height,
        contentRows: r.contentRows,
        contentCols: r.width, // horizontal stays plugin-owned (field-level scroll)
        overscanRow: bankTop,
        off: r.off,
      });
    }
  }

  // Append Sixel overlay (for log graph). With host-owned scroll the graph is
  // rendered with overscan and anchored at the logList bank row, which the
  // host maps to one row above the list viewport (and scrolls/clips it with
  // the region).
  if (SIXEL_ENABLED && ui.logSixelOverlay && state.rightView === 'log') {
    const graphCol = startCol + leftW + divider1W + 1;
    const screenRow = ui.logSixelAnchorBank
      ? hostScroll.bankRow('logList') + 1
      : startRow + titleRows + 1;
    const sz = ui.logSixelOverlaySize;
    const old = ui.logSixelRegion;
    // 새 sixel이 이전 영역을 완전히 덮으면(같은 위치 + 같거나 큰 크기) 텍스트 레이어가
    // 그래프 셀을 먼저 다시 칠하고 그 위에 새 sixel을 얹으므로 잔상이 없다 → clear 불필요.
    // 위치가 바뀌거나 더 작아질 때만 이전 영역을 지워 삐져나온 픽셀을 제거한다.
    const covers = sz && old
      && old.screenRow === screenRow && old.screenCol === graphCol
      && sz.pixelW >= old.pixelW && sz.pixelH >= old.pixelH;
    if (old && !covers) appendLogSixelClear(buf); // ui.logSixelRegion = null 로 정리됨
    buf.push(ansi.moveTo(screenRow, graphCol) + ui.logSixelOverlay);
    if (sz) {
      ui.logSixelRegion = {
        screenRow,
        screenCol: graphCol,
        pixelW: sz.pixelW,
        pixelH: sz.pixelH,
        // bank 앵커면 화면 밖 행이라 2J로 지워지지 않는다 — 지우개를 따로 쏴야 한다.
        anchorBank: !!ui.logSixelAnchorBank,
      };
    }
  } else {
    // 이번 프레임엔 graph sixel이 없다(뷰 전환·목록 0행 등) — 남아있던 이전 sixel 제거.
    appendLogSixelClear(buf);
  }
  ui.logSixelOverlay = null;
  ui.logSixelOverlaySize = null;

  // Scrollbar overlays
  ui.scrollbarOverlays = [];
  ui.hScrollbarZones = [];
  if (SIXEL_ENABLED && !repoSetupMode) {
    const sbBodyTop = startRow + titleRows + 1;
    const midStart = startCol + leftW + divider1W;

    function addScrollbar(scrollOffset, maxScroll, viewportRows, screenRow, screenCol, target) {
      if (maxScroll <= 0 || viewportRows <= 0) return;
      const pixBuf = renderScrollbarPixels(ui.cellW, ui.cellH, viewportRows, scrollOffset, maxScroll);
      if (pixBuf) {
        const isActive = ui.dragging === 'scrollbar' && ui.scrollbarDragInfo && ui.scrollbarDragInfo.target === target;
        const isHovered = ui.hoveredScrollbarTarget === target;
        const palette = isActive ? SCROLLBAR_ACTIVE_PALETTE : isHovered ? SCROLLBAR_HOVER_PALETTE : SCROLLBAR_PALETTE;
        const sixelStr = encodeSixel(pixBuf, ui.cellW, viewportRows * ui.cellH, palette);
        ui.scrollbarOverlays.push({ sixelStr, screenRow, screenCol, viewportRows, maxScroll, target });
      }
    }

    // Left panel
    if (!ui.leftPanelCollapsed && leftW > 0) {
      addScrollbar(ui.leftPanelScrollOffset, ui.leftMaxScroll, contentH, sbBodyTop, startCol + leftW - 1, 'left');
    }

    // Middle panel (files) - diff mode only
    if (state.rightView === 'diff' && middleW > 0) {
      const filesVSbH = ui.filesMaxScrollX > 0 ? contentH - 1 : contentH;
      addScrollbar(state.scrollOffset, ui.filesMaxScroll, filesVSbH, sbBodyTop, midStart + middleW - 1, 'files');
    }

    // Right panels
    if (state.rightView === 'diff') {
      // Diff section
      if (rightW > 0) {
        // 충돌 뷰는 머리말을 고정해 두므로 스크롤바도 그 아래 구간에만 걸린다.
        // 조건은 diff 패널이 충돌 뷰를 그린 조건과 같아야 한다 — 다른 파일의 충돌이
        // state 에 남아 있을 때 conflictBodyH 를 끌어 쓰면 스크롤바가 어긋난다.
        const inConflictView = !!(state.conflictView && state.conflictView.file === state.currentDiffFile);
        const headH = inConflictView ? Math.max(0, ui.rightDiffH - ui.conflictBodyH) : 0;
        addScrollbar(state.diffScrollOffset, ui.diffMaxScroll, ui.rightDiffH - headH, sbBodyTop + headH, startCol + width - 1, 'diff');
      }
    } else if (state.rightView === 'log') {
      // Log history list
      if (rightW > 0 && ui.lastLogListH > 0) {
        addScrollbar(state.logScrollOffset, ui.logListMaxScroll, ui.lastLogListH, sbBodyTop, startCol + width - 1, 'logList');
      }
      // Log detail
      if (rightW > 0 && ui.lastDetailContentH > 0) {
        const detailTop = sbBodyTop + ui.lastLogListH + 1 + 1; // +1 separator +1 refs line
        addScrollbar(state.diffScrollOffset, ui.logDetailMaxScroll, ui.lastDetailContentH, detailTop, startCol + width - 1, 'logDetail');
      }
    } else if (state.rightView === 'fresh') {
      // Fresh file list
      const freshFileListH = Math.max(0, ui.lastFreshListH - 1);
      if (rightW > 0 && freshFileListH > 0) {
        addScrollbar(state.freshScrollOffset, ui.freshListMaxScroll, freshFileListH, sbBodyTop + 1, startCol + width - 1, 'freshList');
      }
      // Fresh detail
      if (rightW > 0 && ui.lastFreshListH > 0) {
        const freshDetailH = contentH - ui.lastFreshListH - 1; // -1 separator
        const freshHsbH = ui.freshDetailMaxScrollX > 0 ? 1 : 0;
        if (freshDetailH > 1) {
          const detailTop = sbBodyTop + ui.lastFreshListH + 1 + 1; // +1 separator +1 header
          addScrollbar(state.diffScrollOffset, ui.freshDetailMaxScroll, freshDetailH - 1 - freshHsbH, detailTop, startCol + width - 1, 'freshDetail');
        }
      }
    }

    for (const sb of ui.scrollbarOverlays) {
      buf.push(ansi.moveTo(sb.screenRow, sb.screenCol) + sb.sixelStr);
    }

    // Horizontal scrollbars (sixel)
    const hasSixel = ui.cellW > 0 && ui.cellH > 0;
    if (hasSixel) {
      function addHScrollbar(target, hScreenRow, hColStart, hCols, viewportCols, scrollX, maxScrollX) {
        const hPixBuf = renderHScrollbarPixels(ui.cellW, ui.cellH, hCols, viewportCols, scrollX, maxScrollX);
        if (hPixBuf) {
          const isActive = ui.dragging === 'hscrollbar' && ui.hScrollbarDragInfo && ui.hScrollbarDragInfo.target === target;
          const isHovered = ui.hoveredHScrollbarTarget === target;
          const palette = isActive ? SCROLLBAR_ACTIVE_PALETTE : isHovered ? SCROLLBAR_HOVER_PALETTE : SCROLLBAR_PALETTE;
          const hSixelStr = encodeSixel(hPixBuf, hCols * ui.cellW, ui.cellH, palette);
          buf.push(ansi.moveTo(hScreenRow, hColStart) + hSixelStr);
          ui.hScrollbarZones.push({
            target,
            screenRow: hScreenRow,
            colStart: hColStart,
            colEnd: hColStart + hCols - 1,
            trackCols: hCols,
            maxScrollX,
          });
        }
      }

      const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;

      // Diff panel horizontal scrollbar (diff mode)
      if (state.rightView === 'diff' && ui.diffMaxScrollX > 0 && rightW > 0) {
        const hCols = rightW - 1;
        addHScrollbar('diff', sbBodyTop + ui.rightDiffH, rpStartCol, hCols, rightW - 1, state.diffScrollX, ui.diffMaxScrollX);
      }
      // Files panel horizontal scrollbar (diff mode)
      if (state.rightView === 'diff' && ui.filesMaxScrollX > 0 && middleW > 0) {
        const hCols = middleW - 1;
        addHScrollbar('files', sbBodyTop + contentH - 1, midStart, hCols, middleW - 1, state.filesScrollX, ui.filesMaxScrollX);
      }
      // Log detail horizontal scrollbar
      if (state.rightView === 'log' && ui.logDetailMaxScrollX > 0 && rightW > 0 && ui.lastLogListH > 0) {
        const hCols = rightW - 1;
        const detailBottom = sbBodyTop + contentH - 1;
        addHScrollbar('logDetail', detailBottom, rpStartCol, hCols, rightW - 1, state.diffScrollX, ui.logDetailMaxScrollX);
      }
      // Fresh detail horizontal scrollbar
      if (state.rightView === 'fresh' && ui.freshDetailMaxScrollX > 0 && rightW > 0 && ui.lastFreshListH > 0) {
        const hCols = rightW - 1;
        const detailBottom = sbBodyTop + contentH - 1;
        addHScrollbar('freshDetail', detailBottom, rpStartCol, hCols, rightW - 1, state.diffScrollX, ui.freshDetailMaxScrollX);
      }
    }
  }

  process.stdout.write(buf.join(''));
  if (hostScrollDefs) hostScroll.syncRegions(hostScrollDefs);

  // Record layout
  ui.lastLayout = { startRow, startCol, width, height, leftW, divider1W, middleW, divider2W, rightW, bodyH, titleRows };

  // Commit button zone (diff mode only)
  if (!repoSetupMode && state.rightView !== 'log' && state.rightView !== 'fresh' && ui.rightDiffH >= 0) {
    const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;
    const visLines = ui.commitMsgVisibleLines || 1;
    const hsbOffset = ui.diffMaxScrollX > 0 ? 1 : 0;
    const mergeFooterOffset = state.conflictView ? 1 : 0;
    ui.commitInputRow = startRow + titleRows + 1 + ui.rightDiffH + hsbOffset + 1 + mergeFooterOffset;
    const btnIsRebase = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    const btnIsMergeOp = state.operationState && (state.operationState.type === 'merge' || state.operationState.type === 'cherry-pick' || state.operationState.type === 'revert');
    const btnLabelLen = btnIsRebase ? 16 : btnIsMergeOp ? (state.operationState.type === 'merge' ? 13 : state.operationState.type === 'cherry-pick' ? 19 : 14) : 6; // Continue Rebase=16, Commit=6, etc
    const btnRow = startRow + titleRows + 1 + ui.rightDiffH + hsbOffset + visLines + 1 + mergeFooterOffset;
    ui.commitButtonZone = {
      row: btnRow,
      colStart: rpStartCol + 1,
      colEnd: rpStartCol + 1 + btnLabelLen,
    };
    // Amend 토글: Commit 버튼과 같은 행 오른쪽 (렌더에서 저장한 상대 위치 사용)
    if (ui.commitAmendBtnOffset >= 0) {
      ui.commitAmendZone = {
        row: btnRow,
        colStart: rpStartCol + ui.commitAmendBtnOffset,
        colEnd: rpStartCol + ui.commitAmendBtnOffset + ui.commitAmendBtnLen,
      };
    } else {
      ui.commitAmendZone = null;
    }
    // 메시지 지우기 버튼: 메시지 첫 줄 오른쪽 (렌더에서 저장한 상대 위치 사용)
    if (ui.commitClearBtnOffset >= 0) {
      ui.commitClearZone = {
        row: ui.commitInputRow,
        colStart: rpStartCol + ui.commitClearBtnOffset,
        colEnd: rpStartCol + ui.commitClearBtnOffset + ui.commitClearBtnLen - 1,
      };
    } else {
      ui.commitClearZone = null;
    }
    if (state.conflictView) {
      const allSelected = actions.allConflictChunksSelected();
      const applyLabel = allSelected ? ' Apply resolution ' : ' Select every conflict to apply ';
      ui.mergeApplyZone = {
        row: startRow + titleRows + 1 + ui.rightDiffH + hsbOffset + 1,
        colStart: rpStartCol + 1,
        colEnd: rpStartCol + applyLabel.length,
        enabled: allSelected && caps().isEnabled('merge-apply'),
        label: applyLabel,
      };
    } else {
      ui.mergeApplyZone = null;
    }
  } else {
    ui.commitInputRow = -1;
    ui.commitButtonZone = null;
    ui.commitAmendZone = null;
    ui.commitClearZone = null;
    ui.mergeApplyZone = null;
  }

  // Clickable areas for hint bar
  ui.clickableAreas = [];
  if (state.mode === 'normal' && !state.error) {
    const contentStart = startCol + 1;
    let plainOffset = 0;
    for (let i = 0; i < hintButtons.length; i++) {
      if (i > 0) plainOffset += 2;
      ui.clickableAreas.push({
        row: hintRow,
        colStart: contentStart + plainOffset,
        colEnd: contentStart + plainOffset + hintButtons[i].label.length - 1,
        action: hintButtons[i].action,
      });
      plainOffset += hintButtons[i].label.length;
    }
  }
  if (ui.hoveredAreaIndex >= ui.clickableAreas.length) ui.hoveredAreaIndex = -1;

  // Position cursor at text input location for IME composition
  if (!repoSetupMode && state.mode === 'commit' && state.rightView !== 'log' && ui.rightDiffH >= 0) {
    const rpStartCol = startCol + leftW + divider1W + middleW + divider2W;
    const topLine = ui.commitTopLine || 0;
    const cursorLineIdx = ui.commitCursorLineIdx || 0;
    const hsbOff = ui.diffMaxScrollX > 0 ? 1 : 0;
    const cursorRow = startRow + titleRows + 1 + ui.rightDiffH + hsbOff + 1 + (cursorLineIdx - topLine);
    // 지우기 버튼이 얹힌 줄은 그만큼 좁게 렌더되므로, 렌더가 실제로 쓴 폭을 그대로 따른다.
    const maxW = ui.commitMsgCursorMaxW > 0 ? ui.commitMsgCursorMaxW : rightW - 2;
    const cursorLineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
    const cursorLineEnd = state.commitMsg.indexOf('\n', state.commitCursor);
    const lineText = state.commitMsg.substring(cursorLineStart, cursorLineEnd === -1 ? state.commitMsg.length : cursorLineEnd);
    const colInLine = state.commitCursor - cursorLineStart;
    const beforeVis = visLen(lineText.substring(0, colInLine));
    const afterVis = visLen(lineText.substring(colInLine));
    const totalVis = beforeVis + 1 + afterVis;
    const fits = totalVis <= maxW;
    const leftEllipsis = fits ? 0 : (beforeVis > 0 ? 1 : 0);
    const rightEllipsis = fits ? 0 : (afterVis > 0 ? 1 : 0);
    const contentWidth = maxW - leftEllipsis - rightEllipsis;
    const scrollOff = fits ? 0 : Math.max(0, beforeVis + 1 - contentWidth);
    const showLeftEllipsis = scrollOff > 0;
    const cursorCol = rpStartCol + 1 + (showLeftEllipsis ? 1 : 0) + (beforeVis - scrollOff);
    process.stdout.write(ansi.moveTo(cursorRow, cursorCol));
  }
}

// ── Left panel: branch tree ──

function buildLeftPanel(w, h) {
  const lines = [];
  const clickMap = [];
  const innerW = w - 1;

  function pushLine(content, action) {
    if (visLen(content) > innerW) {
      content = truncate(content, innerW);
    }
    lines.push(content);
    clickMap.push(action || null);
  }

  // 줄 한복판의 reset이 행 배경까지 지워 하이라이트가 중간에서 잘린다(예: `✓ main` 뒤의 @origin).
  // 파일/로그 목록과 같은 방식으로 reset 뒤마다 배경을 다시 깔고 폭 끝까지 채워 한 줄로 잇는다.
  function rowBg(content, bg) {
    return bg + padRight(content.replace(/\x1b\[0m/g, ansi.reset + bg), innerW) + ansi.reset;
  }

  // Branch name + worktree 표기 + rebase state
  // Branches 목록의 현재 브랜치와 같은 표기(✓ + green)를 쓰고, 클릭하면 목록의 그 줄로 스크롤한다.
  // detached HEAD면 목록에도 ✓ 줄이 없으므로 표기도 클릭도 붙이지 않는다.
  const currentBranchEntry = state.branches.find(b => b.isCurrent) || null;

  // 현재 브랜치의 추적 상태 — 상단 브랜치명 줄과 Branches 목록의 현재 브랜치에 같이 붙인다.
  // 리모트에 올라가 있으면 그 이름을 red로 먼저 붙인다. 화살표는 밀린 커밋이 있어야만 나오므로
  // 화살표만으로는 "리모트와 같다"와 "리모트에 아예 없다"가 구분되지 않는데, @리모트이름이
  // 없는 줄 = 아직 푸시하지 않은 로컬 전용 브랜치로 읽으면 된다.
  // 그 뒤의 pull/push 대기 화살표는 타이틀바 Pull/Push 버튼과 같은 orange를 쓴다.
  // detached HEAD면 올라탄 브랜치가 없어 ahead/behind도 의미가 없으므로 통째로 뺀다.
  const branchRemote = currentBranchEntry ? currentBranchRemote() : '';
  const remoteTag = branchRemote ? ' @' + branchRemote : '';
  const arrowTag = currentBranchEntry
    ? (state.behind > 0 ? ' ↓' + state.behind : '') + (state.ahead > 0 ? ' ↑' + state.ahead : '')
    : '';
  const trackTag = remoteTag + arrowTag;
  const trackPart = (remoteTag ? colors.red + ansi.bold + remoteTag + ansi.reset : '')
    + (arrowTag ? colors.orange + ansi.bold + arrowTag + ansi.reset : '');

  // 임의의 로컬 브랜치에 대한 같은 표기 — Pinned 목록에서 쓴다.
  // ahead/behind는 현재 브랜치만 rev-list로 따로 재고(upstream이 없어도 나온다), 나머지는
  // for-each-ref의 upstream:track에서 온다. 그래서 upstream이 없는 핀 브랜치는 @리모트만
  // 붙고 화살표는 나오지 않는다 — 셀 기준이 없으니 0으로 단정하지 않는 편이 맞다.
  function branchTrackParts(b) {
    if (!b) return { text: '', part: '' };
    if (b.isCurrent) return { text: trackTag, part: trackPart };
    const remote = branchRemoteFor(b);
    const rTag = remote ? ' @' + remote : '';
    const aTag = (b.behind > 0 ? ' ↓' + b.behind : '') + (b.ahead > 0 ? ' ↑' + b.ahead : '');
    return {
      text: rTag + aTag,
      part: (rTag ? colors.red + ansi.bold + rTag + ansi.reset : '')
        + (aTag ? colors.orange + ansi.bold + aTag + ansi.reset : ''),
    };
  }

  {
    const mark = currentBranchEntry ? '✓ ' : '';
    const nameColor = currentBranchEntry ? colors.green : colors.value;
    // Branches 목록의 브랜치 줄과 같은 액션을 사용해 히스토리 전환/커밋 이동도 동일하게 처리한다.
    // reveal은 이 줄에만 붙인다 — 목록의 같은 줄이 접혀 있으면 펼치고 거기로 스크롤하라는 표시다.
    const branchEntry = currentBranchEntry ? { action: 'goto-branch', branch: currentBranchEntry.name, reveal: true } : null;
    const availW = innerW - 1 - mark.length;
    let branchName = state.branch || '...';
    const slashIdx = branchName.lastIndexOf('/');
    if (slashIdx >= 0) branchName = branchName.substring(slashIdx + 1);
    // 현재 저장소가 메인이 아닌 linked worktree면 브랜치명 옆에 표기한다.
    const wtTag = state.isLinkedWorktree ? ' [worktree]' : '';
    const wtPart = wtTag ? colors.cyan + wtTag + ansi.reset : '';
    if (state.operationState) {
      const op = state.operationState;
      const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
      const opLabel = isRebase ? 'rebasing' : op.type === 'merge' ? 'merging' : op.type === 'cherry-pick' ? 'cherry-picking' : 'reverting';
      const suffix = isRebase && op.step ? ' (' + opLabel + ' ' + op.step + '/' + op.total + ')' : ' (' + opLabel + ')';
      branchName = truncate(branchName, Math.max(3, availW - suffix.length - wtTag.length - trackTag.length));
      pushLine(' ' + nameColor + ansi.bold + mark + branchName + ansi.reset + trackPart + wtPart + colors.yellow + suffix + ansi.reset, branchEntry);
    } else {
      branchName = truncate(branchName, Math.max(3, availW - wtTag.length - trackTag.length));
      pushLine(' ' + nameColor + ansi.bold + mark + branchName + ansi.reset + trackPart + wtPart, branchEntry);
    }
  }

  pushLine('');

  if (state.loading) {
    pushLine(colors.dim + ' Loading...' + ansi.reset);
    ui.leftTabInfo = null;
    ui.leftPanelClickMap = clickMap.slice(0, h);
    return lines.slice(0, h);
  }

  if (!state.isGitRepo) {
    if (state.gitNotFound) {
      pushLine(colors.red + ' git executable not found' + ansi.reset);
    } else {
      pushLine(colors.red + ' Not a git repository' + ansi.reset);
    }
    ui.leftTabInfo = null;
    ui.leftPanelClickMap = clickMap.slice(0, h);
    return lines.slice(0, h);
  }

  const ARROW_OPEN = '-';
  const ARROW_CLOSED = '+';
  const activeBranch = ui.leftPanelActiveBranch;

  function branchLine(indent, name, fullRef, isCurrent, isRemote, tag, heldByWorktree, track) {
    const isActive = activeBranch === fullRef;
    const tagText = tag || '';
    const tagPart = tagText ? colors.cyan + tagText + ansi.reset : '';
    // 추적 상태(@리모트 / ahead / behind)는 track을 넘겨 준 줄에만 붙인다 — Pinned 목록과
    // Branches 트리의 핀 고정 브랜치가 그렇다. 나머지 브랜치까지 붙이면 트리가 넓어져
    // 좁은 패널에서 이름이 잘리므로, 현재 브랜치를 뺀 나머지는 이름만 둔다.
    const abText = track ? track.text : (isCurrent ? trackTag : '');
    const abPart = track ? track.part : (isCurrent ? trackPart : '');
    const maxW = Math.max(1, innerW - indent - visLen(tagText) - visLen(abText));
    // \ud788\uc2a4\ud1a0\ub9ac Filter/Hide \uc9c0\uc815\uc740 \uc774 \uc904\uc758 \uc0c9\uc73c\ub85c\ub9cc \ub4dc\ub7ec\ub09c\ub2e4(\ubcc4\ub3c4 \uc139\uc158\ub3c4 \ud5e4\ub354 \ubc84\ud2bc\ub3c4 \uc5c6\ub2e4).
    // \ud540\uacfc \ub2ec\ub9ac \ub85c\uceec/\ub9ac\ubaa8\ud2b8\ub97c \uac01\uac01 \uc9c0\uc815\ud558\ubbc0\ub85c \uc81c refname \uc73c\ub85c\ub9cc \ubcf8\ub2e4.
    const refKey = isRemote ? remoteRefKey(fullRef) : localRefKey(fullRef);
    const filtered = isFilteredRef(refKey);
    const hidden = isHiddenRef(refKey);
    if (isCurrent) {
      // \ud604\uc7ac \ube0c\ub79c\uce58\ub294 Hide \ub300\uc0c1\uc774 \uc544\ub2c8\ub2e4(\uba54\ub274\uc5d0 \ud56d\ubaa9\uc744 \ub0b4\uc9c0 \uc54a\ub294\ub2e4) \u2014 Filter \ub9cc \ubc18\uc601\ud55c\ub2e4.
      // \u2713 \ub294 \uadf8\ub300\ub85c \ub450\ubbc0\ub85c \uc0c9\uc774 \ubc14\ub00c\uc5b4\ub3c4 \uc5b4\ub514\uc5d0 \uc788\ub294\uc9c0\ub294 \uacc4\uc18d \ubcf4\uc778\ub2e4.
      const curClr = filtered ? colors.filtered : colors.green;
      const content = ' '.repeat(indent) + curClr + ansi.bold + '\u2713 ' + truncate(name, Math.max(1, maxW - 2)) + ansi.reset + abPart + tagPart;
      return isActive ? rowBg(content, colors.cursorBg) : content;
    } else {
      // 다른 워크트리가 점유한 브랜치는 [worktree] 표기와 같은 색으로 구분한다.
      // 핀은 색(bright magenta)으로 드러내되, 워크트리 점유 표시가 더 강한 제약이라 색을 양보하고
      // bold만 얹는다 — 그래도 주변 브랜치와 구분된다.
      // 리모트 추적 브랜치는 동명 로컬 브랜치의 핀을 따라간다(origin/develop ← develop).
      const pinned = isRemote ? isPinnedRemoteRef(fullRef) : isPinnedBranch(fullRef);
      // Hide/Filter 는 다른 어떤 표시보다 앞선다 — 지금 히스토리에서 무엇이 빠졌는지가
      // 누가 그 브랜치를 점유했는지보다 먼저 보여야 한다. 감춘 브랜치는 목록에서 지우지
      // 않고 흐리게(dim)만 둔다. 지워 버리면 다시 우클릭해서 켤 길이 사라진다.
      const clr = hidden ? colors.dim
        : filtered ? colors.filtered
        : heldByWorktree ? colors.cyan
        : pinned ? colors.pinned
        : isRemote ? colors.red : colors.value;
      const emph = (pinned && !hidden) ? ansi.bold : '';
      const content = ' '.repeat(indent) + clr + emph + truncate(name, maxW) + ansi.reset + abPart + tagPart;
      return isActive ? rowBg(content, colors.cursorBg) : content;
    }
  }

  function basename(path) {
    const norm = (path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.substring(idx + 1) : norm;
  }

  // 다른 워크트리가 체크아웃 중인 로컬 브랜치 — 태그 대신 이름 색만 바꿔 구분한다.
  // 현재 브랜치는 현재 워크트리가 점유 중이라 여기 포함되지 않는다.
  const branchesInOtherWorktrees = new Set();
  for (const wt of state.worktrees) {
    if (wt.branch && !wt.isCurrent) branchesInOtherWorktrees.add(wt.branch);
  }
  // 저장소 자체가 linked worktree면 현재 브랜치에는 상단 브랜치명과 같은 표기를 붙인다.
  const currentBranchTag = state.isLinkedWorktree ? ' [worktree]' : '';

  // Pinned — 핀 고정한 브랜치를 Branches 위에 모아 그룹 접힘/스크롤과 무관하게 바로 닿게 한다.
  // 목록은 이름만 들고 있으므로 실제로 존재하는 브랜치만 골라 지정 순서대로 그린다.
  // (Branches 트리에도 그대로 남는다 — 트리의 그룹 구조를 깨지 않기 위해서다.)
  {
    const pinned = [];
    for (const name of ui.pinnedBranches) {
      const b = state.branches.find(x => x.name === name);
      if (b) pinned.push(b);
    }
    if (pinned.length > 0) {
      const collapsed = !!ui.collapsedSections.pinned;
      pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Pinned' + ansi.reset, { action: 'toggle-section', section: 'pinned' });
      if (!collapsed) {
        for (const b of pinned) {
          // 핀은 눈에 잘 띄라고 모아 둔 목록이니, 현재 브랜치처럼 @리모트와 push/pull
          // 대기 수까지 붙여 여기만 보고도 상태를 알 수 있게 한다.
          pushLine(branchLine(b.isCurrent ? 2 : 4, b.name, b.name, b.isCurrent, false,
            b.isCurrent ? currentBranchTag : '', branchesInOtherWorktrees.has(b.name),
            branchTrackParts(b)), { action: 'goto-branch', branch: b.name });
        }
      }
    }
  }

  // Branches
  // 상단 브랜치명 클릭 시 스크롤 대상 — 목록에 실제로 그려진 그 브랜치 줄의 인덱스.
  const revealTarget = ui.leftRevealBranch;
  let revealLineIdx = -1;
  {
    const collapsed = !!ui.collapsedSections.branches;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Branches' + ansi.reset, { action: 'toggle-section', section: 'branches' });
    if (!collapsed) {
      const groups = new Map();
      const topLevel = [];
      for (const b of state.branches) {
        const slashIdx = b.name.indexOf('/');
        if (slashIdx >= 0) {
          const prefix = b.name.substring(0, slashIdx);
          const rest = b.name.substring(slashIdx + 1);
          if (!groups.has(prefix)) groups.set(prefix, []);
          groups.get(prefix).push({ ...b, shortName: rest });
        } else {
          topLevel.push(b);
        }
      }
      for (const [prefix, items] of groups) {
        const groupKey = 'b:' + prefix;
        const groupCollapsed = !!ui.collapsedGroups[groupKey];
        pushLine(colors.dim + '   ' + (groupCollapsed ? ARROW_CLOSED : ARROW_OPEN) + ' ' + prefix + '/' + ansi.reset, { action: 'toggle-group', group: groupKey });
        if (!groupCollapsed) {
          for (const item of items) {
            const fullName = prefix + '/' + item.shortName;
            if (revealTarget && fullName === revealTarget) revealLineIdx = lines.length;
            pushLine(branchLine(item.isCurrent ? 4 : 6, item.shortName, fullName, item.isCurrent, false,
              item.isCurrent ? currentBranchTag : '', branchesInOtherWorktrees.has(fullName),
              isPinnedBranch(fullName) ? branchTrackParts(item) : null), { action: 'goto-branch', branch: fullName });
          }
        }
      }
      for (const b of topLevel) {
        if (revealTarget && b.name === revealTarget) revealLineIdx = lines.length;
        pushLine(branchLine(b.isCurrent ? 2 : 4, b.name, b.name, b.isCurrent, false,
          b.isCurrent ? currentBranchTag : '', branchesInOtherWorktrees.has(b.name),
          isPinnedBranch(b.name) ? branchTrackParts(b) : null), { action: 'goto-branch', branch: b.name });
      }
    }
  }

  // Remotes
  {
    const collapsed = !!ui.collapsedSections.remotes;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Remotes' + ansi.reset, { action: 'toggle-section', section: 'remotes' });
    if (!collapsed && state.remoteBranches.length > 0) {
      const remoteGroups = new Map();
      for (const rb of state.remoteBranches) {
        const slashIdx = rb.indexOf('/');
        if (slashIdx >= 0) {
          const remote = rb.substring(0, slashIdx);
          const branch = rb.substring(slashIdx + 1);
          if (!remoteGroups.has(remote)) remoteGroups.set(remote, []);
          remoteGroups.get(remote).push(branch);
        }
      }
      let remoteEntries = Array.from(remoteGroups.entries());
      remoteEntries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [remote, branchesRaw] of remoteEntries) {
        let branches = branchesRaw.slice();
        const mode = ui.remoteSortMode || 'alpha';
        if (mode === 'alpha') {
          branches.sort((a, b) => a.localeCompare(b));
        } else if (mode === 'alpha_desc') {
          branches.sort((a, b) => b.localeCompare(a));
        } else {
          branches.sort((a, b) => {
            const fullA = remote + '/' + a;
            const fullB = remote + '/' + b;
            const ta = ui.remoteRecentBranchUsage[fullA] || 0;
            const tb = ui.remoteRecentBranchUsage[fullB] || 0;
            if (tb !== ta) return tb - ta;
            return a.localeCompare(b);
          });
        }
        const remoteKey = 'r:' + remote;
        const remoteCollapsed = !!ui.collapsedGroups[remoteKey];
        pushLine(colors.dim + '   ' + (remoteCollapsed ? ARROW_CLOSED : ARROW_OPEN) + ' ' + remote + ansi.reset, { action: 'toggle-group', group: remoteKey });
        if (!remoteCollapsed) {
          // Sub-group by prefix within this remote
          const subGroups = new Map();
          const topLevel = [];
          for (const b of branches) {
            const slashIdx = b.indexOf('/');
            if (slashIdx >= 0) {
              const prefix = b.substring(0, slashIdx);
              const rest = b.substring(slashIdx + 1);
              if (!subGroups.has(prefix)) subGroups.set(prefix, []);
              subGroups.get(prefix).push({ shortName: rest, fullRef: remote + '/' + b });
            } else {
              topLevel.push({ shortName: b, fullRef: remote + '/' + b });
            }
          }
          for (const [prefix, items] of subGroups) {
            const subKey = 'r:' + remote + '/' + prefix;
            const subCollapsed = !!ui.collapsedGroups[subKey];
            pushLine(colors.dim + '     ' + (subCollapsed ? ARROW_CLOSED : ARROW_OPEN) + ' ' + prefix + '/' + ansi.reset, { action: 'toggle-group', group: subKey });
            if (!subCollapsed) {
              for (const item of items) {
                pushLine(branchLine(8, item.shortName, item.fullRef, false, true), { action: 'goto-branch', branch: item.fullRef });
              }
            }
          }
          for (const item of topLevel) {
            pushLine(branchLine(6, item.shortName, item.fullRef, false, true), { action: 'goto-branch', branch: item.fullRef });
          }
        }
      }
    }
  }

  // Worktrees — 목록 첫 항목은 항상 메인 워크트리이므로,
  // linked worktree가 하나라도 있을 때(길이 > 1)만 루트 노드를 노출한다.
  if (state.worktrees.length > 1) {
    const collapsed = !!ui.collapsedSections.worktrees;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Worktrees (' + state.worktrees.length + ')' + ansi.reset, { action: 'toggle-section', section: 'worktrees' });
    if (!collapsed) {
      // git은 워크트리에 별도 이름을 주지 않는다(.git/worktrees/<id>는 생성 시점 폴더명에서
      // 파생된 내부 식별자일 뿐이고 worktree list도 알려주지 않는다). 표시는 폴더명 기준인데,
      // 부모만 다르고 폴더명이 같으면 경로를 감춘 상태에서 구분이 안 되므로 부모까지 붙인다.
      const labelCounts = new Map();
      for (const w of state.worktrees) {
        const b = basename(w.path || '');
        if (b) labelCounts.set(b, (labelCounts.get(b) || 0) + 1);
      }
      const worktreeLabel = (w) => {
        const b = basename(w.path || '');
        if (!b) return w.path || '(unknown)';
        if ((labelCounts.get(b) || 0) < 2) return b;
        const parent = basename((w.path || '').replace(/[\\/]+[^\\/]+[\\/]*$/, ''));
        return parent ? parent + '/' + b : b;
      };
      for (const wt of state.worktrees) {
        const stateParts = [];
        if (wt.branch) stateParts.push(wt.branch);
        else if (wt.isDetached) stateParts.push('detached');
        if (wt.isBare) stateParts.push('bare');
        if (wt.isLocked) stateParts.push('locked');
        if (wt.isPrunable) stateParts.push('prunable');
        // 메인/linked 구분은 이름 옆 역할 표기로 — 브랜치명(예: main)과 섞이지 않게 분리한다.
        const role = wt.isMain ? ' (main)' : '';
        const label = worktreeLabel(wt);
        const detail = stateParts.length > 0 ? '  ' + stateParts.join(', ') : '';
        const labelW = Math.max(1, innerW - 6 - visLen(detail) - visLen(role));
        const line = (wt.isCurrent ? '  ' + colors.green + ansi.bold + '\u2713 ' : '    ')
          + colors.value + truncate(label, labelW) + ansi.reset
          + (role ? colors.dim + role + ansi.reset : '')
          + (detail ? colors.dim + detail + ansi.reset : '');
        // 절대경로는 패널을 넘치게 하므로 표시하지 않는다.
        // 경로 확인/이동은 우클릭 메뉴(Copy Path / Show in Explorer / Open in File Explorer)로 한다.
        const wtEntry = { action: 'goto-worktree', path: wt.path };
        pushLine(wt.isCurrent ? rowBg(line, colors.cursorBg) : line, wtEntry);
      }
    }
  }

  // Stashes
  if (state.stashes.length > 0) {
    const collapsed = !!ui.collapsedSections.stashes;
    pushLine(colors.sectionHeader + ansi.bold + ' ' + (collapsed ? ARROW_CLOSED : ARROW_OPEN) + ' Stashes' + ansi.reset, { action: 'toggle-section', section: 'stashes' });
    if (!collapsed) {
      for (const s of state.stashes) {
        const isActive = activeBranch === 'stash:' + s.shortHash;
        const stashLabel = s.message ? s.ref + ' ' + s.message : s.ref;
        const content = '  ' + STASH_TEXT + truncate(stashLabel, innerW - 2) + ansi.reset;
        pushLine(isActive ? rowBg(content, colors.cursorBg) : content, { action: 'goto-stash', shortHash: s.shortHash, ref: s.ref });
      }
    }
  }

  ui.leftTabInfo = null;
  const maxScroll = Math.max(0, lines.length - h);
  ui.leftMaxScroll = maxScroll;
  if (ui.leftPanelScrollOffset > maxScroll) ui.leftPanelScrollOffset = maxScroll;

  // 상단 브랜치명 클릭 → Branches 목록의 그 줄이 보이도록 최소한만 스크롤한다.
  // 위아래 여유(margin)를 둬서 뷰포트 가장자리에 딱 붙지 않게 한다.
  // 오프셋만 바꾸면 프레임 끝의 scroll.set(scroll.js)으로 호스트 스크롤도 따라온다.
  if (revealTarget) {
    ui.leftRevealBranch = null;
    if (revealLineIdx >= 0 && h > 0) {
      const margin = Math.min(2, Math.max(0, (h - 1) >> 1));
      let off = ui.leftPanelScrollOffset;
      if (revealLineIdx - margin < off) off = revealLineIdx - margin;
      else if (revealLineIdx + margin > off + h - 1) off = revealLineIdx + margin - h + 1;
      ui.leftPanelScrollOffset = Math.max(0, Math.min(maxScroll, off));
    }
  }

  if (maxScroll > 0) {
    ui.scrollPct.status = Math.round((ui.leftPanelScrollOffset / maxScroll) * 100);
  } else {
    ui.scrollPct.status = -1;
  }
  const off = ui.leftPanelScrollOffset;
  ui.leftPanelClickMap = clickMap.slice(off, off + h);
  const visibleLines = lines.slice(off, off + h);

  if (hostScroll.isActive() && h > 0) {
    ui.hostScrollRegions.push({
      id: 'left', panel: 'left', relRow: 0, width: innerW, height: h,
      contentRows: lines.length, off,
      bank: hostScroll.buildBank('left', (i) => lines[i], off, h),
    });
  }

  // Apply hover highlight
  // 밑줄만 씌우면 줄 안의 reset이 그걸 끊어 브랜치명 뒤(@리모트, 화살표, 태그)가 하이라이트에서
  // 빠진다. 파일/로그 목록과 같이 기존 배경을 걷어내고 reset 뒤마다 스타일을 다시 깔아
  // 배경과 밑줄이 줄 끝까지 한 줄로 이어지게 한다.
  const hoverRow = ui.hoveredLeftPanelRow;
  if (hoverRow >= 0 && hoverRow < visibleLines.length && ui.leftPanelClickMap[hoverRow]) {
    const hoverStyle = colors.hoverBg + CSI + '4m';
    const deBg = visibleLines[hoverRow].replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
    visibleLines[hoverRow] = hoverStyle + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + hoverStyle), innerW) + ansi.reset;
  }

  return visibleLines;
}

// 상단 브랜치명 클릭 처리 — Branches 목록의 그 브랜치 줄을 화면에 드러낸다.
// 섹션이나 prefix 그룹이 접혀 있으면 그 줄 자체가 그려지지 않아 스크롤할 대상이 없으므로,
// 상위 토글을 모두 펼친 뒤 실제 스크롤은 다음 buildLeftPanel에서 (펼친 뒤의) 줄 인덱스로 한다.
function revealBranch(branchName) {
  if (!branchName) return;
  ui.collapsedSections.branches = false;
  const slashIdx = branchName.indexOf('/');
  if (slashIdx > 0) ui.collapsedGroups['b:' + branchName.substring(0, slashIdx)] = false;
  ui.leftRevealBranch = branchName;
}

// ── Middle panel (diff mode): file list ──

function buildFileListPanel(w, h) {
  const lines = [];
  const lineToFileIdx = [];
  const innerW = w - 1;
  let cursorLineIdx = -1;
  let listIdx = 0;
  const cursorBgColor = listCursorBg();
  ui.fileHeaderZones = [];

  if (state.loading) {
    ui.fileLineMap = [];
    ui.filesMaxScroll = 0;
    ui.scrollPct.files = -1;
    return [colors.dim + ' Loading status...' + ansi.reset].slice(0, h);
  }

  // 그릴 줄은 buildFileList 가 정한다 — 커서·다중 선택·클릭 맵이 전부 이 목록의 인덱스를
  // 가리키므로, 화면을 따로 만들면 보이는 줄과 인덱스가 어긋난다. 트리 모드의 폴더 줄도
  // 여기 섞여 들어오므로 아래 루프는 두 모드를 구분하지 않는다.
  const fileList = buildFileList();

  // 줄에서 가로로 스크롤되는 부분(들여쓰기 + 이름). 평면 모드는 depth 0 에 name 이
  // 경로 전체라 예전과 같은 문자열이 나온다.
  function entryText(item) {
    return '  '.repeat(item.depth || 0) + item.name + (item.kind === 'dir' ? '/' : '');
  }

  // Pre-compute horizontal scroll to reserve row for scrollbar
  // Only count files in non-collapsed sections
  let preMaxFileW = 0;
  for (const item of fileList) {
    const fw = entryText(item).length;
    if (fw > preMaxFileW) preMaxFileW = fw;
  }
  const filesContentWPre = Math.max(1, innerW - 6);
  const preFilesMaxScrollX = Math.max(0, preMaxFileW - filesContentWPre);
  const hasFilesHScrollbar = preFilesMaxScrollX > 0;
  if (hasFilesHScrollbar && h > 1) h--;

  function pushFileLine(content, fileIdx) {
    lineToFileIdx.push(fileIdx);
    if (visLen(content) > innerW) content = truncate(content, innerW);
    lines.push(content);
  }

  function statusColor(s) {
    if (s === 'D') return colors.red;
    if (s === 'U') return colors.red;  // unmerged/conflict
    if (s === 'A') return colors.green;
    if (s === 'R' || s === 'C') return colors.cyan;
    return colors.orange;
  }

  // 파일 줄과 폴더 줄을 한 자리에서 그린다. 상태 글자 자리(4번째 칸)에 폴더는 접힘
  // 표시(+/-)를 놓아, 이름 칸이 어느 줄에서나 같은 열에서 시작하게 한다.
  function pushEntryLine(item, idx) {
    const isCursor = state.cursor === idx;
    const isMultiSel = state.selectedFiles.has(idx);
    if (isCursor) cursorLineIdx = lines.length;
    const bgColor = isMultiSel ? colors.selectedBg : (isCursor ? cursorBgColor : '');
    const resetTo = bgColor ? ansi.reset + bgColor : ansi.reset;
    const prefix = isMultiSel ? bgColor + colors.value + ' \u2713 ' : '   ';
    let mark;
    if (item.kind === 'dir') mark = colors.dim + (item.collapsed ? '+' : '-');
    else if (item.type === 'untracked') mark = colors.dim + '?';
    else if (item.type === 'ignored') mark = colors.dim + '!';
    else mark = statusColor(item.status) + item.status;
    const text = sliceByWidth(entryText(item), state.filesScrollX, innerW - 6);
    // 무시된 파일과 폴더 이름은 눌러 둔다 — 변경 자체가 아니라 그 둘레의 정보다.
    const dim = item.kind === 'dir' || item.section === 'ignored';
    const body = dim ? colors.dim + text + resetTo : text;
    pushFileLine(bgColor + padRight(prefix + mark + resetTo + ' ' + body, innerW) + ansi.reset, idx);
  }

  // 한 구획(Unstaged / Staged / Ignored)에 속한 줄을 목록 순서대로 소진한다.
  function pushSection(section) {
    while (listIdx < fileList.length && fileList[listIdx].section === section) {
      pushEntryLine(fileList[listIdx], listIdx);
      listIdx++;
    }
  }

  // Unstaged (includes untracked)
  const unstagedCount = state.unstaged.length + state.untracked.length;
  {
    const headerLabel = ' Unstaged (' + unstagedCount + ')';
    const unlockLabel = state.indexLocked ? 'Unlock' : '';
    const allBtnLabel = 'Stage All';
    const btnLabel = 'Stage';
    const unlockLen = unlockLabel ? unlockLabel.length + 1 : 0;
    const totalBtnLen = unlockLen + allBtnLabel.length + 1 + btnLabel.length;
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - totalBtnLen - 1);

    let cursorCol = headerLabelLen + gap;
    let unlockSeg = '';
    if (unlockLabel) {
      const unlockZoneIdx = ui.fileHeaderZones.length;
      const unlockOn = caps().isEnabled('unlockIndex');
      const unlockStyle = buttonStyle(unlockOn, ui.hoveredFileHeaderIdx === unlockZoneIdx, colors.red + ansi.bold);
      ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: cursorCol, btnColEnd: cursorCol + unlockLabel.length - 1, action: 'unlockIndex', enabled: unlockOn });
      unlockSeg = unlockStyle + unlockLabel + ansi.reset + ' ';
      cursorCol += unlockLabel.length + 1;
    }

    const allZoneIdx = ui.fileHeaderZones.length;
    const allOn = actionClickable('stageAll');
    const allBtnStyle = actionStyle('stageAll', ui.hoveredFileHeaderIdx === allZoneIdx);

    const zoneIdx = ui.fileHeaderZones.length + 1;
    const selOn = actionClickable('stageSelected');
    const btnStyle = actionStyle('stageSelected', ui.hoveredFileHeaderIdx === zoneIdx);

    const allBtnStart = cursorCol;
    const btnStart = allBtnStart + allBtnLabel.length + 1;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + unlockSeg
      + allBtnStyle + allBtnLabel + ansi.reset + ' '
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: allBtnStart, btnColEnd: allBtnStart + allBtnLabel.length - 1, action: 'stageAll', enabled: allOn });
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: btnStart, btnColEnd: btnStart + btnLabel.length - 1, action: 'stageSelected', enabled: selOn });
    pushFileLine(headerLine, -1);
  }
  pushSection('unstaged');

  // Staged
  {
    const headerLabel = ' Staged (' + state.staged.length + ')';
    const allBtnLabel = 'Unstage All';
    const btnLabel = 'Unstage';
    const totalBtnLen = allBtnLabel.length + 1 + btnLabel.length;
    const headerLabelLen = visLen(headerLabel);
    const gap = Math.max(1, innerW - headerLabelLen - totalBtnLen - 1);

    const allZoneIdx = ui.fileHeaderZones.length;
    const allOn = actionClickable('unstageAll');
    const allBtnStyle = actionStyle('unstageAll', ui.hoveredFileHeaderIdx === allZoneIdx);

    const zoneIdx = ui.fileHeaderZones.length + 1;
    const selOn = actionClickable('unstageSelected');
    const btnStyle = actionStyle('unstageSelected', ui.hoveredFileHeaderIdx === zoneIdx);

    const allBtnStart = headerLabelLen + gap;
    const btnStart = allBtnStart + allBtnLabel.length + 1;
    const headerLine = colors.sectionHeader + ansi.bold + headerLabel + ansi.reset
      + ' '.repeat(gap)
      + allBtnStyle + allBtnLabel + ansi.reset + ' '
      + btnStyle + btnLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: allBtnStart, btnColEnd: allBtnStart + allBtnLabel.length - 1, action: 'unstageAll', enabled: allOn });
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: btnStart, btnColEnd: btnStart + btnLabel.length - 1, action: 'unstageSelected', enabled: selOn });
    pushFileLine(headerLine, -1);
  }
  pushSection('staged');

  // Ignored
  if (state.ignoredLoaded ? (state.ignored.length > 0 || ui.collapsedSections.ignored === false) : true) {
    const ignoredCollapsed = ui.collapsedSections.ignored !== false; // default collapsed
    const arrow = ignoredCollapsed ? '+' : '-';
    const ignoredCount = state.ignoredLoading ? '...' : (state.ignoredLoaded ? String(state.ignored.length) : '?');
    const headerLabel = ' ' + arrow + '  Ignored (' + ignoredCount + ')';
    const zoneIdx = ui.fileHeaderZones.length;
    const isHovered = ui.hoveredFileHeaderIdx === zoneIdx;
    const headerStyle = isHovered ? colors.dim + ansi.bold + CSI + '4m' : colors.dim;
    const headerLine = headerStyle + headerLabel + ansi.reset;
    ui.fileHeaderZones.push({ lineIdx: lines.length, btnColStart: 0, btnColEnd: visLen(headerLabel), action: 'toggleIgnored' });
    pushFileLine(headerLine, -1);
    if (!ignoredCollapsed && !state.ignoredLoaded) {
      pushFileLine(colors.dim + '   Loading ignored files...' + ansi.reset, -1);
    } else if (!ignoredCollapsed) {
      pushSection('ignored');
    }
  }

  ui.filesMaxScrollX = preFilesMaxScrollX;
  if (state.filesScrollX > preFilesMaxScrollX) state.filesScrollX = preFilesMaxScrollX;

  if (fileList.length === 0) {
    pushFileLine(colors.dim + ' Working tree clean' + ansi.reset, -1);
  }

  // Scroll (skip auto-scroll when scrollbar pin is active)
  const filesPinned = ui.filesScrollPin !== undefined && ui.filesScrollPin === state.cursor;
  if (ui.filesScrollPin !== undefined && ui.filesScrollPin !== state.cursor) ui.filesScrollPin = undefined;
  if (!filesPinned && lines.length > h && cursorLineIdx >= 0) {
    if (cursorLineIdx < state.scrollOffset) {
      // Include section headers above the cursor in the viewport
      let target = cursorLineIdx;
      while (target > 0 && lineToFileIdx[target - 1] === -1) target--;
      state.scrollOffset = target;
    } else if (cursorLineIdx >= state.scrollOffset + h) {
      state.scrollOffset = cursorLineIdx - h + 1;
    }
  } else if (!filesPinned) {
    state.scrollOffset = Math.min(state.scrollOffset, Math.max(0, lines.length - h));
  }

  const filesMaxScroll = Math.max(0, lines.length - h);
  ui.filesMaxScroll = filesMaxScroll;
  if (filesMaxScroll > 0) {
    ui.scrollPct.files = Math.round((state.scrollOffset / filesMaxScroll) * 100);
  } else {
    ui.scrollPct.files = -1;
  }
  ui.fileLineMap = lineToFileIdx.slice(state.scrollOffset, state.scrollOffset + h);
  const visibleLines = lines.slice(state.scrollOffset, state.scrollOffset + h);

  if (hostScroll.isActive() && h > 0) {
    const off = state.scrollOffset;
    ui.hostScrollRegions.push({
      id: 'files', panel: 'middle', relRow: 0, width: innerW, height: h,
      contentRows: lines.length, off,
      bank: hostScroll.buildBank('files', (i) => lines[i], off, h),
    });
  }

  // Apply hover highlight to file list
  // 커서 줄은 건너뛴다 — 덮어쓰면 마우스를 올린 동안 선택이 풀린 것처럼 보인다.
  const hoverRow = ui.hoveredFileRow;
  if (hoverRow >= 0 && hoverRow < visibleLines.length && ui.fileLineMap[hoverRow] >= 0
      && ui.fileLineMap[hoverRow] !== state.cursor) {
    const orig = visibleLines[hoverRow];
    // Remove existing background and apply hover
    const deBg = orig.replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
    visibleLines[hoverRow] = colors.hoverBg + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + colors.hoverBg), innerW) + ansi.reset;
  }

  // Append empty row for horizontal scrollbar
  if (hasFilesHScrollbar) visibleLines.push('');

  return visibleLines;
}

// ── Right panel (diff mode): diff + commit area ──

function buildDiffCommitPanel(w, h) {
  const lines = [];
  const innerW = w - 1;
  const isConflictView = !!(state.conflictView && state.conflictView.file === state.currentDiffFile);
  const diffItem = selectedItem();

  let msgLineCount = 1;
  if (state.mode === 'commit') {
    msgLineCount = state.commitMsg.split('\n').length;
  }
  const maxMsgLines = Math.max(1, Math.min(msgLineCount, Math.floor((h - 2) / 2)));
  const commitExtraH = state.conflictView ? 1 : 0;
  // amend 토글은 별도 행이 아니라 Commit 버튼과 같은 행에 표시하므로 높이 추가 없음
  const commitAreaH = h >= 5 ? (2 + maxMsgLines + commitExtraH) : 0;
  let diffH = h - commitAreaH;

  let preMaxScrollX = 0;
  let annotated = null;
  let sideBySideLayout = null;
  let numW = 0; let gutterW = 0; let contentW = 0;
  if (!isConflictView && state.diffLines.length > 0 && diffH > 0) {
    if (diffItem && (diffItem.type === 'staged' || diffItem.type === 'unstaged') && state.diffView === 'side') {
      sideBySideLayout = buildSideBySideDiffLayout(state.diffLines, innerW);
      if (sideBySideLayout) {
        preMaxScrollX = sideBySideLayout.maxScrollX;
      }
    }

    if (!sideBySideLayout) {
      annotated = annotateDiffLineNumbers(state.diffLines);
      numW = annotated.maxLine > 0 ? String(annotated.maxLine).length : 0;
      gutterW = numW > 0 ? numW * 2 + 2 : 0;
      contentW = innerW - (gutterW > 0 ? gutterW : 1);
      let maxLineW = 0;
      for (const line of state.diffLines) {
        const plain = line.replace(/[\r\n]/g, '');
        if (isDiffMetaLine(plain)) continue;
        const lw = stripAnsi(expandDiffTabs(plain)).length;
        if (lw > maxLineW) maxLineW = lw;
      }
      preMaxScrollX = Math.max(0, maxLineW - contentW);
    }
  }
  const hasHScrollbar = !isConflictView && preMaxScrollX > 0;
  if (hasHScrollbar) diffH--;

  ui.rightDiffH = diffH;
  ui.commitMsgVisibleLines = maxMsgLines;
  ui.commitAmendBtnOffset = -1; // commit 영역이 렌더되면 아래에서 다시 설정
  ui.commitClearBtnOffset = -1;
  ui.commitMsgCursorMaxW = 0;

  // Hunk 단위 스테이징 버튼 (staged/unstaged diff에서만, untracked/conflict 제외)
  ui.diffHunkZones = [];
  const canHunk = !isConflictView && diffItem && (diffItem.type === 'staged' || diffItem.type === 'unstaged') && state.diffLines.length > 0;
  const hunkBtnLabel = canHunk ? (diffItem.type === 'staged' ? '[Unstage hunk]' : '[Stage hunk]') : '';
  const hunkAvail = hunkBtnLabel ? Math.max(8, innerW - hunkBtnLabel.length - 2) : 0;
  const hunkOn = canHunk && caps().isEnabled('hunk-apply');
  const renderHunkButton = (hunkIdx) => {
    const style = buttonStyle(hunkOn, ui.hoveredDiffHunkIdx === hunkIdx,
      colors.value, colors.green + ansi.bold + CSI + '4m');
    return style + hunkBtnLabel + ansi.reset;
  };

  // Host-owned scroll: the diff area (rows 0..diffH) is one region; renderRow
  // lazily renders the overscan bank rows for content that is only built for
  // the visible slice (unified mode).
  // relRow/height 를 넘기면 그만큼 아래에서 시작하는 좁은 영역만 스크롤한다 —
  // 충돌 뷰가 머리말을 고정해 두는 데 쓴다.
  function pushDiffRegion(contentLen, off, renderRow, relRow, height) {
    const top = relRow || 0;
    const h = height === undefined ? diffH : height;
    if (!hostScroll.isActive() || h <= 0) return;
    const pick = (i) => (i >= 0 && i < contentLen) ? renderRow(i) : '';
    ui.hostScrollRegions.push({
      id: 'diff', panel: 'right', relRow: top, width: innerW, height: h,
      contentRows: contentLen, off,
      bank: hostScroll.buildBank('diff', pick, off, h),
    });
  }

  if (diffH > 0) {
    if (isConflictView) {
      const conflictRender = buildConflictDiffLines(innerW);
      ui.mergeChunkLineMap = conflictRender.chunkLineMap;
      // 머리말은 스크롤에서 뗀다 — 남은 충돌 수, 이동 버튼, 어느 쪽이 어느 브랜치인지는
      // 파일 어디를 보고 있든 필요한 정보다.
      const headerH = Math.min(conflictRender.headerLines.length, diffH);
      const bodyH = Math.max(0, diffH - headerH);
      ui.conflictBodyH = bodyH;
      const maxScroll = Math.max(0, conflictRender.lines.length - bodyH);
      ui.diffMaxScroll = maxScroll;
      ui.diffMaxScrollX = 0;
      state.diffScrollX = 0;
      if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
      // 클릭 좌표는 화면 기준이다 — hunk 버튼과 같은 규칙으로 스크롤을 걷어내고,
      // 뷰포트 밖으로 밀려난 zone 은 버린다. 절대 줄 번호를 그대로 넘기면 스크롤한
      // 만큼 어긋난 자리를 누르게 된다. 머리말 zone 은 고정이라 그대로 쓴다.
      ui.mergeClickZones = conflictRender.headerZones
        .filter(zone => zone.lineIdx < headerH)
        .concat(conflictRender.zones
          .map(zone => ({ ...zone, lineIdx: zone.lineIdx - state.diffScrollOffset + headerH }))
          .filter(zone => zone.lineIdx >= headerH && zone.lineIdx < diffH));
      for (let i = 0; i < headerH; i++) lines.push(conflictRender.headerLines[i]);
      const visible = conflictRender.lines.slice(state.diffScrollOffset, state.diffScrollOffset + bodyH);
      for (const line of visible) lines.push(line);
      ui.scrollPct.diff = maxScroll > 0 ? Math.round((state.diffScrollOffset / maxScroll) * 100) : -1;
      for (let i = headerH + visible.length; i < diffH; i++) lines.push('');
      pushDiffRegion(conflictRender.lines.length, state.diffScrollOffset, (i) => conflictRender.lines[i], headerH, bodyH);
    } else if (state.diffLines.length === 0) {
      ui.mergeClickZones = [];
      ui.mergeChunkLineMap = {};
      // 로딩 중에는 "파일을 고르라"는 안내가 사실과 다르다 — 스피너로 바꾸고,
      // 스피너를 그리기 전 짧은 유예 동안에는 빈 줄로 둔다.
      const spin = panelLoadingLabel('diff', 'Loading diff...');
      if (spin) lines.push(colors.dim + ' ' + spin + ansi.reset);
      else if (state.diffLoading) lines.push('');
      else lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
      for (let i = 1; i < diffH; i++) lines.push('');
      ui.diffMaxScroll = 0;
      ui.diffMaxScrollX = 0;
    } else {
      ui.mergeClickZones = [];
      ui.mergeChunkLineMap = {};
      ui.diffMaxScrollX = preMaxScrollX;
      if (state.diffScrollX > preMaxScrollX) state.diffScrollX = preMaxScrollX;
      const scrollX = state.diffScrollX;

      if (sideBySideLayout) {
        // hunk 행 → hunk 인덱스 매핑 (버튼 렌더/클릭 존용)
        const sideHunkIdxByRow = new Map();
        if (hunkBtnLabel) {
          let hi = 0;
          for (let ri = 0; ri < sideBySideLayout.rows.length; ri++) {
            if (sideBySideLayout.rows[ri].type === 'hunk') { sideHunkIdxByRow.set(ri, hi); hi++; }
          }
        }
        const sideHunkOpts = hunkBtnLabel ? { label: hunkBtnLabel, avail: hunkAvail, renderButton: renderHunkButton, idxByRow: sideHunkIdxByRow } : null;
        const sideBySideLines = renderSideBySideDiffLines(sideBySideLayout, state.currentDiffFile, scrollX, sideHunkOpts);
        const maxScroll = Math.max(0, sideBySideLines.length - diffH);
        ui.diffMaxScroll = maxScroll;
        if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
        const visible = sideBySideLines.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
        for (const line of visible) lines.push(line);
        if (hunkBtnLabel) {
          for (let vi = 0; vi < visible.length; vi++) {
            const absIdx = state.diffScrollOffset + vi;
            if (sideHunkIdxByRow.has(absIdx)) {
              ui.diffHunkZones.push({ lineIdx: vi, colStart: hunkAvail + 1, colEnd: hunkAvail + hunkBtnLabel.length, hunkIdx: sideHunkIdxByRow.get(absIdx) });
            }
          }
        }
        ui.scrollPct.diff = sideBySideLines.length > diffH ? Math.round((state.diffScrollOffset / maxScroll) * 100) : -1;
        for (let i = visible.length; i < diffH; i++) lines.push('');
        pushDiffRegion(sideBySideLines.length, state.diffScrollOffset, (i) => sideBySideLines[i]);
      } else {
        // 실제로 그려지는 건 annotated 다 — 헤더를 걷어낸 만큼 state.diffLines 보다
        // 짧으므로, 스크롤 한계를 원본 길이로 잡으면 끝을 지나 빈 화면까지 내려간다.
        const maxScroll = Math.max(0, annotated.length - diffH);
        ui.diffMaxScroll = maxScroll;
        if (state.diffScrollOffset > maxScroll) state.diffScrollOffset = maxScroll;
        const isHunkEntry = (entry) => entry && entry.inDiff && typeof entry.text === 'string' && entry.text.startsWith('@@');
        const unifiedHunkIdxByRow = new Map();
        if (hunkBtnLabel) {
          let hi = 0;
          for (let ri = 0; ri < annotated.length; ri++) {
            if (isHunkEntry(annotated[ri])) { unifiedHunkIdxByRow.set(ri, hi); hi++; }
          }
        }
        const renderUnifiedRow = (entry, absIdx) => {
          if (hunkBtnLabel && isHunkEntry(entry)) {
            const base = ' ' + colorizeDiffLine(entry.text, hunkAvail - 1, state.currentDiffFile, scrollX);
            return padRight(base, hunkAvail + 1) + renderHunkButton(unifiedHunkIdxByRow.get(absIdx));
          }
          if (entry.inDiff && gutterW > 0) {
            let gutter;
            if (entry.oldNum != null || entry.newNum != null) {
              const oldStr = entry.oldNum != null ? String(entry.oldNum).padStart(numW) : ' '.repeat(numW);
              const newStr = entry.newNum != null ? String(entry.newNum).padStart(numW) : ' '.repeat(numW);
              gutter = colors.dim + oldStr + ' ' + newStr + ansi.reset + ' ';
            } else {
              gutter = ' '.repeat(gutterW);
            }
            return gutter + colorizeDiffLine(entry.text, contentW, state.currentDiffFile, scrollX);
          }
          return ' ' + colorizeDiffLine(entry.text, innerW - 1, state.currentDiffFile, scrollX);
        };
        const visible = annotated.slice(state.diffScrollOffset, state.diffScrollOffset + diffH);
        for (let vi = 0; vi < visible.length; vi++) {
          const absIdx = state.diffScrollOffset + vi;
          lines.push(renderUnifiedRow(visible[vi], absIdx));
          if (hunkBtnLabel && unifiedHunkIdxByRow.has(absIdx)) {
            ui.diffHunkZones.push({ lineIdx: vi, colStart: hunkAvail + 1, colEnd: hunkAvail + hunkBtnLabel.length, hunkIdx: unifiedHunkIdxByRow.get(absIdx) });
          }
        }
        ui.scrollPct.diff = annotated.length > diffH ? Math.round((state.diffScrollOffset / maxScroll) * 100) : -1;
        for (let i = visible.length; i < diffH; i++) lines.push('');
        pushDiffRegion(annotated.length, state.diffScrollOffset, (i) => renderUnifiedRow(annotated[i], i));
      }
      if (hasHScrollbar) lines.push('');
    }
  }

  // Commit area
  if (commitAreaH > 0) {
    lines.push(colors.border + '\u2500'.repeat(w) + ansi.reset);

    if (state.conflictView) {
      // 라벨은 "모든 충돌을 골랐는가"만 따르고(무엇을 더 해야 하는지 알려 주는 안내다),
      // 색은 지금 실제로 누를 수 있는지를 따른다 — 쓰기 작업 중이면 흐려진다.
      const allSelected = actions.allConflictChunksSelected();
      const canApply = allSelected && caps().isEnabled('merge-apply');
      const applyLabel = allSelected ? ' Apply resolution ' : ' Select every conflict to apply ';
      const applyStyle = buttonStyle(canApply, ui.hoveredMergeApplyButton,
        colors.green + ansi.bold, colors.cursorBg + colors.green + ansi.bold + CSI + '4m');
      lines.push(' ' + applyStyle + applyLabel + ansi.reset);
    }

    if (state.mode === 'commit') {
      const msgLines = state.commitMsg.split('\n');
      const cursorLineIdx = state.commitMsg.substring(0, state.commitCursor).split('\n').length - 1;
      const cursorLineStart = state.commitMsg.lastIndexOf('\n', state.commitCursor - 1) + 1;
      const cursorCol = state.commitCursor - cursorLineStart;

      // Vertical viewport: ensure cursor line is visible
      let topLine = Math.max(0, cursorLineIdx - maxMsgLines + 1);
      topLine = Math.min(topLine, Math.max(0, msgLines.length - maxMsgLines));
      ui.commitTopLine = topLine;
      ui.commitCursorLineIdx = cursorLineIdx;

      // 메시지 지우기 버튼: 첫 줄 오른쪽 끝. 지울 내용이 있을 때만 자리를 차지한다.
      const clearLabel = '[X]';
      const showClear = state.commitMsg.length > 0;

      for (let i = 0; i < maxMsgLines; i++) {
        const lineIdx = topLine + i;
        if (lineIdx < msgLines.length) {
          // 버튼이 얹히는 첫 줄만 폭을 양보한다 — 나머지 줄은 끝까지 쓴다.
          const hasBtn = i === 0 && showClear;
          const lineW = hasBtn ? Math.max(8, w - 3 - clearLabel.length) : w - 2;
          const body = lineIdx === cursorLineIdx
            ? viewport(msgLines[lineIdx], cursorCol, lineW)
            : truncate(msgLines[lineIdx], lineW);
          // IME 커서는 이 폭을 기준으로 자리를 잡아야 렌더와 어긋나지 않는다.
          if (lineIdx === cursorLineIdx) ui.commitMsgCursorMaxW = lineW;
          let line = ' ' + colors.value + body + ansi.reset;
          if (hasBtn) {
            const bodyLen = visLen(stripAnsi(body));
            const pad = Math.max(1, (w - 1 - clearLabel.length) - 1 - bodyLen);
            const clearStyle = ui.hoveredCommitClear
              ? colors.red + ansi.bold + CSI + '4m'
              : colors.dim;
            line += ' '.repeat(pad) + clearStyle + clearLabel + ansi.reset;
            ui.commitClearBtnOffset = 1 + bodyLen + pad;
            ui.commitClearBtnLen = clearLabel.length;
          }
          lines.push(line);
        } else {
          lines.push('');
        }
      }
    } else {
      // \uc0c1\ud0dc \uc815\ubcf4 \ud589 (\ub2e8\ucd95\ud0a4 hint \uc5c6\uc774 staged \uac1c\uc218\ub9cc \ud45c\uc2dc)
      const infoText = state.staged.length > 0
        ? state.staged.length + ' file(s) staged'
        : 'No files staged';
      lines.push(' ' + colors.dim + infoText + ansi.reset);
    }

    const isRebaseOp = state.operationState && (state.operationState.type === 'rebase-merge' || state.operationState.type === 'rebase-apply');
    const isMergeOp = state.operationState && (state.operationState.type === 'merge' || state.operationState.type === 'cherry-pick' || state.operationState.type === 'revert');
    // amend 여부는 오른쪽 토글이 표시하므로 메인 버튼 라벨은 'Commit' 유지(중복 'Amend' 방지)
    const commitLabel = isRebaseOp ? 'Continue Rebase' : isMergeOp ? 'Commit ' + (state.operationState.type === 'merge' ? 'Merge' : state.operationState.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert') : 'Commit';
    // 커밋 모드에서는 제출, 일반 모드에서는 커밋 모드 진입 — 누르면 실제로 일어나는 일과
    // 같은 판정을 본다. input.js 의 클릭 처리도 같은 두 id 로 게이트한다.
    const canCommit = state.mode === 'commit'
      ? caps().isEnabled('commit-submit')
      : caps().isEnabled('commit-enter');
    const commitStyle = buttonStyle(canCommit, ui.hoveredCommitButton,
      colors.green + ansi.bold, colors.green + ansi.bold + CSI + '4m');
    let btnLine = ' ' + commitStyle + commitLabel + ansi.reset;
    // Amend 토글: 작업(merge/rebase 등) 중이 아니면 Commit 버튼 오른쪽에 항상 표시
    if (!state.operationState) {
      const amendLabel = (state.commitAmend ? '[x]' : '[ ]') + ' Amend last commit';
      const amendOn = caps().isEnabled('commit-amend');
      const amendStyle = buttonStyle(amendOn, ui.hoveredCommitAmend,
        state.commitAmend ? colors.yellow : colors.value);
      ui.commitAmendBtnOffset = 1 + commitLabel.length + 2; // 선행공백 + commitLabel + 간격(2)
      ui.commitAmendBtnLen = amendLabel.length;
      btnLine += '  ' + amendStyle + amendLabel + ansi.reset;
    } else {
      ui.commitAmendBtnOffset = -1;
    }
    lines.push(btnLine);
  }

  return lines;
}

// ── Right panel (log mode): history + detail (top/bottom split) ──

function buildLogPanel(w, h) {
  if (state.logItems.length === 0) {
    if (state.logLoading) {
      return [colors.dim + ' Loading commits...' + ansi.reset];
    }
    // Filter/Hide 때문에 비었으면 "커밋이 없다"가 아니다. 그대로 두면 저장소가 텅 빈 것처럼
    // 보이고, 지정을 걸어 둔 걸 잊었을 때 왜 이렇게 됐는지 알 길이 없다 — 되돌리는 길까지 적는다.
    if (ui.filteredRefs.length > 0 || ui.hiddenRefs.length > 0) {
      return [
        colors.dim + ' ' + truncate('No commits match the branch filter', w - 1) + ansi.reset,
        '',
        colors.dim + ' ' + truncate('Right-click a branch → Clear All Filters / Show All Branches', w - 1) + ansi.reset,
      ];
    }
    return [colors.dim + ' No commits yet' + ansi.reset];
  }

  const innerW = w - 1;
  // Commits 탭의 상단 버튼은 정렬 토글이라 접기 버튼이 없다 — 커밋 목록은 항상 펼친 상태로 둔다.
  let listH, detailH, separatorH;
  if (ui.rightBottomCollapsed) {
    listH = h; separatorH = 0; detailH = 0;
  } else {
    listH = Math.min(Math.max(1, Math.floor(h * ui.logListRatio)), h - 2);
    separatorH = 1;
    detailH = h - listH - separatorH;
  }
  ui.lastLogListH = listH;
  ui.lastDetailContentH = Math.max(0, detailH - 1);

  const lines = [];

  const selectedItemIdx = state.logSelectables.length > 0
    ? state.logSelectables[Math.min(state.logCursor, state.logSelectables.length - 1)]
    : -1;

  const logPinned = ui.logScrollPin !== undefined && ui.logScrollPin === state.logCursor;
  if (ui.logScrollPin !== undefined && ui.logScrollPin !== state.logCursor) ui.logScrollPin = undefined;
  if (!logPinned && selectedItemIdx >= 0) {
    if (selectedItemIdx < state.logScrollOffset) {
      state.logScrollOffset = selectedItemIdx;
    } else if (selectedItemIdx >= state.logScrollOffset + listH) {
      state.logScrollOffset = selectedItemIdx - listH + 1;
    }
  }
  state.logScrollOffset = Math.max(0, Math.min(state.logScrollOffset, Math.max(0, state.logItems.length - listH)));

  // -- Item list --
  const visibleItems = state.logItems.slice(state.logScrollOffset, state.logScrollOffset + listH);

  // Compute max natural width among visible rows (trim trailing empty lanes)
  let maxNaturalWidth = 1;
  for (const item of visibleItems) {
    if (item && item.naturalWidth && item.naturalWidth > maxNaturalWidth) {
      maxNaturalWidth = item.naturalWidth;
    }
  }
  const graphRows = [];
  let graphWidth = 0;
  const logFocused = state.focusPanel === 'status';
  const cursorBgColor = listCursorBg();
  function renderLogRow(itemIdx) {
    const item = itemIdx >= 0 ? state.logItems[itemIdx] : null;
    if (!item) return { text: '', graph: null };

    const isCursor = itemIdx === selectedItemIdx;

    if (item.type === 'commit') {
      const prefix = ' ';
      const graphVisLen = maxNaturalWidth;
      // 그래프 칸은 공백으로 채워 밑바탕 텍스트 셀을 매 프레임 비운다. sixel이 그 위에
      // 그려진다. (예전엔 CUF로 이 칸을 건너뛰어 깜빡임을 줄였으나, 밑바탕 셀이 옛 텍스트를
      // 계속 들고 있어 빠른 host-scroll 중 sixel이 못 덮는 순간 stale 텍스트가 새어 나왔다.)
      const graphPart = ' '.repeat(graphVisLen) + ' ';
      const fixedLen = 1 + graphVisLen + 1 + 7 + 1;
      const available = innerW - fixedLen;
      const decoRawOrig = item.decoration ? item.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      const isHead = /(?:^|,\s*)HEAD(?:\s*->|,|\s*$)/.test(decoRawOrig);
      const decoTokens = buildDecoTokens(decoRawOrig.split(', ').map(r =>
        r.startsWith('HEAD -> ') ? r.substring(8) : r
      ).join(', '), state.branch);
      // 폭 계산은 축약된 표기 기준이어야 subject 잘림 위치가 어긋나지 않는다
      const decoRaw = decoPlainText(decoTokens);
      const decoColorized = decoRaw ? colorizeDecoTokens(decoTokens, state.branch, isHead) : '';
      const safeSubject = (item.subject || '').replace(/[\r\n]/g, '');
      let subjStr, decoPart;
      if (available <= 0) {
        subjStr = ''; decoPart = '';
      } else if (!decoRaw) {
        subjStr = truncate(safeSubject, available); decoPart = '';
      } else {
        const subjNeed = visLen(safeSubject);
        const decoNeed = visLen(decoRaw) + 1;
        if (subjNeed + decoNeed <= available) {
          subjStr = safeSubject; decoPart = ' ' + decoColorized;
        } else {
          const subjW = Math.min(subjNeed, available - Math.min(decoNeed, Math.max(4, available - subjNeed)));
          subjStr = truncate(safeSubject, subjW);
          const decoW = available - visLen(subjStr);
          if (decoW >= 4) { decoPart = ' ' + truncate(decoColorized, decoW - 1); }
          else { subjStr = truncate(safeSubject, available); decoPart = ''; }
        }
      }
      const resetTo = isCursor ? ansi.reset + cursorBgColor : ansi.reset;
      const subjectStyle = item.isRecovery ? RECOVERY_TEXT : colors.value;
      const hashStyle = item.isRecovery
        ? RECOVERY_TEXT
        : (isHead ? colors.green + ansi.bold : colors.yellow);
      const subjPart = (isHead ? ansi.bold : '') + subjectStyle + subjStr + resetTo;
      const hashPart = hashStyle + item.ref + resetTo;
      const usedLen = 1 + graphVisLen + 1 + visLen(subjStr) + visLen(decoPart);
      const pad = Math.max(1, innerW - usedLen - 7);
      const decoPartFixed = isCursor ? decoPart.replace(/\x1b\[0m/g, resetTo) : decoPart;
      const line = prefix + graphPart + subjPart + decoPartFixed + ' '.repeat(pad) + hashPart;
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
      return {
        text: (isCursor ? cursorBgColor : '') + padRight(line, innerW) + ansi.reset,
        graph: item.chars ? {
          chars: item.chars, charColors: item.charColors, charColorsH: item.charColorsH,
          charStyles: item.charStyles, charStylesH: item.charStylesH,
          nodeUp: item.nodeUp, nodeDown: item.nodeDown,
          isCursor: isCursor && logFocused, isCursorInactive: isCursor && !logFocused,
        } : null,
      };
    } else {
      const graphPart = ' '.repeat(maxNaturalWidth);
      if (item.chars && item.chars.length > graphWidth) graphWidth = item.chars.length;
      return {
        text: ' ' + graphPart,
        graph: item.chars ? {
          chars: item.chars, charColors: item.charColors, charColorsH: item.charColorsH,
          charStyles: item.charStyles, charStylesH: item.charStylesH,
          nodeUp: item.nodeUp, nodeDown: item.nodeDown,
        } : null,
      };
    }
  }
  for (let i = 0; i < listH; i++) {
    const row = renderLogRow(state.logScrollOffset + i);
    lines.push(row.text);
    graphRows.push(row.graph);
  }

  // Apply hover highlight to log list
  const hoverRow = ui.hoveredLogRow;
  if (hoverRow >= 0 && hoverRow < listH) {
    const itemIdx = state.logScrollOffset + hoverRow;
    const item = state.logItems[itemIdx];
    // Only apply hover to commit items (not graph-only rows) and not to cursor
    if (item && item.type === 'commit') {
      const isCursor = itemIdx === selectedItemIdx;
      if (!isCursor) {
        const orig = lines[hoverRow];
        const deBg = orig.replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
        lines[hoverRow] = colors.hoverBg + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + colors.hoverBg), innerW) + ansi.reset;
        if (graphRows[hoverRow]) graphRows[hoverRow].isHover = true;
      }
    }
  }

  // Host-owned scroll: register the list as a region with its negotiated
  // overscan bank rows (rows above the viewport + rows below) so the host can
  // reveal them while scrolling.
  // Region registration only needs isActive(); the bank contents and the
  // bank-anchored sixel additionally need the host's confirmation (isReady).
  //
  // 목록이 뷰포트 안에 다 들어오면 스크롤할 여지가 없다. 이때 호스트는 region의 overscan을
  // 합성해 줄 이유가 없고, 그러면 화면 밖 bank 행에 앵커한 그래프 sixel은 영영 화면에
  // 나타나지 않는다 — 커밋 수가 적은 저장소에서 브랜치 트리가 통째로 사라지던 원인이다.
  // 스크롤이 불가능할 땐 bank를 쓰지 않고 보이는 행에 직접 그린다(원래 호스트 확인 전에
  // 쓰던 경로와 같다).
  const listScrollable = state.logItems.length > listH;
  const useHostScroll = hostScroll.isActive() && listH > 0 && listScrollable
    && hostScroll.isReady('logList');
  const logDepth = hostScroll.depthOf('logList');
  let logBankRows = null;
  if (hostScroll.isActive() && listH > 0) {
    const off = state.logScrollOffset;
    if (useHostScroll) {
      // Same order as buildBank: `before` rows above (oldest first), then
      // `after` rows below. Kept as row objects because the graph column needs
      // the per-row glyph data, not just the text.
      logBankRows = [];
      for (let i = logDepth.before; i >= 1; i--) logBankRows.push(renderLogRow(off - i));
      for (let i = 0; i < logDepth.after; i++) logBankRows.push(renderLogRow(off + listH + i));
    }
    ui.hostScrollRegions.push({
      id: 'logList', panel: 'right', relRow: 0, width: innerW, height: listH,
      contentRows: state.logItems.length, off,
      bank: logBankRows ? logBankRows.map(r => r.text) : [],
    });
  }

  // Sixel. With host scroll the graph covers the overscan range too
  // ([off-before, off+listH+after-1]) and is anchored at the first bank row,
  // which the host maps to `before` rows above the viewport.
  if (SIXEL_ENABLED && graphRows.length > 0 && maxNaturalWidth > 0) {
    const off = state.logScrollOffset;
    const sixelGraphRows = useHostScroll
      ? [
          ...logBankRows.slice(0, logDepth.before).map(r => r.graph),
          ...graphRows,
          ...logBankRows.slice(logDepth.before).map(r => r.graph),
        ]
      : graphRows;
    const pixBuf = renderCombinedGraphPixels(sixelGraphRows, maxNaturalWidth, ui.cellW, ui.cellH);
    if (pixBuf) {
      const pixelW = maxNaturalWidth * ui.cellW;
      const pixelH = sixelGraphRows.length * ui.cellH;
      ui.logSixelOverlay = encodeSixel(pixBuf, pixelW, pixelH, SIXEL_PALETTE);
      ui.logSixelOverlaySize = { pixelW, pixelH };
      ui.logSixelAnchorBank = useHostScroll;
    }
  } else {
    ui.logSixelOverlay = null;
    ui.logSixelOverlaySize = null;
    ui.logSixelAnchorBank = false;
  }

  // Scroll pct for title
  if (listH > 0 && state.logItems.length > listH) {
    const maxScroll = Math.max(1, state.logItems.length - listH);
    ui.logListMaxScroll = maxScroll;
    ui.scrollPct.history = Math.round((state.logScrollOffset / maxScroll) * 100);
  } else {
    ui.logListMaxScroll = 0;
    ui.scrollPct.history = -1;
  }

  // Build filtered detail lines (respecting collapsed files)
  // 커밋 헤더는 바로 나오고 본문/패치는 늦게 온다 — 그 사이 상세 끝에 스피너를 붙인다.
  // 스크롤 한계도 이 목록에서 나오므로 원본에 얹어 두고 한 번에 계산한다.
  const detailSpin = panelLoadingLabel('logDetail', 'Loading diff...');
  const detailSource = detailSpin ? [...state.logDetailLines, '', detailSpin] : state.logDetailLines;
  const filteredDetail = filterLogDetailLines(detailSource, ui.collapsedDetailFiles);
  ui.filteredDetailCount = filteredDetail.length;

  // Pre-calculate detail scroll pct for separator. Display only — the
  // authoritative clamp lives in the detail section below, whose cH also
  // subtracts the h-scrollbar and sticky-header rows. Clamping state here with
  // the rough cH squeezed the offset below the host's scroll limit, letting
  // the trackpad overscroll at the bottom (jitter + revealed blank rows).
  if (detailH > 1 && filteredDetail.length > 0) {
    const cH = detailH - 1;
    const maxDetailScroll = Math.max(0, filteredDetail.length - cH);
    if (filteredDetail.length > cH) {
      const pctOff = Math.min(state.diffScrollOffset, maxDetailScroll);
      ui.scrollPct.detail = Math.round((pctOff / Math.max(1, maxDetailScroll)) * 100);
    }
  } else {
    ui.logDetailMaxScroll = 0;
  }

  // -- Separator --
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // -- Detail --
  ui.detailFileHeaderMap = [];
  ui.detailCopyZones = [];
  if (detailH > 0) {
    const selItem = selectedLogRef();
    if (state.logDetailLines.length === 0) {
      lines.push(colors.dim + ' Select an item to view details' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
      ui.logDetailMaxScrollX = 0;
    } else {
      const refsRaw = selItem && selItem.decoration ? selItem.decoration.replace(/^\s*\(/, '').replace(/\)$/, '') : '';
      // Collapse/Expand All button
      const allDetailFiles = [];
      for (const entry of filteredDetail) {
        if (entry.isFileHeader) allDetailFiles.push(entry.file);
      }
      const hasFiles = allDetailFiles.length > 0;
      const allCollapsed = hasFiles && allDetailFiles.every(f => ui.collapsedDetailFiles.has(f));
      const collapseLabel = hasFiles ? (allCollapsed ? ' Expand All ' : ' Collapse All ') : '';
      const collapseLabelLen = visLen(collapseLabel);
      function buildRefsLine(refsRaw, maxW, lineIdx) {
        if (!refsRaw) return colors.dim + ' (no refs)' + ansi.reset;
        // Register copy zones and build with hover underline
        let col = 1;
        const refs = refsRaw.split(', ');
        for (const ref of refs) {
          if (col + ref.length > maxW - 1) break;
          const cleanRef = ref.replace(/^HEAD -> /, '');
          ui.detailCopyZones.push({ lineIdx, colStart: col, colEnd: col + ref.length - 1, text: cleanRef });
          col += ref.length + 2;
        }
        // Render with hover underline on hovered ref
        const hoveredZone = ui.hoveredDetailCopyZone;
        if (hoveredZone && hoveredZone.lineIdx === lineIdx) {
          let result = ' ';
          let pos = 1;
          for (const ref of refs) {
            if (pos + ref.length > maxW - 1) break;
            if (pos === hoveredZone.colStart) {
              result += CSI + '4m' + ref + CSI + '24m';
            } else {
              result += ref;
            }
            pos += ref.length;
            if (pos < maxW - 1) { result += ', '; pos += 2; }
          }
          return colors.cyan + result + ansi.reset;
        }
        return colors.cyan + ' ' + truncate(refsRaw, maxW - 2) + ansi.reset;
      }
      if (hasFiles) {
        const refsMaxW = innerW - collapseLabelLen - 1;
        const refsLineIdx = lines.length;
        const refsLine = buildRefsLine(refsRaw, refsMaxW, refsLineIdx);
        const refsVisW = visLen(refsLine);
        const gap = Math.max(1, innerW - refsVisW - collapseLabelLen);
        const btnColStart = refsVisW + gap;
        ui.detailCollapseAllZone = { colStart: btnColStart, colEnd: btnColStart + collapseLabelLen - 1, lineIdx: refsLineIdx };
        const btnStyle = ui.hoveredCollapseAllButton
          ? colors.value + ansi.bold + CSI + '4m'
          : allCollapsed ? colors.cyan : colors.dim;
        lines.push(refsLine + ' '.repeat(gap) + btnStyle + collapseLabel + ansi.reset);
      } else {
        ui.detailCollapseAllZone = null;
        const refsLineIdx = lines.length;
        lines.push(buildRefsLine(refsRaw, innerW, refsLineIdx));
      }
      let cH = detailH - 1;

      // Compute horizontal scroll for log detail
      const logDetailGutterW = filteredDetail.maxLine > 0 ? String(filteredDetail.maxLine).length * 2 + 2 : 0;
      const logDetailContentW = innerW - (logDetailGutterW > 0 ? logDetailGutterW : 1);
      let logDetailMaxLineW = 0;
      for (const entry of filteredDetail) {
        if (entry.text && !entry.isFileHeader && !isDiffMetaLine(entry.text.replace(/[\r\n]/g, ''))) {
          const lw = stripAnsi(expandDiffTabs(entry.text.replace(/[\r\n]/g, ''))).length;
          if (lw > logDetailMaxLineW) logDetailMaxLineW = lw;
        }
      }
      const logDetailMaxScrollX = Math.max(0, logDetailMaxLineW - logDetailContentW);
      ui.logDetailMaxScrollX = logDetailMaxScrollX;
      if (state.diffScrollX > logDetailMaxScrollX) state.diffScrollX = logDetailMaxScrollX;
      if (logDetailMaxScrollX > 0 && cH > 1) cH--;

      // Sticky file header: pin the file name when scrolled past its header.
      // The pinned row consumes a viewport row, so the scroll limit depends on
      // whether the limit position itself shows a sticky (a header landing
      // exactly on the viewport top suppresses it). Resolve that fixed point
      // BEFORE clamping so the plugin's limit and the host's contentRows/height
      // limit agree at every alignment — any mismatch lets the trackpad
      // overscroll at the bottom (jitter + revealed blank bank rows).
      const stickyFileAt = (off) => {
        if (off <= 0 || off >= filteredDetail.length) return null;
        if (filteredDetail[off].isFileHeader) return null;
        for (let i = off - 1; i >= 0; i--) {
          if (filteredDetail[i].isFileHeader) return filteredDetail[i].file;
          if (!filteredDetail[i].inDiff) return null;
        }
        return null;
      };
      const stickyCandidate = Math.max(0, filteredDetail.length - (cH - 1));
      const maxDetailScroll = stickyFileAt(stickyCandidate)
        ? stickyCandidate
        : Math.max(0, stickyCandidate - 1);
      ui.logDetailMaxScroll = maxDetailScroll;
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
      const stickyFile = stickyFileAt(state.diffScrollOffset);
      if (stickyFile) {
        cH--;
        const collapsed = ui.collapsedDetailFiles.has(stickyFile);
        const arrow = collapsed ? '+' : '-';
        const label = ' ' + arrow + ' ' + stickyFile;
        lines.push(ansi.bg(153, 121, 0) + ansi.fg(255, 255, 255) + padRight(truncate(label, innerW), innerW) + ansi.reset);
        ui.detailFileHeaderMap.push(stickyFile);
      }
      ui.lastDetailContentH = cH;

      const detailRegionRelRow = lines.length;
      const visible = filteredDetail.slice(state.diffScrollOffset, state.diffScrollOffset + cH);
      const numW = filteredDetail.maxLine > 0 ? String(filteredDetail.maxLine).length : 0;
      const gutterW = numW > 0 ? numW * 2 + 2 : 0;
      // lineIdx = -1: overscan bank row (skip zone registration / hover)
      function renderDetailRow(entry, lineIdx) {
        if (entry.isFileHeader) {
          const collapsed = ui.collapsedDetailFiles.has(entry.file);
          const arrow = collapsed ? '+' : '-';
          const label = ' ' + arrow + ' ' + entry.file;
          return ansi.bg(153, 121, 0) + ansi.fg(255, 255, 255) + padRight(truncate(label, innerW), innerW) + ansi.reset;
        } else if (/^\u2500{3,}$/.test(entry.text)) {
          return colorizeDiffLine(entry.text, innerW, entry.file);
        } else if (entry.inDiff && gutterW > 0) {
          let gutter;
          if (entry.oldNum != null || entry.newNum != null) {
            const oldStr = entry.oldNum != null ? String(entry.oldNum).padStart(numW) : ' '.repeat(numW);
            const newStr = entry.newNum != null ? String(entry.newNum).padStart(numW) : ' '.repeat(numW);
            gutter = colors.dim + oldStr + ' ' + newStr + ansi.reset + ' ';
          } else {
            gutter = ' '.repeat(gutterW);
          }
          return gutter + colorizeDiffLine(entry.text, innerW - gutterW, entry.file, state.diffScrollX);
        } else {
          const rawText = (entry.text || '').replace(/[\r\n]/g, '');
          // Register copy zones for metadata lines (visible rows only)
          if (lineIdx >= 0) {
            if (rawText.startsWith('commit ')) {
              const hash = rawText.substring(7);
              ui.detailCopyZones.push({ lineIdx, colStart: 8, colEnd: 8 + hash.length - 1, text: hash });
            } else if (rawText.startsWith('Author: ') || rawText.startsWith('Commit: ')) {
              const prefix = rawText.startsWith('Author: ') ? 'Author: ' : 'Commit: ';
              const rest = rawText.substring(prefix.length);
              // Parse: name <email>  date or name  date
              const emailMatch = rest.match(/^(.+?) <(.+?)>(  .+)?$/);
              const noEmailMatch = rest.match(/^(.+?)(  \d{4}-.+)?$/);
              let col = prefix.length + 1; // +1 for leading space
              if (emailMatch) {
                const name = emailMatch[1];
                const email = emailMatch[2];
                const dateStr = emailMatch[3] ? emailMatch[3].substring(2) : '';
                ui.detailCopyZones.push({ lineIdx, colStart: col, colEnd: col + name.length - 1, text: name });
                const emailStart = col + name.length + 2; // ' <'
                ui.detailCopyZones.push({ lineIdx, colStart: emailStart, colEnd: emailStart + email.length - 1, text: email });
                if (dateStr) {
                  const dateStart = emailStart + email.length + 3; // '>  '
                  ui.detailCopyZones.push({ lineIdx, colStart: dateStart, colEnd: dateStart + dateStr.length - 1, text: dateStr });
                }
              } else if (noEmailMatch) {
                const name = noEmailMatch[1];
                const dateStr = noEmailMatch[2] ? noEmailMatch[2].substring(2) : '';
                ui.detailCopyZones.push({ lineIdx, colStart: col, colEnd: col + name.length - 1, text: name });
                if (dateStr) {
                  const dateStart = col + name.length + 2;
                  ui.detailCopyZones.push({ lineIdx, colStart: dateStart, colEnd: dateStart + dateStr.length - 1, text: dateStr });
                }
              }
            }
          }
          // Render with hover underline
          const hz = ui.hoveredDetailCopyZone;
          const hoveredZone = lineIdx >= 0 && hz && hz.lineIdx === lineIdx
            ? ui.detailCopyZones.find(z => z.lineIdx === lineIdx && z.colStart === hz.colStart && z.colEnd === hz.colEnd)
            : null;
          if (hoveredZone) {
            return ' ' + colorizeDiffLineWithUnderline(rawText, innerW - 1, hoveredZone.colStart - 1, hoveredZone.colEnd - 1);
          }
          return ' ' + colorizeDiffLine(entry.text, innerW - 1, entry.file, state.diffScrollX);
        }
      }
      for (const entry of visible) {
        const rendered = renderDetailRow(entry, lines.length);
        lines.push(rendered);
        ui.detailFileHeaderMap.push(entry.isFileHeader ? entry.file : null);
      }
      if (hostScroll.isActive() && cH > 0) {
        const off = state.diffScrollOffset;
        const pick = (i) => (i >= 0 && i < filteredDetail.length) ? renderDetailRow(filteredDetail[i], -1) : '';
        ui.hostScrollRegions.push({
          id: 'logDetail', panel: 'right', relRow: detailRegionRelRow, width: innerW, height: cH,
          // Not filteredDetail.length: the sticky row makes the viewport height
          // position-dependent, so report whatever makes the host's limit
          // (contentRows - height) equal the plugin's true reachable limit.
          contentRows: maxDetailScroll + cH, off,
          bank: hostScroll.buildBank('logDetail', pick, off, cH),
        });
      }
      // Reserve row for horizontal scrollbar
      if (logDetailMaxScrollX > 0) lines.push('');
    }
  }

  return lines;
}

// ── Right panel (fresh mode): file list + detail (top/bottom split) ──

function heatmapColor(date, windowDays) {
  const now = Date.now();
  const fileTime = new Date(date).getTime();
  const ageMs = now - fileTime;
  const windowMs = (windowDays || 7) * 24 * 60 * 60 * 1000;
  const fraction = Math.min(1, Math.max(0, ageMs / windowMs));
  const t = Math.pow(fraction, 0.6);

  // 5 stops: #00E5FF → #00C8C8 → #0096C8 → #646464 → #3C3C3C
  const stops = [
    [0, 229, 255],
    [0, 200, 200],
    [0, 150, 200],
    [100, 100, 100],
    [60, 60, 60],
  ];
  const pos = t * (stops.length - 1);
  const idx = Math.min(Math.floor(pos), stops.length - 2);
  const f = pos - idx;
  const r = Math.round(stops[idx][0] + (stops[idx + 1][0] - stops[idx][0]) * f);
  const g = Math.round(stops[idx][1] + (stops[idx + 1][1] - stops[idx][1]) * f);
  const b = Math.round(stops[idx][2] + (stops[idx + 1][2] - stops[idx][2]) * f);
  return ansi.fg(r, g, b);
}

function relativeDate(date) {
  const now = Date.now();
  const d = new Date(date).getTime();
  const diffSec = Math.floor((now - d) / 1000);
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h';
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return days + 'd';
  return Math.floor(days / 7) + 'w';
}

function freshStatusIcon(status) {
  switch (status) {
    case 'M': return colors.yellow + 'M' + ansi.reset;
    case 'A': return colors.green + 'A' + ansi.reset;
    case 'D': return colors.red + 'D' + ansi.reset;
    case 'R': return colors.cyan + 'R' + ansi.reset;
    case '?': return colors.dim + '?' + ansi.reset;
    default:  return colors.dim + status + ansi.reset;
  }
}

function buildFreshPanel(w, h) {
  if (state.freshItems.length === 0) {
    return [colors.dim + ' No fresh files' + ansi.reset];
  }

  const innerW = w - 1;
  let listH, detailH, separatorH;
  if (ui.rightTopCollapsed && ui.rightBottomCollapsed) {
    listH = 0; separatorH = 0; detailH = 0;
  } else if (ui.rightTopCollapsed) {
    listH = 0; separatorH = 0; detailH = h;
  } else if (ui.rightBottomCollapsed) {
    listH = h; separatorH = 0; detailH = 0;
  } else {
    listH = Math.min(Math.max(1, Math.floor(h * ui.logListRatio)), h - 2);
    separatorH = 1;
    detailH = h - listH - separatorH;
  }
  ui.lastFreshListH = listH;

  const lines = [];
  const lineToFileIdx = [];
  const tw = FRESH_TIME_WINDOWS[state.freshTimeWindow] || FRESH_TIME_WINDOWS[1];

  // -- Header line (time window indicator, clickable) --
  ui.freshWindowZone = null;
  if (listH > 0) {
    const btnLabel = ' ' + tw.label + ' ';
    const btnLen = visLen(btnLabel);
    const suffix = '  ' + colors.dim + state.freshItems.length + ' file(s)' + ansi.reset;
    const isHovered = ui.hoveredFreshWindow;
    const btnStyle = isHovered ? colors.cursorBg + colors.cyan + ansi.bold + CSI + '4m' : colors.cyan;
    const headerLabel = btnStyle + btnLabel + ansi.reset + suffix;
    lines.push(truncate(headerLabel, innerW));
    lineToFileIdx.push(-1);
    // Record click zone (relative col within right panel, will be resolved in input.js)
    ui.freshWindowZone = { lineIdx: 0, colStart: 0, colEnd: btnLen - 1 };
  }

  // -- File list --
  const fileListH = Math.max(0, listH - 1);
  const selectedItemIdx = Math.min(state.freshCursor, state.freshItems.length - 1);

  // Auto-scroll (skip when scrollbar pin is active)
  const freshPinned = ui.freshScrollPin !== undefined && ui.freshScrollPin === state.freshCursor;
  if (ui.freshScrollPin !== undefined && ui.freshScrollPin !== state.freshCursor) ui.freshScrollPin = undefined;
  if (!freshPinned && selectedItemIdx >= 0) {
    if (selectedItemIdx < state.freshScrollOffset) {
      state.freshScrollOffset = selectedItemIdx;
    } else if (selectedItemIdx >= state.freshScrollOffset + fileListH) {
      state.freshScrollOffset = selectedItemIdx - fileListH + 1;
    }
  }
  state.freshScrollOffset = Math.max(0, Math.min(state.freshScrollOffset, Math.max(0, state.freshItems.length - fileListH)));

  const visibleItems = state.freshItems.slice(state.freshScrollOffset, state.freshScrollOffset + fileListH);
  const cursorBgColor = listCursorBg();
  function renderFreshRow(itemIdx) {
    const item = itemIdx >= 0 ? state.freshItems[itemIdx] : null;
    if (!item) return '';

    const isCursor = itemIdx === selectedItemIdx;
    const prefix = '   ';
    const resetTo = isCursor ? ansi.reset + cursorBgColor : ansi.reset;

    const statusIcon = freshStatusIcon(item.status);
    const fileColor = heatmapColor(item.date, tw.days || 7);
    const fileName = truncate(item.file, Math.max(10, innerW - 25));
    const relTime = relativeDate(item.date);
    const authorPart = item.author ? truncate(item.author, 12) : (item.isPending ? 'pending' : '');

    const line = prefix + statusIcon + resetTo + ' ' + fileColor + fileName + resetTo
      + '  ' + colors.dim + padRight(relTime, 4) + resetTo
      + ' ' + colors.dim + authorPart + resetTo;

    return (isCursor ? cursorBgColor : '') + padRight(line, innerW) + ansi.reset;
  }
  for (let i = 0; i < fileListH; i++) {
    const itemIdx = state.freshScrollOffset + i;
    if (itemIdx >= state.freshItems.length) { lines.push(''); lineToFileIdx.push(-1); continue; }
    lines.push(renderFreshRow(itemIdx));
    lineToFileIdx.push(itemIdx);
  }

  if (hostScroll.isActive() && fileListH > 0) {
    const off = state.freshScrollOffset;
    ui.hostScrollRegions.push({
      id: 'freshList', panel: 'right', relRow: 1, width: innerW, height: fileListH,
      contentRows: state.freshItems.length, off,
      bank: hostScroll.buildBank('freshList', renderFreshRow, off, fileListH),
    });
  }

  // Apply hover highlight to fresh file list (skip header at row 0)
  const hoverRow = ui.hoveredFreshRow;
  if (hoverRow > 0 && hoverRow < lines.length) {
    const itemIdx = hoverRow > 0 && hoverRow - 1 < visibleItems.length ? state.freshScrollOffset + (hoverRow - 1) : -1;
    const isCursor = itemIdx === selectedItemIdx;
    if (!isCursor) {
      const orig = lines[hoverRow];
      const deBg = orig.replace(/\x1b\[48;2;[\d;]+m/g, '').replace(/\x1b\[10[0-9]m/g, '').replace(/\x1b\[44m/g, '');
      lines[hoverRow] = colors.hoverBg + padRight(deBg.replace(/\x1b\[0m/g, ansi.reset + colors.hoverBg), innerW) + ansi.reset;
    }
  }

  // Scroll pct
  if (fileListH > 0 && state.freshItems.length > fileListH) {
    const maxScroll = Math.max(1, state.freshItems.length - fileListH);
    ui.freshListMaxScroll = maxScroll;
    ui.scrollPct.history = Math.round((state.freshScrollOffset / maxScroll) * 100);
  } else {
    ui.freshListMaxScroll = 0;
    ui.scrollPct.history = -1;
  }

  // Pre-calculate detail scroll pct. Display only — the authoritative clamp
  // lives in the detail section below (its cH also subtracts the h-scrollbar
  // row); clamping state here would fight the host's scroll limit.
  if (detailH > 1 && state.freshDetailLines.length > 0) {
    const cH = detailH - 1;
    const maxDetailScroll = Math.max(0, state.freshDetailLines.length - cH);
    if (state.freshDetailLines.length > cH) {
      const pctOff = Math.min(state.diffScrollOffset, maxDetailScroll);
      ui.scrollPct.detail = Math.round((pctOff / Math.max(1, maxDetailScroll)) * 100);
    }
  } else {
    ui.freshDetailMaxScroll = 0;
  }

  // -- Separator --
  if (separatorH > 0) {
    const hDivColor = ui.hoveredDivider === 'horizontal' ? colors.value : colors.border;
    lines.push(hDivColor + '\u2500'.repeat(w) + ansi.reset);
  }

  // -- Detail (diff) --
  if (detailH > 0) {
    const selItem = state.freshItems[state.freshCursor];
    if (state.freshDetailLines.length === 0) {
      const spin = panelLoadingLabel('freshDetail', 'Loading diff...');
      if (spin) lines.push(colors.dim + ' ' + spin + ansi.reset);
      else if (state.freshDetailLoading) lines.push('');
      else lines.push(colors.dim + ' Select a file to view diff' + ansi.reset);
      for (let i = 1; i < detailH; i++) lines.push('');
      ui.freshDetailMaxScrollX = 0;
    } else {
      // Header: file info
      if (selItem) {
        const info = selItem.isPending
          ? colors.cyan + ' \u25c6 ' + truncate(selItem.file, innerW - 4) + ' (pending)' + ansi.reset
          : colors.cyan + ' \u25c6 ' + truncate(selItem.file, innerW - 20) + ' ' + colors.dim + selItem.commitHash + ansi.reset;
        lines.push(truncate(info, innerW));
      } else {
        lines.push('');
      }
      let cH = detailH - 1;

      // Compute horizontal scroll for fresh detail
      let freshDetailMaxLineW = 0;
      for (const line of state.freshDetailLines) {
        const plain = line.replace(/[\r\n]/g, '');
        if (isDiffMetaLine(plain)) continue;
        const lw = stripAnsi(expandDiffTabs(plain)).length;
        if (lw > freshDetailMaxLineW) freshDetailMaxLineW = lw;
      }
      const freshDetailMaxScrollX = Math.max(0, freshDetailMaxLineW - (innerW - 1));
      ui.freshDetailMaxScrollX = freshDetailMaxScrollX;
      if (state.diffScrollX > freshDetailMaxScrollX) state.diffScrollX = freshDetailMaxScrollX;
      if (freshDetailMaxScrollX > 0 && cH > 1) cH--;

      const maxDetailScroll = Math.max(0, state.freshDetailLines.length - cH);
      ui.freshDetailMaxScroll = maxDetailScroll;
      if (state.diffScrollOffset > maxDetailScroll) state.diffScrollOffset = maxDetailScroll;
      const renderFreshDetailRow = (rawLine) =>
        ' ' + colorizeDiffLine(rawLine, innerW - 1, selItem ? selItem.file : null, state.diffScrollX);
      const detailRegionRelRow = lines.length;
      const visible = state.freshDetailLines.slice(state.diffScrollOffset, state.diffScrollOffset + cH);
      for (const rawLine of visible) {
        lines.push(renderFreshDetailRow(rawLine));
      }
      if (hostScroll.isActive() && cH > 0) {
        const off = state.diffScrollOffset;
        const pick = (i) => (i >= 0 && i < state.freshDetailLines.length)
          ? renderFreshDetailRow(state.freshDetailLines[i]) : '';
        ui.hostScrollRegions.push({
          id: 'freshDetail', panel: 'right', relRow: detailRegionRelRow, width: innerW, height: cH,
          contentRows: state.freshDetailLines.length, off,
          bank: hostScroll.buildBank('freshDetail', pick, off, cH),
        });
      }
      // Reserve row for horizontal scrollbar
      if (freshDetailMaxScrollX > 0) lines.push('');
    }
  }

  ui.freshFileLineMap = lineToFileIdx.slice(0, listH);
  return lines;
}

// ── Helpers ──

// 리모트 추적 브랜치 접미 표기. "main, origin/main" → "main@origin"
const REMOTE_MARK = '@';

// ref가 리모트 추적 브랜치면 { remote, branch }를, 아니면 null을 돌려준다.
// state.remotes를 기준으로 판정하므로 "feature/foo" 같은 슬래시 포함 로컬 브랜치를
// 리모트로 오인하지 않는다.
function splitRemoteRef(ref) {
  const remotes = state.remotes || [];
  let best = null;
  for (const r of remotes) {
    if (ref.length > r.length + 1 && ref.startsWith(r + '/')) {
      // 리모트명이 겹칠 때(origin, origin/sub)는 더 긴 쪽이 맞다
      if (!best || r.length > best.remote.length) {
        best = { remote: r, branch: ref.substring(r.length + 1) };
      }
    }
  }
  if (best) return best;
  // remotes가 아직 로드되지 않은 동안만 첫 '/' 기준으로 추정한다.
  if (remotes.length === 0 && ref.includes('/') && !state.branches.some(b => b.name === ref)) {
    const slash = ref.indexOf('/');
    return { remote: ref.substring(0, slash), branch: ref.substring(slash + 1) };
  }
  return null;
}

// 리모트 추적 브랜치가 핀 고정된 로컬 브랜치의 짝인지 — "origin/develop"은 로컬 "develop"의 핀을 따른다.
function isPinnedRemoteRef(ref) {
  const split = splitRemoteRef(ref);
  return !!split && isPinnedBranch(split.branch);
}

// decoration 문자열을 토큰으로 쪼개고, 같은 커밋에 있는 동명의 리모트 추적 브랜치를
// 로컬 브랜치의 접미로 흡수한다. 로컬에 짝이 없는 리모트 ref는 원래대로 "origin/foo"를
// 유지해 로컬 브랜치와 헷갈리지 않게 둔다.
function buildDecoTokens(plainDeco, currentBranch) {
  const refs = plainDeco.split(', ').map(r => r.trim()).filter(r => r && !r.endsWith('/HEAD'));
  const tokens = [];
  const localAt = new Map();
  for (const ref of refs) {
    if (ref === 'HEAD') {
      tokens.push({ kind: 'head', name: ref, remotes: [] });
    } else if (ref === 'recovery') {
      tokens.push({ kind: 'recovery', name: ref, remotes: [] });
    } else if (ref === 'refs/stash' || ref.startsWith('stash@{')) {
      tokens.push({ kind: 'stash', name: ref, remotes: [] });
    } else if (ref.startsWith('tag:')) {
      tokens.push({ kind: 'tag', name: ref, remotes: [] });
    } else {
      const split = splitRemoteRef(ref);
      if (split) {
        tokens.push({ kind: 'remote', name: ref, branch: split.branch, remote: split.remote, remotes: [] });
      } else {
        localAt.set(ref, tokens.length);
        tokens.push({ kind: 'local', name: ref, remotes: [] });
      }
    }
  }
  const merged = [];
  for (const token of tokens) {
    if (token.kind === 'remote' && localAt.has(token.branch)) {
      tokens[localAt.get(token.branch)].remotes.push(token.remote);
      continue;
    }
    merged.push(token);
  }

  // Git의 %D 출력 순서에 기대지 않고 브랜치 ref끼리의 표시 순서를 고정한다.
  // 태그/stash/recovery 같은 비브랜치 토큰은 원래 자리를 유지하고, 그 사이의 브랜치
  // 슬롯만 현재 브랜치 -> 핀 지정 순서 -> 나머지 이름 오름차순으로 채운다.
  const checkedOut = currentBranch
    || (state.branches.find(b => b.isCurrent) || {}).name
    || state.branch;
  const branchTokens = merged
    .filter(token => token.kind === 'local' || token.kind === 'remote')
    .map((token, index) => ({ token, index }));
  branchTokens.sort((a, b) => {
    const aBranch = a.token.kind === 'remote' ? a.token.branch : a.token.name;
    const bBranch = b.token.kind === 'remote' ? b.token.branch : b.token.name;
    const aPin = ui.pinnedBranches.indexOf(aBranch);
    const bPin = ui.pinnedBranches.indexOf(bBranch);
    const aRank = aBranch === checkedOut ? 0 : aPin >= 0 ? 1 : 2;
    const bRank = bBranch === checkedOut ? 0 : bPin >= 0 ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    if (aRank === 1 && aPin !== bPin) return aPin - bPin;
    return a.token.name.localeCompare(b.token.name) || a.index - b.index;
  });

  let branchIndex = 0;
  return merged.map(token => {
    if (token.kind !== 'local' && token.kind !== 'remote') return token;
    return branchTokens[branchIndex++].token;
  });
}

function decoPlainText(tokens) {
  return tokens
    .map(t => t.name + (t.remotes.length ? REMOTE_MARK + t.remotes.join(',') : ''))
    .join(', ');
}

function colorizeDecoTokens(tokens, currentBranch, isHead) {
  const parts = [];
  const PINNED_STYLE = colors.pinned + ansi.bold;
  for (const token of tokens) {
    // 핀 고정 브랜치는 history에서도 같은 색으로 눈에 띄게 한다. 리모트 추적 브랜치는
    // 동명 로컬 브랜치의 핀을 따라가고(origin/develop ← develop), 현재 브랜치는
    // HEAD 표시가 더 중요하므로 green을 유지한다.
    const pinned = token.kind === 'remote'
      ? isPinnedBranch(token.branch)
      : token.kind === 'local' && token.name !== currentBranch && isPinnedBranch(token.name);
    let part;
    if (token.kind === 'head') {
      part = colors.green + ansi.bold + token.name + ansi.reset;
    } else if (token.kind === 'recovery') {
      part = RECOVERY_TEXT + token.name + ansi.reset;
    } else if (token.kind === 'stash') {
      part = STASH_TEXT + token.name + ansi.reset;
    } else if (token.kind === 'tag') {
      part = colors.yellow + token.name + ansi.reset;
    } else if (token.kind === 'remote') {
      part = (pinned ? PINNED_STYLE : colors.red) + token.name + ansi.reset;
    } else if (token.name === currentBranch) {
      part = colors.green + (isHead ? ansi.bold : '') + token.name + ansi.reset;
    } else if (pinned) {
      part = PINNED_STYLE + token.name + ansi.reset;
    } else {
      part = colors.cyan + token.name + ansi.reset;
    }
    if (token.remotes.length) {
      // "develop@origin"의 접미도 흡수된 리모트 짝이므로 로컬 이름과 같은 색으로 묶는다.
      part += (pinned ? PINNED_STYLE : colors.red) + REMOTE_MARK + token.remotes.join(',') + ansi.reset;
    }
    parts.push(part);
  }
  return parts.join(colors.dim + ', ' + ansi.reset);
}

function colorizeDecoration(plainDeco, currentBranch, isHead) {
  if (!plainDeco) return '';
  return colorizeDecoTokens(buildDecoTokens(plainDeco, currentBranch), currentBranch, isHead);
}

// ── 충돌 해결 뷰 ──
//
// 상단 Diff 토글(side/unified)을 충돌 파일에도 그대로 적용한다. side 는 파일 전체를
// 좌우로 나란히 놓아 두 갈래가 어디서 갈라졌는지 보이게 하고, unified 는 git 이 파일에
// 써 둔 충돌 마커 모양 그대로 위아래로 쌓는다. 어느 모드든 충돌 블록 머리에 선택
// 버튼을 붙인다 — 고를 수 있다는 사실이 화면에 없으면 기능이 없는 것과 같다.
const CONFLICT_SIDE_MIN_WIDTH = 64;   // 이보다 좁으면 토글과 무관하게 unified 로 떨어뜨린다
const CONFLICT_COMPACT_WIDTH = 88;    // 버튼 라벨을 줄이는 기준

function conflictUsesSideBySide(innerW) {
  return state.diffView === 'side' && innerW >= CONFLICT_SIDE_MIN_WIDTH;
}

// ours/theirs 각각의 파일 라인 번호. context 는 양쪽에 함께 있으니 둘 다 증가하고
// 충돌 구간은 각자만 증가한다 — 그래서 좌우 번호가 어긋나는 게 정상이다.
function annotateConflictLineNumbers(chunks) {
  let ourLine = 1;
  let theirLine = 1;
  const meta = [];
  for (const chunk of chunks) {
    if (chunk.type === 'context') {
      meta.push({ nums: chunk.lines.map(() => ({ our: ourLine++, their: theirLine++ })) });
      continue;
    }
    meta.push({
      ourNums: chunk.ours.map(() => ourLine++),
      theirNums: chunk.theirs.map(() => theirLine++),
    });
  }
  return { meta, maxLine: Math.max(1, ourLine - 1, theirLine - 1) };
}

// 코드 셀 하나 = 라인 번호 gutter + 코드. 배경을 깔 때는 하이라이터가 넣은 reset 이
// 배경까지 지우므로 매번 배경을 다시 이어 붙인다.
function conflictCodeCell(code, lineNum, numW, contentW, totalW, file, bg, faded) {
  const num = lineNum != null ? String(lineNum).padStart(numW) : ' '.repeat(numW);
  let body = '';
  if (code != null) {
    // 표시 전용 탭 확장 — chunk 원본은 해결 결과를 파일에 쓸 때 그대로 쓴다.
    const expanded = expandTabs(code);
    body = truncate(faded ? colors.dim + expanded : highlightCode(expanded, file), Math.max(0, contentW));
  }
  const text = colors.dim + num + ansi.reset + ' ' + body;
  if (!bg) return padRight(text, totalW) + ansi.reset;
  return bg + padRight(text.replace(/\x1b\[0m/g, ansi.reset + bg), totalW) + ansi.reset;
}

function buildConflictDiffLines(innerW) {
  const lines = [];
  const zones = [];
  const chunkLineMap = {};
  const conflictView = state.conflictView;
  if (!conflictView) return { lines, zones, chunkLineMap };

  const op = state.operationState || {};
  const isRebase = op.type === 'rebase-merge' || op.type === 'rebase-apply';
  const oursLabel = isRebase ? 'HEAD' : 'Ours';
  const theirsLabel = isRebase ? 'Incoming' : 'Theirs';
  // 어느 쪽이 어느 브랜치인지는 고정 머리말에만 적는다 — 버튼 라벨에 브랜치명을 넣으면
  // 이름이 긴 브랜치에서 버튼이 화면을 넘긴다. rebase 는 onto 위에 얹는 중이라
  // 왼쪽이 리베이스 대상, 오른쪽이 얹히는 브랜치다.
  const oursName = isRebase ? (op.ontoHash ? 'onto ' + op.ontoHash : '') : (state.branch || '');
  const theirsName = isRebase ? (op.headName || '') : (op.incomingName || '');
  const file = conflictView.file;
  const chunks = conflictView.chunks;

  const conflictIndices = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].type === 'conflict') conflictIndices.push(i);
  }
  const total = conflictIndices.length;
  const selectedCount = conflictIndices.filter(idx => ui.mergeChunkSelections[idx]).length;

  const { meta, maxLine } = annotateConflictLineNumbers(chunks);
  const numW = String(maxLine).length;
  const sideBySide = conflictUsesSideBySide(innerW);
  const compact = innerW < CONFLICT_COMPACT_WIDTH;
  // hover 는 직전 프레임의 zone 목록을 가리키므로 인덱스가 아니라 내용으로 맞춘다.
  const hoveredZone = (ui.hoveredMergeZoneIndex >= 0 && ui.mergeClickZones)
    ? ui.mergeClickZones[ui.hoveredMergeZoneIndex]
    : null;
  // hover 는 (동작, 청크)로만 맞춘다 — zone 의 줄 번호는 화면 기준이라 스크롤하면
  // 여기서 만드는 절대 줄 번호와 어긋난다. 청크 단위로 강조해도 클릭 결과와 같으니
  // 오히려 "이 줄들이 선택된다"가 그대로 보인다.
  const isHovered = (action, chunkIndex) => !!hoveredZone
    && hoveredZone.action === action
    && hoveredZone.chunkIndex === chunkIndex;

  const gap = ' ' + colors.border + '│' + ansi.reset + ' ';
  const availW = innerW - 3;
  const leftW = sideBySide ? Math.floor(availW / 2) : innerW;
  const rightW = sideBySide ? availW - leftW : 0;
  const leftCodeW = Math.max(1, leftW - numW - 1);
  const rightCodeW = Math.max(1, rightW - numW - 1);
  const unifiedCodeW = Math.max(1, innerW - numW - 1);

  const white = ansi.fg(255, 255, 255);
  const brightBlue = ansi.fg(120, 180, 255);
  const pickedBg = colors.diffAddBg;   // 남기기로 한 쪽
  const openBg = colors.hoverBg;       // 아직 고르지 않은 충돌

  const hline = (w) => colors.border + '─'.repeat(Math.max(0, w)) + ansi.reset;

  // ── 머리말: 진행 상황과 충돌 사이 이동 ──
  //
  // 본문과 나눠서 돌려준다 — 함께 스크롤되면 파일을 조금만 내려도 "몇 개가 남았는지"와
  // 이동 버튼, 어느 쪽이 Ours 인지가 화면 밖으로 밀려난다. 렌더 쪽이 고정으로 그린다.
  const headerLines = [];
  const headerZones = [];
  {
    const nav = [
      { action: 'prev-conflict', text: '[‹]' },
      { action: 'next-conflict', text: '[›]' },
    ];
    const progress = `${selectedCount}/${total} resolved `;
    const navW = nav.reduce((sum, b) => sum + visLen(b.text) + 1, 0);
    const headW = Math.max(1, innerW - visLen(progress) - navW);
    const head = ' ' + colors.yellow + ansi.bold + 'Merge conflict' + ansi.reset
      + '  ' + colors.cyan + truncate(file, Math.max(4, headW - 18)) + ansi.reset;
    let line = padRight(head, headW)
      + (total > 0 && selectedCount === total ? colors.green : colors.dim) + progress + ansi.reset;
    for (const b of nav) {
      const start = visLen(line);
      const style = isHovered(b.action, -1)
        ? colors.value + ansi.bold + CSI + '4m'
        : colors.value;
      line += style + b.text + ansi.reset + ' ';
      headerZones.push({ lineIdx: headerLines.length, colStart: start, colEnd: start + visLen(b.text) - 1, action: b.action, chunkIndex: -1 });
    }
    headerLines.push(line);
  }

  // "Ours / Theirs" 만으로는 어느 브랜치인지 알 수 없다 — 이름을 함께 붙인다.
  const titleCell = (label, name, maxW) => {
    const text = brightBlue + ansi.bold + ' ' + label + ansi.reset
      + (name ? colors.dim + ' · ' + ansi.reset + colors.cyan + name + ansi.reset : '');
    return maxW > 0 ? truncate(text, maxW) : text;
  };

  if (sideBySide) {
    headerLines.push(padRight(titleCell(oursLabel, oursName, leftW), leftW) + gap
      + padRight(titleCell(theirsLabel, theirsName, rightW), rightW));
    headerLines.push(hline(leftW) + gap + hline(rightW));
  } else {
    // unified 는 좌우 컬럼이 없으니 한 줄에 나란히 적어 둔다.
    const half = Math.max(1, Math.floor(innerW / 2) - 1);
    headerLines.push(padRight(titleCell(oursLabel, oursName, half), half + 2)
      + titleCell(theirsLabel, theirsName, innerW - half - 2));
    headerLines.push(hline(innerW));
  }

  let ordinal = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const nums = meta[chunkIndex];

    if (chunk.type === 'context') {
      for (let i = 0; i < chunk.lines.length; i++) {
        const n = nums.nums[i];
        lines.push(sideBySide
          ? conflictCodeCell(chunk.lines[i], n.our, numW, leftCodeW, leftW, file, '', false)
            + gap
            + conflictCodeCell(chunk.lines[i], n.their, numW, rightCodeW, rightW, file, '', false)
          : conflictCodeCell(chunk.lines[i], n.our, numW, unifiedCodeW, innerW, file, '', false));
      }
      continue;
    }

    ordinal++;
    const selection = ui.mergeChunkSelections[chunkIndex] || null;
    const chunkStart = lines.length;

    // ── 선택 버튼 머리 ──
    {
      const isCursor = ui.mergeChunkCursor === chunkIndex;
      const head = ` ${isCursor ? '▸' : ' '} Conflict ${ordinal}/${total}  `;
      const buttons = [
        // 숫자를 라벨에 박아 둔다 — 마우스로 눌러 본 사람이 다음엔 키로 누를 수 있게.
        // 코드 영역 클릭과 동작은 같지만 action 은 따로 둔다(hover 강조 대상이 다르다).
        { sel: 'ours', action: 'btn-ours', text: compact ? '[1 ' + oursLabel + ']' : '[ 1 Use ' + oursLabel + ' ]' },
        { sel: 'theirs', action: 'btn-theirs', text: compact ? '[2 ' + theirsLabel + ']' : '[ 2 Use ' + theirsLabel + ' ]' },
        { sel: 'both', action: 'btn-both', text: compact ? '[3 Both]' : '[ 3 Keep both ]' },
      ];
      const lineIdx = lines.length;
      let line = (isCursor ? white + ansi.bold : colors.dim) + head + ansi.reset;
      for (const b of buttons) {
        const start = visLen(line);
        const style = selection === b.sel
          ? pickedBg + white + ansi.bold
          : isHovered(b.action, chunkIndex) ? colors.value + ansi.bold + CSI + '4m' : colors.dim;
        line += style + b.text + ansi.reset + ' ';
        zones.push({ lineIdx, colStart: start, colEnd: start + visLen(b.text) - 1, action: b.action, chunkIndex });
      }
      const status = selection === 'ours' ? oursLabel + ' kept'
        : selection === 'theirs' ? theirsLabel + ' kept'
        : selection === 'both' ? 'both kept'
        : 'unresolved';
      const pad = innerW - visLen(line) - visLen(status) - 1;
      if (pad > 0) {
        line += ' '.repeat(pad) + (selection ? colors.green : colors.yellow) + status + ansi.reset + ' ';
      }
      // 머리는 청크 포커스용 클릭 영역이기도 하다 — 버튼 zone 을 먼저 넣었으니 겹치지 않게 라벨 폭만.
      zones.push({ lineIdx, colStart: 0, colEnd: Math.max(0, visLen(head) - 1), action: 'focus-chunk', chunkIndex });
      lines.push(line);
    }

    const keepOurs = selection === 'ours' || selection === 'both';
    const keepTheirs = selection === 'theirs' || selection === 'both';
    // 고른 쪽은 살아남는 코드라 강조하고, 버린 쪽은 흐리게 둔다 — 결과가 눈에 그려져야 한다.
    const oursBg = keepOurs ? pickedBg : selection ? '' : openBg;
    const theirsBg = keepTheirs ? pickedBg : selection ? '' : openBg;
    const oursFaded = !!selection && !keepOurs;
    const theirsFaded = !!selection && !keepTheirs;

    if (sideBySide) {
      const rowCount = Math.max(chunk.ours.length, chunk.theirs.length, 1);
      for (let row = 0; row < rowCount; row++) {
        const lineIdx = lines.length;
        const hasOur = row < chunk.ours.length;
        const hasTheir = row < chunk.theirs.length;
        const lBg = !keepOurs && isHovered('select-ours', chunkIndex) ? colors.hoverBg : oursBg;
        const rBg = !keepTheirs && isHovered('select-theirs', chunkIndex) ? colors.hoverBg : theirsBg;
        lines.push(
          conflictCodeCell(hasOur ? chunk.ours[row] : null, hasOur ? nums.ourNums[row] : null, numW, leftCodeW, leftW, file, lBg, oursFaded)
          + gap
          + conflictCodeCell(hasTheir ? chunk.theirs[row] : null, hasTheir ? nums.theirNums[row] : null, numW, rightCodeW, rightW, file, rBg, theirsFaded)
        );
        zones.push({ lineIdx, colStart: 0, colEnd: leftW - 1, action: 'select-ours', chunkIndex });
        zones.push({ lineIdx, colStart: leftW + 3, colEnd: innerW, action: 'select-theirs', chunkIndex });
      }
    } else {
      const marker = (text) => lines.push(colors.dim + truncate(text, innerW) + ansi.reset);
      marker(' <<<<<<< ' + oursLabel);
      for (let row = 0; row < chunk.ours.length; row++) {
        const lineIdx = lines.length;
        const bg = !keepOurs && isHovered('select-ours', chunkIndex) ? colors.hoverBg : oursBg;
        lines.push(conflictCodeCell(chunk.ours[row], nums.ourNums[row], numW, unifiedCodeW, innerW, file, bg, oursFaded));
        zones.push({ lineIdx, colStart: 0, colEnd: innerW, action: 'select-ours', chunkIndex });
      }
      marker(' =======');
      for (let row = 0; row < chunk.theirs.length; row++) {
        const lineIdx = lines.length;
        const bg = !keepTheirs && isHovered('select-theirs', chunkIndex) ? colors.hoverBg : theirsBg;
        lines.push(conflictCodeCell(chunk.theirs[row], nums.theirNums[row], numW, unifiedCodeW, innerW, file, bg, theirsFaded));
        zones.push({ lineIdx, colStart: 0, colEnd: innerW, action: 'select-theirs', chunkIndex });
      }
      marker(' >>>>>>> ' + theirsLabel);
    }

    lines.push(sideBySide ? hline(leftW) + gap + hline(rightW) : hline(innerW));
    chunkLineMap[chunkIndex] = { start: chunkStart, end: lines.length - 1 };
  }

  return { headerLines, headerZones, lines, zones, chunkLineMap };
}

const SIDE_BY_SIDE_MIN_WIDTH = 56;

function isDeletionDiffLine(line) {
  return line.startsWith('-') && !line.startsWith('---');
}

function isAdditionDiffLine(line) {
  return line.startsWith('+') && !line.startsWith('+++');
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldLine: parseInt(match[1], 10), newLine: parseInt(match[2], 10) };
}

function buildSideBySideDiffRows(rawLines) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let maxLine = 0;
  let inHunk = false;

  function pushMeta(text) {
    if (text === '' && rows.length === 0) return;
    rows.push({ type: 'meta', text });
  }

  function pushPair(leftText, rightText, oldNum, newNum) {
    if (oldNum != null) maxLine = Math.max(maxLine, oldNum);
    if (newNum != null) maxLine = Math.max(maxLine, newNum);
    rows.push({ type: 'pair', leftText, rightText, oldNum, newNum });
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].replace(/[\r\n]/g, '');
    if (i === rawLines.length - 1 && line === '') continue;

    // 새 파일 헤더가 시작되면 hunk 밖으로 되돌린다 — 뒤따르는 index/---/+++ 를
    // 본문이 아니라 헤더로 판정해야 한다(멀티 파일 diff).
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }

    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      inHunk = true;
      rows.push({ type: 'hunk', text: line });
      continue;
    }

    if (!inHunk) {
      if (isDiffFileHeaderLine(line)) continue;
      pushMeta(line);
      continue;
    }

    if (line.startsWith('diff --git ') || line.startsWith('index ') ||
        line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity') || line.startsWith('rename') ||
        line.startsWith('Binary') || line.startsWith('\\')) {
      pushMeta(line);
      continue;
    }

    if (line.startsWith(' ')) {
      pushPair(line, line, oldLine, newLine);
      oldLine++;
      newLine++;
      continue;
    }

    if (isDeletionDiffLine(line)) {
      const deletions = [];
      let j = i;
      while (j < rawLines.length) {
        const candidate = rawLines[j].replace(/[\r\n]/g, '');
        if (!isDeletionDiffLine(candidate)) break;
        deletions.push(candidate);
        j++;
      }
      const additions = [];
      while (j < rawLines.length) {
        const candidate = rawLines[j].replace(/[\r\n]/g, '');
        if (!isAdditionDiffLine(candidate)) break;
        additions.push(candidate);
        j++;
      }

      const rowCount = Math.max(deletions.length, additions.length);
      for (let row = 0; row < rowCount; row++) {
        const leftText = deletions[row] || '';
        const rightText = additions[row] || '';
        const oldNum = leftText ? oldLine++ : null;
        const newNum = rightText ? newLine++ : null;
        pushPair(leftText, rightText, oldNum, newNum);
      }
      i = j - 1;
      continue;
    }

    if (isAdditionDiffLine(line)) {
      pushPair('', line, null, newLine);
      newLine++;
      continue;
    }

    pushMeta(line);
  }

  rows.maxLine = maxLine;
  return rows;
}

function buildSideBySideDiffLayout(rawLines, innerW) {
  if (innerW < SIDE_BY_SIDE_MIN_WIDTH) return null;

  const gapW = 3;
  const availableW = innerW - gapW;
  const leftW = Math.floor(availableW / 2);
  const rightW = availableW - leftW;
  if (leftW < 24 || rightW < 24) return null;

  const rows = buildSideBySideDiffRows(rawLines);
  const numW = rows.maxLine > 0 ? String(rows.maxLine).length : 1;
  const gutterW = numW + 1;
  const leftContentW = Math.max(1, leftW - gutterW);
  const rightContentW = Math.max(1, rightW - gutterW);
  let maxLeftW = 0;
  let maxRightW = 0;

  for (const row of rows) {
    if (row.type !== 'pair') continue;
    if (row.leftText) maxLeftW = Math.max(maxLeftW, visLen(expandDiffTabs(row.leftText)));
    if (row.rightText) maxRightW = Math.max(maxRightW, visLen(expandDiffTabs(row.rightText)));
  }

  rows.unshift({ type: 'side-header' });
  rows.unshift({ type: 'side-title' });

  return {
    rows,
    innerW,
    leftW,
    rightW,
    numW,
    leftContentW,
    rightContentW,
    maxScrollX: Math.max(0, maxLeftW - leftContentW, maxRightW - rightContentW),
  };
}

function renderSideBySideCell(rawText, lineNum, numW, contentW, totalW, filePath, scrollX) {
  const num = lineNum != null ? String(lineNum).padStart(numW) : ' '.repeat(numW);
  const gutter = colors.dim + num + ansi.reset + ' ';
  const content = rawText
    ? colorizeDiffLine(rawText, contentW, filePath, scrollX)
    : ' '.repeat(contentW);
  return padRight(gutter + content, totalW);
}

function renderSideBySideDiffLines(layout, filePath, scrollX, hunkOpts) {
  const lines = [];
  const gap = colors.border + ' \u2502 ' + ansi.reset;
  const headerGap = colors.border + ' \u2502 ' + ansi.reset;
  for (let rowIdx = 0; rowIdx < layout.rows.length; rowIdx++) {
    const row = layout.rows[rowIdx];
    if (hunkOpts && row.type === 'hunk') {
      const base = ' ' + colorizeDiffLine(row.text, hunkOpts.avail - 1, filePath, 0);
      lines.push(padRight(base, hunkOpts.avail + 1) + hunkOpts.renderButton(hunkOpts.idxByRow.get(rowIdx)));
      continue;
    }
    if (row.type === 'side-title') {
      lines.push(
        colors.dim + padRight(' HEAD', layout.leftW) + ansi.reset +
        headerGap +
        colors.dim + padRight(' STAGED', layout.rightW) + ansi.reset
      );
      continue;
    }
    if (row.type === 'side-header') {
      lines.push(
        colors.border + '\u2500'.repeat(layout.leftW) + ansi.reset +
        headerGap +
        colors.border + '\u2500'.repeat(layout.rightW) + ansi.reset
      );
      continue;
    }
    if (row.type === 'pair') {
      const left = renderSideBySideCell(row.leftText, row.oldNum, layout.numW, layout.leftContentW, layout.leftW, filePath, scrollX);
      const right = renderSideBySideCell(row.rightText, row.newNum, layout.numW, layout.rightContentW, layout.rightW, filePath, scrollX);
      lines.push(left + gap + right);
      continue;
    }
    lines.push(' ' + colorizeDiffLine(row.text, layout.innerW - 1, filePath, 0));
  }
  return lines;
}

function annotateDiffLineNumbers(lines) {
  const result = [];
  let oldLine = 0, newLine = 0, maxLine = 0, inDiff = false, inHunk = false;
  for (const line of lines) {
    if (line.match(/^diff --git /)) { inDiff = true; inHunk = false; continue; }
    if (!inDiff) { result.push({ text: line, inDiff: false }); continue; }
    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hm) { oldLine = parseInt(hm[1]); newLine = parseInt(hm[2]); inHunk = true; result.push({ text: line, inDiff: true, oldNum: null, newNum: null }); continue; }
    // hunk 밖의 index/---/+++ 만 헤더로 보고 걷어낸다 (본문의 '--- ' 삭제줄 보호).
    if (!inHunk && isDiffFileHeaderLine(line)) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename') ||
        line.startsWith('Binary')) { result.push({ text: line, inDiff: true, oldNum: null, newNum: null }); continue; }
    if (line.startsWith('+')) { maxLine = Math.max(maxLine, newLine); result.push({ text: line, inDiff: true, oldNum: null, newNum: newLine }); newLine++; }
    else if (line.startsWith('-')) { maxLine = Math.max(maxLine, oldLine); result.push({ text: line, inDiff: true, oldNum: oldLine, newNum: null }); oldLine++; }
    else { maxLine = Math.max(maxLine, oldLine, newLine); result.push({ text: line, inDiff: true, oldNum: oldLine, newNum: newLine }); oldLine++; newLine++; }
  }
  result.maxLine = maxLine;
  return result;
}

function filterLogDetailLines(lines, collapsedFiles) {
  const result = [];
  let currentFile = null;
  let isCollapsed = false;
  let inDiff = false;
  let inHunk = false;
  let oldLine = 0, newLine = 0;
  let maxLine = 0;
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/.+ b\/(.+)/);
    if (diffMatch) {
      // 이 줄은 접을 수 있는 파일 헤더 UI로 대신 그린다(파일명만 보여 준다).
      currentFile = diffMatch[1];
      isCollapsed = collapsedFiles.has(currentFile);
      inDiff = true;
      inHunk = false;
      result.push({ isFileHeader: true, file: currentFile, text: line });
      continue;
    }
    if (isCollapsed) continue;
    if (!inDiff) {
      result.push({ isFileHeader: false, text: line, inDiff: false });
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]);
      newLine = parseInt(hunkMatch[2]);
      inHunk = true;
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: null, file: currentFile });
      continue;
    }
    // 파일명은 위 헤더가 맡았으니 남은 index/---/+++ 는 군더더기다.
    if (!inHunk && isDiffFileHeaderLine(line)) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity') || line.startsWith('rename') ||
        line.startsWith('Binary')) {
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: null, file: currentFile });
      continue;
    }
    if (line.startsWith('+')) {
      maxLine = Math.max(maxLine, newLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: null, newNum: newLine, file: currentFile });
      newLine++;
    } else if (line.startsWith('-')) {
      maxLine = Math.max(maxLine, oldLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: oldLine, newNum: null, file: currentFile });
      oldLine++;
    } else {
      maxLine = Math.max(maxLine, oldLine, newLine);
      result.push({ isFileHeader: false, text: line, inDiff: true, oldNum: oldLine, newNum: newLine, file: currentFile });
      oldLine++;
      newLine++;
    }
  }
  result.maxLine = maxLine;
  return result;
}

// diff 한 줄의 탭을 화면 폭에 맞춰 공백으로 편다 (표시 전용 — state.diffLines 원본은
// hunk 패치 생성에 그대로 쓰이므로 절대 바꾸지 않는다).
// 첫 칸은 +/-/space 마커라 마커를 컬럼 0으로 세면 들여쓰기가 한 칸씩 밀린다. 마커를
// 떼고 편 뒤 다시 붙여 원본 파일과 같은 tab stop에 맞춘다.
function expandDiffTabs(rawLine) {
  if (typeof rawLine !== 'string' || rawLine.indexOf('\t') === -1) return rawLine;
  const marker = rawLine[0];
  if ((marker === '+' || marker === '-' || marker === ' ') &&
      !rawLine.startsWith('+++') && !rawLine.startsWith('---')) {
    return marker + expandTabs(rawLine.slice(1));
  }
  return expandTabs(rawLine);
}

/**
 * Colorize a diff line with syntax highlighting for code content
 * Adds background color for additions (green) and deletions (red)
 * @param {string} rawLine - The raw diff line
 * @param {number} w - Maximum width
 * @param {string} filePath - File path for language detection
 * @returns {string} Colorized line with background
 */
function isDiffMetaLine(rawLine) {
  return rawLine.startsWith('+++') || rawLine.startsWith('---') ||
    rawLine.startsWith('@@') ||
    rawLine.startsWith('diff ') || rawLine.startsWith('index ') || rawLine.startsWith('commit ') ||
    rawLine.startsWith('Author: ') || rawLine.startsWith('Commit: ') ||
    /^\u2500{3,}$/.test(rawLine);
}

function colorizeDiffLineWithUnderline(rawLine, w, ulStart, ulEnd) {
  // Render a metadata line with underline on [ulStart, ulEnd] range (0-based within rawLine)
  const fgColor = rawLine.startsWith('commit ') ? colors.dim : colors.cyan;
  let result = '';
  for (let i = 0; i < Math.min(rawLine.length, w); i++) {
    if (i === ulStart) result += CSI + '4m';
    result += rawLine[i];
    if (i === ulEnd) result += CSI + '24m';
  }
  return fgColor + result + ansi.reset;
}

function colorizeDiffLine(rawLine, w, filePath, scrollX) {
  rawLine = expandDiffTabs(rawLine.replace(/[\r\n]/g, ''));
  // Don't apply horizontal scroll to metadata/header lines
  const sx = isDiffMetaLine(rawLine) ? 0 : (scrollX || 0);

  // Diff metadata lines (no background, just foreground color)
  if (rawLine.startsWith('+++') || rawLine.startsWith('---')) {
    return colors.diffHeader + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (rawLine.startsWith('@@')) {
    return colors.diffHunk + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (rawLine.startsWith('diff ') || rawLine.startsWith('index ') || rawLine.startsWith('commit ')) {
    return colors.dim + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (rawLine.startsWith('Author: ') || rawLine.startsWith('Commit: ')) {
    return colors.cyan + sliceByWidth(rawLine, sx, w) + ansi.reset;
  } else if (/^\u2500{3,}$/.test(rawLine)) {
    return colors.border + '\u2500'.repeat(w) + ansi.reset;
  }

  // Code lines with diff markers
  const isAdd = rawLine.startsWith('+');
  const isDel = rawLine.startsWith('-');

  // Determine background and foreground colors
  const bgColor = isAdd ? colors.diffAddBg : isDel ? colors.diffDelBg : '';
  const fgColor = isAdd ? colors.diffAdd : isDel ? colors.diffDel : colors.label;

  // Get visible portion with horizontal scroll
  const visibleText = sliceByWidth(rawLine, sx, w);

  // Try to apply syntax highlighting on visible portion
  if (filePath && visibleText.trim()) {
    const lang = getLanguage(filePath);
    if (lang) {
      try {
        const highlighted = highlightCode(visibleText, filePath);
        return bgColor + fgColor + highlighted + ansi.reset;
      } catch (e) {
        // Fall back to basic coloring
      }
    }
  }

  // Fallback: basic diff coloring with background (no syntax highlighting)
  return bgColor + fgColor + visibleText + ansi.reset;
}

const hintButtons = [];

function buildHintText() {
  let result = '';
  if (state.selectedFiles.size > 0) {
    result += colors.cyan + state.selectedFiles.size + ' selected' + ansi.reset + '  ';
    result += colors.dim + '[s]tage  [u]nstage' + ansi.reset + '  ';
  }
  for (let i = 0; i < hintButtons.length; i++) {
    if (i > 0) result += '  ';
    const color = (i === ui.hoveredAreaIndex) ? colors.value + ansi.bold : colors.dim;
    result += color + hintButtons[i].label + ansi.reset;
  }
  return result;
}

function renderMinimized() {
  const cols = ui.termCols;
  let line = '';
  if (state.branch) {
    line += colors.cyan + state.branch + ansi.reset;
  }
  const fileCount = state.staged.length + state.unstaged.length + state.untracked.length;
  if (fileCount > 0) {
    line += colors.dim + ' | ' + ansi.reset;
    if (state.staged.length > 0) line += colors.green + '+' + state.staged.length + ansi.reset + ' ';
    if (state.unstaged.length > 0) line += colors.red + '~' + state.unstaged.length + ansi.reset + ' ';
    if (state.untracked.length > 0) line += colors.dim + '?' + state.untracked.length + ansi.reset;
  }
  line += ' '.repeat(Math.max(0, cols - visLen(line)));
  process.stdout.write(ansi.hideCursor + ansi.moveTo(1, 1) + line + ansi.reset);
}

module.exports = { render, hintButtons, buildLeftPanel, buildFileListPanel, revealBranch, buildDecoTokens, decoPlainText, colorizeDecoration };
