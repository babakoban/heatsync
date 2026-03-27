/* ── State ─────────────────────────────────────────────────────────────── */
const state = {
  socket: null,
  roomCode: null,
  myName: null,
  gameState: null,   // { code, phase, round (1–4), hostName, players, readyProgress?, ... }
  hasSubmitted: false,
  voluntaryLeaveInProgress: false,
  lastResolveData: null,
};

let leaveRoomFallbackTimer = null;
let allocTimerInterval = null;

const ROUND_COUNT = 4;

function buildRoundTrackMarkup() {
  return Array.from(
    { length: ROUND_COUNT },
    (_, i) => `<span class="round-pip" data-i="${i + 1}" aria-hidden="true"></span>`,
  ).join('');
}

function mountRoundTracks() {
  ['alloc-round-track', 'reveal-round-track'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.querySelector('.round-pip')) {
      el.innerHTML = buildRoundTrackMarkup();
    }
  });
}

/** First `round` pips (1–4) are orange; the rest stay gray. */
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

/* ── How To Play Modal ─────────────────────────────────────────────────── */
const HTP_SLIDE_COUNT = 7;
let htpCurrent = 0;

function openHtp(startSlide = 0) {
  htpCurrent = startSlide;
  const modal = document.getElementById('htp-modal');
  modal.classList.remove('hidden');
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
    dot.type = 'button';
    dot.className = 'htp-dot';
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.dataset.i = i;
    dot.addEventListener('click', () => htpGoTo(i));
    container.appendChild(dot);
  }
}

function htpShowSlide(index, direction = 'next') {
  const slides = document.querySelectorAll('.htp-slide');
  slides.forEach((s, i) => {
    s.classList.remove('htp-slide--active', 'htp-slide--exit-left');
    if (i === index) {
      // Reset position before activating
      s.style.transform = direction === 'prev' ? 'translateX(-32px)' : 'translateX(32px)';
      s.style.opacity = '0';
      // Force reflow
      s.offsetHeight; // eslint-disable-line no-unused-expressions
      s.style.transform = '';
      s.style.opacity = '';
      s.classList.add('htp-slide--active');
    }
  });

  // Update dots
  document.querySelectorAll('.htp-dot').forEach((dot, i) => {
    dot.classList.toggle('htp-dot--active', i === index);
  });

  // Update nav buttons
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

  // All HTP trigger buttons (landing btn has its own id, others use .btn-htp class)
  document.getElementById('btn-htp-landing')?.addEventListener('click', () => openHtp(0));
  document.addEventListener('click', e => {
    if (e.target.closest('.btn-htp')) openHtp(0);
  });

  // Close button
  document.getElementById('htp-close').addEventListener('click', closeHtp);

  // Backdrop click
  document.getElementById('htp-backdrop').addEventListener('click', closeHtp);

  // Prev / Next
  document.getElementById('htp-prev').addEventListener('click', () => htpGoTo(htpCurrent - 1));
  document.getElementById('htp-next').addEventListener('click', () => htpGoTo(htpCurrent + 1));

  // Keyboard
  document.getElementById('htp-modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeHtp(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') htpGoTo(htpCurrent + 1);
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   htpGoTo(htpCurrent - 1);
  });
}

function updateHostEndGameButtons() {
  const show = isHost() && state.gameState && state.gameState.phase !== 'lobby';
  document.querySelectorAll('.btn-host-end-game').forEach(btn => {
    btn.classList.toggle('hidden', !show);
  });
}

function clearVoluntaryLeave() {
  state.voluntaryLeaveInProgress = false;
  if (leaveRoomFallbackTimer) {
    clearTimeout(leaveRoomFallbackTimer);
    leaveRoomFallbackTimer = null;
  }
}

function beginVoluntaryLeave() {
  state.voluntaryLeaveInProgress = true;
  if (leaveRoomFallbackTimer) clearTimeout(leaveRoomFallbackTimer);
  leaveRoomFallbackTimer = setTimeout(() => {
    leaveRoomFallbackTimer = null;
    if (state.voluntaryLeaveInProgress) {
      state.voluntaryLeaveInProgress = false;
      returnToMainMenu(null);
    }
  }, 200);
}

// Allocation UI state
const allocState = {
  selectedZones: new Set(),
  resources: { east: 0, west: 0, downtown: 0 },
  myResources: 0,
};

function allocResourceDisplay(n) {
  return n === 0 ? '×' : String(n);
}

function setZoneResVal(zone, n) {
  const el = document.getElementById(`res-${zone}`);
  if (!el) return;
  el.textContent = allocResourceDisplay(n);
  el.classList.toggle('res-val--empty', n === 0);
}

const ZONE_KEYS = ['east', 'downtown', 'west'];

