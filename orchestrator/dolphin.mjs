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

function buildGeckoIni({ stageId, character, color, stagePicker = true }) {
  // Exactly ONE side of a match may pick the stage. It is the same role pair
  // the game itself uses (ISWINNER / CHOSESTAGE), so when both clients claimed
  // it, both believed they had lost game 1 and both drove the stage select for
  // game 2 - it landed on Princess Peach's Castle and froze both machines.
  // The follower takes the winner role and names no stage.
  let autoDirect;
  if (!stagePicker) {
    autoDirect = GECKOS.autoDirectFollow;
  } else if (stageId === "random" || stageId == null) {
    // the build whose lock-in asks the game for a random legal stage
    autoDirect = GECKOS.autoDirectRandom;
  } else {
    const patched = `3860${(stageId & 0xff).toString(16).toUpperCase().padStart(4, "0")}`;
    autoDirect = GECKOS.autoDirect.split(GECKOS.stageWordToken).join(patched);
  }
  // Only Peppy's own patches ship. libmelee's "Extract Menu Info" gecko
  // (LGPL-3.0, altf4/Fizzi) was a development aid for reading game state; the
  // app watches Slippi's log instead, so no third-party code is bundled.
  let body = "[Gecko]\n$AutoDirect [peppy]\n" + autoDirect +
    "\n$AutoBoot [peppy]\n" + GECKOS.autoBoot;
  let enabled = "\n\n[Gecko_Enabled]\n$AutoDirect\n$AutoBoot\n";
  const who = character && character.toUpperCase();
  const pick = who && GECKOS.charPick[who];
  let press = who && GECKOS.charPress[who];
  if (pick && press) {
    // Costume: X presses while the cursor hovers, before A chooses. That order
    // matters - the press code stops the moment a character is chosen, so an X
    // press after the A press never happens, which is why v0.8.x came back
    // costume 0 in every replay.
    const n = Math.max(0, Math.min((GECKOS.costumes?.[who] ?? 6) - 1, Number(color) || 0));
    press = press.split(GECKOS.colorToken)
      .join(`3BE000${n.toString(16).toUpperCase().padStart(2, "0")}`);
    body += "\n$CharPick [peppy]\n" + pick +
      "\n$CharPress [peppy]\n" + press;
    enabled += "$CharPick\n$CharPress\n";
  }
  return body + enabled;
}

/** The usable desktop, so the game can fill it without covering the taskbar. */
let cachedScreen = null;
function screenSize() {
  if (cachedScreen) return cachedScreen;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; \"$($a.Width)x$($a.Height)\""],
      { encoding: "utf8", timeout: 10000 }).trim();
    const [w, h] = out.split("x").map(Number);
    if (w > 200 && h > 200) cachedScreen = { width: w, height: h };
  } catch { /* fall through to something sane */ }
  return (cachedScreen ??= { width: 1600, height: 900 });
}

/** Set `key = value` in a Dolphin ini, leaving the rest of the file alone. */
function setIniValue(text, key, value) {
  const line = new RegExp(`^${key}\\s*=.*$`, "mi");
  return line.test(text) ? text.replace(line, `${key} = ${value}`) : text;
}

const LOG_REL = path.join("User", "Logs", "dolphin.log");

