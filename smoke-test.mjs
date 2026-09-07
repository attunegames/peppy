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
ok("colour 3 is what Peppy presses X to reach", ini2.includes("3BE00003"));
ok("the colour placeholder is gone", !ini2.includes("3BE0005B"));

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

// --- the poll loop must announce a pairing once, not on every tick ---
{
  const { makePairingGate } = await import("./orchestrator/pairing-gate.mjs");
  const gate = makePairingGate();
  const pending = { pairing_id: "p1", state: "pending" };
  const ready = { pairing_id: "p1", state: "ready" };

  ok("a new pairing is announced", gate(pending) === "pending");
  ok("the same pending pairing is not re-announced", gate(pending) === null);
  ok("both-ready fires the go signal", gate(ready) === "ready");
  // This is the bug that relaunched Melee every 4s: 'ready' stays true on the
  // server for the whole match, so the poll sees it over and over.
  ok("a pairing that stays ready does not relaunch the match",
    [gate(ready), gate(ready), gate(ready)].every((s) => s === null));
  ok("the gate resets when the pairing is over", gate(null) === null);
  ok("the next pairing is announced normally",
    gate({ pairing_id: "p2", state: "pending" }) === "pending" &&
    gate({ pairing_id: "p2", state: "ready" }) === "ready");
  ok("a ready pairing seen with no pending first still launches",
    makePairingGate()({ pairing_id: "p3", state: "ready" }) === "ready");
}

// --- exactly one side of a match picks the stage ---
// Both clients claiming the picker role is what sent game 2 to Princess
// Peach's Castle and froze both machines.
{
  const geckos = JSON.parse(fs.readFileSync("./resources/geckos.json", "utf8"));
  ok("a follower build exists", typeof geckos.autoDirectFollow === "string" &&
    geckos.autoDirectFollow.length === geckos.autoDirect.length);
  ok("the follower differs from the picker", geckos.autoDirectFollow !== geckos.autoDirect);

  d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: d.STAGES.DREAMLAND,
                        character: "FOX", stagePicker: true });
  const picker = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
  ok("the picker names its stage", picker.includes("3860001C"));

  d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: d.STAGES.DREAMLAND,
                        character: "FOX", stagePicker: false });
  const follower = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
  ok("the follower ships the follower build", follower.includes(geckos.autoDirectFollow));
  ok("the follower names no stage of its own", !follower.includes("3860001C"));
  ok("a follower asking for random still follows",
    (d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: "random", character: "FOX",
                           stagePicker: false }),
     fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8")
       .includes(geckos.autoDirectFollow)));
}

// --- the game window opens the way the player asked ---
{
  const ini = path.join(USER, "Config", "Dolphin.ini");
  d.writeMatchConfigs({ opponentCode: "TEST#001", character: "FOX", windowMode: "fullscreen" });
  ok("fullscreen is set for a fullscreen match",
    /^Fullscreen = True$/mi.test(fs.readFileSync(ini, "utf8")));
  d.writeMatchConfigs({ opponentCode: "TEST#001", character: "FOX", windowMode: "maximized" });
  const max = fs.readFileSync(ini, "utf8");
  ok("a maximized match is not fullscreen", /^Fullscreen = False$/mi.test(max));
  // Maximised is the render window's own size. Maximising a window by title
  // picked the wrong one - the game list is the window called "Faster Melee".
  ok("the game window is sized to the screen",
    /^RenderWindowAutoSize = False$/mi.test(max) &&
    Number(max.match(/^RenderWindowWidth = (\d+)$/mi)?.[1] ?? 0) > 800 &&
    Number(max.match(/^RenderWindowHeight = (\d+)$/mi)?.[1] ?? 0) > 600);
  ok("...in a window of its own, or there is nothing to size",
    /^RenderToMain = False$/mi.test(max));
  ok("fullscreen is borderless so it can be tabbed out of",
    /^BorderlessFullscreen = True$/mi.test(
      fs.readFileSync(path.join(USER, "Config", "GFX.ini"), "utf8")));
  ok("pause-on-focus-loss stays off (Peppy hides the window on purpose)",
    !/PauseOnFocusLost\s*=\s*True/i.test(fs.readFileSync(ini, "utf8")));
}

