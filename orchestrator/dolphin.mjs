// PEPPY orchestrator: owns a private sandbox copy of the user's Slippi
// Dolphin, writes the per-match configs + game patches, launches the game
// HIDDEN, and reveals it once the opponent is connected.
//
// Everything here was proven live during the 2026-08 spike:
//  - stock netplay Dolphin, launched with `-e <iso> -u <User>`
//  - User\GameSettings\GALE01r2.ini carries the patches:
//      $AutoBoot  - skip the online mode-select, land on the Direct CSS
//      $AutoDirect- auto code entry + search, with game-1 stage locked in
//      $CharPick  - park the CSS cursor on the chosen character
//      $CharPress - pulse A once per frame so the game selects it for real
//  - User\Slippi\direct-codes.json top entry = the opponent to dial
//  - the user's real Slippi install is never modified

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APPDATA = process.env.APPDATA;
const SLIPPI_DIR = path.join(APPDATA, "Slippi Launcher");
const PEPPY_DATA = path.join(APPDATA, "Peppy");
const SANDBOX = path.join(PEPPY_DATA, "netplay");

const GECKOS = JSON.parse(
  fs.readFileSync(new URL("../resources/geckos.json", import.meta.url), "utf-8"),
);

export const CHARACTERS = Object.keys(GECKOS.charPick);

// External stage ids usable for the game-1 stage lock-in.
export const STAGES = {
  BATTLEFIELD: 0x1f,
  FINAL_DESTINATION: 0x20,
  DREAMLAND: 0x1c,
  FOUNTAIN: 0x02,
  YOSHIS: 0x08,
  STADIUM: 0x03,
};

export function findSlippi() {
  const settingsPath = path.join(SLIPPI_DIR, "Settings");
  if (!fs.existsSync(settingsPath)) {
    throw new Error("Slippi Launcher not found. Install and run it once first.");
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  const isoPath = settings.settings?.isoPath;
  const netplay = path.join(SLIPPI_DIR, "netplay");
  if (!fs.existsSync(path.join(netplay, "Slippi Dolphin.exe"))) {
    throw new Error("Slippi's netplay Dolphin not found. Press Play in the Slippi Launcher once, then retry.");
  }
  if (!isoPath || !fs.existsSync(isoPath)) {
    throw new Error("No Melee ISO configured in the Slippi Launcher.");
  }
  return { netplay, isoPath };
}

// Copy the user's Dolphin into our sandbox (first run / after a Slippi update).
export function ensureSandbox() {
  const { netplay, isoPath } = findSlippi();
  const srcExe = path.join(netplay, "Slippi Dolphin.exe");
  const dstExe = path.join(SANDBOX, "Slippi Dolphin.exe");
  const stale =
    !fs.existsSync(dstExe) ||
    fs.statSync(srcExe).mtimeMs !== fs.statSync(dstExe).mtimeMs;
  if (stale) {
    fs.mkdirSync(PEPPY_DATA, { recursive: true });
    try {
      execFileSync("robocopy", [netplay, SANDBOX, "/E", "/XD", "Cache", "Dump",
        "ScreenShots", "Logs", "/NFL", "/NDL", "/NJH", "/NJS"], { stdio: "ignore" });
    } catch (err) {
      // robocopy returns 0-7 for success. A real failure usually means files
      // are locked by a running Dolphin - if we already have a usable copy,
      // play with that rather than refusing to start.
      const usable = fs.existsSync(dstExe);
      if (!usable && (err.status === undefined || err.status > 7)) throw err;
    }
  }
  return { sandbox: SANDBOX, isoPath };
}

/**
 * Who is this PC logged into Slippi as?
 *
 * Reads ONLY the two public identity fields from Slippi's user.json - the
 * connect code and the display name. The play key that also lives in that file
 * is never read, stored or transmitted, and Peppy never asks for a slippi.gg
 * password.
 *
 * This is what lets one player use Peppy on several machines: being able to
 * play as a code in Slippi is what makes you that player in Peppy.
 */
export function readSlippiIdentity() {
  const file = path.join(SLIPPI_DIR, "netplay", "User", "Slippi", "user.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const code = String(raw.connectCode ?? "").trim();
    if (!code) return null;
    // user.json stores it full-width; the app works in plain ASCII
    const ascii = [...code].map((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch;
    }).join("").toUpperCase();
    if (!/^[A-Z]{1,7}#\d{1,3}$/.test(ascii)) return null;
    return { connectCode: ascii, displayName: String(raw.displayName ?? "").trim() || ascii.split("#")[0] };
  } catch {
    return null;   // not logged in, or Slippi not installed
  }
}

// "TEST#001" -> full-width, the charset the in-game code list uses.
export function toFullWidth(code) {
  return [...code.toUpperCase()]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0x21 && c <= 0x7e ? String.fromCharCode(c + 0xfee0) : ch;
    })
    .join("");
}

