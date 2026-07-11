// SKY COMMAND — render + live-state layer.
//
// Boot order:
//   1. try state.json  (plaintext — local dev only)
//   2. try state.enc   (AES-256-GCM blob published by
//      ~/.claude/bin/sky_command_publish.py) → passphrase unlock screen
// Re-polls every 5 minutes and re-renders when generatedAt changes.

let S = null;
let chatWired = false;

const POLL_MS = 5 * 60 * 1000;
const KEY_CACHE = "skycmd_key_v1";

const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── crypto ──────────────────────────────────────────────
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, saltB64, iterations) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations },
    base, 256);
  return bits;
}

async function decryptState(blob, keyBits) {
  const key = await crypto.subtle.importKey(
    "raw", keyBits, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── state loading ───────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function loadState({ interactive }) {
  try {
    return await fetchJSON("state.json"); // local dev
  } catch { /* fall through to encrypted */ }

  const blob = await fetchJSON("state.enc");

  const cached = localStorage.getItem(KEY_CACHE);
  if (cached) {
    try {
      return await decryptState(blob, b64d(cached).buffer);
    } catch {
      localStorage.removeItem(KEY_CACHE); // key rotated or corrupt
    }
  }
  if (!interactive) throw new Error("locked");
  return await unlockFlow(blob);
}

function unlockFlow(blob) {
  const overlay = el("lock");
  overlay.classList.add("show");
  el("lock-input").focus();
  return new Promise((resolve) => {
    el("lock-form").onsubmit = async (e) => {
      e.preventDefault();
      const pass = el("lock-input").value.trim();
      if (!pass) return;
      el("lock-status").textContent = "DERIVING KEY…";
      try {
        const bits = await deriveKey(pass, blob.salt, blob.iter);
        const state = await decryptState(blob, bits);
        localStorage.setItem(KEY_CACHE,
          btoa(String.fromCharCode(...new Uint8Array(bits))));
        overlay.classList.remove("show");
        resolve(state);
      } catch {
        el("lock-status").textContent = "ACCESS DENIED";
        el("lock-box").classList.remove("shake");
        void el("lock-box").offsetWidth;
        el("lock-box").classList.add("shake");
        el("lock-input").value = "";
        el("lock-input").focus();
      }
    };
  });
}

// ── header ──────────────────────────────────────────────
function renderHeader() {
  const gen = new Date(S.generatedAt);
  el("hdr-date").textContent = gen.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  }) + " · " + S.user.location;
  el("hdr-wx").textContent = S.user.weather || "";
  syncChip();
}

function syncChip() {
  if (!S) return;
  const mins = Math.max(0, Math.round((Date.now() - new Date(S.generatedAt)) / 60000));
  const ago = mins < 1 ? "just now"
    : mins < 60 ? mins + "m ago"
    : Math.round(mins / 60) + "h ago";
  el("sync-text").textContent = "SYNCED " + ago.toUpperCase();
  el("sync-dot").className = "dot " + (mins < 90 ? "ok" : "gold");
}

// ── horizon (goal layer) ────────────────────────────────
function renderHorizon() {
  const h = S.goals.horizon;
  el("hz-label").textContent = h.label;
  el("hz-caption").innerHTML = h.caption;

  const track = el("hz-track");
  track.innerHTML =
    `<div class="fill" id="hz-fill"></div>
     <div class="you" id="hz-you"></div>
     <div class="youlab" id="hz-youlab"></div>` +
    h.milestones.map((n) => `
      <div class="node${n.passed ? " passed" : ""}" style="left:${n.pos}%"></div>
      <div class="nlab" style="left:${n.pos}%"><strong>${esc(n.label)}</strong>${esc(n.sub)}</div>
    `).join("");

  el("hz-youlab").innerHTML =
    `you're here · <span class="v">${esc(h.currentLabel)}</span>`;
  requestAnimationFrame(() =>
    setTimeout(() => {
      el("hz-fill").style.width = h.currentPct + "%";
      el("hz-you").style.left = h.currentPct + "%";
      el("hz-youlab").style.left = h.currentPct + "%";
    }, 150));
}

