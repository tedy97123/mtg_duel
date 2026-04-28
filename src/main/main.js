const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const WebSocket = require('ws');
const CHANNELS = require('../shared/ipc-channels');

const RELAY_URL = process.env.RELAY_SERVER_URL || 'wss://mtg-duel-relay-tedy.fly.dev';
const OPPONENT_PING_COLOR = '#ef4444';

const REMOTE_PRESETS = [
  { x: 1280, y: 0,   width: 900, height: 600 },
  { x: 1280, y: 600, width: 900, height: 600 },
  { x: 0,    y: 800, width: 900, height: 600 },
];

let waitingWindow = null;
let localWindow   = null;
let remoteWindows = {};
let ws            = null;

// ── Protocol registration ─────────────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('mtgduel', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('mtgduel');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith('mtgduel://'));
    if (url) handleDeepLink(url);
    if (waitingWindow) {
      if (waitingWindow.isMinimized()) waitingWindow.restore();
      waitingWindow.focus();
    }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── Deep link parser ──────────────────────────────────────────────────────────
function parseDeepLink(url) {
  try {
    const parsed = new URL(url);
    const role   = parsed.hostname;
    const code   = parsed.pathname.replace('/', '').toUpperCase();
    const deck   = decodeURIComponent(parsed.searchParams.get('deck') || '');
    const slot   = parseInt(parsed.searchParams.get('slot') || '-1');
    return { role, code, deck, slot };
  } catch { return null; }
}

function handleDeepLink(url) {
  const params = parseDeepLink(url);
  if (!params || !params.deck) { console.warn('[DeepLink] Could not parse:', url); return; }
  console.log('[DeepLink] Received:', params);

  if (waitingWindow) {
    waitingWindow.webContents.once('dom-ready', () => {
      waitingWindow.webContents.executeJavaScript(
        `window.__WAITING_PARAMS__ = ${JSON.stringify({ code: params.code, role: params.role })};`
      );
    });
    waitingWindow.webContents.reload();
    connectAndStart(params);
  } else {
    openWaitingRoom(params);
  }
}

// ── Waiting room ──────────────────────────────────────────────────────────────
function openWaitingRoom(params) {
  if (waitingWindow) { waitingWindow.close(); waitingWindow = null; }

  waitingWindow = new BrowserWindow({
    width: 560,
    height: 780,
    title: 'MTG Duel',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'waiting-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--waiting-params=${JSON.stringify({ code: params.code || '----', role: params.role || 'host' })}`,
      ],
    },
  });

  waitingWindow.loadFile(path.join(__dirname, '..', 'lobby', 'waiting-room.html'));
  waitingWindow.on('closed', () => { waitingWindow = null; });

  if (params.deck) connectAndStart(params);
}

// ── Connect to relay ──────────────────────────────────────────────────────────
function connectAndStart(params) {
  const { role, code, deck, slot } = params;
  if (ws) { ws.terminate(); ws = null; }

  ws = new WebSocket(RELAY_URL);
  ws._myDeckUrl = deck;
  ws._myIndex   = role === 'host' ? 0 : (slot >= 0 ? slot : -1);
  ws._role      = role;
  ws._code      = code;
  ws._slot      = slot;

  ws.on('open', () => {
    console.log('[Main] Connected, role:', role, 'code:', code, 'slot:', slot);
    if (role === 'host') {
      ws.send(JSON.stringify({ type: 'attach-host', code, deckUrl: deck }));
    } else {
      // Guest attaches to their pre-reserved slot
      ws.send(JSON.stringify({ type: 'attach-guest', code, slot, deckUrl: deck }));
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log('[Relay] Received:', msg.type);
    handleRelayMessage(msg);
  });

  ws.on('error', (err) => {
    console.error('[Main] Relay error:', err.message);
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', { type: 'error', message: err.message });
  });

  ws.on('close', () => console.log('[Main] Relay disconnected'));
}

// ── Relay messages ────────────────────────────────────────────────────────────
function handleRelayMessage(msg) {
  if (msg.type === 'attached') {
    ws._myIndex = msg.playerIndex;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', {
      type: 'player-joined',
      players: msg.players,
    });

  } else if (msg.type === 'room-joined') {
    ws._myIndex = msg.playerIndex;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'player-joined' || msg.type === 'player-disconnected') {
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'game-start') {
    ws._players = msg.players;
    ws._opponentPlayers = msg.players.filter((p, i) => p && p.connected && i !== ws._myIndex);
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'error') {
    console.error('[Relay Error]', msg.message);
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'relay') {
    const fromIndex = msg.fromIndex;
    if (msg.channel === CHANNELS.STATE_UPDATE) {
      const win = remoteWindows[fromIndex];
      if (win) win.webContents.send(CHANNELS.STATE_UPDATE, msg.payload);
    } else if (msg.channel === CHANNELS.COUNTER_UPDATE) {
      const win = remoteWindows[fromIndex];
      if (win) win.webContents.send(CHANNELS.COUNTER_UPDATE, msg.payload);
    } else if (msg.channel === CHANNELS.CARD_ADJUSTMENTS) {
      const win = remoteWindows[fromIndex];
      if (win) win.webContents.send(CHANNELS.CARD_ADJUSTMENTS, msg.payload);
    } else if (msg.channel === CHANNELS.PING) {
      const ping = { ...msg.payload, color: OPPONENT_PING_COLOR };
      if (localWindow) localWindow.webContents.send(CHANNELS.PING, ping);
      Object.values(remoteWindows).forEach(w => { if (w) w.webContents.send(CHANNELS.PING, ping); });
    }
  }
}

