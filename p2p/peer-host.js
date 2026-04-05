'use strict';
// P2P Host — runs game logic locally, accepts WebRTC connections from peers.
// PeerJS is loaded via <script> tag in electron-app/index.html as window.Peer.

const EventEmitter = require('events');
const {
  ZONES, CHARS, PLAYER_ICONS, aggregateZones, classifyZones, zoneDelta, validateAllocation, determineWinners,
} = require('../lib/gameLogic');
const SAVED_STATE_KEY = 'heatsync_host_state';
const STATE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

function genCode() {
  return Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
}

function createPlayer(peerId, name, icon, homeTurf = 'docks') {
  return { peerId, name, resources: 1, heat: 0, connected: true, icon: icon || '♠', homeTurf };
}

// ─── P2PHost ─────────────────────────────────────────────────────────────────

class P2PHost extends EventEmitter {
  constructor() {
    super();
    this.peer = null;
    this.code = null;
    this.room = null;
    this.localPlayerName = null;
    // peer players only (not host)
    this.connToName = new Map(); // DataConnection → playerName
    this.nameToConn = new Map(); // playerName → DataConnection
  }

  // ─── Send helpers ────────────────────────────────────────────────────────

  _sendToConn(conn, event, data) {
    try { conn.send(JSON.stringify({ event, data })); } catch (_) {}
  }

  sendTo(conn, event, data) {
    if (!conn) this.emit(event, data);
    else this._sendToConn(conn, event, data);
  }

  sendToName(name, event, data) {
    if (name === this.localPlayerName) {
      this.emit(event, data);
    } else {
      const conn = this.nameToConn.get(name);
      if (conn) this._sendToConn(conn, event, data);
    }
  }

  broadcast(event, data) {
    for (const conn of this.nameToConn.values()) {
      this._sendToConn(conn, event, data);
    }
    this.emit(event, data); // host itself
  }

  // ─── Player lookup ───────────────────────────────────────────────────────

  getPlayerByConn(conn) {
    if (!conn) return this.room?.players.get(this.localPlayerName) ?? null;
    const name = this.connToName.get(conn);
    return name ? (this.room?.players.get(name) ?? null) : null;
  }

  sendError(conn, message) { this.sendTo(conn, 'error', { message }); }

  // ─── State persistence ───────────────────────────────────────────────────

  saveState() {
    if (!this.room) return;
    const r = this.room;
    const saved = {
      code: r.code,
      phase: r.phase,
      round: r.round,
      hostName: r.hostName,
      // password intentionally omitted — not safe to persist plaintext to localStorage
      timerEnabled: r.timerEnabled,
      timerDuration: r.timerDuration,
      homeTurfEnabled: r.homeTurfEnabled,
      crewRecoveryCostEnabled: r.crewRecoveryCostEnabled,
      players: [...r.players.entries()].map(([n, p]) => [n, {
        name: p.name, resources: p.resources, heat: p.heat, icon: p.icon, homeTurf: p.homeTurf,
      }]),
      pendingAllocations: [...r.pendingAllocations.entries()],
      readyPlayers: [...r.readyPlayers],
      lastResolveData: r.lastResolveData,
      lastWinners: r.lastWinners || null,
      savedAt: Date.now(),
    };
    try { localStorage.setItem(SAVED_STATE_KEY, JSON.stringify(saved)); } catch (_) {}
  }

  clearSavedState() {
    try { localStorage.removeItem(SAVED_STATE_KEY); } catch (_) {}
  }

  // ─── Public state ────────────────────────────────────────────────────────

