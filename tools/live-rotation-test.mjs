// Peppy has to see a game END while the two players are still connected -
// that is what lets the queue move without anyone quitting out of Dolphin.
// Driven with a real replay copied into a scratch folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as replays from "../orchestrator/replays.mjs";

const ok = (label, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const source = replays.replaysSince(0).slice(-1)[0];
if (!source) { console.log("FAIL  no replays on this PC to drive the test"); process.exit(1); }
const { SlippiGame } = await import("@slippi/slippi-js/node");
const codes = new SlippiGame(source).getSettings().players.map((p) => p.connectCode);
console.log("driving with", path.basename(source), "-", codes.join(" vs "));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peppy-rot-"));
const seen = [];
const stop = replays.watchGames({
  sinceMs: 0, myCode: codes[0], opponentCode: codes[1], everyMs: 300, dir,
  onGame: (r) => seen.push(r),
});

await wait(1000);
ok("an empty folder reports nothing", seen.length === 0);

// a game in progress: the file exists but has no game-end block yet
const partial = path.join(dir, "Game_partial.slp");
const full = fs.readFileSync(source);
fs.writeFileSync(partial, full.subarray(0, Math.floor(full.length * 0.6)));
await wait(1200);
ok("a game still being played is not reported", seen.length === 0);
ok("...and that file really is unfinished", replays.isFinished(partial) === false);

// the game ends
fs.writeFileSync(path.join(dir, "Game_done.slp"), full);
await wait(1500);
ok("a finished game is reported once", seen.length === 1);
ok("it says who won", typeof seen[0]?.iWon === "boolean");
ok("it carries the match key both clients agree on", seen[0]?.matchKey === "Game_done.slp");

// the next game of the same set
fs.writeFileSync(path.join(dir, "Game_two.slp"), full);
await wait(1500);
ok("the next game is reported too", seen.length === 2);
ok("the same game is never reported twice",
  new Set(seen.map((s) => s.matchKey)).size === seen.length);

stop();
fs.writeFileSync(path.join(dir, "Game_three.slp"), full);
await wait(1000);
ok("stopping the watch stops the reports", seen.length === 2);

fs.rmSync(dir, { recursive: true, force: true });

// --- a game that was walked out of has no winner to read ---
// Peppy used to fall back to counting stocks in the last frame it could see,
// which hands the win to whoever was ahead when they closed Dolphin.
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "peppy-quit-"));
  const cut = path.join(dir2, "Game_cut.slp");
  fs.writeFileSync(cut, full.subarray(0, Math.floor(full.length * 0.75)));
  const done = path.join(dir2, "Game_whole.slp");
  fs.writeFileSync(done, full);

  ok("a walked-out game reports no winner",
    replays.readResult(cut, codes[0], codes[1]) === null);
  ok("a finished game still reports one",
    replays.readResult(done, codes[0], codes[1]) !== null);
  fs.rmSync(dir2, { recursive: true, force: true });
}
