/**
 * EMS Apply — Server
 *
 * ═══════════════════════════════════════════════════════════════
 *  SETUP CHECKLIST
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. REQUIRED ENV VARS — set these before starting:
 *
 *       DISCORD_WEBHOOK   = https://discord.com/api/webhooks/ID/TOKEN
 *       ADMIN_PASSWORD    = choose_a_strong_password
 *
 *     Optional:
 *       PORT              = 3000  (default)
 *       DATA_FILE         = ./applications.json  (default)
 *
 *     Using a .env file? Uncomment require('dotenv').config() below
 *     and run: npm install dotenv
 *
 *  2. FILE STRUCTURE
 *       project/
 *         server.js
 *         public/
 *           index.html
 *         applications.json   ← auto-created on first submission
 *         package.json
 *
 *  3. INSTALL & RUN
 *       npm install express
 *       node server.js
 *
 *  4. ADMIN DASHBOARD
 *       http://localhost:3000/admin
 *       Password = value of ADMIN_PASSWORD env var
 *       Features:
 *         - View all applications
 *         - Search by name / Discord ID / ref code
 *         - Filter by status (pending / approved / rejected)
 *         - Change application status
 *         - Delete applications
 *         - Export as JSON
 *
 * ═══════════════════════════════════════════════════════════════
 */

// require('dotenv').config();

const express  = require("express");
const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");

const app  = express();
const PORT = process.env.PORT      || 3000;
const DATA = process.env.DATA_FILE || "./applications.json";

// ── Fetch polyfill (Node < 18) ────────────────────────────────
let apiFetch;
(async () => {
  if (typeof globalThis.fetch === "function") {
    apiFetch = globalThis.fetch.bind(globalThis);
    console.log(`✅  Built-in fetch (Node ${process.version})`);
  } else {
    try {
      const nf = await import("node-fetch");
      apiFetch = nf.default;
      console.log(`ℹ️   node-fetch polyfill`);
    } catch {
      console.error("❌  No fetch. Run: npm install node-fetch@2  OR use Node 18+");
      process.exit(1);
    }
  }
})();

// ── Env checks ────────────────────────────────────────────────
const WEBHOOK        = process.env.DISCORD_WEBHOOK;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!WEBHOOK) {
  console.error("❌  DISCORD_WEBHOOK not set.");
  process.exit(1);
}
console.log(`✅  Webhook: ${WEBHOOK.slice(0, 45)}…`);
console.log(`✅  Admin dashboard: http://localhost:${PORT}/admin`);

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ══════════════════════════════════════════════════════════════
//  JSON STORAGE
// ══════════════════════════════════════════════════════════════

function loadApps() {
  try {
    if (!fs.existsSync(DATA)) return [];
    return JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch {
    console.error("[storage] Failed to read applications.json — returning empty list");
    return [];
  }
}

function saveApps(apps) {
  try {
    fs.writeFileSync(DATA, JSON.stringify(apps, null, 2), "utf8");
  } catch (err) {
    console.error("[storage] Failed to write applications.json:", err.message);
    throw err;
  }
}

function appendApp(entry) {
  const apps = loadApps();
  apps.push(entry);
  saveApps(apps);
  return apps.length; // total count
}

// ══════════════════════════════════════════════════════════════
//  SPAM PROTECTION — Multi-layer
// ══════════════════════════════════════════════════════════════

// Layer 1 — IP rate limit  (2 per 10 min)
const IP_WINDOW   = 10 * 60 * 1000;
const IP_MAX      = 2;
const ipBuckets   = new Map();

// Layer 2 — Discord ID rate limit  (1 per 30 min per Discord ID)
const DID_WINDOW  = 30 * 60 * 1000;
const DID_MAX     = 1;
const didBuckets  = new Map();

// Layer 3 — Global burst guard  (max 20 submissions per minute total)
const BURST_WINDOW = 60 * 1000;
const BURST_MAX    = 20;
const burstLog     = [];

// Layer 4 — Duplicate guard  (same Discord ID already has a PENDING app)
function hasPendingApp(discordId) {
  return loadApps().some(
    a => a.discordUser === discordId && a.status === "pending"
  );
}

function checkRateLimit(ip, discordId) {
  const now = Date.now();

  // Layer 1: IP
  const ipHits = (ipBuckets.get(ip) || []).filter(t => now - t < IP_WINDOW);
  if (ipHits.length >= IP_MAX) return { blocked: true, reason: "ip", retryAfter: Math.ceil((IP_WINDOW - (now - ipHits[0])) / 1000 / 60) };
  ipHits.push(now);
  ipBuckets.set(ip, ipHits);

  // Layer 2: Discord ID
  const didHits = (didBuckets.get(discordId) || []).filter(t => now - t < DID_WINDOW);
  if (didHits.length >= DID_MAX) return { blocked: true, reason: "discord_id", retryAfter: Math.ceil((DID_WINDOW - (now - didHits[0])) / 1000 / 60) };
  didHits.push(now);
  didBuckets.set(discordId, didHits);

  // Layer 3: Global burst
  const recent = burstLog.filter(t => now - t < BURST_WINDOW);
  if (recent.length >= BURST_MAX) return { blocked: true, reason: "burst", retryAfter: 1 };
  recent.push(now);
  burstLog.length = 0; burstLog.push(...recent);

  return { blocked: false };
}

// Prune stale rate-limit entries every 15 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets)  { const f = v.filter(t => now - t < IP_WINDOW);  f.length ? ipBuckets.set(k, f)  : ipBuckets.delete(k); }
  for (const [k, v] of didBuckets) { const f = v.filter(t => now - t < DID_WINDOW); f.length ? didBuckets.set(k, f) : didBuckets.delete(k); }
}, 15 * 60 * 1000);