function setZoneResRowActive(zone, active) {
  const card = document.querySelector(`.zone-card[data-zone="${zone}"]`);
  if (!card) return;
  card.querySelector('.zone-res-row').classList.toggle('zone-res-row--inactive', !active);
}

function renderZonePips(zone) {
  const el = document.getElementById(`pips-${zone}`);
  if (!el) return;
  const sel = allocState.selectedZones.has(zone);
  const res = allocState.resources[zone];
  const parts = [];
  if (sel) {
    parts.push('<span class="zone-pip zone-pip--crew"></span>');
    for (let i = 0; i < res; i++) parts.push('<span class="zone-pip zone-pip--res"></span>');
  }
  el.innerHTML = parts.join('');
}

function refreshAllZonePips() {
  ZONE_KEYS.forEach(renderZonePips);
}

/* ── Utility ───────────────────────────────────────────────────────────── */
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
  if (n > 0) return 'delta-pos';
  if (n < 0) return 'delta-neg';
  return 'delta-zero';
}

function deltaStr(n) {
  if (n > 0) return `+${n}`;
  return String(n);
}

function isHost() {
  return state.gameState && state.gameState.hostName === state.myName;
}

function myPlayer() {
  if (!state.gameState) return null;
  return state.gameState.players.find(p => p.name === state.myName) || null;
}

/* ── Standings Table ───────────────────────────────────────────────────── */
function heatPipsHtml(heat) {
  if (heat === 0) return '<span style="color:var(--text-dim)">—</span>';
  return Array.from({ length: heat }, () => '<span class="heat-pip heat-pip--sm"></span>').join('');
}

function renderStandings(tableId, players) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.innerHTML = `
    <thead><tr>
      <th>#</th><th>Player</th><th>Resources</th><th>Heat</th>
    </tr></thead>
    <tbody>
      ${players.map((p, i) => `
        <tr class="${p.name === state.myName ? 'me' : ''} ${p.connected === false ? 'offline-row' : ''}">
          <td>${i + 1}</td>
          <td>${escHtml(p.name)}${p.name === state.myName ? ' (you)' : ''}</td>
          <td>${p.resources}</td>
          <td><span class="heat-pips heat-pips--inline">${heatPipsHtml(p.heat)}</span></td>
        </tr>
      `).join('')}
    </tbody>`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const MAX_LOBBY_SLOTS = 6;
const MIN_PLAYERS_TO_START = 3;

/* ── Lobby seat grid (6 slots) ─────────────────────────────────────────── */
function renderLobbySlots(players, hostName) {
  const container = document.getElementById('lobby-slots');
  if (!container) return;
  const amHost = state.myName === hostName;
  const list = [...players];

  const slotsHtml = [];
  for (let i = 0; i < MAX_LOBBY_SLOTS; i++) {
    const p = list[i];
    if (p) {
      slotsHtml.push(`
        <div class="lobby-slot lobby-slot--filled">
          <span class="lobby-slot-main">
            <span class="dot ${p.connected === false ? 'offline' : ''}"></span>
            <span class="lobby-slot-name">${escHtml(p.name)}${p.name === state.myName ? ' <span class="lobby-you">(you)</span>' : ''}</span>
          </span>
          <span class="lobby-slot-meta">
            ${p.name === hostName ? '<span class="host-tag">HOST</span>' : ''}
            ${amHost && p.name !== state.myName
              ? `<button type="button" class="btn btn-kick" data-name="${escAttr(p.name)}" title="Remove this player from the lobby" aria-label="Kick ${escAttr(p.name)}">Kick</button>`
              : ''}
          </span>
        </div>`);
    } else {
      const needClass = i < MIN_PLAYERS_TO_START ? ' lobby-slot--required' : '';
      slotsHtml.push(`
        <div class="lobby-slot lobby-slot--empty${needClass}">
          <span class="lobby-slot-hint">Open seat</span>
        </div>`);
    }
  }
  container.innerHTML = slotsHtml.join('');

  container.querySelectorAll('.btn-kick').forEach(btn => {
    btn.addEventListener('click', () => {
      state.socket.emit('kick_player', { roomCode: state.roomCode, playerName: btn.dataset.name });
    });
  });
}

function returnToMainMenu(clearMessage) {
  clearVoluntaryLeave();
  state.roomCode = null;
  state.myName = null;
  state.gameState = null;
  state.hasSubmitted = false;
  state.lastResolveData = null;
  sessionStorage.removeItem('heatsync_session');
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.pathname + url.search);
  showLandingView('home');
  showScreen('screen-landing');
  if (clearMessage) showError('landing-error', clearMessage);
}

function emitLeaveRoom() {
  if (state.socket && state.roomCode) {
    beginVoluntaryLeave();
    state.socket.emit('leave_room', { roomCode: state.roomCode });
  }
}

