/* ── HeatSync shared UI ── loaded by both browser (script tag) and Electron ── */
/* Browser: <script src="/shared.js"> before client.js                          */
/* Electron: <script src="../public/shared.js"> before client-p2p.js           */

/* ── Constants ───────────────────────────────────────────────────────────── */
// Single dictionary: icon → colour. PLAYER_ICONS is derived so both stay in sync.
const ICON_META = {
  '☯': '#9ca3af', '★': '#facc15', '♠': '#a855f7', '♣': '#15803d',
  '♥': '#ec4899', '♦': '#ef4444', '⛬': '#0891b2', '▲': '#fb923c',
};
const PLAYER_ICONS = Object.keys(ICON_META);
const ZONES        = ['docks', 'strip', 'slums'];
const ZONE_LABELS  = { docks: 'The Docks', strip: 'The Strip', slums: 'The Slums' };
const ZONE_SHORT   = { docks: 'Docks',     strip: 'Strip',     slums: 'Slums'     };
const TURF_CLASS   = { docks: 'turf--docks', strip: 'turf--strip', slums: 'turf--slums' };
const ROUND_COUNT  = 4;
const MAX_LOBBY_SLOTS    = 6;
const MIN_PLAYERS_TO_START = 3;
// Keep in sync with lib/gameLogic.js CHARS (browser can't require() Node modules)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HTP_SLIDE_COUNT = 7;
const OUTCOME_LABELS = {
  all_different:   'One zone took all the heat — the others walked clean',
  two_tied_lowest: 'Two crews stayed off the radar — payouts are split',
  two_tied_highest:'Two zones got burned — the heat is shared',
  all_tied:        'Citywide crackdown — nobody wins big',
};

/* ── Shared state (var = window global; platform files may override fields) ── */
// eslint-disable-next-line no-var
var state = {
  socket: null,
  roomCode: null,
  myName: null,
  gameState: null,
  hasSubmitted: false,
  voluntaryLeaveInProgress: false,
  lastResolveData: null,
  lastWinners: null,
  reconnectBannerPending: false, // browser-only field; harmless in Electron
  playerIcon: localStorage.getItem('heatsync_icon') || '♠',
  playerTurf: localStorage.getItem('heatsync_turf') || 'docks',
};

// Mutable module-level vars accessed by shared functions
// eslint-disable-next-line no-var
var leaveRoomFallbackTimer = null;
// eslint-disable-next-line no-var
var allocTimerInterval = null;
// eslint-disable-next-line no-var
var _iconDebounce = null;
// eslint-disable-next-line no-var
var htpCurrent = 0;

const allocState = {
  selectedZones: new Set(),
  resources: { docks: 0, strip: 0, slums: 0 },
  myResources: 0,
};

/* ── Utilities ───────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
function hideError(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.add('hidden');
}
function deltaClass(n) {
  return n > 0 ? 'delta-pos' : n < 0 ? 'delta-neg' : 'delta-zero';
}
function isHost() {
  return !!(state.gameState && state.gameState.hostName === state.myName);
}
function myPlayer() {
  if (!state.gameState) return null;
  return state.gameState.players.find(p => p.name === state.myName) || null;
}

/* ── Round track ─────────────────────────────────────────────────────────── */
function buildRoundTrackMarkup() {
  return Array.from({ length: ROUND_COUNT },
    (_, i) => `<span class="round-pip" data-i="${i + 1}" aria-hidden="true"></span>`
  ).join('');
}
function mountRoundTracks() {
  ['alloc-round-track', 'reveal-round-track'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.querySelector('.round-pip')) el.innerHTML = buildRoundTrackMarkup();
  });
}
function updateRoundTrack(trackId, round) {
  const track = document.getElementById(trackId);
  if (!track) return;
  const r = Math.max(0, Math.min(ROUND_COUNT, round));
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', `Round ${r} of ${ROUND_COUNT}`);
  track.querySelectorAll('.round-pip').forEach((pip, idx) => {
    pip.classList.toggle('round-pip--on', idx < r);
  });
}

/* ── Logo ────────────────────────────────────────────────────────────────── */
function initHeatsyncLogos() {
  const tpl = document.getElementById('tpl-heatsync-logo');
  if (!tpl) return;
  document.querySelectorAll('[data-heatsync-logo]').forEach(host => {
    if (host.querySelector('.logo-slice-glow')) return;
    host.appendChild(tpl.content.cloneNode(true));
  });
}

/* ── Leave-confirm modal ─────────────────────────────────────────────────── */
function openLeaveConfirmModal() {
  document.getElementById('leave-confirm-modal').classList.remove('hidden');
  document.getElementById('leave-modal-cancel').focus();
}
function closeLeaveConfirmModal() {
  document.getElementById('leave-confirm-modal').classList.add('hidden');
}
function initLeaveConfirmModal() {
  if (initLeaveConfirmModal._done) return;
  initLeaveConfirmModal._done = true;
  document.getElementById('leave-modal-cancel').addEventListener('click', closeLeaveConfirmModal);
  document.getElementById('leave-modal-backdrop').addEventListener('click', closeLeaveConfirmModal);
  document.getElementById('leave-modal-confirm').addEventListener('click', () => {
    closeLeaveConfirmModal();
    emitLeaveRoom();
  });
  document.getElementById('leave-confirm-modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLeaveConfirmModal();
  });
}

/* ── End-game modal ──────────────────────────────────────────────────────── */
function openEndGameModal() {
  document.getElementById('end-game-modal').classList.remove('hidden');
  document.getElementById('end-game-modal-cancel').focus();
}
function closeEndGameModal() {
  document.getElementById('end-game-modal').classList.add('hidden');
}
function initEndGameModal() {
  if (initEndGameModal._done) return;
  initEndGameModal._done = true;
  document.getElementById('end-game-modal-cancel').addEventListener('click', closeEndGameModal);
  document.getElementById('end-game-modal-backdrop').addEventListener('click', closeEndGameModal);
  document.getElementById('end-game-modal-confirm').addEventListener('click', () => {
    closeEndGameModal();
    state.socket.emit('end_game_to_lobby', { roomCode: state.roomCode });
  });
  document.getElementById('end-game-modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeEndGameModal();
  });
}