// ── Sanitisation ──────────────────────────────────────────────
function safe(s = "", maxLen = 1024) {
  return String(s)
    .replace(/`/g, "'")
    .replace(/@(everyone|here|&)/gi, "@\u200b$1")
    .replace(/@/g, "@\u200b")
    .trim()
    .slice(0, maxLen) || "—";
}

// ── Validation ────────────────────────────────────────────────
const VALID_MCQ = new Set(["A", "B", "C", "D"]);
const MCQ_KEYS  = ["q1", "q2", "q3", "q4", "q5"];
const OPEN_KEYS = ["q6", "q7", "q8", "q9", "q10"];

function validate(body) {
  const errors = [];
  if (!body.fullName?.trim())    errors.push("fullName required");
  if (!body.discordUser?.trim()) errors.push("discordUser required");
  if (!/^\d{17,19}$/.test(body.discordUser?.trim() || "")) errors.push("discordUser invalid");
  for (const k of MCQ_KEYS)  if (!VALID_MCQ.has(body.mcq?.[k])) errors.push(`MCQ ${k} invalid`);
  for (const k of OPEN_KEYS) if (!body.open?.[k]?.trim())       errors.push(`Q${k.slice(1)} empty`);
  const score = Number(body.mcqScore ?? -1);
  if (!Number.isInteger(score) || score < 0 || score > 5) errors.push("mcqScore invalid");
  return errors;
}

// ── MCQ data ──────────────────────────────────────────────────
const MCQ_QUESTIONS = {
  q1: { text: "Main role of EMS in RP?",                opts: { A:"Fight gangs", B:"Save lives & treat injured", C:"Investigate cases", D:"Arrest criminals" } },
  q2: { text: "Found unconscious on the ground?",       opts: { A:"Take a picture", B:"Ask what happened", C:"Secure scene & check breathing", D:"Call police" } },
  q3: { text: "EMS allowed to use weapons?",            opts: { A:"Yes, always", B:"No — strictly medical", C:"Only during wars", D:"With captain approval" } },
  q4: { text: "Medical helicopter can be used by?",     opts: { A:"Any EMS", B:"Flight exam + admin approval", C:"High ranks only", D:"Experienced EMS" } },
  q5: { text: "During an active shootout, EMS should?", opts: { A:"Enter immediately", B:"Wait for police clearance", C:"Leave the area", D:"Call the gang" } },
};
const CORRECT = { q1:"B", q2:"C", q3:"B", q4:"B", q5:"B" };
const OPEN_QUESTIONS = {
  q6:  "Explain Medical RP and why EMS must respect it",
  q7:  "Someone declared dead — what do you do?",
  q8:  "Patient insulting or breaking RP — how do you handle it?",
  q9:  "Car crash triage — who do you treat first?",
  q10: "Patient runs and fights after treatment — what do you do?",
};

// ── Discord embed ─────────────────────────────────────────────
function buildEmbed(p, score, refCode) {
  const color = score === 5 ? 0x10b981 : score >= 3 ? 0xf59e0b : 0xe8304a;
  return {
    embeds: [{
      title:     "🚑  New EMS Application",
      color,
      timestamp: new Date().toISOString(),
      footer:    { text: `REF: ${refCode}  •  EMS Apply` },
      fields: [
        { name: "👤 RP Name",    value: safe(p.fullName, 100),    inline: true },
        { name: "💬 Discord ID", value: safe(p.discordUser, 100), inline: true },
        { name: "🧠 MCQ Score",  value: `**${score} / 5**`,       inline: true },
        { name: "🔖 Ref Code",   value: `\`${refCode}\``,         inline: true },
        { name: "\u200b", value: "**── Multiple Choice ──**", inline: false },
        ...MCQ_KEYS.map(k => {
          const chosen  = p.mcq[k];
          const isRight = chosen === CORRECT[k];
          return { name: `${isRight?"✅":"❌"} Q${k.slice(1)}) ${MCQ_QUESTIONS[k].text}`, value: `**${chosen})** ${safe(MCQ_QUESTIONS[k].opts[chosen]??chosen,200)}`, inline:false };
        }),
        { name: "\u200b", value: "**── Open Questions ──**", inline: false },
        ...OPEN_KEYS.map(k => ({ name: OPEN_QUESTIONS[k], value: safe(p.open[k], 1024), inline: false })),
      ],
    }],
  };
}

