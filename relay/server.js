const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 9147;
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
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ port: PORT });
console.log(`Relay server listening on port ${PORT}`);

wss.on('connection', (ws) => {
  let roomCode = null;
  let playerIndex = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log(`[${roomCode || 'no-room'}] Received: ${msg.type}`);

    if (msg.type === 'create-room') {
      const code = generateCode();
      rooms.set(code, {
        players: [ws, null],
        decks: [msg.deckUrl, null],
      });
      roomCode = code;
      playerIndex = 0;
      send(ws, { type: 'room-created', code });
      console.log(`Room ${code} created`);

    } else if (msg.type === 'join-room') {
      const room = rooms.get(msg.code);
      if (!room || room.players[1]) {
        send(ws, { type: 'error', message: 'Room not found or full' });
        return;
      }
      room.players[1] = ws;
      room.decks[1] = msg.deckUrl;
      roomCode = msg.code;
      playerIndex = 1;

      send(room.players[0], { type: 'game-start', opponentDeckUrl: room.decks[1] });
      send(room.players[1], { type: 'game-start', opponentDeckUrl: room.decks[0] });
      console.log(`Room ${msg.code} started`);

    } else if (msg.type === 'relay') {
      const room = rooms.get(roomCode);
      if (!room) return;
      const opponent = room.players[playerIndex === 0 ? 1 : 0];
      if (opponent) send(opponent, msg);
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const opponent = room.players[playerIndex === 0 ? 1 : 0];
    if (opponent) send(opponent, { type: 'opponent-disconnected' });
    rooms.delete(roomCode);
    console.log(`Room ${roomCode} closed`);
  });
});
