// SKY COMMAND — render + live-state + live-chat layer.
//
// Boot: state.json (dev) → state.enc (AES-256-GCM, passphrase unlock).
// Chat mode  → OpenAI chat completions with Chloe's live-state system prompt.
// Build mode → model writes a Codex task brief → user confirms → brief is
//              encrypted with the session key and committed to the GitHub
//              repo (briefs/pending/) → Mac publisher ingests → hourly
//              in-app task moves it into CodeX/framework/queue/incoming.
// Re-polls state every 5 minutes.

let S = null;
let chatWired = false;
let mode = "chat";               // "chat" | "build"
let history = [];                 // chat-mode conversation history
let sessionKeyBits = null;        // raw AES key after unlock (for briefs)
let devMode = false;              // plaintext state.json — key is a placeholder
let pendingBrief = null;

const POLL_MS = 5 * 60 * 1000;
const KEY_CACHE = "skycmd_key_v1";

const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── crypto ──────────────────────────────────────────────
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function deriveKey(passphrase, saltB64, iterations) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations },
    base, 256);
}

async function decryptState(blob, keyBits) {
  const key = await crypto.subtle.importKey("raw", keyBits, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function encryptForRepo(obj) {
  const key = await crypto.subtle.importKey("raw", sessionKeyBits, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iv: b64e(iv), ct: b64e(ct) });
}

// ── state loading ───────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function loadState({ interactive }) {
  try {
    const dev = await fetchJSON("state.json");
    sessionKeyBits = sessionKeyBits || new ArrayBuffer(32); // dev mode placeholder
    devMode = true;
    return dev;
  } catch { /* encrypted path */ }

  const blob = await fetchJSON("state.enc");
  const cached = localStorage.getItem(KEY_CACHE);
  if (cached) {
    try {
      const bits = b64d(cached).buffer;
      const st = await decryptState(blob, bits);
      sessionKeyBits = bits;
      return st;
    } catch {
      localStorage.removeItem(KEY_CACHE);
    }
  }
  if (!interactive) throw new Error("locked");
  return unlockFlow(blob);
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
        sessionKeyBits = bits;
        localStorage.setItem(KEY_CACHE, b64e(bits));
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

// ── Chloe neural core: plexus sphere ────────────────────
// Wireframe particle sphere (canvas 2D, no libs). Always rotating with
// per-node wobble + neuron-style pulses along mesh edges. Tilts toward the
// pointer, bursts on tap, and accelerates while Chloe is processing
// (window.__orbBusy > 0). Honors prefers-reduced-motion with a static frame.
window.__orbBusy = 0;

class PlexusOrb {
  constructor(canvas, { nodes = 200, k = 3 } = {}) {
    this.cv = canvas;
    this.cx = canvas.getContext("2d");
    this.N = nodes;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // fibonacci sphere
    this.pts = [];
    const GA = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < this.N; i++) {
      const y = 1 - (i / (this.N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = GA * i;
      this.pts.push({
        x: Math.cos(th) * r, y, z: Math.sin(th) * r,
        phase: Math.random() * Math.PI * 2,
        violet: Math.random() < 0.16,
        flare: 0,
      });
    }
    // static mesh: k nearest neighbors per node
    this.edges = [];
    const seen = new Set();
    for (let i = 0; i < this.N; i++) {
      const d = [];
      for (let j = 0; j < this.N; j++) {
        if (i === j) continue;
        const p = this.pts[i], q = this.pts[j];
        d.push([((p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2), j]);
      }
      d.sort((a, b) => a[0] - b[0]);
      for (let n = 0; n < k; n++) {
        const j = d[n][1];
        const key = i < j ? i + "-" + j : j + "-" + i;
        if (!seen.has(key)) { seen.add(key); this.edges.push([i, j]); }
      }
    }

    this.ry = Math.random() * 6; this.rx = 0.35;
    this.px = 0; this.py = 0;           // pointer tilt
    this.tpx = 0; this.tpy = 0;
    this.bounce = 0;
    this.nextPulse = 0;
    this.last = performance.now();

    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.tpx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      this.tpy = ((e.clientY - r.top) / r.height - 0.5) * 2;
    });
    canvas.addEventListener("pointerleave", () => { this.tpx = 0; this.tpy = 0; });
    canvas.addEventListener("pointerdown", (e) => this.burst(e));

    this.resize();
    if (this.reduced) { this.step(16); this.draw(); }
    else requestAnimationFrame((t) => this.loop(t));
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const s = this.cv.clientWidth || 120;
    this.size = s;
    this.cv.width = s * dpr; this.cv.height = s * dpr;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  burst(e) {
    const r = this.cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    this.proj().forEach((p, i) => {
      if ((p.sx - mx) ** 2 + (p.sy - my) ** 2 < 900) this.pts[i].flare = 1;
    });
    this.bounce = 1;
  }

  proj() {
    const t = performance.now() / 1000;
    const cy = Math.cos(this.ry), sy = Math.sin(this.ry);
    const cx_ = Math.cos(this.rx), sx_ = Math.sin(this.rx);
    const half = this.size / 2;
    const scale = half * 0.82 * (1 + this.bounce * 0.07);
    return this.pts.map((p) => {
      const w = 1 + Math.sin(t * 1.1 + p.phase) * 0.035;   // thinking wobble
      let x = p.x * w, y = p.y * w, z = p.z * w;
      let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;      // rot Y
      let y1 = y * cx_ - z1 * sx_, z2 = y * sx_ + z1 * cx_; // rot X
      const persp = 2.4 / (2.4 - z2 * 0.9);
      return { sx: half + x1 * scale * persp * 0.5,
               sy: half + y1 * scale * persp * 0.5,
               depth: (z2 + 1) / 2, persp };
    });
  }

  step(dt) {
    const busy = window.__orbBusy > 0 ? 1 : 0;
    const s = dt / 1000;
    this.px += (this.tpx - this.px) * Math.min(1, s * 5);
    this.py += (this.tpy - this.py) * Math.min(1, s * 5);
    this.ry += s * (0.22 + busy * 0.8 + this.px * 0.6); // pointer steers spin
    this.rx = 0.35 + this.py * 0.55 + Math.sin(performance.now() / 4700) * 0.12;
    this.bounce *= Math.pow(0.92, dt / 16);

    // neuron pulses
    this.nextPulse -= dt;
    if (this.nextPulse <= 0) {
      this.pts[(Math.random() * this.N) | 0].flare = 1;
      this.nextPulse = (700 + Math.random() * 1300) / (busy ? 4 : 1);
    }
    // propagate along edges, then decay
    for (const [a, b] of this.edges) {
      const fa = this.pts[a].flare, fb = this.pts[b].flare;
      if (fa > 0.25) this.pts[b].flare = Math.max(fb, fa * 0.82);
      else if (fb > 0.25) this.pts[a].flare = Math.max(fa, fb * 0.82);
    }
    const decay = Math.pow(busy ? 0.90 : 0.93, dt / 16);
    for (const p of this.pts) p.flare *= decay;
  }

  draw() {
    const c = this.cx, s = this.size, half = s / 2;
    const busy = window.__orbBusy > 0 ? 1 : 0;
    c.clearRect(0, 0, s, s);

    // ambient halo
    const g = c.createRadialGradient(half, half, s * 0.1, half, half, half);
    g.addColorStop(0, `rgba(233,180,76,${0.18 + busy * 0.12})`);
    g.addColorStop(1, "rgba(233,180,76,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);

    const P = this.proj();
    c.globalCompositeOperation = "lighter";

    // mesh edges
    for (const [a, b] of this.edges) {
      const pa = P[a], pb = P[b];
      const depth = (pa.depth + pb.depth) / 2;
      const flare = Math.max(this.pts[a].flare, this.pts[b].flare);
      const alpha = 0.05 + depth * 0.16 + flare * 0.4;
      c.strokeStyle = flare > 0.25
        ? `rgba(255,238,190,${alpha})`
        : `rgba(224,176,72,${alpha})`;
      c.lineWidth = 0.5 + depth * 0.5 + flare * 0.8;
      c.beginPath(); c.moveTo(pa.sx, pa.sy); c.lineTo(pb.sx, pb.sy); c.stroke();
    }

    // nodes
    for (let i = 0; i < this.N; i++) {
      const p = P[i], n = this.pts[i];
      const rad = (0.6 + p.depth * 1.1) * p.persp * 0.9 * (1 + n.flare * 1.5);
      const alpha = 0.25 + p.depth * 0.55 + n.flare * 0.45;
      c.fillStyle = n.violet
        ? `rgba(255,214,120,${alpha})`
        : (n.flare > 0.3 ? `rgba(255,247,220,${alpha})`
                         : `rgba(240,196,96,${alpha})`);
      c.beginPath(); c.arc(p.sx, p.sy, rad, 0, 6.2832); c.fill();
    }
    c.globalCompositeOperation = "source-over";
  }

  loop(t) {
    const dt = Math.min(50, t - this.last);
    this.last = t;
    this.step(dt);
    this.draw();
    requestAnimationFrame((tt) => this.loop(tt));
  }
}

// both cores start immediately — the lock-screen orb greets you before unlock
const orbs = [];
if (el("orb-main")) orbs.push(new PlexusOrb(el("orb-main"), { nodes: 210, k: 3 }));
if (el("orb-lock")) orbs.push(new PlexusOrb(el("orb-lock"), { nodes: 120, k: 3 }));
addEventListener("resize", () => orbs.forEach((o) => o.resize()));

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
  const ago = mins < 1 ? "just now" : mins < 60 ? mins + "m ago" : Math.round(mins / 60) + "h ago";
  el("sync-text").textContent = "SYNCED " + ago.toUpperCase();
  el("sync-dot").className = "dot " + (mins < 90 ? "ok" : "gold");
}

// ── horizon + gates ─────────────────────────────────────
function renderHorizon() {
  const h = S.goals.horizon;
  el("hz-label").textContent = h.label;

  const track = el("hz-track");
  track.innerHTML =
    `<div class="fill" id="hz-fill"></div>
     <div class="you" id="hz-you"></div>
     <div class="youlab" id="hz-youlab"></div>` +
    h.milestones.map((n) => `
      <div class="node${n.passed ? " passed" : ""}" style="left:${n.pos}%"></div>
      <div class="nlab" style="left:${n.pos}%"><strong>${esc(n.label)}</strong>${esc(n.sub)}</div>
    `).join("");

  el("hz-youlab").innerHTML = `you're here · <span class="v">${esc(h.currentLabel)}</span>`;
  requestAnimationFrame(() =>
    setTimeout(() => {
      el("hz-fill").style.width = h.currentPct + "%";
      el("hz-you").style.left = h.currentPct + "%";
      el("hz-youlab").style.left = h.currentPct + "%";
    }, 150));
}

// ── primary cards ───────────────────────────────────────
function renderInbox() {
  const a = S.inboxManager;
  const drafts = (a.recentDrafts || []).slice(0, 5);

  el("card-inbox").innerHTML = `
    <div class="chead">
      <div class="ic" style="background:var(--tealsoft)">📥</div>
      <span class="ctitle">${esc(a.name)}</span>
      <span class="cstatus"><span class="dot ok"></span>ACTIVE</span>
    </div>
    <div class="stat3">
      <div class="s"><div class="v">${a.last24h.scanned}</div><div class="k">scanned 24h</div></div>
      <div class="s"><div class="v" style="color:var(--teal)">${a.last24h.drafts}</div><div class="k">drafts ready</div></div>
      <div class="s"><div class="v" style="color:${a.last24h.urgent ? "var(--coral)" : "var(--ink3)"}">${a.last24h.urgent}</div><div class="k">urgent</div></div>
    </div>
    <div class="smallnote">${esc(a.summary)} <span style="color:var(--ink3)">· ${esc(a.lastRun)}</span></div>
    ${drafts.length ? `
      <div class="draftshead">
        <span>✍️ Waiting for your review</span>
        <span class="dcount">top ${drafts.length} of ${a.last24h.drafts}</span>
      </div>
      <div class="draftlist">
        ${drafts.map((d) => `
          <div class="dcard">
            <div class="dtop">
              <span class="dclient">${esc(d.client)}</span>
              <span class="dstatus">${esc(d.status || "drafted")}</span>
            </div>
            ${d.subject ? `<div class="dsubj">${esc(d.subject)}</div>` : ""}
            <div class="dnote">${esc(d.note)}</div>
            ${d.when ? `<div class="dwhen">${esc(d.when)}</div>` : ""}
          </div>`).join("")}
      </div>` : `
      <div class="smallnote" style="color:var(--ink3)">
        No client-facing drafts staged right now.</div>`}`;
}

// ── background maintenance: its own quiet card, not a CEO action item ──
function renderCleanup() {
  const b = (S.inboxManager || {}).batch || {};
  const filed = b.filed ?? b.processed ?? 0;
  const remaining = typeof b.remaining === "number" ? b.remaining : null;
  const cutoff = b.cutoff
    ? new Date(b.cutoff + "T00:00:00").toLocaleDateString("en-US",
        { month: "long", day: "numeric" })
    : null;

  // Only draw a bar when both sides of the ratio are actually measured —
  // otherwise show counts and say the remaining figure is unknown.
  let bar = "";
  if (remaining !== null && filed > 0) {
    const pct = Math.max(2, Math.min(100, Math.round((filed / (filed + remaining)) * 100)));
    bar = `
      <div class="bgbar"><div class="bgfill" data-w="${pct}%"></div></div>
      <div class="bgrow">
        <span>${filed.toLocaleString()} filed</span>
        <span class="bgtarget">~${remaining.toLocaleString()} left${
          cutoff ? ` before ${esc(cutoff)}` : ""}</span>
      </div>
      <div class="bgapprox">${pct}% complete · remaining count is Gmail’s estimate</div>`;
  } else {
    bar = `
      <div class="bgrow">
        <span>${filed.toLocaleString()} filed</span>
        <span class="bgtarget">remaining unknown</span>
      </div>
      <div class="bgapprox">No reliable remaining count this cycle — no progress inferred.</div>`;
  }

  el("card-cleanup").innerHTML = `
    <div class="bghead">
      <span class="bgdot"></span>
      <span class="bgtitle">Inbox Batch Cleanup</span>
      <span class="bgruns">${b.runs ? esc(b.runs + " runs") : ""}</span>
    </div>
    <div class="bgsub">${cutoff
      ? `Cleaning inbox history through ${esc(cutoff)}`
      : "Filing historical email in batches"}</div>
    ${bar}`;
}

// ── privacy: one reusable switch for every sensitive figure ──────────
// Any element tagged .sens is obscured when privacy is on. CSS-only, so the
// toggle is instant with no re-render, and layout never shifts.
const PRIV_KEY = "skycmd_privacy_v1";
let privacyOn = false;

function applyPrivacy(on, persist = true) {
  privacyOn = !!on;
  document.body.classList.toggle("privacy-on", privacyOn);
  const btn = el("priv-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", String(privacyOn));
    el("priv-ico").textContent = privacyOn ? "🔒" : "👁";
    el("priv-label").textContent = privacyOn ? "HIDDEN" : "FINANCIALS";
    btn.title = privacyOn
      ? "Financial figures hidden — click to reveal (P)"
      : "Hide financial figures (P)";
  }
  if (persist) {
    try { localStorage.setItem(PRIV_KEY, privacyOn ? "1" : "0"); } catch { /* private mode */ }
  }
}

function initPrivacy() {
  let saved = false;
  try { saved = localStorage.getItem(PRIV_KEY) === "1"; } catch { /* ignore */ }
  applyPrivacy(saved, false);           // restore last state, don't re-persist
  el("priv-toggle").onclick = () => applyPrivacy(!privacyOn);
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || "");
    if (!typing && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      applyPrivacy(!privacyOn);
    }
  });
}

