'use strict';
// contextIsolation is false so preload and renderer share the same JS context.
// We set window.electronAPI directly — contextBridge is not available here.
const { ipcRenderer } = require('electron');

window.electronAPI = {
  quit: () => ipcRenderer.send('quit-app'),
};
