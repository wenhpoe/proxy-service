const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proxyApi', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: (opts) => ipcRenderer.invoke('update:check', opts || {}),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateLog: () => ipcRenderer.invoke('update:openLog'),
  onUpdateStatus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_evt, status) => cb(status);
    ipcRenderer.on('app:updateStatus', fn);
    return () => ipcRenderer.removeListener('app:updateStatus', fn);
  },
});