/* ── How To Play modal ───────────────────────────────────────────────────── */
function openHtp(startSlide = 0) {
  htpCurrent = startSlide;
  document.getElementById('htp-modal').classList.remove('hidden');
  htpBuildDots();
  htpShowSlide(htpCurrent, 'none');
  document.getElementById('htp-close').focus();
}
function closeHtp() {
  document.getElementById('htp-modal').classList.add('hidden');
}
function htpBuildDots() {
  const container = document.getElementById('htp-dots');
  if (!container || container.children.length === HTP_SLIDE_COUNT) return;
  container.innerHTML = '';
  for (let i = 0; i < HTP_SLIDE_COUNT; i++) {
    const dot = document.createElement('button');
    dot.type = 'button'; dot.className = 'htp-dot';
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.dataset.i = i;
    dot.addEventListener('click', () => htpGoTo(i));
    container.appendChild(dot);
  }
}
function htpShowSlide(index, direction = 'next') {
  document.querySelectorAll('.htp-slide').forEach((s, i) => {
    s.classList.remove('htp-slide--active', 'htp-slide--exit-left');
    if (i === index) {
      s.style.transform = direction === 'prev' ? 'translateX(-32px)' : 'translateX(32px)';
      s.style.opacity = '0';
      s.offsetHeight; // force reflow
      s.style.transform = '';
      s.style.opacity = '';
      s.classList.add('htp-slide--active');
    }
  });
  document.querySelectorAll('.htp-dot').forEach((dot, i) => {
    dot.classList.toggle('htp-dot--active', i === index);
  });
  const prevBtn = document.getElementById('htp-prev');
  const nextBtn = document.getElementById('htp-next');
  if (prevBtn) prevBtn.disabled = index === 0;
  if (nextBtn) nextBtn.disabled = index === HTP_SLIDE_COUNT - 1;
}
function htpGoTo(index) {
  if (index < 0 || index >= HTP_SLIDE_COUNT) return;
  const dir = index > htpCurrent ? 'next' : 'prev';
  htpCurrent = index;
  htpShowSlide(htpCurrent, dir);
}
function setupHtp() {
  if (setupHtp._done) return;
  setupHtp._done = true;
  document.getElementById('btn-htp-landing')?.addEventListener('click', () => openHtp(0));
  document.addEventListener('click', e => { if (e.target.closest('.btn-htp')) openHtp(0); });
  document.getElementById('htp-close').addEventListener('click', closeHtp);
  document.getElementById('htp-backdrop').addEventListener('click', closeHtp);
  document.getElementById('htp-prev').addEventListener('click', () => htpGoTo(htpCurrent - 1));
  document.getElementById('htp-next').addEventListener('click', () => htpGoTo(htpCurrent + 1));
  document.getElementById('htp-modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeHtp(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') htpGoTo(htpCurrent + 1);
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   htpGoTo(htpCurrent - 1);
  });
}

/* ── Voluntary leave helpers ─────────────────────────────────────────────── */
function clearVoluntaryLeave() {
  state.voluntaryLeaveInProgress = false;
  if (leaveRoomFallbackTimer) { clearTimeout(leaveRoomFallbackTimer); leaveRoomFallbackTimer = null; }
}
function beginVoluntaryLeave() {
  state.voluntaryLeaveInProgress = true;
  if (leaveRoomFallbackTimer) clearTimeout(leaveRoomFallbackTimer);
  leaveRoomFallbackTimer = setTimeout(() => {
    leaveRoomFallbackTimer = null;
    if (state.voluntaryLeaveInProgress) { state.voluntaryLeaveInProgress = false; returnToMainMenu(null); }
  }, 200);
}
function emitLeaveRoom() {
  if (state.socket && state.roomCode) {
    beginVoluntaryLeave();
    state.socket.emit('leave_room', { roomCode: state.roomCode });
  }
}

/* ── Allocation zone helpers ─────────────────────────────────────────────── */
function allocResourceDisplay(n) { return n === 0 ? '×' : String(n); }
function setZoneResVal(zone, n) {
  const el = document.getElementById(`res-${zone}`);
  if (!el) return;
  el.textContent = allocResourceDisplay(n);
  el.classList.toggle('res-val--empty', n === 0);
}
function setZoneResRowActive(zone, active) {
  const card = document.querySelector(`.zone-card[data-zone="${zone}"]`);
  if (!card) return;
  card.querySelector('.zone-res-row').classList.toggle('zone-res-row--inactive', !active);
}
function renderZonePips(zone) {
  const el = document.getElementById(`pips-${zone}`);
  if (!el) return;
  const parts = [];
  if (allocState.selectedZones.has(zone)) {
    parts.push('<span class="zone-pip zone-pip--crew"></span>');
    for (let i = 0; i < allocState.resources[zone]; i++)
      parts.push('<span class="zone-pip zone-pip--res"></span>');
  }
  el.innerHTML = parts.join('');
}
function refreshAllZonePips() { ZONES.forEach(renderZonePips); }

