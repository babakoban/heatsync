'use strict';
// Integration tests for server.js socket.io event handlers.
// Each test spins up the real server on a random port and connects real clients.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { httpServer, io } = require('../server');

// ─── Test server setup ────────────────────────────────────────────────────────

let baseUrl;

before(() => new Promise((resolve) => {
  httpServer.listen(0, () => {
    baseUrl = `http://localhost:${httpServer.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  io.close(resolve);
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return String(++_seq); }

function connect() {
  return ioClient(baseUrl, {
    forceNew: true,
    transports: ['websocket'],
    reconnection: false,
  });
}

// Await a socket event with timeout; rejects if not received within ms
function waitFor(socket, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      ms
    );
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

// Create a room and return { socket, roomCode, name }
async function createRoom(name) {
  name = name || `Host${uid()}`;
  const socket = connect();
  const p = waitFor(socket, 'room_joined');
  socket.emit('create_room', { playerName: name });
  const { roomCode } = await p;
  return { socket, roomCode, name };
}

// Join a room and return { socket, name }
async function joinRoom(roomCode, name) {
  name = name || `P${uid()}`;
  const socket = connect();
  const p = waitFor(socket, 'room_joined');
  socket.emit('join_room', { roomCode, playerName: name });
  await p;
  return { socket, name };
}

// Set up a 3-player lobby; returns { host, p2, p3, roomCode }
async function setupLobby() {
  const host = await createRoom();
  const p2   = await joinRoom(host.roomCode);
  const p3   = await joinRoom(host.roomCode);
  return { host, p2, p3, roomCode: host.roomCode };
}

// Disconnect an array of {socket} objects
function disconnectAll(...players) {
  for (const p of players) p.socket.disconnect();
}

// Build a valid allocation for a player with `res` resources,
// splitting them between docks and strip.
function allocFor(res) {
  const r1 = Math.ceil(res / 2);
  const r2 = res - r1;
  return {
    docks: { crew: 1, resources: r1 },
    strip: { crew: 1, resources: r2 },
    slums: { crew: 0, resources: 0 },
  };
}

// Get a player's resource count from a state object
function resOf(state, name) {
  const p = state.players.find((pl) => pl.name === name);
  return p ? p.resources : 0;
}

// Play all 4 rounds of a game to completion.
// `host`, `p2`, `p3` each have .socket and .name.
async function playFullGame(roomCode, host, p2, p3) {
  const players = [host, p2, p3];
  // Track resources so allocations are always valid
  const res = {};
  for (const p of players) res[p.name] = 1; // initial resources

  for (let round = 1; round <= 4; round++) {
    const doneEvent = round === 4 ? 'game_over' : 'round_resolved';
    const doneP = waitFor(host.socket, doneEvent);

    for (const p of players) {
      p.socket.emit('submit_allocation', {
        roomCode,
        allocation: allocFor(res[p.name]),
      });
    }

    const result = await doneP;

    if (round < 4) {
      // Update resource counts from state
      for (const pState of result.state.players) res[pState.name] = pState.resources;

      // Advance through discussion → allocation
      const phaseP = waitFor(host.socket, 'phase_changed');
      for (const p of players) p.socket.emit('ready_for_next', { roomCode });
      const phaseEv = await phaseP;
      for (const pState of phaseEv.state.players) res[pState.name] = pState.resources;
    }
  }
}

// ─── create_room ─────────────────────────────────────────────────────────────

describe('create_room', () => {
  test('returns a valid 4-char room code', async (t) => {
    const { socket, roomCode } = await createRoom();
    t.after(() => socket.disconnect());
    assert.match(roomCode, /^[A-Z2-9]{4}$/);
  });

  test('state has 1 player, lobby phase, round 1', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const p = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: `Host${uid()}` });
    const { state } = await p;
    assert.equal(state.players.length, 1);
    assert.equal(state.phase, 'lobby');
    assert.equal(state.round, 1);
  });

  test('rejects empty player name', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const p = waitFor(socket, 'error');
    socket.emit('create_room', { playerName: '' });
    const err = await p;
    assert.ok(err.message);
  });

  test('accepts a valid preferredCode', async (t) => {
    const code = 'XKCD';
    const socket = connect();
    t.after(() => socket.disconnect());
    const p = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: `Host${uid()}`, preferredCode: code });
    const { roomCode } = await p;
    assert.equal(roomCode, code);
  });

  test('ignores invalid preferredCode, generates a valid one', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const p = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: `Host${uid()}`, preferredCode: 'bad!' });
    const { roomCode } = await p;
    assert.match(roomCode, /^[A-Z2-9]{4}$/);
  });

  test('myName in room_joined matches the name sent', async (t) => {
    const name = `Host${uid()}`;
    const socket = connect();
    t.after(() => socket.disconnect());
    const p = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: name });
    const { myName } = await p;
    assert.equal(myName, name);
  });
});

// ─── join_room ────────────────────────────────────────────────────────────────

describe('join_room', () => {
  test('second player joins and receives room_joined', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const { socket: p2 } = await joinRoom(roomCode);
    t.after(() => p2.disconnect());
    // If we get here without timeout, join succeeded
  });

  test('player_joined is broadcast to existing players', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const broadcastP = waitFor(host, 'player_joined');
    const { socket: p2 } = await joinRoom(roomCode);
    t.after(() => p2.disconnect());
    const ev = await broadcastP;
    assert.equal(ev.state.players.length, 2);
  });

  test('rejects non-existent room code', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const p = waitFor(socket, 'error');
    socket.emit('join_room', { roomCode: 'ZZZZ', playerName: `P${uid()}` });
    const err = await p;
    assert.ok(err.message.toLowerCase().includes('not found'));
  });

  test('rejects joining with the same name as an existing connected player', async (t) => {
    const { socket: host, roomCode, name } = await createRoom();
    t.after(() => host.disconnect());
    const socket2 = connect();
    t.after(() => socket2.disconnect());
    const p = waitFor(socket2, 'error');
    socket2.emit('join_room', { roomCode, playerName: name });
    const err = await p;
    assert.ok(err.message);
  });

  test('rejects joining a game already in progress', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');
    const joiner = connect();
    t.after(() => joiner.disconnect());
    const errP = waitFor(joiner, 'error');
    joiner.emit('join_room', { roomCode, playerName: `Late${uid()}` });
    const err = await errP;
    assert.ok(err.message.toLowerCase().includes('progress'));
  });

  test('password-protected room prompts for password', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const hostP = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: `Host${uid()}`, password: 'secret' });
    const { roomCode } = await hostP;

    const joiner = connect();
    t.after(() => joiner.disconnect());
    const promptP = waitFor(joiner, 'password_required');
    joiner.emit('join_room', { roomCode, playerName: `J${uid()}` });
    const ev = await promptP;
    assert.equal(ev.roomCode, roomCode);
  });

  test('wrong password returns error', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const hostP = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: `Host${uid()}`, password: 'right' });
    const { roomCode } = await hostP;

    const joiner = connect();
    t.after(() => joiner.disconnect());
    const errP = waitFor(joiner, 'error');
    joiner.emit('join_room', { roomCode, playerName: `J${uid()}`, password: 'wrong', passwordRetry: true });
    const err = await errP;
    assert.ok(err.message.toLowerCase().includes('password'));
  });

  test('correct password allows entry', async (t) => {
    const socket = connect();
    t.after(() => socket.disconnect());
    const hostP = waitFor(socket, 'room_joined');
    socket.emit('create_room', { playerName: `Host${uid()}`, password: 'right' });
    const { roomCode } = await hostP;

    const joiner = connect();
    t.after(() => joiner.disconnect());
    const joinedP = waitFor(joiner, 'room_joined');
    joiner.emit('join_room', { roomCode, playerName: `J${uid()}`, password: 'right', passwordRetry: true });
    const { roomCode: rc } = await joinedP;
    assert.equal(rc, roomCode);
  });

  test('rejects 7th player (max 6)', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const extras = [];
    for (let i = 0; i < 5; i++) {
      const { socket } = await joinRoom(roomCode);
      extras.push(socket);
    }
    t.after(() => extras.forEach(s => s.disconnect()));

    const seventh = connect();
    t.after(() => seventh.disconnect());
    const errP = waitFor(seventh, 'error');
    seventh.emit('join_room', { roomCode, playerName: `P7${uid()}` });
    const err = await errP;
    assert.ok(err.message.toLowerCase().includes('full'));
  });
});

// ─── start_game ───────────────────────────────────────────────────────────────

describe('start_game', () => {
  test('host starts game; all players receive phase_changed → allocation', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    const phaseP = waitFor(p2.socket, 'phase_changed');
    host.socket.emit('start_game', { roomCode });
    const ev = await phaseP;
    assert.equal(ev.phase, 'allocation');
    assert.equal(ev.state.round, 1);
  });

  test('non-host cannot start game', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    const errP = waitFor(p2.socket, 'error');
    p2.socket.emit('start_game', { roomCode });
    const err = await errP;
    assert.ok(err.message.toLowerCase().includes('host'));
  });

  test('cannot start with only 2 players', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const { socket: p2 } = await joinRoom(roomCode);
    t.after(() => p2.disconnect());
    const errP = waitFor(host, 'error');
    host.emit('start_game', { roomCode });
    const err = await errP;
    assert.ok(err.message.includes('3'));
  });
});

// ─── submit_allocation ────────────────────────────────────────────────────────

describe('submit_allocation', () => {
  test('submission count is broadcast after each submit', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const progP = waitFor(p2.socket, 'allocation_received');
    host.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    const ev = await progP;
    assert.equal(ev.submittedCount, 1);
    assert.equal(ev.totalCount, 3);
  });

  test('duplicate submission returns error', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    host.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    await waitFor(host.socket, 'allocation_received');

    const errP = waitFor(host.socket, 'error');
    host.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    const err = await errP;
    assert.ok(err.message.toLowerCase().includes('already'));
  });

  test('invalid allocation (wrong crew count) returns error', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const errP = waitFor(host.socket, 'error');
    host.socket.emit('submit_allocation', {
      roomCode,
      allocation: {
        docks: { crew: 1, resources: 1 }, // only 1 crew zone
        strip: { crew: 0, resources: 0 },
        slums: { crew: 0, resources: 0 },
      },
    });
    const err = await errP;
    assert.ok(err.message);
  });

  test('all 3 players submitting triggers round_resolved', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const resolvedP = waitFor(host.socket, 'round_resolved');
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    }
    const ev = await resolvedP;
    assert.equal(ev.resolveData.round, 1);
    assert.ok(Array.isArray(ev.resolveData.playerResults));
    assert.equal(ev.resolveData.playerResults.length, 3);
  });

  test('round_resolved state shows updated resources', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const resolvedP = waitFor(host.socket, 'round_resolved');
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    }
    const ev = await resolvedP;
    assert.ok(ev.state.players.every(p => typeof p.resources === 'number'));
  });
});

// ─── full game cycle ──────────────────────────────────────────────────────────

describe('full game cycle', () => {
  test('4 rounds end with game_over and winners array', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const gameOverP = waitFor(host.socket, 'game_over');
    await playFullGame(roomCode, host, p2, p3);
    const ev = await gameOverP;

    assert.ok(Array.isArray(ev.winners));
    assert.ok(ev.winners.length >= 1);
    assert.equal(ev.resolveData.round, 4);
  });

  test('game_over state.phase is end', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const gameOverP = waitFor(host.socket, 'game_over');
    await playFullGame(roomCode, host, p2, p3);
    const ev = await gameOverP;
    assert.equal(ev.state.phase, 'end');
  });
});

// ─── discussion phase ─────────────────────────────────────────────────────────

describe('discussion phase', () => {
  test('after round_resolved, phase is discussion', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const resolvedP = waitFor(host.socket, 'round_resolved');
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    }
    const ev = await resolvedP;
    assert.equal(ev.state.phase, 'discussion');
  });

  test('all players ready → phase_changed to allocation', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const resolvedP = waitFor(host.socket, 'round_resolved');
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    }
    await resolvedP;

    const nextPhaseP = waitFor(host.socket, 'phase_changed');
    for (const p of [host, p2, p3]) {
      p.socket.emit('ready_for_next', { roomCode });
    }
    const ev = await nextPhaseP;
    assert.equal(ev.phase, 'allocation');
    assert.equal(ev.state.round, 2);
  });

  test('player_ready event is broadcast as players mark ready', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const resolvedP = waitFor(host.socket, 'round_resolved');
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    }
    await resolvedP;

    const readyP = waitFor(p2.socket, 'player_ready');
    host.socket.emit('ready_for_next', { roomCode });
    const ev = await readyP;
    assert.equal(ev.name, host.name);
    assert.equal(ev.readyCount, 1);
  });
});

// ─── player departure and reconnect ──────────────────────────────────────────

describe('player departure and reconnect', () => {
  test('player leaving lobby triggers player_left; remaining players still see each other', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => { host.socket.disconnect(); p3.socket.disconnect(); });
    const leftP = waitFor(host.socket, 'player_left');
    p2.socket.emit('leave_room', { roomCode });
    const ev = await leftP;
    assert.equal(ev.name, p2.name);
    assert.equal(ev.state.players.length, 2);
    p2.socket.disconnect();
  });

  test('disconnect in active game marks player disconnected (seat kept)', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => { host.socket.disconnect(); p3.socket.disconnect(); });
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const leftP = waitFor(host.socket, 'player_left');
    p2.socket.disconnect();
    const ev = await leftP;
    // Seat is preserved but marked disconnected
    const pState = ev.state.players.find(p => p.name === p2.name);
    assert.ok(pState, 'Player should still be in state (not removed)');
    assert.equal(pState.connected, false);
  });

  test('player reconnects mid-game and receives current state via reconnected event', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => { host.socket.disconnect(); p3.socket.disconnect(); });
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    // p2 disconnects; wait for server to process it
    const leftP = waitFor(host.socket, 'player_left');
    p2.socket.disconnect();
    await leftP;

    // p2 reconnects with same name
    const newSocket = connect();
    t.after(() => newSocket.disconnect());
    const reconP = waitFor(newSocket, 'reconnected');
    newSocket.emit('join_room', { roomCode, playerName: p2.name });
    const ev = await reconP;

    assert.equal(ev.myName, p2.name);
    assert.equal(ev.state.phase, 'allocation');
  });

  test('host leaving lobby transfers host role', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => { p2.socket.disconnect(); p3.socket.disconnect(); });
    const leftP = waitFor(p2.socket, 'player_left');
    host.socket.emit('leave_room', { roomCode });
    const ev = await leftP;
    assert.ok([p2.name, p3.name].includes(ev.state.hostName), 'Host role should transfer');
    host.socket.disconnect();
  });
});

// ─── kick_player ──────────────────────────────────────────────────────────────

describe('kick_player', () => {
  test('host can kick a non-host player', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => { host.socket.disconnect(); p3.socket.disconnect(); p2.socket.disconnect(); });
    const kickedP = waitFor(p2.socket, 'kicked');
    host.socket.emit('kick_player', { roomCode, playerName: p2.name });
    await kickedP;
  });

  test('kicked player is removed from room state', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => { host.socket.disconnect(); p3.socket.disconnect(); p2.socket.disconnect(); });
    const leftP = waitFor(host.socket, 'player_left');
    host.socket.emit('kick_player', { roomCode, playerName: p2.name });
    const ev = await leftP;
    assert.ok(!ev.state.players.some(p => p.name === p2.name));
  });

  test('non-host cannot kick players', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    // p2 tries to kick p3 — should be silently ignored (no kicked event on p3)
    // We verify by checking no player_left is emitted within a short window
    let kicked = false;
    p3.socket.once('kicked', () => { kicked = true; });
    p2.socket.emit('kick_player', { roomCode, playerName: p3.name });
    // Give it time to potentially fire
    await new Promise(r => setTimeout(r, 200));
    assert.equal(kicked, false);
  });
});

// ─── settings ────────────────────────────────────────────────────────────────

describe('settings', () => {
  test('set_timer broadcasts updated settings to all', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const settingsP = waitFor(host, 'timer_settings_changed');
    host.emit('set_timer', { roomCode, enabled: true, duration: 120 });
    const ev = await settingsP;
    assert.equal(ev.timerEnabled, true);
    assert.equal(ev.timerDuration, 120);
  });

  test('set_timer clamps duration to 30-second increments', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const settingsP = waitFor(host, 'timer_settings_changed');
    host.emit('set_timer', { roomCode, enabled: true, duration: 100 }); // rounds to 90
    const ev = await settingsP;
    assert.equal(ev.timerDuration % 30, 0);
  });

  test('set_home_turf_enabled broadcasts changed setting', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const p = waitFor(host, 'home_turf_setting_changed');
    host.emit('set_home_turf_enabled', { roomCode, enabled: true });
    const ev = await p;
    assert.equal(ev.homeTurfEnabled, true);
  });

  test('set_crew_recovery_cost broadcasts changed setting', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const p = waitFor(host, 'crew_recovery_cost_changed');
    host.emit('set_crew_recovery_cost', { roomCode, enabled: false });
    const ev = await p;
    assert.equal(ev.crewRecoveryCostEnabled, false);
  });

  test('game start with timer enabled emits timer_start with future endsAt', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));

    // Enable timer
    const timerSetP = waitFor(host.socket, 'timer_settings_changed');
    host.socket.emit('set_timer', { roomCode, enabled: true, duration: 60 });
    await timerSetP;

    // Start game; listen for both events
    const phaseP    = waitFor(host.socket, 'phase_changed');
    const timerP    = waitFor(host.socket, 'timer_start');
    host.socket.emit('start_game', { roomCode });
    const [, timerEv] = await Promise.all([phaseP, timerP]);

    assert.ok(timerEv.endsAt > Date.now(), 'Timer should end in the future');

    // Clean up: submit allocations to resolve the round so timer doesn't fire during teardown
    const resolvedP = waitFor(host.socket, 'round_resolved');
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_allocation', { roomCode, allocation: allocFor(1) });
    }
    await resolvedP;
  });
});

// ─── play_again and end_game ──────────────────────────────────────────────────

describe('play_again and end_game_to_lobby', () => {
  test('end_game_to_lobby aborts active game and resets to lobby', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    const resetP = waitFor(host.socket, 'game_reset');
    host.socket.emit('end_game_to_lobby', { roomCode });
    const ev = await resetP;
    assert.equal(ev.state.phase, 'lobby');
    assert.equal(ev.state.round, 1);
    assert.ok(ev.state.players.every(p => p.resources === 1));
  });

  test('play_again after game_over resets to lobby', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    // Play entire game
    const gameOverP = waitFor(host.socket, 'game_over');
    await playFullGame(roomCode, host, p2, p3);
    await gameOverP;

    const resetP = waitFor(host.socket, 'game_reset');
    host.socket.emit('play_again', { roomCode });
    const ev = await resetP;
    assert.equal(ev.state.phase, 'lobby');
    assert.equal(ev.state.round, 1);
  });
});

// ─── icon and turf ────────────────────────────────────────────────────────────

describe('icon and turf', () => {
  test('set_icon changes icon and broadcasts lobby_update', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const updateP = waitFor(host, 'lobby_update');
    host.emit('set_icon', { roomCode, icon: '★' });
    const ev = await updateP;
    const player = ev.state.players.find(p => p.name);
    assert.ok(player);
  });

  test('claiming a taken icon returns icon_taken', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    // First set host's icon to ★
    const update1 = waitFor(host, 'lobby_update');
    host.emit('set_icon', { roomCode, icon: '★' });
    await update1;

    const { socket: p2 } = await joinRoom(roomCode);
    t.after(() => p2.disconnect());
    const takenP = waitFor(p2, 'icon_taken');
    p2.emit('set_icon', { roomCode, icon: '★' });
    await takenP; // no assertion needed — just confirm the event fired
  });

  test('set_turf changes home turf and broadcasts lobby_update', async (t) => {
    const { socket: host, roomCode } = await createRoom();
    t.after(() => host.disconnect());
    const updateP = waitFor(host, 'lobby_update');
    host.emit('set_turf', { roomCode, homeTurf: 'slums' });
    const ev = await updateP;
    const player = ev.state.players.find(p => p.homeTurf === 'slums');
    assert.ok(player);
  });

  test('set_icon is ignored after game starts', async (t) => {
    const { host, p2, p3, roomCode } = await setupLobby();
    t.after(() => disconnectAll(host, p2, p3));
    host.socket.emit('start_game', { roomCode });
    await waitFor(host.socket, 'phase_changed');

    let updated = false;
    host.socket.once('lobby_update', () => { updated = true; });
    host.socket.emit('set_icon', { roomCode, icon: '♦' });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(updated, false);
  });
});
