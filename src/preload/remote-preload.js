const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  STATE_UPDATE: 'state-update',
  COUNTER_UPDATE: 'counter-update',
  CARD_ADJUSTMENTS: 'card-adjustments',
  PING: 'ping',
};

const SAVE_STATE_KEY = 'playtester_savestate';
const FIND_INSTANCE_RETRY_MS = 1000;
const PAGE_BRIDGE_CHANNEL = 'moxfield-multiplayer-bridge';

let lastAppliedBlob = null;

function log(...args) {
  console.info('[RemoteSandbox]', ...args);
}

function warn(...args) {
  console.warn('[RemoteSandbox]', ...args);
}

const PAGE_BRIDGE_SOURCE = `
(() => {
  const CHANNEL = '${PAGE_BRIDGE_CHANNEL}';
  const SAVE_STATE_KEY = '${SAVE_STATE_KEY}';
  const LOG_PREFIX = '[MultiplayerBridge]';
  if (window.__MOXFIELD_MULTIPLAYER_BRIDGE__) {
    return;
  }
  window.__MOXFIELD_MULTIPLAYER_BRIDGE__ = true;

  function isValid(instance) {
    return instance && typeof instance.handleRestoreSaveState === 'function';
  }

  function traverseFiber(fiber) {
    if (!fiber) return null;
    const visited = new Set();
    const stack = [fiber];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (isValid(current.stateNode)) {
        return current.stateNode;
      }
      if (current.child && !visited.has(current.child)) stack.push(current.child);
      if (current.sibling && !visited.has(current.sibling)) stack.push(current.sibling);
      if (current.return && !visited.has(current.return)) stack.push(current.return);
      if (current.alternate && !visited.has(current.alternate)) stack.push(current.alternate);
    }
    return null;
  }

  function findInstance() {
    const startedAt = performance.now();
    const nodes = document.querySelectorAll('*');
    let fibersChecked = 0;
    for (const node of nodes) {
      for (const key in node) {
        if (!key.startsWith('__reactFiber$')) continue;
        const fiber = node[key];
        if (!fiber) continue;
        fibersChecked += 1;
        const candidate = traverseFiber(fiber);
        if (candidate) {
          window.__MOXFIELD_PLAYTESTER__ = candidate;
          window.postMessage(
            {
              channel: CHANNEL,
              type: 'INSTANCE_STATUS',
              status: 'captured',
              durationMs: Math.round(performance.now() - startedAt),
              fibersChecked,
            },
            '*'
          );
          return candidate;
        }
      }
    }

    window.postMessage(
      {
        channel: CHANNEL,
        type: 'INSTANCE_STATUS',
        status: 'missing',
        nodesChecked: nodes.length,
        fibersChecked,
        durationMs: Math.round(performance.now() - startedAt),
      },
      '*'
    );
    return null;
  }

  var lastReceivedAdjustments = null;

  function applyBlob(blob) {
    if (typeof blob !== 'string' || blob.length === 0) {
      return false;
    }
    const instance = window.__MOXFIELD_PLAYTESTER__ || findInstance();
    if (!instance) {
      console.warn(LOG_PREFIX, 'Playtester instance not available');
      return false;
    }
    try {
      localStorage.setItem(SAVE_STATE_KEY, blob);
      instance.handleRestoreSaveState();
      if (lastReceivedAdjustments) {
        setTimeout(function() {
          applyCardAdjustments(lastReceivedAdjustments);
        }, 200);
      }
      window.postMessage(
        {
          channel: CHANNEL,
          type: 'APPLY_RESULT',
          ok: true,
        },
        '*'
      );
      return true;
    } catch (error) {
      console.warn(LOG_PREFIX, 'Failed to apply blob', error);
      window.postMessage(
        {
          channel: CHANNEL,
          type: 'APPLY_RESULT',
          ok: false,
          message: error?.message,
        },
        '*'
      );
      return false;
    }
  }

  function applyCounters(counters) {
    if (!counters || typeof counters !== 'object') return false;
    var instance = window.__MOXFIELD_PLAYTESTER__ || findInstance();
    if (!instance) {
      console.warn(LOG_PREFIX, 'Cannot apply counters — instance not found');
      return false;
    }
    try {
      instance.setState(counters);
      window.postMessage({ channel: CHANNEL, type: 'COUNTER_RESULT', ok: true }, '*');
      return true;
    } catch (error) {
      console.warn(LOG_PREFIX, 'Failed to apply counters', error);
      window.postMessage({ channel: CHANNEL, type: 'COUNTER_RESULT', ok: false, message: error?.message }, '*');
      return false;
    }
  }

  function applyCardAdjustments(adjustments) {
    if (!adjustments || typeof adjustments !== 'object') return false;
    lastReceivedAdjustments = adjustments;
    var instance = window.__MOXFIELD_PLAYTESTER__ || findInstance();
    if (!instance || !instance.state || !instance.state.zones) {
      console.warn(LOG_PREFIX, 'Cannot apply card adjustments — instance not found');
      return false;
    }
    try {
      var zones = instance.state.zones;
      var newZones = {};
      var changed = false;
      for (var zoneName in zones) {
        var cards = zones[zoneName];
        var adj = adjustments[zoneName];
        if (!adj) {
          newZones[zoneName] = cards;
          continue;
        }
        var newCards = [];
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var cardAdj = adj[card.id] || adj[card.cardId];
          if (cardAdj
              && (card.adjustedPower !== cardAdj.adjustedPower
                  || card.adjustedToughness !== cardAdj.adjustedToughness
                  || card.adjustedLoyalty !== cardAdj.adjustedLoyalty
                  || card.top !== cardAdj.top
                  || card.left !== cardAdj.left
                  || JSON.stringify(card.counters) !== JSON.stringify(cardAdj.counters))) {
            newCards.push(Object.assign({}, card, {
              adjustedPower: cardAdj.adjustedPower,
              adjustedToughness: cardAdj.adjustedToughness,
              adjustedLoyalty: cardAdj.adjustedLoyalty,
              counters: cardAdj.counters,
              top: cardAdj.top,
              left: cardAdj.left
            }));
            changed = true;
          } else {
            newCards.push(card);
          }
        }
        newZones[zoneName] = newCards;
      }
      if (changed) {
        instance.setState({ zones: newZones });
      }
      window.postMessage({ channel: CHANNEL, type: 'ADJUSTMENT_RESULT', ok: true, changed: changed }, '*');
      return changed;
    } catch (error) {
      console.warn(LOG_PREFIX, 'Failed to apply card adjustments', error);
      window.postMessage({ channel: CHANNEL, type: 'ADJUSTMENT_RESULT', ok: false, message: error?.message }, '*');
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) {
      return;
    }
    if (data.type === 'APPLY_BLOB') {
      applyBlob(data.blob);
    } else if (data.type === 'APPLY_COUNTERS') {
      applyCounters(data.counters);
    } else if (data.type === 'APPLY_CARD_ADJUSTMENTS') {
      applyCardAdjustments(data.adjustments);
    } else if (data.type === 'FIND_REQUEST') {
      findInstance();
    }
  });

  setTimeout(findInstance, 0);

})();
`;