/* ── Standings & result rows ─────────────────────────────────────────────── */
function heatPipsHtml(heat) {
  if (heat === 0) return '<span style="color:var(--text-dim)">—</span>';
  return Array.from({ length: heat }, () => '<span class="heat-pip heat-pip--sm"></span>').join('');
}
function renderStandings(tableId, players) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.innerHTML = `
    <thead><tr><th>#</th><th>Player</th><th>Resources</th><th>Heat</th></tr></thead>
    <tbody>${players.map((p, i) => `
      <tr class="${p.name === state.myName ? 'me' : ''} ${p.connected === false ? 'offline-row' : ''}">
        <td>${i + 1}</td>
        <td>${escHtml(p.name)}${p.name === state.myName ? ' (you)' : ''}</td>
        <td>${p.resources}</td>
        <td><span class="heat-pips heat-pips--inline">${heatPipsHtml(p.heat)}</span></td>
      </tr>`).join('')}
    </tbody>`;
}
function roleShortLabel(role) {
  const map = {
    highest: 'HOT ZONE · LOSE ALL', lone_highest: 'HOT ZONE · LOSE ALL',
    middle: 'EVEN · KEEP +1',
    lowest: 'CLEAN · TRIPLE', lone_lowest: 'CLEAN · TRIPLE',
    tied_lowest: 'SHARED LOW · DOUBLE', tied_highest: 'SHARED HOT · HALVE',
    tied: 'LOCKDOWN',
  };
  return map[role] || role.toUpperCase();
}
function renderResultRows(el, resolveData) {
  const standingsOrder = resolveData.standings.map(p => p.name);
  const heatByName = Object.fromEntries(resolveData.standings.map(p => [p.name, p.heat ?? 0]));
  const sortedResults = [...resolveData.playerResults].sort(
    (a, b) => standingsOrder.indexOf(a.name) - standingsOrder.indexOf(b.name),
  );
  const header = `<div class="rr-header">
    <span></span><span>Player</span>
    <span class="rr-hdr-docks">${ZONE_SHORT.docks}</span>
    <span class="rr-hdr-strip">${ZONE_SHORT.strip}</span>
    <span class="rr-hdr-slums">${ZONE_SHORT.slums}</span>
    <span>±</span><span>Res</span><span class="rr-hdr-heat">Heat</span>
  </div>`;
  const rows = sortedResults.map((pr, idx) => {
    const rank = standingsOrder.indexOf(pr.name) + 1 || idx + 1;
    const isMe = pr.name === state.myName;
    const heat = heatByName[pr.name];
    const sign = pr.totalDelta > 0 ? `+${pr.totalDelta}` : `−${Math.abs(pr.totalDelta)}`;
    const cls = deltaClass(pr.totalDelta);
    const zoneMap = Object.fromEntries(pr.zoneResults.map(zr => [zr.zone, zr]));
    const zoneCells = ZONES.map(zone => {
      const zr = zoneMap[zone];
      if (!zr) return `<span class="rr-zone-cell rr-zone-cell--empty">—</span>`;
      const sent = zr.sent.crew + zr.sent.resources;
      const op = zr.delta <= 0 ? '−' : '+';
      const opCls = deltaClass(zr.delta);
      return `<span class="rr-zone-cell"><span class="rr-zc-sent">${sent}</span><span class="rr-zc-op ${opCls}">${op}</span><span class="${opCls}">${Math.abs(zr.delta)}</span></span>`;
    }).join('');
    const heatHtml = heat > 0
      ? `<span class="heat-pips heat-pips--inline">${heatPipsHtml(heat)}</span>`
      : `<span class="rr-no-heat">—</span>`;
    return `<div class="rr-row${isMe ? ' rr-row--me' : ''}">
      <span class="rr-rank">${rank}</span>
      <span class="rr-name">${escHtml(pr.name)}</span>
      ${zoneCells}
      <span class="rr-delta ${cls}">${sign}</span>
      <span class="rr-total">${pr.newResources}</span>
      <span class="rr-heat">${heatHtml}</span>
    </div>`;
  }).join('');
  el.innerHTML = header + rows;
}

/* ── Lobby slots ─────────────────────────────────────────────────────────── */
function renderLobbySlots(players, hostName) {
  const container = document.getElementById('lobby-slots');
  if (!container) return;
  const amHost = state.myName === hostName;
  const slotsHtml = [];
  for (let i = 0; i < MAX_LOBBY_SLOTS; i++) {
    const p = players[i];
    if (p) {
      const icon  = p.icon || '☯';
      const tc    = TURF_CLASS[p.homeTurf] || '';
      const isMe  = p.name === state.myName;
      const turfOn = !!(state.gameState?.homeTurfEnabled);
      const turfSpan = (turfOn && p.homeTurf)
        ? `<span class="lobby-slot-turf ${tc}${isMe ? ' picker-tap' : ''}"${isMe ? ' id="my-turf-display"' : ''}>${escHtml(ZONE_LABELS[p.homeTurf] || p.homeTurf)}</span>`
        : `<span class="lobby-slot-turf"${isMe ? ' id="my-turf-display"' : ''} style="visibility:hidden">&nbsp;</span>`;
      const shadowColor = ICON_META[icon] || '#ffffff';
      const shadow = `text-shadow:-0.5px 1px 1.25px ${shadowColor}cc,0.5px 1px 1.25px ${shadowColor}cc`;
      slotsHtml.push(`
        <div class="lobby-slot lobby-slot--filled${isMe ? ' lobby-slot--me' : ''}">
          <span class="lobby-slot-main">
            <span class="dot ${p.connected === false ? 'offline' : ''}"></span>
            <span class="lobby-slot-icon${isMe ? ' picker-tap' : ''}"${isMe ? ' id="my-icon-display"' : ''} style="${shadow}">${escHtml(icon)}</span>
            <span class="lobby-slot-name"><span style="${shadow}">${escHtml(p.name)}</span>${isMe ? ' <span class="lobby-you">(you)</span>' : ''}</span>
          </span>
          <span class="lobby-slot-meta">
            ${p.name === hostName ? '<span class="host-tag">HOST</span>' : ''}
            ${amHost && !isMe ? `<button type="button" class="btn btn-kick" data-name="${escAttr(p.name)}" title="Remove this player from the lobby" aria-label="Kick ${escAttr(p.name)}">Kick</button>` : ''}
            ${turfSpan}
          </span>
        </div>`);
    } else {
      const needClass = i < MIN_PLAYERS_TO_START ? ' lobby-slot--required' : '';
      slotsHtml.push(`<div class="lobby-slot lobby-slot--empty${needClass}"><span class="lobby-slot-hint">Open seat</span></div>`);
    }
  }
  container.innerHTML = slotsHtml.join('');
  container.querySelectorAll('.btn-kick').forEach(btn => {
    btn.addEventListener('click', () => {
      state.socket.emit('kick_player', { roomCode: state.roomCode, playerName: btn.dataset.name });
    });
  });
  attachPickerListeners();
}

