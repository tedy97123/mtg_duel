const { contextBridge, ipcRenderer } = require('electron');

const raw = process.argv.find(a => a.startsWith('--waiting-params='));
const params = raw ? JSON.parse(raw.replace('--waiting-params=', '')) : { code: '----', role: 'host' };

contextBridge.exposeInMainWorld('waitingRoomBridge', {
  getParams() { return params; },
  onStatus(callback) {
    ipcRenderer.on('waiting:status', (_event, data) => callback(data));
  },
  startGame() { ipcRenderer.send('waiting:start'); },
  launchGame() { ipcRenderer.send('waiting:launch'); },
});