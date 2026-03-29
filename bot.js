require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} = require("discord.js");

// ─────────────────────────────────────────
// ENV
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID;

if (!TOKEN || !REVIEW_CHANNEL_ID) {
  console.error("❌ Missing TOKEN or REVIEW_CHANNEL_ID in .env");
  process.exit(1);
}

// ─────────────────────────────────────────
// FILE STORAGE
// ─────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "applications.json");

function loadApps() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return new Map();
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (!raw) return new Map();

    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch (err) {
    console.error("❌ Failed to load applications.json:", err.message);
    return new Map();
  }
}

function saveApps(map) {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(Object.fromEntries(map), null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("❌ Failed to save applications.json:", err.message);
  }
}

// ─────────────────────────────────────────
// RATE LIMIT
// ─────────────────────────────────────────
const ipBuckets = new Map();
const didBuckets = new Map();

function checkRateLimit(ip, discordId) {
  const now = Date.now();

  const ipHits = (ipBuckets.get(ip) || []).filter(
    (t) => now - t < 10 * 60 * 1000
  );
  if (ipHits.length >= 2) return false;
  ipHits.push(now);
  ipBuckets.set(ip, ipHits);

  const didHits = (didBuckets.get(discordId) || []).filter(
    (t) => now - t < 30 * 60 * 1000
  );
  if (didHits.length >= 1) return false;
  didHits.push(now);
  didBuckets.set(discordId, didHits);

  return true;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function safe(v, max = 1024) {
  return (
    String(v ?? "")
      .replace(/@(everyone|here)/gi, "@\u200b$1")
      .trim()
      .slice(0, max) || "—"
  );
}

function genRef() {
  return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

const MCQ_CORRECT = {
  q1: "B",
  q2: "C",
  q3: "B",
  q4: "B",
  q5: "B",
};

const OPEN_KEYS = ["q6", "q7", "q8", "q9", "q10"];

const OPEN_LABELS = {
  q6: "اشرح Medical RP ولماذا يجب على EMS احترامه.",
  q7: "إذا تم إعلان وفاة شخص وهناك دليل فيديو، ماذا تفعل؟",
  q8: "كيف تتعامل مع مريض يسبك أو يخالف قواعد الـ RP؟",
  q9: "حادث سيارة: واعٍ وفاقد للوعي — من تعالج أولاً ولماذا؟",
  q10: "عالجت مريضاً لكنه هرب وبدأ يتشاجر فوراً — ماذا تفعل؟",
};

function makeButtons(ref, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${ref}`)
      .setLabel("✅ قبول — Accept")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`reject_${ref}`)
      .setLabel("❌ رفض — Reject")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

function buildEmbed(app, title = "🚑 New EMS Application", color = 0x3b82f6) {
  const scoreColor =
    app.mcqScore === 5 ? "🟢" : app.mcqScore >= 3 ? "🟡" : "🔴";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: "👤 RP Name", value: safe(app.fullName), inline: true },
      { name: "💬 Discord ID", value: `\`${safe(app.discordUser)}\``, inline: true },
      { name: "🧠 MCQ Score", value: `${scoreColor} **${app.mcqScore}/5**`, inline: true },
      { name: "🔖 Ref", value: `\`${app.ref}\``, inline: true },
      { name: "📌 Status", value: safe(app.status), inline: true },
      { name: "👮 Reviewed By", value: safe(app.reviewedBy), inline: true }
    )
    .setFooter({ text: `REF: ${app.ref}` })
    .setTimestamp();

  const mcqText = Object.entries(MCQ_CORRECT)
    .map(([k, correct]) => {
      const ans = app.mcq?.[k] || "—";
      const ok = ans === correct ? "✅" : "❌";
      return `${ok} **${k.toUpperCase()}**: ${ans}`;
    })
    .join(" | ");

  embed.addFields({ name: "📝 MCQ Answers", value: mcqText || "—", inline: false });

  for (const key of OPEN_KEYS) {
    embed.addFields({
      name: `💬 ${OPEN_LABELS[key]}`,
      value: safe(app.open?.[key], 500),
      inline: false,
    });
  }

  return embed;
}

