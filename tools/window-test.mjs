// Proves Peppy can hide Dolphin's windows and get them back.
// The bug this guards: a tester ended up in a match he could hear but not see.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as d from "../orchestrator/dolphin.mjs";

const ok = (label, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const visible = (pid) => {
  const script = `
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class T {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static string Visible(uint target) {
    var sb = new StringBuilder();
    EnumWindows((h, p) => {
      uint id; GetWindowThreadProcessId(h, out id);
      if (id == target && IsWindowVisible(h) && GetWindowTextLength(h) > 0) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        sb.Append(t.ToString() + ";");
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
[T]::Visible(${pid})`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return out.trim().split(";").filter(Boolean);
};

const { isoPath } = d.ensureSandbox();
const iniPath = path.join(process.env.APPDATA, "Peppy", "netplay", "User", "Config", "Dolphin.ini");

// Two setups matter: the render window separate (RenderToMain = False), and the
// game drawn inside the main window (True) - the second is what left a tester
// with audio and no window, because a hidden window has no MainWindowHandle.
async function run(renderToMain) {
  console.log(`
--- RenderToMain = ${renderToMain} ---`);
  d.writeMatchConfigs({ opponentCode: "TEST#001", stageId: 31, character: "FOX", color: 0 });
  const ini = fs.readFileSync(iniPath, "utf8");
  fs.writeFileSync(iniPath, ini.replace(/RenderToMain\s*=\s*\w+/i, `RenderToMain = ${renderToMain}`));
  const pid = d.launch({ isoPath });

  const states = [];
  d.hideUntilConnected(pid, (s) => states.push(s), { revealAfterMs: 25000 });

  await wait(9000);
  const whileHidden = visible(pid);
  console.log("visible while hiding:", JSON.stringify(whileHidden));
  ok("every Dolphin window is hidden during setup", whileHidden.length === 0);

  await wait(4000);
  ok("still hidden once the render window exists", visible(pid).length === 0);

  // Why the old reveal could never work: .NET only reports a MainWindowHandle
  // for a window that is currently visible.
  const mainHandles = execFileSync("powershell",
    ["-NoProfile", "-NonInteractive", "-Command",
     `(Get-Process -Id ${pid} -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object).Count`],
    { encoding: "utf8" }).trim();
  ok("a hidden Dolphin has no MainWindowHandle (the old reveal's only handle)",
    mainHandles === "0");

  const res = d.revealNow();
  await wait(1500);
  const shown = visible(pid);
  console.log("visible after reveal:", JSON.stringify(shown));
  ok("the reveal reports success", res.ok === true);
  ok("the game window comes back", shown.length > 0);
  ok("nothing unrelated was shown", !shown.some((t) => /TAS Input|Configuration/i.test(t)));

  d.killAll();
  await wait(1000);
}

await run("False");
await run("True");