  getPublicState() {
    const r = this.room;
    const state = {
      code: r.code, phase: r.phase, round: r.round, hostName: r.hostName,
      timerEnabled: r.timerEnabled, timerDuration: r.timerDuration,
      homeTurfEnabled: r.homeTurfEnabled,
      crewRecoveryCostEnabled: r.crewRecoveryCostEnabled,
      players: [...r.players.values()].map(p => ({
        name: p.name, resources: p.resources, heat: p.heat, connected: p.connected,
        icon: p.icon, homeTurf: p.homeTurf,
      })),
    };
    if (r.phase === 'allocation') {
      state.allocationProgress = {
        submittedCount: r.pendingAllocations.size,
        totalCount: [...r.players.values()].filter(p => p.connected !== false).length,
      };
      if (r.timerEnabled && r.timerEndAt) state.timerEndAt = r.timerEndAt;
    }
    if (r.phase === 'discussion') {
      state.readyProgress = {
        readyCount: r.readyPlayers.size,
        totalCount: [...r.players.values()].filter(p => p.connected !== false).length,
        readyNames: [...r.readyPlayers],
      };
    }
    return state;
  }

  // ─── Room helpers ────────────────────────────────────────────────────────

  transferHostIfNeeded(departedName) {
    const r = this.room;
    if (r.hostName !== departedName || r.players.size === 0) return;
    const next = [...r.players.values()].find(p => p.connected) || [...r.players.values()][0];
    if (next) r.hostName = next.name;
  }

  afterPlayerRemoved(removedName) {
    const r = this.room;
    r.pendingAllocations.delete(removedName);
    r.readyPlayers.delete(removedName);
    // transferHostIfNeeded is NOT called here — callers must do so only when the
    // player is fully deleted from r.players, so a disconnected host can reclaim
    // their role on reconnect.
    if (r.players.size === 0) { this.clearSavedState(); this.room = null; return; }

    if (r.phase === 'discussion') {
      const connected = [...r.players.values()].filter(p => p.connected).length;
      if (connected > 0 && r.readyPlayers.size >= connected) {
        r.phase = 'allocation';
        r.readyPlayers.clear();
        this.broadcast('phase_changed', { phase: 'allocation', state: this.getPublicState() });
        this.startAllocationTimer();
      }
      return;
    }
    if (r.phase === 'allocation') this.resolveAllIfReady();
  }

  // ─── Game logic ──────────────────────────────────────────────────────────

  resolveRound() {
    const r = this.room;
    const totals = aggregateZones(r.pendingAllocations);
    const classification = classifyZones(totals);
    const playerResults = [];

    for (const [name, alloc] of r.pendingAllocations) {
      const player = r.players.get(name);
      if (!player) continue;
      let totalDelta = 0, crewOnlyTiedHighest = 0;
      const zoneResults = [];

      for (const zone of ZONES) {
        const { crew, resources: res } = alloc[zone];
        if (crew === 0 && res === 0) continue;
        const role = classification.roles[zone];
        const isHomeTurf = r.homeTurfEnabled && zone === player.homeTurf;
        const delta = zoneDelta(crew, res, role, classification.outcome, isHomeTurf, r.crewRecoveryCostEnabled !== false);
        totalDelta += delta;
        if (role === 'tied_highest' && res === 0) crewOnlyTiedHighest++;
        const outcomeLabel = classification.outcome === 'all_tied'
          ? ((crew + res >= 2) ? 'crackdown' : 'safe')
          : role;
        zoneResults.push({ zone, sent: { crew, resources: res }, outcome: outcomeLabel, delta });
      }

      const beforeRes = player.resources;
      const afterMain = Math.max(0, beforeRes + totalDelta);
      const crewPenalty = (r.crewRecoveryCostEnabled !== false)
        ? Math.min(crewOnlyTiedHighest, afterMain) : 0;
      player.resources = afterMain - crewPenalty;
      totalDelta = player.resources - beforeRes;
      playerResults.push({ name, zoneResults, totalDelta, newResources: player.resources, newHeat: player.heat });
    }

    const heatPenalties = [];
    if (r.round < 4) {
      for (const player of r.players.values()) {
        if (player.resources === 0) {
          player.heat += 1;
          heatPenalties.push({ name: player.name, heat: player.heat });
          const res = playerResults.find(pr => pr.name === player.name);
          if (res) res.newHeat = player.heat;
        }
      }
    }

    const standings = [...r.players.values()]
      .map(p => ({ name: p.name, resources: p.resources, heat: p.heat }))
      .sort((a, b) => b.resources - a.resources || a.heat - b.heat);

    const resolveData = {
      round: r.round, zoneTotals: totals, classification,
      playerResults, heatPenalties, standings,
    };

    r.pendingAllocations.clear();
    r.readyPlayers.clear();
    r.lastResolveData = resolveData;

    if (r.round >= 4) {
      r.phase = 'end';
      const winners = determineWinners([...r.players.values()]);
      r.lastWinners = winners;
      this.clearSavedState();
      return { resolveData, gameOver: true, winners };
    }
    r.round += 1;
    r.phase = 'discussion';
    this.saveState();
    return { resolveData, gameOver: false, winners: null };
  }

