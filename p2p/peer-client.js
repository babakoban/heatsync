'use strict';
// P2P Client — socket.io-compatible shim over a PeerJS DataConnection.
// PeerJS is loaded via <script> tag in electron-app/index.html as window.Peer.

function getPeerClass() {
  if (typeof window !== 'undefined' && window.Peer) return window.Peer;
  return require('peerjs').Peer;
}

let _activePeer = null;

/**
 * Connect to a P2P host.
 * Returns a promise resolving to a socket.io-compatible socket object.
 */
function connectToPeer(hostCode) {
  if (_activePeer && !_activePeer.destroyed) _activePeer.destroy();
  const PeerClass = getPeerClass();
  const listeners = {};

  function trigger(event, data) {
    (listeners[event] || []).forEach(cb => {
      try { cb(data); } catch (_) {}
    });
  }

  const socket = {
    on(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      return this;
    },
    off(event, cb) {
      if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== cb);
      return this;
    },
    emit(event, data) {
      if (socket._conn && socket._conn.open) {
        try { socket._conn.send(JSON.stringify({ event, data })); } catch (_) {}
      }
    },
    connected: false,
    id: null,
    _conn: null,
    _peer: null,
  };

  return new Promise((resolve, reject) => {
    const peer = new PeerClass();
    _activePeer = peer;
    socket._peer = peer;

    peer.on('open', () => {
      socket.id = peer.id;
      attachConn(peer.connect(hostCode, { reliable: true }), true);
    });

    peer.on('error', (err) => {
      if (!socket.connected) {
        reject(new Error(err.type || 'PeerJS error'));
      } else {
        trigger('error', { message: 'Connection error: ' + (err.type || err.message) });
      }
    });

    let resolved = false;

    function attachConn(conn, isInitial) {
      socket._conn = conn;

      conn.on('open', () => {
        socket.connected = true;
        if (isInitial && !resolved) {
          resolved = true;
          resolve(socket);
        }
      });

      conn.on('data', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        trigger(msg.event, msg.data);
      });

      conn.on('close', () => {
        socket.connected = false;
        trigger('host_disconnected', {});
      });

      conn.on('error', () => {
        socket.connected = false;
        try { conn.close(); } catch (_) {}
      });
    }

  });
}

module.exports = { connectToPeer };