/* ── Icon / turf picker ──────────────────────────────────────────────────── */
function updateLobbyPickerDisplay() {
  const iconEl = document.getElementById('my-icon-display');
  const turfEl = document.getElementById('my-turf-display');
  if (iconEl) iconEl.textContent = state.playerIcon;
  if (turfEl) {
    const turfOn = !!(state.gameState?.homeTurfEnabled);
    if (turfOn) {
      turfEl.textContent = ZONE_LABELS[state.playerTurf] || state.playerTurf;
      turfEl.className = 'lobby-slot-turf picker-tap ' + (TURF_CLASS[state.playerTurf] || '');
      turfEl.style.visibility = '';
    } else {
      turfEl.textContent = '\u00a0';
      turfEl.className = 'lobby-slot-turf';
      turfEl.style.visibility = 'hidden';
    }
  }
  const color  = ICON_META[state.playerIcon] || '#ffffff';
  const shadow = `-0.5px 1px 1.25px ${color}cc,0.5px 1px 1.25px ${color}cc`;
  if (iconEl) iconEl.style.textShadow = shadow;
  const nameTextEl = document.querySelector('.lobby-slot--me .lobby-slot-name > span:first-child');
  if (nameTextEl) nameTextEl.style.textShadow = shadow;
}
function attachPickerListeners() {
  const iconEl = document.getElementById('my-icon-display');
  const turfEl = document.getElementById('my-turf-display');
  if (iconEl) iconEl.addEventListener('click', () => cycleIcon(+1));
  if (turfEl && state.gameState?.homeTurfEnabled) turfEl.addEventListener('click', () => cycleTurf(+1));
}
function cycleIcon(dir) {
  const gs = state.gameState;
  const takenIcons = gs ? gs.players.filter(p => p.name !== state.myName).map(p => p.icon) : [];
  const available = PLAYER_ICONS.filter(i => !takenIcons.includes(i));
  if (available.length === 0) return;
  const cur = available.indexOf(state.playerIcon);
  const next = available[(cur + dir + available.length) % available.length];
  state.playerIcon = next;
  localStorage.setItem('heatsync_icon', next);
  updateLobbyPickerDisplay();
  clearTimeout(_iconDebounce);
  _iconDebounce = setTimeout(() => {
    if (state.socket && state.roomCode) state.socket.emit('set_icon', { roomCode: state.roomCode, icon: state.playerIcon });
  }, 180);
}
function cycleTurf(dir) {
  const cur = ZONES.indexOf(state.playerTurf);
  const next = ZONES[(cur + dir + ZONES.length) % ZONES.length];
  state.playerTurf = next;
  localStorage.setItem('heatsync_turf', next);
  updateLobbyPickerDisplay();
  if (state.socket && state.roomCode) state.socket.emit('set_turf', { roomCode: state.roomCode, homeTurf: next });
}

/* ── Timer ───────────────────────────────────────────────────────────────── */
function fmtTimerSeconds(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function stopAllocTimer() {
  if (allocTimerInterval) { clearInterval(allocTimerInterval); allocTimerInterval = null; }
  const el = document.getElementById('alloc-timer');
  if (el) el.classList.add('hidden');
}
function startAllocTimer(endsAt) {
  stopAllocTimer();
  const el = document.getElementById('alloc-timer');
  const display = document.getElementById('alloc-timer-display');
  if (!el || !display) return;
  el.classList.remove('hidden', 'alloc-timer--urgent');
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    display.textContent = fmtTimerSeconds(remaining);
    el.classList.toggle('alloc-timer--urgent', remaining <= 30);
    if (remaining === 0) stopAllocTimer();
  };
  tick();
  allocTimerInterval = setInterval(tick, 500);
}
function updateLobbyTimerUI(gs) { updateSettingsModal(gs); }

