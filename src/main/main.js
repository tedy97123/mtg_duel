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
  win.webContents.on('preload-error', (_event, path, error) => {
    console.error(`[Preload Error] ${path}`, error);
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

  if (lobbyWindow) {
    lobbyWindow.close();
    lobbyWindow = null;
  }
}

function sendToRelay(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connectToRelay() {
  console.log('[Main] Connecting to relay at', RELAY_URL);
  try {
    ws = new WebSocket(RELAY_URL);
  } catch (err) {
    console.error('[Main] Failed to create WebSocket:', err);
    return;
  }
  console.log('[Main] WebSocket created, waiting for open...');

  ws.on('open', () => {
    console.log('[Main] Connected to relay server');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log('[Relay] Received:', msg.type);

    if (msg.type === 'room-created' || msg.type === 'error') {
      if (lobbyWindow) {
        lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, msg);
      }
    } else if (msg.type === 'game-start') {
      if (lobbyWindow) {
        lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, msg);
      }
      setTimeout(() => {
        startGame(ws._myDeckUrl, msg.opponentDeckUrl);
      }, 500);
    } else if (msg.type === 'opponent-disconnected') {
      console.log('Opponent disconnected');
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
  });

  ws.on('error', (err) => {
    console.error('Relay connection error:', err.message);
    if (lobbyWindow) {
      lobbyWindow.webContents.send(CHANNELS.LOBBY_STATUS, {
        type: 'error',
        message: `Cannot connect to relay server at ${RELAY_URL}`,
      });
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from relay server');
  });
}

app.whenReady().then(() => {
  createLobbyWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createLobbyWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on(CHANNELS.LOBBY_CREATE, (_event, payload) => {
  console.log('[Main] LOBBY_CREATE received, deck:', payload.deckUrl);
  connectToRelay();
  ws.on('open', () => {
    console.log('[Main] Sending create-room');
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
  sendToRelay({
    type: 'relay',
    channel: CHANNELS.STATE_UPDATE,
    payload: { blob: payload.blob, timestamp: Date.now() },
  });
});

ipcMain.on(CHANNELS.COUNTER_UPDATE, (_event, payload) => {
  sendToRelay({
    type: 'relay',
    channel: CHANNELS.COUNTER_UPDATE,
    payload: { counters: payload.counters, timestamp: Date.now() },
  });
});

ipcMain.on(CHANNELS.CARD_ADJUSTMENTS, (_event, payload) => {
  sendToRelay({
    type: 'relay',
    channel: CHANNELS.CARD_ADJUSTMENTS,
    payload: { adjustments: payload.adjustments, timestamp: Date.now() },
  });
});

ipcMain.on(CHANNELS.PING, (event, payload) => {
  sendToRelay({
    type: 'relay',
    channel: CHANNELS.PING,
    payload,
  });
  if (localWindow && localWindow.webContents !== event.sender) {
    localWindow.webContents.send(CHANNELS.PING, payload);
  }
  if (remoteWindow && remoteWindow.webContents !== event.sender) {
    remoteWindow.webContents.send(CHANNELS.PING, payload);
  }
});
