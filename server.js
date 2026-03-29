require('dotenv').config();

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || "./applications.json";
const CONTENT_FILE = "./content.json";
const VISITS_FILE = "./visits.json";

let fetchPolyfill;
(async () => {
  if (typeof globalThis.fetch === "function") {
    fetchPolyfill = globalThis.fetch.bind(globalThis);
    console.log(`✅ Built-in fetch (Node ${process.version})`);
  } else {
    try {
      const nf = await import("node-fetch");
      fetchPolyfill = nf.default;
      console.log("ℹ️ Using node-fetch polyfill");
    } catch {
      console.error("❌ No fetch. Install node-fetch or use Node 18+");
      process.exit(1);
    }
  }
})();

const WEBHOOK = "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "EMS_CHANGE_ME";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 4 * 60 * 60 * 1000,
    },
  })
);

app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ---------- JSON Storage ----------
function loadApps() {
  try {
    if (!fs.existsSync(DATA)) return [];
    return JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch {
    return [];
  }
}

function saveApps(apps) {
  fs.writeFileSync(DATA, JSON.stringify(apps, null, 2), "utf8");
}

function appendApp(entry) {
  const apps = loadApps();
  apps.push(entry);
  saveApps(apps);
  return apps.length;
}

// ---------- Content ----------
function loadContent() {
  try {
    if (!fs.existsSync(CONTENT_FILE)) {
      const def = {
        heroTitleRed: "EMS ABRAMS",
        heroTitleBlue: "EMERGENCY MEDICAL SERVICES",
        heroSub: "فريق الخدمات الطبية الطارئة في عالم الـ Roleplay.<br/><strong>نحن لا نلعب — نحن ننقذ الأرواح.</strong>",
        aboutText1: "نحن فريق الخدمات الطبية الطارئة الأكثر احترافية في السيرفر.",
        aboutText2: "أعضاؤنا مدربون على أعلى مستوى من الـ Medical RP.",
        statMembers: "52",
        statMissions: "587",
      };
      fs.writeFileSync(CONTENT_FILE, JSON.stringify(def, null, 2));
      return def;
    }
    return JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveContent(c) {
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(c, null, 2));
}

// ---------- Visits ----------
function loadVisits() {
  try {
    if (!fs.existsSync(VISITS_FILE)) return { total: 0, daily: {} };
    return JSON.parse(fs.readFileSync(VISITS_FILE, "utf8"));
  } catch {
    return { total: 0, daily: {} };
  }
}

function recordVisit() {
  const v = loadVisits();
  v.total = (v.total || 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  v.daily[today] = (v.daily[today] || 0) + 1;
  fs.writeFileSync(VISITS_FILE, JSON.stringify(v, null, 2));
  return v;
}

app.use((req, res, next) => {
  if (req.path === "/" && req.method === "GET") recordVisit();
  next();
});

// ---------- Rate limiting for submissions ----------
const ipBuckets = new Map();
const didBuckets = new Map();

function checkRateLimit(ip, discordId) {
  const now = Date.now();
  const ipHits = (ipBuckets.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (ipHits.length >= 2) return { blocked: true, reason: "ip" };
  ipHits.push(now);
  ipBuckets.set(ip, ipHits);
  const didHits = (didBuckets.get(discordId) || []).filter((t) => now - t < 30 * 60 * 1000);
  if (didHits.length >= 1) return { blocked: true, reason: "discord_id" };
  didHits.push(now);
  didBuckets.set(discordId, didHits);
  return { blocked: false };
}

function hasPendingApp(discordId) {
  return loadApps().some((a) => a.discordUser === discordId && a.status === "pending");
}

function safe(s = "", max = 1024) {
  return String(s)
    .replace(/`/g, "'")
    .replace(/@(everyone|here|&)/gi, "@\u200b$1")
    .trim()
    .slice(0, max) || "—";
}

// ---------- Validation ----------
const MCQ_KEYS = ["q1", "q2", "q3", "q4", "q5"];
const OPEN_KEYS = ["q6", "q7", "q8", "q9", "q10"];
const CORRECT = { q1: "B", q2: "C", q3: "B", q4: "B", q5: "B" };

function validate(body) {
  const errors = [];
  if (!body.fullName?.trim()) errors.push("fullName required");
  if (!body.discordUser?.trim()) errors.push("discordUser required");
  if (!/^\d{17,19}$/.test(body.discordUser?.trim() || "")) errors.push("discordUser invalid");
  for (const k of MCQ_KEYS) if (!body.mcq?.[k]) errors.push(`MCQ ${k} missing`);
  for (const k of OPEN_KEYS) if (!body.open?.[k]?.trim()) errors.push(`Open ${k} empty`);
  const score = Number(body.mcqScore ?? -1);
  if (!Number.isInteger(score) || score < 0 || score > 5) errors.push("mcqScore invalid");
  return errors;
}

function genRef() {
  return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ---------- Discord webhook ----------
async function postToDiscord(payload) {
  if (!WEBHOOK || !fetchPolyfill) return;
  const res = await fetchPolyfill(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
}

function buildEmbed(p, score, ref) {
  const color = score === 5 ? 0x10b981 : score >= 3 ? 0xf59e0b : 0xe8304a;
  return {
    embeds: [{
      title: "🚑 New EMS Application",
      color,
      timestamp: new Date().toISOString(),
      footer: { text: `REF: ${ref}` },
      fields: [
        { name: "👤 RP Name", value: safe(p.fullName, 100), inline: true },
        { name: "💬 Discord ID", value: safe(p.discordUser, 100), inline: true },
        { name: "🧠 MCQ Score", value: `${score} / 5`, inline: true },
        { name: "🔖 Ref", value: `\`${ref}\``, inline: true },
        ...OPEN_KEYS.map((k) => ({
          name: `Q${k.slice(1)}`,
          value: safe(p.open?.[k], 800),
          inline: false,
        })),
      ],
    }],
  };
}

