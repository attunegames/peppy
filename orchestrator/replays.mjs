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

// slippi-js is CommonJS, and how well an ESM `import` can pick names out of a
// CommonJS module depends on the Node version. Electron's is older than the
// one the tests run on, so a named import works here and throws in the app -
// taking this module, and everything that depends on it, down with it.
// createRequire loads it the way it was written, on every version.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SlippiGame } = require("@slippi/slippi-js/node");

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

/** Every .slp written since `sinceMs`, oldest first, across monthly folders. */
export function replaysSince(sinceMs, dir = replayDir()) {
  if (!dir) return [];
  const found = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".slp")) {
        let m;
        try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m >= sinceMs) found.push({ file: p, mtime: m });
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => a.mtime - b.mtime).map((x) => x.file);
}

/** Newest .slp written since `sinceMs`. */
export function findReplaySince(sinceMs, dir = replayDir()) {
  const all = replaysSince(sinceMs, dir);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Has this game actually finished? A .slp exists and grows while the game is
 * being played; the game-end block is only written when it is over, which is
 * what makes this safe to poll during a live session.
 */
export function isFinished(file) {
  try {
    return !!new SlippiGame(file).getGameEnd();
  } catch {
    return false;
  }
}

/**
 * Watch for games ending WHILE the two players are still connected.
 *
 * The rotation used to wait for Dolphin to close, which meant a set only ended
 * when somebody remembered to quit out, and anyone waiting in the queue waited
 * on that. Peppy now sees each game finish as it happens.
 *
 * onGame({...result, file, endedAt}) fires once per completed game. endedAt is
 * when the game actually ended, so both players can count from the same moment
 * rather than from whenever their own poll happened to notice.
 */
export function watchGames({ sinceMs, myCode, opponentCode, onGame,
                             everyMs = 2000, dir = replayDir() }) {
  const reported = new Set();
  const timer = setInterval(() => {
    for (const file of replaysSince(sinceMs, dir)) {
      if (reported.has(file) || !isFinished(file)) continue;
      const result = readResult(file, myCode, opponentCode);
      if (!result) continue;
      reported.add(file);
      let endedAt = Date.now();
      try { endedAt = fs.statSync(file).mtimeMs; } catch { /* use now */ }
      try { onGame({ ...result, file, endedAt }); }
      catch { /* never let a listener stop the watch */ }
    }
  }, everyMs);
  return () => clearInterval(timer);
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

    // No ending means the game never finished - Dolphin was closed or crashed
    // mid-game. There is no winner to read here, and guessing from whoever was
    // ahead on stocks would hand the win to the person who walked away.
    const end = game.getGameEnd();
    if (!end) return null;

    // Someone quitting out hands the win to the other player.
    if (end.lrasInitiatorIndex != null && end.lrasInitiatorIndex >= 0) {
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
