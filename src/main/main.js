require('dotenv').config();

const path    = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const WebSocket = require('ws');
const CHANNELS  = require('../../shared/ipc-channels');
const auth      = require('../../shared/auth');
const db        = require('../../shared/db');

const RELAY_URL = process.env.RELAY_SERVER_URL || 'wss://mtg-duel-relay-tedy.fly.dev';
const OPPONENT_PING_COLOR = '#ef4444';

const REMOTE_PRESETS = [
  { x: 1280, y: 0,   width: 900, height: 600 },
  { x: 1280, y: 600, width: 900, height: 600 },
  { x: 0,    y: 800, width: 900, height: 600 },
];

let loginWindow   = null;
let profileWindow = null;
let waitingWindow = null;
let localWindow   = null;
let remoteWindows = {};
let ws            = null;
let selectedDeckUrl  = null;
let selectedDeckId   = null;
let selectedDeckName = null;
let lobbiesWindow = null;

// ── Protocol registration ─────────────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('mtgduel', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('mtgduel');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock && !process.argv.includes('--multi')) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith('mtgduel://'));
    if (url) handleProtocolUrl(url);
    const win = loginWindow || profileWindow || waitingWindow;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

// ── Protocol URL router ───────────────────────────────────────────────────────
function handleProtocolUrl(url) {
  console.log('[Protocol] Received:', url);
  if (url.startsWith('mtgduel://auth/callback')) {
    handleAuthCallback(url);
  } else if (url.startsWith('mtgduel://host/') || url.startsWith('mtgduel://join/')) {
    handleDeepLink(url);
  }
}

// ── Auth callback ─────────────────────────────────────────────────────────────
async function handleAuthCallback(url) {
  try {
    const parsed = new URL(url);
    const code   = parsed.searchParams.get('code');
    if (!code) throw new Error('No code in callback');

    const user = await auth.handleAuthCallback(code);
    auth.saveSession(user);

    if (loginWindow) {
      loginWindow.webContents.send('auth:result', { success: true, username: user.username });
      setTimeout(() => {
        closeLogin();
        openProfile();
      }, 800);
    }
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    if (loginWindow) {
      loginWindow.webContents.send('auth:result', { success: false, error: err.message });
    }
  }
}

// ── Deep link ─────────────────────────────────────────────────────────────────
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
  console.log('[DeepLink]:', params);

  closeLogin();
  closeProfile();

  if (waitingWindow) {
    waitingWindow.webContents.once('dom-ready', () => {
      waitingWindow.webContents.executeJavaScript(
        `window.__WAITING_PARAMS__ = ${JSON.stringify({ code: params.code, role: params.role, deck: params.deck })};`
      );
    });
    waitingWindow.webContents.reload();
    connectDiscord(params);
  } else {
    openWaitingRoom(params);
  }
}

