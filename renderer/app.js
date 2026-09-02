// PEPPY renderer.
//   - inside Electron (window.peppy present): real launches
//   - plain browser: mock mode for UI work
//
// `backend` talks to the shared Peppy server when it can reach it, and falls
// back to a local-only mode (direct challenges still work) when it cannot.

const bridge = window.peppy ?? null;
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("peppy." + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem("peppy." + k, JSON.stringify(v)); },
};

const net = bridge?.net ?? null;
let serverUp = false;          // set by boot(); false = offline mode

const backend = {
  me: { name: "You", code: store.get("myCode", "") },
  friends: store.get("friends", []),
  recent: store.get("recent", []),
  queue: [],
  spectators: [],
  listeners: new Set(),
  emit(e) { for (const fn of this.listeners) fn(e); },
  on(fn) { this.listeners.add(fn); },

  async joinQueue() {
    if (serverUp) { await net.queue("join"); await refreshFromServer(); return; }
    this.queue.push(this.me); this.emit({ type: "queue-updated" });
  },
  async leaveQueue() {
    if (serverUp) { await net.queue("leave"); await refreshFromServer(); return; }
    this.queue = this.queue.filter((p) => p.code !== this.me.code);
    this.spectators = this.spectators.filter((p) => p.code !== this.me.code);
    this.emit({ type: "queue-updated" });
  },
  async goSpectate() {
    if (serverUp) { await net.queue("spectate"); await refreshFromServer(); return; }
    this.queue = this.queue.filter((p) => p.code !== this.me.code);
    this.spectators.push(this.me);
    this.emit({ type: "queue-updated" });
  },
  async rejoinPool() {
    if (serverUp) { await net.queue("join"); await refreshFromServer(); return; }
    this.spectators = this.spectators.filter((p) => p.code !== this.me.code);
    this.queue.push(this.me);
    this.emit({ type: "queue-updated" });
  },

  // No server yet: a challenge is "ready as soon as you are". Once the shared
  // backend exists, accepting on the other side fires challenge-accepted and
  // that acceptance counts as their ready (decided 2026-08-05).
  async sendChallenge(code) {
    this.emit({ type: "challenge-sent", code });
    if (serverUp) {
      const res = await net.challenge(code, stageChoice());
      if (!res.ok) { this.emit({ type: "challenge-failed", error: res.error }); return; }
      return; // the poll loop reports when they accept
    }
    // offline: no server to relay through, so ready up as soon as you like
    setTimeout(() => this.emit({ type: "challenge-accepted", code }), 400);
  },
  async cancelChallenge() {
    if (serverUp) { try { await net.cancel(null); } catch { /* already gone */ } }
    this.emit({ type: "challenge-cancelled" });
  },
  confirmReady(code) { this.emit({ type: "match-launch", code }); },
};

let myQueueState = "out";
let challenge = null;
let lastOpponent = null;   // who we just played, recorded when Melee closes

function render() {
  $("myCode").value = backend.me.code;
  renderPeople($("friendsList"), backend.friends, (f) => btn("PLAY", () => startChallenge(f.code)));
  renderPeople($("recentList"), backend.recent, (r) => btn("ADD FRIEND", () => addFriend(r)));

  const inLists = myQueueState !== "out";
  $("queueLists").classList.toggle("hidden", !inLists);
  const watchAction = (p) =>
    p.state === "playing" && p.id && p.code !== backend.me.code
      ? btn(watchingId === p.id ? "STOP" : "WATCH", () => toggleWatch(p))
      : null;
  renderPeople($("queueList"), backend.queue, watchAction);
  renderPeople($("spectateList"), backend.spectators, () => null);
  $("queueLists").classList.toggle("hidden", !inLists && !backend.queue.length);
  $("joinQueueBtn").textContent = myQueueState === "out" ? "JOIN QUEUE" : "LEAVE QUEUE";
  $("joinQueueBtn").classList.toggle("leave", myQueueState !== "out");
  $("spectateBtn").classList.toggle("hidden", myQueueState === "out");
  $("spectateBtn").textContent = myQueueState === "spectating" ? "JOIN POOL" : "GO SPECTATE";
  const playing = backend.queue.filter((p) => p.state === "playing").length;
  $("queueStatus").textContent =
    myQueueState === "out"
      ? (backend.queue.length
          ? `${backend.queue.length} in the queue${playing ? ", a match is on" : ""}.`
          : "Nobody is waiting right now.")
      : myQueueState === "spectating"
        ? "You're spectating. Jump back in the pool whenever."
        : backend.queue.length > 2
          ? "You're in the queue. Peppy pairs you up and blinks when you're on."
          : "You're in the queue. Peppy blinks when a challenger shows up.";
}

