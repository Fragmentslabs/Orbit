"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("ipcRenderer", {
  on(channel, listener) {
    const wrapper = (_event, ...args) => listener(...args);
    electron.ipcRenderer.on(channel, wrapper);
    return wrapper;
  },
  off(channel, wrapper) {
    electron.ipcRenderer.removeListener(channel, wrapper);
  },
  send(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.send(channel, ...omit);
  },
  invoke(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.invoke(channel, ...omit);
  }
});