async function postToDiscord(payload) {
  if (!apiFetch) throw new Error("fetch not ready yet");
  const res  = await apiFetch(WEBHOOK, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}: ${text.slice(0,150)}`);
}

// ── Ref code generator ────────────────────────────────────────
function genRef() {
  return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ══════════════════════════════════════════════════════════════
//  ROUTES — Public
// ══════════════════════════════════════════════════════════════

app.post("/submit", async (req, res) => {
  const ip        = req.headers["x-forwarded-for"]?.split(",")[0].trim() ?? req.socket.remoteAddress;
  const discordId = req.body?.discordUser?.trim() ?? "";

  // Spam protection
  const limit = checkRateLimit(ip, discordId);
  if (limit.blocked) {
    const msgs = {
      ip:         `Too many submissions from your network. Try again in ~${limit.retryAfter} minute(s).`,
      discord_id: `This Discord ID already submitted recently. Try again in ~${limit.retryAfter} minute(s).`,
      burst:      "Server is receiving too many requests. Please wait a moment.",
    };
    console.warn(`[spam] Blocked — reason:${limit.reason} ip:${ip} did:${discordId}`);
    return res.status(429).json({ error: msgs[limit.reason] || "Too many requests." });
  }

  // Duplicate pending check
  if (hasPendingApp(discordId)) {
    console.warn(`[duplicate] ${discordId} already has a pending application`);
    return res.status(409).json({ error: "You already have a pending application. Please wait for a decision before reapplying." });
  }

  // Validate
  const errors = validate(req.body);
  if (errors.length) {
    console.warn("[validation]", errors);
    return res.status(400).json({ error: "Validation failed", details: errors });
  }

  const p       = req.body;
  const score   = MCQ_KEYS.filter(k => p.mcq[k] === CORRECT[k]).length;
  const refCode = genRef();
  const now     = new Date().toISOString();

  // Build storage entry
  const entry = {
    ref:         refCode,
    status:      "pending",       // pending | approved | rejected
    submittedAt: now,
    ip,
    fullName:    safe(p.fullName, 100),
    discordUser: safe(p.discordUser, 100),
    mcqScore:    score,
    mcq:         Object.fromEntries(MCQ_KEYS.map(k => [k, p.mcq[k]])),
    open:        Object.fromEntries(OPEN_KEYS.map(k => [k, safe(p.open[k], 2000)])),
    notes:       "",              // admin notes field
  };

  try {
    // 1. Save to JSON
    const total = appendApp(entry);
    console.log(`[submit] #${total} "${entry.fullName}" (${entry.discordUser}) score:${score}/5 ref:${refCode} ip:${ip}`);

    // 2. Send to Discord (non-blocking — don't fail submission if Discord is down)
    postToDiscord(buildEmbed(p, score, refCode)).catch(err => {
      console.error("[discord] Webhook failed (submission saved locally):", err.message);
    });

    res.json({ ok: true, ref: refCode });
  } catch (err) {
    console.error("[submit] Storage error:", err.message);
    res.status(500).json({ error: "Failed to save application. Please try again." });
  }
});

// ══════════════════════════════════════════════════════════════
//  ADMIN AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════

// Simple session store — token → expiry
const adminSessions = new Map();

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  const session = adminSessions.get(token);
  if (!session || Date.now() > session.expiry) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

// POST /admin/login
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  const correct = (process.env.ADMIN_PASSWORD || "1234").trim();
  if (!password || password.trim() !== correct) {
    console.warn("[admin] Wrong password attempt");
    return res.status(401).json({ error: "Wrong password" });
  }
  const token  = crypto.randomBytes(24).toString("hex");
  const expiry = Date.now() + 4 * 60 * 60 * 1000; // 4 hours
  adminSessions.set(token, { expiry });
  console.log("[admin] Login successful");
  res.json({ ok: true, token, expiresIn: "4h" });
});

