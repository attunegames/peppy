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
                                            stagePicker = true, windowMode = "maximized",
                                            viaQueue = false }) => {
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
    // Forget the old match before killing it, or its watcher would read the
    // kill as that player walking out and forfeit a match they already played.
    matchContext = null;
    stopWatchingGames();
    d.killAll();
    await new Promise((r) => setTimeout(r, 400));
    const { isoPath } = d.ensureSandbox();
    d.writeMatchConfigs({ opponentCode, stageId, character, color, stagePicker, windowMode });
    const pid = d.launch({ isoPath });
    // remember what this match was, so the result can be read afterwards
    // viaQueue: only a match the rotation set up answers to the rotation. Two
    // people who challenged each other directly are not interrupted because
    // somebody joined the queue, and are not watched for leaving it.
    matchContext = { opponentCode, startedAt: Date.now(), viaQueue };
    startCasting();          // let spectators watch (best effort)
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
 * Who is waiting for the setup, other than the two people playing?
 *
 * Nobody waiting means nothing to decide: the pair carries on and Peppy does
 * not look at their games at all.
 */
async function someoneIsWaiting() {
  if (!matchContext?.viaQueue) return false;
  try {
    const n = await network();
    const me = n.status().player;
    const rows = await n.queueList();
    return (rows ?? []).some((r) =>
      r.state === "waiting" && r.online !== false &&
      r.player_id !== me?.id &&
      String(r.connect_code).toUpperCase() !== String(matchContext.opponentCode).toUpperCase());
  } catch {
    return false;               // can't ask: leave them alone
  }
}

/**
 * Has the other player stopped playing?
 *
 * Their client tells the server when they close Dolphin. If they are no longer
 * marked as playing then the connection this client is sitting in is already
 * dead - they are at a character select with nobody on the other end - so the
 * game may as well close and let them back into the queue.
 *
 * Reading it from the server rather than from a disconnect message means it
 * works the same whether they closed Dolphin, closed Peppy, or their PC died.
 */
async function opponentIsGone() {
  const ctx = matchContext;
  if (!ctx?.viaQueue) return false;
  if (Date.now() - ctx.startedAt < 45000) return false;   // let the match settle
  try {
    const n = await network();
    const rows = await n.queueList();
    const them = (rows ?? []).find((r) =>
      String(r.connect_code).toUpperCase() === String(ctx.opponentCode).toUpperCase());
    return !them || them.state !== "playing";
  } catch {
    return false;               // can't ask: assume they are still there
  }
}

/** They left. Close the dead game and put this player back in the queue. */
async function opponentLeft() {
  const ctx = matchContext;
  if (!ctx) return;
  matchContext = null;          // Peppy is closing this one, not the player
  stopWatchingGames();
  console.log("[queue]", ctx.opponentCode, "is gone - closing this match");
  send("opponent-left", { opponentCode: ctx.opponentCode });

  // Report the last game if it finished and nobody has said so yet; the server
  // discards it if the other client already did.
  try {
    const n = await network();
    const replays = await import("./orchestrator/replays.mjs");
    const identity = (await orchestrator()).readSlippiIdentity();
    const file = replays.findReplaySince(ctx.startedAt - 60000);
    if (file && identity && replays.isFinished(file)) {
      const result = replays.readResult(file, identity.connectCode, ctx.opponentCode);
      if (result) await n.reportResult(ctx.opponentCode, result.iWon, result.matchKey);
    }
    await n.queueJoin();        // still here, still in line
  } catch { /* offline; the poll loop resyncs */ }
  await stopCasting();
  await (await orchestrator()).closeMatch();
}

/**
 * Start watching for the current game to end - but only once somebody is
 * waiting for the setup.
 *
 * Two people alone are never interrupted and never even looked at. The moment
 * a third joins the queue, Peppy starts watching, and the game they are on is
 * the last one: when it ends, the result goes in and the connection closes so
 * the next pairing can start.
 *
 * The watch starts from NOW, never from the beginning of the session: earlier
 * games of this set are already finished on disk, and treating one of those as
 * "the game just ended" would cut them off mid-match.
 */
async function watchForTheLastGame() {
  if (stopGameWatch || !matchContext) return;
  const ctx = matchContext;
  const replays = await import("./orchestrator/replays.mjs");
  const identity = (await orchestrator()).readSlippiIdentity();
  if (!identity) return;

  console.log("[queue] someone is waiting - this is the last game");
  send("last-game", { opponentCode: ctx.opponentCode });
  stopGameWatch = replays.watchGames({
    sinceMs: Date.now(),
    myCode: identity.connectCode,
    opponentCode: ctx.opponentCode,
    onGame: (result) => endSession(ctx, result),
  });
}

function stopWatchingGames() {
  if (stopGameWatch) { try { stopGameWatch(); } catch { /* already stopped */ } }
  stopGameWatch = null;
}

/**
 * The game that ends the session just ended: record it, say so, and close the
 * game so the next pairing can go out.
 *
 * The wait is counted from when the game ACTUALLY ended, not from when this
 * client noticed, so both machines close within a moment of each other -
 * whoever closes first drops the other's connection, and a straggler would sit
 * on a connection error until their own Peppy caught up.
 */
async function endSession(ctx, result) {
  stopWatchingGames();
  if (!(await someoneIsWaiting())) return;      // they left again: carry on

  let swept = false, sweeps = 0;
  try {
    const n = await network();
    const [row] = await n.reportResult(ctx.opponentCode, result.iWon, result.matchKey);
    swept = row?.swept ?? false;
    sweeps = row?.sweeps ?? 0;
  } catch { /* offline: the game still happened, the queue resyncs */ }
  send("match-result", {
    opponentCode: ctx.opponentCode, iWon: result.iWon, swept, sweeps, source: "replay",
  });
  send("session-over", { opponentCode: ctx.opponentCode });

  const closeAt = (result.endedAt ?? Date.now()) + 8000;   // let the results screen sit
  await new Promise((r) => setTimeout(r, Math.max(0, Math.min(15000, closeAt - Date.now()))));
  matchContext = null;
  await (await orchestrator()).closeMatch();
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
  if (!ctx) return;                       // Peppy closed it: already handled
  const n = await network();
  if (!n.status().player) return;

  const replays = await import("./orchestrator/replays.mjs");
  const identity = (await orchestrator()).readSlippiIdentity();

  // Dolphin is gone and Peppy did not close it, so somebody quit or it
  // crashed. The replay says which: a game that finished has an ending, a game
  // that was walked out of does not.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const file = replays.findReplaySince(ctx.startedAt - 60000);
    if (!file || !identity) continue;
    if (!replays.isFinished(file)) break;          // mid-game: forfeit below
    const result = replays.readResult(file, identity.connectCode, ctx.opponentCode);
    if (!result) continue;
    try {
      const [row] = await n.reportResult(ctx.opponentCode, result.iWon, result.matchKey);
      send("match-result", {
        opponentCode: ctx.opponentCode, iWon: result.iWon,
        swept: row?.swept ?? false, sweeps: row?.sweeps ?? 0, source: "replay",
      });
    } catch { /* server unhappy; the poll loop will resync */ }
    // They closed the game themselves - between games, at a character select,
    // whenever. That is leaving, so they come out of the queue rather than
    // being handed another match they are not sitting at.
    try { await n.queueLeave(); } catch { /* offline; the poll loop resyncs */ }
    send("left-queue", { opponentCode: ctx.opponentCode });
    return;
  }

  // Closed or crashed mid-game. That is a forfeit: the win goes to the player
  // who was still there, and whoever walked away steps out of the queue rather
  // than being handed a match they are not at the keyboard for.
  try {
    await n.reportResult(ctx.opponentCode, false, null);
  } catch { /* offline: the other client reports the same outcome */ }
  try { await n.queueLeave(); } catch { /* offline */ }
  send("match-result", {
    opponentCode: ctx.opponentCode, iWon: false, swept: false, sweeps: 0,
    source: "forfeit",
  });
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

      // Only look at their games once somebody is waiting for the setup.
      if (matchContext?.viaQueue) {
        if (await opponentIsGone()) await opponentLeft();
        else if (await someoneIsWaiting()) await watchForTheLastGame();
        else stopWatchingGames();
      }

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
