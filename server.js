const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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

const ZONES = ['east', 'west', 'downtown'];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createPlayer(socketId, name) {
  return { socketId, name, resources: 1, heat: 0, connected: true };
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

/** After removing a player from room.players — clean maps and maybe advance phase. */
function afterPlayerRemoved(room, code, removedName) {
  room.pendingAllocations.delete(removedName);
  room.readyPlayers.delete(removedName);
  transferHostIfNeeded(room, removedName);

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
    players: [...room.players.values()].map(p => ({
      name: p.name,
      resources: p.resources,
      heat: p.heat,
      connected: p.connected,
    })),
  };
  if (room.phase === 'allocation') {
    state.allocationProgress = {
      submittedCount: room.pendingAllocations.size,
      totalCount: room.players.size,
    };
    if (room.timerEnabled && room.timerEndAt) {
      state.timerEndAt = room.timerEndAt;
    }
  }
  if (room.phase === 'discussion') {
    state.readyProgress = {
      readyCount: room.readyPlayers.size,
      totalCount: room.players.size,
      readyNames: [...room.readyPlayers],
    };
  }
  return state;
}

// ─── Game Logic ───────────────────────────────────────────────────────────────

function aggregateZones(room) {
  const totals = { east: 0, west: 0, downtown: 0 };
  for (const alloc of room.pendingAllocations.values()) {
    for (const zone of ZONES) {
      totals[zone] += alloc[zone].crew + alloc[zone].resources;
    }
  }
  return totals;
}

function classifyZones(totals) {
  const vals = ZONES.map(z => totals[z]);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);

  if (unique.length === 3) {
    const roles = {};
    roles[ZONES.find(z => totals[z] === unique[0])] = 'lowest';
    roles[ZONES.find(z => totals[z] === unique[1])] = 'middle';
    roles[ZONES.find(z => totals[z] === unique[2])] = 'highest';
    return { outcome: 'all_different', roles };
  }

  if (unique.length === 1) {
    const roles = {};
    ZONES.forEach(z => roles[z] = 'tied');
    return { outcome: 'all_tied', roles };
  }

  // Two zones tied
  const tiedVal = unique.find(v => counts[v] === 2);
  const loneVal = unique.find(v => counts[v] === 1);
  const tiedZones = ZONES.filter(z => totals[z] === tiedVal);
  const loneZone = ZONES.find(z => totals[z] === loneVal);

  const roles = {};
  if (tiedVal < loneVal) {
    // Two tied for lowest
    tiedZones.forEach(z => roles[z] = 'tied_lowest');
    roles[loneZone] = 'lone_highest';
    return { outcome: 'two_tied_lowest', roles };
  } else {
    // Two tied for highest
    tiedZones.forEach(z => roles[z] = 'tied_highest');
    roles[loneZone] = 'lone_lowest';
    return { outcome: 'two_tied_highest', roles };
  }
}

// Returns resource delta for a player's contribution to one zone.
// crew is always 1 when player is in the zone, res >= 0.
function zoneDelta(crew, res, role, classificationOutcome) {
  if (classificationOutcome === 'all_tied') {
    // Crackdown: lose 1 resource per zone with any resources placed
    return (crew + res >= 2) ? -1 : 0;
  }
  switch (role) {
    case 'highest':
    case 'lone_highest':
      // Lose allocation: lose invested resources + pay 1 for crew recovery
      return -(res + 1);
    case 'middle':
      // Keep allocation + gain 1 bonus resource
      return 1;
    case 'lowest':
    case 'lone_lowest':
      // Triple: receive 3*(crew+res), having spent res → net = 3+2*res
      return 3 + 2 * res;
    case 'tied_lowest':
      // Double: receive 2*(crew+res), having spent res → net = 2+res
      return 2 + res;
    case 'tied_highest':
      // Halve: receive floor((crew+res)/2), having spent res
      return Math.floor((crew + res) / 2) - res;
    default:
      return 0;
  }
}

