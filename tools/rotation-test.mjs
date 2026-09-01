// Simulates a Fort Wayne friendlies night against the live server to check the
// rotation rules: winner stays, sweeps, the two-player uninterrupted case, and
// declining. Uses throwaway codes and cleans up after itself.
//
// Run: node tools/rotation-test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "config.json"), "utf-8"));

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

function device() {
  const mem = {};
  return createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: {
      storage: { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; }, removeItem: (k) => { delete mem[k]; } },
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    },
  });
}
const rpc = async (c, name, args = {}) => {
  const { data, error } = await c.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
};
let myCodes = [];   // set once this run's codes exist
const queue = async (c) => (await rpc(c, "peppy_queue_list"))
  .filter((r) => myCodes.includes(r.connect_code));
const pairingOf = async (c) => (await rpc(c, "peppy_my_pairing"))?.[0] ?? null;
const stateOf = (q, code) => q.find((r) => r.connect_code === code)?.state;

const main = async () => {
  const A = device(), B = device(), C = device();
  // Fresh codes each run: a claimed code belongs to the device that claimed it,
  // and every run signs in as brand new anonymous devices.
  const n = () => String(Math.floor(Math.random() * 900) + 99);
  const codes = { A: `RTA#${n()}`, B: `RTB#${n()}`, C: `RTC#${n()}` };
  myCodes = Object.values(codes);
  console.log("test codes:", myCodes.join("  "));

  for (const [k, c] of Object.entries({ A, B, C })) {
    await c.auth.signInAnonymously();
    await rpc(c, "peppy_claim_code", { p_code: codes[k], p_name: "Rot" + k });
    await rpc(c, "peppy_queue_leave");   // clean slate from any earlier run
  }
  console.log("--- two players ---");

  await rpc(A, "peppy_queue_set", { p_state: "waiting" });
  await rpc(B, "peppy_queue_set", { p_state: "waiting" });

  let pa = await pairingOf(A), pb = await pairingOf(B);
  ok("two players get paired", !!pa && !!pb && pa.pairing_id === pb.pairing_id);
  ok("the pairing names the opponent", pa?.other_code === codes.B, pa?.other_code ?? "");
  ok("nobody has accepted yet", pa?.i_accepted === false && pa?.they_accepted === false);

  await rpc(A, "peppy_pairing_respond", { p_id: pa.pairing_id, p_accept: true });
  let mid = await pairingOf(B);
  ok("one-sided accept does not start the match", mid?.state === "pending" && mid?.they_accepted === true);

  await rpc(B, "peppy_pairing_respond", { p_id: pa.pairing_id, p_accept: true });
  let q = await queue(A);
  ok("both accepted -> both playing",
    stateOf(q, codes.A) === "playing" && stateOf(q, codes.B) === "playing");

  // A wins. With only two of them, Peppy should stay out of the way.
  await rpc(A, "peppy_report_result", { p_opponent_code: codes.B, p_i_won: true, p_match_key: "game1-" + Date.now() });
  q = await queue(A);
  ok("two-player session keeps going after a game",
    stateOf(q, codes.A) === "playing" && stateOf(q, codes.B) === "playing");
  ok("no new prompt for a two-player session", (await pairingOf(A)) === null);
  ok("winner holds the setup", q.find((r) => r.connect_code === codes.A)?.is_king === true);

  console.log("--- a third player joins ---");
  await rpc(C, "peppy_queue_set", { p_state: "waiting" });
  ok("joining does not interrupt the game in progress", (await pairingOf(C)) === null);

  // that match ends: now the rotation takes over
  await rpc(A, "peppy_report_result", { p_opponent_code: codes.B, p_i_won: true, p_match_key: "game2-" + Date.now() });
  const pc = await pairingOf(C);
  ok("after the match, the rotation pairs the winner with the newcomer",
    !!pc && pc.other_code === codes.A, pc ? `C vs ${pc.other_code}` : "no pairing");

  await rpc(A, "peppy_pairing_respond", { p_id: pc.pairing_id, p_accept: true });
  await rpc(C, "peppy_pairing_respond", { p_id: pc.pairing_id, p_accept: true });

  console.log("--- the sweep ---");
  // A has already beaten B this reign; beating C clears the room.
  const swept = await rpc(A, "peppy_report_result", { p_opponent_code: codes.C, p_i_won: true, p_match_key: "game3-" + Date.now() });
  ok("beating everyone counts as a sweep", swept?.[0]?.swept === true, JSON.stringify(swept?.[0] ?? {}));
  ok("the sweep is counted on the player", (swept?.[0]?.sweeps ?? 0) >= 1);

  q = await queue(A);
  ok("sweeper gives up the setup", q.find((r) => r.connect_code === codes.A)?.is_king !== true);
  ok("sweeper goes to the back of the line",
    q.filter((r) => ["waiting", "challenged"].includes(r.state))
      .sort((x, y) => new Date(x.joined_at) - new Date(y.joined_at))
      .at(-1)?.connect_code === codes.A);
  ok("sweeps show up in the queue list for everyone",
    (await queue(B)).find((r) => r.connect_code === codes.A)?.sweeps >= 1);

  console.log("--- declining ---");
  const next = await pairingOf(B);
  ok("the next pair is proposed automatically", !!next, next?.other_code ?? "none");
  if (next) {
    await rpc(B, "peppy_pairing_respond", { p_id: next.pairing_id, p_accept: false });
    q = await queue(B);
    ok("declining drops you to spectating", stateOf(q, codes.B) === "spectating");
    ok("the other player keeps their place",
      ["waiting", "challenged"].includes(stateOf(q, next.other_code)));
  }

  // cleanup
  for (const c of [A, B, C]) await rpc(c, "peppy_queue_leave");
  const left = await queue(A);
  ok("test players cleaned up", left.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
