'use strict';
// Browser-specific client code for HeatSync.
// All shared UI/game-logic lives in public/shared.js (loaded first via <script> tag).
// This file adds: returnToMainMenu, setupLanding, setupGameLeaveButtons,
// initReconnectBanner, and the socket.io transport (initSocket).

/* ── Navigation ──────────────────────────────────────────────────────────── */
function returnToMainMenu(clearMessage) {
  clearVoluntaryLeave();
  state.roomCode = null;
  state.myName = null;
  state.gameState = null;
  state.hasSubmitted = false;
  state.lastResolveData = null;
  sessionStorage.removeItem('heatsync_session');
  // Clear the ?room= query param from the browser URL
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.pathname);
  showLandingView('home');
  showScreen('screen-landing');
  if (clearMessage) showError('landing-error', clearMessage);
}

/* ── Landing screen ──────────────────────────────────────────────────────── */
function setupLanding() {
  const savedName = localStorage.getItem('heatsync_name');
  if (savedName) {
    document.getElementById('create-name').value = savedName;
    document.getElementById('join-name').value = savedName;
  }

  // Pre-fill join form if ?room= is in the URL
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
    state.socket.emit('create_room', { playerName: name, password: password || null, preferredCode, icon: state.playerIcon, homeTurf: state.playerTurf });
  });

  // Join room (password only after server says room is protected)
  document.getElementById('btn-join').addEventListener('click', () => {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const pwdStep = document.getElementById('join-password-step');
    const passwordVisible = pwdStep && !pwdStep.classList.contains('hidden');
    const password = document.getElementById('join-password').value.trim();
    if (!name) { showError('join-error', 'Enter your name'); return; }
    if (!code)  { showError('join-error', 'Enter the code'); return; }
    if (passwordVisible && !password) { showError('join-error', 'Enter the password'); return; }
    const payload = { roomCode: code, playerName: name, icon: state.playerIcon, homeTurf: state.playerTurf };
    if (passwordVisible) { payload.password = password; payload.passwordRetry = true; }
    state.socket.emit('join_room', payload);
  });

  // Enter-key shortcuts
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

/* ── In-game leave/copy buttons ──────────────────────────────────────────── */
function setupGameLeaveButtons() {
  initLeaveConfirmModal();
  document.querySelectorAll('.btn-leave-game').forEach(btn => {
    btn.addEventListener('click', openLeaveConfirmModal);
  });

  // In-game code badge — click to copy invite URL (falls back to code only)
  document.querySelectorAll('.ingame-code-badge').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = state.roomCode;
      if (!code) return;
      const url = `${location.origin}${location.pathname}?room=${code}`;
      const orig = btn.textContent;
      const markCopied = () => {
        btn.classList.add('room-code--copied');
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.classList.remove('room-code--copied'); btn.textContent = orig; }, 1500);
      };
      navigator.clipboard.writeText(url).then(markCopied)
        .catch(() => navigator.clipboard.writeText(code).then(markCopied).catch(() => {}));
    });
  });
}

/* ── Reconnect banner (browser socket.io) ────────────────────────────────── */
function initReconnectBanner() {
  const saved = sessionStorage.getItem('heatsync_session');
  if (!saved) return;
  try {
    const { roomCode, playerName } = JSON.parse(saved);
    if (!roomCode || !playerName) return;

    const banner = document.getElementById('reconnect-banner');
    if (!banner) return;

    document.getElementById('reconnect-code').textContent = roomCode;
    document.getElementById('reconnect-name').textContent = playerName;
    banner.classList.remove('hidden');
    state.reconnectBannerPending = true;

    document.getElementById('btn-reconnect-yes').addEventListener('click', () => {
      banner.classList.add('hidden');
      state.reconnectBannerPending = false;
      state.myName = playerName;
      state.roomCode = roomCode;
      // Socket may already be connected — emit directly; otherwise the connect handler fires
      if (state.socket?.connected) {
        state.socket.emit('join_room', { roomCode, playerName });
      }
    }, { once: true });

    document.getElementById('btn-reconnect-no').addEventListener('click', () => {
      banner.classList.add('hidden');
      state.reconnectBannerPending = false;
      sessionStorage.removeItem('heatsync_session');
    }, { once: true });
  } catch (_) {}
}

/* ── Socket.io transport ─────────────────────────────────────────────────── */
function initSocket() {
  state.socket = io();

  state.socket.on('connect', () => {
    // Wait if user is still deciding on the reconnect banner
    if (state.reconnectBannerPending) return;
    // Attempt mid-session reconnect if we have a saved session
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

  setupSocketHandlers(state.socket, {
    // Browser: emit join_room immediately on self-disconnect so socket.io reconnects us.
    onPlayerLeftSelf: (socket) => socket.emit('join_room', { roomCode: state.roomCode, playerName: state.myName }),
  });
}

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initHeatsyncLogos();
  mountRoundTracks();
  initReconnectBanner();
  initSocket();
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
