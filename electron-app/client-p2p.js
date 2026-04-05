'use strict';
// P2P-specific client code for the Electron desktop app.
// All shared UI/game-logic lives in public/shared.js (loaded first via <script> tag).
// This file adds: P2P transport init, overrides for returnToMainMenu /
// updateLobbyChrome / setupLanding / setupGameLeaveButtons, and reconnect/resume banners.

const { startHost, resumeHost, getSavedHostState } = require('../p2p/peer-host');
const { connectToPeer } = require('../p2p/peer-client');

/* ── Lazy PeerJS loader ──────────────────────────────────────────────────── */
// peerjs.min.js creates an RTCPeerConnection at module evaluation time to probe
// WebRTC support. In Electron on macOS this triggers a ~10-second ICE/network-
// interface scan that blocks the JS thread. Loading it asynchronously (after the
// landing screen is already painted) keeps startup instant.
let _peerJSPromise = null;
function loadPeerJS() {
  if (_peerJSPromise) return _peerJSPromise;
  if (window.Peer) return (_peerJSPromise = Promise.resolve());
  _peerJSPromise = new Promise(resolve => {
    const s = document.createElement('script');
    s.src = '../node_modules/peerjs/dist/peerjs.min.js';
    s.onload = resolve;
    document.head.appendChild(s);
  });
  return _peerJSPromise;
}

/* ── Navigation (P2P override) ───────────────────────────────────────────── */
// Overrides shared.js version: also destroys the P2P socket and resets buttons.
function returnToMainMenu(clearMessage) {
  clearVoluntaryLeave();
  state.roomCode = null;
  state.myName = null;
  state.gameState = null;
  state.hasSubmitted = false;
  state.lastResolveData = null;
  if (state.socket) {
    try { state.socket.destroy?.(); } catch (_) {}
    state.socket = null;
  }
  sessionStorage.removeItem('heatsync_session');
  // Reset button states in case we left mid-connect
  const createBtn = document.getElementById('btn-create');
  if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create'; }
  const joinBtn = document.getElementById('btn-join');
  if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Join'; }
  showLandingView('home');
  showScreen('screen-landing');
  if (clearMessage) showError('landing-error', clearMessage);
}

/* ── Lobby chrome (P2P override) ─────────────────────────────────────────── */
// Overrides shared.js version: shows "Resume Round N" when rejoining a mid-game room.
function updateLobbyChrome(gs) {
  const startBtn = document.getElementById('btn-start');
  const canStart = gs.players.length >= MIN_PLAYERS_TO_START;
  if (isHost()) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = !canStart;
    startBtn.textContent = (gs.round > 1) ? `Resume Round ${gs.round}` : 'Start';
  } else {
    startBtn.classList.add('hidden');
  }
}

/* ── P2P socket event handlers ───────────────────────────────────────────── */
/** Attach all socket event handlers to the given P2P socket shim. */
function attachSocketHandlers(socket) {
  // All shared handlers (identical between browser and P2P) live in shared.js.
  // P2P: onPlayerLeftSelf is a no-op — peer-client.js handles reconnect automatically.
  setupSocketHandlers(socket, { onPlayerLeftSelf: () => {} });

  // P2P-only: host disconnected — show reconnect banner so peer can rejoin when host returns.
  socket.on('host_disconnected', () => {
    const roomCode = state.roomCode;
    const playerName = state.myName;
    state.roomCode = null; state.myName = null; state.gameState = null;
    state.hasSubmitted = false; state.lastResolveData = null;
    if (state.socket) { try { state.socket.destroy?.(); } catch (_) {} state.socket = null; }
    const createBtn = document.getElementById('btn-create');
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create'; }
    const joinBtn = document.getElementById('btn-join');
    if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Join'; }
    showLandingView('home');
    showScreen('screen-landing');
    if (roomCode && playerName) showReconnectBanner(roomCode, playerName);
  });
}

/* ── P2P room creation / joining ─────────────────────────────────────────── */
async function doCreateRoom() {
  const name = document.getElementById('create-name').value.trim();
  const password = document.getElementById('create-password').value.trim();
  const preferredCode = document.getElementById('create-code-preview').textContent.trim();
  if (!name) { showError('create-error', 'Enter your name'); return; }

  const btn = document.getElementById('btn-create');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    await loadPeerJS();
    const { roomCode, socket } = await startHost(name, preferredCode);
    state.socket = socket;
    attachSocketHandlers(socket);
    socket.emit('create_room', { playerName: name, password: password || null, preferredCode: roomCode, icon: state.playerIcon, homeTurf: state.playerTurf });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Create';
    showError('create-error', err.message || 'Failed to create room');
  }
}

