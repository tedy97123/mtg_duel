const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  STATE_UPDATE: 'state-update',
  COUNTER_UPDATE: 'counter-update',
  CARD_ADJUSTMENTS: 'card-adjustments',
  PING: 'ping',
};

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

function publishBlob(blob) {
  if (!isValidBlob(blob)) {
    return;
  }

  ipcRenderer.send(CHANNELS.STATE_UPDATE, { blob });
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
const LOCAL_BRIDGE_CHANNEL = 'moxfield-local-bridge';
const COUNTER_POLL_MS = 500;
const COUNTER_KEYS = [
  'life', 'energy', 'rad', 'experience', 'poison', 'tickets',
  'commanderDamage1', 'commanderDamage2', 'commanderDamage3',
  'mana', 'turn', 'game',
];

let lastPublishedBlob = null;
let lastPublishedCountersJson = null;
let lastPublishedAdjustmentsJson = null;

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

const LOCAL_BRIDGE_SOURCE = `
(() => {
  var CHANNEL = '${LOCAL_BRIDGE_CHANNEL}';
  var KEYS = ${JSON.stringify(COUNTER_KEYS)};
  var POLL_MS = ${COUNTER_POLL_MS};

  if (window.__MOXFIELD_LOCAL_BRIDGE__) return;
  window.__MOXFIELD_LOCAL_BRIDGE__ = true;

  function findPlaytesterInstance() {
    var visited = new Set();
    var nodes = document.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      for (var key in node) {
        if (!key.startsWith('__reactFiber$')) continue;
        var stack = [node[key]];
        while (stack.length > 0) {
          var fiber = stack.pop();
          if (!fiber || visited.has(fiber)) continue;
          visited.add(fiber);
          if (fiber.stateNode && typeof fiber.stateNode === 'object'
              && !(fiber.stateNode instanceof HTMLElement)
              && typeof fiber.stateNode.handleRestoreSaveState === 'function') {
            window.__MOXFIELD_PLAYTESTER__ = fiber.stateNode;
            return fiber.stateNode;
          }
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
          if (fiber.return) stack.push(fiber.return);
          if (fiber.alternate) stack.push(fiber.alternate);
        }
      }
    }
    return null;
  }

  var lastJson = null;
  var lastAdjJson = null;

  function pollCounters() {
    var instance = window.__MOXFIELD_PLAYTESTER__ || findPlaytesterInstance();
    if (!instance || !instance.state) return;
    var counters = {};
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (k in instance.state) counters[k] = instance.state[k];
    }
    var json = JSON.stringify(counters);
    if (json === lastJson) return;
    lastJson = json;
    window.postMessage({ channel: CHANNEL, type: 'COUNTER_UPDATE', counters: counters }, '*');
  }

  function pollCardAdjustments() {
    var instance = window.__MOXFIELD_PLAYTESTER__ || findPlaytesterInstance();
    if (!instance || !instance.state || !instance.state.zones) return;
    var adjustments = {};
    var zones = instance.state.zones;
    for (var zoneName in zones) {
      var cards = zones[zoneName];
      if (!cards || !cards.length) continue;
      adjustments[zoneName] = {};
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        adjustments[zoneName][card.id] = {
          adjustedPower: card.adjustedPower,
          adjustedToughness: card.adjustedToughness,
          adjustedLoyalty: card.adjustedLoyalty,
          counters: card.counters,
          top: card.top,
          left: card.left
        };
      }
    }
    var json = JSON.stringify(adjustments);
    if (json === lastAdjJson) return;
    lastAdjJson = json;
    window.postMessage({ channel: CHANNEL, type: 'CARD_ADJUSTMENTS', adjustments: adjustments }, '*');
  }

  setInterval(pollCounters, POLL_MS);
  setInterval(pollCardAdjustments, POLL_MS);
  setTimeout(findPlaytesterInstance, 0);
})();
`;

function injectLocalBridge() {
  if (window.__MOXFIELD_LOCAL_BRIDGE_INJECTED__) {
    return;
  }
  const script = document.createElement('script');
  script.textContent = LOCAL_BRIDGE_SOURCE;
  document.documentElement.appendChild(script);
  script.remove();
  window.__MOXFIELD_LOCAL_BRIDGE_INJECTED__ = true;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== LOCAL_BRIDGE_CHANNEL) return;

  if (data.type === 'COUNTER_UPDATE' && data.counters) {
    const json = JSON.stringify(data.counters);
    if (json === lastPublishedCountersJson) return;
    lastPublishedCountersJson = json;

    ipcRenderer.send(CHANNELS.COUNTER_UPDATE, {
      counters: data.counters,
    });

    console.log('[LocalSandbox] Published counters', data.counters);
  } else if (data.type === 'CARD_ADJUSTMENTS' && data.adjustments) {
    const json = JSON.stringify(data.adjustments);
    if (json === lastPublishedAdjustmentsJson) return;
    lastPublishedAdjustmentsJson = json;

    ipcRenderer.send(CHANNELS.CARD_ADJUSTMENTS, {
      adjustments: data.adjustments,
    });

    console.log('[LocalSandbox] Published card adjustments');
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectLocalBridge, { once: true });
} else {
  injectLocalBridge();
}

