// ══════════════════════════════════════════════════════
// db.js — SQLite persistence layer (built-in node:sqlite, no native deps)
// ══════════════════════════════════════════════════════
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH  = path.join(DATA_DIR, "ems.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS applications (
  ref TEXT PRIMARY KEY,
  fullName TEXT, discordUser TEXT, mcqScore INTEGER,
  mcq TEXT, open TEXT, status TEXT, notes TEXT,
  createdAt TEXT, reviewedAt TEXT, reviewedBy TEXT
);
CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_created ON applications(createdAt);

CREATE TABLE IF NOT EXISTS users (
  discordId TEXT PRIMARY KEY,
  rpName TEXT, points INTEGER DEFAULT 0, badges TEXT DEFAULT '[]', role TEXT DEFAULT 'none'
);

CREATE TABLE IF NOT EXISTS handbook (id TEXT PRIMARY KEY, title TEXT, body TEXT, sortOrder INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sop (id TEXT PRIMARY KEY, category TEXT, title TEXT, body TEXT, sortOrder INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS schedule_claims (
  shiftId TEXT NOT NULL, discordId TEXT NOT NULL, PRIMARY KEY (shiftId, discordId)
);

CREATE TABLE IF NOT EXISTS loa (
  id TEXT PRIMARY KEY, discordId TEXT, rpName TEXT, reason TEXT,
  startDate TEXT, endDate TEXT, status TEXT,
  createdAt TEXT, reviewedAt TEXT, reviewedBy TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discordId TEXT, ts TEXT, delta INTEGER, reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(discordId);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, target TEXT, details TEXT
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// ── One-time migration from the old flat JSON files, if present and DB is empty ──
function migrateFromJSON() {
  const readJSON = (name, fallback) => {
    const f = path.join(DATA_DIR, name);
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8") || "null") ?? fallback : fallback; }
    catch { return fallback; }
  };

  const appCount = db.prepare("SELECT COUNT(*) c FROM applications").get().c;
  if (appCount === 0) {
    const apps = readJSON("applications.json", {});
    const insert = db.prepare(`INSERT OR REPLACE INTO applications
      (ref,fullName,discordUser,mcqScore,mcq,open,status,notes,createdAt,reviewedAt,reviewedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.exec("BEGIN");
    try {
      for (const a of Object.values(apps)) {
        insert.run(a.ref, a.fullName || "", a.discordUser || "", a.mcqScore || 0,
          JSON.stringify(a.mcq || {}), JSON.stringify(a.open || {}), (a.status || "pending").toLowerCase(),
          a.notes || "", a.createdAt || new Date().toISOString(), a.reviewedAt || null, a.reviewedBy || null);
      }
      db.exec("COMMIT");
      if (Object.keys(apps).length) console.log(`📦 Migrated ${Object.keys(apps).length} applications from JSON to SQLite`);
    } catch (e) { db.exec("ROLLBACK"); console.error("Migration (applications) failed:", e.message); }
  }

  const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (userCount === 0) {
    const users = readJSON("users.json", {});
    const insert = db.prepare(`INSERT OR REPLACE INTO users (discordId,rpName,points,badges,role) VALUES (?,?,?,?,?)`);
    for (const u of Object.values(users)) {
      insert.run(u.discordId, u.rpName || "", u.points || 0, JSON.stringify(u.badges || []), u.role || "none");
    }
    if (Object.keys(users).length) console.log(`📦 Migrated ${Object.keys(users).length} users from JSON to SQLite`);
  }

  const hbCount = db.prepare("SELECT COUNT(*) c FROM handbook").get().c;
  if (hbCount === 0) {
    const hb = readJSON("handbook.json", []);
    const insert = db.prepare(`INSERT OR REPLACE INTO handbook (id,title,body,sortOrder) VALUES (?,?,?,?)`);
    hb.forEach((h, i) => insert.run(h.id, h.title, h.body, i));
  }

  const sopCount = db.prepare("SELECT COUNT(*) c FROM sop").get().c;
  if (sopCount === 0) {
    const sop = readJSON("sop.json", []);
    const insert = db.prepare(`INSERT OR REPLACE INTO sop (id,category,title,body,sortOrder) VALUES (?,?,?,?,?)`);
    sop.forEach((s, i) => insert.run(s.id, s.category, s.title, s.body, i));
  }

  const schedCount = db.prepare("SELECT COUNT(*) c FROM schedule_claims").get().c;
  if (schedCount === 0) {
    const sched = readJSON("schedule.json", {});
    const insert = db.prepare(`INSERT OR IGNORE INTO schedule_claims (shiftId,discordId) VALUES (?,?)`);
    for (const [shiftId, ids] of Object.entries(sched)) for (const id of ids) insert.run(shiftId, id);
  }

  const loaCount = db.prepare("SELECT COUNT(*) c FROM loa").get().c;
  if (loaCount === 0) {
    const loa = readJSON("loa.json", {});
    const insert = db.prepare(`INSERT OR REPLACE INTO loa
      (id,discordId,rpName,reason,startDate,endDate,status,createdAt,reviewedAt,reviewedBy) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const l of Object.values(loa)) {
      insert.run(l.id, l.discordId, l.rpName, l.reason, l.startDate, l.endDate, l.status, l.createdAt, l.reviewedAt || null, l.reviewedBy || null);
    }
  }

  const actCount = db.prepare("SELECT COUNT(*) c FROM activity").get().c;
  if (actCount === 0) {
    const act = readJSON("activity.json", {});
    const insert = db.prepare(`INSERT INTO activity (discordId,ts,delta,reason) VALUES (?,?,?,?)`);
    for (const [discordId, entries] of Object.entries(act)) for (const e of entries) insert.run(discordId, e.ts, e.delta, e.reason);
  }

  const auditCount = db.prepare("SELECT COUNT(*) c FROM audit").get().c;
  if (auditCount === 0) {
    const audit = readJSON("audit.json", []);
    const insert = db.prepare(`INSERT INTO audit (ts,actor,action,target,details) VALUES (?,?,?,?,?)`);
    for (const e of audit) insert.run(e.ts, e.actor, e.action, e.target, e.details);
  }

  const settingsCount = db.prepare("SELECT COUNT(*) c FROM settings").get().c;
  if (settingsCount === 0) {
    const s = readJSON("settings.json", { maintenance: false, maintenanceMessage: "" });
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('maintenance',?)`).run(JSON.stringify(!!s.maintenance));
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('maintenanceMessage',?)`).run(s.maintenanceMessage || "");
  }
}
migrateFromJSON();

// ══════════════════════════════════════════════════════
// Applications
// ══════════════════════════════════════════════════════
function rowToApp(r) {
  if (!r) return null;
  return { ...r, mcq: JSON.parse(r.mcq || "{}"), open: JSON.parse(r.open || "{}") };
}
function getApplication(ref) { return rowToApp(db.prepare("SELECT * FROM applications WHERE ref = ?").get(ref)); }
function getAllApplications() { return db.prepare("SELECT * FROM applications").all().map(rowToApp); }
function upsertApplication(a) {
  db.prepare(`INSERT INTO applications (ref,fullName,discordUser,mcqScore,mcq,open,status,notes,createdAt,reviewedAt,reviewedBy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ref) DO UPDATE SET fullName=excluded.fullName, discordUser=excluded.discordUser,
      mcqScore=excluded.mcqScore, mcq=excluded.mcq, open=excluded.open, status=excluded.status,
      notes=excluded.notes, reviewedAt=excluded.reviewedAt, reviewedBy=excluded.reviewedBy`)
    .run(a.ref, a.fullName, a.discordUser, a.mcqScore, JSON.stringify(a.mcq || {}), JSON.stringify(a.open || {}),
         a.status, a.notes || "", a.createdAt, a.reviewedAt || null, a.reviewedBy || null);
}
function updateApplicationNotes(ref, notes) {
  db.prepare("UPDATE applications SET notes = ? WHERE ref = ?").run(notes, ref);
}
function queryApplications({ status = "all", search = "", sort = "new", page = 1, limit = 20 }) {
  const where = [], params = [];
  if (status !== "all") { where.push("status = ?"); params.push(status.toLowerCase()); }
  if (search) { where.push("(fullName LIKE ? OR discordUser LIKE ? OR ref LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const orderSql = sort === "old" ? "ORDER BY createdAt ASC" : sort === "score" ? "ORDER BY mcqScore DESC" : "ORDER BY createdAt DESC";
  const total = db.prepare(`SELECT COUNT(*) c FROM applications ${whereSql}`).get(...params).c;
  const p = Math.max(1, +page), lim = Math.min(100, Math.max(1, +limit));
  const data = db.prepare(`SELECT * FROM applications ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, lim, (p - 1) * lim).map(rowToApp);
  return { total, page: p, data };
}
function applicationStats() {
  const rows = db.prepare("SELECT status, COUNT(*) c, AVG(mcqScore) avgScore FROM applications GROUP BY status").all();
  const byStatus = Object.fromEntries(rows.map(r => [r.status, r.c]));
  const total = db.prepare("SELECT COUNT(*) c FROM applications").get().c;
  const avg = db.prepare("SELECT AVG(mcqScore) a FROM applications").get().a;
  return {
    total, pending: byStatus.pending || 0, approved: byStatus.approved || 0, rejected: byStatus.rejected || 0,
    avgScore: avg ? avg.toFixed(1) : 0,
  };
}

// ══════════════════════════════════════════════════════
// Users
// ══════════════════════════════════════════════════════
function rowToUser(r) { return r ? { ...r, badges: JSON.parse(r.badges || "[]") } : null; }
function getUser(discordId) { return rowToUser(db.prepare("SELECT * FROM users WHERE discordId = ?").get(discordId)); }
function getAllUsersMap() {
  const out = {};
  for (const r of db.prepare("SELECT * FROM users").all()) out[r.discordId] = rowToUser(r);
  return out;
}
function getAllUsers() { return db.prepare("SELECT * FROM users").all().map(rowToUser); }
function upsertUser(u) {
  db.prepare(`INSERT INTO users (discordId,rpName,points,badges,role) VALUES (?,?,?,?,?)
    ON CONFLICT(discordId) DO UPDATE SET rpName=excluded.rpName, points=excluded.points,
      badges=excluded.badges, role=excluded.role`)
    .run(u.discordId, u.rpName || "", u.points || 0, JSON.stringify(u.badges || []), u.role || "none");
}
function setUserRole(discordId, role) { db.prepare("UPDATE users SET role = ? WHERE discordId = ?").run(role, discordId); }
function addUserPoints(discordId, amount) {
  db.prepare("UPDATE users SET points = points + ? WHERE discordId = ?").run(amount, discordId);
  return getUser(discordId);
}

// ══════════════════════════════════════════════════════
// Handbook / SOP
// ══════════════════════════════════════════════════════
function getHandbook() { return db.prepare("SELECT id,title,body FROM handbook ORDER BY sortOrder").all(); }
function getSop() { return db.prepare("SELECT id,category,title,body FROM sop ORDER BY sortOrder").all(); }

// ══════════════════════════════════════════════════════
// Duty schedule
// ══════════════════════════════════════════════════════
function getScheduleClaims() {
  const out = {};
  for (const r of db.prepare("SELECT shiftId, discordId FROM schedule_claims").all()) {
    (out[r.shiftId] ||= []).push(r.discordId);
  }
  return out;
}
function claimShift(shiftId, discordId) { db.prepare("INSERT OR IGNORE INTO schedule_claims (shiftId,discordId) VALUES (?,?)").run(shiftId, discordId); }
function unclaimShift(shiftId, discordId) { db.prepare("DELETE FROM schedule_claims WHERE shiftId = ? AND discordId = ?").run(shiftId, discordId); }
function shiftClaimCount(shiftId) { return db.prepare("SELECT COUNT(*) c FROM schedule_claims WHERE shiftId = ?").get(shiftId).c; }
function isShiftClaimedBy(shiftId, discordId) { return !!db.prepare("SELECT 1 FROM schedule_claims WHERE shiftId = ? AND discordId = ?").get(shiftId, discordId); }

// ══════════════════════════════════════════════════════
// LOA
// ══════════════════════════════════════════════════════
function getLoa(id) { return db.prepare("SELECT * FROM loa WHERE id = ?").get(id); }
function getLoaForUser(discordId) { return db.prepare("SELECT * FROM loa WHERE discordId = ? ORDER BY createdAt DESC").all(discordId); }
function getAllLoa() { return db.prepare("SELECT * FROM loa ORDER BY createdAt DESC").all(); }
function insertLoa(l) {
  db.prepare(`INSERT INTO loa (id,discordId,rpName,reason,startDate,endDate,status,createdAt) VALUES (?,?,?,?,?,?,?,?)`)
    .run(l.id, l.discordId, l.rpName, l.reason, l.startDate, l.endDate, "pending", l.createdAt);
}
function reviewLoaRecord(id, status, reviewedBy) {
  db.prepare("UPDATE loa SET status=?, reviewedAt=?, reviewedBy=? WHERE id=?").run(status, new Date().toISOString(), reviewedBy, id);
}

// ══════════════════════════════════════════════════════
// Activity ledger
// ══════════════════════════════════════════════════════
function addActivityEntry(discordId, delta, reason) {
  db.prepare("INSERT INTO activity (discordId,ts,delta,reason) VALUES (?,?,?,?)").run(discordId, new Date().toISOString(), delta, reason);
}
function getActivityForUser(discordId) {
  return db.prepare("SELECT ts,delta,reason FROM activity WHERE discordId = ? ORDER BY id DESC").all(discordId);
}

// ══════════════════════════════════════════════════════
// Audit log
// ══════════════════════════════════════════════════════
function addAuditEntry(actor, action, target, details) {
  db.prepare("INSERT INTO audit (ts,actor,action,target,details) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), actor, action, target, details);
}
function getRecentAudit(limit = 100) {
  return db.prepare("SELECT ts,actor,action,target,details FROM audit ORDER BY id DESC LIMIT ?").all(limit);
}

// ══════════════════════════════════════════════════════
// Settings (maintenance mode, etc.)
// ══════════════════════════════════════════════════════
function getSettings() {
  const rows = db.prepare("SELECT key,value FROM settings").all();
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { maintenance: m.maintenance === "true", maintenanceMessage: m.maintenanceMessage || "" };
}
function setSettings({ maintenance, maintenanceMessage }) {
  db.prepare("INSERT INTO settings (key,value) VALUES ('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(!!maintenance));
  db.prepare("INSERT INTO settings (key,value) VALUES ('maintenanceMessage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(maintenanceMessage || "");
}

// ══════════════════════════════════════════════════════
// Backups
// ══════════════════════════════════════════════════════
const BACKUP_RETENTION = 30; // keep the last N backups
function backupNow(reason = "scheduled") {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // fold the WAL into the main file before copying
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `ems-${stamp}.db`);
  fs.copyFileSync(DB_PATH, dest);

  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".db")).sort();
  while (files.length > BACKUP_RETENTION) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));

  console.log(`💾 Backup created (${reason}): ${path.basename(dest)}`);
  return { file: path.basename(dest), createdAt: new Date().toISOString() };
}
function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".db")).sort().reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, createdAt: stat.mtime.toISOString() };
    });
}
function scheduleAutoBackups(intervalMs) {
  setInterval(() => { try { backupNow("automatic"); } catch (e) { console.error("Auto-backup failed:", e.message); } }, intervalMs);
}

module.exports = {
  db, migrateFromJSON,
  getApplication, getAllApplications, upsertApplication, updateApplicationNotes, queryApplications, applicationStats,
  getUser, getAllUsersMap, getAllUsers, upsertUser, setUserRole, addUserPoints,
  getHandbook, getSop,
  getScheduleClaims, claimShift, unclaimShift, shiftClaimCount, isShiftClaimedBy,
  getLoa, getLoaForUser, getAllLoa, insertLoa, reviewLoaRecord,
  addActivityEntry, getActivityForUser,
  addAuditEntry, getRecentAudit,
  getSettings, setSettings,
  backupNow, listBackups, scheduleAutoBackups,
  DB_PATH, BACKUP_DIR,
};
