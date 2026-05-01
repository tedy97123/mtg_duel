const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loginBridge', {
  loginWithDiscord() {
    ipcRenderer.send('auth:login');
  },
  skipLogin() {
    ipcRenderer.send('auth:skip');
  },
  onAuthResult(callback) {
    ipcRenderer.on('auth:result', (_event, data) => callback(data));
  },
});