  resolveAllIfReady() {
    const r = this.room;
    if (!r) return;
    const connected = [...r.players.values()].filter(p => p.connected).length;
    if (connected > 0 && r.pendingAllocations.size >= connected) {
      r.phase = 'reveal';
      this.clearRoomTimer();
      const { resolveData, gameOver, winners } = this.resolveRound();
      if (gameOver) this.broadcast('game_over', { resolveData, winners, state: this.getPublicState() });
      else this.broadcast('round_resolved', { resolveData, state: this.getPublicState() });
    }
  }

  // ─── Timer ───────────────────────────────────────────────────────────────

  makeAutoAllocation(player) {
    const shuffled = [...ZONES].sort(() => Math.random() - 0.5);
    const [z1, z2, z3] = shuffled;
    const res = player.resources;
    const alloc = {};
    alloc[z1] = { crew: 1, resources: Math.ceil(res / 2) };
    alloc[z2] = { crew: 1, resources: Math.floor(res / 2) };
    alloc[z3] = { crew: 0, resources: 0 };
    return alloc;
  }

  clearRoomTimer() {
    const r = this.room;
    if (!r) return;
    if (r.timerHandle) { clearTimeout(r.timerHandle); r.timerHandle = null; }
    r.timerEndAt = null;
  }

  startAllocationTimer() {
    const r = this.room;
    this.clearRoomTimer();
    if (!r.timerEnabled) return;
    r.timerEndAt = Date.now() + r.timerDuration * 1000;
    this.broadcast('timer_start', { endsAt: r.timerEndAt });
    r.timerHandle = setTimeout(() => {
      if (r.phase !== 'allocation') return;
      for (const player of r.players.values()) {
        if (player.connected && !r.pendingAllocations.has(player.name)) {
          r.pendingAllocations.set(player.name, this.makeAutoAllocation(player));
        }
      }
      this.broadcast('timer_expired', {});
      this.resolveAllIfReady();
    }, r.timerDuration * 1000);
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  handleEvent(conn, event, data) {
    switch (event) {
      case 'create_room':       this.onCreateRoom(conn, data); break;
      case 'join_room':         this.onJoinRoom(conn, data); break;
      case 'start_game':        this.onStartGame(conn, data); break;
      case 'set_timer':         this.onSetTimer(conn, data); break;
      case 'ready_for_next':    this.onReadyForNext(conn, data); break;
      case 'submit_allocation': this.onSubmitAllocation(conn, data); break;
      case 'kick_player':       this.onKickPlayer(conn, data); break;
      case 'leave_room':        this.onLeaveRoom(conn, data); break;
      case 'play_again':        this.onPlayAgain(conn, data); break;
      case 'end_game_to_lobby': this.onEndGameToLobby(conn, data); break;
      case 'set_icon':              this.onSetIcon(conn, data); break;
      case 'set_turf':              this.onSetTurf(conn, data); break;
      case 'set_home_turf_enabled':    this.onSetHomeTurfEnabled(conn, data); break;
      case 'set_crew_recovery_cost':   this.onSetCrewRecoveryCost(conn, data); break;
    }
  }

  onCreateRoom(conn, { playerName, password, preferredCode, icon, homeTurf } = {}) {
    const name = (playerName || '').trim().slice(0, 20);
    if (!name) { this.sendError(conn, 'Name required'); return; }
    this.localPlayerName = name;
    this.room = {
      code: this.code, phase: 'lobby', round: 1, hostName: name,
      password: (password || '').trim() || null,
      players: new Map(), pendingAllocations: new Map(),
      readyPlayers: new Set(), lastResolveData: null,
      timerEnabled: false, timerDuration: 180, timerHandle: null, timerEndAt: null,
      homeTurfEnabled: false, crewRecoveryCostEnabled: true,
    };
    const assignedIcon = PLAYER_ICONS.includes(icon) ? icon : PLAYER_ICONS[0];
    this.room.players.set(name, createPlayer(null, name, assignedIcon, homeTurf || 'docks'));
    this.emit('room_joined', { roomCode: this.code, myName: name, state: this.getPublicState() });
  }

  onJoinRoom(conn, { roomCode, playerName, password, passwordRetry, icon, homeTurf } = {}) {
    const r = this.room;
    const name = (playerName || '').trim().slice(0, 20);
    if (!name) { this.sendError(conn, 'Name required'); return; }
    if (!r) { this.sendError(conn, 'Room not found'); return; }

    const existing = r.players.get(name);
    if (existing) {
      if (existing && existing.connected) {
        this.sendError(conn, 'That name is already in use.');
        return;
      }
      // Reconnect: update connection mapping
      if (existing.peerId) {
        const oldConn = this.nameToConn.get(name);
        if (oldConn) { this.connToName.delete(oldConn); this.nameToConn.delete(name); }
      }
      if (conn) {
        existing.peerId = conn.peer;
        existing.connected = true;
        this.connToName.set(conn, name);
        this.nameToConn.set(name, conn);
      }
      const hasSubmitted = r.pendingAllocations.has(name);
      this.sendTo(conn, 'reconnected', {
        myName: name, state: this.getPublicState(),
        hasSubmitted, lastResolveData: r.lastResolveData,
        lastWinners: r.lastWinners || null,
      });
      this.broadcast('player_joined', { name, state: this.getPublicState() });
      return;
    }

    if (r.phase !== 'lobby') { this.sendError(conn, 'Game already in progress'); return; }
    if (r.players.size >= 6) { this.sendError(conn, 'Room is full (max 6)'); return; }
    if (r.password) {
      if (!passwordRetry) { this.sendTo(conn, 'password_required', { roomCode: r.code }); return; }
      if ((password || '').trim() !== r.password) { this.sendError(conn, 'Incorrect password'); return; }
    }

    const takenIcons = [...r.players.values()].map(p => p.icon);
    const assignedIcon2 = (PLAYER_ICONS.includes(icon) && !takenIcons.includes(icon))
      ? icon
      : PLAYER_ICONS.find(i => !takenIcons.includes(i)) || PLAYER_ICONS[0];
    r.players.set(name, createPlayer(conn?.peer ?? null, name, assignedIcon2, homeTurf || 'docks'));
    if (conn) { this.connToName.set(conn, name); this.nameToConn.set(name, conn); }
    this.sendTo(conn, 'room_joined', { roomCode: r.code, myName: name, state: this.getPublicState() });
    this.broadcast('player_joined', { name, state: this.getPublicState() });
    this.saveState();
  }

  onStartGame(conn, { roomCode } = {}) {
    const r = this.room;
    if (!r) return;
    const player = this.getPlayerByConn(conn);
    if (player?.name !== r.hostName) { this.sendError(conn, 'Only the host can start'); return; }
    if (r.players.size < 3) { this.sendError(conn, 'Need at least 3 players'); return; }
    r.readyPlayers.clear();

    // Randomize home turf assignments when the setting is enabled
    if (r.homeTurfEnabled) {
      const players = [...r.players.values()];
      const shuffled = [...ZONES].sort(() => Math.random() - 0.5);
      players.forEach((p, i) => { p.homeTurf = shuffled[i % shuffled.length]; });
    }

    r.phase = 'allocation';
    this.broadcast('phase_changed', { phase: 'allocation', state: this.getPublicState() });
    this.startAllocationTimer();
    this.saveState();
  }

  onSetTimer(conn, { enabled, duration } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'lobby') return;
    const player = this.getPlayerByConn(conn);
    if (player?.name !== r.hostName) return;
    if (typeof enabled === 'boolean') r.timerEnabled = enabled;
    if (typeof duration === 'number') {
      r.timerDuration = Math.min(300, Math.max(60, Math.round(duration / 30) * 30));
    }
    this.broadcast('timer_settings_changed', { timerEnabled: r.timerEnabled, timerDuration: r.timerDuration });
    this.saveState();
  }