function buildGeckoIni({ stageId, character, color }) {
  // stageId === "random" uses the build whose lock-in asks the game for a
  // random legal stage, rather than naming one.
  const wantsRandom = stageId === "random" || stageId == null;
  let autoDirect = wantsRandom ? GECKOS.autoDirectRandom : GECKOS.autoDirect;
  if (!wantsRandom) {
    const patched = `3860${(stageId & 0xff).toString(16).toUpperCase().padStart(4, "0")}`;
    autoDirect = autoDirect.split(GECKOS.stageWordToken).join(patched);
  }
  // Only Peppy's own patches ship. libmelee's "Extract Menu Info" gecko
  // (LGPL-3.0, altf4/Fizzi) was a development aid for reading game state; the
  // app watches Slippi's log instead, so no third-party code is bundled.
  let body = "[Gecko]\n$AutoDirect [peppy]\n" + autoDirect +
    "\n$AutoBoot [peppy]\n" + GECKOS.autoBoot;
  let enabled = "\n\n[Gecko_Enabled]\n$AutoDirect\n$AutoBoot\n";
  let pick = character && GECKOS.charPick[character.toUpperCase()];
  if (pick) {
    // Costume: Slippi disables the in-game colour buttons on the online
    // character select, so the choice is written straight into the selection
    // that the lock-in reads.
    const n = Math.max(0, Math.min(5, Number(color) || 0));
    pick = pick.split(GECKOS.colorToken)
      .join(`3BE000${n.toString(16).toUpperCase().padStart(2, "0")}`);
    body += "\n$CharPick [peppy]\n" + pick +
      "\n$CharPress [peppy]\n" + GECKOS.charPress;
    enabled += "$CharPick\n$CharPress\n";
  }
  return body + enabled;
}

const LOG_REL = path.join("User", "Logs", "dolphin.log");

// Everything a match launch needs. opponentCode is plain ASCII ("ABCD#123").
export function writeMatchConfigs({ opponentCode, stageId = STAGES.BATTLEFIELD,
                                   character, color = 0 }) {
  const user = path.join(SANDBOX, "User");
  for (const dir of ["Config", "GameSettings", "Slippi", "Logs"]) {
    fs.mkdirSync(path.join(user, dir), { recursive: true });
  }
  // Mirror the player's real Dolphin settings (their controller, video, delay).
  const realIni = path.join(SLIPPI_DIR, "netplay", "User", "Config", "Dolphin.ini");
  try {
    fs.copyFileSync(realIni, path.join(user, "Config", "Dolphin.ini"));
  } catch { /* keep the copy we already have rather than refusing to play */ }
  // No GCPadNew: native adapter only. Peppy never uses virtual controllers.
  try {
    const gcpad = path.join(user, "Config", "GCPadNew.ini");
    if (fs.existsSync(gcpad)) fs.rmSync(gcpad);
  } catch { /* not fatal */ }
  // Slippi logging on: the connect moment is our cue to reveal the window.
  fs.writeFileSync(path.join(user, "Config", "Logger.ini"),
    "[Options]\nWriteToFile = True\nVerbosity = 5\n[Logs]\nSLIPPI = True\nSLIPPI_ONLINE = True\n");
  // Best effort only. A still-running Dolphin holds this file open, and on
  // Windows the delete then fails with EBUSY - which used to abort the whole
  // launch with "Couldn't start the game". Detection reads from the end of the
  // file instead (see logOffset below), so clearing it is a nicety, not a need.
  try {
    const log = path.join(SANDBOX, LOG_REL);
    if (fs.existsSync(log)) fs.rmSync(log);
  } catch { /* keep going: the log is only used to spot the connection */ }

  fs.writeFileSync(path.join(user, "GameSettings", "GALE01r2.ini"),
    buildGeckoIni({ stageId, character, color }));
  fs.writeFileSync(path.join(user, "Slippi", "direct-codes.json"),
    JSON.stringify([{ connectCode: toFullWidth(opponentCode), lastPlayed: Math.floor(Date.now() / 1000) }]));
}

