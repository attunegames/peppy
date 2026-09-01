// A stand-in opponent for testing the app by hand.
//
// Runs a simulated Fort Wayne regular: joins the queue, stays online, and
// accepts whatever Peppy proposes - so you can drive the real app on this PC
// and watch the rotation behave with a second person present.
//
//   node tools/fake-opponent.mjs            join and accept everything
//   node tools/fake-opponent.mjs --lose     also report a loss after each match
//   node tools/fake-opponent.mjs --leave    just leave the queue and exit
import { testDevice, signIn, rpc } from "./test-device.mjs";

const CODE = "FAKE#001";
const NAME = "Practice Dummy";
const args = process.argv.slice(2);
const REPORT_LOSS = args.includes("--lose");

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

const main = async () => {
  const me = testDevice("fakeOpponent");
  await signIn(me, "fake opponent");
  await rpc(me, "peppy_claim_code", { p_code: CODE, p_name: NAME });

  if (args.includes("--leave")) {
    await rpc(me, "peppy_queue_leave");
    log("left the queue");
    return;
  }

  await rpc(me, "peppy_queue_set", { p_state: "waiting" });
  log(`${NAME} (${CODE}) joined the queue - Ctrl+C to stop`);

  let announced = null;
  for (;;) {
    try {
      await rpc(me, "peppy_heartbeat", { p_char: "FOX", p_stage: 31 });

      // accept any direct challenge aimed at us
      const inbox = await rpc(me, "peppy_inbox");
      if (inbox?.[0]) {
        log("accepting direct challenge from", inbox[0].from_code);
        await rpc(me, "peppy_challenge_respond", { p_id: inbox[0].challenge_id, p_accept: true });
      }

      // accept whatever the rotation proposes
      const pairing = (await rpc(me, "peppy_my_pairing"))?.[0];
      if (pairing && pairing.state === "pending" && !pairing.i_accepted) {
        log(`paired with ${pairing.other_code} - accepting`);
        await rpc(me, "peppy_pairing_respond", { p_id: pairing.pairing_id, p_accept: true });
      }
      if (pairing?.state === "ready" && announced !== pairing.pairing_id) {
        announced = pairing.pairing_id;
        log("both ready - your Peppy should be launching Melee now");
        if (REPORT_LOSS) {
          setTimeout(async () => {
            try {
              await rpc(me, "peppy_report_result", {
                p_opponent_code: pairing.other_code, p_i_won: false,
                p_match_key: "fake-" + Date.now(),
              });
              log("reported a loss, so you keep the setup");
            } catch (e) { log("could not report:", e.message); }
          }, 20000);
        }
      }

      const q = await rpc(me, "peppy_queue_list");
      const line = q.map((r) =>
        `${r.connect_code}${r.is_king ? "(K)" : ""}:${r.state}${r.sweeps ? " sw" + r.sweeps : ""}`).join("  ");
      process.stdout.write(`\r  queue: ${line || "(empty)"}                    `);
    } catch (e) {
      log("error:", e.message);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
};

process.on("SIGINT", async () => {
  try {
    const me = testDevice("fakeOpponent");
    await rpc(me, "peppy_queue_leave");
    console.log("\nleft the queue. bye");
  } catch { /* best effort */ }
  process.exit(0);
});

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
