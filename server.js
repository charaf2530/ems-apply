const express = require("express");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Env ──────────────────────────────────────────────────────────────────────
const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) {
  console.error("❌  Missing DISCORD_WEBHOOK environment variable");
  process.exit(1);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// ── Rate limiter (in-memory, per IP) ─────────────────────────────────────────
// Max 2 submissions per IP per 10 minutes
const RATE_WINDOW_MS  = 10 * 60 * 1000;
const RATE_MAX        = 2;
const rateBuckets     = new Map(); // ip -> [timestamp, ...]

function isRateLimited(ip) {
  const now  = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  rateBuckets.set(ip, hits);
  return false;
}

// Prune stale entries every 15 min so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateBuckets) {
    const fresh = hits.filter(t => now - t < RATE_WINDOW_MS);
    fresh.length ? rateBuckets.set(ip, fresh) : rateBuckets.delete(ip);
  }
}, 15 * 60 * 1000);

// ── Sanitization ──────────────────────────────────────────────────────────────
// Block Discord @mentions/role pings; strip backtick code blocks; trim length
function safe(s = "", maxLen = 1024) {
  return String(s)
    .replace(/`/g, "'")
    .replace(/@(everyone|here|&)/gi, "@\u200b$1")  // neutralise dangerous pings
    .replace(/@/g, "@\u200b")                       // neutralise user pings
    .trim()
    .slice(0, maxLen) || "—";
}

// ── Validation ────────────────────────────────────────────────────────────────
const VALID_MCQ_OPTS = new Set(["A", "B", "C", "D"]);
const MCQ_KEYS       = ["q1", "q2", "q3", "q4", "q5"];
const OPEN_KEYS      = ["q6", "q7", "q8", "q9", "q10"];

function validate(body) {
  const errors = [];

  if (!body.fullName?.trim())    errors.push("fullName is required");
  if (!body.discordUser?.trim()) errors.push("discordUser is required");

  for (const k of MCQ_KEYS) {
    const v = body.mcq?.[k];
    if (!VALID_MCQ_OPTS.has(v)) errors.push(`MCQ ${k} has invalid answer "${v}"`);
  }

  for (const k of OPEN_KEYS) {
    if (!body.open?.[k]?.trim()) errors.push(`Open question ${k} is empty`);
  }

  const score = Number(body.mcqScore ?? -1);
  if (!Number.isInteger(score) || score < 0 || score > 5)
    errors.push("mcqScore must be an integer 0–5");

  return errors;
}

// ── MCQ labels (for readable Discord output) ──────────────────────────────────
const MCQ_QUESTIONS = {
  q1: { text: "Main role of EMS in RP?",               opts: { A: "Fight gangs", B: "Save lives & treat injured", C: "Investigate cases", D: "Arrest criminals" } },
  q2: { text: "Found unconscious on the ground?",      opts: { A: "Take a picture", B: "Ask what happened", C: "Secure scene & check breathing", D: "Call police" } },
  q3: { text: "EMS allowed to use weapons?",           opts: { A: "Yes, always", B: "No — strictly medical", C: "Only during wars", D: "With captain approval" } },
  q4: { text: "Medical helicopter can be used by?",    opts: { A: "Any EMS", B: "Flight exam + admin approval", C: "High ranks only", D: "Any experienced EMS" } },
  q5: { text: "During an active shootout, EMS should?",opts: { A: "Enter immediately", B: "Wait for police clearance", C: "Leave the area", D: "Call the gang" } },
};

const CORRECT = { q1: "B", q2: "C", q3: "B", q4: "B", q5: "B" };

const OPEN_QUESTIONS = {
  q6:  "Explain Medical RP and why EMS must respect it",
  q7:  "Someone declared dead with clear video evidence — what do you do?",
  q8:  "Patient is insulting or breaking RP — how do you handle it?",
  q9:  "Car crash: one conscious, one unconscious — who do you treat first?",
  q10: "You treated a patient but they immediately run and start fighting — what do you do?",
};

// ── Discord embed builder ────────────────────────────────────────────────────
function buildEmbed(p, score) {
  const scoreColor =
    score === 5 ? 0x00e676 :   // green
    score >= 3  ? 0xffb300 :   // amber
                  0xff4757;    // red

  // Build MCQ fields
  const mcqFields = MCQ_KEYS.map(k => {
    const chosen  = p.mcq[k];
    const correct = CORRECT[k];
    const label   = MCQ_QUESTIONS[k].opts[chosen] ?? chosen;
    const isRight = chosen === correct;
    return {
      name:   `${isRight ? "✅" : "❌"} Q${k.slice(1)}) ${MCQ_QUESTIONS[k].text}`,
      value:  `**${chosen})** ${safe(label, 200)}`,
      inline: false,
    };
  });

  // Build open-question fields
  const openFields = OPEN_KEYS.map(k => ({
    name:   OPEN_QUESTIONS[k],
    value:  safe(p.open[k], 1024),
    inline: false,
  }));

  return {
    embeds: [{
      title:       "🚑  New EMS Application",
      color:       scoreColor,
      timestamp:   new Date().toISOString(),
      footer:      { text: "EMS Apply System" },
      fields: [
        { name: "👤 RP Name",        value: safe(p.fullName, 100),    inline: true },
        { name: "💬 Discord",        value: safe(p.discordUser, 100), inline: true },
        { name: "🧠 MCQ Score",      value: `**${score} / 5**`,       inline: true },
        { name: "\u200b",            value: "**── Multiple Choice ──**", inline: false },
        ...mcqFields,
        { name: "\u200b",            value: "**── Open Questions ──**",  inline: false },
        ...openFields,
      ],
    }],
  };
}

// ── Discord post ──────────────────────────────────────────────────────────────
async function postToDiscord(payload) {
  const res = await fetch(WEBHOOK, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook error ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ── /submit route ─────────────────────────────────────────────────────────────
app.post("/submit", async (req, res) => {
  // Rate limit
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() ?? req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    console.warn(`[rate-limit] ${ip}`);
    return res.status(429).json({ error: "Too many submissions. Please wait a few minutes." });
  }

  // Validate
  const errors = validate(req.body);
  if (errors.length) {
    console.warn("[validation]", errors);
    return res.status(400).json({ error: "Validation failed", details: errors });
  }

  const p     = req.body;
  const score = MCQ_KEYS.filter(k => p.mcq[k] === CORRECT[k]).length; // recompute server-side

  try {
    await postToDiscord(buildEmbed(p, score));
    console.log(`[submit] ✅  ${safe(p.fullName, 60)} (${safe(p.discordUser, 60)}) — score ${score}/5 — IP ${ip}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[submit] ❌ ", err.message);
    res.status(502).json({ error: "Failed to reach Discord. Please try again." });
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: "Not found" }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅  EMS server running → http://localhost:${PORT}`));