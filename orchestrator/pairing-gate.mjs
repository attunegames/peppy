// The poll loop asks the server "what pairing am I in?" every few seconds, and
// a pairing SITS in its state until the match result comes back - 'ready' is
// not an event, it is a condition that stays true for the whole match. So the
// loop has to remember what it already announced, or it re-announces "both
// ready, launch!" on every tick and Melee gets killed and relaunched in a loop.
export function makePairingGate() {
  let toldPending = null;
  let toldReady = null;
  return function announce(pairing) {
    if (!pairing) { toldPending = null; toldReady = null; return null; }
    const id = pairing.pairing_id;
    if (pairing.state === "pending" && id !== toldPending) {
      toldPending = id;
      return "pending";
    }
    if (pairing.state === "ready" && id !== toldReady) {
      toldReady = id;
      toldPending = null;
      return "ready";
    }
    return null;
  };
}
