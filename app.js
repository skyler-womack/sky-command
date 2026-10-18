// SKY COMMAND — render + live-state layer.
//
// Boot: state.json (dev) → state.enc (AES-256-GCM, passphrase unlock).
// The hero is Chloe's Executive Priorities, ranked by the publisher
// (sky_priorities.py). Nothing in this file calls an AI model. Writes back
// (check-ins, priority status, agent diagnostics) are encrypted with the
// session key and committed to the GitHub repo; the Mac publisher ingests them.
// Re-polls state every 5 minutes.

let S = null;
let sessionKeyBits = null;        // raw AES key after unlock (for repo writes)
let devMode = false;              // plaintext state.json — key is a placeholder

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

// ── finance / agents ────────────────────────────────────
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

const band = (p) =>
  (p === null || p === undefined ? "" : p >= 75 ? "good" : p >= 50 ? "mid" : "low");

// ── check-in lock ───────────────────────────────────────
// Once a check-in is filed, the button stays dead until 1:00 AM Houston time
// on the next Sunday. The publisher ships lockedUntil; the localStorage marker
// covers the ~30 minutes between filing and the next publish.
const CI_LOCK_KEY = "skycmd_ci_unlock_v1";
const CT_ZONE = "America/Chicago";
const CI_TIMER = { id: null };

