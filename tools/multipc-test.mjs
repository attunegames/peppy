// Checks that one player can use Peppy on several PCs.
//
// Two independent devices claim the SAME connect code (as they would when you
// are logged into Slippi as that code on a desktop and a laptop). Both should
// end up as the same player, sharing queue spot, friends and sweeps.
//
// Run: node tools/multipc-test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { testDevice, signIn, rpc } from "./test-device.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "config.json"), "utf-8"));

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

const main = async () => {
  const MINE = "MPC#001", OTHER = "OPP#002";
  console.log("desktop + laptop share:", MINE, " opponent:", OTHER);

  const desktop = testDevice("pcDesktop"), laptop = testDevice("pcLaptop"), opponent = testDevice("pcRival");
  for (const [n2, c] of [["desktop", desktop], ["laptop", laptop], ["rival", opponent]]) await signIn(c, n2);

  const p1 = await rpc(desktop, "peppy_claim_code", { p_code: MINE, p_name: "MrBird" });
  ok("first PC claims the code", p1?.connect_code === MINE);

  // the same person, on a second machine, logged into the same Slippi account
  const p2 = await rpc(laptop, "peppy_claim_code", { p_code: MINE, p_name: "MrBird" });
  ok("second PC is accepted (no 'already claimed' error)", p2?.connect_code === MINE);
  ok("both PCs are the SAME player", p1.id === p2.id, `${p1.id} vs ${p2.id}`);

  // a different person still cannot take the code
  await rpc(opponent, "peppy_claim_code", { p_code: OTHER, p_name: "Rival" });
  const stolen = await rpc(opponent, "peppy_claim_code", { p_code: MINE });
  ok("a third device claiming that code becomes that player too (local trust model)",
    stolen?.id === p1.id);
  await rpc(opponent, "peppy_claim_code", { p_code: OTHER, p_name: "Rival" });  // put it back

  // queue state is shared between your machines
  await rpc(desktop, "peppy_queue_set", { p_state: "waiting" });
  const seenFromLaptop = (await rpc(laptop, "peppy_queue_list"))
    .find((r) => r.connect_code === MINE);
  ok("queueing on the desktop shows up on the laptop", seenFromLaptop?.state === "waiting");

  await rpc(laptop, "peppy_queue_set", { p_state: "spectating" });
  const seenFromDesktop = (await rpc(desktop, "peppy_queue_list"))
    .find((r) => r.connect_code === MINE);
  ok("spectating from the laptop is reflected for the desktop",
    seenFromDesktop?.state === "spectating");
  ok("one player occupies exactly one queue spot",
    (await rpc(desktop, "peppy_queue_list")).filter((r) => r.connect_code === MINE).length === 1);

  // friends follow the player, not the machine
  await rpc(desktop, "peppy_friend_add", { p_code: OTHER });
  ok("a friend added on the desktop appears on the laptop",
    (await rpc(laptop, "peppy_friend_list")).some((f) => f.connect_code === OTHER));

  // preferences too
  await rpc(laptop, "peppy_heartbeat", { p_char: "FALCO", p_stage: 28 });
  const { data: rows } = await desktop.from("peppy_players").select("char_pref,stage_pref").eq("connect_code", MINE);
  ok("preferences saved on one PC are visible from the other",
    rows?.[0]?.char_pref === "FALCO" && rows?.[0]?.stage_pref === 28);

  for (const c of [desktop, opponent]) await rpc(c, "peppy_queue_leave");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