// ---------- Submit ----------
app.post("/submit", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const discordId = req.body?.discordUser?.trim() || "";

  const limit = checkRateLimit(ip, discordId);
  if (limit.blocked) return res.status(429).json({ error: "Too many requests. Please wait." });
  if (hasPendingApp(discordId)) return res.status(409).json({ error: "You already have a pending application." });

  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

  const p = req.body;
  const score = MCQ_KEYS.filter((k) => p.mcq[k] === CORRECT[k]).length;
  const refCode = genRef();
  const entry = {
    ref: refCode,
    status: "pending",
    submittedAt: new Date().toISOString(),
    ip,
    fullName: safe(p.fullName, 100),
    discordUser: safe(p.discordUser, 100),
    mcqScore: score,
    mcq: Object.fromEntries(MCQ_KEYS.map((k) => [k, p.mcq[k]])),
    open: Object.fromEntries(OPEN_KEYS.map((k) => [k, safe(p.open[k], 2000)])),
    notes: "",
  };

  try {
    const total = appendApp(entry);
    console.log(`[submit] #${total} ${entry.fullName} score:${score} ref:${refCode}`);
   // if (WEBHOOK) postToDiscord(buildEmbed(p, score, refCode)).catch((e) => console.error("[discord]", e.message));
    res.json({ ok: true, ref: refCode });
  } catch (err) {
    console.error("[submit] error:", err.message);
    res.status(500).json({ error: "Failed to save application." });
  }
});

// ---------- Admin Auth — FIXED ----------
const loginAttempts = new Map();

// Only CHECKS — does NOT record
function checkLoginAttempts(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  return attempts.length < 5;
}

