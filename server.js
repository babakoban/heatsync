const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { ZONES, ZONE_TURF, PLAYER_ICONS, aggregateZones, classifyZones, zoneDelta, validateAllocation, determineWinners } = require('./lib/gameLogic');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory state ────────────────────────────────────────────────────────

const rooms = new Map(); // roomCode -> Room

// Room shape:
// {
//   code, phase, round, hostName,
//   players: Map<name, Player>,
//   pendingAllocations: Map<name, ZoneAllocation>,
//   readyPlayers: Set<name>,
//   lastResolveData: object | null,
// }
//
// Player shape:
// { socketId, name, resources, heat, connected }
//
// ZoneAllocation shape:
// { east: { crew, resources }, west: { crew, resources }, downtown: { crew, resources } }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_CODE_RE = /^[A-Z2-9]{4}$/;

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createPlayer(socketId, name, icon, homeTurf = 'docks') {
  return { socketId, name, resources: 1, heat: 0, connected: true, icon: icon || '♠', homeTurf };
}

function findPlayerBySocket(room, socketId) {
  for (const player of room.players.values()) {
    if (player.socketId === socketId) return player;
  }
  return null;
}

function transferHostIfNeeded(room, departedName) {
  if (room.hostName !== departedName || room.players.size === 0) return;
  const next =
    [...room.players.values()].find((p) => p.connected) ||
    [...room.players.values()][0];
  if (next) room.hostName = next.name;
}

/**
 * Called after a player leaves or disconnects. Cleans up pending maps and
 * auto-advances the phase if everyone remaining has acted.
 * NOTE: does NOT call transferHostIfNeeded — callers must do that themselves
 * only when the player has been fully deleted from room.players (not merely
 * marked disconnected), so a disconnected host can still reclaim their role
 * on reconnect.
 */
function afterPlayerRemoved(room, code, removedName) {
  room.pendingAllocations.delete(removedName);
  room.readyPlayers.delete(removedName);

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.phase === 'discussion') {
    const connected = [...room.players.values()].filter(p => p.connected).length;
    if (connected > 0 && room.readyPlayers.size >= connected) {
      room.phase = 'allocation';
      room.readyPlayers.clear();
      io.to(code).emit('phase_changed', { phase: 'allocation', state: getPublicState(room) });
    }
    return;
  }

  if (room.phase === 'allocation') {
    const connected = [...room.players.values()].filter(p => p.connected).length;
    const submitted = room.pendingAllocations.size;
    if (connected > 0 && submitted >= connected) {
      room.phase = 'reveal';
      const { resolveData, gameOver, winners } = resolveRound(room);
      if (gameOver) {
        io.to(code).emit('game_over', { resolveData, winners, state: getPublicState(room) });
      } else {
        io.to(code).emit('round_resolved', { resolveData, state: getPublicState(room) });
      }
    }
  }
}

function getPublicState(room) {
  const state = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostName: room.hostName,
    timerEnabled: room.timerEnabled,
    timerDuration: room.timerDuration,
    homeTurfEnabled: room.homeTurfEnabled,
    crewRecoveryCostEnabled: room.crewRecoveryCostEnabled,
    players: [...room.players.values()].map(p => ({
      name: p.name,
      resources: p.resources,
      heat: p.heat,
      connected: p.connected,
      icon: p.icon,
      homeTurf: p.homeTurf,
    })),
  };
  if (room.phase === 'allocation') {
    state.allocationProgress = {
      submittedCount: room.pendingAllocations.size,
      totalCount: [...room.players.values()].filter(p => p.connected !== false).length,
    };
    if (room.timerEnabled && room.timerEndAt) {
      state.timerEndAt = room.timerEndAt;
    }
  }
  if (room.phase === 'discussion') {
    state.readyProgress = {
      readyCount: room.readyPlayers.size,
      totalCount: [...room.players.values()].filter(p => p.connected !== false).length,
      readyNames: [...room.readyPlayers],
    };
  }
  return state;
}

