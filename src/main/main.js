const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const WebSocket = require('ws');
const CHANNELS = require('../shared/ipc-channels');

const RELAY_URL = process.env.RELAY_SERVER_URL || 'wss://mtg-duel-relay.fly.dev';
const OPPONENT_PING_COLOR = '#ef4444';

const WINDOW_PRESETS = {
  local: {
    label: 'Local Board',
    partition: 'persist:local-board',
    preload: 'local-preload.js',
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 800 },
  },
  remote: {
    label: 'Remote Board',
    partition: 'persist:remote-board',
    preload: 'remote-preload.js',
    position: { x: 1280, y: 0 },
    size: { width: 900, height: 600 },
  },
};

let lobbyWindow = null;
let localWindow = null;
let remoteWindow = null;
let ws = null;

// ── Protocol registration (Windows) ──────────────────────────────────────────
// Registers mtgduel:// so Discord "Launch" buttons can open the app directly.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('mtgduel', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('mtgduel');
}

// Force single instance so a second launch passes the URL to the first instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is running — quit and let it handle the URL
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: the deep link URL is the last item in commandLine
    const url = commandLine.find(arg => arg.startsWith('mtgduel://'));
    if (url) handleDeepLink(url);

    // Bring existing window to front
    if (lobbyWindow) {
      if (lobbyWindow.isMinimized()) lobbyWindow.restore();
      lobbyWindow.focus();
    }
  });
}

// ── Deep link parser ─────────────────────────────────────────────────────────
// mtgduel://host/ABCD?deck=https://...
// mtgduel://join/ABCD?deck=https://...
function parseDeepLink(url) {
  try {
    // node's URL needs a proper base
    const parsed = new URL(url);
    const role = parsed.hostname;               // 'host' or 'join'
    const code = parsed.pathname.replace('/', '').toUpperCase();
    const deck = decodeURIComponent(parsed.searchParams.get('deck') || '');
    return { role, code, deck };
  } catch {
    return null;
  }
}

function handleDeepLink(url) {
  const params = parseDeepLink(url);
  if (!params || !params.deck) {
    console.warn('[DeepLink] Could not parse URL:', url);
    return;
  }
  console.log('[DeepLink] Received:', params);
  connectAndStart(params.role, params.code, params.deck);
}

// ── Connect to relay and start game (used by deep link flow) ─────────────────
function connectAndStart(role, code, myDeckUrl) {
  if (ws) {
    ws.terminate();
    ws = null;
  }

  ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    console.log('[Main] Connected to relay via deep link, role:', role);
    if (role === 'host') {
      // Host already created the room via the bot — re-join as host isn't
      // needed since the relay already has the room open. The bot kept the
      // relay WS alive waiting for the guest. We open the game windows and
      // wait for game-start (which the bot already triggered).
      // Instead, just treat this as if game-start already fired using the
      // stored deck URL — show lobby and wait or skip straight to game.
      // For simplicity: show lobby which will auto-proceed when WS fires game-start.
      ws._myDeckUrl = myDeckUrl;
      ws._pendingCode = code;
      // Re-attach to room on relay by sending a rejoin signal
      ws.send(JSON.stringify({ type: 'rejoin-host', code, deckUrl: myDeckUrl }));
    } else {
      ws._myDeckUrl = myDeckUrl;
      ws.send(JSON.stringify({ type: 'join-room', code, deckUrl: myDeckUrl }));
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
    if (lobbyWindow) {
      lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, {
        type: 'error',
        message: `Cannot connect to relay: ${err.message}`,
      });
    }
  });

  ws.on('close', () => console.log('[Main] Relay disconnected'));
}