/** Wrap a value so the privacy switch can obscure it. */
function sens(v) {
  return `<span class="sens">${esc(v)}</span>`;
}

// ── CEO Daily Briefing — reads like an email waiting from Chloe ───────
// Financial indicators deliberately omitted: Financial Pulse sits directly
// below and already carries them. The full briefing stays closed until asked.
function renderBriefing() {
  const b = S.briefing;
  const hasHtml = !!(b.html && b.html.length > 500);
  const stale = b.feeds.filter((f) => !f.fresh).length;
  const today = new Date().toLocaleDateString("en-US",
    { weekday: "long", month: "long", day: "numeric" });

  el("card-briefing").innerHTML = `
    <div class="chead">
      <div class="ic" style="background:var(--goldsoft)">📬</div>
      <span class="ctitle">${esc(b.name)}</span>
      <span class="cstatus"><span class="dot ok"></span>SENT ${esc(b.sentAt.toUpperCase())}</span>
    </div>
    <div class="envelope" id="bf-envelope" role="button" tabindex="0"
         aria-label="Open the full CEO Daily Briefing">
      <div class="envfrom">
        <span class="envavatar">C</span>
        <div class="envmeta">
          <div class="envname">Chloe <span class="envrole">· AI Executive Assistant</span></div>
          <div class="envsubj">Chloe’s CEO Briefing — ${esc(today)}</div>
        </div>
      </div>
      <div class="envpreview">${esc(b.quote)}</div>
      <div class="envfoot">
        <button class="openbrief" id="bf-open" type="button">Open Full Briefing →</button>
        <span class="envfeeds">${b.feeds.length - stale}/${b.feeds.length} feeds live${
          stale ? ` · ${stale} stale` : ""}</span>
      </div>
    </div>`;

  if (hasHtml) {
    const open = () => {
      el("bf-frame").srcdoc = b.html;
      el("bf-overlay").classList.add("show");
    };
    el("bf-open").onclick = (e) => { e.stopPropagation(); open(); };
    const env = el("bf-envelope");
    env.onclick = open;
    env.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    };
  } else {
    el("bf-open").disabled = true;
    el("bf-open").textContent = "Briefing not staged yet";
  }
}

