// PEPPY - Electron main process: window, tray-style notifications, and the
// IPC bridge to the Dolphin orchestrator.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

let win;
let orch;
let net;
let pollTimer = null;
let watchedChallenge = null;
let announcePairing = null;    // dedupes the poll's pairing signals
let matchContext = null;       // { opponentCode, startedAt } while a game runs
let stopGameWatch = null;      // ends the per-game watcher

async function orchestrator() {
  if (!orch) orch = await import("./orchestrator/dolphin.mjs");
  return orch;
}

async function spectating() {
  return import("./orchestrator/spectate.mjs");
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
  // Step out of the queue on the way out: the server would sweep us after 90
  // seconds anyway, but people were being paired with an app that had closed.
  try {
    const n = await network();
    if (n.status().player) await Promise.race([
      n.queueLeave(),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch { /* offline, or never connected */ }
  (await orchestrator()).killAll();
  app.quit();
});

ipcMain.on("renderer-log", (_e, msg) => console.log("[ui]", msg));

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---- IPC ----

ipcMain.handle("notify-blink", () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

ipcMain.handle("slippi-info", async () => {
  const d = await orchestrator();
  const identity = d.readSlippiIdentity();   // who this PC is logged in as
  try {
    const { isoPath } = d.findSlippi();
    return { ok: true, isoPath, characters: d.CHARACTERS, identity };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err), characters: d.CHARACTERS, identity };
  }
});

// Launch a direct match: hidden Dolphin, revealed once actually connected.
ipcMain.handle("launch-match", async (_ev, { opponentCode, stageId, character, color,
                                            stagePicker = true, windowMode = "maximized" }) => {
  const d = await orchestrator();
  try {
    // Never restart a match that is already running: relaunching kills the
    // Dolphin the player is sitting in. It has to be a LIVE match, though -
    // when this only checked matchContext, a match whose end went unnoticed
    // wedged every later launch on "setting up your match" until Peppy was
    // restarted.
    if (matchContext && matchContext.opponentCode === opponentCode && d.isRunning()) {
      console.log("[match] already running vs", opponentCode, "- ignoring relaunch");
      return { ok: true, alreadyRunning: true };
    }
    // Close any Dolphin still running FIRST: on Windows a live process holds
    // its config and log files open, and writing them then fails with EBUSY.
    d.killAll();
    await new Promise((r) => setTimeout(r, 400));
    const { isoPath } = d.ensureSandbox();
    d.writeMatchConfigs({ opponentCode, stageId, character, color, stagePicker, windowMode });
    const pid = d.launch({ isoPath });
    // remember what this match was, so the result can be read afterwards
    matchContext = { opponentCode, startedAt: Date.now() };
    startCasting();          // let spectators watch (best effort)
    watchGamesLive();        // the rotation moves on its own, mid-session
    d.hideUntilConnected(pid, async (state) => {
      send("match-state", state);
      if (state === "gone") await finishMatch();
    });
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

/**
 * Report each game as it finishes, and step aside when the queue needs the
 * setup.
 *
 * The rotation used to wait for Dolphin to close: a set ended when someone
 * remembered to quit out, and everyone waiting waited on that. Now Peppy sees
 * each game end, reports it, and asks the server whether these two should keep
 * going. Two people alone keep playing untouched. With someone else waiting,
 * the server puts both back in the queue - and then the game closes itself and
 * the next pairing goes out.
 */
async function watchGamesLive() {
  stopWatchingGames();
  const ctx = matchContext;
  if (!ctx) return;
  const replays = await import("./orchestrator/replays.mjs");
  const identity = (await orchestrator()).readSlippiIdentity();
  if (!identity) return;

  stopGameWatch = replays.watchGames({
    sinceMs: ctx.startedAt - 5000,
    myCode: identity.connectCode,
    opponentCode: ctx.opponentCode,
    onGame: async (result) => {
      let swept = false, sweeps = 0;
      try {
        const n = await network();
        const [row] = await n.reportResult(ctx.opponentCode, result.iWon, result.matchKey);
        swept = row?.swept ?? false;
        sweeps = row?.sweeps ?? 0;
      } catch { /* offline: the game still happened, the queue will resync */ }
      send("match-result", {
        opponentCode: ctx.opponentCode, iWon: result.iWon, swept, sweeps, source: "replay",
      });
      await maybeEndSession();
    },
  });
}

function stopWatchingGames() {
  if (stopGameWatch) { try { stopGameWatch(); } catch { /* already stopped */ } }
  stopGameWatch = null;
}

/**
 * Does the queue want this setup back? The server decides: it leaves two
 * players alone and only puts a pair back in the queue when someone else is
 * waiting. If it has, close the game so the next match can start - after a few
 * seconds, so nobody is yanked off the results screen.
 */
async function maybeEndSession() {
  let stillPlaying = true;
  try {
    const n = await network();
    const me = n.status().player;
    const rows = await n.queueList();
    const mine = rows?.find((r) => r.player_id === me?.id);
    stillPlaying = !mine || mine.state === "playing";
  } catch {
    return;               // can't ask: leave them playing
  }
  if (stillPlaying) return;

  send("session-over", { opponentCode: matchContext?.opponentCode ?? null });
  stopWatchingGames();
  await new Promise((r) => setTimeout(r, 6000));   // let the results screen sit
  matchContext = null;
  (await orchestrator()).killAll();
}

// Share our live match so people in the queue can watch. Entirely optional:
// any failure here is logged and ignored, never affecting the match.
async function startCasting() {
  try {
    const n = await network();
    const me = n.status().player;
    if (!me) return;
    const sp = await spectating();
    const publish = await n.startCast(me.id);
    // Dolphin only opens its live feed once the game is up.
    setTimeout(() => sp.startBroadcast(publish, (st) => send("cast-state", st)), 8000);
  } catch (err) {
    console.log("[cast] not broadcasting:", err.message ?? err);
  }
}

async function stopCasting() {
  try {
    (await spectating()).stopBroadcast();
    (await network()).stopCast();
  } catch { /* nothing to stop */ }
}

// Melee closed. Find the replay it just wrote and report who won; if the
// replay cannot be read, ask the player rather than guessing.
async function finishMatch() {
  stopWatchingGames();
  await stopCasting();
  const ctx = matchContext;
  matchContext = null;
  if (!ctx) return;
  const n = await network();
  if (!n.status().player) return;

  const replays = await import("./orchestrator/replays.mjs");
  const identity = (await orchestrator()).readSlippiIdentity();
  // Slippi flushes the file on exit; give it a moment.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const file = replays.findReplaySince(ctx.startedAt - 60000);
    if (!file || !identity) continue;
    const result = replays.readResult(file, identity.connectCode, ctx.opponentCode);
    if (!result) continue;
    try {
      const [row] = await n.reportResult(ctx.opponentCode, result.iWon, result.matchKey);
      send("match-result", {
        opponentCode: ctx.opponentCode, iWon: result.iWon,
        swept: row?.swept ?? false, sweeps: row?.sweeps ?? 0, source: "replay",
      });
    } catch { /* server unhappy; the poll loop will resync */ }
    return;
  }
  // Couldn't tell from the replay - maybe they quit before a game finished, or
  // closed Dolphin outright. Either way the match is over, so step out of
  // 'playing' rather than sitting there as a match nobody is in. (Rejoining as
  // 'waiting' keeps your place: joined_at only moves if you were spectating.)
  try { await n.queueJoin(); } catch { /* offline; the poll loop resyncs */ }
  send("ask-result", { opponentCode: ctx.opponentCode });
}

// Watch someone else's match: subscribe to their stream, rebuild it locally,
// and open Slippi's playback build once there is something to show.
ipcMain.handle("spectate-start", async (_e, { playerId, name }) => {
  try {
    const sp = await spectating();
    if (!sp.playbackAvailable()) {
      return { ok: false, error: "Slippi's playback build isn't installed - open the Slippi Launcher once." };
    }
    const n = await network();
    const d = await orchestrator();
    sp.startWatching();
    let opened = false, bytes = 0;
    await n.watchCast(playerId, (b64) => {
      bytes += Math.floor(b64.length * 0.75);
      const file = sp.feed(b64);
      // wait for a little data so playback has a real game to chase
      if (!opened && file && bytes > 40000) {
        opened = true;
        const { isoPath } = d.findSlippi();
        const res = sp.openPlayback(isoPath, file);
        send("spectate-state", res.ok ? { state: "watching", name } : { state: "error", error: res.error });
      }
    });
    send("spectate-state", { state: "connecting", name });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
});

ipcMain.handle("spectate-stop", async () => {
  try {
    (await spectating()).stopWatching();
    (await network()).stopWatchCast();
  } catch { /* already stopped */ }
  send("spectate-state", { state: "stopped" });
  return { ok: true };
});

// Escape hatch: if the automatic reveal ever misses, the player can ask for
// the window by hand instead of sitting in a match they can only hear.
ipcMain.handle("reveal-match", async () => (await orchestrator()).revealNow());

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

// The rotation proposed a match: accepting is also your ready, so when both
// sides have accepted the game launches by itself.
ipcMain.handle("net-pairing-respond", async (_e, { id, accept }) => {
  const res = await netCall((n) => n.pairingRespond(id, accept));
  if (!accept) lastPairingId = null;
  return res;
});

// Who won? Read it out of the replay Slippi just wrote, and only ask the
// player if that fails.
ipcMain.handle("report-result", async (_e, { opponentCode, iWon, matchKey }) =>
  netCall((n) => n.reportResult(opponentCode, iWon, matchKey)));

// One poll loop for the whole app: keeps presence alive, watches for an
// incoming challenge (which makes the window blink) and for our own outgoing
// challenge being accepted.
async function startPolling() {
  const { makePairingGate } = await import("./orchestrator/pairing-gate.mjs");
  announcePairing = makePairingGate();
  pollTimer = setInterval(async () => {
    try {
      const n = await network();
      if (!n.status().player) return;
      await n.heartbeat();
      const { incoming, outgoing, pairing } = await n.poll(watchedChallenge);

      // Announce each pairing once. It stays 'ready' on the server for the
      // whole match, so sending it every tick would relaunch Melee every tick.
      const signal = announcePairing(pairing);
      if (signal === "pending") {
        send("net-pairing", pairing);
        if (win && !win.isFocused()) win.flashFrame(true);
      }
      if (signal === "ready") send("net-pairing-ready", pairing);   // the go signal

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
