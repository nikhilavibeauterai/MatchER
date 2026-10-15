const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('matcherDesktop', Object.freeze({
  chooseFolder: () => ipcRenderer.invoke('matcher:choose-folder'),
}));