/* ── Settings modal ──────────────────────────────────────────────────────── */
function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  updateSettingsModal(state.gameState);
}
function closeSettingsModal() {
  document.getElementById('settings-modal')?.classList.add('hidden');
}
function updateSettingsModal(gs) {
  if (!gs) return;
  const modal = document.getElementById('settings-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  const amHost = gs.hostName === state.myName;
  const panel = modal.querySelector('.settings-panel');
  panel.classList.toggle('settings-readonly', !amHost);
  panel.querySelector('.settings-readonly-notice')?.remove();
  if (!amHost) {
    const notice = document.createElement('p');
    notice.className = 'settings-readonly-notice';
    notice.textContent = 'Only the host can change settings';
    panel.appendChild(notice);
  }
  const timerEnabled  = gs.timerEnabled  || false;
  const timerDuration = gs.timerDuration || 180;
  const timerToggle = document.getElementById('settings-timer-toggle');
  const timerDurRow = document.getElementById('settings-timer-duration');
  const timerDisplay = document.getElementById('settings-timer-display');
  const decBtn = document.getElementById('settings-timer-dec');
  const incBtn = document.getElementById('settings-timer-inc');
  if (timerToggle) { timerToggle.setAttribute('aria-checked', String(timerEnabled)); timerToggle.classList.toggle('active', timerEnabled); }
  if (timerDurRow) { timerDurRow.classList.toggle('hidden', !timerEnabled); timerDurRow.dataset.duration = timerDuration; }
  if (timerDisplay) timerDisplay.textContent = fmtTimerSeconds(timerDuration);
  if (decBtn) decBtn.disabled = timerDuration <= 60;
  if (incBtn) incBtn.disabled = timerDuration >= 300;
  const turfEnabled = gs.homeTurfEnabled || false;
  const turfToggle = document.getElementById('settings-turf-toggle');
  if (turfToggle) { turfToggle.setAttribute('aria-checked', String(turfEnabled)); turfToggle.classList.toggle('active', turfEnabled); }
  const crewEnabled = gs.crewRecoveryCostEnabled !== false;
  const crewToggle = document.getElementById('settings-crew-toggle');
  if (crewToggle) { crewToggle.setAttribute('aria-checked', String(crewEnabled)); crewToggle.classList.toggle('active', crewEnabled); }
}
function setupSettingsModal() {
  document.getElementById('btn-lobby-settings')?.addEventListener('click', openSettingsModal);
  document.getElementById('settings-close')?.addEventListener('click', closeSettingsModal);
  document.getElementById('settings-backdrop')?.addEventListener('click', closeSettingsModal);
  document.getElementById('settings-timer-toggle')?.addEventListener('click', () => {
    const gs = state.gameState;
    if (!gs || gs.hostName !== state.myName) return;
    state.socket.emit('set_timer', { roomCode: state.roomCode, enabled: !(gs.timerEnabled || false) });
  });
  document.getElementById('settings-timer-dec')?.addEventListener('click', () => {
    const cur = Number(document.getElementById('settings-timer-duration')?.dataset.duration) || 180;
    state.socket.emit('set_timer', { roomCode: state.roomCode, duration: Math.max(60, cur - 30) });
  });
  document.getElementById('settings-timer-inc')?.addEventListener('click', () => {
    const cur = Number(document.getElementById('settings-timer-duration')?.dataset.duration) || 180;
    state.socket.emit('set_timer', { roomCode: state.roomCode, duration: Math.min(300, cur + 30) });
  });
  document.getElementById('settings-turf-toggle')?.addEventListener('click', () => {
    const gs = state.gameState;
    if (!gs || gs.hostName !== state.myName) return;
    state.socket.emit('set_home_turf_enabled', { roomCode: state.roomCode, enabled: !(gs.homeTurfEnabled || false) });
  });
  document.getElementById('settings-crew-toggle')?.addEventListener('click', () => {
    const gs = state.gameState;
    if (!gs || gs.hostName !== state.myName) return;
    state.socket.emit('set_crew_recovery_cost', { roomCode: state.roomCode, enabled: gs.crewRecoveryCostEnabled === false });
  });
}

/* ── Landing helpers (shared) ────────────────────────────────────────────── */
function genCode() {
  return Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
}
function showLandingView(view) {
  document.getElementById('landing-home').classList.toggle('hidden', view !== 'home');
  document.getElementById('landing-create').classList.toggle('hidden', view !== 'create');
  document.getElementById('landing-join').classList.toggle('hidden', view !== 'join');
}
function resetJoinPasswordStep() {
  document.getElementById('join-password-step')?.classList.add('hidden');
  const pw = document.getElementById('join-password');
  if (pw) pw.value = '';
}

/* ── Lobby screen ────────────────────────────────────────────────────────── */
// updateLobbyChrome: browser default; Electron overrides in client-p2p.js
function updateLobbyChrome(gs) {
  const startBtn = document.getElementById('btn-start');
  const canStart = gs.players.length >= MIN_PLAYERS_TO_START;
  if (isHost()) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = !canStart;
  } else {
    startBtn.classList.add('hidden');
  }
}
function goToLobby(gs) {
  state.gameState = gs;
  state.lastResolveData = null;
  stopAllocTimer();
  document.getElementById('lobby-code-text').textContent = gs.code;
  renderLobbySlots(gs.players, gs.hostName);
  updateLobbyPickerDisplay();
  updateLobbyChrome(gs);
  updateLobbyTimerUI(gs);
  updateHostEndGameButtons();
  showScreen('screen-lobby');
}
function updateHostEndGameButtons() {
  const show = isHost() && state.gameState && state.gameState.phase !== 'lobby';
  document.querySelectorAll('.btn-host-end-game').forEach(btn => btn.classList.toggle('hidden', !show));
}
function updateIngameCodeBadges() {
  const code = state.roomCode || '';
  document.querySelectorAll('.ingame-code-badge').forEach(btn => { btn.textContent = code; });
}

/* ── Copy helper (used by setupLobby and per-platform setupGameLeaveButtons) */
function copyWithFeedback(btn, textFn, labelDone) {
  const text = typeof textFn === 'function' ? textFn() : textFn;
  const origTitle = btn.title;
  const origLabel = btn.getAttribute('aria-label');
  const markCopied = () => {
    btn.classList.add('room-code--copied', 'btn-copy--done');
    btn.title = 'Copied!';
    btn.setAttribute('aria-label', labelDone);
    setTimeout(() => {
      btn.classList.remove('room-code--copied', 'btn-copy--done');
      btn.title = origTitle;
      btn.setAttribute('aria-label', origLabel);
    }, 2000);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta); markCopied();
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(markCopied).catch(fallback);
  else fallback();
}

function setupLobby() {
  initLeaveConfirmModal();
  const codeBtn = document.getElementById('btn-copy-code');
  const linkBtn = document.getElementById('btn-copy-link');
  codeBtn.addEventListener('click', () => copyWithFeedback(codeBtn, () => state.roomCode || '', 'Code copied'));
  linkBtn.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.search = `?room=${state.roomCode}`;
    copyWithFeedback(linkBtn, url.href, 'Link copied');
  });
  document.getElementById('btn-start').addEventListener('click', () => {
    state.socket.emit('start_game', { roomCode: state.roomCode });
  });
  document.getElementById('btn-leave-lobby').addEventListener('click', openLeaveConfirmModal);
  setupSettingsModal();
}
function setupHostEndGame() {
  initEndGameModal();
  document.querySelectorAll('.btn-host-end-game').forEach(btn => btn.addEventListener('click', openEndGameModal));
}