  onReadyForNext(conn, { roomCode } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'discussion') return;
    const player = this.getPlayerByConn(conn);
    if (!player) return;
    r.readyPlayers.add(player.name);
    const readyCount = r.readyPlayers.size;
    const connectedCount = [...r.players.values()].filter(p => p.connected).length;
    this.broadcast('player_ready', { name: player.name, readyCount, totalCount: connectedCount });
    if (readyCount >= connectedCount) {
      r.phase = 'allocation';
      r.readyPlayers.clear();
      this.broadcast('phase_changed', { phase: 'allocation', state: this.getPublicState() });
      this.startAllocationTimer();
      this.saveState();
    }
  }

  onSubmitAllocation(conn, { roomCode, allocation } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'allocation') return;
    const player = this.getPlayerByConn(conn);
    if (!player) return;
    if (r.pendingAllocations.has(player.name)) { this.sendError(conn, 'Already submitted this round'); return; }
    const err = validateAllocation(allocation, player);
    if (err) { this.sendError(conn, err); return; }
    r.pendingAllocations.set(player.name, allocation);
    const submittedCount = r.pendingAllocations.size;
    const connectedCount = [...r.players.values()].filter(p => p.connected).length;
    this.broadcast('allocation_received', { submittedCount, totalCount: connectedCount });
    if (submittedCount >= connectedCount) {
      r.phase = 'reveal';
      this.clearRoomTimer();
      const { resolveData, gameOver, winners } = this.resolveRound();
      if (gameOver) this.broadcast('game_over', { resolveData, winners, state: this.getPublicState() });
      else this.broadcast('round_resolved', { resolveData, state: this.getPublicState() });
    }
  }

  onKickPlayer(conn, { playerName } = {}) {
    const r = this.room;
    if (!r) return;
    const requester = this.getPlayerByConn(conn);
    if (requester?.name !== r.hostName) return;
    if (playerName === r.hostName) return;
    const target = r.players.get(playerName);
    if (!target) return;
    this.sendToName(playerName, 'kicked', { message: 'You were removed by the host' });
    r.players.delete(playerName);
    this.transferHostIfNeeded(playerName);
    const targetConn = this.nameToConn.get(playerName);
    if (targetConn) {
      this.connToName.delete(targetConn);
      this.nameToConn.delete(playerName);
      setTimeout(() => targetConn.close(), 50);
    }
    this.afterPlayerRemoved(playerName);
    if (this.room) {
      this.broadcast('player_left', { name: playerName, state: this.getPublicState() });
      this.saveState();
    }
  }

  onLeaveRoom(conn, { roomCode } = {}) {
    const r = this.room;
    if (!r) { this.sendTo(conn, 'left_room', {}); return; }
    const player = this.getPlayerByConn(conn);
    if (!player) { this.sendTo(conn, 'left_room', {}); return; }
    const name = player.name;

    if (r.phase !== 'lobby') {
      player.connected = false;
      if (conn) { this.connToName.delete(conn); this.nameToConn.delete(name); }
      this.broadcast('player_left', { name, state: this.getPublicState() });
      this.sendTo(conn, 'left_room', {});
      this.afterPlayerRemoved(name);
      if (this.room) this.saveState();
      return;
    }

    r.players.delete(name);
    this.transferHostIfNeeded(name);
    if (conn) { this.connToName.delete(conn); this.nameToConn.delete(name); }
    this.afterPlayerRemoved(name);
    if (!this.room) { this.sendTo(conn, 'left_room', {}); return; }
    this.broadcast('player_left', { name, state: this.getPublicState() });
    this.sendTo(conn, 'left_room', {});
    if (this.room) this.saveState();
  }

  resetRoomToLobby() {
    const r = this.room;
    this.clearRoomTimer();
    r.round = 1; r.phase = 'lobby';
    r.pendingAllocations.clear(); r.readyPlayers.clear(); r.lastResolveData = null;
    for (const p of r.players.values()) { p.resources = 1; p.heat = 0; }
  }

  onPlayAgain(conn, { roomCode } = {}) {
    const r = this.room;
    if (!r) return;
    const player = this.getPlayerByConn(conn);
    if (player?.name !== r.hostName) return;
    this.resetRoomToLobby();
    this.broadcast('game_reset', { state: this.getPublicState() });
    this.saveState();
  }

  onSetIcon(conn, { icon } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'lobby') return;
    const player = this.getPlayerByConn(conn);
    if (!player) return;
    if (!PLAYER_ICONS.includes(icon)) return;
    const taken = [...r.players.values()].some(p => p.name !== player.name && p.icon === icon);
    if (taken) { this.sendTo(conn, 'icon_taken', {}); return; }
    player.icon = icon;
    this.broadcast('lobby_update', { state: this.getPublicState() });
  }

  onSetTurf(conn, { homeTurf } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'lobby') return;
    const player = this.getPlayerByConn(conn);
    if (!player) return;
    if (!['docks', 'strip', 'slums'].includes(homeTurf)) return;
    player.homeTurf = homeTurf;
    this.broadcast('lobby_update', { state: this.getPublicState() });
  }

  onSetHomeTurfEnabled(conn, { enabled } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'lobby') return;
    const player = this.getPlayerByConn(conn);
    if (player?.name !== r.hostName) return;
    r.homeTurfEnabled = !!enabled;
    this.broadcast('home_turf_setting_changed', { homeTurfEnabled: r.homeTurfEnabled });
    this.saveState();
  }

  onSetCrewRecoveryCost(conn, { enabled } = {}) {
    const r = this.room;
    if (!r || r.phase !== 'lobby') return;
    const player = this.getPlayerByConn(conn);
    if (player?.name !== r.hostName) return;
    r.crewRecoveryCostEnabled = !!enabled;
    this.broadcast('crew_recovery_cost_changed', { crewRecoveryCostEnabled: r.crewRecoveryCostEnabled });
    this.saveState();
  }

  onEndGameToLobby(conn, { roomCode } = {}) {
    const r = this.room;
    if (!r) return;
    const player = this.getPlayerByConn(conn);
    if (player?.name !== r.hostName) return;
    if (r.phase === 'lobby') return;
    this.resetRoomToLobby();
    this.broadcast('game_reset', { state: this.getPublicState() });
    this.saveState();
  }

  // ─── Incoming connection management ──────────────────────────────────────

  onConnection(conn) {
    conn.on('data', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.handleEvent(conn, msg.event, msg.data);
    });

    conn.on('close', () => {
      const name = this.connToName.get(conn);
      if (!name || !this.room) return;
      this.connToName.delete(conn);
      this.nameToConn.delete(name);
      const player = this.room.players.get(name);
      if (player) {
        if (this.room.phase === 'lobby') {
          // In the lobby, free the seat immediately — same as onLeaveRoom lobby path.
          this.room.players.delete(name);
          this.transferHostIfNeeded(name);
        } else {
          // In an active game, keep the seat for reconnect.
          player.connected = false;
        }
        this.broadcast('player_left', { name, state: this.getPublicState() });
        this.afterPlayerRemoved(name);
        if (this.room) this.saveState();
      }
    });

    conn.on('error', () => { try { conn.close(); } catch (_) {} });
  }

  // ─── PeerJS init ──────────────────────────────────────────────────────────

  tryOpenPeer(id) {
    const PeerClass = (typeof window !== 'undefined' && window.Peer) ? window.Peer : require('peerjs').Peer;
    return new Promise((resolve, reject) => {
      const peer = new PeerClass(id);
      peer.on('open', () => resolve(peer));
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          peer.destroy();
          resolve(this.tryOpenPeer(genCode()));
        } else {
          reject(new Error(err.type + ': ' + (err.message || 'PeerJS error')));
        }
      });
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function startHost(playerName, preferredCode) {
  const host = new P2PHost();
  const code = (preferredCode && preferredCode.length === 4) ? preferredCode : genCode();
  host.peer = await host.tryOpenPeer(code);
  host.code = host.peer.id;
  host.peer.on('connection', (conn) => host.onConnection(conn));
  const socket = makeHostSocket(host);
  return { roomCode: host.code, socket };
}