function renderHeatPips(heat) {
  const el = document.getElementById('alloc-heat-pips');
  if (!el) return;
  if (heat === 0) {
    el.innerHTML = '<span class="heat-pip-none">—</span>';
  } else {
    el.innerHTML = Array.from({ length: heat }, () => '<span class="heat-pip"></span>').join('');
  }
}

function updateIngameCodeBadges() {
  const code = state.roomCode || '';
  document.querySelectorAll('.ingame-code-badge').forEach(btn => {
    btn.textContent = code;
  });
}

function refreshScreenAfterRosterChange(gs) {
  const id = document.querySelector('.screen.active')?.id;
  if (id === 'screen-allocation') {
    const me = gs.players.find(p => p.name === state.myName);
    if (!me) return;
    renderHeatPips(me.heat);
    allocState.myResources = me.resources;
    updateRemaining();
    if (gs.allocationProgress) {
      const el = document.getElementById('submitted-count');
      if (el) {
        el.textContent = `${gs.allocationProgress.submittedCount} of ${gs.allocationProgress.totalCount} submitted`;
      }
    }
  }
}

/* ── Landing Screen ────────────────────────────────────────────────────── */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function showLandingView(view) {
  document.getElementById('landing-home').classList.toggle('hidden', view !== 'home');
  document.getElementById('landing-create').classList.toggle('hidden', view !== 'create');
  document.getElementById('landing-join').classList.toggle('hidden', view !== 'join');
}

function resetJoinPasswordStep() {
  const step = document.getElementById('join-password-step');
  if (step) step.classList.add('hidden');
  const pw = document.getElementById('join-password');
  if (pw) pw.value = '';
}

function setupLanding() {
  // Pre-fill saved name
  const savedName = localStorage.getItem('heatsync_name');
  if (savedName) {
    document.getElementById('create-name').value = savedName;
    document.getElementById('join-name').value = savedName;
  }

  // Check for room code in URL — go straight to join view
  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get('room');
  if (codeParam) {
    resetJoinPasswordStep();
    showLandingView('join');
    document.getElementById('join-code').value = codeParam.toUpperCase();
    document.getElementById('join-name').focus();
  }

  // Home buttons
  document.getElementById('btn-show-create').addEventListener('click', () => {
    showLandingView('create');
    document.getElementById('create-code-preview').textContent = genCode();
    document.getElementById('create-name').focus();
  });
  document.getElementById('btn-show-join').addEventListener('click', () => {
    resetJoinPasswordStep();
    showLandingView('join');
    document.getElementById('join-name').focus();
  });

  // Back buttons
  document.getElementById('btn-back-create').addEventListener('click', () => showLandingView('home'));
  document.getElementById('btn-back-join').addEventListener('click', () => {
    resetJoinPasswordStep();
    showLandingView('home');
  });

  document.getElementById('join-code').addEventListener('input', () => {
    resetJoinPasswordStep();
    hideError('join-error');
  });

  // Regenerate code
  document.getElementById('btn-regen-code').addEventListener('click', () => {
    const el = document.getElementById('create-code-preview');
    el.classList.add('regen-spin');
    el.textContent = genCode();
    setTimeout(() => el.classList.remove('regen-spin'), 300);
  });

  // Create room
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('create-name').value.trim();
    const password = document.getElementById('create-password').value.trim();
    const preferredCode = document.getElementById('create-code-preview').textContent.trim();
    if (!name) { showError('create-error', 'Enter your name'); return; }
    state.socket.emit('create_room', { playerName: name, password: password || null, preferredCode });
  });

  // Join room (password only after server says room is protected)
  document.getElementById('btn-join').addEventListener('click', () => {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const pwdStep = document.getElementById('join-password-step');
    const passwordVisible = pwdStep && !pwdStep.classList.contains('hidden');
    const password = document.getElementById('join-password').value.trim();
    if (!name) { showError('join-error', 'Enter your name'); return; }
    if (!code) { showError('join-error', 'Enter the code'); return; }
    if (passwordVisible && !password) { showError('join-error', 'Enter the password'); return; }
    const payload = { roomCode: code, playerName: name };
    if (passwordVisible) {
      payload.password = password;
      payload.passwordRetry = true;
    }
    state.socket.emit('join_room', payload);
  });

  // Enter key shortcuts
  ['create-name', 'create-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-create').click();
    });
  });
  ['join-name', 'join-code', 'join-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-join').click();
    });
  });
}

/* ── Lobby Screen ──────────────────────────────────────────────────────── */
function updateLobbyChrome(gs) {
  const startBtn = document.getElementById('btn-start');
  const n = gs.players.length;
  const canStart = n >= MIN_PLAYERS_TO_START;

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
  updateLobbyChrome(gs);
  updateLobbyTimerUI(gs);
  updateHostEndGameButtons();

  showScreen('screen-lobby');
}