// ── primary agents ──────────────────────────────────────
function renderInbox() {
  const a = S.inboxManager;
  const pct = Math.min(100, Math.round((a.batch.processed / a.batch.target) * 100));
  el("card-inbox").innerHTML = `
    <div class="chead">
      <div class="ic" style="background:var(--tealsoft)">📥</div>
      <span class="ctitle">${esc(a.name)}</span>
      <span class="cstatus"><span class="dot ok"></span>ACTIVE</span>
    </div>
    <div class="stat3">
      <div class="s"><div class="v">${a.last24h.scanned}</div><div class="k">scanned</div></div>
      <div class="s"><div class="v" style="color:var(--teal)">${a.last24h.drafts}</div><div class="k">drafts</div></div>
      <div class="s"><div class="v" style="color:${a.last24h.urgent ? "var(--coral)" : "var(--ink3)"}">${a.last24h.urgent}</div><div class="k">urgent</div></div>
    </div>
    <div class="smallnote">${esc(a.summary)} <span style="color:var(--ink3)">· ${esc(a.lastRun)}</span></div>
    <div class="drafts">
      ${a.recentDrafts.map((d) => `
        <div class="drow"><span class="c">${esc(d.client)}</span><span class="n">${esc(d.note)}</span></div>
      `).join("")}
    </div>
    <div class="batch">
      <div class="lbl"><span>${esc(a.batch.label)}</span><b>${a.batch.processed.toLocaleString()} · ${pct}%</b></div>
      <div class="bar"><div class="f" data-w="${pct}%"></div></div>
      <div class="lbl" style="margin-top:5px"><span>${esc(a.batch.phase)}</span></div>
    </div>`;
}

function renderBriefing() {
  const b = S.briefing;
  el("card-briefing").innerHTML = `
    <div class="chead">
      <div class="ic" style="background:var(--goldsoft)">📊</div>
      <span class="ctitle">${esc(b.name)}</span>
      <span class="cstatus"><span class="dot ok"></span>SENT ${esc(b.sentAt.toUpperCase())}</span>
    </div>
    <div class="quote">“${esc(b.quote)}”</div>
    <div class="hl">
      ${b.highlights.map((h) => {
        const color = h.tone === "gold" ? "var(--gold)"
          : h.tone === "attention" ? "var(--coral)"
          : "var(--ink)";
        return `
        <div class="h"><span class="k">${esc(h.k)}</span>
        <span class="v" style="color:${color}">${esc(h.v)}</span></div>`;
      }).join("")}
    </div>
    <div class="feeds">
      ${b.feeds.map((f) => `
        <span class="feed ${f.fresh ? "live" : "stale"}"><span class="fd"></span>${esc(f.name)}${f.fresh ? "" : " · stale"}</span>
      `).join("")}
    </div>`;
}

// ── right column ────────────────────────────────────────
function renderFocus() {
  el("focus-list").innerHTML = S.goals.focus
    .map((f) => `<li class="${f.tone}">${esc(f.text)}</li>`)
    .join("");
}

function renderGates() {
  el("gates").innerHTML = S.goals.gates.map((g) => {
    const near = g.state === "near";
    return `
      <div class="gate ${near ? "near" : ""}">
        <div class="glock ${near ? "near" : ""}">${near ? "🔓" : "🔒"}</div>
        <div style="flex:1;min-width:0">
          <div class="gname">${esc(g.name)}</div>
          <div class="gcond">${esc(g.cond)}</div>
          ${near ? `<div class="gmini"><div style="width:${g.pct}%"></div></div>` : ""}
        </div>
        <span class="gpill ${near ? "near" : ""}">${near ? g.pct + "% there" : "Locked"}</span>
      </div>`;
  }).join("");
}

function renderConnections() {
  el("connections").innerHTML = S.connections.map((c) => `
    <div class="flow ${c.state === "warn" ? "warn" : ""}">
      <div class="nodebox">
        <span class="dot ${c.state === "warn" ? "gold" : "ok"}"></span>
        <div style="min-width:0">
          <div class="nm">${esc(c.name)}</div>
          <div class="nt">${esc(c.note)}</div>
        </div>
      </div>
      <div class="flowline"></div>
      <div class="hub">◈</div>
    </div>`).join("");
}

// ── bottom band ─────────────────────────────────────────
function renderCheckin() {
  const c = S.checkin;
  el("card-checkin").innerHTML = `
    <div class="scan"></div>
    <div class="chead">
      <div class="ic" style="background:var(--goldsoft)">🌅</div>
      <span class="ctitle">${esc(c.name)}</span>
      <span class="cstatus building"><span class="dot gold"></span>COMING ONLINE</span>
    </div>
    <div class="smallnote">${esc(c.note)}</div>
    <div class="ghostcats">
      ${c.categories.map((n) => `
        <div class="gc">${esc(n)}<div class="gbar"><div></div></div></div>
      `).join("")}
    </div>
    <div class="bootline">initializing weekly ritual … ${c.progressPct}% built<span class="cursor">▊</span></div>`;
}

