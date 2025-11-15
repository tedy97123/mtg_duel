const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  STATE_UPDATE: 'state-update',
};

const DEFAULT_TARGET = 'persist:remote-board';
const SAVE_STATE_KEY = 'playtester_savestate';

function isValidBlob(blob) {
  return typeof blob === 'string' && blob.length > 0;
}

function readSaveStateRaw() {
  try {
    return window.localStorage?.getItem(SAVE_STATE_KEY) ?? null;
  } catch (error) {
    console.warn('Unable to read playtester state', error);
    return null;
  }
}

function safeJsonParse(payload) {
  try {
    return JSON.parse(payload);
  } catch (error) {
    const start = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw error;
    }

    const candidate = payload.slice(start, end + 1);
    return JSON.parse(candidate);
  }
}

function readSaveStateDecoded() {
  const raw = readSaveStateRaw();
  if (!isValidBlob(raw)) {
    return null;
  }

  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return safeJsonParse(json);
  } catch (error) {
    console.warn('Failed to decode playtester state', error);
    return null;
  }
}

console.info('[Moxfield] local preload initialized');

function publishBlob(blob, targetPartition = DEFAULT_TARGET) {
  if (!isValidBlob(blob)) {
    return;
  }

  ipcRenderer.send(CHANNELS.STATE_UPDATE, {
    blob,
    targetPartition,
  });
}

contextBridge.exposeInMainWorld('localSandboxBridge', {
  readSaveStateRaw,
  readSaveStateDecoded,
  publishState: publishBlob,
  onRemoteState(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(CHANNELS.STATE_UPDATE, handler);
    return () => ipcRenderer.removeListener(CHANNELS.STATE_UPDATE, handler);
  },
});

const POLL_INTERVAL_MS = 500;
let lastPublishedBlob = null;

function pollAndPublish() {
  const currentBlob = readSaveStateRaw();
  if (!currentBlob || currentBlob === lastPublishedBlob) {
    return;
  }

  lastPublishedBlob = currentBlob;
  publishBlob(currentBlob);
  console.log('[LocalSandbox] Published state', {
    timestamp: new Date().toISOString(),
  });
}

setInterval(pollAndPublish, POLL_INTERVAL_MS);