// ── Game windows ──────────────────────────────────────────────────────────────
function createGameWindow(preload, partition, url, x, y, width, height, label) {
  const win = new BrowserWindow({
    width, height, x, y,
    title: `Moxfield – ${label}`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', preload),
      partition, contextIsolation: true, nodeIntegration: false, spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(url).catch(err => console.error(`Failed to load ${label}:`, err));
  return win;
}

function startGame(myDeckUrl, opponentPlayers) {
  localWindow = createGameWindow(
    'local-preload.js', 'persist:local-board',
    myDeckUrl, 0, 0, 1280, 800, 'Local Board'
  );
  localWindow.on('closed', () => { localWindow = null; });

  remoteWindows = {};
  opponentPlayers.forEach((player, i) => {
    if (!player || !player.deckUrl) return;
    const preset = REMOTE_PRESETS[i] || REMOTE_PRESETS[0];
    const playerIdx = player.index;
    const win = createGameWindow(
      'remote-preload.js', `persist:remote-board-${playerIdx}`,
      player.deckUrl, preset.x, preset.y, preset.width, preset.height,
      `Remote — ${player.name || `P${playerIdx + 1}`}`
    );
    win.on('closed', () => { delete remoteWindows[playerIdx]; });
    remoteWindows[playerIdx] = win;
  });

  if (waitingWindow) { waitingWindow.close(); waitingWindow = null; }
}

function sendToRelay(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const deepLinkUrl = process.argv.find(arg => arg.startsWith('mtgduel://'));
  if (deepLinkUrl) {
    handleDeepLink(deepLinkUrl);
  } else {
    openWaitingRoom({ role: 'host', code: '----', deck: '', slot: -1 });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWaitingRoom({ role: 'host', code: '----', deck: '', slot: -1 });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on('waiting:start', () => sendToRelay({ type: 'start-game' }));

ipcMain.on('waiting:launch', () => {
  if (!ws || !ws._myDeckUrl || !ws._opponentPlayers) return;
  startGame(ws._myDeckUrl, ws._opponentPlayers);
});

ipcMain.on(CHANNELS.STATE_UPDATE, (_event, payload) => {
  sendToRelay({ type: 'relay', channel: CHANNELS.STATE_UPDATE, payload: { blob: payload.blob, timestamp: Date.now() } });
});

ipcMain.on(CHANNELS.COUNTER_UPDATE, (_event, payload) => {
  sendToRelay({ type: 'relay', channel: CHANNELS.COUNTER_UPDATE, payload: { counters: payload.counters, timestamp: Date.now() } });
});

ipcMain.on(CHANNELS.CARD_ADJUSTMENTS, (_event, payload) => {
  sendToRelay({ type: 'relay', channel: CHANNELS.CARD_ADJUSTMENTS, payload: { adjustments: payload.adjustments, timestamp: Date.now() } });
});

ipcMain.on(CHANNELS.PING, (event, payload) => {
  sendToRelay({ type: 'relay', channel: CHANNELS.PING, payload });
  if (localWindow && localWindow.webContents !== event.sender) localWindow.webContents.send(CHANNELS.PING, payload);
  Object.values(remoteWindows).forEach(w => {
    if (w && w.webContents !== event.sender) w.webContents.send(CHANNELS.PING, payload);
  });
});