// Prune expired admin sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of adminSessions) if (now > s.expiry) adminSessions.delete(t);
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  ADMIN API
// ══════════════════════════════════════════════════════════════

// GET /admin/api/apps?search=X&status=pending&page=1&limit=20
app.get("/admin/api/apps", requireAdmin, (req, res) => {
  let apps = loadApps();

  const { search = "", status = "", page = "1", limit = "20" } = req.query;

  if (status) apps = apps.filter(a => a.status === status);
  if (search) {
    const q = search.toLowerCase();
    apps = apps.filter(a =>
      a.fullName.toLowerCase().includes(q)    ||
      a.discordUser.toLowerCase().includes(q) ||
      a.ref.toLowerCase().includes(q)
    );
  }

  // Sort newest first
  apps = [...apps].reverse();

  const total    = apps.length;
  const pageNum  = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
  const start    = (pageNum - 1) * pageSize;
  const items    = apps.slice(start, start + pageSize);

  res.json({ total, page: pageNum, pageSize, items });
});

// GET /admin/api/apps/:ref — single application
app.get("/admin/api/apps/:ref", requireAdmin, (req, res) => {
  const app_ = loadApps().find(a => a.ref === req.params.ref);
  if (!app_) return res.status(404).json({ error: "Not found" });
  res.json(app_);
});

// PATCH /admin/api/apps/:ref — update status or notes
app.patch("/admin/api/apps/:ref", requireAdmin, (req, res) => {
  const apps = loadApps();
  const idx  = apps.findIndex(a => a.ref === req.params.ref);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const { status, notes } = req.body;
  if (status && !["pending","approved","rejected"].includes(status))
    return res.status(400).json({ error: "Invalid status" });

  if (status !== undefined) apps[idx].status = status;
  if (notes  !== undefined) apps[idx].notes  = safe(notes, 500);
  apps[idx].updatedAt = new Date().toISOString();

  saveApps(apps);
  console.log(`[admin] Updated ${req.params.ref} → status:${apps[idx].status}`);
  res.json({ ok: true, app: apps[idx] });
});

// DELETE /admin/api/apps/:ref
app.delete("/admin/api/apps/:ref", requireAdmin, (req, res) => {
  const apps    = loadApps();
  const filtered = apps.filter(a => a.ref !== req.params.ref);
  if (filtered.length === apps.length) return res.status(404).json({ error: "Not found" });
  saveApps(filtered);
  console.log(`[admin] Deleted ${req.params.ref}`);
  res.json({ ok: true });
});

