const { contextBridge, ipcRenderer } = require('electron');

const raw = process.argv.find(a => a.startsWith('--waiting-params='));
const params = raw ? JSON.parse(raw.replace('--waiting-params=', '')) : {
  code: '----', role: 'host', deck: '', decks: [], selectedDeckId: null,
};

contextBridge.exposeInMainWorld('waitingRoomBridge', {
  getParams() { return params; },

  onStatus(callback) {
    ipcRenderer.on('waiting:status', (_event, data) => callback(data));
  },

  onPrefilledCode(callback) {
    ipcRenderer.on('waiting:prefill-code', (_event, data) => callback(data));
  },

  createRoom(deckUrl, deckId, isPublic) {
    ipcRenderer.send('waiting:create-room', { deckUrl, deckId, isPublic });
  },

  joinRoom(code, deckUrl, deckId) {
    ipcRenderer.send('waiting:join-room', { code, deckUrl, deckId });
  },

  startGame() {
    ipcRenderer.send('waiting:start');
  },

  launchGame() {
    ipcRenderer.send('waiting:launch');
  },

  browseLobbies() {
    ipcRenderer.send('waiting:browse-lobbies');
  },
});