async function resumeHost(savedCode, savedState) {
  const host = new P2PHost();
  host.peer = await host.tryOpenPeer(savedCode);
  host.code = host.peer.id;
  host.localPlayerName = savedState.hostName;

  host.room = {
    code: savedState.code,
    phase: 'lobby',   // reset to lobby so peers can rejoin before resuming
    round: savedState.round,
    hostName: savedState.hostName,
    password: savedState.password || null,
    players: new Map(savedState.players.map(([n, p]) => [n, {
      ...p, peerId: null, connected: n === savedState.hostName,
      icon: p.icon || '♠', homeTurf: p.homeTurf || 'docks',
    }])),
    pendingAllocations: new Map(savedState.pendingAllocations || []),
    readyPlayers: new Set(savedState.readyPlayers || []),
    lastResolveData: savedState.lastResolveData || null,
    lastWinners: savedState.lastWinners || null,
    timerEnabled: savedState.timerEnabled || false,
    timerDuration: savedState.timerDuration || 180,
    timerHandle: null,
    timerEndAt: null,
    homeTurfEnabled: savedState.homeTurfEnabled || false,
    crewRecoveryCostEnabled: savedState.crewRecoveryCostEnabled !== false,
  };

  host.peer.on('connection', (conn) => host.onConnection(conn));
  const socket = makeHostSocket(host);
  return { roomCode: host.code, socket };
}

function makeHostSocket(host) {
  return {
    on(event, cb) { host.on(event, cb); return this; },
    off(event, cb) { host.off(event, cb); return this; },
    emit(event, data) { host.handleEvent(null, event, data); },
    destroy() {
      if (host.room && host.room.timerHandle) {
        clearTimeout(host.room.timerHandle);
        host.room.timerHandle = null;
      }
      for (const conn of host.nameToConn.values()) {
        try { conn.close(); } catch (_) {}
      }
      if (host.peer && !host.peer.destroyed) {
        try { host.peer.destroy(); } catch (_) {}
      }
      host.removeAllListeners();
    },
    get connected() { return host.peer && !host.peer.destroyed; },
    get id() { return host.peer?.id; },
  };
}

function getSavedHostState() {
  try {
    const raw = localStorage.getItem(SAVED_STATE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved.savedAt || Date.now() - saved.savedAt > STATE_MAX_AGE_MS) {
      localStorage.removeItem(SAVED_STATE_KEY);
      return null;
    }
    return saved;
  } catch { return null; }
}

module.exports = { startHost, resumeHost, getSavedHostState };