function renderPeople(ul, items, actionFor) {
  ul.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "nobody yet";
    ul.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const isMe = item.code === backend.me.code;
    if (isMe) li.classList.add("me");
    const who = document.createElement("div");
    who.className = "who";
    const dot = document.createElement("span");
    dot.className = "dot" + (item.online || isMe ? " on" : "");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name || item.code.split("#")[0];
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = item.code;
    who.append(dot, name, code);
    if (item.isKing) {
      const crown = document.createElement("span");
      crown.className = "crown";
      crown.textContent = "♛";           // holds the setup
      crown.title = "winner - holding the setup";
      who.append(crown);
    }
    if (item.sweeps > 0) {
      const sw = document.createElement("span");
      sw.className = "sweeps";
      sw.textContent = `${item.sweeps} sweep${item.sweeps > 1 ? "s" : ""}`;
      sw.title = "times they beat everyone in the room";
      who.append(sw);
    }
    if (item.state === "playing") {
      li.classList.add("playing");
      const st = document.createElement("span");
      st.className = "state";
      st.textContent = "PLAYING";
      who.append(st);
    }
    li.append(who);
    if (isMe) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "YOU";
      li.append(badge);
    } else {
      const action = actionFor(item);
      if (action) li.append(action);
    }
    ul.appendChild(li);
  }
}

// "random" is passed through as-is; the server only stores a number, so a
// random choice is recorded as no preference.
function stageChoice() {
  const v = $("stageSel").value;
  return v === "random" ? "random" : Number(v);
}

function colorChoice() { return Number($("colorSel").value) || 0; }

// The costume list belongs to the character, so switching characters redraws it,
// and a colour the new character doesn't have falls back to their default.
function renderColors() {
  const list = window.costumesFor($("charSel").value);
  const field = $("colorSel");
  let picked = Number(field.value) || 0;
  if (picked >= list.length) picked = 0;
  field.value = String(picked);
  store.set("color", field.value);
  const row = $("colorRow");
  row.innerHTML = "";
  list.forEach(([name, hex], i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (i === picked ? " on" : "");
    b.title = name;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = hex;
    const label = document.createElement("span");
    label.className = "cname";
    label.textContent = name;
    b.append(chip, label);
    b.addEventListener("click", () => {
      field.value = String(i);
      renderColors();
    });
    row.appendChild(b);
  });
}

function btn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function addFriend(person) {
  if (serverUp) {
    const res = await net.friendAdd(person.code);
    if (!res.ok) { alert("Couldn't add that friend:\n\n" + res.error); return; }
    await refreshFromServer();
    return;
  }
  if (!backend.friends.some((f) => f.code === person.code)) {
    backend.friends.push({ ...person });
    store.set("friends", backend.friends);
  }
  render();
}

async function rememberOpponent(code) {
  if (serverUp) {
    await net.recordPlayed(code);   // records it for BOTH players
    await refreshFromServer();
    return;
  }
  if (!backend.recent.some((r) => r.code === code)) {
    backend.recent.unshift({ code });
    backend.recent = backend.recent.slice(0, 8);
    store.set("recent", backend.recent);
  }
  render();
}

// ---- challenge -> ready -> launch ----
function startChallenge(code) {
  code = (code || "").toUpperCase().trim();
  if (!/^[A-Z]{1,7}#\d{1,3}$/.test(code)) {
    alert("That doesn't look like a connect code (like ABCD#123).");
    return;
  }
  challenge = { code, phase: "sent" };
  showOverlay({ text: `Challenging ${code}…`, spinner: true, ready: false });
  backend.sendChallenge(code);
}