let dolphinProc = null;
let watchTimer = null;

export function launch({ isoPath }) {
  killAll();
  const exe = path.join(SANDBOX, "Slippi Dolphin.exe");
  dolphinProc = spawn(exe, ["-e", isoPath, "-u", path.join(SANDBOX, "User")], {
    stdio: "ignore",
  });
  return dolphinProc.pid;
}

export function killAll() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  try {
    execFileSync("taskkill", ["/F", "/IM", "Slippi Dolphin.exe"], { stdio: "ignore" });
  } catch { /* nothing running */ }
  dolphinProc = null;
}

// --- window visibility -----------------------------------------------------
// Dolphin owns its own windows, so we drive user32 ShowWindow by PID. Hiding
// keeps the menu automation off-screen; the player only ever sees the game
// once it is connected.

function showWindowsForPid(pid, mode /* 0 = hide, 5 = show */) {
  const ps = `
$sig = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
$w = Add-Type -MemberDefinition $sig -Name W -Namespace P -PassThru
Get-Process -Id ${pid} -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  ForEach-Object { [void]$w::ShowWindow($_.MainWindowHandle, ${mode})
                   if (${mode} -ne 0) { [void]$w::SetForegroundWindow($_.MainWindowHandle) } }`;
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: "ignore", timeout: 8000 });
  } catch { /* window may not exist yet; the poller retries */ }
}

/**
 * Hide Dolphin's window while the patches drive the menus, then reveal it when
 * the match is actually connected.
 *
 * The reveal cue is Slippi's own log line ("Connection success!") — no game
 * memory reading needed, which keeps this pure Node.
 *
 * onState(state) receives: "hidden" | "connected" | "timeout" | "gone".
 */
export function hideUntilConnected(pid, onState, { revealAfterMs = 90000 } = {}) {
  const log = path.join(SANDBOX, LOG_REL);
  const started = Date.now();
  let revealed = false;
  // Where the log already ended, so a "Connection success!" from an earlier
  // match can never be mistaken for this one.
  let baseline = 0;
  try { baseline = fs.existsSync(log) ? fs.statSync(log).size : 0; } catch { baseline = 0; }

  const reveal = (why) => {
    if (revealed) return;
    revealed = true;
    showWindowsForPid(pid, 5);
    clearInterval(watchTimer);
    watchTimer = null;
    onState?.(why);
  };

  watchTimer = setInterval(() => {
    // keep hiding: Dolphin can open its window a moment after launch
    if (!revealed && Date.now() - started < 6000) showWindowsForPid(pid, 0);

    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(watchTimer);
      watchTimer = null;
      onState?.("gone");
      return;
    }

    if (fs.existsSync(log)) {
      let text = "";
      try {
        const size = fs.statSync(log).size;
        if (size < baseline) baseline = 0;          // log was rotated/cleared
        if (size > baseline) {
          const fd = fs.openSync(log, "r");
          try {
            const buf = Buffer.alloc(size - baseline);
            fs.readSync(fd, buf, 0, buf.length, baseline);
            text = buf.toString("latin1");
          } finally { fs.closeSync(fd); }
        }
      } catch { /* mid-write; try again next tick */ }
      if (text.includes("Connection success!")) return reveal("connected");
    }
    if (Date.now() - started > revealAfterMs) reveal("timeout");
  }, 500);

  showWindowsForPid(pid, 0);
  onState?.("hidden");
}
