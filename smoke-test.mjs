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

// --- random stage + colour ---
d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: "random", character: "FOX", color: 3 });
const ini2 = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
ok("random stage uses the game's own random option", !ini2.includes("3860001F") && !ini2.includes("3860001C"));
ok("colour 3 written into the pick", ini2.includes("3BE00003"));
ok("colour placeholder is gone", !ini2.includes("3BE0005B"));

d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: 0x1F, character: "FOX", color: 0 });
const ini3 = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
ok("a named stage still works alongside colour", ini3.includes("3860001F"));
ok("colour 0 is the default", ini3.includes("3BE00000"));

// --- costume table: every character the picker can offer has real colours ---
{
  const geckos = JSON.parse(fs.readFileSync("./resources/geckos.json", "utf8"));
  const src = fs.readFileSync("./renderer/costumes.js", "utf8");
  const win = {};
  new Function("window", src)(win);
  const names = Object.keys(geckos.characters);
  ok("every character has a costume list",
    names.every((n) => Array.isArray(win.COSTUMES[n]) && win.COSTUMES[n].length >= 2));
  ok("no costume list exceeds the game's six",
    Object.values(win.COSTUMES).every((l) => l.length <= 6));
  ok("every costume has a name and a swatch",
    Object.values(win.COSTUMES).flat().every(([name, hex]) =>
      typeof name === "string" && name.length > 0 && /^#[0-9a-f]{6}$/.test(hex)));
  ok("costumes are named, not numbered",
    !Object.values(win.COSTUMES).flat().some(([name]) => /^Color\s*\d/i.test(name)));
  ok("an unknown character still gets a picker", win.costumesFor("NOBODY").length === 1);
  ok("Marth's four alts are the real ones",
    win.COSTUMES.MARTH.map(([n]) => n).join(",") === "Blue,Red,Green,Black,White");
}

// A <label> forwards clicks to the first button inside it, so wrapping the
// swatches in one made every click re-pick the first colour (v0.5.1 bug).
{
  const html = fs.readFileSync("./renderer/index.html", "utf8")
    .replace(/<!--[\s\S]*?-->/g, "");   // comments mention <label> on purpose
  const before = html.slice(0, html.indexOf('id="colorRow"'));
  const lastLabel = before.lastIndexOf("<label");
  ok("the colour swatches are not wrapped in a <label>",
    lastLabel === -1 || before.slice(lastLabel).includes("</label>"));
}