async function doJoinRoom() {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const pwdStep = document.getElementById('join-password-step');
  const passwordVisible = pwdStep && !pwdStep.classList.contains('hidden');
  const password = document.getElementById('join-password').value.trim();
  if (!name) { showError('join-error', 'Enter your name'); return; }
  if (!code)  { showError('join-error', 'Enter the code'); return; }
  if (passwordVisible && !password) { showError('join-error', 'Enter the password'); return; }

  // Connect to the host peer if not already connected (or if previous socket dropped)
  if (!state.socket || !state.socket.connected) {
    const btn = document.getElementById('btn-join');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      await loadPeerJS();
      const socket = await connectToPeer(code);
      state.socket = socket;
      attachSocketHandlers(socket);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Join';
      showError('join-error', err.message || 'Failed to connect — check the code and try again');
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Join';
  }

  const payload = { roomCode: code, playerName: name, icon: state.playerIcon, homeTurf: state.playerTurf };
  if (passwordVisible) { payload.password = password; payload.passwordRetry = true; }
  state.socket.emit('join_room', payload);
}

/* ── Landing screen (P2P override) ──────────────────────────────────────── */
// Overrides shared.js version: uses async doCreateRoom/doJoinRoom; no URL param handling.
function setupLanding() {
  const savedName = localStorage.getItem('heatsync_name');
  if (savedName) {
    document.getElementById('create-name').value = savedName;
    document.getElementById('join-name').value = savedName;
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
    state.socket = null; // discard stale peer connection
    showLandingView('home');
  });

  document.getElementById('join-code').addEventListener('input', () => {
    resetJoinPasswordStep();
    hideError('join-error');
    state.socket = null; // code changed — discard any stale peer connection
  });

  // Regenerate code
  document.getElementById('btn-regen-code').addEventListener('click', () => {
    const el = document.getElementById('create-code-preview');
    el.classList.add('regen-spin');
    el.textContent = genCode();
    setTimeout(() => el.classList.remove('regen-spin'), 300);
  });

  // Create / Join — async P2P transport
  document.getElementById('btn-create').addEventListener('click', doCreateRoom);
  document.getElementById('btn-join').addEventListener('click', doJoinRoom);

  // Enter-key shortcuts
  ['create-name', 'create-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doCreateRoom();
    });
  });
  ['join-name', 'join-code', 'join-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doJoinRoom();
    });
  });
}

/* ── In-game leave/copy buttons (P2P override) ───────────────────────────── */
// Overrides shared.js version: copies room code only (no shareable URL in Electron).
function setupGameLeaveButtons() {
  initLeaveConfirmModal();
  document.querySelectorAll('.btn-leave-game').forEach(btn => {
    btn.addEventListener('click', openLeaveConfirmModal);
  });

  // In-game code badge — copy just the room code
  document.querySelectorAll('.ingame-code-badge').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = state.roomCode;
      if (!code) return;
      const orig = btn.textContent;
      const markCopied = () => {
        btn.classList.add('room-code--copied');
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.classList.remove('room-code--copied'); btn.textContent = orig; }, 1500);
      };
      navigator.clipboard.writeText(code).then(markCopied).catch(() => {});
    });
  });
}