/* ── Timer helpers ─────────────────────────────────────────────────────────── */

function fmtTimerSeconds(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function stopAllocTimer() {
  if (allocTimerInterval) {
    clearInterval(allocTimerInterval);
    allocTimerInterval = null;
  }
  const el = document.getElementById('alloc-timer');
  if (el) el.classList.add('hidden');
}

function startAllocTimer(endsAt) {
  stopAllocTimer();
  const el = document.getElementById('alloc-timer');
  const display = document.getElementById('alloc-timer-display');
  if (!el || !display) return;
  el.classList.remove('hidden');
  el.classList.remove('alloc-timer--urgent');

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    display.textContent = fmtTimerSeconds(remaining);
    if (remaining <= 30) el.classList.add('alloc-timer--urgent');
    else el.classList.remove('alloc-timer--urgent');
    if (remaining === 0) stopAllocTimer();
  };
  tick();
  allocTimerInterval = setInterval(tick, 500);
}

function updateLobbyTimerUI(gs) {
  const row = document.getElementById('lobby-timer-row');
  if (!row) return;
  const amHost = gs && gs.hostName === state.myName;
  row.classList.toggle('hidden', !amHost);
  if (!amHost) return;

  const enabled = gs.timerEnabled || false;
  const dur = gs.timerDuration || 180;
  const toggleBtn = document.getElementById('btn-timer-toggle');
  const durationRow = document.getElementById('timer-duration-controls');
  const durationDisplay = document.getElementById('timer-duration-display');

  toggleBtn.setAttribute('aria-checked', String(enabled));
  toggleBtn.classList.toggle('timer-toggle--on', enabled);
  // Use visibility so row height stays constant whether controls are shown or not
  durationRow.style.visibility = enabled ? 'visible' : 'hidden';
  durationRow.classList.remove('hidden');
  durationDisplay.textContent = fmtTimerSeconds(dur);

  // Dim step buttons at range limits
  const decBtn = document.getElementById('btn-timer-dec');
  const incBtn = document.getElementById('btn-timer-inc');
  if (decBtn) decBtn.disabled = dur <= 60;
  if (incBtn) incBtn.disabled = dur >= 300;

  // store current values so step buttons can read them
  row.dataset.duration = dur;
}

function setupLobby() {
  initLeaveConfirmModal();

  const linkBtn = document.getElementById('btn-copy-link');
  const linkTitleDefault = linkBtn.getAttribute('title') || 'Copy invite link';

  const codeBtn = document.getElementById('btn-copy-code');
  const codeTitleDefault = codeBtn.getAttribute('title') || 'Copy code';

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = state.roomCode || '';
    const btn = document.getElementById('btn-copy-code');
    const markCopied = () => {
      btn.classList.add('room-code--copied');
      btn.title = 'Copied!';
      btn.setAttribute('aria-label', 'Code copied');
      setTimeout(() => {
        btn.classList.remove('room-code--copied');
        btn.title = codeTitleDefault;
        btn.setAttribute('aria-label', codeTitleDefault);
      }, 2000);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      markCopied();
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(markCopied).catch(fallback);
    } else {
      fallback();
    }
  });

  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.search = `?room=${state.roomCode}`;
    const link = url.toString();
    const btn = document.getElementById('btn-copy-link');

    const markCopied = () => {
      btn.classList.add('btn-copy--done');
      btn.title = 'Copied!';
      btn.setAttribute('aria-label', 'Link copied');
      setTimeout(() => {
        btn.classList.remove('btn-copy--done');
        btn.title = linkTitleDefault;
        btn.setAttribute('aria-label', linkTitleDefault);
      }, 2000);
    };

    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      markCopied();
    };

    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(markCopied).catch(fallback);
    } else {
      fallback();
    }
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    state.socket.emit('start_game', { roomCode: state.roomCode });
  });

  document.getElementById('btn-leave-lobby').addEventListener('click', openLeaveConfirmModal);

  // Timer controls (host only)
  document.getElementById('btn-timer-toggle').addEventListener('click', () => {
    const gs = state.gameState;
    if (!gs) return;
    const newEnabled = !(gs.timerEnabled || false);
    state.socket.emit('set_timer', { roomCode: state.roomCode, enabled: newEnabled });
  });

  document.getElementById('btn-timer-dec').addEventListener('click', () => {
    const row = document.getElementById('lobby-timer-row');
    const cur = Number(row.dataset.duration) || 180;
    const next = Math.max(60, cur - 30);
    state.socket.emit('set_timer', { roomCode: state.roomCode, duration: next });
  });

  document.getElementById('btn-timer-inc').addEventListener('click', () => {
    const row = document.getElementById('lobby-timer-row');
    const cur = Number(row.dataset.duration) || 180;
    const next = Math.min(300, cur + 30);
    state.socket.emit('set_timer', { roomCode: state.roomCode, duration: next });
  });
}

