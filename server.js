require("dotenv").config();

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder,
} = require("discord.js");

// ══════════════════════════════════════════════════════
// ENV
// ══════════════════════════════════════════════════════
const PORT              = process.env.PORT || 3000;
const TOKEN              = process.env.TOKEN;
const REVIEW_CHANNEL_ID  = process.env.REVIEW_CHANNEL_ID;
const CLIENT_ID          = process.env.CLIENT_ID;
const CLIENT_SECRET      = process.env.CLIENT_SECRET;
const REDIRECT_URI       = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const APPLY_URL          = process.env.APPLY_URL || `http://localhost:${PORT}/apply`;
const SESSION_SECRET     = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
// Comma-separated Discord IDs that get the "owner" role the first time they log in.
const OWNER_IDS          = (process.env.OWNER_IDS || process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const DATA_DIR   = path.join(__dirname, "data");
const APPS_FILE  = path.join(DATA_DIR, "applications.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const HANDBOOK_FILE = path.join(DATA_DIR, "handbook.json");
const SOP_FILE      = path.join(DATA_DIR, "sop.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const LOA_FILE       = path.join(DATA_DIR, "loa.json");
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const AUDIT_FILE     = path.join(DATA_DIR, "audit.json");
const LOGO_FILE  = path.join(__dirname, "assets", "underwater-medical-center.png");

if (!TOKEN || !REVIEW_CHANNEL_ID) {
  console.error("❌  Missing TOKEN or REVIEW_CHANNEL_ID in .env — copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ══════════════════════════════════════════════════════
// EXPRESS
// ══════════════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax" },
}));

// ══════════════════════════════════════════════════════
// DISCORD BOT
// ══════════════════════════════════════════════════════
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ══════════════════════════════════════════════════════
// DATA HELPERS
// ══════════════════════════════════════════════════════
function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { console.error(`loadJSON(${file}):`, e.message); return fallback; }
}
function saveJSON(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
function loadApps()    { return new Map(Object.entries(loadJSON(APPS_FILE, {}))); }
function saveApps(map) { saveJSON(APPS_FILE, Object.fromEntries(map)); }
function loadUsers()   { return loadJSON(USERS_FILE, {}); }
function saveUsers(u)  { saveJSON(USERS_FILE, u); }

function loadHandbook() { return loadJSON(HANDBOOK_FILE, []); }
function loadSop()       { return loadJSON(SOP_FILE, []); }
function loadSchedule()  { return loadJSON(SCHEDULE_FILE, {}); }
function saveSchedule(s) { saveJSON(SCHEDULE_FILE, s); }
function loadLoa()       { return loadJSON(LOA_FILE, {}); }
function saveLoa(l)      { saveJSON(LOA_FILE, l); }
function loadActivity()  { return loadJSON(ACTIVITY_FILE, {}); }
function saveActivity(a) { saveJSON(ACTIVITY_FILE, a); }
function loadAudit()     { return loadJSON(AUDIT_FILE, []); }
function logAudit(actor, action, target, details) {
  const audit = loadAudit();
  audit.push({ ts: new Date().toISOString(), actor: safe(actor, 100), action: safe(action, 60), target: safe(target, 100), details: safe(details, 500) });
  if (audit.length > 5000) audit.splice(0, audit.length - 5000); // keep it bounded
  saveJSON(AUDIT_FILE, audit);
}

// Fixed weekly duty shift structure. schedule.json only stores who claimed what: { shiftId: [discordId, ...] }
const DUTY_DAYS   = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DUTY_SLOTS  = [
  { key: "morning", label: "Morning · 08:00–14:00", capacity: 4 },
  { key: "evening", label: "Evening · 14:00–20:00", capacity: 4 },
  { key: "night",   label: "Night · 20:00–02:00",   capacity: 3 },
];
function dutyShiftId(day, slotKey) { return `${day}-${slotKey}`; }

function safe(v, max = 1000) { return String(v ?? "—").trim().slice(0, max) || "—"; }
function genRef() { return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase(); }

// ══════════════════════════════════════════════════════
// ROLES  (owner > admin > reviewer > viewer > none)
// ══════════════════════════════════════════════════════
const ROLE_WEIGHT = { owner: 4, admin: 3, reviewer: 2, viewer: 1, none: 0 };

function getUserRole(discordId) {
  const users = loadUsers();
  const u = users[discordId];
  if (u?.role) return u.role;
  if (OWNER_IDS.includes(discordId)) return "owner";
  return "none";
}
function ensureUserRecord(discordId, rpName) {
  const users = loadUsers();
  if (!users[discordId]) {
    users[discordId] = {
      discordId, rpName, points: 0, badges: [],
      role: OWNER_IDS.includes(discordId) ? "owner" : "none",
    };
    saveUsers(users);
  }
  return users[discordId];
}
function hasRole(discordId, minRole) {
  return ROLE_WEIGHT[getUserRole(discordId)] >= ROLE_WEIGHT[minRole];
}

// ══════════════════════════════════════════════════════
// RATE LIMITER — 1 submission / 24h / discord id
// ══════════════════════════════════════════════════════
const RATE_WINDOW = 24 * 60 * 60 * 1000;
const rateMap = new Map();
function checkRate(id) {
  const last = rateMap.get(id);
  if (!last) return { ok: true };
  const elapsed = Date.now() - last;
  if (elapsed >= RATE_WINDOW) return { ok: true };
  return { ok: false, remainSec: Math.ceil((RATE_WINDOW - elapsed) / 1000) };
}
function recordRate(id) { rateMap.set(id, Date.now()); }

// ══════════════════════════════════════════════════════
// POINTS & BADGES
// ══════════════════════════════════════════════════════
const BADGES = [
  { pts: 10,  label: "🥉 Bronze"  },
  { pts: 30,  label: "🥈 Silver"  },
  { pts: 60,  label: "🥇 Gold"    },
  { pts: 100, label: "💎 Diamond" },
];
function awardPoints(discordId, rpName, amount, reason) {
  const users = loadUsers();
  if (!users[discordId]) users[discordId] = { discordId, rpName, points: 0, badges: [], role: "none" };
  users[discordId].points += amount;
  users[discordId].rpName = rpName;
  for (const b of BADGES) {
    if (users[discordId].points >= b.pts && !users[discordId].badges.includes(b.label))
      users[discordId].badges.push(b.label);
  }
  saveUsers(users);

  const activity = loadActivity();
  if (!activity[discordId]) activity[discordId] = [];
  activity[discordId].push({ ts: new Date().toISOString(), delta: amount, reason: safe(reason || "Points adjustment", 200) });
  saveActivity(activity);

  return users[discordId];
}

// ══════════════════════════════════════════════════════
// DISCORD OAUTH
// ══════════════════════════════════════════════════════
app.get("/auth/discord", (req, res) => {
  if (!CLIENT_ID) return res.status(500).send("CLIENT_ID not configured");
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?auth=failed");
  try {
    const tok = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      }),
    }).then(r => r.json());

    if (!tok.access_token) throw new Error("No access token from Discord");

    const me = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then(r => r.json());

    ensureUserRecord(me.id, me.username);
    req.session.user = { id: me.id, username: me.username, avatar: me.avatar };

    res.redirect(hasRole(me.id, "viewer") ? "/dashboard" : "/");
  } catch (e) {
    console.error("OAuth error:", e.message);
    res.redirect("/?auth=failed");
  }
});

