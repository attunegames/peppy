// Reading match results out of Slippi's own replay files.
//
// The rotation needs to know who won (winner stays), and asking the players
// after every game would be exactly the coordination Peppy exists to remove.
// Every netplay match writes a .slp containing both connect codes and the
// final placements, so the answer is already on disk.
//
// Note the import: slippi-js resolves to a browser build by default, which
// refuses file paths. The node entrypoint is required.
import fs from "node:fs";
import path from "node:path";

import { SlippiGame } from "@slippi/slippi-js/node";

const APPDATA = process.env.APPDATA;
const REAL_DOLPHIN_INI = path.join(
  APPDATA, "Slippi Launcher", "netplay", "User", "Config", "Dolphin.ini");

/** Where Slippi saves replays on this PC (from the player's own settings). */
export function replayDir() {
  try {
    const ini = fs.readFileSync(REAL_DOLPHIN_INI, "utf-8");
    const match = ini.match(/^SlippiReplayDir\s*=\s*(.+)$/m);
    const dir = match?.[1]?.trim();
    if (dir && fs.existsSync(dir)) return dir;
  } catch { /* fall through */ }
  const fallback = path.join(APPDATA, "..", "Documents", "Slippi");
  return fs.existsSync(fallback) ? fallback : null;
}

/** Newest .slp written since `sinceMs`, searching the monthly subfolders. */
export function findReplaySince(sinceMs, dir = replayDir()) {
  if (!dir) return null;
  let best = null;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".slp")) {
        let m;
        try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m >= sinceMs && (!best || m > best.mtime)) best = { file: p, mtime: m };
      }
    }
  };
  walk(dir);
  return best?.file ?? null;
}

/**
 * Who won, from the replay's point of view.
 *
 * Returns { iWon, matchKey, opponentCode } or null if the file cannot be read
 * or does not involve both players (in which case the caller should ask).
 * matchKey is the file name, which both players' clients agree on, so the
 * server can discard the duplicate report.
 */
export function readResult(file, myCode, opponentCode) {
  try {
    const game = new SlippiGame(file);
    const settings = game.getSettings();
    const players = settings?.players ?? [];
    const norm = (c) => String(c ?? "").toUpperCase().trim();

    const me = players.find((p) => norm(p.connectCode) === norm(myCode));
    const them = players.find((p) => norm(p.connectCode) === norm(opponentCode));
    if (!me || !them) return null;              // not the match we think it is

    let winnerIndex = null;

    // Someone quitting out hands the win to the other player.
    const end = game.getGameEnd();
    if (end && end.lrasInitiatorIndex != null && end.lrasInitiatorIndex >= 0) {
      winnerIndex = end.lrasInitiatorIndex === me.playerIndex ? them.playerIndex : me.playerIndex;
    }

    // Otherwise trust the game's own placements.
    if (winnerIndex === null) {
      try {
        const winners = game.getWinners?.() ?? [];
        const first = winners.find((w) => w.position === 0) ?? winners[0];
        if (first) winnerIndex = first.playerIndex;
      } catch { /* fall through to stocks */ }
    }

    // Last resort: whoever still had stocks.
    if (winnerIndex === null) {
      const last = game.getLatestFrame();
      const stocks = (p) => last?.players?.[p.playerIndex]?.post?.stocksRemaining ?? 0;
      const mine = stocks(me), theirs = stocks(them);
      if (mine === theirs) return null;
      winnerIndex = mine > theirs ? me.playerIndex : them.playerIndex;
    }

    return {
      iWon: winnerIndex === me.playerIndex,
      matchKey: path.basename(file),
      opponentCode: norm(them.connectCode),
    };
  } catch {
    return null;
  }
}