// ── Window creators ───────────────────────────────────────────────────────────
function openLogin() {
  if (loginWindow) { loginWindow.focus(); return; }
  loginWindow = new BrowserWindow({
    width: 600,
    height: 700,
    title: 'MTG Duel — Login',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'login-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow.loadFile(path.join(__dirname, '..', 'lobby', 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
}

function closeLogin() {
  if (loginWindow) { loginWindow.close(); loginWindow = null; }
}

function openProfile() {
  if (profileWindow) { profileWindow.focus(); return; }
  profileWindow = new BrowserWindow({
    width: 700,
    height: 900,
    title: 'MTG Duel — Profile',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'profile-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  profileWindow.loadFile(path.join(__dirname, '..', 'lobby', 'profile.html'));
  profileWindow.on('closed', () => { profileWindow = null; });
}

function closeProfile() {
  if (profileWindow) { profileWindow.close(); profileWindow = null; }
}

function openLobbies() {
  if (lobbiesWindow) { lobbiesWindow.focus(); return; }
  lobbiesWindow = new BrowserWindow({
    width: 700,
    height: 800,
    title: 'MTG Duel — Open Lobbies',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'lobbies-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lobbiesWindow.loadFile(path.join(__dirname, '..', 'lobby', 'lobbies.html'));
  lobbiesWindow.webContents.openDevTools(); // ← add this
  lobbiesWindow.on('closed', () => { lobbiesWindow = null; });
}

function closeLobbies() {
  if (lobbiesWindow) { lobbiesWindow.close(); lobbiesWindow = null; }
}

async function openWaitingRoom(params = {}) {
    const oldWindow = waitingWindow;  // ← save reference
  if (waitingWindow) { waitingWindow.close(); waitingWindow = null; }
  const code         = params.code || '----';
  const role         = params.role || 'host';
  const deck         = params.deck || selectedDeckUrl || '';
  const prefilledCode = params.prefilledCode || '';  

  let decks = [];
  const user = auth.getUser();
  if (user) {
    try { decks = await db.getDecks(user.id); } catch {}
  }

  waitingWindow = new BrowserWindow({
    width: 660,
    height: 960,
    title: 'MTG Duel',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'waiting-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--waiting-params=${JSON.stringify({
          code,
          role,
          deck,
          decks,
          selectedDeckId,
          prefilledCode,   
        })}`,
      ],
    },
  });

  waitingWindow.loadFile(path.join(__dirname, '..', 'lobby', 'waiting-room.html')); 
  waitingWindow.on('closed', () => { waitingWindow = null; });
    if (oldWindow) { oldWindow.close(); }
  if (params.deck) connectDiscord(params);
}

// ── Relay helpers ─────────────────────────────────────────────────────────────
function setupWs(deckUrl, myIndex, role, onOpen) {
  if (ws) { ws.terminate(); ws = null; }

  ws = new WebSocket(RELAY_URL);
  ws._myDeckUrl = deckUrl;
  ws._myIndex   = myIndex;
  ws._role      = role;

  ws.on('open', () => { console.log('[Main] WS open, role:', role); onOpen(); });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log('[Relay]', msg.type);
    handleRelayMessage(msg);
  });
  ws.on('error', (err) => {
    console.error('[Main] Relay error:', err.message);
    // Don't show connection reset errors to user — relay auto-restarts
    if (err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED')) return;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', { type: 'error', message: err.message });
  });
  ws.on('close', () => console.log('[Main] Relay disconnected'));
}

function connectDiscord(params) {
  const { role, code, deck, slot } = params;
  setupWs(deck, role === 'host' ? 0 : (slot >= 0 ? slot : -1), role, () => {
    if (role === 'host') {
      ws.send(JSON.stringify({ type: 'attach-host', code, deckUrl: deck }));
    } else {
      ws.send(JSON.stringify({ type: 'attach-guest', code, slot, deckUrl: deck }));
    }
  });
}

function sendToRelay(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Relay messages ────────────────────────────────────────────────────────────
function handleRelayMessage(msg) {
  if (msg.type === 'room-created') {
    ws._myIndex = 0;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', {
      type: 'room-created', code: msg.code, players: msg.players,
    });

  } else if (msg.type === 'room-joined') {
    ws._myIndex = msg.playerIndex;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'slot-reserved') {
    ws._myIndex = msg.playerIndex;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', {
      type: 'room-joined', playerIndex: msg.playerIndex, players: msg.players, code: msg.code,
    });

  } else if (msg.type === 'attached') {
    ws._myIndex = msg.playerIndex;
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', {
      type: 'player-joined', players: msg.players,
    });

  } else if (msg.type === 'player-joined' || msg.type === 'player-disconnected') {
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'game-start') {
    ws._players = msg.players;
    ws._opponentPlayers = msg.players.filter((p, i) => p && p.connected && i !== ws._myIndex);
 

    const user = auth.getUser();
    if (user) {
      db.createMatch(ws._code || 'unknown', msg.players.filter(p => p && p.connected).length)
        .then(match => {
          if (!match) return;
          ws._matchId = match.id;
          msg.players.forEach((p, i) => {
            if (!p || !p.connected) return;
            db.addMatchPlayer(match.id, {
              user_id:      i === ws._myIndex ? user.id : null,
              discord_id:   i === ws._myIndex ? user.discord_id : null,
              username:     p.name,
              deck_url:     p.deckUrl,
              player_index: i,
            });
          });
        });

      if (selectedDeckId) db.markDeckUsed(selectedDeckId);
    }

    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'error') {
    console.error('[Relay Error]', msg.message);
    if (waitingWindow) waitingWindow.webContents.send('waiting:status', msg);

  } else if (msg.type === 'relay') {
    const from = msg.fromIndex;
    if (msg.channel === CHANNELS.STATE_UPDATE) {
      const win = remoteWindows[from];
      if (win) win.webContents.send(CHANNELS.STATE_UPDATE, msg.payload);
    } else if (msg.channel === CHANNELS.COUNTER_UPDATE) {
      const win = remoteWindows[from];
      if (win) win.webContents.send(CHANNELS.COUNTER_UPDATE, msg.payload);
    } else if (msg.channel === CHANNELS.CARD_ADJUSTMENTS) {
      const win = remoteWindows[from];
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
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(url).catch(err => console.error(`Failed to load ${label}:`, err));
  return win;
}


function closeWaitingRoom() {
  // function to ret urn to profile page if user is logged in, or login page if not
  const user = auth.getUser();
  if (user) {
    if (waitingWindow) { waitingWindow.close(); waitingWindow = null; }
    openProfile();
  } else {
    if (waitingWindow) { waitingWindow.close(); waitingWindow = null; }
    openLogin();
  }
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
    const preset    = REMOTE_PRESETS[i] || REMOTE_PRESETS[0];
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

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const deepLinkUrl = process.argv.find(arg => arg.startsWith('mtgduel://'));

  if (deepLinkUrl) {
    handleProtocolUrl(deepLinkUrl);
    return;
  }

  const savedUser = auth.loadSession();
  if (savedUser) {
    console.log('[Auth] Restored session for:', savedUser.username);
    openProfile();
  } else {
    openLogin();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const user = auth.getUser();
      if (user) openProfile();
      else openLogin();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: Auth ─────────────────────────────────────────────────────────────────
ipcMain.on('auth:login', () => auth.startDiscordAuth());

ipcMain.on('auth:skip', async () => {
  try {
    await openWaitingRoom();
    closeLogin();
  } catch (err) {
    console.error('[Skip] Failed to open waiting room:', err.message);
  }
});

ipcMain.on('auth:logout', () => {
  auth.clearSession();
  closeProfile();
  openLogin();
});

// ── IPC: Profile ──────────────────────────────────────────────────────────────
ipcMain.handle('profile:get', async () => {
  const user = auth.getUser();
  if (!user) return { user: {}, decks: [], matches: [], stats: {}, selectedDeckId };
  const [decks, matches, stats] = await Promise.all([
    db.getDecks(user.id),
    db.getRecentMatches(user.id),
    db.getStats(user.id),
  ]);
  return { user, decks, matches, stats, selectedDeckId };
});

ipcMain.handle('profile:add-deck', async (_event, { name, url }) => {
  const user = auth.getUser();
  // Includes full url to playtest page so users arrrive on the board instead of the deck view.
  let complete_deck_url = `https://moxfield.com/decks/${url}/goldfish`;
  if (!user) return [];
  await db.addDeck(user.id, name, complete_deck_url);
  return db.getDecks(user.id);
});

ipcMain.handle('profile:delete-deck', async (_event, { id }) => {
  const user = auth.getUser();
  if (!user) return [];
  await db.deleteDeck(id);
  if (selectedDeckId === id) { selectedDeckId = null; selectedDeckUrl = null; selectedDeckName = null; }
  return db.getDecks(user.id);
});

ipcMain.on('profile:select-deck', (_event, { id, url, name }) => {
  selectedDeckId   = id;
  selectedDeckUrl  = url;
  selectedDeckName = name;
});

ipcMain.on('profile:play', async () => {
  try {
    await openWaitingRoom();
    closeProfile();
  } catch (err) {
    console.error('[Profile] Failed to open waiting room:', err.message);
  }
});
// ── IPC: Manual lobby ─────────────────────────────────────────────────────────

ipcMain.on('waiting:join-room', (_event, { code, deckUrl, deckId }) => {
  const deck = deckUrl || selectedDeckUrl;
  if (!deck) return;
  selectedDeckUrl = deck;
  if (deckId) selectedDeckId = deckId;
  setupWs(deck, -1, 'join-manual', () => {
    ws.send(JSON.stringify({
      type: 'join-room',
      code: code.toUpperCase(),
      deckUrl: deck,
      name: auth.getUser()?.username || 'Guest',
    }));
  });
});

// waiting room public toggle
ipcMain.on('waiting:create-room', (_event, { deckUrl, deckId, isPublic }) => {
  const deck = deckUrl || selectedDeckUrl;
    console.log('[Create Room] deck:', deck, 'isPublic:', isPublic);  // ← add this
  if (!deck){
    console.log('[Create Room] NO DECK — aborting');  // ← add this
    return;
  }
  selectedDeckUrl = deck;
  if (deckId) selectedDeckId = deckId;
  setupWs(deck, 0, 'host', () => {
    ws.send(JSON.stringify({
      type: 'create-room',
      deckUrl: deck,
      name: auth.getUser()?.username || 'Host',
      isPublic: isPublic !== false,
    }));
  });
});


// ── IPC: Lobbies ──────────────────────────────────────────────────────────────
ipcMain.on('lobbies:join', async (_event, { code }) => {
  console.log('[Lobbies] Join clicked, code:', code);
  try {
    if (waitingWindow) {
      // Send code to existing waiting room instead of opening a new one
      waitingWindow.webContents.send('waiting:prefill-code', { code });
      // closeLobbies();
      waitingWindow.focus();
    } else {
      await openWaitingRoom({ prefilledCode: code });
      closeLobbies();
    }
  } catch (err) {
    console.error('[Lobbies] Failed:', err.message);
  }
});

ipcMain.on('lobbies:back', () => {
  closeLobbies();
});

ipcMain.on('waiting:browse-lobbies', () => {
  openLobbies();
});

ipcMain.on('waiting:leave-room', () => {
  // When clicking leave room button it navigate user back to profile page, but if user joined rooom via deep link it will navigate them back to user login page
  const user = auth.getUser();
  if (user) {
    closeWaitingRoom();
    openProfile();
  } else {
    closeWaitingRoom();
    openLogin();
  }
})

// ── IPC: Game flow ────────────────────────────────────────────────────────────
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