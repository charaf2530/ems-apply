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
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TOKEN;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID;

if (!TOKEN || !REVIEW_CHANNEL_ID) {
  console.error("❌ Missing TOKEN or REVIEW_CHANNEL_ID");
  process.exit(1);
}

// ─────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/apply", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "apply.html"));
});

// ─────────────────────────────────────────
// FILE STORAGE
// ─────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "applications.json");

function loadApps() {
  try {
    if (!fs.existsSync(DATA_FILE)) return new Map();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function saveApps(map) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(Object.fromEntries(map), null, 2)
  );
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function safe(v, max = 1024) {
  return String(v ?? "").slice(0, max) || "—";
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

// ─────────────────────────────────────────
// DISCORD
// ─────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
});

// buttons
function makeButtons(ref) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${ref}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`reject_${ref}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger)
  );
}

// embed
function buildEmbed(app) {
  return new EmbedBuilder()
    .setTitle("🚑 EMS Application")
    .setColor(0x3b82f6)
    .addFields(
      { name: "RP Name", value: safe(app.fullName), inline: true },
      { name: "Discord ID", value: safe(app.discordUser), inline: true },
      { name: "Score", value: `${app.mcqScore}/5`, inline: true },
      { name: "Ref", value: app.ref }
    )
    .setTimestamp();
}

// accept / reject
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, ref] = interaction.customId.split("_");
  const apps = loadApps();
  const data = apps.get(ref);
  if (!data) return;

  data.status = action;
  apps.set(ref, data);
  saveApps(apps);

  await interaction.update({
    content: `Application ${action}`,
    embeds: [],
    components: [],
  });

  try {
    const user = await client.users.fetch(data.discordUser);

    if (action === "accept") {
      await user.send("✅ تم قبول طلبك في EMS");
    } else {
      await user.send("❌ تم رفض طلبك في EMS");
    }
  } catch {}
});

// ─────────────────────────────────────────
// SUBMIT
// ─────────────────────────────────────────
app.post("/submit", async (req, res) => {
  try {
    const fullName = req.body.fullName;
    const discordUser = req.body.discordUser;
    const mcq = req.body.mcq || {};

    if (!fullName || !discordUser) {
      return res.json({ error: "Missing data" });
    }

    const score = Object.entries(MCQ_CORRECT).filter(
      ([k, v]) => mcq[k] === v
    ).length;

    const ref = genRef();

    const data = {
      ref,
      fullName,
      discordUser,
      mcqScore: score,
      status: "pending",
    };

    const apps = loadApps();
    apps.set(ref, data);
    saveApps(apps);

    const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);

    await channel.send({
      embeds: [buildEmbed(data)],
      components: [makeButtons(ref)],
    });

    res.json({ success: true, ref });
  } catch (err) {
    console.log(err);
    res.json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║         EMS ABRAMS BOT RUNNING      ║");
  console.log(`║  Port    → ${PORT}`);
  console.log(`║  Channel → ${REVIEW_CHANNEL_ID}`);
  console.log("╚══════════════════════════════════════╝");
});

client.login(TOKEN);