setInterval(() => {
  injectLocalBridge();
}, 1000);

const LOCAL_PING_COLOR = '#3b82f6';

let cachedBoardEl = null;

function findBoardContainer() {
  if (cachedBoardEl && cachedBoardEl.isConnected) return cachedBoardEl;
  const els = document.querySelectorAll('[style]');
  for (const el of els) {
    if (el.style.top && el.style.left && el.parentElement) {
      const rect = el.parentElement.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 200) {
        cachedBoardEl = el.parentElement;
        return cachedBoardEl;
      }
    }
  }
  return document.documentElement;
}

function injectPingStyles() {
  if (document.getElementById('moxfield-ping-styles')) return;
  const style = document.createElement('style');
  style.id = 'moxfield-ping-styles';
  style.textContent = `
    @keyframes moxfield-ping-ripple {
      0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; }
      70% { transform: translate(-50%, -50%) scale(2.5); opacity: 0.4; }
      100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
    }
    @keyframes moxfield-ping-dot {
      0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      60% { opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
    }
    .moxfield-ping-ring {
      position: fixed;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      pointer-events: none;
      z-index: 999999;
      border: 3px solid var(--ping-color);
      animation: moxfield-ping-ripple 1.2s ease-out forwards;
    }
    .moxfield-ping-dot {
      position: fixed;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      pointer-events: none;
      z-index: 999999;
      background: var(--ping-color);
      animation: moxfield-ping-dot 1.2s ease-out forwards;
    }
  `;
  document.head.appendChild(style);
}

function showPing(offsetX, offsetY, color) {
  injectPingStyles();
  const board = findBoardContainer();
  const rect = board.getBoundingClientRect();
  const x = rect.left + offsetX;
  const y = rect.top + offsetY;

  const ring = document.createElement('div');
  ring.className = 'moxfield-ping-ring';
  ring.style.setProperty('--ping-color', color);
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';

  const dot = document.createElement('div');
  dot.className = 'moxfield-ping-dot';
  dot.style.setProperty('--ping-color', color);
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';

  document.body.appendChild(ring);
  document.body.appendChild(dot);
  ring.addEventListener('animationend', () => ring.remove());
  dot.addEventListener('animationend', () => dot.remove());
}

function initPing() {
  document.addEventListener('click', (event) => {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const board = findBoardContainer();
    const rect = board.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    showPing(offsetX, offsetY, LOCAL_PING_COLOR);
    ipcRenderer.send(CHANNELS.PING, { x: offsetX, y: offsetY, color: LOCAL_PING_COLOR });
  }, true);

  ipcRenderer.on(CHANNELS.PING, (_event, payload) => {
    showPing(payload.x, payload.y, payload.color);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPing, { once: true });
} else {
  initPing();
}