function setupGameLeaveButtons() {
  initLeaveConfirmModal();
  document.querySelectorAll('.btn-leave-game').forEach(btn => {
    btn.addEventListener('click', openLeaveConfirmModal);
  });

  // In-game code badges — click to copy
  document.querySelectorAll('.ingame-code-badge').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = state.roomCode;
      if (!code) return;
      const url = `${location.origin}${location.pathname}?room=${code}`;
      navigator.clipboard.writeText(url).catch(() => navigator.clipboard.writeText(code));
      btn.classList.add('room-code--copied');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => {
        btn.classList.remove('room-code--copied');
        btn.textContent = orig;
      }, 1500);
    });
  });
}

function setupHostEndGame() {
  initEndGameModal();
  document.querySelectorAll('.btn-host-end-game').forEach(btn => {
    btn.addEventListener('click', openEndGameModal);
  });
}

/* ── Allocation Screen ─────────────────────────────────────────────────── */
function goToAllocation(gs) {
  state.gameState = gs;
  state.hasSubmitted = false;

  const me = myPlayer();
  allocState.myResources = me ? me.resources : 0;
  allocState.selectedZones = new Set();
  allocState.resources = { east: 0, west: 0, downtown: 0 };

  updateRoundTrack('alloc-round-track', gs.round);
  renderHeatPips(me ? me.heat : 0);
  updateIngameCodeBadges();

  document.querySelectorAll('.zone-card').forEach(card => {
    card.classList.remove('selected');
    const z = card.dataset.zone;
    setZoneResRowActive(z, false);
  });
  ZONE_KEYS.forEach(z => setZoneResVal(z, 0));
  refreshAllZonePips();
  updateRemaining();
  updateSubmitBtn();

  document.getElementById('alloc-submit-section').classList.remove('hidden');
  document.getElementById('alloc-waiting').classList.add('hidden');
  hideError('alloc-error');

  if (gs.allocationProgress) {
    const el = document.getElementById('submitted-count');
    if (el && state.hasSubmitted) {
      el.textContent = `${gs.allocationProgress.submittedCount} of ${gs.allocationProgress.totalCount} submitted`;
    }
  }

  // Start countdown if server sent a timer end time
  if (gs.timerEndAt) {
    startAllocTimer(gs.timerEndAt);
  } else {
    stopAllocTimer();
  }

  updateHostEndGameButtons();
  showScreen('screen-allocation');
}

function setupAllocation() {
  // Zone card click = toggle selection
  document.querySelectorAll('.zone-card').forEach(card => {
    card.addEventListener('click', () => {
      if (state.hasSubmitted) return;
      const zone = card.dataset.zone;
      if (allocState.selectedZones.has(zone)) {
        allocState.selectedZones.delete(zone);
        allocState.resources[zone] = 0;
        card.classList.remove('selected');
        setZoneResRowActive(zone, false);
        setZoneResVal(zone, 0);
      } else {
        if (allocState.selectedZones.size >= 2) return;
        allocState.selectedZones.add(zone);
        card.classList.add('selected');
        setZoneResRowActive(zone, true);
      }
      renderZonePips(zone);
      updateRemaining();
      updateSubmitBtn();
    });
  });

  // +/- resource buttons
  document.querySelectorAll('.res-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.hasSubmitted) return;
      const zone = btn.dataset.zone;
      const dir = parseInt(btn.dataset.dir);
      const remaining = getAllocRemaining();

      if (dir === 1 && remaining <= 0) return; // no resources left
      if (dir === -1 && allocState.resources[zone] <= 0) return; // already 0

      allocState.resources[zone] += dir;
      setZoneResVal(zone, allocState.resources[zone]);
      renderZonePips(zone);
      updateRemaining();
      updateSubmitBtn();
    });
  });

  document.getElementById('btn-submit').addEventListener('click', submitAllocation);
}

function getAllocRemaining() {
  const used = Object.values(allocState.resources).reduce((a, b) => a + b, 0);
  return allocState.myResources - used;
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
    const dir = parseInt(btn.dataset.dir, 10);
    if (!allocState.selectedZones.has(zone)) {
      btn.classList.remove('res-btn--actionable');
      return;
    }
    const actionable =
      dir === 1 ? getAllocRemaining() > 0 : allocState.resources[zone] > 0;
    btn.classList.toggle('res-btn--actionable', actionable);
  });
}

function updateSubmitBtn() {
  const valid = allocState.selectedZones.size === 2 && getAllocRemaining() === 0;
  document.getElementById('btn-submit').disabled = !valid;
}