// GET /admin/api/export — download full JSON
app.get("/admin/api/export", requireAdmin, (req, res) => {
  const apps = loadApps();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="ems-applications-${Date.now()}.json"`);
  res.send(JSON.stringify(apps, null, 2));
});

// GET /admin/api/stats
app.get("/admin/api/stats", requireAdmin, (req, res) => {
  const apps    = loadApps();
  const total   = apps.length;
  const pending  = apps.filter(a => a.status === "pending").length;
  const approved = apps.filter(a => a.status === "approved").length;
  const rejected = apps.filter(a => a.status === "rejected").length;
  const avgScore = total ? (apps.reduce((s,a) => s + (a.mcqScore||0), 0) / total).toFixed(2) : 0;
  res.json({ total, pending, approved, rejected, avgScore });
});

// ══════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD — Single-page HTML (no extra files needed)
// ══════════════════════════════════════════════════════════════

app.get("/admin", (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>EMS Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07080d;--s1:#0d0f18;--s2:#10121e;
  --border:#1a1d2e;--bord2:#252840;
  --red:#e8304a;--red2:#ff5068;
  --amber:#f59e0b;--green:#10b981;--blue:#6366f1;
  --text:#e2e4f0;--muted:#3d4060;--muted2:#7880a0;
}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
a{color:inherit;text-decoration:none;}
button{cursor:pointer;}

/* LOGIN */
#loginScreen{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
.login-box{background:var(--s1);border:1px solid var(--border);border-radius:16px;padding:36px;width:100%;max-width:380px;text-align:center;}
.login-box h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:6px;}
.login-box p{font-size:13px;color:var(--muted2);margin-bottom:24px;}
.login-box input{width:100%;padding:12px 14px;border-radius:9px;border:1px solid var(--bord2);background:rgba(0,0,0,.3);color:var(--text);font-size:14px;outline:none;margin-bottom:12px;transition:border-color .2s;}
.login-box input:focus{border-color:var(--red);}
.login-box button{width:100%;padding:13px;border:none;border-radius:9px;background:var(--red);color:#fff;font-size:14px;font-weight:700;transition:opacity .2s;}
.login-box button:hover{opacity:.88;}
.login-err{font-size:12px;color:var(--red);margin-top:10px;min-height:18px;}

/* SHELL */
#adminShell{display:none;}
.topbar{display:flex;align-items:center;gap:14px;padding:14px 20px;background:var(--s1);border-bottom:1px solid var(--border);flex-wrap:wrap;}
.topbar h1{font-size:18px;font-weight:700;color:#fff;flex:1;}
.topbar .tag{font-size:10px;font-family:monospace;background:rgba(232,48,74,.12);color:var(--red2);border:1px solid rgba(232,48,74,.22);padding:3px 8px;border-radius:5px;letter-spacing:1px;}
.topbar button{font-size:12px;padding:7px 14px;border-radius:7px;border:1px solid var(--bord2);background:transparent;color:var(--muted2);transition:all .2s;}
.topbar button:hover{color:var(--text);border-color:var(--muted);}

.main{padding:20px;max-width:1100px;margin:0 auto;}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:24px;}
.stat-card{background:var(--s1);border:1px solid var(--border);border-radius:12px;padding:16px;}
.stat-val{font-size:28px;font-weight:700;color:#fff;line-height:1;}
.stat-label{font-size:11px;color:var(--muted2);margin-top:4px;font-family:monospace;letter-spacing:.5px;text-transform:uppercase;}
.stat-card.pending  .stat-val{color:var(--amber);}
.stat-card.approved .stat-val{color:var(--green);}
.stat-card.rejected .stat-val{color:var(--red);}

/* TOOLBAR */
.toolbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center;}
.toolbar input{flex:1;min-width:180px;padding:9px 13px;border-radius:8px;border:1px solid var(--bord2);background:rgba(0,0,0,.3);color:var(--text);font-size:13px;outline:none;transition:border-color .2s;}
.toolbar input:focus{border-color:var(--red);}
.toolbar select{padding:9px 12px;border-radius:8px;border:1px solid var(--bord2);background:var(--s2);color:var(--text);font-size:13px;outline:none;}
.btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;transition:opacity .2s;}
.btn:hover{opacity:.85;}
.btn-primary{background:var(--red);color:#fff;}
.btn-green{background:var(--green);color:#031a0f;}
.btn-amber{background:var(--amber);color:#1a0f00;}
.btn-ghost{background:rgba(255,255,255,.06);color:var(--muted2);border:1px solid var(--bord2);}

/* TABLE */
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--border);}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{background:var(--s2);padding:11px 14px;text-align:left;font-size:10px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);white-space:nowrap;}
tbody tr{border-top:1px solid var(--border);transition:background .15s;}
tbody tr:hover{background:rgba(255,255,255,.025);}
tbody td{padding:11px 14px;vertical-align:middle;}
.td-ref{font-family:monospace;font-size:11px;color:var(--muted2);}
.td-name{font-weight:600;color:#fff;}
.td-did{font-family:monospace;font-size:11px;color:var(--muted2);}
.status-badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:600;font-family:monospace;letter-spacing:.5px;}
.status-pending {background:rgba(245,158,11,.12);color:var(--amber);border:1px solid rgba(245,158,11,.25);}
.status-approved{background:rgba(16,185,129,.12);color:var(--green);border:1px solid rgba(16,185,129,.25);}
.status-rejected{background:rgba(232,48,74,.12); color:var(--red2); border:1px solid rgba(232,48,74,.25);}
.td-actions{display:flex;gap:6px;flex-wrap:wrap;}
.td-actions button{padding:4px 10px;border:none;border-radius:6px;font-size:11px;font-weight:600;}
.btn-view{background:rgba(99,102,241,.15);color:#a5b4fc;}
.btn-approve{background:rgba(16,185,129,.15);color:#6ee7b7;}
.btn-reject{background:rgba(232,48,74,.15);color:#fca5a5;}
.btn-del{background:rgba(255,255,255,.06);color:var(--muted2);}

/* PAGINATION */
.pagination{display:flex;align-items:center;gap:8px;margin-top:16px;justify-content:flex-end;flex-wrap:wrap;}
.pagination button{padding:6px 12px;border:1px solid var(--bord2);border-radius:7px;background:transparent;color:var(--muted2);font-size:12px;}
.pagination button:hover{color:var(--text);}
.pagination button.active{background:var(--red);border-color:var(--red);color:#fff;}
.pg-info{font-size:12px;color:var(--muted);margin-right:auto;}

/* MODAL */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center;padding:20px;}
.modal-overlay.open{display:flex;}
.modal{background:var(--s1);border:1px solid var(--border);border-radius:16px;width:100%;max-width:640px;max-height:85vh;overflow-y:auto;}
.modal-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border);}
.modal-header h2{font-size:16px;font-weight:700;color:#fff;}
.modal-close{background:none;border:none;color:var(--muted2);font-size:20px;cursor:pointer;}
.modal-body{padding:22px;}
.m-section{margin-bottom:20px;}
.m-label{font-size:10px;font-family:monospace;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);}
.m-row{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(26,29,46,.8);font-size:13px;}
.m-row:last-child{border-bottom:none;}
.m-key{color:var(--muted2);min-width:90px;font-family:monospace;font-size:11px;}
.m-val{color:var(--text);flex:1;line-height:1.5;}
.m-notes{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bord2);background:rgba(0,0,0,.3);color:var(--text);font-size:13px;min-height:80px;resize:vertical;outline:none;font-family:inherit;margin-top:6px;}
.m-notes:focus{border-color:var(--red);}
.modal-footer{display:flex;gap:8px;padding:16px 22px;border-top:1px solid var(--border);flex-wrap:wrap;}

/* TOAST */
.toast{position:fixed;bottom:24px;right:24px;background:var(--s1);border:1px solid var(--border);border-radius:10px;padding:12px 18px;font-size:13px;color:var(--text);box-shadow:0 8px 30px rgba(0,0,0,.4);transform:translateY(80px);opacity:0;transition:all .3s;z-index:200;}
.toast.show{transform:translateY(0);opacity:1;}
.toast.ok  {border-left:3px solid var(--green);}
.toast.err {border-left:3px solid var(--red);}

/* Empty */
.empty{text-align:center;padding:48px 20px;color:var(--muted2);font-size:14px;}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="loginScreen">
  <div class="login-box">
    <div style="font-size:32px;margin-bottom:12px;">🚑</div>
    <h1>EMS Admin</h1>
    <p>Enter your admin password to continue</p>
    <input type="password" id="pwInput" placeholder="Admin password" id="pwInput"/>
    <button onclick="doLogin()">Login →</button>
    <div class="login-err" id="loginErr"></div>
  </div>
</div>

<!-- ADMIN SHELL -->
<div id="adminShell">
  <div class="topbar">
    <div style="font-size:22px;">🚑</div>
    <h1>EMS Admin Dashboard</h1>
    <span class="tag">ADMIN</span>
    <button onclick="doExport()">⬇ Export JSON</button>
    <button onclick="doLogout()">Logout</button>
  </div>

  <div class="main">
    <!-- Stats -->
    <div class="stats" id="statsRow">
      <div class="stat-card"><div class="stat-val" id="st-total">–</div><div class="stat-label">Total</div></div>
      <div class="stat-card pending"><div class="stat-val" id="st-pending">–</div><div class="stat-label">Pending</div></div>
      <div class="stat-card approved"><div class="stat-val" id="st-approved">–</div><div class="stat-label">Approved</div></div>
      <div class="stat-card rejected"><div class="stat-val" id="st-rejected">–</div><div class="stat-label">Rejected</div></div>
      <div class="stat-card"><div class="stat-val" id="st-avg">–</div><div class="stat-label">Avg MCQ</div></div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <input type="text" id="searchInput" placeholder="Search name, Discord ID, or ref code…" oninput="debounceLoad()"/>
      <select id="statusFilter" onchange="loadApps()">
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
      </select>
      <button class="btn btn-ghost" onclick="loadApps()">Refresh</button>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Name</th>
            <th>Discord ID</th>
            <th>Status</th>
            <th>Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="appsBody">
          <tr><td colspan="6" class="empty">Loading…</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pagination" id="pagination"></div>
  </div>
</div>

<!-- DETAIL MODAL -->
<div class="modal-overlay" id="detailModal">
  <div class="modal">
    <div class="modal-header">
      <h2 id="modalTitle">Application</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-footer" id="modalFooter"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let TOKEN = "";
let currentPage = 1;
let debounceTimer = null;

// ── Login ──────────────────────────────────────────────────────
async function doLogin(){
  const pw  = document.getElementById("pwInput").value;
  const err = document.getElementById("loginErr");
  err.textContent = "";
  try{
    const r = await fetch("/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||"Wrong password");
    TOKEN = d.token;
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("adminShell").style.display  = "block";
    loadStats();
    loadApps();
  }catch(e){
    err.textContent = e.message;
    document.getElementById("pwInput").value = "";
  }
}

function doLogout(){
  TOKEN = "";
  document.getElementById("adminShell").style.display  = "none";
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("pwInput").value = "";
  document.getElementById("loginErr").textContent = "";
}

// Enter key on password field
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pwInput").addEventListener("keydown", e => {
    if(e.key === "Enter") doLogin();
  });
});

// ── API helpers ───────────────────────────────────────────────
async function api(path, opts={}){
  const r = await fetch(path,{...opts, headers:{...opts.headers,"x-admin-token":TOKEN,"Content-Type":"application/json"}});
  if(!r.ok){ const d=await r.json().catch(()=>({})); throw new Error(d.error||"Request failed"); }
  return r.json();
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats(){
  try{
    const s = await api("/admin/api/stats");
    document.getElementById("st-total").textContent   = s.total;
    document.getElementById("st-pending").textContent  = s.pending;
    document.getElementById("st-approved").textContent = s.approved;
    document.getElementById("st-rejected").textContent = s.rejected;
    document.getElementById("st-avg").textContent      = s.avgScore + "/5";
  }catch(_){}
}

// ── Apps list ─────────────────────────────────────────────────
async function loadApps(page){
  if(page) currentPage = page;
  const search = document.getElementById("searchInput").value;
  const status = document.getElementById("statusFilter").value;
  const params = new URLSearchParams({search,status,page:currentPage,limit:20});
  try{
    const d = await api("/admin/api/apps?"+params);
    renderTable(d.items);
    renderPagination(d.total, d.page, d.pageSize);
  }catch(e){ showToast(e.message,"err"); }
}

function debounceLoad(){
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(()=>loadApps(1), 350);
}

function renderTable(items){
  const body = document.getElementById("appsBody");
  if(!items.length){ body.innerHTML='<tr><td colspan="6" class="empty">No applications found.</td></tr>'; return; }
  body.innerHTML = items.map(a => \`
    <tr>
      <td class="td-ref">\${a.ref}</td>
      <td class="td-name">\${esc(a.fullName)}</td>
      <td class="td-did">\${esc(a.discordUser)}</td>
      <td><span class="status-badge status-\${a.status}">\${a.status.toUpperCase()}</span></td>
      <td style="font-size:12px;color:var(--muted2);white-space:nowrap">\${new Date(a.submittedAt).toLocaleString()}</td>
      <td><div class="td-actions">
        <button class="btn-view"  onclick="viewAppBtn(this)" data-ref="\${a.ref}">View</button>
        \${a.status!=='approved'?'<button class="btn-approve" onclick="setStatusBtn(this)" data-ref="'+a.ref+'" data-status="approved">✓ Approve</button>':''}
        \${a.status!=='rejected'?'<button class="btn-reject"  onclick="setStatusBtn(this)" data-ref="'+a.ref+'" data-status="rejected">✗ Reject</button>':''}
        <button class="btn-del" onclick="delAppBtn(this)" data-ref="\${a.ref}">🗑</button>
      </div></td>
    </tr>
  \`).join("");
}

function renderPagination(total, page, size){
  const pages = Math.ceil(total / size);
  const pg = document.getElementById("pagination");
  if(pages <= 1){ pg.innerHTML=""; return; }
  let html = \`<span class="pg-info">Showing \${Math.min((page-1)*size+1,total)}–\${Math.min(page*size,total)} of \${total}</span>\`;
  if(page > 1) html += \`<button onclick="loadApps(\${page-1})">← Prev</button>\`;
  for(let i=Math.max(1,page-2);i<=Math.min(pages,page+2);i++)
    html += \`<button class="\${i===page?'active':''}" onclick="loadApps(\${i})">\${i}</button>\`;
  if(page < pages) html += \`<button onclick="loadApps(\${page+1})">Next →</button>\`;
  pg.innerHTML = html;
}

function setStatusBtn(btn){ setStatus(btn.dataset.ref, btn.dataset.status); }
function delAppBtn(btn){ delApp(btn.dataset.ref); }
function viewAppBtn(btn){ viewApp(btn.dataset.ref); }

// ── View detail ───────────────────────────────────────────────
async function viewApp(ref){
  try{
    const a = await api("/admin/api/apps/"+ref);
    document.getElementById("modalTitle").textContent = "Application — " + a.ref;

    const MCQ_Q={q1:"Main EMS role?",q2:"Unconscious person?",q3:"EMS weapons?",q4:"Helicopter usage?",q5:"Active shootout?"};
    const OPEN_Q={q6:"Medical RP",q7:"Declared dead",q8:"Patient breaking RP",q9:"Car crash triage",q10:"Patient runs after treatment"};

    let html = \`
      <div class="m-section">
        <div class="m-label">Applicant</div>
        <div class="m-row"><div class="m-key">Name</div><div class="m-val">\${esc(a.fullName)}</div></div>
        <div class="m-row"><div class="m-key">Discord ID</div><div class="m-val">\${esc(a.discordUser)}</div></div>
        <div class="m-row"><div class="m-key">Ref</div><div class="m-val">\${a.ref}</div></div>
        <div class="m-row"><div class="m-key">Status</div><div class="m-val"><span class="status-badge status-\${a.status}">\${a.status.toUpperCase()}</span></div></div>
        <div class="m-row"><div class="m-key">Submitted</div><div class="m-val">\${new Date(a.submittedAt).toLocaleString()}</div></div>
        <div class="m-row"><div class="m-key">MCQ Score</div><div class="m-val">\${a.mcqScore}/5</div></div>
      </div>
      <div class="m-section">
        <div class="m-label">Multiple Choice</div>
        \${Object.entries(MCQ_Q).map(([k,q])=>\`<div class="m-row"><div class="m-key">\${k.toUpperCase()}</div><div class="m-val">\${esc((a.mcq||{})[k]||'–')} — \${q}</div></div>\`).join("")}
      </div>
      <div class="m-section">
        <div class="m-label">Open Questions</div>
        \${Object.entries(OPEN_Q).map(([k,q])=>\`<div class="m-row" style="flex-direction:column;gap:4px"><div class="m-key">\${q}</div><div class="m-val" style="white-space:pre-wrap">\${esc((a.open||{})[k]||'–')}</div></div>\`).join("")}
      </div>
      <div class="m-section">
        <div class="m-label">Admin Notes</div>
        <textarea class="m-notes" id="notesField" placeholder="Add notes…">\${esc(a.notes||'')}</textarea>
      </div>
    \`;
    document.getElementById("modalBody").innerHTML = html;
    document.getElementById("modalFooter").innerHTML = \`
      <button class="btn btn-green"  onclick="setStatus('\${a.ref}','approved');closeModal()">✓ Approve</button>
      <button class="btn btn-primary" onclick="setStatus('\${a.ref}','rejected');closeModal()">✗ Reject</button>
      <button class="btn btn-amber"  onclick="saveNotes('\${a.ref}')">💾 Save Notes</button>
      <button class="btn btn-ghost"  onclick="closeModal()">Close</button>
    \`;
    document.getElementById("detailModal").classList.add("open");
  }catch(e){ showToast(e.message,"err"); }
}

function closeModal(){ document.getElementById("detailModal").classList.remove("open"); }

async function saveNotes(ref){
  const notes = document.getElementById("notesField")?.value || "";
  try{
    await api("/admin/api/apps/"+ref,{method:"PATCH",body:JSON.stringify({notes})});
    showToast("Notes saved","ok");
  }catch(e){ showToast(e.message,"err"); }
}

// ── Status change ─────────────────────────────────────────────
async function setStatus(ref, status){
  try{
    await api("/admin/api/apps/"+ref,{method:"PATCH",body:JSON.stringify({status})});
    showToast("Status updated → "+status, "ok");
    loadApps(); loadStats();
  }catch(e){ showToast(e.message,"err"); }
}

// ── Delete ────────────────────────────────────────────────────
async function delApp(ref){
  if(!confirm("Delete application "+ref+"?")) return;
  try{
    await api("/admin/api/apps/"+ref,{method:"DELETE"});
    showToast("Deleted "+ref,"ok");
    loadApps(); loadStats();
  }catch(e){ showToast(e.message,"err"); }
}

// ── Export ────────────────────────────────────────────────────
function doExport(){
  window.open("/admin/api/export?token="+TOKEN,"_blank");
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type="ok"){
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast "+type;
  setTimeout(()=>t.classList.add("show"),10);
  setTimeout(()=>t.classList.remove("show"),3000);
}

// ── Escape HTML ───────────────────────────────────────────────
function esc(s){
  if(!s) return "—";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}


</script>
</body>
</html>`);
});

// ── 404 ───────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: "Not found" }));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  EMS Apply    → http://localhost:${PORT}`);
  console.log(`✅  Admin Panel  → http://localhost:${PORT}/admin`);
  console.log(`    Data file: ${path.resolve(DATA)}`);
});