// ── focus / finance / agents ────────────────────────────
function renderFocus() {
  el("focus-list").innerHTML = S.goals.focus
    .map((f) => `<li class="${f.tone}">${esc(f.text)}</li>`).join("");
}

const money = (n) => (typeof n === "number"
  ? (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString() : "—");

function finRow(k, v, opts = {}) {
  const color = opts.neg && typeof v === "number" && v !== 0 ? "var(--coral)"
    : opts.color || "var(--ink)";
  const base = opts.count
    ? (typeof v === "number" ? v.toLocaleString() : "—")
    : money(v);
  const shown = opts.neg && typeof v === "number" && v > 0 ? `(${base})` : base;
  return `<div class="row"><span class="rk">${esc(k)}</span>
    <span class="rv" style="color:${color}">${shown}</span></div>`;
}

// Money for briefing tiles: negatives shown as ($X) in the tile's own red.
const bfMoney = (n) => (typeof n === "number"
  ? (n < 0 ? "(" + "$" + Math.abs(n).toLocaleString() + ")" : "$" + n.toLocaleString())
  : "—");
const stamp = (live, asOf) => live ? "● LIVE" : "◌ CACHED " + (asOf || "");

// One briefing-style KPI tile.
// Values + their sub-lines carry .sens so the privacy switch can obscure them.
// Labels, icons and structure stay visible — you can still explain the board
// to someone without exposing the figures.
function bfTile(cls, label, chip, num, sub) {
  return `<div class="bftile ${cls}">
    <div class="bfrow"><span class="bflabel">${esc(label)}</span>
      <span class="bfchip">${chip}</span></div>
    <div class="bfnum sens">${num}</div>
    <div class="bfsub${sub ? " sens" : ""}">${sub ? esc(sub) : ""}</div>
  </div>`;
}

/** "2026-08" → "August 2026"; falls back to whatever the API gave us. */
function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  if (!m) return ym || "this month";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function renderFinance() {
  const f = S.finance, c = f.crm, b = f.billing;
  el("fin-status").innerHTML =
    `<span class="dot ${b.live && c.live ? "ok" : "gold"}"></span>` +
    (b.live && c.live ? "BOTH APIS LIVE" : "PARTIAL — CACHED DATA IN USE");

  // ── CRM card: 4 tiles, exactly like the briefing ──
  el("card-crm").innerHTML = `
    <div class="bfhead">
      <div class="bfic">🎯</div>
      <span class="bftitle">Active CRM Leads</span>
      <span class="bfstamp">${stamp(c.live, c.asOf)}</span>
    </div>
    <div class="bftiles">
      ${bfTile("red", "HOT Leads", "🔥", c.hot ?? "—", "")}
      ${bfTile("amber", "Warm Leads", "🌡️", c.warm ?? "—", "")}
      ${bfTile("green", "Potential Revenue", "💲",
        `${money(c.potential)}<small>/mo</small>`, `${(c.hot||0)+(c.warm||0)} hot+warm leads`)}
      ${bfTile("blue", "Revenue (2026)", "📈",
        `${money(c.recurring)}<small>/mo</small>`,
        `${c.recurringClients ?? "—"} recurring · ${money(c.oneTime)} one-time YTD · ${c.oneTimeClients ?? "—"} projects`)}
    </div>
    <div class="bfnote">📸 Sales Pipeline board · Sky Collective Portal</div>`;

  // ── Billing Buddy card: monthly pulse tiles, matching the briefing ──
  const netCls = typeof b.net === "number" && b.net < 0 ? "slate neg" : "slate";
  el("card-billing").innerHTML = `
    <div class="bfhead">
      <div class="bfic" style="background:#2A2113;color:#FFB454">💵</div>
      <span class="bftitle">Monthly Billing Buddy <span class="bfdiv">|</span> ${esc(monthLabel(b.month))}</span>
      <span class="bfstamp">${stamp(b.live, b.asOf)}</span>
    </div>
    <div class="bftiles">
      ${bfTile("slate", "Total Revenue", "🚀", bfMoney(b.revenue), "Retainers + A-La-Carte + Projects")}
      ${bfTile("slate", "PM Base Pay*", "👛", bfMoney(b.pmBasePay), "Monthly assignments")}
      ${bfTile("slate", "Proposed A-La-Carte", "✨", bfMoney(b.alaCarte),
        `PM ${bfMoney(b.alaCartePm)} · Creative ${bfMoney(b.alaCarteCreative)}`)}
      ${bfTile("slate", "Project Payouts*", "📁", bfMoney(b.projectPayouts), "Creatives on projects")}
    </div>
    <div class="bftiles" style="margin-top:10px">
      ${bfTile("slate neg", "Total Payouts*", "🧾", bfMoney(-Math.abs(b.totalPayouts || 0)), "PM + Creative + Projects")}
      ${bfTile("slate neg", "Monthly Overhead", "🏢", bfMoney(-Math.abs(b.overhead || 0)), "Standard fixed expense")}
      ${bfTile(netCls, "Net Profit", "⚡", bfMoney(b.net),
        `${esc((b.status || "").replace("_", " "))} · Revenue − Payouts − Overhead`)}
      ${bfTile("slate", "Active Clients", "👥", (c.recurringClients ?? 0) + (c.oneTimeClients ?? 0) + "", "recurring + one-time")}
    </div>
    <div class="bfnote">* EXCLUDES OWNER · 📸 financial_pulse · Billing Buddy</div>`;
}

// deterministic barcode pattern so tiles look "instrumented" but stable
function barcode(seed) {
  let bits = "";
  for (let i = 0; i < 22; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bits += `<i style="opacity:${(seed % 100) < 45 ? 0.85 : 0.2}"></i>`;
  }
  return `<div class="barcode">${bits}</div>`;
}

// ── health model ──────────────────────────────────────────────────────
// The publisher computes `health` from real signals (file mtimes vs cron
// expectations, live API results, explicit flags). The UI only presents it.
const HEALTH = {
  working: { led: "WORKING", cls: "working", blurb: "Actively running a job" },
  healthy: { led: "HEALTHY", cls: "healthy", blurb: "Completed its work on schedule" },
  idle:    { led: "IDLE",    cls: "idle",    blurb: "Nothing due right now" },
  warning: { led: "WARNING", cls: "warning", blurb: "Behind schedule" },
  stalled: { led: "STALLED", cls: "stalled", blurb: "Expected work has not happened" },
  error:   { led: "ERROR",   cls: "error",   blurb: "A known failure occurred" },
};
const healthOf = (a) => HEALTH[a.health] ||
  (a.status === "alert" ? HEALTH.stalled : HEALTH.healthy);

/** A tiny operator at a workstation. Down states stop the animation and smoke. */
function workstation(a, h) {
  const down = h.cls === "stalled" || h.cls === "error";
  return `
    <div class="wstation ${h.cls}">
      <div class="wsmoke" aria-hidden="true"><i></i><i></i><i></i></div>
      <svg viewBox="0 0 64 40" class="wsvg" aria-hidden="true">
        <rect class="wdesk" x="6" y="30" width="52" height="3" rx="1.5"/>
        <rect class="wscreen" x="34" y="14" width="20" height="14" rx="2"/>
        <line class="wscan" x1="36" y1="18" x2="52" y2="18"/>
        <line class="wscan wscan2" x1="36" y1="22" x2="48" y2="22"/>
        <circle class="whead" cx="18" cy="15" r="5"/>
        <rect class="wbody" x="11" y="21" width="14" height="9" rx="3"/>
        <rect class="warm" x="23" y="22" width="10" height="3" rx="1.5"/>
        <circle class="weye" cx="16.4" cy="15" r="1"/>
        <circle class="weye" cx="19.9" cy="15" r="1"/>
      </svg>
      <div class="wdata" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </div>`;
}

function renderAgents() {
  const bad = S.agents.filter((a) => ["stalled", "error", "warning"].includes(
    (healthOf(a)).cls)).length;
  el("agents-status").innerHTML = bad
    ? `<span class="dot warn"></span>${bad} NEED${bad === 1 ? "S" : ""} ATTENTION`
    : `<span class="dot ok"></span>ALL NOMINAL`;

  el("agentsgrid").innerHTML = S.agents.map((a, i) => {
    const h = healthOf(a);
    return `
      <button class="agent ${h.cls}" data-agent="${esc(a.id || String(i))}"
              type="button" aria-label="Open ${esc(a.name)} details">
        ${workstation(a, h)}
        <div class="ahead">
          <span class="dot ${h.cls === "healthy" || h.cls === "working" ? "ok"
            : h.cls === "idle" ? "" : "warn"}"></span>
          <span class="aname">${esc(a.name)}</span>
          <span class="aled ${h.cls}">${h.led}</span>
        </div>
        <div class="arole">${esc(a.role || "Automation")}</div>
        <div class="ameta"><span>${esc(a.schedule)}</span><b>NEXT ${esc(String(a.nextRun).toUpperCase())}</b></div>
        <div class="anote">${esc(a.note)}</div>
        <span class="aopen">Details →</span>
      </button>`;
  }).join("");

  el("agentsgrid").querySelectorAll("[data-agent]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-agent");
      const a = S.agents.find((x) => (x.id || "") === id) ||
                S.agents[Number(id)] || null;
      if (a) openAgentDrawer(a);
    };
  });
}

