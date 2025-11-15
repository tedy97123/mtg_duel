const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  STATE_UPDATE: 'state-update',
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

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) {
      return;
    }
    if (data.type === 'APPLY_BLOB') {
      applyBlob(data.blob);
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
  }
});

function initializeBridge() {
  injectPageBridge();
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
