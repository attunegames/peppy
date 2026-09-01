// Shared test helper: a simulated PC whose identity SURVIVES between runs.
//
// Anonymous sign-ins are rate limited (Supabase returns 429 after ~30/hour per
// IP by default). Creating fresh devices on every test run burned through that
// allowance in an afternoon, so each named test device keeps its session in
// tools/.test-sessions/ and signs in only the first time it is ever used.
//
// Stable devices also mean stable connect codes: a device re-claiming the code
// it already owns is allowed, so tests no longer need randomised codes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SESSIONS = path.join(HERE, ".test-sessions");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "config.json"), "utf-8"));

export function testDevice(name) {
  const file = path.join(SESSIONS, `${name}.json`);
  const storage = {
    getItem: (k) => {
      try { return JSON.parse(fs.readFileSync(file, "utf-8"))[k] ?? null; } catch { return null; }
    },
    setItem: (k, v) => {
      let all = {};
      try { all = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* first use */ }
      all[k] = v;
      fs.mkdirSync(SESSIONS, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
    },
    removeItem: (k) => {
      try {
        const all = JSON.parse(fs.readFileSync(file, "utf-8"));
        delete all[k];
        fs.writeFileSync(file, JSON.stringify(all));
      } catch { /* nothing stored */ }
    },
  };
  return createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

/** Sign in only if this device has never been used before. */
export async function signIn(client, label) {
  const { data: { session } } = await client.auth.getSession();
  if (session) return session;
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    throw new Error(
      `${label}: ${error.message}` +
      (error.status === 429
        ? "\n\nAnonymous sign-ins are rate limited. Either wait for the window to\n" +
          "reset, or raise it in Supabase: Authentication -> Rate Limits ->\n" +
          "anonymous sign-ins. Existing test devices in tools/.test-sessions/\n" +
          "do not need to sign in again."
        : ""));
  }
  return data.session;
}

export const rpc = async (client, name, args = {}) => {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
};
