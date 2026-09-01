const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("peppy", {
  // game
  slippiInfo: () => ipcRenderer.invoke("slippi-info"),
  launchMatch: (opts) => ipcRenderer.invoke("launch-match", opts),
  killDolphin: () => ipcRenderer.invoke("kill-dolphin"),
  notifyBlink: () => ipcRenderer.invoke("notify-blink"),
  onMatchState: (cb) => ipcRenderer.on("match-state", (_e, s) => cb(s)),

  // shared server (all optional: absent/failing = offline mode)
  net: {
    connect: () => ipcRenderer.invoke("net-connect"),
    claim: (code, name) => ipcRenderer.invoke("net-claim", { code, name }),
    heartbeat: (character, stage) =>
      ipcRenderer.invoke("net-heartbeat", { character, stage }),
    queue: (action) => ipcRenderer.invoke("net-queue", { action }),
    queueList: () => ipcRenderer.invoke("net-queue-list"),
    friends: () => ipcRenderer.invoke("net-friends"),
    recent: () => ipcRenderer.invoke("net-recent"),
    friendAdd: (code) => ipcRenderer.invoke("net-friend-add", { code }),
    recordPlayed: (code) => ipcRenderer.invoke("net-record-played", { code }),
    challenge: (code, stage) => ipcRenderer.invoke("net-challenge", { code, stage }),
    respond: (id, accept) => ipcRenderer.invoke("net-respond", { id, accept }),
    cancel: (id) => ipcRenderer.invoke("net-cancel", { id }),
    onIncoming: (cb) => ipcRenderer.on("net-incoming", (_e, c) => cb(c)),
    onOutgoing: (cb) => ipcRenderer.on("net-outgoing", (_e, c) => cb(c)),
  },
});
