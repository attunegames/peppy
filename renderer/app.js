// PEPPY renderer.
//   - inside Electron (window.peppy present): real launches
//   - plain browser: mock mode for UI work
//
// `backend` is the seam where the shared server drops in later. Today it is a
// local simulation for the queue/friends, while PLAY SOMEONE is fully real.

const bridge = window.peppy ?? null;
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("peppy." + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem("peppy." + k, JSON.stringify(v)); },
};

const backend = {
  me: { name: "You", code: store.get("myCode", "") },
  friends: store.get("friends", []),
  recent: store.get("recent", []),
  queue: [],
  spectators: [],
  listeners: new Set(),
  emit(e) { for (const fn of this.listeners) fn(e); },
  on(fn) { this.listeners.add(fn); },

  joinQueue() { this.queue.push(this.me); this.emit({ type: "queue-updated" }); },
  leaveQueue() {
    this.queue = this.queue.filter((p) => p.code !== this.me.code);
    this.spectators = this.spectators.filter((p) => p.code !== this.me.code);
    this.emit({ type: "queue-updated" });
  },
  goSpectate() {
    this.queue = this.queue.filter((p) => p.code !== this.me.code);
    this.spectators.push(this.me);
    this.emit({ type: "queue-updated" });
  },
  rejoinPool() {
    this.spectators = this.spectators.filter((p) => p.code !== this.me.code);
    this.queue.push(this.me);
    this.emit({ type: "queue-updated" });
  },

  // No server yet: a challenge is "ready as soon as you are". Once the shared
  // backend exists, accepting on the other side fires challenge-accepted and
  // that acceptance counts as their ready (decided 2026-08-05).
  sendChallenge(code) {
    this.emit({ type: "challenge-sent", code });
    setTimeout(() => this.emit({ type: "challenge-accepted", code }), 400);
  },
  cancelChallenge() { this.emit({ type: "challenge-cancelled" }); },
  confirmReady(code) { this.emit({ type: "match-launch", code }); },
};

let myQueueState = "out";
let challenge = null;

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

function addFriend(person) {
  if (!backend.friends.some((f) => f.code === person.code)) {
    backend.friends.push({ ...person });
    store.set("friends", backend.friends);
  }
  render();
}

function rememberOpponent(code) {
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
    case "match-launch":
      if (!challenge) break;
      challenge.phase = "launching";
      showOverlay({ text: `Setting up your match…\nPeppy is picking ${$("charSel").value}.`, spinner: true, ready: false });
      rememberOpponent(event.code);
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

bridge?.onMatchState((state) => {
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

function showOverlay({ text, spinner, ready }) {
  $("overlayText").textContent = text;
  $("overlaySpinner").classList.toggle("hidden", !spinner);
  $("readyBtn").classList.toggle("hidden", !ready);
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
  sel.addEventListener("change", () => store.set("character", sel.value));
  $("stageSel").value = store.get("stage", "31");
  $("stageSel").addEventListener("change", () => store.set("stage", $("stageSel").value));
  $("statusbar").textContent = status;
  render();
})();
