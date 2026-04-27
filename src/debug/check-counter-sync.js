(() => {
  const LOG = '[CounterCheck]';
  const SAVE_STATE_KEY = 'playtester_savestate';

  const COUNTER_KEYS = [
    'life', 'energy', 'rad', 'experience', 'poison', 'tickets',
    'commanderDamage1', 'commanderDamage2', 'commanderDamage3',
    'mana', 'turn', 'game',
  ];

  // 1. Decode the save-state blob (handle URL-safe base64)
  console.log(LOG, '=== Step 1: Decode save-state blob ===');
  const raw = localStorage.getItem(SAVE_STATE_KEY);
  let blobData = null;
  if (raw) {
    try {
      const standard = raw.replace(/-/g, '+').replace(/_/g, '/');
      const json = atob(standard);
      blobData = JSON.parse(json);
      console.log(LOG, 'Blob top-level keys:', Object.keys(blobData));
      const counterInBlob = {};
      for (const key of COUNTER_KEYS) {
        if (key in blobData) {
          counterInBlob[key] = blobData[key];
        }
      }
      if (Object.keys(counterInBlob).length > 0) {
        console.log(LOG, 'Counter values IN blob:', counterInBlob);
      } else {
        console.log(LOG, 'NO counter keys found in blob top level');
        console.log(LOG, 'Searching nested...', JSON.stringify(blobData).slice(0, 500));
      }
    } catch (e) {
      console.warn(LOG, 'Decode failed:', e.message);
    }
  } else {
    console.warn(LOG, 'No save-state in localStorage');
  }

  // 2. Find the playtester component instance and dump its counter state
  console.log(LOG, '\n=== Step 2: Playtester instance state ===');
  const visited = new Set();
  const nodes = document.querySelectorAll('*');
  let playtesterInstance = null;

  for (const node of nodes) {
    for (const key in node) {
      if (!key.startsWith('__reactFiber$')) continue;
      const stack = [node[key]];
      while (stack.length > 0) {
        const fiber = stack.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        if (fiber.stateNode?.state && typeof fiber.stateNode.state === 'object') {
          const stateKeys = Object.keys(fiber.stateNode.state);
          if (stateKeys.includes('life') && stateKeys.includes('zones') && stateKeys.includes('poison')) {
            playtesterInstance = fiber.stateNode;
            const counters = {};
            for (const k of COUNTER_KEYS) {
              if (k in fiber.stateNode.state) {
                counters[k] = fiber.stateNode.state[k];
              }
            }
            console.log(LOG, 'Playtester counter state:', counters);

            const proto = Object.getPrototypeOf(fiber.stateNode);
            if (proto && proto !== Object.prototype) {
              const methods = Object.getOwnPropertyNames(proto).filter(k => {
                if (k === 'constructor') return false;
                try {
                  return typeof Object.getOwnPropertyDescriptor(proto, k)?.value === 'function';
                } catch { return false; }
              });
              console.log(LOG, 'Playtester methods:', methods);
            }

            // Check for handleRestoreSaveState specifically
            const inst = fiber.stateNode;
            const allProps = [];
            let obj = inst;
            while (obj && obj !== Object.prototype) {
              allProps.push(...Object.getOwnPropertyNames(obj));
              obj = Object.getPrototypeOf(obj);
            }
            const saveRelated = [...new Set(allProps)].filter(k =>
              /save|restore|state|persist|serial/i.test(k)
            );
            console.log(LOG, 'Save/restore related props:', saveRelated);

            // Check if handleRestoreSaveState exists (possibly minified)
            const restoreFn = allProps.find(k => {
              try {
                const val = inst[k];
                if (typeof val !== 'function') return false;
                const src = val.toString();
                return src.includes(SAVE_STATE_KEY) || src.includes('savestate') || src.includes('SaveState');
              } catch { return false; }
            });
            if (restoreFn) {
              console.log(LOG, 'Found restore function:', restoreFn, inst[restoreFn].toString().slice(0, 200));
            }
          }
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
    }
    if (playtesterInstance) break;
  }

  if (!playtesterInstance) {
    console.warn(LOG, 'Could not find playtester instance');
    return;
  }

  // 3. Check what handleSaveSaveState puts into localStorage
  console.log(LOG, '\n=== Step 3: Test save/restore cycle ===');
  const allMethods = [];
  let obj2 = playtesterInstance;
  while (obj2 && obj2 !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(obj2)) {
      try {
        if (typeof obj2[name] === 'function' && name !== 'constructor') {
          const src = obj2[name].toString().slice(0, 300);
          if (src.includes('localStorage') || src.includes(SAVE_STATE_KEY)) {
            console.log(LOG, `Method "${name}" references localStorage:`, src.slice(0, 200));
          }
        }
      } catch {}
    }
    obj2 = Object.getPrototypeOf(obj2);
  }

  // Store instance globally for further manual inspection
  window.__PLAYTESTER_INSTANCE__ = playtesterInstance;
  console.log(LOG, 'Instance stored at window.__PLAYTESTER_INSTANCE__');
  console.log(LOG, '=== Done ===');
})();