// ── agent detail drawer ───────────────────────────────────────────────
function buildDiagnosticPrompt(a, question) {
  const L = [];
  L.push(`Diagnose the "${a.name}" agent in Sky Command and get it running again.`);
  L.push("");
  L.push("AGENT CONTEXT (auto-collected by Sky Command)");
  L.push(`- id: ${a.id}`);
  L.push(`- name: ${a.name}`);
  L.push(`- role: ${a.role || "—"}`);
  L.push(`- purpose: ${a.purpose || a.desc || "—"}`);
  L.push(`- runner: ${a.runner || "launchd"}`);
  L.push(`- schedule: ${a.schedule}${a.cron ? `  (cron: ${a.cron})` : ""}`);
  L.push(`- health: ${a.health || a.status}`);
  L.push(`- status note: ${a.note}`);
  L.push(`- last successful output: ${a.lastSuccessAt || a.lastSuccess || "unknown"}`);
  L.push(`- next expected run: ${a.nextRun}`);
  if (a.deps && a.deps.length) L.push(`- depends on: ${a.deps.join(", ")}`);
  if (a.logPath) L.push(`- log: ${a.logPath}`);
  if (a.problem) L.push(`- reported problem: ${a.problem}`);
  if (a.action) L.push(`- Chloe's read: ${a.action}`);
  L.push("");
  L.push("ENVIRONMENT");
  L.push("- Publisher: ~/.claude/bin/sky_command_publish.py (launchd, every 30 min)");
  L.push("- Briefing stager: ~/.claude/bin/briefing_stager.py (launchd, 6:50 AM)");
  L.push("- Agent feeds are read from ~/.claude/feeds (TCC-safe; launchd cannot read ~/Desktop)");
  L.push("- Agent roster + flags: ~/.claude/sky-command/config.json");
  L.push("");
  L.push("REQUEST");
  L.push(question && question.trim()
    ? question.trim()
    : "Find out why this agent is not completing its scheduled work, fix the root cause, and confirm it produced fresh output.");
  L.push("");
  L.push("Report back in plain English: what was wrong, what you changed, and how you verified it.");
  return L.join("\n");
}