// ─────────────────────────────────────────
// DISCORD CLIENT
// ─────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    console.log("🔘 Button clicked:", interaction.customId);

    const [action, ref] = interaction.customId.split("_");
    const apps = loadApps();
    const app = apps.get(ref);

    if (!app) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `❌ Application not found.\nRef: \`${ref}\``,
          ephemeral: true,
        });
      }
      return;
    }

    if (app.status !== "pending") {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `⚠️ This application is already **${app.status}**.`,
          ephemeral: true,
        });
      }
      return;
    }

    if (action === "accept") {
      app.status = "accepted";
      app.reviewedBy = interaction.user.tag;
      app.reviewedAt = new Date().toISOString();
      apps.set(ref, app);
      saveApps(apps);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.update({
          embeds: [buildEmbed(app, "✅ EMS Application — ACCEPTED", 0x22c55e)],
          components: [makeButtons(ref, true)],
        });
      }

      try {
        const user = await client.users.fetch(app.discordUser);

        await user.send(
          `🚑 **EMS Abrams**\n\n` +
            `مرحباً **${app.fullName}**!\n` +
            `✅ تم **قبول** طلبك في فريق EMS.\n` +
            `🔖 المرجع: \`${ref}\`\n\n` +
            `مرحبا بك في الفريق! شوف التعليمات داخل السيرفر. 🎉`
        );

        console.log(`✅ Accept DM sent to ${app.discordUser}`);
      } catch (err) {
        console.log(`⚠️ Failed to send accept DM to ${app.discordUser}: ${err.message}`);
      }

      return;
    }

    if (action === "reject") {
      app.status = "rejected";
      app.reviewedBy = interaction.user.tag;
      app.reviewedAt = new Date().toISOString();
      apps.set(ref, app);
      saveApps(apps);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.update({
          embeds: [buildEmbed(app, "❌ EMS Application — REJECTED", 0xef4444)],
          components: [makeButtons(ref, true)],
        });
      }

      try {
        const user = await client.users.fetch(app.discordUser);

        await user.send(
          `🚑 **EMS Abrams**\n\n` +
            `مرحباً **${app.fullName}**!\n` +
            `❌ للأسف تم **رفض** طلبك هذه المرة.\n` +
            `🔖 المرجع: \`${ref}\`\n\n` +
            `يمكنك إعادة التقديم لاحقاً بعد تحسين مستواك. حظ موفق 💪`
        );

        console.log(`✅ Reject DM sent to ${app.discordUser}`);
      } catch (err) {
        console.log(`⚠️ Failed to send reject DM to ${app.discordUser}: ${err.message}`);
      }

      return;
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
  }
});

// ─────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────
const expressApp = express();

expressApp.use(express.json({ limit: "1mb" }));
expressApp.use(express.static("public"));

expressApp.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

expressApp.get("/apply", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "apply.html"));
});

expressApp.post("/submit", async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const discordId = String(req.body?.discordUser || "").trim();
    const fullName = String(req.body?.fullName || "").trim();

    if (!checkRateLimit(ip, discordId)) {
      return res.status(429).json({
        error: "Too many requests. Please wait before trying again.",
      });
    }

    if (fullName.length < 2) {
      return res.status(400).json({
        error: "fullName must be at least 2 characters.",
      });
    }

    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({
        error: "Invalid Discord ID. It must be 17 to 20 digits.",
      });
    }

    const apps = loadApps();

    const hasPending = [...apps.values()].some(
      (a) => a.discordUser === discordId && a.status === "pending"
    );

    if (hasPending) {
      return res.status(409).json({
        error: "You already have a pending application.",
      });
    }

    const mcqAns = req.body?.mcq || {};
    const openAns = req.body?.open || {};

    const score = Object.entries(MCQ_CORRECT).filter(
      ([k, v]) => mcqAns[k] === v
    ).length;

    const ref = genRef();

    const appData = {
      ref,
      fullName,
      discordUser: discordId,
      mcqScore: score,
      mcq: mcqAns,
      open: openAns,
      status: "pending",
      reviewedBy: "—",
      reviewedAt: null,
      ip,
      createdAt: new Date().toISOString(),
    };

    apps.set(ref, appData);
    saveApps(apps);

    const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      throw new Error("Review channel not found or not text-based.");
    }

    await channel.send({
      embeds: [buildEmbed(appData)],
      components: [makeButtons(ref)],
    });

    console.log(`📝 New application: ${ref} — ${fullName} (score: ${score}/5)`);

    return res.json({
      ok: true,
      ref,
      message: "Application submitted successfully.",
    });
  } catch (err) {
    console.error("❌ Submit error:", err);
    return res.status(500).json({
      error: "Failed to send application to Discord.",
    });
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
client
  .login(TOKEN)
  .then(() => {
    expressApp.listen(PORT, () => {
      console.log("╔══════════════════════════════════════╗");
      console.log("║         EMS ABRAMS BOT RUNNING      ║");
      console.log(`║  Port    → ${PORT}`);
      console.log(`║  Channel → ${REVIEW_CHANNEL_ID}`);
      console.log("╚══════════════════════════════════════╝");
    });
  })
  .catch((err) => {
    console.error("❌ Failed to login bot:", err.message);
    process.exit(1);
  });