// Everything a match launch needs. opponentCode is plain ASCII ("ABCD#123").
export function writeMatchConfigs({ opponentCode, stageId = STAGES.BATTLEFIELD,
                                   character, color = 0, stagePicker = true,
                                   windowMode = "maximized" }) {
  const user = path.join(SANDBOX, "User");
  for (const dir of ["Config", "GameSettings", "Slippi", "Logs"]) {
    fs.mkdirSync(path.join(user, dir), { recursive: true });
  }
  // Mirror the player's real Dolphin settings (their controller, video, delay).
  const realIni = path.join(SLIPPI_DIR, "netplay", "User", "Config", "Dolphin.ini");
  try {
    fs.copyFileSync(realIni, path.join(user, "Config", "Dolphin.ini"));
    const ini = path.join(user, "Config", "Dolphin.ini");
    let text = fs.readFileSync(ini, "utf8");
    // Peppy hides the window on purpose while it drives the menus, so this
    // setting would pause the emulator mid-launch and stall both sides.
    text = text.replace(/PauseOnFocusLost\s*=\s*True/gi, "PauseOnFocusLost = False");
    // Whether the game opens fullscreen is the player's choice in Peppy, not a
    // leftover from however their own Dolphin happened to be set. Everything
    // else - controller, video backend, delay - is still theirs.
    text = setIniValue(text, "Fullscreen", windowMode === "fullscreen" ? "True" : "False");
    // Peppy closes the game itself when the queue needs the setup; a
    // confirmation dialog would leave it sitting there instead.
    text = setIniValue(text, "ConfirmStop", "False");
    // "Maximized" is Dolphin's own render-window size, not a ShowWindow call.
    // Maximising by hand picked the wrong window - Dolphin's main window is
    // the one titled "Faster Melee - Slippi", so the game stayed small and the
    // game-list window filled the screen.
    if (windowMode === "maximized") {
      const { width, height } = screenSize();
      // The size below belongs to the render window, so the game has to have
      // one: with RenderToMain the game draws inside the small game-list
      // window and none of this applies. "However Dolphin is set" leaves the
      // player's own choice alone.
      text = setIniValue(text, "RenderToMain", "False");
      text = setIniValue(text, "RenderWindowAutoSize", "False");
      text = setIniValue(text, "RenderWindowXPos", "0");
      text = setIniValue(text, "RenderWindowYPos", "0");
      text = setIniValue(text, "RenderWindowWidth", String(width));
      text = setIniValue(text, "RenderWindowHeight", String(height));
    }
    fs.writeFileSync(ini, text);
  } catch { /* keep the copy we already have rather than refusing to play */ }
  // Mirror their graphics settings too, and make fullscreen BORDERLESS: an
  // exclusive-fullscreen Dolphin that Peppy hid and showed again could be
  // heard but never tabbed back into.
  try {
    const realGfx = path.join(SLIPPI_DIR, "netplay", "User", "Config", "GFX.ini");
    const gfx = path.join(user, "Config", "GFX.ini");
    if (fs.existsSync(realGfx)) fs.copyFileSync(realGfx, gfx);
    let text = fs.existsSync(gfx) ? fs.readFileSync(gfx, "utf8") : "[Settings]\n";
    if (!/^\[Settings\]/m.test(text)) text += "\n[Settings]\n";
    text = /^BorderlessFullscreen\s*=/mi.test(text)
      ? setIniValue(text, "BorderlessFullscreen", "True")
      : text.replace(/^\[Settings\][^\n]*$/mi, "[Settings]\nBorderlessFullscreen = True");
    fs.writeFileSync(gfx, text);
  } catch { /* graphics settings are a nicety, never a reason not to play */ }

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
    buildGeckoIni({ stageId, character, color, stagePicker }));
  fs.writeFileSync(path.join(user, "Slippi", "direct-codes.json"),
    JSON.stringify([{ connectCode: toFullWidth(opponentCode), lastPlayed: Math.floor(Date.now() / 1000) }]));
}

let dolphinProc = null;
let watchTimer = null;

export function launch({ isoPath }) {
  killAll();
  const exe = path.join(SANDBOX, "Slippi Dolphin.exe");
  // -b (batch) makes Dolphin exit when emulation stops. Without it, closing
  // the game left the emulator window up, Peppy never saw the match end, the
  // queue kept showing you as playing, and the next match refused to launch.
  dolphinProc = spawn(exe, ["-b", "-e", isoPath, "-u", path.join(SANDBOX, "User")], {
    stdio: "ignore",
  });
  return dolphinProc.pid;
}

/** Is a match actually running right now? */
export function isRunning() {
  if (!dolphinProc?.pid) return false;
  try {
    process.kill(dolphinProc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End the match Peppy started, politely.
 *
 * killAll force-kills every Dolphin by name. That is right before a launch -
 * clear the decks - and wrong for ending a session: a forced kill gives Dolphin
 * no chance to tell the other player it is going (which is what leaves them
 * staring at a connection error), and killing by name would also take down a
 * second Dolphin someone had open watching a replay. This asks OUR process to
 * close, and only forces it if it will not go.
 */
export async function closeMatch({ forceAfterMs = 4000 } = {}) {
  const pid = dolphinProc?.pid;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  stopHiding();
  if (!pid) return killAll();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" });   // asks
  } catch { /* already gone */ }
  const deadline = Date.now() + forceAfterMs;
  while (Date.now() < deadline && isRunning()) await sleep(150);
  if (isRunning()) {
    try {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
    } catch { /* raced us */ }
    for (let i = 0; i < 20 && isRunning(); i++) await sleep(150);
  }
  dolphinProc = null;
}

/**
 * Close every Dolphin, including one the player started from the Slippi
 * Launcher themselves, and wait for it to actually be gone. A match cannot
 * start while another Dolphin holds the config and log files open, and
 * accepting a challenge with Dolphin already open used to look like nothing
 * happening at all.
 */
export function killAll() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  stopHiding();
  for (const name of ["Slippi Dolphin.exe", "Dolphin.exe"]) {
    try {
      execFileSync("taskkill", ["/F", "/IM", name], { stdio: "ignore" });
    } catch { /* that one was not running */ }
  }
  // taskkill returns before Windows has finished tearing the process down.
  for (let i = 0; i < 20 && dolphinIsUp(); i++) sleepSync(150);
  dolphinProc = null;
}

function dolphinIsUp() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Slippi Dolphin.exe"],
      { encoding: "utf8", timeout: 5000 });
    return out.includes("Slippi Dolphin.exe");
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- window visibility -----------------------------------------------------
// Dolphin opens TWO top-level windows: "Dolphin" (the emulator shell) and the
// render window ("Faster Melee - Slippi ..."). Unless the player has
// RenderToMain switched on - then there is only one, and the game draws inside
// it.
//
// The old code drove Process.MainWindowHandle, which is wrong twice over: it
// only ever returns ONE window (so the render window stayed on screen for most
// people), and .NET only reports a handle for a VISIBLE window (so once hidden,
// nothing could ever show it again). A tester with RenderToMain ended up in a
// match he could hear but not see, with no way to get the window back.
//
// So: enumerate the windows ourselves, remember exactly which ones we hid, and
// put exactly those back.
const WIN_HELPER = `
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PeppyWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static string List(uint target) {
    var sb = new StringBuilder();
    EnumWindows((h, p) => {
      uint id; GetWindowThreadProcessId(h, out id);
      if (id == target && GetWindowTextLength(h) > 0) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        sb.Append(h.ToInt64() + "~" + (IsWindowVisible(h) ? "1" : "0") + "~" + t.ToString() + ";");
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
function Get-Windows($target) {
  [PeppyWin]::List($target) -split ';' | Where-Object { $_ } | ForEach-Object {
    $f = $_ -split '~'
    [pscustomobject]@{ H = [int64]$f[0]; Visible = ($f[1] -eq '1'); Title = $f[2] }
  }
}`;

