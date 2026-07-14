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
  const hasHtml = !!(b.html && b.html.length > 500);
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
          : h.tone === "attention" ? "var(--coral)" : "var(--ink)";
        return `<div class="h"><span class="k">${esc(h.k)}</span>
          <span class="v" style="color:${color}">${esc(h.v)}</span></div>`;
      }).join("")}
    </div>
    <div class="feeds">
      ${b.feeds.map((f) => `
        <span class="feed ${f.fresh ? "live" : "stale"}"><span class="fd"></span>${esc(f.name)}${f.fresh ? "" : " · stale"}</span>
      `).join("")}
    </div>
    ${hasHtml ? `
      <div class="bfpreview">
        <iframe id="bf-mini" sandbox="allow-same-origin" title="Briefing preview"></iframe>
        <button class="qc bfexpand" id="bf-open">⤢ Open full briefing</button>
      </div>` : ""}`;
  if (hasHtml) {
    el("bf-mini").srcdoc = b.html;
    el("bf-open").onclick = () => {
      el("bf-frame").srcdoc = b.html;
      el("bf-overlay").classList.add("show");
    };
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
function bfTile(cls, label, chip, num, sub) {
  return `<div class="bftile ${cls}">
    <div class="bfrow"><span class="bflabel">${esc(label)}</span>
      <span class="bfchip">${chip}</span></div>
    <div class="bfnum">${num}</div>
    <div class="bfsub">${sub ? esc(sub) : ""}</div>
  </div>`;
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
      <span class="bftitle">Billing Buddy — ${esc(b.month || "this month")}</span>
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

function renderAgents() {
  const alerts = S.agents.filter((a) => a.status === "alert").length;
  el("agents-status").innerHTML = alerts
    ? `<span class="dot warn"></span>${alerts} FLAG${alerts === 1 ? "" : "S"}`
    : `<span class="dot ok"></span>ALL NOMINAL`;
  el("agentsgrid").innerHTML = S.agents.map((a, i) => `
    <div class="agent ${a.status === "alert" ? "alert" : ""}">
      <div class="ahead">
        <span class="dot ${a.status === "alert" ? "warn" : "ok"}"></span>
        <span class="aname">${esc(a.name)}</span>
        <span class="aled">${a.status === "alert" ? "CHECK" : "LIVE"}</span>
      </div>
      <div class="adesc">${esc(a.desc)}</div>
      ${barcode(i * 97 + 13)}
      <div class="ameta"><span>${esc(a.schedule)}</span><b>NEXT ${esc(a.nextRun.toUpperCase())}</b></div>
      <div class="anote">${esc(a.note)}</div>
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
        <div class="gc">${esc(n)}<div class="gbar"><div></div></div></div>`).join("")}
    </div>
    <div class="bootline">initializing weekly ritual … ${c.progressPct}% built<span class="cursor">▊</span></div>`;
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
  div.innerHTML =
    `<div class="who">${who === "chloe" ? "Chloe" : "Sky"}</div>${esc(text)}`;
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
  renderBriefing();
  renderFocus();
  renderFinance();
  renderAgents();
  renderCheckin();
  renderConnections();
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
    } catch { /* offline — keep last state */ }
  }, POLL_MS);
}

boot();
