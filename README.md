# HeatSync

A fast-paced multiplayer resource allocation game for 3–6 players. Every round, each player secretly distributes their crew and resources across three zones of a city. Zones are scored based on who sent the most — the top zone burns you, the bottom zone pays off. Run the city without getting burned.

Available as a web server (play in any browser) and as a standalone desktop app (Electron + P2P, no server needed).

---

## Quick start

```
npm install
npm start        # web server on port 3000
```

Open `http://localhost:3000` in multiple browser tabs to test locally.

## Development

```
npm run dev      # auto-restarts on file changes (port 3002)
```

## Electron (desktop, P2P)

No server required — one player hosts, others connect directly via WebRTC.

```
npm run electron       # open the app
npm run dist-mac       # build macOS .zip
npm run dist-win       # build Windows portable .exe
```

---

## How to play

1. **Lobby** — One player creates a room and shares the 4-character code. 3–6 players join.
2. **Allocation** — Each player secretly sends crew (and optionally resources) to exactly 2 of the 3 zones.
3. **Reveal** — Zones are ranked by total weight sent:
   - **Highest zone** — you lose everything you sent, plus 1 for your crew.
   - **Middle zone** — gain 1 resource.
   - **Lowest zone** — triple your placement (double gain).
   - **Ties** modify the outcome (split gains, crackdowns, etc.).
4. **4 rounds** — after the last round, most resources wins. Ties broken by least heat (heat accumulates when you hit 0 resources).

Optional settings (host-only): allocation timer, home turf bonus, crew recovery cost.

---

## Testing

```
npm test               # run all suites
npm run test:unit      # game-logic unit tests only
npm run test:server    # server socket.io integration tests only
npm run test:html      # HTML structure tests only
```

Tests use Node's built-in `node:test` runner — no external framework required.

---

## Architecture

```
server.js              Web server (Express + Socket.io)
lib/gameLogic.js       Pure game logic — shared by server and P2P host
public/
  client.js            Browser client (socket.io transport)
  shared.js            Shared UI logic used by both web and Electron clients
  style.css
electron/
  main.js              Electron main process
electron-app/
  client-p2p.js        Electron client (PeerJS P2P transport)
p2p/
  peer-host.js         P2P host — mirrors server.js game logic over WebRTC
  peer-client.js       Socket.io-compatible shim over PeerJS DataConnection
views/
  game.html            Single-source HTML template (generates web + electron builds)
test/
  gameLogic.test.js    Unit tests for pure game logic
  server.test.js       Integration tests for socket.io server
  html.test.js         HTML structure and build-consistency tests
```

The HTML template (`views/game.html`) uses `<!--[WEB]-->` / `<!--[ELECTRON]-->` markers to manage platform-specific sections. Run `npm run build-html` after editing the template to regenerate `public/index.html` and `electron-app/index.html`.