// Only records FAILED attempts
function recordFailedAttempt(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.push(now);
  loginAttempts.set(ip, attempts);
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.post("/admin/login", (req, res) => {
  const ip = req.ip;

  // Check BEFORE doing anything
  if (!checkLoginAttempts(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const { password, rememberMe } = req.body;

  // Wrong password → record failure
  if (!password || password !== ADMIN_PASSWORD) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: "Wrong password" });
  }

  // Success → NO recording, just create session
  req.session.isAdmin = true;
  req.session.cookie.maxAge = rememberMe
    ? 7 * 24 * 60 * 60 * 1000
    : 4 * 60 * 60 * 1000;
  res.json({ ok: true });
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ---------- Admin API ----------
app.get("/admin/api/stats", requireAdmin, (req, res) => {
  const apps = loadApps();
  const total = apps.length;
  const pending = apps.filter((a) => a.status === "pending").length;
  const approved = apps.filter((a) => a.status === "approved").length;
  const rejected = apps.filter((a) => a.status === "rejected").length;
  const avgScore = total ? (apps.reduce((s, a) => s + (a.mcqScore || 0), 0) / total).toFixed(2) : 0;
  const visits = loadVisits();
  const today = new Date().toISOString().slice(0, 10);
  res.json({ total, pending, approved, rejected, avgScore, visits: { total: visits.total, today: visits.daily[today] || 0 } });
});

app.get("/admin/api/apps", requireAdmin, (req, res) => {
  let apps = loadApps();
  const { search = "", status = "", page = "1", limit = "20" } = req.query;
  if (status) apps = apps.filter((a) => a.status === status);
  if (search) {
    const q = search.toLowerCase();
    apps = apps.filter((a) =>
      a.fullName.toLowerCase().includes(q) ||
      a.discordUser.toLowerCase().includes(q) ||
      a.ref.toLowerCase().includes(q)
    );
  }
  apps = apps.reverse();
  const total = apps.length;
  const pageNum = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
  const start = (pageNum - 1) * pageSize;
  res.json({ total, page: pageNum, pageSize, items: apps.slice(start, start + pageSize) });
});

app.get("/admin/api/apps/:ref", requireAdmin, (req, res) => {
  const a = loadApps().find((x) => x.ref === req.params.ref);
  if (!a) return res.status(404).json({ error: "Not found" });
  res.json(a);
});

app.patch("/admin/api/apps/:ref", requireAdmin, (req, res) => {
  const apps = loadApps();
  const idx = apps.findIndex((a) => a.ref === req.params.ref);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const { status, notes } = req.body;
  if (status && !["pending", "approved", "rejected"].includes(status))
    return res.status(400).json({ error: "Invalid status" });
  if (status !== undefined) apps[idx].status = status;
  if (notes !== undefined) apps[idx].notes = safe(notes, 500);
  apps[idx].updatedAt = new Date().toISOString();
  saveApps(apps);
  res.json({ ok: true, app: apps[idx] });
});

app.delete("/admin/api/apps/:ref", requireAdmin, (req, res) => {
  const apps = loadApps();
  const filtered = apps.filter((a) => a.ref !== req.params.ref);
  if (filtered.length === apps.length) return res.status(404).json({ error: "Not found" });
  saveApps(filtered);
  res.json({ ok: true });
});

app.get("/admin/api/export", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="ems-apps-${Date.now()}.json"`);
  res.send(JSON.stringify(loadApps(), null, 2));
});

app.get("/api/content", (req, res) => res.json(loadContent()));

app.put("/api/content", requireAdmin, (req, res) => {
  try {
    saveContent(req.body);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save content" });
  }
});

// ---------- Admin Dashboard HTML ----------
app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EMS Abrams — لوحة التحكم</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080b15;font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;min-height:100vh}
.login-wrap{display:flex;justify-content:center;align-items:center;min-height:100vh;background:radial-gradient(circle at 20% 30%,#1e1b2e,#080b15)}
.login-box{background:rgba(15,18,34,.95);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:44px 40px;width:100%;max-width:400px;text-align:center}
.login-icon{font-size:52px;margin-bottom:18px}
.login-box h1{font-size:28px;margin-bottom:8px}
.login-box p{color:#8892b0;margin-bottom:26px;font-size:14px}
.login-box input[type=password]{width:100%;padding:13px 14px;border-radius:12px;border:1px solid #2d3260;background:#0c1020;color:#fff;font-size:15px;margin-bottom:14px;outline:none;transition:.2s}
.login-box input[type=password]:focus{border-color:#e11d48}
.remember{display:flex;align-items:center;gap:8px;margin-bottom:18px;font-size:13px;color:#8892b0;cursor:pointer}
.login-box .login-btn{width:100%;padding:13px;background:linear-gradient(135deg,#e11d48,#9b1235);border:none;border-radius:12px;color:#fff;font-weight:700;font-size:15px;cursor:pointer;transition:.2s}
.login-box .login-btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(225,29,72,.3)}
.err{color:#f87171;margin-top:12px;font-size:13px;min-height:18px}
.dashboard{display:none;flex-direction:column;min-height:100vh}
.topbar{background:#0c1020;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1a1f3a;position:sticky;top:0;z-index:10}
.topbar h2{font-size:17px;color:#fff}
.topbar-right{display:flex;align-items:center;gap:10px}
.btn{padding:8px 16px;border-radius:10px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:.2s}
.btn:hover{transform:translateY(-1px)}
.btn-danger{background:#e11d48;color:#fff}
.btn-blue{background:#3b82f6;color:#fff}
.btn-amber{background:#f59e0b;color:#1a1200}
.btn-green{background:#10b981;color:#fff}
.btn-gray{background:#1e2540;color:#ccd;border:1px solid #2d3260}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:14px;padding:20px 24px 0}
.stat-card{background:#0c1020;border:1px solid #1a1f3a;border-radius:16px;padding:18px;text-align:center}
.stat-val{font-size:30px;font-weight:800;color:#e11d48}
.stat-lbl{color:#7a8ab0;margin-top:6px;font-size:12px}
.controls{padding:16px 24px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #1a1f3a}
.controls input,.controls select{padding:9px 12px;border-radius:10px;background:#0c1020;border:1px solid #2d3260;color:#fff;font-size:13px;outline:none}
.controls input:focus{border-color:#3b82f6}
table{width:calc(100% - 48px);margin:20px 24px;border-collapse:collapse;font-size:13px}
th,td{text-align:right;padding:11px 12px;border-bottom:1px solid #1a1f3a}
th{color:#7a8ab0;font-weight:500;background:#0c1020;position:sticky;top:57px}
tr:hover td{background:rgba(255,255,255,.02)}
.badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
.badge-pending{background:rgba(245,158,11,.15);color:#f59e0b}
.badge-approved{background:rgba(16,185,129,.15);color:#10b981}
.badge-rejected{background:rgba(239,68,68,.15);color:#ef4444}
.acts button{background:none;border:none;color:#7a8ab0;cursor:pointer;padding:4px 7px;border-radius:6px;font-size:12px;transition:.15s}
.acts button:hover{background:#1a1f3a;color:#fff}
.pagination{display:flex;justify-content:center;gap:8px;padding:20px}
.pagination button{background:#0c1020;border:1px solid #2d3260;padding:6px 13px;border-radius:8px;color:#ccd;cursor:pointer;font-size:13px;transition:.15s}
.pagination button.active,.pagination button:hover{background:#e11d48;border-color:#e11d48;color:#fff}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;justify-content:center;align-items:center}
.modal-bg.open{display:flex}
.modal{background:#0d1122;border:1px solid #1e2540;border-radius:20px;width:90%;max-width:640px;max-height:85vh;overflow:auto;padding:26px}
.modal-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.modal-hdr h3{font-size:17px}
.close-btn{background:none;border:none;color:#7a8ab0;font-size:24px;cursor:pointer;line-height:1}
.close-btn:hover{color:#fff}
.field-row{display:grid;grid-template-columns:130px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px}
.field-row:last-of-type{border:none}
.field-key{color:#7a8ab0;font-size:12px}
.field-val{color:#dce9f6;word-break:break-word;white-space:pre-wrap;line-height:1.6}
.notes-ta{width:100%;margin-top:10px;padding:12px;border-radius:10px;background:#080b15;border:1px solid #2d3260;color:#fff;font-size:13px;resize:vertical;outline:none}
.notes-ta:focus{border-color:#3b82f6}
.modal-acts{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.content-grid{display:grid;gap:12px}
.content-field label{font-size:11px;color:#7a8ab0;letter-spacing:.8px;text-transform:uppercase;display:block;margin-bottom:6px}
.content-field textarea{width:100%;padding:10px 12px;border-radius:10px;background:#080b15;border:1px solid #2d3260;color:#fff;font-size:13px;resize:vertical;outline:none;line-height:1.6}
.content-field textarea:focus{border-color:#f59e0b}
.empty-row td{text-align:center;padding:32px;color:#4a5580}
</style>
</head>
<body>

<!-- LOGIN -->
<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <div class="login-icon">🚑</div>
    <h1>EMS Admin Panel</h1>
    <p>أدخل كلمة المرور للدخول</p>
    <input type="password" id="pwInput" placeholder="كلمة المرور" onkeydown="if(event.key==='Enter')doLogin()">
    <label class="remember"><input type="checkbox" id="rememberMe"> تذكرني لمدة 7 أيام</label>
    <button class="login-btn" onclick="doLogin()">تسجيل الدخول</button>
    <div class="err" id="loginErr"></div>
  </div>
</div>

<!-- DASHBOARD -->
<div class="dashboard" id="dashboard">
  <div class="topbar">
    <h2>🚑 EMS Abrams — لوحة التحكم</h2>
    <div class="topbar-right">
      <button class="btn btn-amber" onclick="openContentEditor()">✏️ تعديل المحتوى</button>
      <button class="btn btn-blue" onclick="exportData()">⬇ تصدير JSON</button>
      <button class="btn btn-danger" onclick="doLogout()">تسجيل الخروج</button>
    </div>
  </div>

  <div class="stats" id="statsGrid"></div>

  <div class="controls">
    <input type="text" id="search" placeholder="بحث بالاسم، Discord، أو الرمز..." oninput="debounce()">
    <select id="statusFilter" onchange="loadApps(1)">
      <option value="">جميع الحالات</option>
      <option value="pending">قيد الانتظار</option>
      <option value="approved">مقبول</option>
      <option value="rejected">مرفوض</option>
    </select>
    <button class="btn btn-gray" onclick="loadApps(1)">🔄 تحديث</button>
  </div>

  <table>
    <thead><tr>
      <th>الرمز</th><th>الاسم</th><th>Discord ID</th>
      <th>الدرجة</th><th>الحالة</th><th>التاريخ</th><th>إجراءات</th>
    </tr></thead>
    <tbody id="appsBody"></tbody>
  </table>
  <div class="pagination" id="pager"></div>
</div>

<!-- APP DETAIL MODAL -->
<div class="modal-bg" id="detailModal">
  <div class="modal">
    <div class="modal-hdr">
      <h3 id="modalTitle">تفاصيل الطلب</h3>
      <button class="close-btn" onclick="closeModal('detailModal')">×</button>
    </div>
    <div id="modalBody"></div>
    <div class="modal-acts">
      <button class="btn btn-green" onclick="setStatus('approved')">✓ قبول</button>
      <button class="btn btn-danger" onclick="setStatus('rejected')">✗ رفض</button>
      <button class="btn btn-blue" onclick="saveNotes()">💾 حفظ الملاحظات</button>
    </div>
  </div>
</div>

<!-- CONTENT EDITOR MODAL -->
<div class="modal-bg" id="contentModal">
  <div class="modal" style="max-width:760px">
    <div class="modal-hdr">
      <h3>✏️ تعديل محتوى الصفحة الرئيسية</h3>
      <button class="close-btn" onclick="closeModal('contentModal')">×</button>
    </div>
    <div class="content-grid" id="contentGrid"></div>
    <div class="modal-acts" style="margin-top:20px">
      <button class="btn btn-green" onclick="saveContent()">💾 حفظ التغييرات</button>
    </div>
  </div>
</div>

<script>
const MCQ_KEYS = ['q1','q2','q3','q4','q5'];
const OPEN_KEYS = ['q6','q7','q8','q9','q10'];
let activeRef = null;
let debTimer;

function esc(s){
  if(!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function doLogin(){
  const pw = document.getElementById('pwInput').value;
  const rem = document.getElementById('rememberMe').checked;
  document.getElementById('loginErr').textContent = '';
  const r = await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,rememberMe:rem})});
  const d = await r.json();
  if(r.ok){
    document.getElementById('loginWrap').style.display='none';
    document.getElementById('dashboard').style.display='flex';
    loadStats();
    loadApps(1);
  } else {
    document.getElementById('loginErr').textContent = d.error || 'كلمة المرور خاطئة';
    document.getElementById('pwInput').value='';
  }
}

async function doLogout(){
  await fetch('/admin/logout',{method:'POST'});
  location.reload();
}

function handleUnauth(res){
  if(res.status===401){
    document.getElementById('dashboard').style.display='none';
    document.getElementById('loginWrap').style.display='flex';
    document.getElementById('loginErr').textContent='انتهت جلسة العمل. يرجى تسجيل الدخول مجدداً.';
    return true;
  }
  return false;
}

async function loadStats(){
  const r = await fetch('/admin/api/stats');
  if(handleUnauth(r)) return;
  const s = await r.json();
  document.getElementById('statsGrid').innerHTML = \`
    <div class="stat-card"><div class="stat-val">\${s.total}</div><div class="stat-lbl">إجمالي الطلبات</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#f59e0b">\${s.pending}</div><div class="stat-lbl">قيد الانتظار</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#10b981">\${s.approved}</div><div class="stat-lbl">مقبول</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#ef4444">\${s.rejected}</div><div class="stat-lbl">مرفوض</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#3b82f6">\${s.avgScore}/5</div><div class="stat-lbl">متوسط الدرجة</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#a78bfa">\${s.visits.total}</div><div class="stat-lbl">إجمالي الزيارات</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#f472b6">\${s.visits.today}</div><div class="stat-lbl">زيارات اليوم</div></div>
  \`;
}

async function loadApps(page=1){
  const search = document.getElementById('search').value;
  const status = document.getElementById('statusFilter').value;
  const r = await fetch(\`/admin/api/apps?search=\${encodeURIComponent(search)}&status=\${status}&page=\${page}&limit=20\`);
  if(handleUnauth(r)) return;
  const data = await r.json();
  renderTable(data.items);
  renderPager(data.total, data.page, data.pageSize);
}

function renderTable(apps){
  const tb = document.getElementById('appsBody');
  if(!apps.length){
    tb.innerHTML='<tr class="empty-row"><td colspan="7">لا توجد طلبات</td></tr>';
    return;
  }
  tb.innerHTML = apps.map(a=>\`
    <tr>
      <td style="font-family:monospace;font-size:12px">\${a.ref}</td>
      <td>\${esc(a.fullName)}</td>
      <td style="font-family:monospace;font-size:12px">\${esc(a.discordUser)}</td>
      <td><strong>\${a.mcqScore}/5</strong></td>
      <td><span class="badge badge-\${a.status}">\${a.status==='pending'?'قيد الانتظار':a.status==='approved'?'مقبول':'مرفوض'}</span></td>
      <td style="font-size:12px;color:#7a8ab0">\${new Date(a.submittedAt).toLocaleString('ar')}</td>
      <td class="acts">
        <button onclick="viewApp('\${a.ref}')">عرض</button>
        \${a.status!=='approved'?'<button onclick="quickSet(\''+a.ref+'\',\'approved\')">قبول</button>':''}
        \${a.status!=='rejected'?'<button onclick="quickSet(\''+a.ref+'\',\'rejected\')">رفض</button>':''}
        <button onclick="delApp('\${a.ref}')" style="color:#f87171">حذف</button>
      </td>
    </tr>
  \`).join('');
}

function renderPager(total, page, size){
  const pages = Math.ceil(total/size);
  if(pages<=1){document.getElementById('pager').innerHTML='';return;}
  let h='';
  if(page>1) h+=\`<button onclick="loadApps(\${page-1})">← السابق</button>\`;
  for(let i=Math.max(1,page-2);i<=Math.min(pages,page+2);i++){
    h+=\`<button class="\${i===page?'active':''}" onclick="loadApps(\${i})">\${i}</button>\`;
  }
  if(page<pages) h+=\`<button onclick="loadApps(\${page+1})">التالي →</button>\`;
  document.getElementById('pager').innerHTML=h;
}

async function viewApp(ref){
  const r = await fetch('/admin/api/apps/'+ref);
  if(handleUnauth(r)) return;
  const a = await r.json();
  activeRef = ref;
  document.getElementById('modalTitle').textContent = 'الطلب — '+a.ref;
  const mcqH = MCQ_KEYS.map(k=>\`<div class="field-row"><div class="field-key">س\${k.slice(1)} (MCQ)</div><div class="field-val">\${esc(a.mcq?.[k]||'—')}</div></div>\`).join('');
  const openH = OPEN_KEYS.map(k=>\`<div class="field-row"><div class="field-key">س\${k.slice(1)}</div><div class="field-val">\${esc(a.open?.[k]||'—')}</div></div>\`).join('');
  document.getElementById('modalBody').innerHTML = \`
    <div class="field-row"><div class="field-key">الاسم</div><div class="field-val">\${esc(a.fullName)}</div></div>
    <div class="field-row"><div class="field-key">Discord ID</div><div class="field-val" style="font-family:monospace">\${esc(a.discordUser)}</div></div>
    <div class="field-row"><div class="field-key">الحالة</div><div class="field-val"><span class="badge badge-\${a.status}">\${a.status}</span></div></div>
    <div class="field-row"><div class="field-key">الدرجة</div><div class="field-val"><strong>\${a.mcqScore}/5</strong></div></div>
    <div class="field-row"><div class="field-key">تاريخ التقديم</div><div class="field-val">\${new Date(a.submittedAt).toLocaleString('ar')}</div></div>
    \${mcqH}\${openH}
    <div style="margin-top:14px;font-size:12px;color:#7a8ab0">ملاحظات المشرف:</div>
    <textarea id="adminNotes" class="notes-ta" rows="3">\${esc(a.notes||'')}</textarea>
  \`;
  document.getElementById('detailModal').classList.add('open');
}

async function setStatus(status){
  if(!activeRef) return;
  const r = await fetch('/admin/api/apps/'+activeRef,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  if(r.ok){closeModal('detailModal');loadStats();loadApps();}
  else alert('فشل تحديث الحالة');
}

async function quickSet(ref,status){
  const r = await fetch('/admin/api/apps/'+ref,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  if(r.ok){loadStats();loadApps();}
  else alert('فشل التحديث');
}

async function saveNotes(){
  if(!activeRef) return;
  const notes = document.getElementById('adminNotes').value;
  const r = await fetch('/admin/api/apps/'+activeRef,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes})});
  if(r.ok) alert('✓ تم حفظ الملاحظات');
  else alert('فشل الحفظ');
}

async function delApp(ref){
  if(!confirm('هل أنت متأكد من حذف هذا الطلب نهائياً؟')) return;
  const r = await fetch('/admin/api/apps/'+ref,{method:'DELETE'});
  if(r.ok){loadStats();loadApps();}
  else alert('فشل الحذف');
}

function exportData(){ window.open('/admin/api/export','_blank'); }

async function openContentEditor(){
  const r = await fetch('/api/content');
  if(!r.ok) return alert('فشل تحميل المحتوى');
  const c = await r.json();
  document.getElementById('contentGrid').innerHTML = Object.entries(c).map(([k,v])=>\`
    <div class="content-field">
      <label>\${k}</label>
      <textarea id="cf_\${k}" rows="2">\${esc(v)}</textarea>
    </div>
  \`).join('');
  document.getElementById('contentModal').classList.add('open');
}

async function saveContent(){
  const updated={};
  document.querySelectorAll('#contentGrid textarea').forEach(ta=>{
    updated[ta.id.replace('cf_','')] = ta.value;
  });
  const r = await fetch('/api/content',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(updated)});
  if(r.ok){alert('✓ تم حفظ المحتوى');closeModal('contentModal');}
  else alert('فشل الحفظ');
}

function closeModal(id){ document.getElementById(id).classList.remove('open'); }
function debounce(){ clearTimeout(debTimer); debTimer=setTimeout(()=>loadApps(1),400); }

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    closeModal('detailModal');
    closeModal('contentModal');
  }
});
</script>
</body>
</html>`);
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     EMS ABRAMS — SERVER RUNNING      ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  App    → http://localhost:${PORT}       ║`);
  console.log(`║  Admin  → http://localhost:${PORT}/admin ║`);
  console.log("╠══════════════════════════════════════╣");
  if (ADMIN_PASSWORD === "EMS_CHANGE_ME") {
    console.log("║  ⚠️  WARNING: Change ADMIN_PASSWORD!   ║");
  }
  console.log("╚══════════════════════════════════════╝");
});