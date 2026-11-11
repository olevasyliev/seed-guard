// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seedGuard', {
  access: (sources) => ipcRenderer.invoke('access', sources),
  scan: (plan) => ipcRenderer.invoke('scan', plan),
  pause: (value) => ipcRenderer.invoke('pause', value),
  open: (id) => ipcRenderer.invoke('open', id),
  restart: () => ipcRenderer.invoke('restart'),
  theme: (t) => ipcRenderer.invoke('theme', t),
  state: () => ipcRenderer.invoke('state'),
  icons: () => ipcRenderer.invoke('icons'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
