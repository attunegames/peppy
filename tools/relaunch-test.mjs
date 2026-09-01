// Reproduces the "EBUSY: resource busy or locked, unlink dolphin.log" failure
// that blocked the first live test, and proves it is fixed.
//
// A running Dolphin holds its own log open. Peppy used to delete that log
// before each match, so starting a second match - or starting one while any
// Dolphin was still open - threw EBUSY and aborted with "Couldn't start the
// game". Housekeeping should never be able to stop a match.
//
// Run: node tools/relaunch-test.mjs
import fs from "node:fs";
import path from "node:path";

import * as d from "../orchestrator/dolphin.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

const LOG = path.join(process.env.APPDATA, "Peppy", "netplay", "User", "Logs", "dolphin.log");

const main = async () => {
  const { isoPath } = d.ensureSandbox();

  // first match, as normal
  d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: d.STAGES.BATTLEFIELD, character: "FOX" });
  const pid1 = d.launch({ isoPath });
  ok("first match launched", !!pid1);

  // let Dolphin boot and take hold of its log
  await new Promise((r) => setTimeout(r, 15000));
  ok("Dolphin is writing its log", fs.existsSync(LOG), fs.existsSync(LOG) ? `${fs.statSync(LOG).size} bytes` : "no log yet");

  // THE FAILING CASE: write a new match's configs while that Dolphin still runs
  let error = null;
  try {
    d.writeMatchConfigs({ opponentCode: "TEST#002", stageId: d.STAGES.DREAMLAND, character: "MARTH" });
  } catch (err) {
    error = String(err.message ?? err);
  }
  ok("writing configs with Dolphin still running does not throw", error === null, error ?? "");

  // and a second launch should work, the way clicking READY again does
  let launchError = null, pid2 = null;
  try {
    d.killAll();
    await new Promise((r) => setTimeout(r, 400));
    d.writeMatchConfigs({ opponentCode: "TEST#002", stageId: d.STAGES.DREAMLAND, character: "MARTH" });
    pid2 = d.launch({ isoPath });
  } catch (err) {
    launchError = String(err.message ?? err);
  }
  ok("a second match launches cleanly", !!pid2 && !launchError, launchError ?? "");

  // the new match's settings really were written
  const ini = fs.readFileSync(path.join(process.env.APPDATA, "Peppy", "netplay", "User",
    "GameSettings", "GALE01r2.ini"), "utf-8");
  ok("second match got its own stage (Dream Land)", ini.includes("3860001C"));
  ok("second match got its own character (Marth)", ini.includes("$CharPick"));

  await new Promise((r) => setTimeout(r, 3000));
  d.killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("ERROR:", e.message); d.killAll(); process.exit(1); });
