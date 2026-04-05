'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Enforce single instance when packaged — second launch focuses the existing window.
// In dev (!app.isPackaged) multiple instances are allowed for local testing.
const gotLock = !app.isPackaged ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 450,
    title: 'HeatSync',
    show: false,           // hold until first paint — avoids blank window on startup
    backgroundColor: '#12121e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, '../electron-app/preload.js'),
    },
  });

  win.once('ready-to-show', () => win.show());
  win.maximize();
  win.loadFile(path.join(__dirname, '../electron-app/index.html'));

  // Uncomment to open DevTools:
  // win.webContents.openDevTools();
}

ipcMain.on('quit-app', () => app.quit());

app.on('second-instance', () => {
  // A second instance was launched — bring the existing window to front.
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
