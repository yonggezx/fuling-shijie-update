const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installerAPI', {
  // Initialization
  onInit: (callback) => ipcRenderer.on('init', (event, data) => callback(data)),

  // Window controls
  minimize: () => ipcRenderer.invoke('minimize-window'),
  close: () => ipcRenderer.invoke('close-window'),

  // Install
  browseDirectory: () => ipcRenderer.invoke('browse-directory'),
  getDiskSpace: (dirPath) => ipcRenderer.invoke('get-disk-space', dirPath),
  startInstall: (opts) => ipcRenderer.invoke('start-install', opts),
  onInstallProgress: (callback) => ipcRenderer.on('install-progress', (event, data) => callback(data)),

  // Uninstall
  startUninstall: (opts) => ipcRenderer.invoke('start-uninstall', opts),
  onUninstallProgress: (callback) => ipcRenderer.on('uninstall-progress', (event, data) => callback(data)),

  // Launch app
  launchApp: (installPath) => ipcRenderer.invoke('launch-app', { installPath }),
});