function openAgentDrawer(a) {
  const h = healthOf(a);
  const needsHelp = ["stalled", "error", "warning"].includes(h.cls);
  const d = el("ag-drawer");

  d.innerHTML = `
    <div class="dwhead">
      <div class="dwtitle">
        <span class="dwled ${h.cls}">${h.led}</span>
        <h3>${esc(a.name)}</h3>
        <div class="dwrole">${esc(a.role || "Automation")} · runs via ${esc(a.runner || "launchd")}</div>
      </div>
      <button class="qc" id="dw-close" type="button">✕</button>
    </div>
    <div class="dwbody">
      <section class="dwsec">
        <h4>What Chloe uses this for</h4>
        <p>${esc(a.purpose || a.desc)}</p>
      </section>

      <section class="dwsec">
        <h4>Current status</h4>
        <div class="dwstat ${h.cls}">
          <span class="dwstatled"></span>
          <div><b>${h.led.charAt(0) + h.led.slice(1).toLowerCase()}</b>
            <div class="dwmuted">${esc(h.blurb)}</div></div>
        </div>
        <div class="dwgrid">
          <div><span>Last successful run</span><b>${esc(a.lastSuccessAt || a.lastSuccess || "unknown")}</b></div>
          <div><span>Next scheduled</span><b>${esc(a.nextRun)}</b></div>
          <div><span>Schedule</span><b>${esc(a.schedule)}</b></div>
          <div><span>Current activity</span><b>${esc(a.note)}</b></div>
        </div>
      </section>

      ${needsHelp && (a.problem || a.action) ? `
      <section class="dwsec problem">
        <h4>What appears to be wrong</h4>
        <p>${esc(a.problem || a.note)}</p>
        ${a.action ? `<div class="dwrec"><b>Chloe recommends</b><p>${esc(a.action)}</p></div>` : ""}
      </section>` : ""}

      ${(a.deps && a.deps.length) ? `
      <section class="dwsec">
        <h4>Depends on</h4>
        <ul class="dwdeps">${a.deps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </section>` : ""}

      <section class="dwsec">
        <h4>Ask Chloe to investigate</h4>
        <p class="dwmuted">Sends this agent’s full context plus your instruction to Claude Code
          through the encrypted brief queue.</p>
        <textarea id="dw-q" rows="2"
          placeholder="e.g. Figure out why this agent stopped working and get it running again."></textarea>
        <div class="dwbtns">
          <button class="openbrief" id="dw-diag" type="button">🔧 Diagnose Agent</button>
          <button class="qc" id="dw-copy" type="button">Copy prompt</button>
        </div>
        <div class="dwresult" id="dw-result"></div>
      </section>

      <details class="dwtech">
        <summary>Technical details</summary>
        <pre>${esc(JSON.stringify({
          id: a.id, health: a.health, status: a.status, cron: a.cron,
          runner: a.runner, log: a.logPath, lastSuccess: a.lastSuccessAt,
          deps: a.deps,
        }, null, 2))}</pre>
      </details>
    </div>`;

  const close = () => {
    d.classList.remove("show");
    el("ag-veil").classList.remove("show");
  };
  el("dw-close").onclick = close;
  el("ag-veil").onclick = close;
  document.addEventListener("keydown", function esc2(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc2); }
  });

  el("dw-copy").onclick = async () => {
    const p = buildDiagnosticPrompt(a, el("dw-q").value);
    try {
      await navigator.clipboard.writeText(p);
      el("dw-result").innerHTML = `<span class="ok">✓ Prompt copied — paste into Claude Code.</span>`;
    } catch {
      el("dw-result").innerHTML = `<pre class="promptout">${esc(p)}</pre>`;
    }
  };
  el("dw-diag").onclick = () => dispatchDiagnostic(a, el("dw-q").value);

  el("ag-veil").classList.add("show");
  d.classList.add("show");
  d.focus();
}

/** Queue a diagnostic through the SAME encrypted brief pipeline Build mode
 *  already uses: encrypt → commit to briefs/pending → Mac ingests → Codex.
 *  There is no return channel yet, so we say so instead of faking a reply. */
async function dispatchDiagnostic(a, question) {
  const out = el("dw-result");
  const prompt = buildDiagnosticPrompt(a, question);
  if (!S.chat || !S.chat.ghToken || !S.chat.ghRepo) {
    out.innerHTML = `<span class="warn">Dispatch channel unavailable — no repo credentials in
      this state. Use “Copy prompt” and paste into Claude Code.</span>`;
    return;
  }
  out.innerHTML = `<span class="dwmuted">Queueing diagnostic…</span>`;
  const brief = {
    task_id: `diagnose_${a.id}_${Date.now()}`,
    title: `Diagnose agent: ${a.name}`,
    agent: "codex",
    permission_level: "green",
    kind: "agent_diagnostic",
    subject_agent: a.id,
    created_at: new Date().toISOString(),
    prompt,
  };
  try {
    const enc = await encryptForRepo(brief);
    const r = await fetch(
      `https://api.github.com/repos/${S.chat.ghRepo}/contents/briefs/pending/${brief.task_id}.json.enc`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + S.chat.ghToken, Accept: "application/vnd.github+json" },
        body: JSON.stringify({
          message: "agent diagnostic: " + a.id,
          content: btoa(unescape(encodeURIComponent(enc))),
        }),
      });
    if (!r.ok) throw new Error("GitHub " + r.status);
    out.innerHTML = `<span class="ok">✓ Queued.</span> <span class="dwmuted">The Mac ingests it
      within ~30 min and it lands in the Codex queue on the next hourly sync. Results are not
      streamed back here yet — check the agent card or ask Chloe in chat.</span>`;
  } catch (e) {
    out.innerHTML = `<span class="warn">Couldn’t queue (${esc(e.message)}).
      Use “Copy prompt” and paste into Claude Code instead.</span>`;
  }
}

// ── bottom band: personal performance ───────────────────
const CI_STATUS = {
  done:    { dot: "ok",   label: "ON TRACK" },
  due:     { dot: "gold", label: "DUE" },
  overdue: { dot: "warn", label: "OVERDUE" },
  empty:   { dot: "warn", label: "NO DATA" },
};

const band = (p) => (p >= 75 ? "good" : p >= 50 ? "mid" : "low");