/* ── Reconnect banner (P2P peer) ─────────────────────────────────────────── */
function showReconnectBanner(roomCode, playerName) {
  // Strip accumulated listeners by replacing buttons with fresh clones
  ['btn-reconnect-yes', 'btn-reconnect-no'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const clone = el.cloneNode(true); el.replaceWith(clone); }
  });
  const banner = document.getElementById('reconnect-banner');
  if (!banner) return;

  document.getElementById('reconnect-code').textContent = roomCode;
  document.getElementById('reconnect-name').textContent = playerName;
  banner.classList.remove('hidden');

  document.getElementById('btn-reconnect-yes').addEventListener('click', async () => {
    // Disable No immediately to prevent both handlers firing on a rapid double-tap
    const noBtn = document.getElementById('btn-reconnect-no');
    if (noBtn) noBtn.disabled = true;
    banner.classList.add('hidden');
    const btn = document.getElementById('btn-reconnect-yes');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
      await loadPeerJS();
      const socket = await connectToPeer(roomCode);
      state.socket = socket;
      state.roomCode = roomCode;
      state.myName = playerName;
      sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode, playerName }));
      attachSocketHandlers(socket);
      socket.emit('join_room', { roomCode, playerName });
    } catch (err) {
      banner.classList.remove('hidden');
      if (btn) { btn.disabled = false; btn.textContent = 'Rejoin'; }
      showError('landing-error', 'Could not reconnect: ' + (err.message || 'Host may be offline'));
    }
  }, { once: true });

  document.getElementById('btn-reconnect-no').addEventListener('click', () => {
    const yesBtn = document.getElementById('btn-reconnect-yes');
    if (yesBtn) yesBtn.disabled = true;
    banner.classList.add('hidden');
    sessionStorage.removeItem('heatsync_session');
  }, { once: true });
}

function initReconnectBanner() {
  const saved = sessionStorage.getItem('heatsync_session');
  if (!saved) return;
  try {
    const { roomCode, playerName } = JSON.parse(saved);
    if (!roomCode || !playerName) return;
    // If this player is the host, the resume-banner handles it instead
    const savedHostState = getSavedHostState();
    if (savedHostState?.code === roomCode && savedHostState?.hostName === playerName) return;
    showReconnectBanner(roomCode, playerName);
  } catch (_) {}
}

/* ── Resume banner (P2P host) ────────────────────────────────────────────── */
function initResumeBanner() {
  const savedState = getSavedHostState();
  if (!savedState) return;

  const banner = document.getElementById('resume-banner');
  const codeEl = document.getElementById('resume-code');
  if (!banner || !codeEl) return;

  codeEl.textContent = savedState.code;
  banner.classList.remove('hidden');

  document.getElementById('btn-resume-yes').addEventListener('click', async () => {
    banner.classList.add('hidden');
    try {
      await loadPeerJS();
      const { roomCode, socket } = await resumeHost(savedState.code, savedState);
      state.socket = socket;
      state.roomCode = roomCode;
      state.myName = savedState.hostName;
      localStorage.setItem('heatsync_name', savedState.hostName);
      sessionStorage.setItem('heatsync_session', JSON.stringify({ roomCode, playerName: savedState.hostName }));
      attachSocketHandlers(socket);

      // Build a lobby-phase game state for the UI while players reconnect
      const gs = {
        code: roomCode,
        phase: 'lobby',
        round: savedState.round,
        hostName: savedState.hostName,
        timerEnabled: savedState.timerEnabled,
        timerDuration: savedState.timerDuration,
        homeTurfEnabled: savedState.homeTurfEnabled ?? false,
        crewRecoveryCostEnabled: savedState.crewRecoveryCostEnabled !== false,
        players: (savedState.players || []).map(([n, p]) => ({
          ...p, connected: n === savedState.hostName,
        })),
      };
      state.gameState = gs;
      goToLobby(gs);
    } catch (err) {
      showError('landing-error', 'Failed to resume: ' + (err.message || 'unknown error'));
    }
  }, { once: true });

  document.getElementById('btn-resume-no').addEventListener('click', () => {
    banner.classList.add('hidden');
    try { localStorage.removeItem('heatsync_host_state'); } catch (_) {}
  }, { once: true });
}

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Wire quit button (Electron only — present in electron-app/index.html landing screen)
  document.getElementById('btn-quit-app').addEventListener('click', () => {
    window.electronAPI.quit();
  });

  initHeatsyncLogos();
  mountRoundTracks();
  initResumeBanner();    // check for saved host state (P2P only)
  initReconnectBanner(); // check for saved peer session (P2P only)
  // No initSocket() — P2P transport is initialized on-demand in doCreateRoom / doJoinRoom
  // Kick off PeerJS in the background with a small random stagger so that multiple
  // dev instances don't all trigger RTCPeerConnection init at the exact same moment
  // (simultaneous calls contend on macOS network-interface enumeration).
  setTimeout(() => loadPeerJS(), 200 + Math.random() * 600);
  setupLanding();
  setupLobby();
  setupGameLeaveButtons();
  setupHostEndGame();
  setupHtp();
  setupAllocation();
  setupLastResultsModal();
  setupReveal();
  setupGameOver();
});