backend.on(async (event) => {
  switch (event.type) {
    case "queue-updated":
      render();
      break;
    case "challenge-accepted":
      if (challenge?.phase === "sent") {
        challenge.phase = "accepted";
        showOverlay({
          text: `Ready to play ${event.code}?\nHit ready once they've challenged you back.`,
          spinner: false, ready: true,
        });
        bridge?.notifyBlink();
      }
      break;
    case "challenge-failed":
      closeOverlay();
      alert("Couldn't send that challenge:\n\n" + event.error);
      break;
    case "match-launch":
      if (!challenge) break;
      challenge.phase = "launching";
      showOverlay({ text: `Setting up your match…\nPeppy is picking ${$("charSel").value}.`, spinner: true, ready: false });
      lastOpponent = event.code;   // recorded once the match actually ends
      if (!bridge) { setTimeout(closeOverlay, 2000); break; }
      {
        const res = await bridge.launchMatch({
          opponentCode: event.code,
          stageId: stageChoice(),
          character: $("charSel").value,
          color: colorChoice(),
        });
        if (!res.ok) {
          closeOverlay();
          alert("Couldn't start the game:\n\n" + res.error);
        }
      }
      break;
  }
});

bridge?.onMatchState(async (state) => {
  if (state === "gone" && lastOpponent) {
    // Melee closed: now it counts as played, and both of us go back to
    // waiting in the queue.
    await rememberOpponent(lastOpponent);
    lastOpponent = null;
  }
  if (state === "hidden") {
    showOverlay({ text: "Connecting to your opponent…\nThe game will appear when you're in.",
      spinner: true, ready: false, showGame: true });
  } else if (state === "connected") {
    showOverlay({ text: "Connected — have fun!", spinner: false, ready: false });
    setTimeout(closeOverlay, 1500);
  } else if (state === "timeout") {
    showOverlay({ text: "Couldn't find them.\nThe game is on screen — check they challenged you back.", spinner: false, ready: false });
    setTimeout(closeOverlay, 4000);
  } else if (state === "gone") {
    closeOverlay();
  }
});

function showOverlay({ text, spinner, ready, accept = false, result = false, cancel = true,
                      showGame = false }) {
  $("overlayText").textContent = text;
  $("overlaySpinner").classList.toggle("hidden", !spinner);
  $("readyBtn").classList.toggle("hidden", !ready);
  $("acceptBtn").classList.toggle("hidden", !accept);
  $("declineBtn").classList.toggle("hidden", !accept);
  $("wonBtn").classList.toggle("hidden", !result);
  $("lostBtn").classList.toggle("hidden", !result);
  $("cancelBtn").classList.toggle("hidden", !cancel);
  $("showGameBtn").classList.toggle("hidden", !showGame);
  $("overlay").classList.remove("hidden");
}

function closeOverlay() {
  $("overlay").classList.add("hidden");
  challenge = null;
}

$("readyBtn").addEventListener("click", () => {
  if (challenge?.phase === "accepted") backend.confirmReady(challenge.code);
});

// If the game is running but its window never appeared, ask for it directly.
$("showGameBtn").addEventListener("click", async () => {
  const res = await bridge?.revealMatch();
  if (!res?.ok) {
    alert("Couldn't find the game window.\n\nIf you can hear the match it is running - try alt-tab.");
  }
});

$("cancelBtn").addEventListener("click", async () => {
  backend.cancelChallenge();
  closeOverlay();
  if (bridge) await bridge.killDolphin();
});

$("directBtn").addEventListener("click", () => startChallenge($("directCode").value));
$("directCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startChallenge($("directCode").value);
});
$("myCode").addEventListener("change", (e) => {
  backend.me.code = e.target.value.toUpperCase().trim();
  store.set("myCode", backend.me.code);
});

$("joinQueueBtn").addEventListener("click", () => {
  myQueueState = myQueueState === "out" ? "queued" : "out";
  myQueueState === "queued" ? backend.joinQueue() : backend.leaveQueue();
  render();
});

