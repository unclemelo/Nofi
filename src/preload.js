const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayAPI", {
  getSession: () => ipcRenderer.invoke("auth:getSession"),
  getBundledClientId: () => ipcRenderer.invoke("config:getClientId"),
  startAuth: (config) => ipcRenderer.invoke("auth:start", config),
  logout: () => ipcRenderer.invoke("auth:logout"),
  connectTwitch: (settings) => ipcRenderer.invoke("twitch:connect", settings),
  disconnectTwitch: () => ipcRenderer.invoke("twitch:disconnect"),
  emitTestNotification: () => ipcRenderer.invoke("overlay:testNotification"),
  emitTestNotificationByType: (type) => ipcRenderer.invoke("overlay:testNotificationByType", type),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  updater: {
    getStatus: () => ipcRenderer.invoke("updater:getStatus"),
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
    onStatus: (callback) => {
      const wrapped = (_event, payload) => callback(payload);
      ipcRenderer.on("update:status", wrapped);
      return () => ipcRenderer.removeListener("update:status", wrapped);
    }
  },
  onSettingsUpdate: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on("settings:update", wrapped);
    return () => ipcRenderer.removeListener("settings:update", wrapped);
  },
  onEvent: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay:event", wrapped);
    return () => ipcRenderer.removeListener("overlay:event", wrapped);
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChange: (callback) => {
      const wrapped = (_event, val) => callback(val);
      ipcRenderer.on("window:maximizeChange", wrapped);
      return () => ipcRenderer.removeListener("window:maximizeChange", wrapped);
    }
  }
});