function renderPulse() {
  const dot = { ok: "ok", stale: "stale", alert: "warn", idle: "idle" };
  el("pulsegrid").innerHTML = S.pulseAgents.map((p) => `
    <div class="pa ${p.state === "alert" ? "alert" : ""}">
      <span class="dot ${dot[p.state]}"></span>
      <div><div class="nm">${esc(p.name)}</div><div class="st">${esc(p.note)}</div></div>
    </div>`).join("");
}

// ── chat console ────────────────────────────────────────
const thread = () => el("thread");

function addMsg(who, text) {
  const div = document.createElement("div");
  div.className = "msg " + who;
  div.innerHTML =
    `<div class="who">${who === "chloe" ? "Chloe" : "Sky"}</div>${esc(text)}`;
  thread().appendChild(div);
  thread().scrollTop = thread().scrollHeight;
  return div;
}

function chloeReply(userText) {
  const t = userText.toLowerCase();
  const hit = S.chat.responses.find((r) => r.match.some((m) => t.includes(m)));
  const reply = hit ? hit.reply : S.chat.fallback;

  const typing = document.createElement("div");
  typing.className = "msg chloe";
  typing.innerHTML =
    `<div class="who">Chloe</div><span class="typing"><i></i><i></i><i></i></span>`;
  thread().appendChild(typing);
  thread().scrollTop = thread().scrollHeight;

  setTimeout(() => {
    typing.remove();
    addMsg("chloe", reply);
  }, 700 + Math.random() * 600);
}

function initChat() {
  if (thread().children.length === 0) {
    S.chat.seed.forEach((m) => addMsg(m.who, m.text));
  }
  if (chatWired) return;
  chatWired = true;

  const quick = ["Inbox status", "Where's my briefing?", "Pipeline", "How am I tracking on goals?"];
  el("quick").innerHTML = quick
    .map((q) => `<button type="button" class="qc">${esc(q)}</button>`)
    .join("");
  el("quick").addEventListener("click", (e) => {
    const btn = e.target.closest(".qc");
    if (!btn) return;
    addMsg("you", btn.textContent);
    chloeReply(btn.textContent);
  });

  el("chatform").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el("chatinput");
    const v = input.value.trim();
    if (!v) return;
    input.value = "";
    addMsg("you", v);
    chloeReply(v);
  });
}

// ── ambient system line ─────────────────────────────────
function sysLines() {
  const lines = ["ALL SYSTEMS NOMINAL"];
  if (S) {
    const fresh = S.briefing.feeds.filter((f) => f.fresh).length;
    lines.push(`FEEDS · ${fresh}/${S.briefing.feeds.length} LIVE`);
    if (S.goals.focus[0]) {
      lines.push("FOCUS · " + S.goals.focus[0].text.slice(0, 40).toUpperCase());
    }
    lines.push("NEXT GATE · DEBT-FREE");
  }
  return lines;
}

let sysIdx = 0;
function initSysline() {
  setInterval(() => {
    const lines = sysLines();
    sysIdx = (sysIdx + 1) % lines.length;
    el("sysline-text").textContent = lines[sysIdx];
  }, 5000);
  setInterval(syncChip, 30000);
}

// ── boot ────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderHorizon();
  renderInbox();
  renderBriefing();
  renderFocus();
  renderGates();
  renderConnections();
  renderCheckin();
  renderPulse();
  initChat();

  requestAnimationFrame(() =>
    setTimeout(() => {
      document.querySelectorAll(".bar .f[data-w]").forEach((b) => {
        b.style.width = b.dataset.w;
      });
      document.querySelectorAll(".ghostcats .gbar > div").forEach((b, i) => {
        b.style.transition = "width 1.4s ease " + i * 0.12 + "s";
        b.style.width = 30 + Math.random() * 45 + "%";
      });
    }, 250));
}

async function boot() {
  try {
    S = await loadState({ interactive: true });
  } catch (e) {
    el("sysline-text").textContent = "STATE UNAVAILABLE — CHECK PUBLISHER";
    return;
  }
  renderAll();
  initSysline();

  setInterval(async () => {
    try {
      const next = await loadState({ interactive: false });
      if (next.generatedAt !== S.generatedAt) {
        S = next;
        renderAll();
      } else {
        syncChip();
      }
    } catch { /* offline or locked — keep showing last state */ }
  }, POLL_MS);
}

boot();
