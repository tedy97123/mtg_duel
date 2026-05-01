const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, excludeIndex = -1) {
  room.players.forEach((ws, i) => {
    if (i !== excludeIndex && ws) send(ws, msg);
  });
}

function playerList(room) {
  return room.players.map((ws, i) => ({
    index: i,
    name: room.names[i] || null,
    deckUrl: room.decks[i] || null,
    connected: !!room.names[i],
    isHost: i === 0,
  }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // ── /launch ─────────────────────────────────────────────────────────────────
  if (url.pathname === '/launch') {
    const role     = url.searchParams.get('role') || 'join';
    const code     = (url.searchParams.get('code') || '').toUpperCase();
    const deck     = url.searchParams.get('deck') || '';
    const slot     = url.searchParams.get('slot') || '';
    const deepLink = `mtgduel://${role}/${code}?deck=${encodeURIComponent(deck)}&slot=${slot}`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0;url=${deepLink}">
  <title>Launching MTG Duel...</title>
  <style>
    body{font-family:monospace;background:#0c0b10;color:#c9a84c;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;margin:0;flex-direction:column;gap:16px;}
    h1{font-size:24px;}p{font-size:14px;color:#7a7090;}a{color:#c9a84c;}
  </style>
</head>
<body>
  <h1>⚔ Launching MTG Duel...</h1>
  <p>If the app doesn't open, <a href="${deepLink}">click here</a>.</p>
  <script>window.location.href=${JSON.stringify(deepLink)};</script>
</body>
</html>`);
    return;
  }

  // ── /auth/callback ───────────────────────────────────────────────────────────
  if (url.pathname === '/auth/callback') {
    const code     = url.searchParams.get('code');
    const deepLink = `mtgduel://auth/callback?code=${code}`;
    res.writeHead(302, { Location: deepLink });
    res.end();
    return;
  }

  // ── /lobbies ─────────────────────────────────────────────────────────────────
  if (url.pathname === '/lobbies') {
    const list = [...rooms.entries()]
      .filter(([, room]) => !room.started)
      .map(([code, room]) => ({
        code,
        hostName:   room.names[0] || 'Host',
        players:    room.names.filter(Boolean).length,
        maxPlayers: MAX_PLAYERS,
        isPublic:   room.isPublic !== false,
      }));

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(list));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
server.listen(PORT, () => console.log(`Relay listening on port ${PORT}`));

wss.on('connection', (ws) => {
  let roomCode    = null;
  let playerIndex = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log(`[${roomCode || 'no-room'}] ${msg.type}`);

    // ── create-room ───────────────────────────────────────────────────────────
    if (msg.type === 'create-room') {
      const code = generateCode();
      rooms.set(code, {
        started:  false,
        isPublic: msg.isPublic !== false,
        players:  new Array(MAX_PLAYERS).fill(null),
        decks:    new Array(MAX_PLAYERS).fill(null),
        names:    new Array(MAX_PLAYERS).fill(null),
      });

      const room = rooms.get(code);
      room.players[0] = ws;
      room.decks[0]   = msg.deckUrl;
      room.names[0]   = msg.name || 'Host';
      roomCode    = code;
      playerIndex = 0;

      send(ws, { type: 'room-created', code, maxPlayers: MAX_PLAYERS, playerIndex: 0, players: playerList(room) });
      console.log(`Room ${code} created for ${msg.name} (public: ${msg.isPublic !== false})`);

    // ── join-room-bot ─────────────────────────────────────────────────────────
    } else if (msg.type === 'join-room-bot') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room)        { send(ws, { type: 'error', message: 'Room not found' }); return; }
      if (room.started) { send(ws, { type: 'error', message: 'Game already started' }); return; }

      const slot = room.players.findIndex((p, i) => i > 0 && p === null);
      if (slot === -1)  { send(ws, { type: 'error', message: 'Room is full' }); return; }

      room.players[slot] = ws;
      room.decks[slot]   = msg.deckUrl;
      room.names[slot]   = msg.name || `Player ${slot + 1}`;
      roomCode    = code;
      playerIndex = slot;
      ws._isBotPlaceholder = true;

      const list = playerList(room);
      send(ws, { type: 'slot-reserved', code, playerIndex: slot, maxPlayers: MAX_PLAYERS, players: list });
      broadcast(room, { type: 'player-joined', players: list }, slot);
      console.log(`Bot reserved slot ${slot} for ${msg.name} in ${code}`);

    // ── join-room ─────────────────────────────────────────────────────────────
    } else if (msg.type === 'join-room') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room)        { send(ws, { type: 'error', message: 'Room not found' }); return; }
      if (room.started) { send(ws, { type: 'error', message: 'Game already started' }); return; }

      const slot = room.players.findIndex((p, i) => i > 0 && !p && !room.names[i]);
      if (slot === -1)  { send(ws, { type: 'error', message: 'Room is full' }); return; }

      room.players[slot] = ws;
      room.decks[slot]   = msg.deckUrl;
      room.names[slot]   = msg.name || `Player ${slot + 1}`;
      roomCode    = code;
      playerIndex = slot;

      const list = playerList(room);
      send(ws, { type: 'room-joined', code, playerIndex: slot, maxPlayers: MAX_PLAYERS, players: list });
      broadcast(room, { type: 'player-joined', players: list }, slot);
      console.log(`Player ${slot} (${msg.name}) joined ${code}`);

    // ── attach-host ───────────────────────────────────────────────────────────
    } else if (msg.type === 'attach-host') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room)        { send(ws, { type: 'error', message: `Room ${code} not found` }); return; }
      if (room.started) { send(ws, { type: 'error', message: 'Game already started' }); return; }

      if (room.players[0] && room.players[0] !== ws) {
        room.players[0]._replacedByElectron = true;
      }

      room.players[0] = ws;
      room.decks[0]   = msg.deckUrl || room.decks[0];
      room.names[0]   = msg.name || room.names[0];
      roomCode    = code;
      playerIndex = 0;

      const list = playerList(room);
      send(ws, { type: 'attached', code, playerIndex: 0, players: list, maxPlayers: MAX_PLAYERS });
      broadcast(room, { type: 'player-joined', players: list }, 0);
      console.log(`Host Electron attached to room ${code}`);

    // ── attach-guest ──────────────────────────────────────────────────────────
    } else if (msg.type === 'attach-guest') {
      const code = (msg.code || '').toUpperCase();
      const slot = parseInt(msg.slot);
      const room = rooms.get(code);
      if (!room)                         { send(ws, { type: 'error', message: `Room ${code} not found` }); return; }
      if (room.started)                  { send(ws, { type: 'error', message: 'Game already started' }); return; }
      if (slot < 1 || slot >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'Invalid slot' }); return; }

      if (room.players[slot] && room.players[slot] !== ws) {
        room.players[slot]._replacedByElectron = true;
      }

      room.players[slot] = ws;
      room.decks[slot]   = msg.deckUrl || room.decks[slot];
      room.names[slot]   = msg.name || room.names[slot];
      roomCode    = code;
      playerIndex = slot;

      const list = playerList(room);
      send(ws, { type: 'attached', code, playerIndex: slot, players: list, maxPlayers: MAX_PLAYERS });
      broadcast(room, { type: 'player-joined', players: list }, slot);
      console.log(`Guest Electron attached to slot ${slot} in room ${code}`);

    // ── start-game ────────────────────────────────────────────────────────────
    } else if (msg.type === 'start-game') {
      const room = rooms.get(roomCode);
      if (!room || playerIndex !== 0 || room.started) return;

      const connected = room.names.filter(Boolean).length;
      if (connected < 2) { send(ws, { type: 'error', message: 'Need at least 2 players' }); return; }

      room.started = true;
      const list = playerList(room);
      room.players.forEach((playerWs, i) => {
        if (playerWs) send(playerWs, { type: 'game-start', playerIndex: i, players: list });
      });
      console.log(`Room ${roomCode} started with ${connected} players`);

    // ── relay ─────────────────────────────────────────────────────────────────
    } else if (msg.type === 'relay') {
      const room = rooms.get(roomCode);
      if (!room) return;
      broadcast(room, { ...msg, fromIndex: playerIndex }, playerIndex);
    }
  });

  ws.on('close', () => {
    if (ws._replacedByElectron) {
      console.log(`Bot placeholder closed (replaced, ignored)`);
      return;
    }

    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.players[playerIndex] === ws) {
      room.players[playerIndex] = null;
      room.names[playerIndex]   = null;
      room.decks[playerIndex]   = null;
    }

    console.log(`Player ${playerIndex} left ${roomCode}`);

    const remaining = room.players.filter(Boolean).length;
    if (remaining === 0) {
      rooms.delete(roomCode);
      console.log(`Room ${roomCode} closed`);
      return;
    }

    broadcast(room, { type: 'player-disconnected', playerIndex, players: playerList(room) });
  });
});