function submitAllocation() {
  if (state.hasSubmitted) return;

  const allocation = {
    east:     { crew: allocState.selectedZones.has('east')     ? 1 : 0, resources: allocState.resources.east },
    west:     { crew: allocState.selectedZones.has('west')     ? 1 : 0, resources: allocState.resources.west },
    downtown: { crew: allocState.selectedZones.has('downtown') ? 1 : 0, resources: allocState.resources.downtown },
  };

  state.socket.emit('submit_allocation', { roomCode: state.roomCode, allocation });
  state.hasSubmitted = true;
  updateAllocResButtons();

  document.getElementById('alloc-submit-section').classList.add('hidden');
  document.getElementById('alloc-waiting').classList.remove('hidden');
  hideError('alloc-error');
}

/* ── Reveal Screen ─────────────────────────────────────────────────────── */
const ZONE_DISPLAY_ORDER = ['west', 'downtown', 'east'];
const ZONE_NAMES = { west: 'The Docks', downtown: 'The Strip', east: 'The Slums' };

function sortZonesForDisplay(zoneResults) {
  return [...zoneResults].sort(
    (a, b) => ZONE_DISPLAY_ORDER.indexOf(a.zone) - ZONE_DISPLAY_ORDER.indexOf(b.zone),
  );
}

function updateRevealReadyUI(gs) {
  const el = document.getElementById('reveal-ready-count');
  const cont = document.getElementById('btn-continue');
  if (!el || !cont) return;
  const rp = gs.readyProgress;
  if (!rp) {
    el.textContent = '';
    cont.disabled = false;
    return;
  }
  el.textContent = `${rp.readyCount} / ${rp.totalCount} ready`;
  const already = rp.readyNames && rp.readyNames.includes(state.myName);
  cont.disabled = !!already;
}

const OUTCOME_LABELS = {
  all_different:   'One zone took all the heat — the others walked clean',
  two_tied_lowest: 'Two crews stayed off the radar — payouts are split',
  two_tied_highest:'Two zones got burned — the heat is shared',
  all_tied:        'Citywide lockdown — nobody wins big',
};

const ROLE_LABELS = {
  highest:      '🚔 Hot zone — lose it all',
  lone_highest: '🚔 Hot zone — lose it all',
  middle:       '🤝 Even — keep +1',
  lowest:       '💰 Clean run — triple up',
  lone_lowest:  '💰 Clean run — triple up',
  tied_lowest:  '📈 Shared low — double up',
  tied_highest: '📉 Shared heat — halved',
  tied:         '🔒 Citywide lockdown',
};

function goToReveal(resolveData, gs, isGameOver) {
  state.gameState = gs;
  state.lastResolveData = resolveData;

  updateRoundTrack('reveal-round-track', resolveData.round);

  const totalsEl = document.getElementById('reveal-zone-totals');
  totalsEl.innerHTML = ZONE_DISPLAY_ORDER.map((zone) => {
    const total = resolveData.zoneTotals[zone];
    const role = resolveData.classification.outcome === 'all_tied'
      ? 'tied'
      : resolveData.classification.roles[zone];
    return `
      <div class="zone-total-card zt-zone--${zone}">
        <div class="zt-name zt-name--${zone}">${ZONE_NAMES[zone]}</div>
        <div class="zt-number">${total}</div>
        <div class="zt-role role-${role}">${roleShortLabel(role)}</div>
      </div>`;
  }).join('');

  // Outcome banner
  document.getElementById('reveal-outcome-banner').textContent =
    OUTCOME_LABELS[resolveData.classification.outcome] || '';

  // Player results
  const resultsEl = document.getElementById('reveal-player-results');
  resultsEl.innerHTML = resolveData.playerResults.map(pr => {
    const sign = pr.totalDelta >= 0 ? `+${pr.totalDelta}` : String(pr.totalDelta);
    const cls = deltaClass(pr.totalDelta);
    const zoneLines = sortZonesForDisplay(pr.zoneResults).map(zr => {
      const outcome = ROLE_LABELS[zr.outcome] || zr.outcome;
      return `<div class="zone-result-row">
        <span class="zone-tag zone-tag--${zr.zone}">${ZONE_NAMES[zr.zone]}</span>:
        <span class="${deltaClass(zr.delta)}">${deltaStr(zr.delta)}</span>
        <span> (${outcome})</span>
      </div>`;
    }).join('');
    return `
      <div class="player-result">
        <div class="player-result-header">
          <span class="player-result-name">${escHtml(pr.name)}${pr.name === state.myName ? ' (you)' : ''}</span>
          <span class="player-result-delta"><span class="${cls}">${sign} resources</span> → ${pr.newResources} total</span>
        </div>
        ${zoneLines}
      </div>`;
  }).join('');

  // Heat penalties
  const heatSection = document.getElementById('reveal-heat-penalties');
  if (resolveData.heatPenalties && resolveData.heatPenalties.length > 0) {
    heatSection.classList.remove('hidden');
    const names = resolveData.heatPenalties.map(h => h.name);
    const nameList = names.length === 1
      ? names[0]
      : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    heatSection.querySelector('.heat-notice').textContent =
      `${nameList} gained heat`;
  } else {
    heatSection.classList.add('hidden');
  }

  // Standings
  renderStandings('reveal-standings', resolveData.standings);

  // Buttons
  const continueBtn = document.getElementById('btn-continue');
  const seeResultsBtn = document.getElementById('btn-see-results');

  if (isGameOver) {
    continueBtn.classList.add('hidden');
    seeResultsBtn.classList.remove('hidden');
    document.getElementById('reveal-ready-count').textContent = '';
  } else {
    continueBtn.classList.remove('hidden');
    const n = gs.round;
    const nextRoundEl = document.getElementById('next-round-num');
    if (nextRoundEl) nextRoundEl.textContent = String(n);
    continueBtn.title = 'Ready for the next allocation round';
    continueBtn.setAttribute('aria-label', `Ready for round ${n}`);
    seeResultsBtn.classList.add('hidden');
    updateRevealReadyUI(gs);
  }

  updateIngameCodeBadges();
  updateHostEndGameButtons();
  showScreen('screen-reveal');
}

