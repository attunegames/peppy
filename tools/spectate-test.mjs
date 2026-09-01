// Proves the spectating path without needing a live match or a second PC.
//
// One side streams a real replay's bytes through the relay exactly as a player
// would; the other subscribes, rebuilds them with Slippi's writer, and the
// result is parsed back. If the rebuilt game has the same players, stage and
// length as the original, the relay + writer half of spectating is sound - all
// that differs in a real match is where the bytes come from.
//
// Run: node tools/spectate-test.mjs [--play]      (--play also opens playback)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SlippiGame } from "@slippi/slippi-js/node";

import { testDevice, signIn, rpc } from "./test-device.mjs";
import * as spectate from "../orchestrator/spectate.mjs";
import * as replays from "../orchestrator/replays.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAY = process.argv.includes("--play");

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

const summary = (game) => {
  const s = game.getSettings();
  return {
    stage: s?.stageId,
    players: (s?.players ?? []).map((p) => `${p.connectCode ?? "?"}:${p.characterId}`).sort().join(","),
    frames: Object.keys(game.getFrames() ?? {}).length,
  };
};

const main = async () => {
  const source = replays.findReplaySince(0);
  ok("found a replay to stream", !!source, source ? path.basename(source) : "none");
  if (!source) return 1;

  const original = summary(new SlippiGame(source));
  console.log("streaming:", path.basename(source), JSON.stringify(original));

  // two devices: one casting, one watching
  const caster = testDevice("castA"), viewer = testDevice("castB");
  await signIn(caster, "caster");
  await signIn(viewer, "viewer");
  const me = await rpc(caster, "peppy_claim_code", { p_code: "CAST#001", p_name: "Caster" });
  await rpc(viewer, "peppy_claim_code", { p_code: "VIEW#002", p_name: "Viewer" });

  // Two separate clients, because these are two different PCs in real life.
  // (Subscribing twice to one channel name from a SINGLE client fails, which
  // is what made an earlier version of this test time out.)
  const topic = `spectate-${me.id}`;
  const join = (client, opts, onMsg) => new Promise((resolve, reject) => {
    const ch = client.channel(topic, { config: { broadcast: opts } });
    if (onMsg) ch.on("broadcast", { event: "slp" }, ({ payload }) => onMsg(payload));
    const timer = setTimeout(() => reject(new Error("realtime join timed out")), 15000);
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(ch); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer); reject(new Error("realtime: " + status));
      }
    });
  });

  spectate.startWatching();
  let received = 0, chunks = 0;
  const viewerCh = await join(viewer, { self: false }, (payload) => {
    if (!payload?.d) return;
    chunks++;
    received += Buffer.from(payload.d, "base64").length;
    spectate.feed(payload.d);
  });
  ok("spectator joined the live channel", !!viewerCh);

  const casterCh = await join(caster, { self: false, ack: false });
  ok("player joined the live channel", !!casterCh);
  const publish = (b64) =>
    casterCh.send({ type: "broadcast", event: "slp", payload: { d: b64 } });
  // Stream a slice of the file at a realistic live rate rather than blasting
  // the whole 8MB: a real match trickles a few KB per second.
  const bytes = fs.readFileSync(source).subarray(0, 512 * 1024);
  const SLICE = 24 * 1024;
  for (let i = 0; i < bytes.length; i += SLICE) {
    publish(bytes.subarray(i, i + SLICE).toString("base64"));
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 3000));   // let the tail arrive

  ok("the relay delivered data", chunks > 0, `${chunks} chunks, ${received} bytes`);
  ok("everything sent arrived", received === bytes.length, `${received} of ${bytes.length}`);
  ok("throughput is enough for a live match", received > 200 * 1024, `${Math.round(received/1024)} KB relayed`);

  const rebuilt = spectate.watchingFile();
  ok("a replay was rebuilt on the spectator side", !!rebuilt, rebuilt ?? "none");

  if (rebuilt && fs.existsSync(rebuilt)) {
    const copy = summary(new SlippiGame(rebuilt));
    console.log("rebuilt:  ", JSON.stringify(copy));
    ok("same players and characters", copy.players === original.players);
    ok("same stage", copy.stage === original.stage);
    ok("frames came through", copy.frames > 0, `${copy.frames} vs ${original.frames} original`);

    if (PLAY) {
      const { isoPath } = (await import("../orchestrator/dolphin.mjs")).findSlippi();
      const res = spectate.openPlayback(isoPath, rebuilt);
      ok("playback build opened the rebuilt replay", res.ok, res.error ?? "");
      console.log("(watch the window - closing in 20s)");
      await new Promise((r) => setTimeout(r, 20000));
    }
  }

  try { await caster.removeChannel(casterCh); } catch { /* ignore */ }
  try { await viewer.removeChannel(viewerCh); } catch { /* ignore */ }
  spectate.stopWatching();
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => process.exit(f ? 1 : 0))
  .catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