/* ── Allocation screen ───────────────────────────────────────────────────── */
function renderHeatPips(heat) {
  const el = document.getElementById('alloc-heat-pips');
  if (!el) return;
  el.innerHTML = heat === 0
    ? '<span class="heat-pip-none">—</span>'
    : Array.from({ length: heat }, () => '<span class="heat-pip"></span>').join('');
}
function refreshScreenAfterRosterChange(gs) {
  if (document.querySelector('.screen.active')?.id !== 'screen-allocation') return;
  const me = gs.players.find(p => p.name === state.myName);
  if (!me) return;
  renderHeatPips(me.heat);
  allocState.myResources = me.resources;
  updateRemaining();
  if (gs.allocationProgress) {
    const el = document.getElementById('submitted-count');
    if (el) el.textContent = `${gs.allocationProgress.submittedCount} of ${gs.allocationProgress.totalCount} submitted`;
  }
}
function goToAllocation(gs) {
  state.gameState = gs;
  state.hasSubmitted = false;
  const me = myPlayer();
  allocState.myResources = me ? me.resources : 0;
  allocState.selectedZones = new Set();
  allocState.resources = { docks: 0, strip: 0, slums: 0 };
  updateRoundTrack('alloc-round-track', gs.round);
  renderHeatPips(me ? me.heat : 0);
  updateIngameCodeBadges();
  document.querySelectorAll('.zone-card').forEach(card => {
    card.classList.remove('selected');
    setZoneResRowActive(card.dataset.zone, false);
  });
  ZONES.forEach(z => setZoneResVal(z, 0));
  refreshAllZonePips(); updateRemaining(); updateSubmitBtn();
  document.getElementById('alloc-submit-section').classList.remove('hidden');
  document.getElementById('alloc-waiting').classList.add('hidden');
  hideError('alloc-error');
  if (gs.allocationProgress) {
    const el = document.getElementById('submitted-count');
    if (el && state.hasSubmitted)
      el.textContent = `${gs.allocationProgress.submittedCount} of ${gs.allocationProgress.totalCount} submitted`;
  }
  if (gs.timerEndAt) startAllocTimer(gs.timerEndAt); else stopAllocTimer();
  updateHostEndGameButtons();
  const lastBtn = document.getElementById('btn-last-results');
  if (lastBtn) lastBtn.classList.toggle('hidden', !state.lastResolveData);
  showScreen('screen-allocation');
}
function getAllocRemaining() {
  return allocState.myResources - Object.values(allocState.resources).reduce((a, b) => a + b, 0);
}
function updateRemaining() {
  const rem = getAllocRemaining();
  const el = document.getElementById('remaining-count');
  if (!el) return;
  el.textContent = rem;
  el.classList.toggle('alloc-status-bar__value--zero', rem === 0);
  updateAllocResButtons();
}
function updateAllocResButtons() {
  if (state.hasSubmitted) {
    document.querySelectorAll('.res-btn').forEach(btn => btn.classList.remove('res-btn--actionable'));
    return;
  }
  document.querySelectorAll('.res-btn').forEach(btn => {
    const zone = btn.dataset.zone;
    const dir  = parseInt(btn.dataset.dir, 10);
    if (!allocState.selectedZones.has(zone)) { btn.classList.remove('res-btn--actionable'); return; }
    btn.classList.toggle('res-btn--actionable',
      dir === 1 ? getAllocRemaining() > 0 : allocState.resources[zone] > 0);
  });
}
function updateSubmitBtn() {
  document.getElementById('btn-submit').disabled =
    !(allocState.selectedZones.size === 2 && getAllocRemaining() === 0);
}
function submitAllocation() {
  if (state.hasSubmitted) return;
  const allocation = {
    docks: { crew: allocState.selectedZones.has('docks') ? 1 : 0, resources: allocState.resources.docks },
    strip: { crew: allocState.selectedZones.has('strip') ? 1 : 0, resources: allocState.resources.strip },
    slums: { crew: allocState.selectedZones.has('slums') ? 1 : 0, resources: allocState.resources.slums },
  };
  state.socket.emit('submit_allocation', { roomCode: state.roomCode, allocation });
  state.hasSubmitted = true;
  updateAllocResButtons();
  document.getElementById('alloc-submit-section').classList.add('hidden');
  document.getElementById('alloc-waiting').classList.remove('hidden');
  hideError('alloc-error');
}
function setupAllocation() {
  document.querySelectorAll('.zone-card').forEach(card => {
    card.addEventListener('click', () => {
      if (state.hasSubmitted) return;
      const zone = card.dataset.zone;
      if (allocState.selectedZones.has(zone)) {
        allocState.selectedZones.delete(zone); allocState.resources[zone] = 0;
        card.classList.remove('selected'); setZoneResRowActive(zone, false); setZoneResVal(zone, 0);
      } else {
        if (allocState.selectedZones.size >= 2) return;
        allocState.selectedZones.add(zone); card.classList.add('selected'); setZoneResRowActive(zone, true);
      }
      renderZonePips(zone); updateRemaining(); updateSubmitBtn();
    });
  });
  document.querySelectorAll('.res-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (state.hasSubmitted) return;
      const zone = btn.dataset.zone;
      const dir  = parseInt(btn.dataset.dir);
      if (dir === 1 && getAllocRemaining() <= 0) return;
      if (dir === -1 && allocState.resources[zone] <= 0) return;
      allocState.resources[zone] += dir;
      setZoneResVal(zone, allocState.resources[zone]);
      renderZonePips(zone); updateRemaining(); updateSubmitBtn();
    });
  });
  document.getElementById('btn-submit').addEventListener('click', submitAllocation);
}