// --- the CURSOR runs for game 1 only; the costume keeps being written ---
// Peppy connects players; it does not run their set. After game 1 the cursor
// belongs to the player again so they can counterpick. The costume is
// different: Slippi blocks the costume buttons online, so the only way a
// chosen colour survives into game 2 is for Peppy to keep writing it.
//
// This mirrors the state machine compiled into $CharPick / $CharPress: two data
// words that start as `nop` (0x60000000), the frame the hook last saw, and a
// done flag. The hook only runs on the character select, so "a game happened"
// is a gap in the frames it sees.
{
  const NOP = 0x60000000;
  const makeStandDown = () => {
    let last = NOP, done = NOP;
    return (frame) => {
      if (done === 1) return "exit";                  // stood down for good
      if (last !== NOP && (frame < last || frame - last > 120)) {
        done = 1;
        return "exit";
      }
      last = frame;
      return "pick";
    };
  };

  let g = makeStandDown();
  ok("it picks on the first character-select frame", g(400) === "pick");
  ok("it keeps picking through that session",
    [401, 402, 402, 403].every((f) => g(f) === "pick"));

  // game 1 happens: thousands of frames pass before the CSS comes back
  ok("it stands down when the CSS returns after a game", g(9000) === "exit");
  ok("it stays stood down for game 3 and beyond",
    [9001, 9002, 12000].every((f) => g(f) === "exit"));

  // some counters restart per scene instead of running on
  g = makeStandDown();
  g(400); g(401);
  ok("a counter that restarts also counts as a game", g(12) === "exit");

  // a dropped frame inside one session must not look like a game
  g = makeStandDown();
  g(400);
  ok("a dropped frame is not a game", g(402) === "pick");
  ok("a two-second gap is a game", g(600) === "exit");

}

// --- the costume is pressed for, in the right order ---
// X while hovering, THEN A. The press code stops the moment a character is
// chosen, so an X press after the A press never happens - v0.8.x had that
// order backwards and every replay came back costume 0.
{
  const geckos = JSON.parse(fs.readFileSync("./resources/geckos.json", "utf8"));
  ok("there is a press payload per character",
    Object.keys(geckos.charPress).length === Object.keys(geckos.charPick).length);
  ok("the costume lives in the press, not the cursor",
    geckos.charPress.FOX.includes("3BE0005B") && !geckos.charPick.FOX.includes("3BE0005B"));
  ok("the press knows each character's costume count",
    geckos.costumes.FOX === 4 && geckos.costumes.MARTH === 5 && geckos.costumes.KIRBY === 6);
  // 0x400 = X, 0x100 = A, 0x500 = both (cleared between presses), and the
  // press count lives in a data word that starts as a nop (3F606000 tests it).
  for (const [what, word] of [["X", "3B200400"], ["A", "3B200100"], ["a press count", "3F606000"]]) {
    ok(`${what} is in the payload`, geckos.charPress.FOX.includes(word));
  }
  ok("X comes before A",
    geckos.charPress.FOX.indexOf("3B200400") < geckos.charPress.FOX.indexOf("3B200100"));

  d.writeMatchConfigs({ opponentCode: "TEST#001", character: "KIRBY", color: 5 });
  const ini = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
  ok("Kirby's sixth costume is asked for", ini.includes("3BE00005"));
  ok("the costume placeholder is gone", !ini.includes("3BE0005B"));

  d.writeMatchConfigs({ opponentCode: "TEST#001", character: "MARTH", color: 5 });
  const marth = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
  ok("a colour a character does not have is clamped",
    marth.includes("3BE00004") && !marth.includes("3BE00005"));
}

// --- friendlies play the stage the game normally plays ---
// Every replay from the scene test came back isFrozenPS, which is what ranked
// uses. The lock-in had it hardcoded on.
{
  d.writeMatchConfigs({ opponentCode: "TEST#001", character: "FOX", stageId: 3 });
  const ini = fs.readFileSync(path.join(USER, "GameSettings", "GALE01r2.ini"), "utf8");
  // 987F0009 stores the byte; the word before it is what gets stored. Compare
  // on the payload with its formatting stripped, so a line break cannot hide
  // the pair.
  const hex = ini.replace(/[^0-9A-F]/g, "");
  ok("Pokemon Stadium is not forced frozen",
    hex.includes("38600000987F0009") && !hex.includes("38600001987F0009"));
}

// --- a session that ends without Dolphin closing ---
// Quitting out in game leaves the emulator open, so the process is no help:
// Peppy would never know the match was over and the player would sit in the
// queue as if they were still playing.
{
  const src = fs.readFileSync("./orchestrator/dolphin.mjs", "utf8");
  ok("the log is watched for the connection ending", /Disconnecting peer/.test(src));
  ok("...only from the moment the match was revealed",
    src.indexOf("baseline = fs.statSync(log).size") < src.indexOf("if (/Disconnecting peer"));
  ok("shaders come along to the sandbox", !/\/XD", "Cache"|"Cache", "Dump"/.test(src));
}
