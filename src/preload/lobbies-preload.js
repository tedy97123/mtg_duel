const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lobbiesBridge', {
  joinLobby(code) {
    ipcRenderer.send('lobbies:join', { code });
  },
  goBack() {
    ipcRenderer.send('lobbies:back');
  },
});