function roleShortLabel(role) {
  const map = {
    highest:      'HOT ZONE · LOSE ALL',
    lone_highest: 'HOT ZONE · LOSE ALL',
    middle:       'EVEN · KEEP +1',
    lowest:       'CLEAN · TRIPLE',
    lone_lowest:  'CLEAN · TRIPLE',
    tied_lowest:  'SHARED LOW · DOUBLE',
    tied_highest: 'SHARED HOT · HALVE',
    tied:         'LOCKDOWN',
  };
  return map[role] || role.toUpperCase();
}

function setupReveal() {
  document.getElementById('btn-continue').addEventListener('click', () => {
    state.socket.emit('ready_for_next', { roomCode: state.roomCode });
    document.getElementById('btn-continue').disabled = true;
  });

  document.getElementById('btn-see-results').addEventListener('click', () => {
    showScreen('screen-gameover');
  });
}

/* ── Game Over Screen ──────────────────────────────────────────────────── */
function goToGameOver(winners, gs) {
  state.gameState = gs;

  const winnerBanner = document.getElementById('winner-banner');
  if (winners.length === 1) {
    winnerBanner.textContent = `${winners[0]} wins!`;
  } else if (winners.length === 0) {
    winnerBanner.textContent = 'No winner?';
  } else {
    winnerBanner.textContent = `Draw: ${winners.join(' & ')}`;
  }

  const sorted = [...gs.players].sort((a, b) => b.resources - a.resources || a.heat - b.heat);
  renderStandings('gameover-standings', sorted);

  const playAgainBtn = document.getElementById('btn-play-again');
  const waitingEl = document.getElementById('gameover-waiting');
  if (isHost()) {
    playAgainBtn.classList.remove('hidden');
    waitingEl.classList.add('hidden');
  } else {
    playAgainBtn.classList.add('hidden');
    waitingEl.classList.remove('hidden');
  }

  updateIngameCodeBadges();
  updateHostEndGameButtons();
  showScreen('screen-gameover');
}

function setupGameOver() {
  document.getElementById('btn-play-again').addEventListener('click', () => {
    state.socket.emit('play_again', { roomCode: state.roomCode });
  });
}

