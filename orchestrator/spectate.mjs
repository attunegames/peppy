// Live spectating.
//
// Slippi Dolphin exposes the match it is playing on a local socket (the same
// one stream overlays and the Slippi Launcher's own spectate feature use).
// Peppy taps that, relays the bytes through the Peppy server, and a spectator
// rebuilds them into a replay file that Slippi's PLAYBACK Dolphin plays while
// it is still being written - so you watch a few seconds behind live.
//
//   player            -> DolphinConnection (127.0.0.1:51441)
//                     -> base64 batches over a Supabase realtime channel
//   spectator         -> writes bytes into a .slp as they arrive
//                     -> playback Dolphin, told to mirror that growing file
//
// Nothing here touches the match-launching path: if spectating breaks, playing
// is unaffected.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConnectionEvent, DolphinConnection, SlpFileWriter } from "@slippi/slippi-js/node";

const APPDATA = process.env.APPDATA;
const SLIPPI_DIR = path.join(APPDATA, "Slippi Launcher");
const PLAYBACK_DIR = path.join(SLIPPI_DIR, "playback");
const PEPPY_DATA = path.join(APPDATA, "Peppy");
const WATCH_DIR = path.join(PEPPY_DATA, "spectate");

// Dolphin's live feed, from the player's own settings.
function spectatorPort() {
  try {
    const ini = fs.readFileSync(
      path.join(SLIPPI_DIR, "netplay", "User", "Config", "Dolphin.ini"), "utf-8");
    const m = ini.match(/^SlippiSpectatorLocalPort\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* default below */ }
  return 51441;
}

export function playbackAvailable() {
  return fs.existsSync(path.join(PLAYBACK_DIR, "Slippi Dolphin.exe"));
}

// ---------------------------------------------------------- broadcasting ---

let connection = null;
let sendBatch = null;
let pending = [];
let flushTimer = null;

/**
 * Start relaying this PC's live match.
 *
 * `publish(base64Chunk)` is called with batched bytes - batching keeps the
 * message rate sane for the relay rather than sending every packet.
 */
export function startBroadcast(publish, onState = () => {}) {
  stopBroadcast();
  sendBatch = publish;
  connection = new DolphinConnection();

  connection.on(ConnectionEvent.STATUS_CHANGE, (status) => onState(status));
  connection.on(ConnectionEvent.ERROR, (err) => onState("error", String(err)));
  // Raw payloads: whatever Dolphin emits is exactly what a spectator needs.
  connection.on(ConnectionEvent.DATA, (data) => {
    pending.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  });

  try {
    connection.connect("127.0.0.1", spectatorPort());
  } catch (err) {
    onState("error", String(err.message ?? err));
  }
  return true;
}

function flush() {
  flushTimer = null;
  if (!pending.length || !sendBatch) return;
  const chunk = Buffer.concat(pending);
  pending = [];
  try { sendBatch(chunk.toString("base64")); } catch { /* relay hiccup */ }
}

export function stopBroadcast() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pending = [];
  sendBatch = null;
  if (connection) {
    try { connection.disconnect(); } catch { /* already gone */ }
    connection = null;
  }
}

// ----------------------------------------------------------- spectating ----

let watchFile = null;
let writer = null;
let playbackProc = null;

/**
 * Begin a spectate session.
 *
 * The relayed bytes are Dolphin's raw replay events, not a .slp file - a valid
 * replay needs the proper header and framing, so they go through Slippi's own
 * SlpFileWriter rather than being appended to a file directly.
 */
export function startWatching() {
  stopWatching();
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  writer = new SlpFileWriter({ folderPath: WATCH_DIR });
  writer.on("new-file", (filePath) => { watchFile = filePath; });
  return WATCH_DIR;
}

/** Feed relayed bytes into the growing replay. Returns the file once known. */
export function feed(base64Chunk) {
  if (!writer) return null;
  try {
    writer.write(Buffer.from(base64Chunk, "base64"));
    return watchFile ?? writer.getCurrentFilename?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Launch Slippi's playback Dolphin so it follows the file as it grows.
 *
 * Playback is driven by a small JSON "comm" file: mirror mode plus
 * isRealTimeMode makes it chase the end of the replay instead of stopping at
 * whatever was written when it started.
 */
export function openPlayback(isoPath, file = watchFile) {
  if (!file) return { ok: false, error: "no replay to watch yet" };
  if (!playbackAvailable()) {
    return { ok: false, error: "Slippi's playback build isn't installed (open the Slippi Launcher once)" };
  }
  const comm = path.join(os.tmpdir(), `peppy-spectate-${Date.now()}.json`);
  fs.writeFileSync(comm, JSON.stringify({
    mode: "mirror",
    replay: file,
    isRealTimeMode: true,
    outputOverlayFiles: false,
  }));
  try {
    playbackProc = spawn(path.join(PLAYBACK_DIR, "Slippi Dolphin.exe"),
      ["-i", comm, "-e", isoPath, "-b"], { stdio: "ignore" });
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

export function stopWatching() {
  if (writer) { try { writer.endCurrentFile(); } catch { /* ignore */ } writer = null; }
  watchFile = null;
  if (playbackProc) {
    try { execFileSync("taskkill", ["/F", "/PID", String(playbackProc.pid)], { stdio: "ignore" }); }
    catch { /* already closed */ }
    playbackProc = null;
  }
}

export function watchingFile() {
  return watchFile;
}