function renderCheckin() {
  const c = S.checkin;
  const st = CI_STATUS[c.status] || CI_STATUS.empty;
  const head = `
    <div class="chead">
      <div class="ic" style="background:var(--goldsoft)">🌅</div>
      <span class="ctitle">${esc(c.name)}</span>
      <span class="cstatus ${esc(c.status)}"><span class="dot ${st.dot}"></span>${st.label}</span>
    </div>`;

  if (c.status === "empty" || !c.score) {
    el("card-checkin").innerHTML = head + `
      <div class="ppempty">${esc(c.statusNote)}<br/>
        ${c.ruleCount} rules across ${c.categories.length} areas · ${c.goalCount} goals tracked.</div>
      <div class="ppactions"><button class="btn-gold" id="ci-open">Start first check-in</button></div>`;
    el("ci-open").onclick = openCheckin;
    return;
  }

  const s = c.score;
  const cats = s.categories.map((k) => `
    <div class="ppcat ${band(k.pct)}">
      <div class="t"><span>${esc(k.short)}</span><b>${k.pct}%</b></div>
      <div class="gbar"><div data-w="${k.pct}%"></div></div>
    </div>`).join("");

  const peak = Math.max(...c.trend.map((t) => t.pct), 1);
  const spark = c.trend.length > 1
    ? `<span class="ppspark" title="Last ${c.trend.length} weeks">${
        c.trend.map((t, i) => `<i style="height:${Math.max(2, Math.round(22 * t.pct / peak))}px"
          class="${i === c.trend.length - 1 ? "last" : ""}" title="${esc(t.weekOf)} · ${t.pct}%"></i>`).join("")
      }</span>` : "";

  const energy = c.energy.filter((e) => e.value != null);
  const carry = c.carryForward || c.topGoal;

  el("card-checkin").innerHTML = head + `
    <div class="pp">
      <div class="ppscore ${band(s.pct)}">
        <div class="v">${s.pct}<small>%</small></div>
        <div class="k">${s.answered}/${c.ruleCount} rated</div>
      </div>
      <div class="ppcats">${cats}</div>
    </div>
    <div class="ppmeta">
      <span>Streak <b>${c.streak}w</b></span>
      <span>Logged <b>${c.totalCheckins}</b></span>
      <span>Goals moved <b>${c.goalsMoved}</b></span>
      ${energy.length ? `<span>Energy <b>${
        Math.round(energy.reduce((a, e) => a + e.value, 0) / energy.length * 10) / 10}/10</b></span>` : ""}
      ${spark}
    </div>
    ${carry ? `<div class="ppcarry"><span>Carrying into this week —</span> ${esc(carry)}</div>` : ""}
    <div class="ppactions">
      <button class="btn-gold" id="ci-open">${c.status === "done" ? "Revise check-in" : "Start check-in"}</button>
      <span class="cistatus">${esc(c.statusNote)}</span>
    </div>`;
  el("ci-open").onclick = openCheckin;
}

// ── weekly check-in form ────────────────────────────────
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RATINGS = [["good", "Good"], ["moderate", "Moderate"], ["needs", "Needs work"]];
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Monday of the week this ritual plans — always next week, so a Sunday
 *  check-in plans tomorrow. Must stay in step with planning_monday() in
 *  sky_command_publish.py or entries file under the wrong week. */
function planningMonday(now = new Date()) {
  const d = new Date(now);
  d.setDate(now.getDate() + (now.getDay() === 0 ? 1 : 8 - now.getDay()));
  d.setHours(0, 0, 0, 0);
  return d;
}

const CI = { ratings: {}, goals: {}, week: null, draftKey: null };

