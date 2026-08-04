require("dotenv").config();

const express = require("express");
const session = require("express-session");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder,
} = require("discord.js");
const db = require("./db");

// ══════════════════════════════════════════════════════
// ENV
// ══════════════════════════════════════════════════════
const PORT               = process.env.PORT || 3000;
const TOKEN               = process.env.TOKEN;
const REVIEW_CHANNEL_ID   = process.env.REVIEW_CHANNEL_ID;
const CLIENT_ID           = process.env.CLIENT_ID;
const CLIENT_SECRET       = process.env.CLIENT_SECRET;
const REDIRECT_URI        = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const APPLY_URL           = process.env.APPLY_URL || `http://localhost:${PORT}/apply`;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || REVIEW_CHANNEL_ID;
const SESSION_SECRET      = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 6);
// Comma-separated Discord IDs that get the "owner" role the first time they log in.
const OWNER_IDS = (process.env.OWNER_IDS || process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const LOGO_FILE = path.join(__dirname, "assets", "underwater-medical-center.png");

if (!TOKEN || !REVIEW_CHANNEL_ID) {
  console.error("❌  Missing TOKEN or REVIEW_CHANNEL_ID in .env — copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ══════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO (sharing one HTTP server + one session)
// ══════════════════════════════════════════════════════
const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer);

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax" },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware); // reuse the same session for socket handshakes

// ══════════════════════════════════════════════════════
// DISCORD BOT
// ══════════════════════════════════════════════════════
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function safe(v, max = 1000) { return String(v ?? "—").trim().slice(0, max) || "—"; }
function genRef() { return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase(); }
function logAudit(actor, action, target, details) { db.addAuditEntry(safe(actor, 100), safe(action, 60), safe(target, 100), safe(details, 500)); }

// Fixed weekly duty shift structure.
const DUTY_DAYS  = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DUTY_SLOTS = [
  { key: "morning", label: "Morning · 08:00–14:00", capacity: 4 },
  { key: "evening", label: "Evening · 14:00–20:00", capacity: 4 },
  { key: "night",   label: "Night · 20:00–02:00",   capacity: 3 },
];
function dutyShiftId(day, slotKey) { return `${day}-${slotKey}`; }

// ══════════════════════════════════════════════════════
// ROLES  (owner > admin > reviewer > viewer > none)
// ══════════════════════════════════════════════════════
const ROLE_WEIGHT = { owner: 4, admin: 3, reviewer: 2, viewer: 1, none: 0 };

function getUserRole(discordId) {
  const u = db.getUser(discordId);
  if (u?.role) return u.role;
  if (OWNER_IDS.includes(discordId)) return "owner";
  return "none";
}
function ensureUserRecord(discordId, rpName) {
  let u = db.getUser(discordId);
  if (!u) {
    u = { discordId, rpName, points: 0, badges: [], role: OWNER_IDS.includes(discordId) ? "owner" : "none" };
    db.upsertUser(u);
  }
  return u;
}
function hasRole(discordId, minRole) { return ROLE_WEIGHT[getUserRole(discordId)] >= ROLE_WEIGHT[minRole]; }

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
  let u = db.getUser(discordId);
  if (!u) { u = { discordId, rpName, points: 0, badges: [], role: "none" }; db.upsertUser(u); }
  const updated = db.addUserPoints(discordId, amount);
  updated.rpName = rpName || updated.rpName;
  for (const b of BADGES) {
    if (updated.points >= b.pts && !updated.badges.includes(b.label)) updated.badges.push(b.label);
  }
  db.upsertUser(updated);
  db.addActivityEntry(discordId, amount, safe(reason || "Points adjustment", 200));
  io.to("staff").emit("points:updated", { discordId, points: updated.points });
  return updated;
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
app.get("/api/content", (_, res) => {
  try { res.json(JSON.parse(fs.readFileSync(path.join(__dirname, "content.json"), "utf8"))); }
  catch { res.json({}); }
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const u = db.getUser(req.session.user.id) || {};
  res.json({
    loggedIn: true,
    user: { ...req.session.user, points: u.points || 0, badges: u.badges || [], role: getUserRole(req.session.user.id) },
  });
});

app.get("/api/leaderboard", (req, res) => {
  const board = db.getAllUsers()
    .filter(u => u.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 10)
    .map((u, i) => ({ rank: i + 1, rpName: u.rpName, points: u.points, badges: u.badges || [] }));
  res.json(board);
});

app.get("/api/my-apps", requireAuth, (req, res) => {
  const mine = db.getAllApplications()
    .filter(a => a.discordUser === req.session.user.id)
    .map(a => ({ ref: a.ref, status: a.status, createdAt: a.createdAt, mcqScore: a.mcqScore, fullName: a.fullName }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(mine);
});

// Server-side answer key — never trust a client-computed score.
const MCQ_ANSWER_KEY = { q1: "A", q2: "B", q3: "C", q4: "C", q5: "B" };
function scoreMcq(mcq) {
  return Object.entries(MCQ_ANSWER_KEY).reduce((s, [k, correct]) => s + (mcq?.[k] === correct ? 1 : 0), 0);
}

// ── Submit ──
app.post("/submit", async (req, res) => {
  try {
    if (db.getSettings().maintenance) return res.status(503).json({ error: "maintenance" });
    if (!req.session.user) return res.status(401).json({ error: "login_required" });

    const body = req.body || {};
    if (!body.fullName) return res.status(400).json({ error: "Missing fullName" });

    // The Discord identity always comes from the authenticated session, never from client input.
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

    db.upsertApplication(appData);
    recordRate(discordUser);
    io.to("staff").emit("application:new", { ref: appData.ref, fullName: appData.fullName, mcqScore: appData.mcqScore });

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
  const stats = db.applicationStats();
  res.json({ ...stats, members: db.getAllUsers().length });
});

app.get("/api/admin/analytics", requireRole("viewer"), (req, res) => {
  const list = db.getAllApplications();

  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
  const perDay = Object.fromEntries(days.map(d => [d, 0]));
  for (const a of list) { const d = (a.createdAt || "").slice(0, 10); if (d in perDay) perDay[d]++; }

  const scoreDist = [0, 0, 0, 0, 0, 0];
  for (const a of list) { const s = Math.max(0, Math.min(5, Number(a.mcqScore) || 0)); scoreDist[s]++; }

  const byReviewer = {};
  for (const a of list) { if (!a.reviewedBy) continue; byReviewer[a.reviewedBy] = (byReviewer[a.reviewedBy] || 0) + 1; }

  const turnarounds = list.filter(a => a.createdAt && a.reviewedAt).map(a => (new Date(a.reviewedAt) - new Date(a.createdAt)) / 3.6e6);
  const avgTurnaroundH = turnarounds.length ? (turnarounds.reduce((s, v) => s + v, 0) / turnarounds.length).toFixed(1) : null;
  const approvalRate = list.length ? ((list.filter(a => a.status === "approved").length / list.length) * 100).toFixed(1) : "0.0";

  res.json({
    submissionsPerDay: days.map(d => ({ date: d, count: perDay[d] })),
    scoreDist,
    reviewerLeaderboard: Object.entries(byReviewer).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    avgTurnaroundH, approvalRate,
  });
});

app.get("/api/admin/apps", requireRole("viewer"), (req, res) => {
  const { status = "all", search = "", page = 1, limit = 20, sort = "new" } = req.query;
  res.json(db.queryApplications({ status, search, sort, page, limit }));
});

app.post("/api/admin/review", requireRole("reviewer"), async (req, res) => {
  const { ref, action, notes } = req.body;
  if (!ref || !["accept", "reject"].includes(action)) return res.status(400).json({ error: "Invalid" });
  try { await processReview(ref, action, req.session.user.username, notes); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/admin/bulk-review", requireRole("reviewer"), async (req, res) => {
  const { refs, action } = req.body;
  if (!Array.isArray(refs) || !refs.length || !["accept", "reject"].includes(action)) return res.status(400).json({ error: "Invalid" });
  const results = { ok: [], failed: [] };
  for (const ref of refs) {
    try { await processReview(ref, action, req.session.user.username); results.ok.push(ref); }
    catch (e) { results.failed.push({ ref, error: e.message }); }
  }
  res.json(results);
});

app.patch("/api/admin/apps/:ref/notes", requireRole("reviewer"), (req, res) => {
  const data = db.getApplication(req.params.ref);
  if (!data) return res.status(404).json({ error: "Not found" });
  const notes = safe(req.body.notes, 2000);
  db.updateApplicationNotes(req.params.ref, notes);
  logAudit(req.session.user.username, "notes_updated", req.params.ref, notes.slice(0, 120));
  res.json({ ok: true });
});

// ── Members & role management (admin+) ──
app.get("/api/admin/users", requireRole("admin"), (req, res) => {
  res.json(db.getAllUsers().sort((a, b) => (b.points || 0) - (a.points || 0)));
});

app.patch("/api/admin/users/:id/role", requireRole("admin"), (req, res) => {
  const { role } = req.body;
  if (!["owner", "admin", "reviewer", "viewer", "none"].includes(role)) return res.status(400).json({ error: "Invalid role" });

  const actingRole = getUserRole(req.session.user.id);
  const target = db.getUser(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const prevRole = target.role || "none";

  if (actingRole !== "owner" && (role === "owner" || prevRole === "owner")) {
    return res.status(403).json({ error: "Only an owner can grant or change the owner role" });
  }

  db.setUserRole(req.params.id, role);
  logAudit(req.session.user.username, "role_changed", req.params.id, `${prevRole} → ${role}`);
  io.to("staff").emit("role:updated", { discordId: req.params.id, role });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
// PERSONNEL API (Phase 3 — EMS Personnel Panel)
// ══════════════════════════════════════════════════════
app.get("/api/personnel/handbook", requireRole("viewer"), (req, res) => res.json(db.getHandbook()));
app.get("/api/personnel/sop",       requireRole("viewer"), (req, res) => res.json(db.getSop()));

// ── Duty schedule ──
app.get("/api/personnel/schedule", requireRole("viewer"), (req, res) => {
  const claims = db.getScheduleClaims();
  const usersMap = db.getAllUsersMap();
  const grid = DUTY_DAYS.map(day => ({
    day,
    slots: DUTY_SLOTS.map(s => {
      const id = dutyShiftId(day, s.key);
      const ids = claims[id] || [];
      return {
        id, key: s.key, label: s.label, capacity: s.capacity,
        claimedBy: ids.map(uid => ({ discordId: uid, rpName: usersMap[uid]?.rpName || uid })),
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
  if (db.isShiftClaimedBy(id, req.session.user.id)) return res.status(400).json({ error: "Already claimed" });
  if (db.shiftClaimCount(id) >= slotDef.capacity) return res.status(400).json({ error: "Shift is full" });
  db.claimShift(id, req.session.user.id);
  io.to("staff").emit("schedule:updated", { shiftId: id });
  res.json({ ok: true });
});

app.post("/api/personnel/schedule/unclaim", requireRole("viewer"), (req, res) => {
  const { day, slot } = req.body;
  const id = dutyShiftId(day, slot);
  db.unclaimShift(id, req.session.user.id);
  io.to("staff").emit("schedule:updated", { shiftId: id });
  res.json({ ok: true });
});

// ── LOA (Leave of Absence) ──
app.get("/api/personnel/loa", requireAuth, (req, res) => res.json(db.getLoaForUser(req.session.user.id)));

app.post("/api/personnel/loa", requireRole("viewer"), (req, res) => {
  const { reason, startDate, endDate } = req.body;
  if (!reason || !startDate || !endDate) return res.status(400).json({ error: "Missing fields" });
  const u = db.getUser(req.session.user.id);
  const id = "LOA-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  const rec = {
    id, discordId: req.session.user.id, rpName: u?.rpName || req.session.user.username,
    reason: safe(reason, 500), startDate: safe(startDate, 20), endDate: safe(endDate, 20),
    createdAt: new Date().toISOString(),
  };
  db.insertLoa(rec);
  logAudit(req.session.user.username, "loa_submitted", id, safe(reason, 120));
  io.to("staff").emit("loa:new", { id, rpName: rec.rpName });
  res.json({ ok: true, id });
});

app.get("/api/admin/loa", requireRole("reviewer"), (req, res) => res.json(db.getAllLoa()));

app.post("/api/admin/loa/review", requireRole("reviewer"), (req, res) => {
  const { id, action } = req.body;
  if (!["approve", "deny"].includes(action)) return res.status(400).json({ error: "Invalid action" });
  const rec = db.getLoa(id);
  if (!rec) return res.status(404).json({ error: "Not found" });
  if (rec.status !== "pending") return res.status(400).json({ error: `Already ${rec.status}` });
  const status = action === "approve" ? "approved" : "denied";
  db.reviewLoaRecord(id, status, req.session.user.username);
  logAudit(req.session.user.username, action === "approve" ? "loa_approved" : "loa_denied", id, rec.rpName);
  io.to("staff").emit("loa:updated", { id, status });
  res.json({ ok: true });
});

// ── Activity points ──
app.get("/api/personnel/activity", requireAuth, (req, res) => {
  const u = db.getUser(req.session.user.id) || { points: 0, badges: [] };
  res.json({ points: u.points || 0, badges: u.badges || [], history: db.getActivityForUser(req.session.user.id) });
});

app.post("/api/admin/activity/adjust", requireRole("admin"), (req, res) => {
  const { discordId, delta, reason } = req.body;
  const amount = Number(delta);
  if (!discordId || !amount || !reason) return res.status(400).json({ error: "Missing fields" });
  const target = db.getUser(discordId);
  awardPoints(discordId, target?.rpName || discordId, amount, reason);
  logAudit(req.session.user.username, "points_adjusted", discordId, `${amount > 0 ? "+" : ""}${amount} — ${reason}`);
  res.json({ ok: true });
});

// ── Audit log ──
app.get("/api/admin/audit", requireRole("admin"), (req, res) => {
  const limit = Math.min(500, Math.max(1, +(req.query.limit || 100)));
  res.json(db.getRecentAudit(limit));
});

// ══════════════════════════════════════════════════════
// CONTROLS — maintenance mode, CSV export, emergency broadcast, backups
// ══════════════════════════════════════════════════════
app.get("/api/maintenance", (req, res) => res.json(db.getSettings()));

app.post("/api/admin/maintenance", requireRole("admin"), (req, res) => {
  const { enabled, message } = req.body;
  const settings = { maintenance: !!enabled, maintenanceMessage: safe(message || "", 300) };
  db.setSettings(settings);
  logAudit(req.session.user.username, enabled ? "maintenance_enabled" : "maintenance_disabled", "site", settings.maintenanceMessage);
  io.emit("maintenance:updated", settings); // public — visitors' pages may want to know too
  res.json({ ok: true });
});

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
app.get("/api/admin/export/applications.csv", requireRole("reviewer"), (req, res) => {
  const rows = db.getAllApplications();
  const cols = ["ref","fullName","discordUser","mcqScore","status","createdAt","reviewedAt","reviewedBy","notes",
                "mcq.q1","mcq.q2","mcq.q3","mcq.q4","mcq.q5","open.q6","open.q7","open.q8","open.q9","open.q10"];
  const lines = [cols.join(",")];
  for (const a of rows) {
    const flat = cols.map(c => {
      if (c.startsWith("mcq.")) return csvEscape(a.mcq?.[c.slice(4)]);
      if (c.startsWith("open.")) return csvEscape(a.open?.[c.slice(5)]);
      return csvEscape(a[c]);
    });
    lines.push(flat.join(","));
  }
  logAudit(req.session.user.username, "applications_exported", "csv", `${rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="applications-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));
});

app.post("/api/admin/broadcast", requireRole("admin"), async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message required" });
  try {
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error("Announce channel not found or not text based");
    const embed = new EmbedBuilder()
      .setColor(0xf59e0b).setTitle("📢 EMS Broadcast").setDescription(safe(message, 1800))
      .setFooter({ text: `Sent by ${req.session.user.username}` }).setTimestamp();
    await channel.send({ content: "@here", embeds: [embed] });
    logAudit(req.session.user.username, "broadcast_sent", "discord", safe(message, 200));
    res.json({ ok: true });
  } catch (err) {
    console.error("Broadcast error:", err.message);
    res.status(500).json({ error: "Failed to send broadcast" });
  }
});

// ── Backups ──
app.get("/api/admin/backups", requireRole("admin"), (req, res) => res.json(db.listBackups()));
app.post("/api/admin/backup", requireRole("admin"), (req, res) => {
  try {
    const result = db.backupNow("manual");
    logAudit(req.session.user.username, "backup_created", result.file, "manual");
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("Manual backup failed:", e.message);
    res.status(500).json({ error: "Backup failed" });
  }
});

// ══════════════════════════════════════════════════════
// REVIEW LOGIC (shared by web + Discord buttons)
// ══════════════════════════════════════════════════════
async function processReview(ref, action, reviewerTag, notes) {
  const data = db.getApplication(ref);
  if (!data) throw new Error("Application not found");
  if (data.status !== "pending") throw new Error(`Already ${data.status}`);

  data.status     = action === "accept" ? "approved" : "rejected";
  data.reviewedAt = new Date().toISOString();
  data.reviewedBy = reviewerTag || "System";
  if (notes) data.notes = safe(notes, 2000);
  db.upsertApplication(data);

  if (action === "accept") awardPoints(data.discordUser, data.fullName, 10, `Application ${ref} approved`);
  logAudit(reviewerTag || "System", action === "accept" ? "application_approved" : "application_rejected", ref, data.fullName);
  io.to("staff").emit("application:updated", { ref, status: data.status });

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
    if (interaction.deferred || interaction.replied) return;
    await interaction.deferUpdate();

    const [action, ref] = interaction.customId.split("_");
    if (!["accept", "reject"].includes(action) || !ref) return;

    const data = db.getApplication(ref);
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
    console.error("Interaction handling error:", err.message);
  }
});

process.on("unhandledRejection", (err) => console.error("⚠️  Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("⚠️  Uncaught exception:", err));

// ══════════════════════════════════════════════════════
// SOCKET.IO — live updates for staff
// ══════════════════════════════════════════════════════
io.on("connection", (socket) => {
  const sessUser = socket.request.session?.user;
  if (!sessUser || !hasRole(sessUser.id, "viewer")) { socket.disconnect(true); return; }
  socket.join("staff");
});

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
function maintenanceGate(req, res, next) {
  if (db.getSettings().maintenance) return res.status(503).sendFile(path.join(__dirname, "public", "maintenance.html"));
  next();
}
app.get("/",              maintenanceGate, (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/apply",         maintenanceGate, (_, res) => res.sendFile(path.join(__dirname, "public", "apply.html")));
app.get("/dashboard",     requireAuth, (req, res, next) => {
  if (!hasRole(req.session.user.id, "viewer")) return res.status(403).sendFile(path.join(__dirname, "public", "403.html"));
  next();
}, (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/personnel",     requireAuth, (req, res, next) => {
  if (!hasRole(req.session.user.id, "viewer")) return res.status(403).sendFile(path.join(__dirname, "public", "403.html"));
  next();
}, (_, res) => res.sendFile(path.join(__dirname, "public", "personnel.html")));
app.get("/handbook", (_, res) => res.sendFile(path.join(__dirname, "public", "documentation.html")));
app.get("/documentation", (_, res) => res.redirect(301, "/handbook"));

// ══════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  httpServer.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`📨 Review channel: ${REVIEW_CHANNEL_ID}`);
    console.log(`🌐 Apply URL: ${APPLY_URL}`);
    console.log(`🛡️  Owners: ${OWNER_IDS.join(", ") || "none configured"}`);
    console.log(`🗄️  Database: ${db.DB_PATH}`);
    console.log(`💾 Auto-backup every ${BACKUP_INTERVAL_HOURS}h → ${db.BACKUP_DIR}`);
    db.backupNow("startup");
    db.scheduleAutoBackups(BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
  });
});

client.login(TOKEN).catch(err => { console.error("❌ Login failed:", err.message); process.exit(1); });