/* ── Reveal screen ───────────────────────────────────────────────────────── */
function updateRevealReadyUI(gs) {
  const el   = document.getElementById('reveal-ready-count');
  const cont = document.getElementById('btn-continue');
  if (!el || !cont) return;
  const rp = gs.readyProgress;
  if (!rp) { el.textContent = ''; cont.disabled = false; return; }
  el.textContent = `${rp.readyCount} / ${rp.totalCount} ready`;
  cont.disabled = !!(rp.readyNames && rp.readyNames.includes(state.myName));
}
function goToReveal(resolveData, gs, isGameOver) {
  state.gameState = gs;
  state.lastResolveData = resolveData;
  updateRoundTrack('reveal-round-track', resolveData.round);
  const totalsEl = document.getElementById('reveal-zone-totals');
  totalsEl.innerHTML = ZONES.map(zone => {
    const total = resolveData.zoneTotals[zone];
    const role  = resolveData.classification.outcome === 'all_tied'
      ? 'tied' : resolveData.classification.roles[zone];
    return `<div class="zone-total-card zt-zone--${zone}">
      <div class="zt-name zt-name--${zone}">${ZONE_LABELS[zone]}</div>
      <div class="zt-number">${total}</div>
      <div class="zt-role role-${role}">${roleShortLabel(role)}</div>
    </div>`;
  }).join('');
  document.getElementById('reveal-outcome-banner').textContent =
    OUTCOME_LABELS[resolveData.classification.outcome] || '';
  renderResultRows(document.getElementById('reveal-player-results'), resolveData);
  const continueBtn   = document.getElementById('btn-continue');
  const seeResultsBtn = document.getElementById('btn-see-results');
  if (isGameOver) {
    continueBtn.classList.add('hidden');
    seeResultsBtn.classList.remove('hidden');
    document.getElementById('reveal-ready-count').textContent = '';
  } else {
    continueBtn.classList.remove('hidden');
    const nextRoundEl = document.getElementById('next-round-num');
    if (nextRoundEl) nextRoundEl.textContent = String(gs.round);
    continueBtn.title = 'Ready for the next allocation round';
    continueBtn.setAttribute('aria-label', `Ready for round ${gs.round}`);
    seeResultsBtn.classList.add('hidden');
    updateRevealReadyUI(gs);
  }
  updateIngameCodeBadges();
  updateHostEndGameButtons();
  showScreen('screen-reveal');
}
function setupLastResultsModal() {
  function open() {
    const rd = state.lastResolveData;
    if (!rd) return;
    document.getElementById('last-results-round-num').textContent = rd.round;
    renderResultRows(document.getElementById('last-results-content'), rd);
    document.getElementById('last-results-modal').classList.remove('hidden');
  }
  function close() { document.getElementById('last-results-modal').classList.add('hidden'); }
  document.getElementById('btn-last-results').addEventListener('click', open);
  document.getElementById('last-results-close').addEventListener('click', close);
  document.getElementById('last-results-backdrop').addEventListener('click', close);
}
/* ── Shared socket event handlers ────────────────────────────────────────── */
/**
 * Attach all shared socket event handlers to a socket (socket.io or P2P shim).
 * opts.onPlayerLeftSelf(socket): called when the server marks *us* as disconnected.
 *   Browser: emit join_room to attempt reconnect. P2P: no-op (peer-client retries).
 */