// ── Relay message handler (shared between manual lobby and deep link) ─────────
function handleRelayMessage(msg) {
  if (msg.type === 'room-created' || msg.type === 'error') {
    if (lobbyWindow) lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, msg);

  } else if (msg.type === 'game-start') {
    if (lobbyWindow) lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, msg);
    setTimeout(() => {
      startGame(ws._myDeckUrl, msg.opponentDeckUrl);
    }, 500);

  } else if (msg.type === 'opponent-disconnected') {
    console.log('[Main] Opponent disconnected');

  } else if (msg.type === 'relay') {
    if (msg.channel === CHANNELS.STATE_UPDATE && remoteWindow) {
      remoteWindow.webContents.send(CHANNELS.STATE_UPDATE, msg.payload);
    } else if (msg.channel === CHANNELS.COUNTER_UPDATE && remoteWindow) {
      remoteWindow.webContents.send(CHANNELS.COUNTER_UPDATE, msg.payload);
    } else if (msg.channel === CHANNELS.CARD_ADJUSTMENTS && remoteWindow) {
      remoteWindow.webContents.send(CHANNELS.CARD_ADJUSTMENTS, msg.payload);
    } else if (msg.channel === CHANNELS.PING) {
      const opponentPing = { ...msg.payload, color: OPPONENT_PING_COLOR };
      if (localWindow) localWindow.webContents.send(CHANNELS.PING, opponentPing);
      if (remoteWindow) remoteWindow.webContents.send(CHANNELS.PING, opponentPing);
    }
  }
}

// ── Window creation ───────────────────────────────────────────────────────────
function createLobbyWindow() {
  lobbyWindow = new BrowserWindow({
    width: 500,
    height: 520,
    title: 'MTG Duel',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'lobby-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  lobbyWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Lobby Preload Error]', preloadPath, error);
  });

  lobbyWindow.loadFile(path.join(__dirname, '..', 'lobby', 'lobby.html'));
  lobbyWindow.on('closed', () => { lobbyWindow = null; });
}

function createGameWindow(preset, url) {
  const preloadPath = path.join(__dirname, '..', 'preload', preset.preload);
  const { width, height } = preset.size;

  const win = new BrowserWindow({
    width,
    height,
    title: `Moxfield – ${preset.label}`,
    x: preset.position.x,
    y: preset.position.y,
    webPreferences: {
      preload: preloadPath,
      partition: preset.partition,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('preload-error', (_event, p, error) => {
    console.error(`[Preload Error] ${p}`, error);
  });

  win.loadURL(url).catch((error) => {
    console.error(`Failed to load ${preset.label}:`, error);
  });

  return win;
}

function startGame(myDeckUrl, opponentDeckUrl) {
  localWindow = createGameWindow(WINDOW_PRESETS.local, myDeckUrl);
  remoteWindow = createGameWindow(WINDOW_PRESETS.remote, opponentDeckUrl);
  localWindow.on('closed', () => { localWindow = null; });
  remoteWindow.on('closed', () => { remoteWindow = null; });
  if (lobbyWindow) { lobbyWindow.close(); lobbyWindow = null; }
}

function sendToRelay(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connectToRelay() {
  console.log('[Main] Connecting to relay at', RELAY_URL);
  ws = new WebSocket(RELAY_URL);

  ws.on('open', () => console.log('[Main] Connected to relay server'));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log('[Relay] Received:', msg.type);
    handleRelayMessage(msg);
  });
  ws.on('error', (err) => {
    console.error('[Main] Relay connection error:', err.message);
    if (lobbyWindow) {
      lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, {
        type: 'error',
        message: `Cannot connect to relay server at ${RELAY_URL}`,
      });
    }
  });
  ws.on('close', () => console.log('[Main] Disconnected from relay server'));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Check if launched via deep link (Windows passes it as a CLI arg)
  const deepLinkUrl = process.argv.find(arg => arg.startsWith('mtgduel://'));
  if (deepLinkUrl) {
    // Launched by clicking the Discord button — skip lobby, connect directly
    handleDeepLink(deepLinkUrl);
  } else {
    createLobbyWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLobbyWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC (manual lobby flow — still works as before) ──────────────────────────
ipcMain.on(CHANNELS.LOBBY_CREATE, (_event, payload) => {
  console.log('[Main] LOBBY_CREATE received, deck:', payload.deckUrl);
  connectToRelay();
  ws.on('open', () => {
    ws._myDeckUrl = payload.deckUrl;
    sendToRelay({ type: 'create-room', deckUrl: payload.deckUrl });
  });
});

ipcMain.on(CHANNELS.LOBBY_JOIN, (_event, payload) => {
  connectToRelay();
  ws.on('open', () => {
    ws._myDeckUrl = payload.deckUrl;
    sendToRelay({ type: 'join-room', code: payload.code, deckUrl: payload.deckUrl });
  });
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
  if (remoteWindow && remoteWindow.webContents !== event.sender) remoteWindow.webContents.send(CHANNELS.PING, payload);
});