$("spectateBtn").addEventListener("click", () => {
  if (myQueueState === "queued") { myQueueState = "spectating"; backend.goSpectate(); }
  else if (myQueueState === "spectating") { myQueueState = "queued"; backend.rejoinPool(); }
  render();
});

// ---- shared server ----

async function refreshFromServer() {
  if (!serverUp) return;
  const [q, f, r] = await Promise.all([net.queueList(), net.friends(), net.recent()]);
  if (q.ok) {
    const rows = q.data ?? [];
    const asPerson = (row) => ({
      code: row.connect_code, name: row.display_name, online: row.online,
      sweeps: row.sweeps ?? 0, isKing: !!row.is_king, state: row.state,
      id: row.player_id,
    });
    backend.queue = rows.filter((x) => x.state !== "spectating").map(asPerson);
    backend.spectators = rows.filter((x) => x.state === "spectating").map(asPerson);
    const mine = rows.find((x) => x.connect_code === backend.me.code);
    myQueueState = !mine ? "out" : mine.state === "spectating" ? "spectating" : "queued";
  }
  if (f.ok) backend.friends = (f.data ?? []).map((x) => ({
    code: x.connect_code, name: x.display_name, online: x.online }));
  if (r.ok) backend.recent = (r.data ?? []).map((x) => ({
    code: x.connect_code, name: x.display_name }));
  render();
}

// Someone challenged us. Accepting counts as our ready, so the moment we
// accept we go straight into setting the match up.
let incomingId = null;
net?.onIncoming(async (c) => {
  if (challenge || incomingId === c.challenge_id) return;
  incomingId = c.challenge_id;
  const mins = Math.max(0, Math.round((new Date(c.expires_at) - Date.now()) / 60000));
  showOverlay({
    text: `${c.from_name} (${c.from_code}) wants to play!
Accept within ${mins} min.`,
    spinner: false, ready: false, accept: true,
  });
});