function setupSocketHandlers(socket, opts = {}) {
  const { onPlayerLeftSelf = () => {} } = opts;

  socket.on('password_required', () => {
    document.getElementById('join-password-step').classList.remove('hidden');
    hideError('join-error');
    document.getElementById('join-password').focus();
  });

  socket.on('room_joined', ({ roomCode, myName, state: gs }) => {
    clearVoluntaryLeave();
    resetJoinPasswordStep();
    state.roomCode = roomCode;
    state.myName = myName;
    localStorage.setItem('heatsync_name', myName);
    sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode, playerName: myName }));
    goToLobby(gs);
  });

  socket.on('reconnected', ({ myName, state: gs, hasSubmitted, lastResolveData, lastWinners }) => {
    clearVoluntaryLeave();
    state.myName = myName;
    state.hasSubmitted = hasSubmitted;
    state.gameState = gs;
    state.lastResolveData = lastResolveData || null;
    state.lastWinners = lastWinners || null;
    sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode: gs.code, playerName: myName }));

    switch (gs.phase) {
      case 'lobby': goToLobby(gs); break;
      case 'discussion':
        if (lastResolveData) goToReveal(lastResolveData, gs, false);
        else goToAllocation(gs);
        break;
      case 'allocation':
        goToAllocation(gs);
        if (hasSubmitted) {
          state.hasSubmitted = true;
          document.getElementById('alloc-submit-section').classList.add('hidden');
          document.getElementById('alloc-waiting').classList.remove('hidden');
        }
        updateAllocResButtons();
        break;
      case 'reveal':
        if (lastResolveData) goToReveal(lastResolveData, gs, false);
        else goToAllocation(gs);
        break;
      case 'end':
        if (lastResolveData) goToGameOver(lastWinners ?? [], gs);
        else showScreen('screen-gameover');
        break;
    }
  });

  socket.on('player_joined', ({ name, state: gs }) => {
    state.gameState = gs;
    const currentScreen = document.querySelector('.screen.active')?.id;
    if (currentScreen === 'screen-lobby') {
      renderLobbySlots(gs.players, gs.hostName);
      updateLobbyChrome(gs);
      updateLobbyTimerUI(gs);
    } else {
      refreshScreenAfterRosterChange(gs);
    }
  });

  socket.on('player_left', ({ name, state: gs }) => {
    if (name === state.myName && state.roomCode && !state.voluntaryLeaveInProgress) {
      const me = gs.players && gs.players.find(p => p.name === state.myName);
      if (me && me.connected === false) {
        onPlayerLeftSelf(socket);
        return;
      }
    }
    state.gameState = gs;
    const currentScreen = document.querySelector('.screen.active')?.id;
    if (currentScreen === 'screen-lobby') {
      renderLobbySlots(gs.players, gs.hostName);
      updateLobbyChrome(gs);
      updateLobbyTimerUI(gs);
    } else {
      refreshScreenAfterRosterChange(gs);
    }
  });

  socket.on('left_room', () => { returnToMainMenu(null); });

  socket.on('phase_changed', ({ phase, state: gs }) => {
    state.gameState = gs;
    if (phase === 'allocation') {
      document.getElementById('btn-continue').disabled = false;
      goToAllocation(gs);
    }
  });

  socket.on('player_ready', ({ name, readyCount, totalCount }) => {
    const el = document.getElementById('reveal-ready-count');
    if (el) el.textContent = `${readyCount} / ${totalCount} ready`;
    if (name === state.myName) {
      const c = document.getElementById('btn-continue');
      if (c) c.disabled = true;
    }
  });

  socket.on('allocation_received', ({ submittedCount, totalCount }) => {
    const el = document.getElementById('submitted-count');
    if (el) el.textContent = `${submittedCount} of ${totalCount} submitted`;
  });

  socket.on('round_resolved', ({ resolveData, state: gs }) => {
    state.gameState = gs;
    goToReveal(resolveData, gs, false);
  });

  socket.on('game_over', ({ resolveData, winners, state: gs }) => {
    state.gameState = gs;
    state.lastWinners = winners;
    goToReveal(resolveData, gs, true);
    document.getElementById('btn-see-results').onclick = () => goToGameOver(state.lastWinners, state.gameState);
  });

  socket.on('timer_start', ({ endsAt }) => { startAllocTimer(endsAt); });
  socket.on('timer_expired', () => { stopAllocTimer(); });

  socket.on('timer_settings_changed', ({ timerEnabled, timerDuration }) => {
    if (state.gameState) {
      state.gameState.timerEnabled  = timerEnabled;
      state.gameState.timerDuration = timerDuration;
    }
    updateLobbyTimerUI(state.gameState);
  });

  socket.on('home_turf_setting_changed', ({ homeTurfEnabled }) => {
    if (state.gameState) state.gameState.homeTurfEnabled = homeTurfEnabled;
    updateSettingsModal(state.gameState);
    const gs = state.gameState;
    if (gs && document.querySelector('.screen.active')?.id === 'screen-lobby') {
      renderLobbySlots(gs.players, gs.hostName);
      updateLobbyPickerDisplay();
    }
  });

  socket.on('crew_recovery_cost_changed', ({ crewRecoveryCostEnabled }) => {
    if (state.gameState) state.gameState.crewRecoveryCostEnabled = crewRecoveryCostEnabled;
    updateSettingsModal(state.gameState);
  });

  socket.on('game_reset', ({ state: gs }) => {
    clearVoluntaryLeave();
    state.gameState = gs;
    state.hasSubmitted = false;
    sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode: gs.code, playerName: state.myName }));
    goToLobby(gs);
  });

  socket.on('lobby_update', ({ state: gs }) => {
    if (state.gameState) gs.homeTurfEnabled = gs.homeTurfEnabled ?? state.gameState.homeTurfEnabled;
    state.gameState = gs;
    const me = gs.players.find(p => p.name === state.myName);
    if (me) { state.playerIcon = me.icon; state.playerTurf = me.homeTurf; }
    if (document.querySelector('.screen.active')?.id === 'screen-lobby') {
      renderLobbySlots(gs.players, gs.hostName);
      updateLobbyPickerDisplay();
    }
  });

  socket.on('icon_taken', () => {
    const gs = state.gameState;
    const takenIcons = gs ? gs.players.filter(p => p.name !== state.myName).map(p => p.icon) : [];
    const available = PLAYER_ICONS.filter(i => !takenIcons.includes(i) && i !== state.playerIcon);
    if (available.length === 0) return;
    state.playerIcon = available[0];
    localStorage.setItem('heatsync_icon', state.playerIcon);
    updateLobbyPickerDisplay();
    if (state.roomCode) socket.emit('set_icon', { roomCode: state.roomCode, icon: state.playerIcon });
  });

  socket.on('kicked', ({ message }) => {
    clearVoluntaryLeave();
    returnToMainMenu(message || 'You were removed from the room');
  });

  socket.on('error', ({ message }) => {
    const screen = document.querySelector('.screen.active')?.id;
    let errId = 'landing-error';
    if (screen === 'screen-landing') {
      const joinVisible   = !document.getElementById('landing-join').classList.contains('hidden');
      const createVisible = !document.getElementById('landing-create').classList.contains('hidden');
      if (joinVisible)        errId = 'join-error';
      else if (createVisible) errId = 'create-error';
    } else if (screen === 'screen-lobby') {
      errId = 'lobby-error';
    } else if (screen === 'screen-allocation') {
      errId = 'alloc-error';
    }
    showError(errId, message);

    if (screen === 'screen-allocation' && state.hasSubmitted) {
      state.hasSubmitted = false;
      document.getElementById('alloc-submit-section').classList.remove('hidden');
      document.getElementById('alloc-waiting').classList.add('hidden');
      updateAllocResButtons();
    }
  });
}

function setupReveal() {
  document.getElementById('btn-continue').addEventListener('click', () => {
    state.socket.emit('ready_for_next', { roomCode: state.roomCode });
    document.getElementById('btn-continue').disabled = true;
  });
  // btn-see-results onclick is set dynamically in the game_over socket handler
  // (via setupSocketHandlers) so that it always captures the latest state refs.
}

/* ── Game-over screen ────────────────────────────────────────────────────── */
function goToGameOver(winners, gs) {
  state.gameState = gs;
  const winnerBanner = document.getElementById('winner-banner');
  if (winners.length === 1)      winnerBanner.textContent = `${winners[0]} wins!`;
  else if (winners.length === 0) winnerBanner.textContent = 'No winner?';
  else                           winnerBanner.textContent = `Draw: ${winners.join(' & ')}`;
  const sorted = [...gs.players].sort((a, b) => b.resources - a.resources || a.heat - b.heat);
  renderStandings('gameover-standings', sorted);
  const playAgainBtn = document.getElementById('btn-play-again');
  const waitingEl    = document.getElementById('gameover-waiting');
  if (isHost()) { playAgainBtn.classList.remove('hidden'); waitingEl.classList.add('hidden'); }
  else          { playAgainBtn.classList.add('hidden');    waitingEl.classList.remove('hidden'); }
  updateIngameCodeBadges();
  updateHostEndGameButtons();
  showScreen('screen-gameover');
}
function setupGameOver() {
  document.getElementById('btn-play-again').addEventListener('click', () => {
    state.socket.emit('play_again', { roomCode: state.roomCode });
  });
}
