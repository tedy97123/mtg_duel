const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  LOBBY_CREATE: 'lobby:create-room',
  LOBBY_JOIN: 'lobby:join-room',
  LOBBY_STATUS: 'lobby:status',
};

contextBridge.exposeInMainWorld('lobbyBridge', {
  createRoom(deckUrl) {
    ipcRenderer.send(CHANNELS.LOBBY_CREATE, { deckUrl });
  },
  joinRoom(code, deckUrl) {
    ipcRenderer.send(CHANNELS.LOBBY_JOIN, { code, deckUrl });
  },
  onStatus(callback) {
    ipcRenderer.on(CHANNELS.LOBBY_STATUS, (_event, data) => callback(data));
  },
});