function openCheckin() {
  const c = S.checkin;
  const monday = planningMonday();
  CI.week = isoDate(monday);
  CI.draftKey = "skyCheckinDraft:" + CI.week;
  CI.ratings = {};
  CI.goals = {};

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  el("ci-week").textContent = `WEEK OF ${fmt(monday).toUpperCase()} — ${fmt(sunday).toUpperCase()}`;

  const rulesByCat = {};
  c.rules.forEach((r) => (rulesByCat[r.category] ||= []).push(r));

  el("ci-form").innerHTML = `
    <div class="cisec">
      <h3>🏆 Last week's review</h3>
      <div class="sub">Be honest with yourself.</div>
      <div class="cilabel">3–5 biggest wins</div>
      ${[1, 2, 3, 4, 5].map((i) => `
        <div class="ciwin"><div class="n">${i}</div>
          <textarea name="win${i}" rows="2" placeholder="${
            i < 4 ? "What went really well?" : "Optional…"}"></textarea></div>`).join("")}
      <div class="cifield"><div class="cilabel">Lessons learned — keep, change, adjust</div>
        <textarea name="lessons" rows="3" placeholder="Be specific. What will you actually change?"></textarea></div>
      <div class="cifield"><div class="cilabel">Personal / housekeeping</div>
        <textarea name="personalTasks" rows="2"></textarea></div>
      <div class="cifield"><div class="cilabel">Outstanding or lingering</div>
        <textarea name="outstanding" rows="2"></textarea></div>
    </div>

    <div class="cisec">
      <h3>📆 This week's plan</h3>
      <div class="sub">${esc(fmt(monday))} — ${esc(fmt(sunday))}</div>
      ${DAYS.map((day, i) => {
        const d = new Date(monday); d.setDate(monday.getDate() + i);
        return `<div class="ciday">
          <div class="d">${day}<em>${fmt(d)}</em></div>
          <textarea name="day_${day.toLowerCase()}" rows="2" placeholder="${
            i > 4 ? "Rest, enjoyment, personal…" : "Key focus, meetings, goals…"}"></textarea></div>`;
      }).join("")}
    </div>

    <div class="cisec">
      <h3>⚖️ Weekly self-assessment</h3>
      <div class="sub">Rate yourself against your ${c.rules.length} rules.</div>
      ${Object.entries(rulesByCat).map(([cat, items]) => `
        <div class="cicat">${esc(cat)}</div>
        ${items.map((r) => `
          <div class="cirule" id="rule-${r.num}">
            <div class="n">${r.num}</div>
            <div class="t">${esc(r.text)}</div>
            <div class="cirbtns">${RATINGS.map(([v, lbl]) =>
              `<button class="cirb" type="button" data-rule="${r.num}" data-val="${v}">${lbl}</button>`).join("")}
            </div>
          </div>`).join("")}`).join("")}
    </div>

    <div class="cisec">
      <h3>🎯 Goals progress</h3>
      <div class="sub">Mark anything you moved this week.</div>
      ${Object.entries(c.goals).map(([cat, list]) => `
        <div class="cigoalcat">${esc(cat)}</div>
        ${list.map((g, i) => {
          const key = `${cat}_${i}`;
          return `<div class="cigoal">
            <div class="box" data-goal="${esc(key)}" role="checkbox" aria-checked="false" tabindex="0">✓</div>
            <div class="g">${esc(g)}</div></div>`;
        }).join("")}`).join("")}
      <div class="cifield" style="margin-top:14px">
        <div class="cilabel">The #1 goal getting your focus this week</div>
        <textarea name="topGoal" rows="2"></textarea></div>
    </div>

    <div class="cisec">
      <h3>⚡ Energy &amp; spiritual check</h3>
      <div class="sub">How are you doing — not the business.</div>
      <div class="cienergy">
        ${c.energyFields.map((f) => `
          <div class="cifield"><div class="cilabel">${esc(f.label)} (1–10)</div>
            <input type="text" name="${esc(f.key)}" placeholder="e.g. 7 — two workouts in"/></div>`).join("")}
      </div>
      <div class="cifield"><div class="cilabel">One thing to carry into this week</div>
        <textarea name="carryForward" rows="2" placeholder="A word, a posture, a commitment."></textarea></div>
    </div>`;

  el("ci-form").querySelectorAll(".cirb").forEach((b) => {
    b.onclick = () => rateRule(b.dataset.rule, b.dataset.val);
  });
  el("ci-form").querySelectorAll(".box[data-goal]").forEach((b) => {
    b.onclick = () => toggleGoal(b);
    b.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleGoal(b); } };
  });
  el("ci-form").addEventListener("input", saveDraft);

  restoreDraft();
  ciTally();
  el("ci-status").textContent = "";
  el("ci-status").className = "cistatus";
  el("ci-save").disabled = false;
  el("ci-overlay").classList.add("show");
  document.body.style.overflow = "hidden";
}

function closeCheckin() {
  el("ci-overlay").classList.remove("show");
  document.body.style.overflow = "";
}

function rateRule(num, val) {
  CI.ratings["r" + num] = val;
  el("rule-" + num).querySelectorAll(".cirb").forEach((b) => {
    b.className = "cirb" + (b.dataset.val === val ? " on-" + val : "");
  });
  ciTally();
  saveDraft();
}

function toggleGoal(box) {
  const key = box.dataset.goal;
  CI.goals[key] = !CI.goals[key];
  box.classList.toggle("on", CI.goals[key]);
  box.setAttribute("aria-checked", String(!!CI.goals[key]));
  saveDraft();
}

function ciTally() {
  const v = Object.values(CI.ratings);
  const n = (r) => v.filter((x) => x === r).length;
  el("ci-good").textContent = n("good");
  el("ci-mod").textContent = n("moderate");
  el("ci-needs").textContent = n("needs");
  el("ci-total").textContent = `${v.length}/${S.checkin.ruleCount}`;
}

function collectCheckin() {
  const data = { weekOf: CI.week, savedAt: new Date().toISOString() };
  el("ci-form").querySelectorAll("textarea[name], input[name]").forEach((f) => {
    if (f.value.trim()) data[f.name] = f.value.trim();
  });
  data.ratings = { ...CI.ratings };
  data.goalProgress = { ...CI.goals };
  return data;
}

/** Drafts live in this browser only, so a half-finished Sunday check-in
 *  survives a refresh without touching the repo. */
function saveDraft() {
  try {
    localStorage.setItem(CI.draftKey, JSON.stringify(collectCheckin()));
    el("ci-draft").textContent = "draft saved";
  } catch { /* private mode — the form still works, just no draft */ }
}

function restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem(CI.draftKey) || "null"); } catch { return; }
  if (!d) return;
  el("ci-form").querySelectorAll("textarea[name], input[name]").forEach((f) => {
    if (d[f.name]) f.value = d[f.name];
  });
  Object.entries(d.ratings || {}).forEach(([k, v]) => rateRule(k.slice(1), v));
  Object.entries(d.goalProgress || {}).forEach(([k, v]) => {
    if (!v) return;
    const box = el("ci-form").querySelector(`.box[data-goal="${CSS.escape(k)}"]`);
    if (box) toggleGoal(box);
  });
  el("ci-draft").textContent = "draft restored";
}

async function saveCheckin() {
  const data = collectCheckin();
  const answered = Object.keys(data.ratings).length;
  const status = el("ci-status");
  if (!answered) {
    status.className = "cistatus warn";
    status.textContent = "Rate at least one rule before saving.";
    return;
  }

  // Dev mode encrypts with a zero-key placeholder, so the publisher could
  // never decrypt what we'd file. Keep the draft, refuse the push.
  if (devMode) {
    status.className = "cistatus warn";
    status.textContent = "Dev mode (plaintext state) — draft saved locally, not filed.";
    return;
  }
  const path = `checkins/pending/${CI.week}.json.enc`;
  if (!S.chat || !S.chat.ghToken || !S.chat.ghRepo) {
    status.className = "cistatus warn";
    status.textContent = "Saved as a local draft only — no repo credentials in this state.";
    return;
  }

  el("ci-save").disabled = true;
  status.className = "cistatus";
  status.textContent = "Encrypting and filing…";
  try {
    const enc = await encryptForRepo(data);
    const url = `https://api.github.com/repos/${S.chat.ghRepo}/contents/${path}`;
    const headers = {
      Authorization: "Bearer " + S.chat.ghToken,
      Accept: "application/vnd.github+json",
    };
    // A re-submitted week is still sitting in pending until the Mac ingests it;
    // GitHub needs that blob's sha to overwrite rather than 409.
    let sha;
    const head = await fetch(url, { headers, cache: "no-store" });
    if (head.ok) sha = (await head.json()).sha;

    const r = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `check-in: week of ${CI.week}`,
        content: btoa(unescape(encodeURIComponent(enc))),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!r.ok) throw new Error("GitHub " + r.status);

    try { localStorage.removeItem(CI.draftKey); } catch { /* nothing to clear */ }
    status.className = "cistatus ok";
    status.textContent = `✓ Filed — ${answered}/${S.checkin.ruleCount} rated. The board picks it up within ~30 min.`;
    el("ci-draft").textContent = "";
    setTimeout(closeCheckin, 2200);
  } catch (e) {
    el("ci-save").disabled = false;
    status.className = "cistatus warn";
    status.textContent = `Couldn't file it (${esc(e.message)}). Your draft is saved locally — try again.`;
  }
}

function initCheckin() {
  el("ci-close").onclick = closeCheckin;
  el("ci-save").onclick = saveCheckin;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el("ci-overlay").classList.contains("show")) closeCheckin();
  });
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

// ── chat console ────────────────────────────────────────
const thread = () => el("thread");

function addMsg(who, text, cls) {
  const div = document.createElement("div");
  div.className = "msg " + who + (cls ? " " + cls : "");
  const stamp = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
  div.innerHTML =
    `<div class="who">${who === "chloe" ? "Chloe" : "Sky"}` +
    `<span class="ts">${stamp}</span></div>${esc(text)}`;
  thread().appendChild(div);
  thread().scrollTop = thread().scrollHeight;
  return div;
}

function typingBubble() {
  const t = document.createElement("div");
  t.className = "msg chloe";
  t.innerHTML = `<div class="who">Chloe</div><span class="typing"><i></i><i></i><i></i></span>`;
  thread().appendChild(t);
  thread().scrollTop = thread().scrollHeight;
  return t;
}

async function llm(messages) {
  window.__orbBusy++;
  el("core-status").textContent = "· thinking";
  try {
    return await llmCall(messages);
  } finally {
    window.__orbBusy--;
    if (!window.__orbBusy) el("core-status").textContent = "· online";
  }
}

