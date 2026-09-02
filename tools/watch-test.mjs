// Peppy must notice Melee closing AFTER a match connected - that is what
// reports the result and lets the rotation move on. The watcher used to switch
// itself off at the reveal, so a match that connected was never seen to end.
import { spawn } from "node:child_process";
import * as d from "../orchestrator/dolphin.mjs";

const ok = (label, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a stand-in for Dolphin: something that stays alive until we close it
const fake = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
  { stdio: "ignore" });
await wait(1500);

const states = [];
d.hideUntilConnected(fake.pid, (s) => states.push(s), { revealAfterMs: 1500 });

await wait(4000);
ok("the match is revealed", states.includes("timeout") || states.includes("connected"));
ok("nothing has ended yet", !states.includes("gone"));

fake.kill();
await wait(2500);
ok("closing the game is still noticed after the reveal", states.includes("gone"));
console.log("states:", states.join(" -> "));

d.killAll();
process.exit(states.includes("gone") ? 0 : 1);
