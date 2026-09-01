// End-to-end test against the live Peppy server.
//
// Simulates two devices (two anonymous sessions) and walks the whole flow:
// claim -> queue -> challenge -> accept -> played -> friends. Also checks that
// the row-level security actually blocks direct writes, since the key is public.
//
// Uses throwaway codes so it never squats on a real player's connect code.
// Run: node tools/live-test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "config.json"), "utf-8"));

// Fresh each run: a claimed code belongs to the device that claimed it, and
// every run signs in as brand new anonymous devices.
const n = () => String(Math.floor(Math.random() * 900) + 99);
const A_CODE = `TSTA#${n()}`;
const B_CODE = `TSTB#${n()}`;

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

function memClient() {
  const mem = {};
  return createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: {
      storage: {
        getItem: (k) => mem[k] ?? null,
        setItem: (k, v) => { mem[k] = v; },
        removeItem: (k) => { delete mem[k]; },
      },
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    },
  });
}

const rpc = async (c, name, args = {}) => {
  const { data, error } = await c.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
};

const main = async () => {
  const A = memClient(), B = memClient();

  // --- anonymous sign-in (device identity) ---
  const a = await A.auth.signInAnonymously();
  const b = await B.auth.signInAnonymously();
  ok("anonymous sign-in works (device A)", !a.error && !!a.data.session, a.error?.message ?? "");
  ok("anonymous sign-in works (device B)", !b.error && !!b.data.session, b.error?.message ?? "");
  if (a.error || b.error) return;

  // --- claim codes ---
  const pa = await rpc(A, "peppy_claim_code", { p_code: A_CODE, p_name: "TesterA" });
  const pb = await rpc(B, "peppy_claim_code", { p_code: B_CODE, p_name: "TesterB" });
  ok("device A claimed its code", pa?.connect_code === A_CODE);
  ok("device B claimed its code", pb?.connect_code === B_CODE);

  // --- a code can only be claimed once ---
  let stolen = null;
  try { await rpc(B, "peppy_claim_code", { p_code: A_CODE }); stolen = "no error"; }
  catch (e) { stolen = e.message; }
  ok("someone else cannot steal a claimed code", /already claimed/.test(stolen), stolen);

  // --- bad codes rejected ---
  let badCode = null;
  try { await rpc(A, "peppy_claim_code", { p_code: "nonsense" }); badCode = "accepted!"; }
  catch (e) { badCode = e.message; }
  ok("malformed connect codes rejected", /connect code/.test(badCode));

  // --- RLS: no direct writes with the public key ---
  const direct = await A.from("peppy_players").update({ display_name: "hacked" })
    .eq("connect_code", B_CODE).select();
  ok("cannot edit someone else's player row",
    (direct.data?.length ?? 0) === 0, direct.error?.message ?? "no rows changed");

  const inject = await A.from("peppy_queue").insert({ player: pb.id, state: "waiting" }).select();
  ok("cannot queue on someone else's behalf", !!inject.error, inject.error?.message ?? "INSERT SUCCEEDED");

  // --- queue ---
  await rpc(A, "peppy_queue_set", { p_state: "waiting" });
  await rpc(B, "peppy_queue_set", { p_state: "waiting" });
  let q = await rpc(A, "peppy_queue_list");
  ok("both players show in the queue", q.filter((r) => [A_CODE, B_CODE].includes(r.connect_code)).length === 2);
  ok("queue reports presence", q.every((r) => typeof r.online === "boolean"));

  await rpc(B, "peppy_queue_set", { p_state: "spectating" });
  q = await rpc(A, "peppy_queue_list");
  ok("spectating is reflected in the queue",
    q.find((r) => r.connect_code === B_CODE)?.state === "spectating");
  await rpc(B, "peppy_queue_set", { p_state: "waiting" });

  // --- challenge handshake ---
  const ch = await rpc(A, "peppy_challenge_create", { p_code: B_CODE, p_stage: 28 });
  ok("challenge created", ch?.state === "pending" && ch.stage_id === 28);

  const inboxB = await rpc(B, "peppy_inbox");
  ok("challenge lands in the other player's inbox",
    inboxB?.[0]?.challenge_id === ch.id && inboxB[0].from_code === A_CODE);
  ok("inbox carries a 5-minute deadline", (() => {
    const mins = (new Date(inboxB[0].expires_at) - new Date(inboxB[0].created_at)) / 60000;
    return Math.abs(mins - 5) < 0.1;
  })());

  q = await rpc(A, "peppy_queue_list");
  ok("challenged player is marked as challenged",
    q.find((r) => r.connect_code === B_CODE)?.state === "challenged");

  // only the recipient may answer
  let wrongResponder = null;
  try { await rpc(A, "peppy_challenge_respond", { p_id: ch.id, p_accept: true }); wrongResponder = "allowed!"; }
  catch (e) { wrongResponder = e.message; }
  ok("challenger cannot accept their own challenge", /not yours/.test(wrongResponder), wrongResponder);

  const accepted = await rpc(B, "peppy_challenge_respond", { p_id: ch.id, p_accept: true });
  ok("recipient can accept", accepted?.state === "accepted");

  q = await rpc(A, "peppy_queue_list");
  ok("both players move to playing",
    q.filter((r) => [A_CODE, B_CODE].includes(r.connect_code)).every((r) => r.state === "playing"));

  // --- after the match ---
  await rpc(A, "peppy_record_played", { p_code: B_CODE });
  const recentA = await rpc(A, "peppy_recent_list");
  const recentB = await rpc(B, "peppy_recent_list");
  ok("recently-played recorded for both sides",
    recentA.some((r) => r.connect_code === B_CODE) && recentB.some((r) => r.connect_code === A_CODE));

  // Recording a match no longer touches the queue: with only these two in the
  // pool they stay in-session and keep playing, which is the "uninterrupted
  // until someone joins" rule. Releasing players is peppy_report_result's job.
  q = await rpc(A, "peppy_queue_list");
  ok("a two-player session keeps playing after a recorded game",
    q.filter((r) => [A_CODE, B_CODE].includes(r.connect_code)).every((r) => r.state === "playing"));

  // --- friends ---
  await rpc(A, "peppy_friend_add", { p_code: B_CODE });
  const friendsA = await rpc(A, "peppy_friend_list");
  ok("friend added", friendsA.some((f) => f.connect_code === B_CODE));
  ok("friend list shows not-yet-mutual", friendsA.find((f) => f.connect_code === B_CODE)?.mutual === false);
  await rpc(B, "peppy_friend_add", { p_code: A_CODE });
  const friendsA2 = await rpc(A, "peppy_friend_list");
  ok("friendship becomes mutual", friendsA2.find((f) => f.connect_code === B_CODE)?.mutual === true);

  // --- cleanup so the test never leaves players in the queue ---
  await rpc(A, "peppy_queue_leave");
  await rpc(B, "peppy_queue_leave");
  const qEnd = await rpc(A, "peppy_queue_list");
  ok("test players cleaned out of the queue",
    !qEnd.some((r) => [A_CODE, B_CODE].includes(r.connect_code)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