async function llmCall(messages) {
  if (S.chat.provider === "anthropic") {
    const system = messages.filter((m) => m.role === "system")
      .map((m) => m.content).join("\n");
    const rest = messages.filter((m) => m.role !== "system");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": S.chat.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: S.chat.model, max_tokens: 1024, system, messages: rest }),
    });
    if (!r.ok) throw new Error("API " + r.status);
    const d = await r.json();
    return d.content[0].text.trim();
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + S.chat.apiKey,
    },
    body: JSON.stringify({ model: S.chat.model, messages, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error("API " + r.status);
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

async function chatTurn(text) {
  addMsg("you", text);
  const t = typingBubble();
  try {
    history.push({ role: "user", content: text });
    history = history.slice(-S.chat.maxHistory);
    const reply = await llm([
      { role: "system", content: S.chat.system }, ...history]);
    history.push({ role: "assistant", content: reply });
    t.remove();
    addMsg("chloe", reply);
  } catch (e) {
    t.remove();
    addMsg("chloe", "Live chat is unreachable right now (" + e.message +
      "). The board itself is still current — try again in a moment.");
  }
}

async function buildTurn(text) {
  addMsg("you", text);
  const t = typingBubble();
  try {
    const raw = await llm([
      { role: "system", content: S.chat.buildSystem },
      { role: "user", content: text }]);
    const brief = JSON.parse(raw.replace(/^```json?|```$/g, "").trim());
    brief.dispatched_at = new Date().toISOString();
    pendingBrief = brief;
    t.remove();
    const div = document.createElement("div");
    div.className = "msg chloe brief-preview";
    div.innerHTML =
      `<div class="who">Chloe · task brief</div>
       <b>${esc(brief.title || brief.task_id)}</b>
       <span class="gpill" style="margin-left:8px">${esc(brief.agent)} · ${esc(brief.permission_level)}</span>
       <pre>${esc(JSON.stringify(brief, null, 2))}</pre>
       <div class="briefbtns">
         <button class="send teal" id="brief-go">⚡ Queue it</button>
         <button class="send ghost" id="brief-no">Cancel</button>
       </div>`;
    thread().appendChild(div);
    thread().scrollTop = thread().scrollHeight;
    div.querySelector("#brief-go").onclick = () => dispatchBrief(div);
    div.querySelector("#brief-no").onclick = () => {
      pendingBrief = null;
      div.remove();
      addMsg("chloe", "Cancelled — nothing was queued.");
    };
  } catch (e) {
    t.remove();
    addMsg("chloe", "Couldn't draft that brief (" + e.message + "). Rephrase and try again.");
  }
}

async function dispatchBrief(previewDiv) {
  if (!pendingBrief) return;
  const brief = pendingBrief;
  pendingBrief = null;
  previewDiv.querySelector(".briefbtns").innerHTML =
    `<span class="tag">Dispatching…</span>`;
  try {
    const name = (brief.task_id || "brief_" + Date.now()) + ".json.enc";
    const enc = await encryptForRepo(brief);
    const r = await fetch(
      `https://api.github.com/repos/${S.chat.ghRepo}/contents/briefs/pending/${name}`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + S.chat.ghToken,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          message: "build-mode brief: " + (brief.task_id || name),
          content: btoa(unescape(encodeURIComponent(enc))),
        }),
      });
    if (!r.ok) throw new Error("GitHub " + r.status);
    previewDiv.querySelector(".briefbtns").innerHTML =
      `<span class="tag" style="color:var(--teal)">✓ Queued</span>`;
    addMsg("chloe", `Dispatched. “${brief.title || brief.task_id}” is en route to the ` +
      `${brief.agent} agent — the Mac ingests it within ~30 min and it lands in the ` +
      `Codex queue on the next hourly sync. Permission level: ${brief.permission_level}.`);
  } catch (e) {
    previewDiv.querySelector(".briefbtns").innerHTML =
      `<span class="tag" style="color:var(--coral)">✗ Dispatch failed — ${esc(e.message)}</span>`;
  }
}

function setMode(m) {
  mode = m;
  const isBuild = m === "build";
  el("tab-chat").classList.toggle("active", !isBuild);
  el("tab-build").classList.toggle("active", isBuild);
  el("tab-build").classList.toggle("build", isBuild);
  el("tab-chat").setAttribute("aria-selected", String(!isBuild));
  el("tab-build").setAttribute("aria-selected", String(isBuild));
  document.querySelector(".console").classList.toggle("buildmode", isBuild);
  el("mode-hint").textContent = isBuild
    ? "describe a task → Chloe writes the brief → you approve → Codex queue"
    : "ask about anything on the board";
  el("chatinput").placeholder = isBuild
    ? "Describe the task to dispatch — e.g. “have research pull 990s for the 12 hot leads”"
    : "Talk to Chloe — live numbers, agents, goals…";
  el("send-btn").textContent = isBuild ? "Draft brief" : "Send";
  el("send-btn").style.background = isBuild ? "var(--teal)" : "var(--gold)";
}

function initChat() {
  if (thread().children.length === 0) {
    (S.chat.seed || []).forEach((m) => addMsg(m.who, m.text));
    if (!S.chat.apiKey) {
      addMsg("chloe", "Note: no chat API key found in state — live chat is offline this cycle.");
    }
  }
  if (chatWired) return;
  chatWired = true;

  el("tab-chat").onclick = () => setMode("chat");
  el("tab-build").onclick = () => setMode("build");

  const quick = ["Inbox status", "How's my pipeline?", "Any agent problems?", "How am I tracking on goals?"];
  el("quick").innerHTML = quick
    .map((q) => `<button type="button" class="qc">${esc(q)}</button>`).join("");
  el("quick").addEventListener("click", (e) => {
    const btn = e.target.closest(".qc");
    if (!btn) return;
    setMode("chat");
    chatTurn(btn.textContent);
  });

  el("chatform").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el("chatinput");
    const v = input.value.trim();
    if (!v) return;
    input.value = "";
    (mode === "build" ? buildTurn : chatTurn)(v);
  });

  el("bf-close").onclick = () => el("bf-overlay").classList.remove("show");
}

// ── ambient system line ─────────────────────────────────
let sysIdx = 0;
function sysLines() {
  const lines = ["ALL SYSTEMS NOMINAL"];
  if (S) {
    const alerts = S.agents ? S.agents.filter((a) => a.status === "alert").length : 0;
    lines.push(alerts ? `${alerts} AGENT${alerts === 1 ? "" : "S"} NEED ATTENTION` : "ALL AGENTS GREEN");
    const fresh = S.briefing.feeds.filter((f) => f.fresh).length;
    lines.push(`FEEDS · ${fresh}/${S.briefing.feeds.length} LIVE`);
    if (S.goals.focus[0]) lines.push("FOCUS · " + S.goals.focus[0].text.slice(0, 40).toUpperCase());
  }
  return lines;
}

function initSysline() {
  setInterval(() => {
    const lines = sysLines();
    sysIdx = (sysIdx + 1) % lines.length;
    el("sysline-text").textContent = lines[sysIdx];
  }, 10000);
  setInterval(syncChip, 30000);
  // live telemetry clock in the agents console header
  const tick = () => {
    const c = el("tele-clock");
    if (c) c.textContent = new Date().toLocaleTimeString("en-US", { hour12: false }) + " CT";
  };
  tick();
  setInterval(tick, 1000);
}

// ── boot ────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderHorizon();
  renderInbox();
  renderCleanup();
  renderBriefing();
  renderFocus();
  renderFinance();
  renderAgents();
  renderCheckin();
  renderConnections();
  initChat();

  requestAnimationFrame(() =>
    setTimeout(() => {
      document.querySelectorAll(".bar .f[data-w], .bgfill[data-w], .ppcat .gbar > div[data-w]")
        .forEach((b) => { b.style.width = b.dataset.w; });
    }, 250));
}

async function boot() {
  try {
    S = await loadState({ interactive: true });
  } catch (e) {
    el("sysline-text").textContent = "STATE UNAVAILABLE — CHECK PUBLISHER";
    return;
  }
  initPrivacy();   // restore the last privacy state BEFORE the first paint
  initCheckin();
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
    } catch { /* offline — keep last state */ }
  }, POLL_MS);
}

boot();