$("acceptBtn").addEventListener("click", async () => {
  if (!incomingId) return;      // a rotation pairing, handled by its own listener
  const res = await net.respond(incomingId, true);
  const code = $("overlayText").textContent.match(/\(([A-Z]+#\d+)\)/)?.[1];
  incomingId = null;
  if (!res.ok) { closeOverlay(); alert("Couldn't accept:\n\n" + res.error); return; }
  challenge = { code, phase: "accepted" };
  backend.confirmReady(code);          // accepting IS our ready
});

$("declineBtn").addEventListener("click", async () => {
  if (!incomingId) return;      // a rotation pairing, handled by its own listener
  await net.respond(incomingId, false);
  incomingId = null;
  closeOverlay();
});

// Our outgoing challenge was answered.
net?.onOutgoing((c) => {
  if (!challenge || challenge.phase !== "sent") return;
  if (c.state === "accepted") {
    challenge.phase = "accepted";
    showOverlay({ text: `${challenge.code} accepted!
Ready when you are.`,
      spinner: false, ready: true });
    bridge?.notifyBlink();
  } else {
    closeOverlay();
    alert(`${challenge.code} ${c.state} the challenge.`);
  }
});

// ---- spectating ----
// Watching someone opens Slippi's playback build following their live match a
// few seconds behind, rebuilt from the stream they broadcast.
let watchingId = null;

async function toggleWatch(person) {
  if (!bridge) return;
  if (watchingId === person.id) {
    await bridge.net.spectateStop();
    watchingId = null;
    render();
    return;
  }
  watchingId = person.id;
  render();
  const res = await bridge.net.spectateStart(person.id, person.name);
  if (!res.ok) {
    watchingId = null;
    render();
    alert("Couldn't start watching:\n\n" + res.error);
  }
}

bridge?.net?.onSpectateState((s) => {
  if (s.state === "connecting") {
    $("queueHint").textContent = `Connecting to ${s.name}'s match…`;
  } else if (s.state === "watching") {
    $("queueHint").textContent = `Watching ${s.name} - the playback window is live.`;
  } else if (s.state === "error") {
    $("queueHint").textContent = "Couldn't watch: " + s.error;
    watchingId = null;
    render();
  } else {
    $("queueHint").textContent = "Stopped watching.";
  }
});

// ---- the rotation ----
// Peppy proposes a match; accepting is also your ready, so once both sides
// accept the game launches itself.
let pairing = null;

net?.onPairing((p) => {
  bridge?.log("pairing proposed vs", p.other_code, "state", p.state);
  if (challenge || pairing?.pairing_id === p.pairing_id) return;
  pairing = p;
  const mins = Math.max(0, Math.round((new Date(p.expires_at) - Date.now()) / 60000));
  const crown = p.other_sweeps ? `  (${p.other_sweeps} sweep${p.other_sweeps > 1 ? "s" : ""})` : "";
  showOverlay({
    text: `You're up against ${p.other_name}${crown}
(${p.other_code})

Accept within ${mins} min.`,
    spinner: false, ready: false, accept: true, cancel: false,
  });
  bridge?.notifyBlink();
});

let launchedPairing = null;    // never launch the same pairing twice

net?.onPairingReady(async (p) => {
  if (launchedPairing === p.pairing_id) {
    bridge?.log("already launched pairing", p.pairing_id, "- ignoring");
    return;
  }
  launchedPairing = p.pairing_id;
  bridge?.log("pairing READY vs", p.other_code, "- launching");
  if (!pairing || pairing.pairing_id !== p.pairing_id) pairing = p;
  showOverlay({
    text: `Both ready - setting up your match with ${p.other_name}…`,
    spinner: true, ready: false, cancel: true,
  });
  lastOpponent = p.other_code;
  pairing = null;
  if (!bridge) return;
  const res = await bridge.launchMatch({
    opponentCode: p.other_code,
    stageId: stageChoice(),
    character: $("charSel").value,
    color: colorChoice(),
  });
  if (!res.ok) { closeOverlay(); alert("Couldn't start the game:\n\n" + res.error); }
});

// Peppy read the result out of the replay.
net?.onMatchResult((r) => {
  const line = r.iWon ? "You won!" : "Good game.";
  const swept = r.swept ? `

SWEEP! You beat everyone here (${r.sweeps} total).
Back of the line - someone else takes the setup.` : "";
  showOverlay({ text: line + swept, spinner: false, ready: false, cancel: false });
  setTimeout(closeOverlay, r.swept ? 5000 : 2000);
  refreshFromServer();
});

// The replay could not be read - ask rather than guess.
let askingAbout = null;
net?.onAskResult((r) => {
  askingAbout = r.opponentCode;
  showOverlay({
    text: `Who won against ${r.opponentCode}?
(Peppy couldn't read the replay)`,
    spinner: false, ready: false, result: true, cancel: false,
  });
});

const answerResult = async (iWon) => {
  if (!askingAbout) return closeOverlay();
  const res = await net.reportResult(askingAbout, iWon, null);
  askingAbout = null;
  closeOverlay();
  if (res?.ok && res.data?.[0]?.swept) {
    showOverlay({ text: `SWEEP! You beat everyone here.
Back of the line.`, spinner: false, cancel: false });
    setTimeout(closeOverlay, 4000);
  }
  refreshFromServer();
};
$("wonBtn").addEventListener("click", () => answerResult(true));
$("lostBtn").addEventListener("click", () => answerResult(false));

$("acceptBtn").addEventListener("click", async () => {
  if (pairing) {
    const id = pairing.pairing_id;
    showOverlay({ text: "Waiting for them to accept…", spinner: true, cancel: false });
    const res = await net.pairingRespond(id, true);
    if (!res.ok) { closeOverlay(); pairing = null; alert(res.error); }
    return;   // onPairingReady launches once both sides are in
  }
  // otherwise this is a direct challenge (handled below)
});

$("declineBtn").addEventListener("click", async () => {
  if (pairing) {
    await net.pairingRespond(pairing.pairing_id, false);
    pairing = null;
    closeOverlay();
    refreshFromServer();
  }
});

// ---- boot ----
window.addEventListener("error", (e) => {
  bridge?.log("UI ERROR:", e.message, "at", e.filename + ":" + e.lineno);
  $("statusbar").textContent = "app error: " + e.message;
  $("statusbar").classList.add("bad");
});
window.addEventListener("unhandledrejection", (e) => {
  bridge?.log("UI PROMISE REJECTION:", e.reason?.message ?? e.reason);
});

(async () => {
 try {
  const fallback = ["FOX", "FALCO", "MARTH", "SHEIK", "JIGGLYPUFF", "PEACH", "CPTFALCON"];
  let chars = fallback, status = "browser preview - mock mode", detected = null;
  if (bridge) {
    const info = await bridge.slippiInfo();
    chars = info.characters?.length ? info.characters : fallback;
    status = info.ok ? "ready - Slippi and Melee found" : "SETUP NEEDED: " + info.error;
    $("statusbar").classList.toggle("bad", !info.ok);
    // Your identity comes from this PC's Slippi login, so the same code works
    // on every machine you play on and nobody has to type anything.
    detected = info.identity ?? null;
    if (detected) {
      backend.me.code = detected.connectCode;
      backend.me.name = detected.displayName;
      store.set("myCode", detected.connectCode);
      $("myCode").value = detected.connectCode;
      $("myCode").title = "from your Slippi login on this PC";
      $("myCode").readOnly = true;
    }
  }
  const sel = $("charSel");
  sel.innerHTML = "";
  for (const c of chars) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c.charAt(0) + c.slice(1).toLowerCase();
    sel.appendChild(o);
  }
  sel.value = store.get("character", "FOX");
  sel.addEventListener("change", () => {
    store.set("character", sel.value);
    renderColors();
    if (serverUp) net.heartbeat(sel.value, stageChoice() === "random" ? null : stageChoice());
  });
  $("stageSel").value = store.get("stage", "31");
  $("colorSel").value = store.get("color", "0");
  renderColors();
  $("stageSel").addEventListener("change", () => {
    store.set("stage", $("stageSel").value);
    if (serverUp) net.heartbeat(sel.value, stageChoice() === "random" ? null : stageChoice());
  });
  $("statusbar").textContent = status;
  render();

  // ---- connect to the shared server (optional) ----
  if (!net) { bridge?.log("no net bridge"); return; }
  bridge?.log("connecting to server...");
  const conn = await net.connect();
  bridge?.log("connect result:", JSON.stringify(conn));
  serverUp = !!conn.ok;
  if (!serverUp) {
    $("queueHint").textContent = "Can't reach the Peppy server - direct challenges still work.";
    $("statusbar").textContent = status + " | server offline";
    return;
  }
  // Claim our connect code so other people can find us.
  const claim = async (code) => {
    bridge?.log("claiming", code);
    if (!/^[A-Z]{1,7}#\d{1,3}$/.test(code)) { bridge?.log("code failed the format check:", code); return false; }
    const res = await net.claim(code, detected?.displayName || code.split("#")[0]);
    bridge?.log("claim result:", JSON.stringify(res).slice(0, 200));
    if (!res.ok) {
      $("queueHint").textContent = res.error;
      return false;
    }
    backend.me.code = code;
    $("queueHint").textContent = "Connected to the Fort Wayne queue.";
    await refreshFromServer();
    return true;
  };
  if (backend.me.code) {
    const okClaim = await claim(backend.me.code);
    if (okClaim && detected) {
      $("queueHint").textContent = `Signed in as ${detected.displayName} (${detected.connectCode}) from Slippi.`;
    }
  } else {
    $("queueHint").textContent = "Log in to Slippi (or type your code above) to join the queue.";
  }

  $("myCode").addEventListener("change", async (e) => {
    await claim(e.target.value.toUpperCase().trim());
  });

  $("statusbar").textContent = status + " | connected to the Fort Wayne server";
  setInterval(refreshFromServer, 5000);
 } catch (err) {
   bridge?.log("BOOT FAILED:", err?.message ?? err);
   $("statusbar").textContent = "startup failed: " + (err?.message ?? err);
   $("statusbar").classList.add("bad");
 }
})();
