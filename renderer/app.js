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
      const res = await net.challenge(code, Number($("stageSel").value));
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
  if (inLists) {
    renderPeople($("queueList"), backend.queue, () => null);
    renderPeople($("spectateList"), backend.spectators, () => null);
  }
  $("joinQueueBtn").textContent = myQueueState === "out" ? "JOIN QUEUE" : "LEAVE QUEUE";
  $("joinQueueBtn").classList.toggle("leave", myQueueState !== "out");
  $("spectateBtn").classList.toggle("hidden", myQueueState === "out");
  $("spectateBtn").textContent = myQueueState === "spectating" ? "JOIN POOL" : "GO SPECTATE";
  $("queueStatus").textContent =
    myQueueState === "out" ? "Nobody is waiting right now."
      : myQueueState === "spectating" ? "You're spectating. Jump back in the pool whenever."
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
          stageId: Number($("stageSel").value),
          character: $("charSel").value,
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
    showOverlay({ text: "Connecting to your opponent…\nThe game will appear when you're in.", spinner: true, ready: false });
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

function showOverlay({ text, spinner, ready, accept = false }) {
  $("overlayText").textContent = text;
  $("overlaySpinner").classList.toggle("hidden", !spinner);
  $("readyBtn").classList.toggle("hidden", !ready);
  $("acceptBtn").classList.toggle("hidden", !accept);
  $("declineBtn").classList.toggle("hidden", !accept);
  $("overlay").classList.remove("hidden");
}

function closeOverlay() {
  $("overlay").classList.add("hidden");
  challenge = null;
}

$("readyBtn").addEventListener("click", () => {
  if (challenge?.phase === "accepted") backend.confirmReady(challenge.code);
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
  const res = await net.respond(incomingId, true);
  const code = $("overlayText").textContent.match(/\(([A-Z]+#\d+)\)/)?.[1];
  incomingId = null;
  if (!res.ok) { closeOverlay(); alert("Couldn't accept:\n\n" + res.error); return; }
  challenge = { code, phase: "accepted" };
  backend.confirmReady(code);          // accepting IS our ready
});

$("declineBtn").addEventListener("click", async () => {
  if (incomingId) await net.respond(incomingId, false);
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

// ---- boot ----
(async () => {
  const fallback = ["FOX", "FALCO", "MARTH", "SHEIK", "JIGGLYPUFF", "PEACH", "CPTFALCON"];
  let chars = fallback, status = "browser preview - mock mode";
  if (bridge) {
    const info = await bridge.slippiInfo();
    chars = info.characters?.length ? info.characters : fallback;
    status = info.ok ? "ready - Slippi and Melee found" : "SETUP NEEDED: " + info.error;
    $("statusbar").classList.toggle("bad", !info.ok);
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
    if (serverUp) net.heartbeat(sel.value, Number($("stageSel").value));
  });
  $("stageSel").value = store.get("stage", "31");
  $("stageSel").addEventListener("change", () => {
    store.set("stage", $("stageSel").value);
    if (serverUp) net.heartbeat(sel.value, Number($("stageSel").value));
  });
  $("statusbar").textContent = status;
  render();

  // ---- connect to the shared server (optional) ----
  if (!net) return;
  const conn = await net.connect();
  serverUp = !!conn.ok;
  if (!serverUp) {
    $("queueHint").textContent = "Can't reach the Peppy server - direct challenges still work.";
    $("statusbar").textContent = status + " | server offline";
    return;
  }
  // Claim our connect code so other people can find us.
  const claim = async (code) => {
    if (!/^[A-Z]{1,7}#\d{1,3}$/.test(code)) return false;
    const res = await net.claim(code, code.split("#")[0]);
    if (!res.ok) {
      $("queueHint").textContent = res.error;
      return false;
    }
    backend.me.code = code;
    $("queueHint").textContent = "Connected to the Fort Wayne queue.";
    await refreshFromServer();
    return true;
  };
  if (backend.me.code) await claim(backend.me.code);
  else $("queueHint").textContent = "Enter your connect code above to join the queue.";

  $("myCode").addEventListener("change", async (e) => {
    await claim(e.target.value.toUpperCase().trim());
  });

  $("statusbar").textContent = status + " | connected to the Fort Wayne server";
  setInterval(refreshFromServer, 5000);
})();