function resolveRound(room) {
  const totals = aggregateZones(room);
  const classification = classifyZones(totals);
  const playerResults = [];

  // Apply zone outcomes to each player
  for (const [name, alloc] of room.pendingAllocations) {
    const player = room.players.get(name);
    if (!player) continue;

    let totalDelta = 0;
    const zoneResults = [];

    for (const zone of ZONES) {
      const { crew, resources: res } = alloc[zone];
      if (crew === 0 && res === 0) continue; // player didn't go here

      const role = classification.roles[zone];
      const delta = zoneDelta(crew, res, role, classification.outcome);
      totalDelta += delta;

      let outcomeLabel;
      if (classification.outcome === 'all_tied') {
        outcomeLabel = (crew + res >= 2) ? 'crackdown' : 'safe';
      } else {
        outcomeLabel = role; // e.g. 'highest', 'middle', 'lowest', etc.
      }

      zoneResults.push({ zone, sent: { crew, resources: res }, outcome: outcomeLabel, delta });
    }

    player.resources = Math.max(0, player.resources + totalDelta);
    playerResults.push({ name, zoneResults, totalDelta, newResources: player.resources, newHeat: player.heat });
  }

  // Heat penalty: applies at the START of rounds 2–4
  // (i.e., after resolving rounds 1–3, before advancing)
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
    return { resolveData, gameOver: true, winners: determineWinners(room) };
  }

  room.round += 1;
  room.phase = 'discussion';
  return { resolveData, gameOver: false, winners: null };
}

function determineWinners(room) {
  const players = [...room.players.values()];
  const maxRes = Math.max(...players.map(p => p.resources));
  const contenders = players.filter(p => p.resources === maxRes);
  if (contenders.length === 1) return [contenders[0].name];
  const minHeat = Math.min(...contenders.map(p => p.heat));
  return contenders.filter(p => p.heat === minHeat).map(p => p.name);
}

function validateAllocation(alloc, player) {
  if (!alloc || typeof alloc !== 'object') return 'Invalid allocation';
  let crewCount = 0;
  let totalResources = 0;
  for (const zone of ZONES) {
    const z = alloc[zone];
    if (!z || typeof z !== 'object') return 'Invalid allocation format';
    const { crew, resources } = z;
    if (crew !== 0 && crew !== 1) return 'Invalid crew value';
    if (typeof resources !== 'number' || !Number.isInteger(resources) || resources < 0) return 'Invalid resources';
    if (resources > 0 && crew === 0) return 'Cannot place resources without crew';
    crewCount += crew;
    totalResources += resources;
  }
  if (crewCount !== 2) return 'Must assign crew to exactly 2 zones';
  if (totalResources !== player.resources) return 'Must allocate all your resources';
  return null;
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
  socket.on('create_room', ({ playerName, password, preferredCode }) => {
    const name = (playerName || '').trim().slice(0, 20);
    if (!name) { socket.emit('error', { message: 'Name required' }); return; }

    const preferred = (preferredCode || '').toUpperCase().trim();
    const code = (preferred.length === 4 && !rooms.has(preferred)) ? preferred : generateRoomCode();
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
    };
    room.players.set(name, createPlayer(socket.id, name));
    rooms.set(code, room);
    socket.join(code);

    socket.emit('room_joined', { roomCode: code, myName: name, state: getPublicState(room) });
  });

  socket.on('join_room', ({ roomCode, playerName, password, passwordRetry }) => {
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

    room.players.set(name, createPlayer(socket.id, name));
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
      room.pendingAllocations.delete(name);
      room.readyPlayers.delete(name);
      transferHostIfNeeded(room, name);
      io.to(code).emit('player_left', { name, state: getPublicState(room) });
      socket.emit('left_room');
      // Check if remaining connected players can advance
      afterPlayerRemoved(room, code, name);
      return;
    }

    room.players.delete(name);
    socket.leave(code);

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

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = findPlayerBySocket(room, socket.id);
      if (player) {
        player.connected = false;

        // Transfer host if host disconnected during lobby
        if (player.name === room.hostName && room.phase === 'lobby') {
          const nextHost = [...room.players.values()].find(p => p.connected && p.name !== player.name);
          if (nextHost) room.hostName = nextHost.name;
        }

        io.to(room.code).emit('player_left', { name: player.name, state: getPublicState(room) });
        break;
      }
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`HeatSync running at http://localhost:${PORT}`));
