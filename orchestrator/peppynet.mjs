// PEPPY's connection to the shared Fort Wayne server (Supabase).
//
// Runs in Electron's main process, never in the page, and talks to the
// renderer over the same IPC bridge the game launcher uses.
//
// Identity: each install signs in anonymously once, which gives it a durable
// account, then claims a connect code. The session is written to
// %APPDATA%/Peppy/session.json so the device keeps that identity across
// restarts. Adding email or Discord login later attaches to the same account.
//
// Everything here degrades gracefully: if the server is unreachable the app
// still works for direct challenges, it just cannot show the shared queue.

import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

const CONFIG = JSON.parse(
  fs.readFileSync(new URL("../resources/config.json", import.meta.url), "utf-8"),
);
const SESSION_FILE = path.join(process.env.APPDATA, "Peppy", "session.json");

// supabase-js expects a browser-style storage object; keep the session on disk
// so this device stays the same player between launches.
const diskStorage = {
  getItem: (key) => {
    try {
      const all = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      return all[key] ?? null;
    } catch { return null; }
  },
  setItem: (key, value) => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")); } catch { /* first run */ }
    all[key] = value;
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(all));
  },
  removeItem: (key) => {
    try {
      const all = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      delete all[key];
      fs.writeFileSync(SESSION_FILE, JSON.stringify(all));
    } catch { /* nothing stored */ }
  },
};

let sb = null;
let me = null;          // our peppy_players row
let lastError = null;

function client() {
  if (!sb) {
    sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: {
        storage: diskStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return sb;
}

async function rpc(name, args) {
  const { data, error } = await client().rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

/** Sign in (anonymously, once per device) and load our player row if claimed. */
export async function connect() {
  try {
    const c = client();
    let { data: { session } } = await c.auth.getSession();
    if (!session) {
      const { data, error } = await c.auth.signInAnonymously();
      if (error) throw new Error(error.message);
      session = data.session;
    }
    if (!session) throw new Error("could not start a session");

    const { data: rows, error } = await c
      .from("peppy_players")
      .select("*")
      .eq("auth_id", session.user.id)
      .limit(1);
    if (error) throw new Error(error.message);
    me = rows?.[0] ?? null;
    lastError = null;
    return { ok: true, player: me };
  } catch (err) {
    lastError = String(err.message ?? err);
    return { ok: false, error: lastError };
  }
}

export function status() {
  return { online: !!me || !lastError, player: me, error: lastError };
}

export async function claimCode(code, name) {
  me = await rpc("peppy_claim_code", { p_code: code, p_name: name ?? null });
  return me;
}

export async function heartbeat(character, stage) {
  if (!me) return;
  await rpc("peppy_heartbeat", {
    p_char: character ?? null,
    p_stage: stage == null ? null : Number(stage),
  });
}

export const queueJoin = () => rpc("peppy_queue_set", { p_state: "waiting" });
export const queueSpectate = () => rpc("peppy_queue_set", { p_state: "spectating" });
export const queueLeave = () => rpc("peppy_queue_leave", {});
export const queueList = () => rpc("peppy_queue_list", {});

export const challengeCreate = (code, stage) =>
  rpc("peppy_challenge_create", {
    p_code: code,
    p_stage: stage == null ? null : Number(stage),
  });
export const challengeRespond = (id, accept) =>
  rpc("peppy_challenge_respond", { p_id: id, p_accept: !!accept });
export const challengeCancel = (id) => rpc("peppy_challenge_cancel", { p_id: id });
export const inbox = () => rpc("peppy_inbox", {});

export const friendAdd = (code) => rpc("peppy_friend_add", { p_code: code });
export const friendList = () => rpc("peppy_friend_list", {});
export const recentList = () => rpc("peppy_recent_list", {});
export const recordPlayed = (code) => rpc("peppy_record_played", { p_code: code });

/** Watch for a challenge sent to us, and for our own outgoing one being taken. */
export async function poll(sentChallengeId) {
  const out = { incoming: null, outgoing: null };
  out.incoming = (await inbox())?.[0] ?? null;
  if (sentChallengeId) {
    const { data, error } = await client()
      .from("peppy_challenges")
      .select("id,state,challenged")
      .eq("id", sentChallengeId)
      .limit(1);
    if (!error) out.outgoing = data?.[0] ?? null;
  }
  return out;
}
