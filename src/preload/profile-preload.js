const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profileBridge', {
  async getProfile() {
    return ipcRenderer.invoke('profile:get');
  },
  async addDeck(name, url) {
    return ipcRenderer.invoke('profile:add-deck', { name, url });
  },
  async deleteDeck(id) {
    return ipcRenderer.invoke('profile:delete-deck', { id });
  },
  selectDeck(id, url) {
    ipcRenderer.send('profile:select-deck', { id, url });
  },
  goToWaitingRoom() {
    ipcRenderer.send('profile:play');
  },
  logout() {
    ipcRenderer.send('auth:logout');
  },
});
