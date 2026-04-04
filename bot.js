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
  AttachmentBuilder,
} = require("discord.js");

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TOKEN;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID;
const APPLY_URL = process.env.APPLY_URL;

if (!TOKEN || !REVIEW_CHANNEL_ID) {
  console.error("❌ Missing ENV variables");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const DATA_FILE = "./applications.json";
const LOGO_FILE = path.join(__dirname, "assets", "underwater-medical-center.png");

function safe(v, max = 1000) {
  return String(v ?? "—").slice(0, max);
}

function genRef() {
  return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function loadApps() {
  if (!fs.existsSync(DATA_FILE)) return new Map();
  return new Map(Object.entries(JSON.parse(fs.readFileSync(DATA_FILE))));
}

function saveApps(map) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
}

function makeButtons(ref, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`accept_${ref}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),

      new ButtonBuilder()
        .setCustomId(`reject_${ref}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    ),
  ];
}

function buildEmbed(data, title, color) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: "👤 Name", value: safe(data.fullName), inline: true },
      { name: "💬 Discord", value: safe(data.discordUser), inline: true },
      { name: "🧠 Score", value: `${data.mcqScore}/5`, inline: true },
      { name: "📛 Ref", value: data.ref, inline: true },
      { name: "📌 Status", value: data.status, inline: true }
    )
    .setFooter({ text: `REF: ${data.ref}` })
    .setTimestamp();
}

function buildResultEmbed(data, action, ref) {
  const accepted = action === "accept";

  return new EmbedBuilder()
    .setColor(accepted ? 0x2ecc71 : 0xe74c3c)
    .setAuthor({
      name: "Underwater Medical Center",
      iconURL: "attachment://logo.png",
    })
    .setTitle(accepted ? "Application Approved" : "Application Update")
    .setDescription(
      accepted
        ? `Dear **${data.fullName}**,

Your application has been **approved successfully**.

Reference ID: \`${ref}\`

Welcome to Underwater Medical Center.`
        : `Dear **${data.fullName}**,

Your application was **not approved**.

Reference ID: \`${ref}\`

You can apply again in the future.`
    )
    .setThumbnail("attachment://logo.png")
    .setTimestamp();
}

app.post("/submit", async (req, res) => {
  try {
    const body = req.body;
    const ref = genRef();

    const data = {
      ref,
      fullName: body.fullName,
      discordUser: body.discordUser,
      mcqScore: body.mcqScore || 0,
      status: "Pending",
    };

    const apps = loadApps();
    apps.set(ref, data);
    saveApps(apps);

    const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);

    await channel.send({
      embeds: [buildEmbed(data, "🚑 New EMS Application", 0x3b82f6)],
      components: makeButtons(ref),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  await interaction.deferUpdate();

  const [action, ref] = interaction.customId.split("_");
  const apps = loadApps();
  const data = apps.get(ref);

  if (!data) return;

  if (data.status !== "Pending") return;

  data.status = action === "accept" ? "Approved" : "Rejected";
  apps.set(ref, data);
  saveApps(apps);

  const color = action === "accept" ? 0x22c55e : 0xef4444;

  await interaction.editReply({
    embeds: [buildEmbed(data, "Application Updated", color)],
    components: makeButtons(ref, true),
  });

  try {
    const user = await client.users.fetch(data.discordUser);

    const files = [
      new AttachmentBuilder(LOGO_FILE, { name: "logo.png" }),
    ];

    await user.send({
      embeds: [buildResultEmbed(data, action, ref)],
      files,
    });
  } catch {}
});

client.once(Events.ClientReady, () => {
  console.log("✅ BOT READY");
});

client.login(TOKEN);

app.listen(PORT, () => {
  console.log(`🚀 LIVE: ${APPLY_URL}`);
});