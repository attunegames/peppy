// PEPPY - Electron main process: window, tray-style notifications, and the
// IPC bridge to the Dolphin orchestrator.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

let win;
let orch;
let net;
let pollTimer = null;
let watchedChallenge = null;

async function orchestrator() {
  if (!orch) orch = await import("./orchestrator/dolphin.mjs");
  return orch;
}

async function network() {
  if (!net) net = await import("./orchestrator/peppynet.mjs");
  return net;
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 780,
    resizable: true,
    autoHideMenuBar: true,
    title: "Peppy",
    backgroundColor: "#101418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("renderer/index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", async () => {
  (await orchestrator()).killAll();
  app.quit();
});

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---- IPC ----

ipcMain.handle("notify-blink", () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

ipcMain.handle("slippi-info", async () => {
  const d = await orchestrator();
  try {
    const { isoPath } = d.findSlippi();
    return { ok: true, isoPath, characters: d.CHARACTERS };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err), characters: d.CHARACTERS };
  }
});

// Launch a direct match: hidden Dolphin, revealed once actually connected.
ipcMain.handle("launch-match", async (_ev, { opponentCode, stageId, character }) => {
  const d = await orchestrator();
  try {
    const { isoPath } = d.ensureSandbox();
    d.writeMatchConfigs({ opponentCode, stageId, character });
    const pid = d.launch({ isoPath });
    d.hideUntilConnected(pid, (state) => send("match-state", state));
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle("kill-dolphin", async () => {
  (await orchestrator()).killAll();
  return { ok: true };
});

// ---- shared server (optional: the app works offline without it) ----

const netCall = async (fn) => {
  try {
    return { ok: true, data: await fn(await network()) };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
};

ipcMain.handle("net-connect", async () => {
  const n = await network();
  const res = await n.connect();
  if (res.ok && !pollTimer) startPolling();
  return res;
});

ipcMain.handle("net-claim", (_e, { code, name }) =>
  netCall((n) => n.claimCode(code, name)));
ipcMain.handle("net-heartbeat", (_e, { character, stage }) =>
  netCall((n) => n.heartbeat(character, stage)));
ipcMain.handle("net-queue", (_e, { action }) =>
  netCall((n) => action === "join" ? n.queueJoin()
    : action === "spectate" ? n.queueSpectate() : n.queueLeave()));
ipcMain.handle("net-queue-list", () => netCall((n) => n.queueList()));
ipcMain.handle("net-friends", () => netCall((n) => n.friendList()));
ipcMain.handle("net-recent", () => netCall((n) => n.recentList()));
ipcMain.handle("net-friend-add", (_e, { code }) =>
  netCall((n) => n.friendAdd(code)));
ipcMain.handle("net-record-played", (_e, { code }) =>
  netCall((n) => n.recordPlayed(code)));

ipcMain.handle("net-challenge", async (_e, { code, stage }) => {
  const res = await netCall((n) => n.challengeCreate(code, stage));
  if (res.ok) watchedChallenge = res.data?.id ?? null;
  return res;
});
ipcMain.handle("net-respond", async (_e, { id, accept }) => {
  const res = await netCall((n) => n.challengeRespond(id, accept));
  return res;
});
ipcMain.handle("net-cancel", async (_e, { id }) => {
  watchedChallenge = null;
  return netCall((n) => n.challengeCancel(id ?? watchedChallenge));
});

// One poll loop for the whole app: keeps presence alive, watches for an
// incoming challenge (which makes the window blink) and for our own outgoing
// challenge being accepted.
function startPolling() {
  pollTimer = setInterval(async () => {
    try {
      const n = await network();
      if (!n.status().player) return;
      await n.heartbeat();
      const { incoming, outgoing } = await n.poll(watchedChallenge);
      if (incoming) {
        send("net-incoming", incoming);
        if (win && !win.isFocused()) win.flashFrame(true);
      }
      if (outgoing && outgoing.state !== "pending") {
        send("net-outgoing", outgoing);
        if (outgoing.state !== "accepted") watchedChallenge = null;
      }
    } catch { /* offline; the UI keeps working for direct challenges */ }
  }, 4000);
}
