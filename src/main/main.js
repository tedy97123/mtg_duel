const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const CHANNELS = require('../shared/ipc-channels');

const { MOXFIELD_DECK_ID, MOXFIELD_PLAYTEST_URL } = process.env;

function buildSandboxUrl() {
  if (MOXFIELD_DECK_ID) {
    return `https://www.moxfield.com/decks/${MOXFIELD_DECK_ID}/goldfish`;
  }

  if (MOXFIELD_PLAYTEST_URL) {
    return MOXFIELD_PLAYTEST_URL;
  }

  return 'https://moxfield.com/decks/public';
}

const DEFAULT_SANDBOX_URL = buildSandboxUrl();

const WINDOW_PRESETS = [
  {
    label: 'Local Board',
    partition: 'persist:local-board',
    preload: 'local-preload.js',
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 800 },
  },
  {
    label: 'Remote Board',
    partition: 'persist:remote-board',
    preload: 'remote-preload.js',
    position: { x: 1280, y: 0 },
    size: { width: 900, height: 600 },
  },
];

const windows = new Map();

function createPlayerWindow(options) {
  const preloadPath = path.join(__dirname, '..', 'preload', options.preload);
  const { width = 1280, height = 800 } = options.size || {};

  const win = new BrowserWindow({
    width,
    height,
    title: `Moxfield – ${options.label}`,
    x: options.position.x,
    y: options.position.y,
    webPreferences: {
      preload: preloadPath,
      partition: options.partition,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[Preload Error] ${preloadPath}`, error);
  });

  win.loadURL(DEFAULT_SANDBOX_URL).catch((error) => {
    console.error(`Failed to load Moxfield in ${options.label}`, error);
  });

  win.on('closed', () => {
    windows.delete(options.partition);
  });

  windows.set(options.partition, win);
  return win;
}

function createWindows() {
  WINDOW_PRESETS.forEach((preset) => {
    if (!windows.has(preset.partition)) {
      createPlayerWindow(preset);
    }
  });
}

app.whenReady().then(() => {
  createWindows();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on(CHANNELS.STATE_UPDATE, (_event, payload) => {
  const targetWindow = windows.get(payload?.targetPartition);
  if (!targetWindow) {
    return;
  }

  targetWindow.webContents.send(CHANNELS.STATE_UPDATE, {
    blob: payload.blob,
    timestamp: Date.now(),
  });
});
