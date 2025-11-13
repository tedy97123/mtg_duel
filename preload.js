// Preload runs in an isolated world with access to the page DOM.
// We inject a tiny "MF" activator button and a popup panel that toggles.
(function() {
	'use strict';

	function ensureStyle() {
		if (document.getElementById('mtgduel-electron-style')) return;
		const style = document.createElement('style');
		style.id = 'mtgduel-electron-style';
		style.textContent = `
			#mtgduel-activator {
				position: fixed; top: 12px; left: 12px; z-index: 2147483647;
				width: 36px; height: 30px; line-height: 30px; text-align: center;
				background: #1976d2; color: #fff; border: none; border-radius: 6px;
				box-shadow: 0 2px 8px rgba(0,0,0,0.35); font: 12px system-ui, -apple-system, Segoe UI, Roboto, Arial;
				font-weight: 700; cursor: pointer;
			}
			#mtgduel-popup {
				position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
				width: 300px; background: #0f1115; color: #e6e6e6;
				border: 1px solid #2b2f3a; border-radius: 10px; padding: 10px;
				box-shadow: 0 6px 18px rgba(0,0,0,0.35);
				font: 12px system-ui, -apple-system, Segoe UI, Roboto, Arial;
			}
			#mtgduel-popup header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
			#mtgduel-popup header strong { font-weight:600; }
			#mtgduel-popup .row { display:flex; gap:8px; }
			#mtgduel-popup .row > button {
				flex:1; padding:6px; background:#2e7d32; color:#fff; border:none; border-radius:6px; cursor:pointer;
			}
			#mtgduel-popup .row > button.secondary {
				background:#b71c1c;
			}
		`;
		document.head.appendChild(style);
	}

	function appendToBody(node) {
		if (document.body) {
			document.body.appendChild(node);
			return;
		}
		const obs = new MutationObserver(() => {
			if (document.body) {
				document.body.appendChild(node);
				obs.disconnect();
			}
		});
		obs.observe(document.documentElement || document, { childList: true, subtree: true });
	}

	function buildActivator() {
		if (document.getElementById('mtgduel-activator')) return;
		const a = document.createElement('button');
		a.id = 'mtgduel-activator';
		a.textContent = 'MF';
		a.title = 'Show MTGDuel popup';
		a.addEventListener('click', togglePopup);
		appendToBody(a);
	}

	function buildPopup() {
		if (document.getElementById('mtgduel-popup')) return;
		const box = document.createElement('div');
		box.id = 'mtgduel-popup';
		box.style.display = 'none';
		box.innerHTML = `
			<header>
				<div style="width:8px;height:8px;border-radius:50%;background:#ef5350"></div>
				<strong>MTGDuel</strong>
				<div style="margin-left:auto;font-size:11px;color:#9fb3c8">Electron</div>
			</header>
			<div style="color:#9fb3c8; margin-bottom:8px;">Hello from Electron preload. This is a test popup.</div>
			<div class="row">
				<button id="mtgduel-ok">OK</button>
				<button class="secondary" id="mtgduel-close">Close</button>
			</div>
		`;
		box.querySelector('#mtgduel-ok').addEventListener('click', () => {
			alert('Button works!');
		});
		box.querySelector('#mtgduel-close').addEventListener('click', togglePopup);
		appendToBody(box);
	}

	function togglePopup() {
		const box = document.getElementById('mtgduel-popup');
		if (!box) return;
		box.style.display = (box.style.display === 'none' || box.style.display === '') ? 'block' : 'none';
	}

	function init() {
		try {
			ensureStyle();
			buildPopup();
			buildActivator();
		} catch (e) {
			console.error('[mtgduel-electron] preload init error', e);
		}
	}

	// Initial load
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	// SPA navigation robustness: re-inject if DOM is replaced
	const mo = new MutationObserver(() => {
		if (!document.getElementById('mtgduel-activator')) {
			init();
		}
	});
	mo.observe(document.documentElement, { childList: true, subtree: true });
})();


