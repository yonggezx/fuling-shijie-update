const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installerAPI', {
  // Initialization
  onInit: (callback) => ipcRenderer.on('init', (event, data) => callback(data)),

  // Window controls
  minimize: () => ipcRenderer.invoke('minimize-window'),
  close: () => ipcRenderer.invoke('close-window'),

  // Uninstall
  startUninstall: (opts) => ipcRenderer.invoke('start-uninstall', opts),
  onUninstallProgress: (callback) => ipcRenderer.on('uninstall-progress', (event, data) => callback(data)),
});
