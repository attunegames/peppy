// Smoke test: does the orchestrator produce a valid, correctly-patched match
// setup? Run with: node smoke-test.mjs
import fs from "node:fs";
import path from "node:path";

import * as d from "./orchestrator/dolphin.mjs";

const USER = path.join(process.env.APPDATA, "Peppy", "netplay", "User");
const ok = (label, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);

console.log(`characters available: ${d.CHARACTERS.length}`);
const { isoPath } = d.ensureSandbox();
ok("Slippi + ISO found", !!isoPath);

d.writeMatchConfigs({
  opponentCode: "TEST#001",
  stageId: d.STAGES.DREAMLAND,
  character: "MARTH",
});

const ini = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
ok("AutoBoot patch present", ini.includes("$AutoBoot"));
ok("AutoDirect patch present", ini.includes("$AutoDirect"));
ok("CharPick patch present", ini.includes("$CharPick"));
ok("CharPress patch present", ini.includes("$CharPress"));
ok("no third-party gecko bundled", !ini.includes("Extract Menu Info"));
ok("stage patched to Dream Land (3860001C)", ini.includes("3860001C"));
ok("default stage word replaced", !ini.includes("3860001F"));

const codes = JSON.parse(fs.readFileSync(path.join(USER, "Slippi", "direct-codes.json"), "utf8"));
ok("opponent code written full-width", codes[0].connectCode === "ＴＥＳＴ＃００１");

ok("no virtual controller config", !fs.existsSync(path.join(USER, "Config", "GCPadNew.ini")));
ok("logging enabled for connect detection",
  fs.readFileSync(path.join(USER, "Config", "Logger.ini"), "utf8").includes("WriteToFile = True"));

const real = path.join(process.env.APPDATA, "Slippi Launcher", "netplay", "User", "GameSettings");
ok("real Slippi install untouched (no peppy patches there)",
  !fs.existsSync(path.join(real, "GALE01r2.ini")) ||
  !fs.readFileSync(path.join(real, "GALE01r2.ini"), "utf8").includes("peppy"));