// ─── Game Logic ───────────────────────────────────────────────────────────────

function resolveRound(room) {
  const totals = aggregateZones(room.pendingAllocations);
  const classification = classifyZones(totals);
  const playerResults = [];

  // Apply zone outcomes to each player
  for (const [name, alloc] of room.pendingAllocations) {
    const player = room.players.get(name);
    if (!player) continue;

    let totalDelta = 0;
    let crewOnlyTiedHighest = 0;
    const zoneResults = [];

    for (const zone of ZONES) {
      const { crew, resources: res } = alloc[zone];
      if (crew === 0 && res === 0) continue; // player didn't go here

      const role = classification.roles[zone];
      const isHomeTurf = room.homeTurfEnabled && ZONE_TURF[zone] === player.homeTurf;
      const delta = zoneDelta(crew, res, role, classification.outcome, isHomeTurf);
      totalDelta += delta;

      // Crew-only tied_highest: floor(1/2)=0 means crew is lost — charge 1 Ⓡ after all other deltas
      if (role === 'tied_highest' && res === 0) crewOnlyTiedHighest++;

      let outcomeLabel;
      if (classification.outcome === 'all_tied') {
        outcomeLabel = (crew + res >= 2) ? 'crackdown' : 'safe';
      } else {
        outcomeLabel = role; // e.g. 'highest', 'middle', 'lowest', etc.
      }

      zoneResults.push({ zone, sent: { crew, resources: res }, outcome: outcomeLabel, delta });
    }

    // Apply main delta first, then crew recovery penalty (only if setting enabled)
    const beforeResources = player.resources;
    const afterMain = Math.max(0, beforeResources + totalDelta);
    const crewPenalty = (room.crewRecoveryCostEnabled !== false)
      ? Math.min(crewOnlyTiedHighest, afterMain) : 0;
    player.resources = afterMain - crewPenalty;
    totalDelta = player.resources - beforeResources; // actual net change for display
    playerResults.push({ name, zoneResults, totalDelta, newResources: player.resources, newHeat: player.heat });
  }

  // Heat penalty: applies between rounds — players at 0 resources gain 1 heat.
  // At this point room.round is still the round that just resolved (1–4).
  // We skip round 4 because the game ends immediately after; there is no
  // next round for the penalty to matter, and determineWinners uses the
  // final resource counts directly.
  const heatPenalties = [];
  if (room.round < 4) {
    for (const player of room.players.values()) {
      if (player.resources === 0) {
        player.heat += 1;
        heatPenalties.push({ name: player.name, heat: player.heat });
        // Update newHeat in playerResults
        const result = playerResults.find(r => r.name === player.name);
        if (result) result.newHeat = player.heat;
      }
    }
  }

  // Build standings
  const standings = [...room.players.values()]
    .map(p => ({ name: p.name, resources: p.resources, heat: p.heat }))
    .sort((a, b) => b.resources - a.resources || a.heat - b.heat);

  const resolveData = {
    round: room.round,
    zoneTotals: totals,
    classification,
    playerResults,
    heatPenalties,
    standings,
  };

  // Clear for next round
  room.pendingAllocations.clear();
  room.readyPlayers.clear();
  room.lastResolveData = resolveData;

  if (room.round >= 4) {
    room.phase = 'end';
    const winners = determineWinners([...room.players.values()]);
    room.lastWinners = winners;
    return { resolveData, gameOver: true, winners };
  }

  room.round += 1;
  room.phase = 'discussion';
  return { resolveData, gameOver: false, winners: null };
}

// ─── Timer helpers ────────────────────────────────────────────────────────────

function makeAutoAllocation(player) {
  // Randomly pick 2 of the 3 zones, then split resources as evenly as possible
  const shuffled = [...ZONES].sort(() => Math.random() - 0.5);
  const [z1, z2, z3] = shuffled;
  const res = player.resources;
  const half1 = Math.ceil(res / 2);
  const half2 = Math.floor(res / 2);
  const alloc = {};
  alloc[z1] = { crew: 1, resources: half1 };
  alloc[z2] = { crew: 1, resources: half2 };
  alloc[z3] = { crew: 0, resources: 0 };
  return alloc;
}