app.get("/auth/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Login required" });
  next();
}
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: "Login required" });
    if (!hasRole(req.session.user.id, minRole)) return res.status(403).json({ error: "Forbidden — insufficient role" });
    next();
  };
}

// ══════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════
app.get("/api/content", (_, res) => res.json(loadJSON(path.join(__dirname, "content.json"), {})));

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const u = loadUsers()[req.session.user.id] || {};
  res.json({
    loggedIn: true,
    user: {
      ...req.session.user,
      points: u.points || 0,
      badges: u.badges || [],
      role: getUserRole(req.session.user.id),
    },
  });
});

app.get("/api/leaderboard", (req, res) => {
  const board = Object.values(loadUsers())
    .filter(u => u.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10)
    .map((u, i) => ({ rank: i + 1, rpName: u.rpName, points: u.points, badges: u.badges || [] }));
  res.json(board);
});

app.get("/api/my-apps", requireAuth, (req, res) => {
  const mine = [];
  for (const a of loadApps().values())
    if (a.discordUser === req.session.user.id)
      mine.push({ ref: a.ref, status: a.status, createdAt: a.createdAt, mcqScore: a.mcqScore, fullName: a.fullName });
  res.json(mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Server-side answer key — never trust a client-computed score.
const MCQ_ANSWER_KEY = { q1: "A", q2: "B", q3: "C", q4: "C", q5: "B" };
function scoreMcq(mcq) {
  return Object.entries(MCQ_ANSWER_KEY).reduce((s, [k, correct]) => s + (mcq?.[k] === correct ? 1 : 0), 0);
}

// ── Submit ──
app.post("/submit", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: "login_required" });

    const body = req.body || {};
    if (!body.fullName)
      return res.status(400).json({ error: "Missing fullName" });

    // The Discord identity always comes from the authenticated session, never from client input —
    // otherwise anyone could submit under someone else's Discord ID.
    const discordUser = req.session.user.id;

    const rl = checkRate(discordUser);
    if (!rl.ok) return res.status(429).json({ error: "Too many submissions", remainSec: rl.remainSec });

    const ref = genRef();
    const appData = {
      ref,
      fullName:    safe(body.fullName, 100),
      discordUser: safe(discordUser, 100),
      mcqScore:    scoreMcq(body.mcq),
      mcq:         body.mcq || {},
      open:        body.open || {},
      status:      "pending",
      notes:       "",
      createdAt:   new Date().toISOString(),
    };

    const apps = loadApps();
    apps.set(ref, appData);
    saveApps(apps);
    recordRate(discordUser);

    const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);
    if (channel?.isTextBased())
      await channel.send({
        embeds: [buildEmbed(appData, "🚑 Underwater Medical Center — New Application", 0x3b82f6)],
        components: [makeButtons(ref)],
      });

    console.log(`✅ Application: ${ref}`);
    return res.json({ ok: true, ref });
  } catch (err) {
    console.error("Submit error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════
// ADMIN API
// ══════════════════════════════════════════════════════
app.get("/api/admin/stats", requireRole("viewer"), (req, res) => {
  const list  = Array.from(loadApps().values());
  const users = loadUsers();
  res.json({
    total:    list.length,
    pending:  list.filter(a => a.status === "pending").length,
    approved: list.filter(a => a.status === "approved").length,
    rejected: list.filter(a => a.status === "rejected").length,
    members:  Object.keys(users).length,
    avgScore: list.length ? (list.reduce((s, a) => s + (a.mcqScore || 0), 0) / list.length).toFixed(1) : 0,
  });
});

app.get("/api/admin/analytics", requireRole("viewer"), (req, res) => {
  const list = Array.from(loadApps().values());

  // submissions per day, last 30 days
  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const perDay = Object.fromEntries(days.map(d => [d, 0]));
  for (const a of list) {
    const d = (a.createdAt || "").slice(0, 10);
    if (d in perDay) perDay[d]++;
  }

  // score distribution 0-5
  const scoreDist = [0, 0, 0, 0, 0, 0];
  for (const a of list) {
    const s = Math.max(0, Math.min(5, Number(a.mcqScore) || 0));
    scoreDist[s]++;
  }

  // reviewer leaderboard
  const byReviewer = {};
  for (const a of list) {
    if (!a.reviewedBy) continue;
    byReviewer[a.reviewedBy] = (byReviewer[a.reviewedBy] || 0) + 1;
  }

  // avg review turnaround (hours)
  const turnarounds = list
    .filter(a => a.createdAt && a.reviewedAt)
    .map(a => (new Date(a.reviewedAt) - new Date(a.createdAt)) / 3.6e6);
  const avgTurnaroundH = turnarounds.length
    ? (turnarounds.reduce((s, v) => s + v, 0) / turnarounds.length).toFixed(1)
    : null;

  const approvalRate = list.length
    ? ((list.filter(a => a.status === "approved").length / list.length) * 100).toFixed(1)
    : "0.0";

  res.json({
    submissionsPerDay: days.map(d => ({ date: d, count: perDay[d] })),
    scoreDist,
    reviewerLeaderboard: Object.entries(byReviewer).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    avgTurnaroundH,
    approvalRate,
  });
});

app.get("/api/admin/apps", requireRole("viewer"), (req, res) => {
  const { status = "all", search = "", page = 1, limit = 20, sort = "new" } = req.query;
  let list = Array.from(loadApps().values());
  if (status !== "all") list = list.filter(a => a.status === status.toLowerCase());
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(a =>
      (a.fullName || "").toLowerCase().includes(s) ||
      (a.discordUser || "").includes(s) ||
      (a.ref || "").toLowerCase().includes(s)
    );
  }
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else if (sort === "old") list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  else if (sort === "score") list.sort((a, b) => (b.mcqScore || 0) - (a.mcqScore || 0));

  const p = Math.max(1, +page), lim = Math.min(100, Math.max(1, +limit));
  res.json({ total: list.length, page: p, data: list.slice((p - 1) * lim, p * lim) });
});

app.post("/api/admin/review", requireRole("reviewer"), async (req, res) => {
  const { ref, action, notes } = req.body;
  if (!ref || !["accept", "reject"].includes(action)) return res.status(400).json({ error: "Invalid" });
  try {
    await processReview(ref, action, req.session.user.username, notes);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/admin/bulk-review", requireRole("reviewer"), async (req, res) => {
  const { refs, action } = req.body;
  if (!Array.isArray(refs) || !refs.length || !["accept", "reject"].includes(action))
    return res.status(400).json({ error: "Invalid" });

  const results = { ok: [], failed: [] };
  for (const ref of refs) {
    try { await processReview(ref, action, req.session.user.username); results.ok.push(ref); }
    catch (e) { results.failed.push({ ref, error: e.message }); }
  }
  res.json(results);
});

app.patch("/api/admin/apps/:ref/notes", requireRole("reviewer"), (req, res) => {
  const apps = loadApps();
  const data = apps.get(req.params.ref);
  if (!data) return res.status(404).json({ error: "Not found" });
  data.notes = safe(req.body.notes, 2000);
  apps.set(req.params.ref, data);
  saveApps(apps);
  logAudit(req.session.user.username, "notes_updated", req.params.ref, data.notes.slice(0, 120));
  res.json({ ok: true });
});

// ── Members & role management (admin+) ──
app.get("/api/admin/users", requireRole("admin"), (req, res) => {
  const users = Object.values(loadUsers()).sort((a, b) => (b.points || 0) - (a.points || 0));
  res.json(users);
});

app.patch("/api/admin/users/:id/role", requireRole("owner"), (req, res) => {
  const { role } = req.body;
  if (!["owner", "admin", "reviewer", "viewer", "none"].includes(role))
    return res.status(400).json({ error: "Invalid role" });
  const users = loadUsers();
  if (!users[req.params.id]) return res.status(404).json({ error: "User not found" });
  const prevRole = users[req.params.id].role || "none";
});

// ══════════════════════════════════════════════════════
// PERSONNEL API (Phase 3 — EMS Personnel Panel)
// Available to any logged-in user holding an EMS rank (role >= viewer).
// ══════════════════════════════════════════════════════
app.get("/api/personnel/handbook", requireRole("viewer"), (req, res) => res.json(loadHandbook()));
app.get("/api/personnel/sop",       requireRole("viewer"), (req, res) => res.json(loadSop()));

// ── Duty schedule ──
app.get("/api/personnel/schedule", requireRole("viewer"), (req, res) => {
  const claims = loadSchedule();
  const users  = loadUsers();
  const grid = DUTY_DAYS.map(day => ({
    day,
    slots: DUTY_SLOTS.map(s => {
      const id = dutyShiftId(day, s.key);
      const ids = claims[id] || [];
      return {
        id, key: s.key, label: s.label, capacity: s.capacity,
        claimedBy: ids.map(uid => ({ discordId: uid, rpName: users[uid]?.rpName || uid })),
        mineClaimed: ids.includes(req.session.user.id),
      };
    }),
  }));
  res.json(grid);
});

app.post("/api/personnel/schedule/claim", requireRole("viewer"), (req, res) => {
  const { day, slot } = req.body;
  const slotDef = DUTY_SLOTS.find(s => s.key === slot);
  if (!DUTY_DAYS.includes(day) || !slotDef) return res.status(400).json({ error: "Invalid shift" });
  const id = dutyShiftId(day, slot);
  const claims = loadSchedule();
  const list = claims[id] || [];
  if (list.includes(req.session.user.id)) return res.status(400).json({ error: "Already claimed" });
  if (list.length >= slotDef.capacity) return res.status(400).json({ error: "Shift is full" });
  list.push(req.session.user.id);
  claims[id] = list;
  saveSchedule(claims);
  res.json({ ok: true });
});

app.post("/api/personnel/schedule/unclaim", requireRole("viewer"), (req, res) => {
  const { day, slot } = req.body;
  const id = dutyShiftId(day, slot);
  const claims = loadSchedule();
  claims[id] = (claims[id] || []).filter(uid => uid !== req.session.user.id);
  saveSchedule(claims);
  res.json({ ok: true });
});

// ── LOA (Leave of Absence) ──
app.get("/api/personnel/loa", requireAuth, (req, res) => {
  const mine = Object.values(loadLoa())
    .filter(l => l.discordId === req.session.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(mine);
});

app.post("/api/personnel/loa", requireRole("viewer"), (req, res) => {
  const { reason, startDate, endDate } = req.body;
  if (!reason || !startDate || !endDate) return res.status(400).json({ error: "Missing fields" });
  const users = loadUsers();
  const id = "LOA-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  const loa = loadLoa();
  loa[id] = {
    id,
    discordId: req.session.user.id,
    rpName: users[req.session.user.id]?.rpName || req.session.user.username,
    reason: safe(reason, 500), startDate: safe(startDate, 20), endDate: safe(endDate, 20),
    status: "pending", createdAt: new Date().toISOString(),
  };
  saveLoa(loa);
  logAudit(req.session.user.username, "loa_submitted", id, safe(reason, 120));
  res.json({ ok: true, id });
});

app.get("/api/admin/loa", requireRole("reviewer"), (req, res) => {
  res.json(Object.values(loadLoa()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post("/api/admin/loa/review", requireRole("reviewer"), (req, res) => {
  const { id, action } = req.body;
  if (!["approve", "deny"].includes(action)) return res.status(400).json({ error: "Invalid action" });
  const loa = loadLoa();
  const rec = loa[id];
  if (!rec) return res.status(404).json({ error: "Not found" });
  if (rec.status !== "pending") return res.status(400).json({ error: `Already ${rec.status}` });
  rec.status = action === "approve" ? "approved" : "denied";
  rec.reviewedAt = new Date().toISOString();
  rec.reviewedBy = req.session.user.username;
  loa[id] = rec;
  saveLoa(loa);
  logAudit(req.session.user.username, action === "approve" ? "loa_approved" : "loa_denied", id, rec.rpName);
  res.json({ ok: true });
});

// ── Activity points ──
app.get("/api/personnel/activity", requireAuth, (req, res) => {
  const users = loadUsers();
  const u = users[req.session.user.id] || { points: 0, badges: [] };
  const history = (loadActivity()[req.session.user.id] || []).slice().reverse();
  res.json({ points: u.points || 0, badges: u.badges || [], history });
});

app.post("/api/admin/activity/adjust", requireRole("admin"), (req, res) => {
  const { discordId, delta, reason } = req.body;
  const amount = Number(delta);
  if (!discordId || !amount || !reason) return res.status(400).json({ error: "Missing fields" });
  const users = loadUsers();
  const rpName = users[discordId]?.rpName || discordId;
  awardPoints(discordId, rpName, amount, reason);
  logAudit(req.session.user.username, "points_adjusted", discordId, `${amount > 0 ? "+" : ""}${amount} — ${reason}`);
  res.json({ ok: true });
});

// ── Audit log (read-only here; full console lands in Phase 2) ──
app.get("/api/admin/audit", requireRole("admin"), (req, res) => {
  const limit = Math.min(500, Math.max(1, +(req.query.limit || 100)));
  res.json(loadAudit().slice(-limit).reverse());
});

// ══════════════════════════════════════════════════════
// REVIEW LOGIC (shared by web + Discord buttons)
// ══════════════════════════════════════════════════════
async function processReview(ref, action, reviewerTag, notes) {
  const apps = loadApps();
  const data = apps.get(ref);
  if (!data) throw new Error("Application not found");
  if (data.status !== "pending") throw new Error(`Already ${data.status}`);

  data.status     = action === "accept" ? "approved" : "rejected";
  data.reviewedAt  = new Date().toISOString();
  data.reviewedBy  = reviewerTag || "System";
  if (notes) data.notes = safe(notes, 2000);
  apps.set(ref, data);
  saveApps(apps);

  if (action === "accept") awardPoints(data.discordUser, data.fullName, 10, `Application ${ref} approved`);
  logAudit(reviewerTag || "System", action === "accept" ? "application_approved" : "application_rejected", ref, data.fullName);

  try {
    const user  = await client.users.fetch(data.discordUser);
    const files = [];
    if (fs.existsSync(LOGO_FILE)) files.push(new AttachmentBuilder(LOGO_FILE, { name: "underwater-medical-center.png" }));
    await user.send({ embeds: [buildResultEmbed(data, action, ref)], files });
  } catch (e) { console.log("DM failed:", e.message); }

  return data;
}

// ══════════════════════════════════════════════════════
// DISCORD BUTTONS
// ══════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.deferred || interaction.replied) return; // already handled — likely a double-click/duplicate event
    await interaction.deferUpdate();

    const [action, ref] = interaction.customId.split("_");
    if (!["accept", "reject"].includes(action) || !ref) return;

    const data = loadApps().get(ref);
    if (!data) return interaction.followUp({ content: "❌ Not found.", ephemeral: true });
    if (data.status !== "pending") return interaction.followUp({ content: `⚠️ Already ${data.status}`, ephemeral: true });

    let updatedData;
    try { updatedData = await processReview(ref, action, interaction.user.tag); }
    catch (e) { return interaction.followUp({ content: `❌ ${e.message}`, ephemeral: true }); }

    const title = action === "accept" ? "✅ Underwater Medical Center — APPROVED" : "❌ Underwater Medical Center — REJECTED";
    await interaction.editReply({
      embeds: [buildEmbed(updatedData, title, action === "accept" ? 0x22c55e : 0xef4444)],
      components: [makeButtons(ref, true)],
    });
  } catch (err) {
    // Never let a single bad interaction (double-click, expired token, Discord API hiccup) take the whole process down.
    console.error("Interaction handling error:", err.message);
  }
});

// Last-resort safety nets: log and keep running instead of crashing the whole server + bot.
process.on("unhandledRejection", (err) => console.error("⚠️  Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("⚠️  Uncaught exception:", err));

// ══════════════════════════════════════════════════════
// EMBED BUILDERS
// ══════════════════════════════════════════════════════
const MCQ_KEYS  = ["q1", "q2", "q3", "q4", "q5"];
const OPEN_KEYS = ["q6", "q7", "q8", "q9", "q10"];
const OPEN_LBLS = [
  "Explain Medical RP and why EMS must respect it",
  "Death declared + video evidence — what do you do?",
  "Patient insults you / breaks RP rules — response?",
  "Crash: one conscious, one unconscious — who first, why?",
  "Treated patient flees & starts fighting — what do you do?",
];

function makeButtons(ref, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`accept_${ref}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`reject_${ref}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function buildEmbed(data, title = "🚑 New Application", color = 0x3b82f6) {
  const scoreIcon = data.mcqScore >= 4 ? "🟢" : data.mcqScore === 3 ? "🟡" : "🔴";
  const mcqLine = MCQ_KEYS.map(k => {
    const given = safe(data.mcq?.[k], 10);
    const correct = given === MCQ_ANSWER_KEY[k];
    return `${correct ? "✅" : "❌"} **${k.toUpperCase()}:** ${given}`;
  }).join("  |  ");

  const embed = new EmbedBuilder().setColor(color).setTitle(title)
    .addFields(
      { name: "👤 RP Name",    value: safe(data.fullName, 80),           inline: true },
      { name: "💬 Discord ID", value: `\`${safe(data.discordUser, 30)}\``, inline: true },
      { name: "🧠 MCQ Score",  value: `${scoreIcon} ${safe(data.mcqScore, 10)}/5`, inline: true },
      { name: "🏷️ Ref",        value: `\`${safe(data.ref, 30)}\``,         inline: true },
      { name: "📌 Status",     value: safe(data.status, 20),             inline: true },
      { name: "🛡️ Reviewed By", value: data.reviewedBy ? safe(data.reviewedBy, 60) : "—", inline: true },
      { name: "📝 MCQ Answers", value: safe(mcqLine, 400), inline: false },
    );
  OPEN_KEYS.forEach((k, i) => embed.addFields({ name: `💬 ${OPEN_LBLS[i]}`, value: safe(data.open?.[k], 500), inline: false }));
  embed.setFooter({ text: `REF: ${safe(data.ref)} • ${new Date(data.createdAt).toLocaleString()}` }).setTimestamp();
  return embed;
}

function buildResultEmbed(data, action, ref) {
  const ok = action === "accept";
  return new EmbedBuilder()
    .setColor(ok ? 0x22c55e : 0xef4444)
    .setAuthor({ name: "Underwater Medical Center", iconURL: "attachment://underwater-medical-center.png" })
    .setTitle(ok ? "🎉 Application Approved!" : "📋 Application Update")
    .setDescription(ok
      ? `Dear **${safe(data.fullName, 80)}**,\n\nYour application has been **approved** ✅\n\nYou earned **+10 points** 🏅\n\n**Ref:** \`${ref}\`\n\nWelcome to **Underwater Medical Center**!`
      : `Dear **${safe(data.fullName, 80)}**,\n\nYour application was **not approved** at this time.\n\n**Ref:** \`${ref}\`\n\nYou may re-apply after improving your preparation.`
    )
    .addFields(
      { name: "Applicant",  value: safe(data.fullName, 80),    inline: true },
      { name: "Discord ID", value: safe(data.discordUser, 30), inline: true },
      { name: "Score",      value: `${safe(data.mcqScore, 10)}/5`, inline: true },
    )
    .setThumbnail("attachment://underwater-medical-center.png")
    .setFooter({ text: "Underwater Medical Center • Recruitment" })
    .setTimestamp();
}

// ══════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════
app.get("/",              (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/apply",         (_, res) => res.sendFile(path.join(__dirname, "public", "apply.html")));
app.get("/dashboard",     requireAuth, (req, res, next) => {
  if (!hasRole(req.session.user.id, "viewer")) return res.status(403).sendFile(path.join(__dirname, "public", "403.html"));
  next();
}, (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/personnel",     requireAuth, (req, res, next) => {
  if (!hasRole(req.session.user.id, "viewer")) return res.status(403).sendFile(path.join(__dirname, "public", "403.html"));
  next();
}, (_, res) => res.sendFile(path.join(__dirname, "public", "personnel.html")));
app.get("/handbook", (_, res) => res.sendFile(path.join(__dirname, "public", "documentation.html")));
app.get("/documentation", (_, res) => res.redirect(301, "/handbook")); // old link, kept working

// ══════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`📨 Review channel: ${REVIEW_CHANNEL_ID}`);
    console.log(`🌐 Apply URL: ${APPLY_URL}`);
    console.log(`🛡️  Owners: ${OWNER_IDS.join(", ") || "none configured"}`);
  });
});

client.login(TOKEN).catch(err => { console.error("❌ Login failed:", err.message); process.exit(1); });
