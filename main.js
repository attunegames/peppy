// PEPPY - Electron main process: window, tray-style notifications, and the
// IPC bridge to the Dolphin orchestrator.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

let win;
let orch;

async function orchestrator() {
  if (!orch) orch = await import("./orchestrator/dolphin.mjs");
  return orch;
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