function resolveAllIfReady(room, code) {
  const connectedCount = [...room.players.values()].filter(p => p.connected).length;
  if (room.pendingAllocations.size >= connectedCount) {
    room.phase = 'reveal';
    clearRoomTimer(room);
    const { resolveData, gameOver, winners } = resolveRound(room);
    if (gameOver) {
      io.to(code).emit('game_over', { resolveData, winners, state: getPublicState(room) });
    } else {
      io.to(code).emit('round_resolved', { resolveData, state: getPublicState(room) });
    }
  }
}

function clearRoomTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
  room.timerEndAt = null;
}

function startAllocationTimer(room, code) {
  clearRoomTimer(room);
  if (!room.timerEnabled) return;

  room.timerEndAt = Date.now() + room.timerDuration * 1000;
  io.to(code).emit('timer_start', { endsAt: room.timerEndAt });

  room.timerHandle = setTimeout(() => {
    if (room.phase !== 'allocation') return;
    // Auto-submit for any connected player who hasn't submitted yet
    for (const player of room.players.values()) {
      if (player.connected && !room.pendingAllocations.has(player.name)) {
        room.pendingAllocations.set(player.name, makeAutoAllocation(player));
      }
    }
    io.to(code).emit('timer_expired', {});
    resolveAllIfReady(room, code);
  }, room.timerDuration * 1000);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName, password, preferredCode, icon, homeTurf }) => {
    const name = (playerName || '').trim().slice(0, 20);
    if (!name) { socket.emit('error', { message: 'Name required' }); return; }

    const preferred = (preferredCode || '').toUpperCase().trim();
    const code = (VALID_CODE_RE.test(preferred) && !rooms.has(preferred)) ? preferred : generateRoomCode();
    const room = {
      code,
      phase: 'lobby',
      round: 1,
      hostName: name,
      password: (password || '').trim() || null,
      players: new Map(),
      pendingAllocations: new Map(),
      readyPlayers: new Set(),
      lastResolveData: null,
      timerEnabled: false,
      timerDuration: 180, // seconds
      timerHandle: null,
      timerEndAt: null,
      homeTurfEnabled: false,
      crewRecoveryCostEnabled: true,
    };
    const assignedIcon = PLAYER_ICONS.includes(icon) ? icon : PLAYER_ICONS[0];
    room.players.set(name, createPlayer(socket.id, name, assignedIcon, homeTurf || 'docks'));
    rooms.set(code, room);
    socket.join(code);

    socket.emit('room_joined', { roomCode: code, myName: name, state: getPublicState(room) });
  });

  socket.on('join_room', ({ roomCode, playerName, password, passwordRetry, icon, homeTurf }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const name = (playerName || '').trim().slice(0, 20);
    if (!name) { socket.emit('error', { message: 'Name required' }); return; }

    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    const existing = room.players.get(name);
    if (existing) {
      if (existing.connected && existing.socketId !== socket.id) {
        socket.emit('error', { message: 'That name is already in use.' });
        return;
      }
      existing.socketId = socket.id;
      existing.connected = true;
      socket.join(code);

      const hasSubmitted = room.pendingAllocations.has(name);
      socket.emit('reconnected', {
        myName: name,
        state: getPublicState(room),
        hasSubmitted,
        lastResolveData: room.lastResolveData,
        lastWinners: room.lastWinners || null,
      });
      io.to(code).emit('player_joined', { name, state: getPublicState(room) });
      return;
    }

    if (room.phase !== 'lobby') { socket.emit('error', { message: 'Game already in progress' }); return; }
    if (room.players.size >= 6) { socket.emit('error', { message: 'Room is full (max 6)' }); return; }
    if (room.password) {
      const pwdProvided = (password || '').trim();
      if (!passwordRetry) {
        socket.emit('password_required', { roomCode: code });
        return;
      }
      if (pwdProvided !== room.password) {
        socket.emit('error', { message: 'Incorrect password' });
        return;
      }
    }

    const takenIcons = [...room.players.values()].map(p => p.icon);
    const assignedIcon2 = (PLAYER_ICONS.includes(icon) && !takenIcons.includes(icon))
      ? icon
      : PLAYER_ICONS.find(i => !takenIcons.includes(i)) || PLAYER_ICONS[0];
    room.players.set(name, createPlayer(socket.id, name, assignedIcon2, homeTurf || 'docks'));
    socket.join(code);

    socket.emit('room_joined', { roomCode: code, myName: name, state: getPublicState(room) });
    io.to(code).emit('player_joined', { name, state: getPublicState(room) });
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.name !== room.hostName) { socket.emit('error', { message: 'Only the host can start' }); return; }
    if (room.players.size < 3) { socket.emit('error', { message: 'Need at least 3 players' }); return; }

    room.readyPlayers.clear();
    room.phase = 'allocation';
    io.to(roomCode).emit('phase_changed', { phase: 'allocation', state: getPublicState(room) });
    startAllocationTimer(room, roomCode);
  });

  socket.on('set_timer', ({ roomCode, enabled, duration }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.name !== room.hostName) return;
    if (typeof enabled === 'boolean') room.timerEnabled = enabled;
    if (typeof duration === 'number') {
      room.timerDuration = Math.min(300, Math.max(60, Math.round(duration / 30) * 30));
    }
    io.to(roomCode).emit('timer_settings_changed', {
      timerEnabled: room.timerEnabled,
      timerDuration: room.timerDuration,
    });
  });

  socket.on('set_home_turf_enabled', ({ roomCode, enabled }) => {
    const room = rooms.get((roomCode || '').toUpperCase().trim());
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.name !== room.hostName) return;
    room.homeTurfEnabled = !!enabled;
    io.to(roomCode).emit('home_turf_setting_changed', { homeTurfEnabled: room.homeTurfEnabled });
  });

  socket.on('set_crew_recovery_cost', ({ roomCode, enabled }) => {
    const room = rooms.get((roomCode || '').toUpperCase().trim());
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.name !== room.hostName) return;
    room.crewRecoveryCostEnabled = !!enabled;
    io.to(roomCode).emit('crew_recovery_cost_changed', { crewRecoveryCostEnabled: room.crewRecoveryCostEnabled });
  });

  socket.on('ready_for_next', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'discussion') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;

    room.readyPlayers.add(player.name);
    const readyCount = room.readyPlayers.size;
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;

    io.to(roomCode).emit('player_ready', { name: player.name, readyCount, totalCount: connectedCount });

    if (readyCount >= connectedCount) {
      room.phase = 'allocation';
      room.readyPlayers.clear();
      io.to(roomCode).emit('phase_changed', { phase: 'allocation', state: getPublicState(room) });
      startAllocationTimer(room, roomCode);
    }
  });

  socket.on('submit_allocation', ({ roomCode, allocation }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'allocation') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;

    if (room.pendingAllocations.has(player.name)) {
      socket.emit('error', { message: 'Already submitted this round' });
      return;
    }

    const err = validateAllocation(allocation, player);
    if (err) { socket.emit('error', { message: err }); return; }

    room.pendingAllocations.set(player.name, allocation);

    const submittedCount = room.pendingAllocations.size;
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    io.to(roomCode).emit('allocation_received', { submittedCount, totalCount: connectedCount });

    if (submittedCount >= connectedCount) {
      room.phase = 'reveal';
      clearRoomTimer(room);
      const { resolveData, gameOver, winners } = resolveRound(room);

      if (gameOver) {
        io.to(roomCode).emit('game_over', { resolveData, winners, state: getPublicState(room) });
      } else {
        io.to(roomCode).emit('round_resolved', { resolveData, state: getPublicState(room) });
      }
    }
  });

  socket.on('kick_player', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const requester = findPlayerBySocket(room, socket.id);
    if (!requester || requester.name !== room.hostName) return;
    if (playerName === room.hostName) return;

    const target = room.players.get(playerName);
    if (!target) return;

    if (target.socketId) io.to(target.socketId).emit('kicked', { message: 'You were removed by the host' });
    room.players.delete(playerName);
    transferHostIfNeeded(room, playerName);
    afterPlayerRemoved(room, roomCode, playerName);
    if (rooms.has(roomCode)) {
      io.to(roomCode).emit('player_left', { name: playerName, state: getPublicState(room) });
    }
  });

  socket.on('leave_room', ({ roomCode }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('left_room');
      return;
    }
    const player = findPlayerBySocket(room, socket.id);
    if (!player) {
      socket.emit('left_room');
      return;
    }

    const name = player.name;

    if (room.phase !== 'lobby') {
      // During active game: keep seat but mark disconnected so they can rejoin
      player.connected = false;
      socket.leave(code);
      io.to(code).emit('player_left', { name, state: getPublicState(room) });
      socket.emit('left_room');
      // afterPlayerRemoved handles pendingAllocations, readyPlayers, transferHostIfNeeded, resolveAllIfReady
      afterPlayerRemoved(room, code, name);
      return;
    }

    room.players.delete(name);
    socket.leave(code);
    transferHostIfNeeded(room, name);
    afterPlayerRemoved(room, code, name);

    if (!rooms.has(code)) {
      socket.emit('left_room');
      return;
    }

    io.to(code).emit('player_left', { name, state: getPublicState(room) });
    socket.emit('left_room');
  });

  function resetRoomToLobby(room) {
    clearRoomTimer(room);
    room.round = 1;
    room.phase = 'lobby';
    room.pendingAllocations.clear();
    room.readyPlayers.clear();
    room.lastResolveData = null;
    for (const p of room.players.values()) {
      p.resources = 1;
      p.heat = 0;
    }
  }

  socket.on('play_again', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.name !== room.hostName) return;

    resetRoomToLobby(room);
    io.to(roomCode).emit('game_reset', { state: getPublicState(room) });
  });

  socket.on('end_game_to_lobby', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.name !== room.hostName) return;
    if (room.phase === 'lobby') return;

    resetRoomToLobby(room);
    io.to(roomCode).emit('game_reset', { state: getPublicState(room) });
  });

  socket.on('set_icon', ({ roomCode, icon }) => {
    const room = rooms.get((roomCode || '').toUpperCase().trim());
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    if (!PLAYER_ICONS.includes(icon)) return;
    const taken = [...room.players.values()].some(p => p.name !== player.name && p.icon === icon);
    if (taken) { socket.emit('icon_taken', {}); return; }
    player.icon = icon;
    io.to(roomCode).emit('lobby_update', { state: getPublicState(room) });
  });

  socket.on('set_turf', ({ roomCode, homeTurf }) => {
    const room = rooms.get((roomCode || '').toUpperCase().trim());
    if (!room || room.phase !== 'lobby') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    if (!['docks', 'strip', 'slums'].includes(homeTurf)) return;
    player.homeTurf = homeTurf;
    io.to(roomCode).emit('lobby_update', { state: getPublicState(room) });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = findPlayerBySocket(room, socket.id);
      if (player) {
        const name = player.name;
        if (room.phase === 'lobby') {
          // In the lobby, fully remove the player so the seat is freed immediately.
          // (Ghost seats block same-name rejoin and confuse the host roster.)
          room.players.delete(name);
          transferHostIfNeeded(room, name);
        } else {
          // In an active game, keep the seat so the player can reconnect mid-game.
          player.connected = false;
        }
        io.to(room.code).emit('player_left', { name, state: getPublicState(room) });
        if (rooms.has(room.code)) afterPlayerRemoved(room, room.code, name);
        break;
      }
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => console.log(`HeatSync running at http://localhost:${PORT}`));
}

module.exports = { httpServer, io };