function injectPageBridge() {
  if (window.__MOXFIELD_MULTIPLAYER_BRIDGE_INJECTED__) {
    return;
  }
  const script = document.createElement('script');
  script.textContent = PAGE_BRIDGE_SOURCE;
  document.documentElement.appendChild(script);
  script.remove();
  window.__MOXFIELD_MULTIPLAYER_BRIDGE_INJECTED__ = true;
}

function postToPage(type, payload = {}) {
  window.postMessage(
    {
      channel: PAGE_BRIDGE_CHANNEL,
      type,
      ...payload,
    },
    '*'
  );
}

function applyIncomingBlob(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    return;
  }

  if (blob === lastAppliedBlob) {
    return;
  }

  lastAppliedBlob = blob;
  postToPage('APPLY_BLOB', { blob });
}

function subscribeToStateUpdates(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }

  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(CHANNELS.STATE_UPDATE, handler);
  return () => ipcRenderer.removeListener(CHANNELS.STATE_UPDATE, handler);
}

contextBridge.exposeInMainWorld('remoteSandboxBridge', {
  onStateUpdate: subscribeToStateUpdates,
  injectState(blob) {
    applyIncomingBlob(blob);
  },
});

subscribeToStateUpdates((payload) => {
  if (!payload || !payload.blob) {
    return;
  }

  log('Received remote blob', {
    length: payload.blob.length,
    timestamp: payload.timestamp,
  });

  applyIncomingBlob(payload.blob);
});

let lastAppliedCountersJson = null;
let lastAppliedAdjustmentsJson = null;

ipcRenderer.on(CHANNELS.COUNTER_UPDATE, (_event, payload) => {
  if (!payload || !payload.counters) {
    return;
  }

  const json = JSON.stringify(payload.counters);
  if (json === lastAppliedCountersJson) {
    return;
  }

  lastAppliedCountersJson = json;
  log('Received counters', payload.counters);
  postToPage('APPLY_COUNTERS', { counters: payload.counters });
});

ipcRenderer.on(CHANNELS.CARD_ADJUSTMENTS, (_event, payload) => {
  if (!payload || !payload.adjustments) {
    return;
  }

  const json = JSON.stringify(payload.adjustments);
  if (json === lastAppliedAdjustmentsJson) {
    return;
  }

  lastAppliedAdjustmentsJson = json;
  log('Received card adjustments');
  postToPage('APPLY_CARD_ADJUSTMENTS', { adjustments: payload.adjustments });
});
window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (!data || data.channel !== PAGE_BRIDGE_CHANNEL) {
    return;
  }
  if (data.type === 'INSTANCE_STATUS') {
    log('Instance status from page', data);
  } else if (data.type === 'APPLY_RESULT' && !data.ok) {
    warn('Page failed to apply blob', data.message);
  } else if (data.type === 'COUNTER_RESULT' && !data.ok) {
    warn('Page failed to apply counters', data.message);
  } else if (data.type === 'ADJUSTMENT_RESULT' && !data.ok) {
    warn('Page failed to apply card adjustments', data.message);
  }
});

function injectHideZonesCSS() {
  if (document.getElementById('moxfield-hide-zones')) return;
  const style = document.createElement('style');
  style.id = 'moxfield-hide-zones';
  style.textContent = `
    .player {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function initializeBridge() {
  injectPageBridge();
  injectHideZonesCSS();
  postToPage('FIND_REQUEST');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeBridge, { once: true });
} else {
  initializeBridge();
}

setInterval(() => {
  postToPage('FIND_REQUEST');
}, FIND_INSTANCE_RETRY_MS);

const REMOTE_PING_COLOR = '#ef4444';

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
    showPing(offsetX, offsetY, REMOTE_PING_COLOR);
    ipcRenderer.send(CHANNELS.PING, { x: offsetX, y: offsetY, color: REMOTE_PING_COLOR });
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