/** Houston wall clock minus UTC (ms) at instant ms. */
function ctOffsetMs(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: CT_ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** UTC instant for a Houston wall-clock time (month 0-based; day may overflow). */
function ctWallToUtc(y, m, d, h) {
  const guess = Date.UTC(y, m, d, h);
  return guess - ctOffsetMs(guess - ctOffsetMs(guess));
}
/** Next Sunday 1:00 AM Houston time strictly after fromMs. */
function nextCheckinOpen(fromMs) {
  const w = new Date(fromMs + ctOffsetMs(fromMs));
  const ahead = (7 - w.getUTCDay()) % 7;
  const at = (extra) => ctWallToUtc(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + ahead + extra, 1);
  const t = at(0);
  return t > fromMs ? t : at(7);
}
/** ms timestamp the button reopens, or 0 when it is clickable. */
function ciLockedUntil() {
  let until = S && S.checkin && S.checkin.lockedUntil ? Date.parse(S.checkin.lockedUntil) || 0 : 0;
  try { until = Math.max(until, +localStorage.getItem(CI_LOCK_KEY) || 0); } catch { /* private mode */ }
  return until > Date.now() ? until : 0;
}
const ciOpensLabel = (ms) => new Date(ms).toLocaleString("en-US",
  { timeZone: CT_ZONE, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function renderCheckin() {
  const c = S.checkin;
  const lock = ciLockedUntil();
  const status = lock ? "done" : c.status;
  const st = CI_STATUS[status] || CI_STATUS.empty;
  const head = `
    <div class="chead">
      <div class="ic" style="background:var(--goldsoft)">🌅</div>
      <span class="ctitle">${esc(c.name)}</span>
      <span class="cstatus ${esc(status)}"><span class="dot ${st.dot}"></span>${st.label}</span>
    </div>`;

  if (c.status === "empty" || !c.score || c.score.pct === null) {
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
      ${spark}
    </div>
    ${carry ? `<div class="ppcarry"><span>Carrying into this week —</span> ${esc(carry)}</div>` : ""}
    <div class="ppactions">
      ${lock
        ? `<button class="btn-gold" id="ci-open" type="button" disabled aria-disabled="true"
             title="Reopens ${esc(ciOpensLabel(lock))}">✓ Filed for this week</button>`
        : `<button class="btn-gold" id="ci-open" type="button">${c.status === "done" ? "Revise check-in" : "Start check-in"}</button>`}
      <button class="qc" id="pp-dash">📊 Dashboard</button>
      <span class="cistatus">${lock ? `Next check-in opens ${esc(ciOpensLabel(lock))}.` : esc(c.statusNote)}</span>
    </div>`;
  el("ci-open").onclick = openCheckin;
  el("pp-dash").onclick = openDashboard;
  clearTimeout(CI_TIMER.id);
  if (lock) CI_TIMER.id = setTimeout(renderCheckin, Math.min(lock - Date.now() + 1500, 2 ** 31 - 1));
}

// ── weekly check-in form ────────────────────────────────
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RATINGS = [["good", "Good"], ["moderate", "Moderate"], ["needs", "Needs work"]];
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// ISO day -> "Oct 12", parsed as local so the label can't slip a day
const fromISO = (s) => new Date(...s.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
const dayLabel = (s) => fromISO(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const shortWeek = (s) => dayLabel(s);

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
  if (ciLockedUntil()) return;
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

  const hk = c.housekeeping || {};
  // the publisher only ships meetings for the week being planned, but guard
  // anyway so a stale state can never show last week's calendar as this week's
  const cal = (c.calendar || []).filter((e) => e.day >= CI.week);
  const byDay = [...cal.reduce((m, e) => m.set(e.day, [...(m.get(e.day) || []), e]),
                               new Map()).entries()];

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
    </div>

    <div class="cisec">
      <h3>📆 This week's plan</h3>
      <div class="sub">${esc(fmt(monday))} — ${esc(fmt(sunday))}${
        cal.length ? ` · ${cal.length} meeting${cal.length === 1 ? "" : "s"}` : ""}</div>
      ${cal.length ? byDay.map(([day, evs]) => `
        <div class="cicalday">
          <div class="cdh">${esc(evs[0].dow)}<em>${esc(dayLabel(day))}</em></div>
          ${evs.map((e, i) => {
            const id = `${day}_${i}`;
            return `<div class="cevt" data-evt="${esc(id)}">
              <div class="ct">${esc(e.time)}</div>
              <div class="cb">
                <div class="cn">${esc(e.title)}</div>
                ${e.meta ? `<div class="cm">${esc(e.meta)}</div>` : ""}
                <button class="cprepbtn" type="button" data-for="${esc(id)}">+ prep to-do</button>
                <input class="cprep" type="text" hidden
                       data-event="${esc(e.title)}" data-dow="${esc(e.dow)}" data-time="${esc(e.time)}"
                       name="prep_${esc(id)}" placeholder="What do you need to do before this?"/>
              </div>
            </div>`;
          }).join("")}
        </div>`).join("")
        : `<div class="ppempty">No meetings found for next week — either the week is
             genuinely clear or the calendar feed is stale. Nothing is being invented here.</div>`}
      <div class="smallnote" style="margin-top:10px">Prep to-dos go to your
        <b>${esc(hk.tasklist || "Sky Weekly Check-In")}</b> list in Google Tasks.</div>
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
      <div class="sub">Mark anything you moved this week. A ✓ badge means you
        already moved it in an earlier week.</div>
      ${Object.entries(c.goals).map(([cat, list]) => `
        <div class="cigoalcat">${esc(cat)}</div>
        ${list.map((g, i) => {
          const key = `${cat}_${i}`;
          const since = (c.goalsEverMoved || {})[key];
          return `<div class="cigoal">
            <div class="box" data-goal="${esc(key)}" role="checkbox" aria-checked="false" tabindex="0">✓</div>
            <div class="g">${esc(g)}</div>
            ${since ? `<span class="gdone" title="First moved the week of ${esc(since)}">✓ ${esc(shortWeek(since))}</span>` : ""}
          </div>`;
        }).join("")}`).join("")}
    </div>

    <div class="cisec">
      <h3>🧹 ${esc(hk.label || "Housekeeping Tasks")}</h3>
      <div class="sub">${esc(hk.hint || "What has to get handled this week?")}
        Each one becomes a Google Task, and Chloe emails you Wednesday morning
        about anything still open.</div>
      <div id="ci-hk"></div>
      <button class="qc" type="button" id="ci-hk-add">+ Add another</button>
    </div>

    <div class="cisec cidashcta">
      <div>
        <div class="cilabel" style="margin:0 0 3px">Zoom out</div>
        <div class="smallnote">See every week you've logged — scores, trends and
          the areas that keep slipping.</div>
      </div>
      <button class="btn-gold" type="button" id="ci-dash-btn">📊 Open dashboard</button>
    </div>`;

  hkRows(Math.max(1, hk.rows || 4));
  el("ci-hk-add").onclick = () => { hkRows(1, true); saveDraft(); };
  el("ci-dash-btn").onclick = () => { closeCheckin(); openDashboard(); };

  el("ci-form").querySelectorAll(".cprepbtn").forEach((b) => {
    b.onclick = () => {
      const inp = el("ci-form").querySelector(`.cprep[name="prep_${CSS.escape(b.dataset.for)}"]`);
      inp.hidden = false;
      b.remove();
      inp.focus();
    };
  });

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

/** Append n housekeeping rows (or render the initial set). */
function hkRows(n, append) {
  const box = el("ci-hk");
  if (!append) box.innerHTML = "";
  const start = box.children.length;
  for (let i = 0; i < n; i++) {
    const row = document.createElement("div");
    row.className = "cihk";
    row.innerHTML = `<div class="n">☐</div>
      <input type="text" name="hk_${start + i}" placeholder="e.g. Renew car registration"/>`;
    box.appendChild(row);
  }
  if (append) box.lastElementChild.querySelector("input").focus();
}

function collectCheckin() {
  const data = { weekOf: CI.week, savedAt: new Date().toISOString() };
  el("ci-form").querySelectorAll("textarea[name], input[name]").forEach((f) => {
    if (!f.value.trim()) return;
    if (f.name.startsWith("hk_") || f.name.startsWith("prep_")) return;  // collected below
    data[f.name] = f.value.trim();
  });
  data.housekeeping = [...el("ci-hk").querySelectorAll("input")]
    .map((i) => i.value.trim()).filter(Boolean);
  data.meetingPrep = [...el("ci-form").querySelectorAll(".cprep")]
    .filter((i) => i.value.trim())
    .map((i) => ({ todo: i.value.trim(), event: i.dataset.event,
                   dow: i.dataset.dow, time: i.dataset.time }));
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
  (d.housekeeping || []).forEach((t, i) => {
    if (i >= el("ci-hk").children.length) hkRows(1, true);
    el("ci-hk").children[i].querySelector("input").value = t;
  });
  (d.meetingPrep || []).forEach((p) => {
    const inp = [...el("ci-form").querySelectorAll(".cprep")]
      .find((i) => i.dataset.event === p.event && i.dataset.time === p.time);
    if (!inp) return;                       // meeting moved or was cancelled
    inp.value = p.todo;
    inp.hidden = false;
    const btn = el("ci-form").querySelector(`.cprepbtn[data-for="${CSS.escape(inp.name.slice(5))}"]`);
    if (btn) btn.remove();
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
    try { localStorage.setItem(CI_LOCK_KEY, String(nextCheckinOpen(Date.now()))); } catch { /* private mode */ }
    renderCheckin();
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

// ── check-in dashboard: personal intelligence ───────────
// Four views over the same published state. Everything here is read-only and
// derived from build_dashboard() in the publisher; the check-in form and its
// submission path are untouched by any of it.
const DASH = { tab: "overview", range: "all", hidden: new Set() };

const RANGES = [["4", "4 weeks"], ["12", "12 weeks"], ["ytd", "Year to date"], ["all", "All time"]];

function dashWeeks() {
  const all = (S.checkin.dashboard || {}).weeks || [];
  if (DASH.range === "all") return all;
  if (DASH.range === "ytd") {
    const y = String(new Date().getFullYear());
    return all.filter((w) => w.weekOf.startsWith(y));
  }
  return all.slice(-Number(DASH.range));
}

const avgOf = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const pctOf = (ws) => avgOf(ws.map((w) => w.pct).filter((p) => p !== null));

function openDashboard() {
  el("cd-overlay").classList.add("show");
  document.body.style.overflow = "hidden";
  renderDashShell();
}

function closeDashboard() {
  el("cd-overlay").classList.remove("show");
  document.body.style.overflow = "";
}

function renderDashShell() {
  const tabs = [["overview", "◈ Overview"], ["goals", "🎯 My Goals"],
                ["analytics", "📈 Life Analytics"], ["reports", "📁 Weekly Reports"]];
  el("cd-tabs").innerHTML = tabs.map(([k, label]) =>
    `<button class="cdtab ${DASH.tab === k ? "on" : ""}" data-tab="${k}">${label}</button>`).join("");
  el("cd-tabs").querySelectorAll(".cdtab").forEach((b) => {
    b.onclick = () => { DASH.tab = b.dataset.tab; renderDashShell(); };
  });
  renderDashTab();
}

function renderDashTab() {
  const d = S.checkin.dashboard;
  const body = el("cd-body");
  if (!d || !d.weeks.length) {
    body.innerHTML = `<div class="ppempty">No check-ins logged yet. Every view here
      fills in from your weekly entries.</div>`;
    return;
  }
  body.innerHTML = { overview: dashOverview, goals: dashGoals,
                     analytics: dashAnalytics, reports: dashReports }[DASH.tab](d);
  wireDashTab(d);
  requestAnimationFrame(() => body.querySelectorAll("[data-grow]").forEach((n) => {
    n.style.width = n.dataset.grow;
  }));
}

// ── A. overview ─────────────────────────────────────────
function dashOverview(d) {
  const c = S.checkin, g = d.goalSummary, i = d.intelligence;
  const last = d.weeks[d.weeks.length - 1], prev = d.weeks[d.weeks.length - 2];
  const delta = last && prev && last.pct !== null && prev.pct !== null ? last.pct - prev.pct : null;
  const scored = d.weeks.filter((w) => w.pct !== null);

  return `
    <div class="cdstats">
      ${cdTile(d.average + "%", "Life performance", band(d.average),
               `average of ${scored.length} weeks`)}
      ${cdTile(last.pct === null ? "—" : last.pct + "%", "Latest week", band(last.pct),
               delta === null ? shortWeek(last.weekOf)
                 : `${delta > 0 ? "▲" : delta < 0 ? "▼" : "—"} ${Math.abs(delta)} pts vs prior`)}
      ${cdTile(String(c.totalCheckins), "Weeks logged", "", `streak ${c.streak}w`)}
      ${cdTile(String(d.totalWins), "Wins captured", "", "across all weeks")}
      ${cdTile(String(g.achieved), "Goals achieved", "good", `${g.datedCompletions} dated in-period`)}
      ${cdTile(String(g.stalled), "Goals stalled", g.stalled ? "low" : "good",
               `${g.active} active · ${g.notStarted} not started`)}
    </div>

    <div class="cdintel">
      <div class="cdih">
        <span class="ic">◈</span>
        <div><b>Chloe's Personal Intelligence</b>
          <em>Read from ${scored.length} scored weeks and ${d.goals.length} tracked goals.
            Every line shows the numbers behind it.</em></div>
      </div>
      <div class="cdigrid">
        ${intelCard("What's going well", "good", i.good)}
        ${intelCard("What needs attention", "warn", i.attention)}
        ${intelCard("Patterns Chloe is noticing", "pat", i.patterns)}
        ${intelCard("Recommended this week", "act", i.actions)}
      </div>
    </div>

    <div class="cdsec">
      <h4>Trajectory <span class="cdsub">${esc(shortWeek(d.weeks[0].weekOf))} → ${esc(shortWeek(last.weekOf))}</span></h4>
      ${lineChart(scored.map((w) => ({ x: w.weekOf, y: w.pct })), 100)}
      ${d.best && d.worst ? `<div class="smallnote" style="margin-top:8px">
        Best <b>${esc(shortWeek(d.best.weekOf))}</b> ${d.best.pct}% ·
        toughest <b>${esc(shortWeek(d.worst.weekOf))}</b> ${d.worst.pct}%
        ${d.trendDelta === null ? "" : `· second half ${d.trendDelta > 0 ? "+" : ""}${d.trendDelta} pts on the first`}</div>` : ""}
    </div>`;
}

const intelCard = (title, tone, items) => `
  <div class="cdi ${tone}">
    <h5>${esc(title)}</h5>
    ${items.length ? items.map((x) => `
      <div class="cdirow"><div class="t">${esc(x.text)}</div>
        <div class="ev">${esc(x.evidence)}</div></div>`).join("")
      : `<div class="cdirow"><div class="t">Nothing to report from the data yet.</div></div>`}
  </div>`;

// ── B. goals ────────────────────────────────────────────
const GOAL_STATUS = {
  achieved: ["Achieved", "good"], active: ["Actively progressing", "good"],
  stalled: ["Stalled", "low"], urgent: ["Urgent", "low"],
  not_started: ["Not yet started", "mid"],
};
const STATUS_ORDER = ["urgent", "stalled", "active", "not_started", "achieved"];

function dashGoals(d) {
  const goals = d.goals;
  if (!goals.length) {
    return `<div class="ppempty">Goal history comes from the Basecamp weeks. None found
      in the current store.</div>`;
  }
  const needs = goals.filter((g) => g.status === "stalled" || g.status === "urgent")
                     .sort((a, b) => b.weeksInState - a.weeksInState);
  const byCat = {};
  goals.forEach((g) => (byCat[g.category] ||= []).push(g));

  return `
    <div class="cdstats">
      ${cdTile(String(d.goalSummary.achieved), "Achieved", "good")}
      ${cdTile(String(d.goalSummary.active), "Actively progressing", "good")}
      ${cdTile(String(d.goalSummary.stalled), "Stalled", "low")}
      ${cdTile(String(d.goalSummary.notStarted), "Not yet started", "mid")}
    </div>

    ${needs.length ? `
    <div class="cdsec cdneeds">
      <h4>⚠ Goals that need your attention</h4>
      <div class="smallnote" style="margin-bottom:12px">Marked as your next move but
        unchanged for ${window.__stallWeeks || 7}+ weeks running.</div>
      ${needs.map((g) => `
        <div class="cdneed" data-goal="${esc(g.text)}">
          <div class="w">${g.weeksInState}w</div>
          <div class="b"><div class="n">${esc(g.text)}</div>
            <div class="m">${esc(g.category)} · next-up since ${esc(shortWeek(g.firstActiveWeek || g.firstSeen))}</div></div>
          <span class="cdchev">›</span>
        </div>`).join("")}
    </div>` : ""}

    ${Object.keys(byCat).sort().map((cat) => {
      const list = byCat[cat].slice().sort(
        (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
      const done = list.filter((g) => g.status === "achieved").length;
      return `
      <div class="cdsec">
        <h4>${esc(cat)} <span class="cdsub">${done}/${list.length} achieved</span></h4>
        <div class="cdbarline"><div data-grow="${Math.round(100 * done / list.length)}%"></div></div>
        <div class="cdgoals">
          ${list.map((g) => {
            const [label, tone] = GOAL_STATUS[g.status];
            return `<div class="cdgoal ${g.status}" data-goal="${esc(g.text)}">
              <div class="cdgh">
                <span class="dotx ${tone}"></span>
                <span class="nm">${esc(g.text)}</span>
                <span class="st ${tone}">${label}</span>
              </div>
              <div class="cdgm">${goalMeta(g)}</div>
              ${goalTrack(g)}
            </div>`;
          }).join("")}
        </div>
      </div>`;
    }).join("")}`;
}

function goalMeta(g) {
  if (g.status === "achieved") {
    return g.datedCompletion
      ? `Completed week of ${esc(shortWeek(g.datedCompletion))}`
      : `Completed before tracking began — no date in the data`;
  }
  if (g.status === "not_started") return `Listed ${g.seenWeeks} weeks, never marked active`;
  return `${g.weeksInState} weeks in this state · tracked ${g.seenWeeks} weeks`;
}

/** Roadmap strip: one cell per tracked week, coloured by that week's state. */
function goalTrack(g) {
  if (!g.history || g.history.length < 2) return "";
  const tone = { completed: "good", active: "mid", urgent: "low", backlog: "" };
  return `<div class="cdtrack" title="State each tracked week">
    ${g.history.map((h) => `<i class="${tone[h.state] || ""}"
      title="${esc(h.weekOf)} · ${esc(h.state)}"></i>`).join("")}</div>`;
}

// ── C. analytics ────────────────────────────────────────
function dashAnalytics(d) {
  const weeks = dashWeeks();
  const names = d.categoryNames;
  const shown = names.filter((n) => !DASH.hidden.has(n));
  const inRange = new Set(weeks.map((w) => w.weekOf));
  const heat = d.heatmap.filter((r) => inRange.has(r.weekOf));

  const series = shown.map((n) => ({
    name: n,
    points: (d.categorySeries[n] || []).filter((p) => inRange.has(p.weekOf) && p.pct !== null)
      .map((p) => ({ x: p.weekOf, y: p.pct })),
  }));

  // period comparison: this range's second half against its first
  const sc = weeks.map((w) => w.pct).filter((p) => p !== null);
  const half = Math.floor(sc.length / 2);
  const cmp = sc.length >= 4
    ? { a: avgOf(sc.slice(0, half)), b: avgOf(sc.slice(half)) } : null;

  return `
    <div class="cdfilters">
      <span class="cdfl">Range</span>
      ${RANGES.map(([k, l]) => `<button class="cdchip ${DASH.range === k ? "on" : ""}"
        data-range="${k}">${l}</button>`).join("")}
      <span class="cdcount">${weeks.length} week${weeks.length === 1 ? "" : "s"}</span>
    </div>

    <div class="cdstats">
      ${cdTile((pctOf(weeks) ?? "—") + "%", "Average this range", band(pctOf(weeks)))}
      ${cmp ? cdTile((cmp.b - cmp.a > 0 ? "+" : "") + (cmp.b - cmp.a), "Second half vs first",
                     cmp.b - cmp.a > 0 ? "good" : cmp.b - cmp.a < 0 ? "low" : "mid",
                     `${cmp.a}% → ${cmp.b}%`) : ""}
      ${cdTile(String(weeks.reduce((a, w) => a + w.wins, 0)), "Wins in range")}
    </div>

    <div class="cdsec">
      <h4>Life balance calendar</h4>
      <div class="smallnote" style="margin-bottom:12px">Green good · amber average ·
        red needs work — the same meaning your Basecamp highlights carried.
        Hollow cells are weeks with no check-in. Click any week to open its report.</div>
      ${monthCalendar(heat, names, weeks)}
    </div>

    <div class="cdsec">
      <h4>Category trends</h4>
      <div class="cdlegend">
        ${names.map((n, i) => `<button class="cdleg ${DASH.hidden.has(n) ? "off" : ""}"
          data-cat="${esc(n)}"><i style="background:${catColor(i)}"></i>${esc(n)}</button>`).join("")}
      </div>
      ${series.some((s) => s.points.length) ? multiLineChart(series, names)
        : `<div class="ppempty">No category data in this range.</div>`}
    </div>

    <div class="cdsec">
      <h4>Every rule, ranked</h4>
      <div class="cdrank">
        ${d.ruleRanking.map((r) => `
          <div class="cdrr">
            <span class="n">${r.num}</span>
            <span class="s">${esc(r.short)}</span>
            <span class="t">${esc(r.text)}</span>
            <span class="mixbar">
              <i class="g" style="flex:${r.good}"></i><i class="m" style="flex:${r.moderate}"></i><i class="w" style="flex:${r.needs}"></i>
            </span>
            <span class="p ${band(r.pct)}">${r.pct}%</span>
          </div>`).join("")}
      </div>
    </div>`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

/** Every Monday falling inside a given year/month. */
function mondaysIn(year, month) {
  const out = [];
  const d = new Date(year, month, 1);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7));   // first Monday
  while (d.getMonth() === month) {
    out.push(isoDate(d));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

/** Life balance as a month-by-month calendar: one card per month, each a grid
 *  of that month's weeks against the six life areas. Weeks with no check-in
 *  are rendered hollow rather than skipped, so the gaps stay visible. */
function monthCalendar(heat, names, weeks) {
  if (!heat.length) return `<div class="ppempty">No weeks in this range.</div>`;
  const byWeek = Object.fromEntries(heat.map((r) => [r.weekOf, r.cells]));
  const scoreOf = Object.fromEntries(weeks.map((w) => [w.weekOf, w.pct]));
  const first = fromISO(heat[0].weekOf), last = fromISO(heat[heat.length - 1].weekOf);

  const cards = [];
  for (let y = first.getFullYear(), m = first.getMonth();
       y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth());
       m === 11 ? (m = 0, y++) : m++) {
    const mondays = mondaysIn(y, m);
    const logged = mondays.filter((w) => byWeek[w]);
    if (!logged.length) continue;                     // month with nothing logged
    const scores = logged.map((w) => scoreOf[w]).filter((p) => p !== null && p !== undefined);
    const mAvg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    cards.push(`
      <div class="cdmon">
        <div class="cdmonh">
          <span class="nm">${MONTHS[m]} <em>${y}</em></span>
          <span class="av ${band(mAvg)}">${mAvg === null ? "—" : mAvg + "%"}</span>
        </div>
        <table class="cdmg">
          <thead><tr><th></th>${mondays.map((w) =>
            `<th>${fromISO(w).getDate()}</th>`).join("")}</tr></thead>
          <tbody>
            <tr class="ovr"><th>Week</th>${mondays.map((w) => {
              const p = byWeek[w] ? scoreOf[w] : undefined;
              return p === undefined || p === null
                ? `<td class="none" title="${esc(w)} · no check-in"></td>`
                : `<td class="${band(p)}" data-week="${esc(w)}"
                     title="Week of ${esc(w)} · ${p}% overall">${p}</td>`;
            }).join("")}</tr>
            ${names.map((n, ci) => `<tr><th>${esc(n)}</th>${mondays.map((w) => {
              const cells = byWeek[w];
              if (!cells) return `<td class="none" title="${esc(w)} · no check-in"></td>`;
              const v = cells[ci];
              return v === null
                ? `<td class="skip" data-week="${esc(w)}" title="${esc(n)} · ${esc(w)} · not rated"></td>`
                : `<td class="${band(v)}" data-week="${esc(w)}"
                     title="${esc(n)} · week of ${esc(w)} · ${v}%"></td>`;
            }).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>`);
  }
  return `<div class="cdmons">${cards.join("")}</div>`;
}

const CAT_COLORS = ["#4FD1B5", "#E9B44C", "#9A8CF0", "#F0766B", "#5AA0FF", "#7ED992"];
const catColor = (i) => CAT_COLORS[i % CAT_COLORS.length];

// ── D. weekly reports ───────────────────────────────────
/** Reports grouped into month folders: the current month stays open as a
 *  plain list, earlier months collapse into folders you click to open. */
function dashReports(d) {
  const nowMonth = isoDate(new Date()).slice(0, 7);
  const months = [];
  d.reports.forEach((r, i) => {                     // reports arrive newest-first
    const m = r.weekOf.slice(0, 7);
    if (!months.length || months[months.length - 1].m !== m) months.push({ m, rows: [] });
    months[months.length - 1].rows.push({ r, i });
  });

  const c = S.checkin;
  const due = !ciLockedUntil() && (c.status === "due" || c.status === "overdue");
  const banner = due ? `
    <div class="cddue ${esc(c.status)}">
      <div class="ic">${c.status === "overdue" ? "!" : "●"}</div>
      <div class="b">
        <div class="t">This week's check-in is still ${c.status === "overdue" ? "overdue" : "due"}</div>
        <div class="s">${esc(c.statusNote)}</div>
      </div>
      <button class="btn-gold" id="cd-start">Start check-in</button>
    </div>` : "";

  return banner + months.map(({ m, rows }) => {
    const open = m === nowMonth;
    const scored = rows.map(({ r }) => r.pct).filter((p) => p !== null);
    const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
    const [y, mm] = m.split("-");
    return `
      <div class="cdfold ${open ? "open" : ""}" data-month="${esc(m)}">
        <div class="cdfoldh">
          <span class="ar">▸</span>
          <span class="ic">${open ? "📂" : "📁"}</span>
          <span class="nm">${MONTHS[Number(mm) - 1]} <em>${esc(y)}</em></span>
          <span class="ct">${rows.length} report${rows.length === 1 ? "" : "s"}</span>
          <span class="av ${band(avg)}">${avg === null ? "—" : avg + "%"}</span>
        </div>
        <div class="cdfoldb"${open ? "" : " hidden"}>
          ${rows.map(({ r, i }) => repCard(r, i)).join("")}
        </div>
      </div>`;
  }).join("");
}

const repCard = (r, i) => `
      <div class="cdrep" data-rep="${i}">
        <div class="cdreph">
          <div class="wk">${esc(shortWeek(r.weekOf))}<em>${esc(r.weekOf)}</em></div>
          <div class="sc ${band(r.pct)}">${r.pct === null ? "—" : r.pct + "%"}</div>
          <div class="mx"><span class="g">${r.good}</span><span class="m">${r.moderate}</span><span class="w">${r.needs}</span></div>
          <div class="sm">${r.wins.length} win${r.wins.length === 1 ? "" : "s"}${
            r.housekeeping.length ? ` · ${r.housekeeping.length} to-do${r.housekeeping.length === 1 ? "" : "s"}` : ""}</div>
          <span class="src ${r.source === "basecamp" ? "bc" : ""}">${r.source === "basecamp" ? "Basecamp" : "Sky Command"}</span>
          <span class="cdchev">›</span>
        </div>
        <div class="cdrepb" hidden>
          ${r.wins.length ? `<div class="cdrs"><h6>Biggest wins</h6><ul>${
            r.wins.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
          ${r.lessons ? `<div class="cdrs"><h6>Lessons learned</h6><p>${esc(r.lessons)}</p></div>` : ""}
          ${r.housekeeping.length ? `<div class="cdrs"><h6>Housekeeping</h6><ul>${
            r.housekeeping.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
          ${r.meetingPrep.length ? `<div class="cdrs"><h6>Meeting prep</h6><ul>${
            r.meetingPrep.map((p) => `<li>${esc(p.todo)} <em>— ${esc(p.event || "")} ${esc(p.dow || "")} ${esc(p.time || "")}</em></li>`).join("")}</ul></div>` : ""}
          <div class="cdrs"><h6>Ratings by area</h6>
            <div class="cdcats">${Object.entries(r.categories).map(([k, v]) => `
              <div class="cdcat"><div class="cdch"><span>${esc(k)}</span>
                <b class="${band(v)}">${v === null ? "—" : v + "%"}</b></div></div>`).join("")}</div>
          </div>
          ${Object.keys(r.legacy || {}).length ? `<div class="cdrs">
            <h6>Also recorded <em>(fields since retired from the form)</em></h6><ul>${
            Object.entries(r.legacy).map(([k, v]) =>
              `<li><em>${esc(k.replace(/([A-Z])/g, " $1").toLowerCase())}:</em> ${esc(v)}</li>`).join("")}</ul></div>` : ""}
          ${r.extras.unmappedRated.length ? `<div class="cdrs"><h6>Also rated that week
            <em>(historical items with no field in the current form)</em></h6><ul>${
            r.extras.unmappedRated.map((u) => `<li><span class="dotx ${
              u.value === "good" ? "good" : u.value === "moderate" ? "mid" : "low"}"></span>${esc(u.text)}</li>`).join("")}</ul></div>` : ""}
          ${r.extras.dayPlans.length ? `<div class="cdrs"><h6>Week plan as written</h6><ul>${
            r.extras.dayPlans.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
          ${r.sourceUrl ? `<a class="qc" href="${esc(r.sourceUrl)}" target="_blank"
            rel="noopener noreferrer">Open original in Basecamp ↗</a>` : ""}
        </div>
      </div>`;

// ── shared chart + tile helpers ─────────────────────────
const cdTile = (v, k, tone, sub) =>
  `<div class="cdtile"><div class="v ${tone || ""}">${esc(v)}</div>
    <div class="k">${esc(k)}</div>${sub ? `<div class="sb">${esc(sub)}</div>` : ""}</div>`;

/** Single-series area+line chart, plain SVG so there's no CDN dependency. */
function lineChart(points, maxY) {
  if (points.length < 2) return `<div class="ppempty">Needs at least two weeks.</div>`;
  const W = 760, H = 180, P = 26;
  const x = (i) => P + i * (W - P * 2) / (points.length - 1);
  const y = (v) => H - P - (v / maxY) * (H - P * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
  return `<div class="cdchart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Weekly score trajectory">
    ${[0, 25, 50, 75, 100].map((g) => `<line x1="${P}" x2="${W - P}" y1="${y(g)}" y2="${y(g)}"
      stroke="var(--line)" stroke-width="1"/>`).join("")}
    <path d="${line}L${x(points.length - 1)},${H - P}L${x(0)},${H - P}Z" fill="rgba(79,209,181,.10)"/>
    <path d="${line}" fill="none" stroke="var(--teal)" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="3.5" fill="var(--teal)">
      <title>${esc(p.x)} · ${p.y}%</title></circle>`).join("")}
  </svg></div>`;
}

function multiLineChart(series, allNames) {
  const live = series.filter((s) => s.points.length > 1);
  if (!live.length) return `<div class="ppempty">Toggle a category on to chart it.</div>`;
  const W = 760, H = 230, P = 26;
  const labels = [...new Set(live.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const x = (wk) => P + labels.indexOf(wk) * (W - P * 2) / Math.max(1, labels.length - 1);
  const y = (v) => H - P - (v / 100) * (H - P * 2);
  return `<div class="cdchart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Category trends over time">
    ${[0, 25, 50, 75, 100].map((g) => `<line x1="${P}" x2="${W - P}" y1="${y(g)}" y2="${y(g)}"
      stroke="var(--line)" stroke-width="1"/>`).join("")}
    ${live.map((s) => {
      const col = catColor(allNames.indexOf(s.name));
      const dpath = s.points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
      return `<path d="${dpath}" fill="none" stroke="${col}" stroke-width="2.2"
        stroke-linejoin="round" stroke-linecap="round" opacity="0.92"/>
        ${s.points.map((p) => `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="3" fill="${col}">
          <title>${esc(s.name)} · ${esc(p.x)} · ${p.y}%</title></circle>`).join("")}`;
    }).join("")}
  </svg></div>`;
}

// ── interactions ────────────────────────────────────────
function wireDashTab(d) {
  const body = el("cd-body");
  body.querySelectorAll("[data-range]").forEach((b) => {
    b.onclick = () => { DASH.range = b.dataset.range; renderDashTab(); };
  });
  body.querySelectorAll("[data-cat]").forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.cat;
      DASH.hidden.has(n) ? DASH.hidden.delete(n) : DASH.hidden.add(n);
      renderDashTab();
    };
  });
  body.querySelectorAll(".cdreph").forEach((h) => {
    h.onclick = () => {
      const panel = h.parentElement.querySelector(".cdrepb");
      panel.hidden = !panel.hidden;
      h.parentElement.classList.toggle("open", !panel.hidden);
    };
  });
  body.querySelectorAll(".cdfoldh").forEach((h) => {
    h.onclick = () => {
      const fold = h.parentElement;
      const panel = fold.querySelector(".cdfoldb");
      panel.hidden = !panel.hidden;
      fold.classList.toggle("open", !panel.hidden);
      h.querySelector(".ic").textContent = panel.hidden ? "📁" : "📂";
    };
  });
  const start = body.querySelector("#cd-start");
  if (start) start.onclick = () => { closeDashboard(); openCheckin(); };
  // a calendar cell jumps to that week's report
  body.querySelectorAll(".cdmg td[data-week]").forEach((td) => {
    td.onclick = () => openReport(td.dataset.week);
  });
  // "needs attention" jumps to the goal in its category block
  body.querySelectorAll(".cdneed[data-goal]").forEach((n) => {
    n.onclick = () => {
      const t = [...body.querySelectorAll(`.cdgoal[data-goal]`)]
        .find((g) => g.dataset.goal === n.dataset.goal && g !== n);
      if (!t) return;
      t.scrollIntoView({ behavior: "smooth", block: "center" });
      t.classList.add("flash");
      setTimeout(() => t.classList.remove("flash"), 1400);
    };
  });
}

function openReport(weekOf) {
  DASH.tab = "reports";
  renderDashShell();
  const d = S.checkin.dashboard;
  const i = d.reports.findIndex((r) => r.weekOf === weekOf);
  if (i < 0) return;
  const card = el("cd-body").querySelector(`.cdrep[data-rep="${i}"]`);
  if (!card) return;
  const fold = card.closest(".cdfold");        // the month may be collapsed
  if (fold && !fold.classList.contains("open")) {
    fold.querySelector(".cdfoldb").hidden = false;
    fold.classList.add("open");
    fold.querySelector(".cdfoldh .ic").textContent = "📂";
  }
  card.querySelector(".cdrepb").hidden = false;
  card.classList.add("open");
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function initCheckin() {
  el("ci-close").onclick = closeCheckin;
  el("ci-save").onclick = saveCheckin;
  el("cd-close").onclick = closeDashboard;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (el("cd-overlay").classList.contains("show")) closeDashboard();
    else if (el("ci-overlay").classList.contains("show")) closeCheckin();
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

// ── Chloe's Executive Priorities ────────────────────────
// Ranked by the publisher (sky_priorities.py) from real feeds; nothing here
// calls a model. Status changes file through the same encrypted repo path as
// check-ins. They show immediately through a local overlay, which clears once
// the publisher reports the action as applied.
const PR = { view: "today", open: null, showAll: false, notes: {}, flash: null };
const PR_VIEW_KEY = "skycmd_prio_view_v1";
const PR_OVERLAY_KEY = "skycmd_prio_overlay_v1";
const PR_SHOW = 5;
const PR_OVERLAY_MAX_MS = 48 * 3600 * 1000;
const PR_WORDS = ["", "one thing", "two things", "three things", "four things", "five things"];
const PR_KIND = {
  now: { label: "Act now", cls: "now" },
  strategic: { label: "Strategic", cls: "strategic" },
  delegate: { label: "Delegable", cls: "delegate" },
};
const PR_STATUS = {
  new: "New", updated: "Updated", in_progress: "In progress", reviewed: "Reviewed",
};

function prOverlay() {
  try { return JSON.parse(localStorage.getItem(PR_OVERLAY_KEY)) || {}; } catch { return {}; }
}
function prSaveOverlay(o) {
  try { localStorage.setItem(PR_OVERLAY_KEY, JSON.stringify(o)); } catch { /* private mode */ }
}

/** Newest local action per priority that the publisher hasn't applied yet. */
function prPending() {
  const applied = new Set((S.priorities && S.priorities.appliedActions) || []);
  const o = prOverlay();
  const now = Date.now();
  let changed = false;
  for (const [k, a] of Object.entries(o)) {
    if (applied.has(k) || now - Date.parse(a.at) > PR_OVERLAY_MAX_MS) { delete o[k]; changed = true; }
  }
  if (changed) prSaveOverlay(o);
  const latest = {};
  for (const [actionId, a] of Object.entries(o)) {
    if (!latest[a.id] || a.at > latest[a.id].at) latest[a.id] = { ...a, actionId };
  }
  return latest;
}

function prApply(c, pend) {
  const a = pend[c.id];
  if (!a) return c;
  if (a.action === "snooze") return Date.parse(a.until) > Date.now() ? null : c;
  // reopen restores what the publisher said, unless that was the state being undone
  const status = a.action === "reopen"
    ? (["reviewed", "in_progress"].includes(c.status) ? "attention" : c.status)
    : { reviewed: "reviewed", in_progress: "in_progress" }[a.action];
  return { ...c, status, local: true };
}

function prHeadline(items, span) {
  if (!items.length) return `Nothing on the board needs you ${span}. Enjoy the room.`;
  const n = Math.min(PR_SHOW, items.filter((c) => c.status !== "reviewed").length);
  if (!n) return `You’ve reviewed everything I flagged ${span}.`;
  return `Skyler, here ${n === 1 ? "is" : "are"} the ${PR_WORDS[n]} I think deserve your attention ${span}.`;
}

const prTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const prDay = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const prWhen = (iso) => new Date(iso).toLocaleString("en-US",
  { weekday: "short", hour: "numeric", minute: "2-digit" });

function prHistory(c) {
  const bits = [];
  if (c.firstSeen) bits.push(`First flagged ${prDay(c.firstSeen)}`);
  const verbs = { reviewed: "Reviewed", in_progress: "Marked in progress", snooze: "Snoozed",
                  reopen: "Reopened", "snooze ended": "Back from snooze", "came back": "Came back" };
  (c.history || []).forEach((h) => { if (verbs[h.action]) bits.push(`${verbs[h.action]} ${prDay(h.at)}`); });
  return bits.join(" · ");
}

function prCard(c, i) {
  const kind = PR_KIND[c.kind] || PR_KIND.now;
  const open = PR.open === c.id;
  const bodyId = `pr-body-${i}`;
  const status = PR_STATUS[c.status];
  const note = PR.notes[c.id] || (c.local ? (devMode ? "Dev mode: saved on this device only."
    : "Saved. The board confirms it on its next refresh.") : c.statusNote);
  const chips = [
    ...(c.sources || []).map((s) => `<span class="prchip">${esc(s)}</span>`),
    c.deadlineLabel ? `<span class="prchip due">${esc(c.deadlineLabel)}</span>` : "",
    status ? `<span class="prchip st-${esc(c.status)}">${status}</span>` : "",
  ].join("");

  let take = "";
  if (c.agentId) {
    take = `<button type="button" class="prbtn primary" data-act="agent">${esc(c.link ? c.link.label : "Open agent")}</button>`;
  } else if (c.link && /^https:\/\//.test(c.link.url || "")) {
    take = `<a class="prbtn primary" href="${esc(c.link.url)}" target="_blank" rel="noopener">${esc(c.link.label)} ↗</a>`;
  }
  const reviewed = c.status === "reviewed";
  const working = c.status === "in_progress";

  return `
    <li class="prcard k-${kind.cls} s-${esc(c.status || "attention")}${open ? " open" : ""}" data-id="${esc(c.id)}">
      <button type="button" class="prhead" aria-expanded="${open}" aria-controls="${bodyId}">
        <span class="prrank mono">${String(i + 1).padStart(2, "0")}</span>
        <span class="prmain">
          <span class="prtitle">${esc(c.title)}</span>
          <span class="prwhy">${esc(c.why)}</span>
          <span class="prnext"><b>Chloe recommends</b> ${esc(c.action)}</span>
          <span class="prchips">${chips}</span>
        </span>
        <span class="prdot" title="${kind.label}"><span class="sr-only">${kind.label}</span></span>
      </button>
      <div class="prbody" id="${bodyId}"${open ? "" : " hidden"}>
        ${(c.details && c.details.length) ? `
          <div class="prsub">What’s behind it</div>
          <ul class="prdetails">${c.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
        <div class="prhist">${esc(prHistory(c))}</div>
        <div class="practs">
          ${take}
          <button type="button" class="prbtn" data-act="${reviewed ? "reopen" : "reviewed"}">${reviewed ? "Undo reviewed" : "Mark reviewed"}</button>
          <button type="button" class="prbtn" data-act="${working ? "reopen" : "in_progress"}">${working ? "Not started" : "I’m on it"}</button>
          <details class="prsnooze">
            <summary class="prbtn">Remind me later</summary>
            <div class="prsnoozemenu">
              <button type="button" class="prbtn" data-act="snooze" data-when="tomorrow">Tomorrow, 8 AM</button>
              <button type="button" class="prbtn" data-act="snooze" data-when="3d">In 3 days</button>
              <button type="button" class="prbtn" data-act="snooze" data-when="monday">Next Monday</button>
            </div>
          </details>
        </div>
        ${note ? `<div class="prnote" role="status">${esc(note)}</div>` : ""}
      </div>
    </li>`;
}

function prSnoozeUntil(when) {
  const d = new Date();
  if (when === "3d") { d.setDate(d.getDate() + 3); d.setHours(8, 0, 0, 0); return d; }
  if (when === "monday") { d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); d.setHours(8, 0, 0, 0); return d; }
  d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
  return d;
}

/** Wins band: only what the publisher could prove. Hidden when a window has none. */
function renderWins() {
  const box = el("pr-wins");
  const all = S.priorities && S.priorities.wins;
  const W = all && all[PR.view];
  if (!W || !W.items || !W.items.length) { box.hidden = true; box.innerHTML = ""; return; }
  const kicker = PR.view === "today" ? "Wins today" : "Wins · past 7 days";
  const rows = W.items.map((w) => {
    const head = `<span class="prwmark" aria-hidden="true">✓</span>
      <span class="prwt">${esc(w.title)}</span>${w.detail ? `<span class="prwd">${esc(w.detail)}</span>` : ""}`;
    return (w.details && w.details.length)
      ? `<li class="prw k-${esc(w.kind)}"><details><summary>${head}<span class="prwmore">${
          w.kind === "tasks" ? "see what" : "see more"}</span></summary>
          <ul class="prwsub">${w.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></details></li>`
      : `<li class="prw k-${esc(w.kind)}"><div class="prwrow">${head}</div></li>`;
  }).join("");
  const conv = W.items.some((w) => ["client", "accepted", "proposal"].includes(w.kind));
  const since = all.crmSince && Date.now() - Date.parse(all.crmSince) < 30 * 864e5
    ? `<p class="prwnote">New clients and sent proposals are counted as they change in the CRM, tracking since ${esc(prDay(all.crmSince + "T12:00:00"))}.</p>` : "";
  box.innerHTML = `<div class="prwk">${kicker}</div>
    <p class="prwh">${esc(W.headline)}</p>
    <ul class="prwl">${rows}</ul>${conv ? "" : since}`;
  box.hidden = false;
}

function renderPriorities() {
  const P = S.priorities;
  document.querySelectorAll(".prtab").forEach((t) => {
    const on = t.dataset.view === PR.view;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  if (!P || P.error) {
    el("pr-headline").textContent = P ? "Priorities couldn’t be ranked this cycle."
      : "Priorities appear after the next publish.";
    el("pr-insight").textContent = P ? "The rest of the board is current. The next refresh retries." : "";
    el("pr-meta").textContent = "";
    el("pr-wins").hidden = true;
    el("pr-list").innerHTML = "";
    el("pr-foot").innerHTML = "";
    return;
  }

  const pend = prPending();
  const span = PR.view === "today" ? "today" : "this week";
  const items = (P[PR.view] || []).map((c) => prApply(c, pend)).filter(Boolean)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.status === "reviewed") - (b.c.status === "reviewed") || a.i - b.i)
    .map((x) => x.c);
  const shown = PR.showAll ? items : items.slice(0, PR_SHOW);

  el("pr-headline").textContent = prHeadline(items, span);
  el("pr-insight").textContent = PR.view === "week" ? (P.insight || "") : "";
  el("pr-insight").hidden = !(PR.view === "week" && P.insight);
  renderWins();

  const srcs = P.sources || [];
  const down = srcs.filter((s) => !s.fresh);
  el("pr-meta").innerHTML =
    `<span>Refreshed ${esc(prTime(P.generatedAt))}</span>` +
    `<span title="${esc(srcs.map((s) => `${s.name}: ${s.note}`).join("\n"))}">` +
    `${srcs.length - down.length} of ${srcs.length} sources live</span>` +
    down.map((s) => `<span class="warn">${esc(s.name)} ${esc(s.note)}</span>`).join("") +
    (((P.wins && P.wins.missing) || []).map((m) => `<span class="warn">Wins: ${esc(m)} unavailable</span>`).join("")) +
    (PR.flash ? `<span class="prflash" role="status">${esc(PR.flash.text)}
      <button type="button" class="prlink" id="pr-undo">Undo</button></span>` : "");

  el("pr-list").innerHTML = shown.map(prCard).join("");

  const foot = [];
  if (items.length > PR_SHOW) {
    foot.push(`<button type="button" class="prmore" id="pr-more">${PR.showAll
      ? "Show top five only" : `Show ${items.length - PR_SHOW} more`}</button>`);
  }
  if (PR.view === "week" && P.weekExcludedFromToday) {
    foot.push(`<span>${P.weekExcludedFromToday} of today’s priorities aren’t repeated here.</span>`);
  }
  const snoozed = (P.snoozed || []).filter((s) => !(pend[s.id] && pend[s.id].action === "reopen"));
  Object.values(pend).forEach((a) => {
    if (a.action === "snooze" && Date.parse(a.until) > Date.now() && !snoozed.some((s) => s.id === a.id)) {
      snoozed.push({ id: a.id, title: a.title, until: a.until });
    }
  });
  if (snoozed.length) {
    foot.push(`<details class="prfold"><summary>${snoozed.length} snoozed</summary><ul>${
      snoozed.map((s) => `<li>${esc(s.title)} <span class="dim">until ${esc(prWhen(s.until))}</span>
        <button type="button" class="prlink" data-wake="${esc(s.id)}" data-title="${esc(s.title)}">Bring back</button></li>`).join("")
    }</ul></details>`);
  }
  if ((P.resolved || []).length) {
    foot.push(`<details class="prfold"><summary>${P.resolved.length} resolved recently</summary><ul>${
      P.resolved.map((r) => `<li>✓ ${esc(r.title)} <span class="dim">${esc(prDay(r.at))}</span></li>`).join("")
    }</ul></details>`);
  }
  foot.push(`<span class="prlegend"><i class="now"></i>Act now<i class="strategic"></i>Strategic<i class="delegate"></i>Delegable</span>`);
  el("pr-foot").innerHTML = foot.join("");
}

/** File a status change: local overlay first, then the encrypted repo commit. */
async function prAct(c, action, until) {
  const a = {
    actionId: crypto.randomUUID(), id: c.id, title: c.title, action,
    at: new Date().toISOString(), ...(until ? { until: until.toISOString() } : {}),
  };
  const o = prOverlay();
  o[a.actionId] = a;
  prSaveOverlay(o);
  delete PR.notes[c.id];
  if (action === "snooze" && PR.open === c.id) PR.open = null;
  const said = { reviewed: "Marked reviewed", snooze: "Snoozed", in_progress: "Marked in progress" }[action];
  clearTimeout(PR.flashTimer);
  PR.flash = said ? { text: `${said}: ${c.title.length > 60 ? c.title.slice(0, 58) + "…" : c.title}`, item: c } : null;
  if (PR.flash) PR.flashTimer = setTimeout(() => { PR.flash = null; renderPriorities(); }, 9000);
  renderPriorities();

  if (devMode) return;
  const fail = (msg) => {
    const cur = prOverlay();
    delete cur[a.actionId];
    prSaveOverlay(cur);
    PR.notes[c.id] = msg;
    PR.open = c.id;
    renderPriorities();
  };
  if (!S.chat || !S.chat.ghToken || !S.chat.ghRepo) {
    fail("Couldn’t save: this state has no repo credentials.");
    return;
  }
  try {
    const enc = await encryptForRepo(a);
    const r = await fetch(
      `https://api.github.com/repos/${S.chat.ghRepo}/contents/priorities/pending/${Date.now()}_${a.actionId}.json.enc`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + S.chat.ghToken, Accept: "application/vnd.github+json" },
        body: JSON.stringify({
          message: `priority: ${action} ${c.id}`,
          content: btoa(unescape(encodeURIComponent(enc))),
        }),
      });
    if (!r.ok) throw new Error("GitHub " + r.status);
  } catch (e) {
    fail(`Couldn’t save (${e.message}). Nothing changed. Try again.`);
  }
}

function initPriorities() {
  try {
    const v = localStorage.getItem(PR_VIEW_KEY);
    if (v === "today" || v === "week") PR.view = v;
  } catch { /* private mode */ }

  document.querySelectorAll(".prtab").forEach((t) => {
    t.onclick = () => {
      PR.view = t.dataset.view;
      PR.showAll = false;
      try { localStorage.setItem(PR_VIEW_KEY, PR.view); } catch { /* private mode */ }
      renderPriorities();
    };
  });

  el("pr-list").addEventListener("click", (e) => {
    const li = e.target.closest(".prcard");
    if (!li) return;
    const P = S.priorities || {};
    const c = (P[PR.view] || []).find((x) => x.id === li.dataset.id);
    if (!c) return;
    if (e.target.closest(".prhead")) {
      PR.open = PR.open === c.id ? null : c.id;
      renderPriorities();
      const head = el("pr-list").querySelector(`.prcard[data-id="${CSS.escape(c.id)}"] .prhead`);
      if (head) head.focus();
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "agent") {
      const a = (S.agents || []).find((x) => x.id === c.agentId);
      if (a) openAgentDrawer(a);
      return;
    }
    prAct(c, act, act === "snooze" ? prSnoozeUntil(btn.dataset.when) : null);
  });

  el("pr-meta").addEventListener("click", (e) => {
    if (e.target.id !== "pr-undo" || !PR.flash) return;
    const c = PR.flash.item;
    PR.flash = null;
    prAct(c, "reopen");
  });

  el("pr-foot").addEventListener("click", (e) => {
    if (e.target.id === "pr-more") {
      PR.showAll = !PR.showAll;
      renderPriorities();
      return;
    }
    const wake = e.target.closest("[data-wake]");
    if (wake) prAct({ id: wake.dataset.wake, title: wake.dataset.title }, "reopen");
  });
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
    const top = S.priorities && (S.priorities.today || [])[0];
    if (top) lines.push("PRIORITY · " + top.title.slice(0, 44).toUpperCase());
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
  renderPriorities();
  renderBriefing();
  renderFinance();
  renderAgents();
  renderCheckin();
  renderConnections();

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
  initPriorities();
  el("bf-close").onclick = () => el("bf-overlay").classList.remove("show");
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
