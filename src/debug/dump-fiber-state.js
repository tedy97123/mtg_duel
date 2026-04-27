(() => {
  const LOG = '[FiberDump]';
  const SAVE_STATE_KEY = 'playtester_savestate';

  // 1. Decode the save-state blob from localStorage
  console.log(LOG, '=== Step 1: Decode localStorage save-state ===');
  const raw = localStorage.getItem(SAVE_STATE_KEY);
  if (raw) {
    try {
      const json = atob(raw);
      const parsed = JSON.parse(json);
      console.log(LOG, 'Save-state top-level keys:', Object.keys(parsed));
      for (const [k, v] of Object.entries(parsed)) {
        const type = Array.isArray(v) ? `Array(${v.length})` : typeof v;
        const preview = typeof v === 'object' ? JSON.stringify(v)?.slice(0, 200) : String(v);
        console.log(`  ${k} [${type}]:`, preview);
      }
    } catch (e) {
      console.warn(LOG, 'Failed to decode save-state:', e.message);
      console.log(LOG, 'Raw (first 200 chars):', raw.slice(0, 200));
    }
  } else {
    console.warn(LOG, 'No save-state found in localStorage');
  }

  // 2. Find the life counter element and trace its fiber
  console.log(LOG, '\n=== Step 2: Find life/counter DOM elements ===');
  const selectors = [
    { label: 'life total (by text "40" or "20")', fn: () => {
      return [...document.querySelectorAll('*')].find(el => {
        const text = el.textContent?.trim();
        return (text === '40' || text === '20') && el.children.length === 0 && el.offsetWidth > 0;
      });
    }},
    { label: 'input[type=number]', fn: () => document.querySelector('input[type="number"]') },
    { label: '[class*=life]', fn: () => document.querySelector('[class*="life" i]') },
    { label: '[class*=counter]', fn: () => document.querySelector('[class*="counter" i]') },
    { label: '[class*=poison]', fn: () => document.querySelector('[class*="poison" i]') },
    { label: '[data-testid*=life]', fn: () => document.querySelector('[data-testid*="life" i]') },
  ];

  for (const { label, fn } of selectors) {
    try {
      const el = fn();
      if (el) {
        console.log(LOG, `Found "${label}":`, el.tagName, el.className?.slice?.(0, 80), `text="${el.textContent?.trim().slice(0, 30)}"`);
        traceFiber(el);
      }
    } catch {}
  }

  // 3. Dump ALL 53 components flat (no collapsed groups)
  console.log(LOG, '\n=== Step 3: All class component instances (flat) ===');
  const visited = new Set();
  const nodes = document.querySelectorAll('*');
  let count = 0;
  for (const node of nodes) {
    for (const key in node) {
      if (!key.startsWith('__reactFiber$')) continue;
      const stack = [node[key]];
      while (stack.length > 0) {
        const fiber = stack.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        if (fiber.stateNode && typeof fiber.stateNode === 'object' && !(fiber.stateNode instanceof HTMLElement)) {
          const name = fiber.type?.displayName || fiber.type?.name || '(anon)';
          const proto = Object.getPrototypeOf(fiber.stateNode);
          let methods = [];
          if (proto && proto !== Object.prototype) {
            methods = Object.getOwnPropertyNames(proto).filter(k => {
              if (k === 'constructor') return false;
              try { return typeof Object.getOwnPropertyDescriptor(proto, k)?.value === 'function'; } catch { return false; }
            });
          }
          if (methods.length > 0) {
            const stateKeys = fiber.stateNode.state ? Object.keys(fiber.stateNode.state) : [];
            console.log(`  [${count}] ${name}  methods:[${methods.join(',')}]  stateKeys:[${stateKeys.join(',')}]`);
            count++;
          }
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
    }
  }
  console.log(LOG, `Total: ${count} class instances with methods`);

  // 4. Find any component whose state has numeric values (possible counters)
  console.log(LOG, '\n=== Step 4: Instances with numeric state values ===');
  visited.clear();
  for (const node of nodes) {
    for (const key in node) {
      if (!key.startsWith('__reactFiber$')) continue;
      const stack = [node[key]];
      while (stack.length > 0) {
        const fiber = stack.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        if (fiber.stateNode?.state && typeof fiber.stateNode.state === 'object') {
          const numericEntries = Object.entries(fiber.stateNode.state).filter(([, v]) => typeof v === 'number');
          if (numericEntries.length > 0) {
            const name = fiber.type?.displayName || fiber.type?.name || '(anon)';
            console.log(`  ${name} numeric state:`, Object.fromEntries(numericEntries));
          }
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
    }
  }

  function traceFiber(el) {
    for (const key in el) {
      if (!key.startsWith('__reactFiber$')) continue;
      let fiber = el[key];
      let depth = 0;
      console.log(LOG, '  Fiber chain from element:');
      while (fiber && depth < 10) {
        const name = fiber.type?.displayName || fiber.type?.name || (typeof fiber.type === 'string' ? `<${fiber.type}>` : '(anon)');
        const hasState = !!fiber.memoizedState;
        const proto = fiber.stateNode && typeof fiber.stateNode === 'object' && !(fiber.stateNode instanceof HTMLElement)
          ? Object.getPrototypeOf(fiber.stateNode) : null;
        let methods = [];
        if (proto && proto !== Object.prototype) {
          methods = Object.getOwnPropertyNames(proto).filter(k => {
            if (k === 'constructor') return false;
            try { return typeof Object.getOwnPropertyDescriptor(proto, k)?.value === 'function'; } catch { return false; }
          });
        }
        const info = [
          hasState ? 'hasState' : '',
          methods.length > 0 ? `methods:[${methods.join(',')}]` : '',
        ].filter(Boolean).join(' ');
        console.log(`    ${'  '.repeat(depth)}↑ ${name} ${info}`);
        fiber = fiber.return;
        depth++;
      }
      break;
    }
  }

  console.log(LOG, '=== Done ===');
})();