/* ── Socket Setup ──────────────────────────────────────────────────────── */
function initSocket() {
  state.socket = io();

  state.socket.on('connect', () => {
    // Attempt reconnect if we have saved session
    const saved = sessionStorage.getItem('heatsync_session');
    if (saved) {
      try {
        const { roomCode, playerName } = JSON.parse(saved);
        if (roomCode && playerName) {
          state.myName = playerName;
          state.roomCode = roomCode;
          state.socket.emit('join_room', { roomCode, playerName });
        }
      } catch (_) {}
    }
  });

  state.socket.on('password_required', () => {
    document.getElementById('join-password-step').classList.remove('hidden');
    hideError('join-error');
    document.getElementById('join-password').focus();
  });

  state.socket.on('room_joined', ({ roomCode, myName, state: gs }) => {
    clearVoluntaryLeave();
    resetJoinPasswordStep();
    state.roomCode = roomCode;
    state.myName = myName;
    localStorage.setItem('heatsync_name', myName);
    sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode, playerName: myName }));
    goToLobby(gs);
  });

  state.socket.on('reconnected', ({ myName, state: gs, hasSubmitted, lastResolveData }) => {
    clearVoluntaryLeave();
    state.myName = myName;
    state.hasSubmitted = hasSubmitted;
    state.gameState = gs;
    sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode: gs.code, playerName: myName }));

    // Route to correct screen
    switch (gs.phase) {
      case 'lobby':       goToLobby(gs); break;
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
        showScreen('screen-gameover');
        break;
    }
  });

  state.socket.on('player_joined', ({ name, state: gs }) => {
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

  state.socket.on('player_left', ({ name, state: gs }) => {
    if (name === state.myName && state.roomCode && !state.voluntaryLeaveInProgress) {
      const me = gs.players && gs.players.find(p => p.name === state.myName);
      if (me && me.connected === false) {
        state.socket.emit('join_room', { roomCode: state.roomCode, playerName: state.myName });
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

  state.socket.on('left_room', () => {
    returnToMainMenu(null);
  });

  state.socket.on('phase_changed', ({ phase, state: gs }) => {
    state.gameState = gs;
    if (phase === 'allocation') {
      document.getElementById('btn-continue').disabled = false;
      goToAllocation(gs);
    }
  });

  state.socket.on('player_ready', ({ name, readyCount, totalCount }) => {
    const el = document.getElementById('reveal-ready-count');
    if (el) el.textContent = `${readyCount} / ${totalCount} ready`;
    if (name === state.myName) {
      const c = document.getElementById('btn-continue');
      if (c) c.disabled = true;
    }
  });

  state.socket.on('allocation_received', ({ submittedCount, totalCount }) => {
    const el = document.getElementById('submitted-count');
    if (el) el.textContent = `${submittedCount} of ${totalCount} submitted`;
  });

  state.socket.on('round_resolved', ({ resolveData, state: gs }) => {
    state.gameState = gs;
    goToReveal(resolveData, gs, false);
  });

  state.socket.on('game_over', ({ resolveData, winners, state: gs }) => {
    state.gameState = gs;
    // Show reveal first, then game over on button click
    goToReveal(resolveData, gs, true);
    // Store winners for when user clicks "See Final Results"
    document.getElementById('btn-see-results').onclick = () => goToGameOver(winners, gs);
  });

  state.socket.on('timer_start', ({ endsAt }) => {
    startAllocTimer(endsAt);
  });

  state.socket.on('timer_expired', () => {
    stopAllocTimer();
  });

  state.socket.on('timer_settings_changed', ({ timerEnabled, timerDuration }) => {
    if (state.gameState) {
      state.gameState.timerEnabled = timerEnabled;
      state.gameState.timerDuration = timerDuration;
    }
    updateLobbyTimerUI(state.gameState);
  });

  state.socket.on('game_reset', ({ state: gs }) => {
    clearVoluntaryLeave();
    state.gameState = gs;
    state.hasSubmitted = false;
    sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode: gs.code, playerName: state.myName }));
    goToLobby(gs);
  });

  state.socket.on('kicked', ({ message }) => {
    clearVoluntaryLeave();
    state.roomCode = null;
    state.myName = null;
    state.gameState = null;
    sessionStorage.removeItem('heatsync_session');
    showLandingView('home');
    showScreen('screen-landing');
    showError('landing-error', message || 'You were removed from the room');
  });

  state.socket.on('error', ({ message }) => {
    const screen = document.querySelector('.screen.active')?.id;
    // On landing, show error in whichever sub-view is visible
    let errId = 'landing-error';
    if (screen === 'screen-landing') {
      const joinVisible   = !document.getElementById('landing-join').classList.contains('hidden');
      const createVisible = !document.getElementById('landing-create').classList.contains('hidden');
      if (joinVisible)        errId = 'join-error';
      else if (createVisible) errId = 'create-error';
      else                    errId = 'landing-error';
    } else if (screen === 'screen-lobby') {
      errId = 'lobby-error';
    } else if (screen === 'screen-allocation') {
      errId = 'alloc-error';
    }
    showError(errId, message);

    // If allocation failed, re-enable submit
    if (screen === 'screen-allocation' && state.hasSubmitted) {
      state.hasSubmitted = false;
      document.getElementById('alloc-submit-section').classList.remove('hidden');
      document.getElementById('alloc-waiting').classList.add('hidden');
      updateAllocResButtons();
    }
  });
}

/* ── Logo (single template → each [data-heatsync-logo] host) ───────────── */
function initHeatsyncLogos() {
  const tpl = document.getElementById('tpl-heatsync-logo');
  if (!tpl) return;
  document.querySelectorAll('[data-heatsync-logo]').forEach(host => {
    if (host.querySelector('.logo-slice-glow')) return;
    host.appendChild(tpl.content.cloneNode(true));
  });
}

/* ── Boot ──────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initHeatsyncLogos();
  mountRoundTracks();
  initSocket();
  setupLanding();
  setupLobby();
  setupGameLeaveButtons();
  setupHostEndGame();
  setupHtp();
  setupAllocation();
  setupReveal();
  setupGameOver();
});
