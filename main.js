// Electron main process - creates a window that loads Moxfield and injects a preload
const { app, BrowserWindow } = require('electron');
const path = require('path');

// Change this to any Moxfield URL you want to land on
const START_URL = process.env.START_URL || 'https://moxfield.com/';

function createWindow() {
	const win = new BrowserWindow({
		width: 1400,
		height: 900,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			devTools: true
		}
	});

	win.loadURL(START_URL);

	// Optional: open devtools on start
	if (process.env.ELECTRON_DEVTOOLS === '1') {
		win.webContents.openDevTools({ mode: 'bottom' });
	}
}

app.whenReady().then(() => {
	createWindow();
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});


