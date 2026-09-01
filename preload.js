const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("peppy", {
  slippiInfo: () => ipcRenderer.invoke("slippi-info"),
  launchMatch: (opts) => ipcRenderer.invoke("launch-match", opts),
  killDolphin: () => ipcRenderer.invoke("kill-dolphin"),
  notifyBlink: () => ipcRenderer.invoke("notify-blink"),
  onMatchState: (cb) => ipcRenderer.on("match-state", (_e, state) => cb(state)),
});