const SPLIT_LINES = /\s+/;

let hider = null;              // the child that keeps windows hidden while booting
let hiddenHandles = new Set(); // what we actually hid, so we can show it back

const powershell = (script, opts = {}) =>
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 15000, ...opts });

/** Keep Dolphin's windows hidden for the first `ms` while the menus are driven. */
function hideWindows(pid, ms) {
  stopHiding();
  hiddenHandles = new Set();
  const script = `${WIN_HELPER}
$deadline = (Get-Date).AddMilliseconds(${ms})
while ((Get-Date) -lt $deadline) {
  foreach ($w in (Get-Windows ${pid})) {
    if ($w.Visible) { [void][PeppyWin]::ShowWindow([IntPtr]$w.H, 0); Write-Output $w.H }
  }
  Start-Sleep -Milliseconds 200
}`;
  hider = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["ignore", "pipe", "ignore"] });
  hider.stdout.on("data", (buf) => {
    for (const line of String(buf).split(SPLIT_LINES)) {
      const h = line.trim();
      if (h) hiddenHandles.add(h);
    }
  });
  hider.on("close", () => { hider = null; });
}

function stopHiding() {
  if (hider) { try { hider.kill(); } catch { /* already gone */ } hider = null; }
}

/**
 * Put the windows back. Shows exactly what we hid, plus - belt and braces - any
 * window of Dolphin's that is still hidden and looks like the emulator or the
 * game, in case we launched one we never recorded.
 *
 * Returns how many of Dolphin's windows are visible afterwards. How big the
 * game window is comes from Dolphin's own config (see writeMatchConfigs), not
 * from here - picking a window to maximise by title chose the wrong one.
 */
function revealWindows(pid) {
  stopHiding();
  const csv = [...hiddenHandles].join(",");
  const script = `${WIN_HELPER}
foreach ($h in ('${csv}' -split ',' | Where-Object { $_ })) {
  $ptr = [IntPtr][int64]$h
  if ([PeppyWin]::IsWindow($ptr)) { [void][PeppyWin]::ShowWindow($ptr, 5) }
}
foreach ($w in (Get-Windows ${pid})) {
  if (-not $w.Visible -and ($w.Title -eq 'Dolphin' -or $w.Title -like '*Faster Melee*' -or
      $w.Title -like '*Slippi*' -or $w.Title -like '*GALE01*' -or $w.Title -like '*Melee*')) {
    [void][PeppyWin]::ShowWindow([IntPtr]$w.H, 5)
  }
}
$shown = @(Get-Windows ${pid} | Where-Object { $_.Visible })
if ($shown.Count -gt 0) { [void][PeppyWin]::SetForegroundWindow([IntPtr]$shown[0].H) }
$shown.Count`;
  try {
    return Number(String(powershell(script)).trim()) || 0;
  } catch {
    return 0;
  }
}

/** Manual escape hatch: show the running match's windows on demand. */
export function revealNow() {
  if (!dolphinProc?.pid) return { ok: false, error: "no match is running" };
  const shown = revealWindows(dolphinProc.pid);
  return { ok: shown > 0, shown };
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
    let shown = revealWindows(pid);
    // Showing a window can lose a race with Dolphin creating it. Never leave a
    // player in a match they can hear but not see.
    for (let retry = 0; retry < 3 && shown === 0; retry++) shown = revealWindows(pid);
    // The watcher stays up. It used to stop here, which meant Peppy never saw
    // Melee close after a match it had connected: no replay was read, no result
    // was reported, and the pairing sat 'ready' on the server so the rotation
    // could not move on.
    onState?.(why);
  };

  watchTimer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(watchTimer);
      watchTimer = null;
      onState?.("gone");
      return;
    }
    if (revealed) return;         // from here we are only waiting for the exit

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

  // A separate hider keeps every window of Dolphin's off screen while the
  // patches drive the menus, including the render window that appears a few
  // seconds in.
  hideWindows(pid, 20000);
  onState?.("hidden");
}
