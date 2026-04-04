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
const APPLY_URL =
  process.env.APPLY_URL || `http://localhost:${PORT}/apply`;

if (!TOKEN || !REVIEW_CHANNEL_ID) {
  console.error("❌ Missing TOKEN or REVIEW_CHANNEL_ID in .env");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.get("/", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get("/apply", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "apply.html"))
);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const DATA_FILE = path.join(__dirname, "applications.json");
const LOGO_FILE = path.join(
  __dirname,
  "assets",
  "underwater-medical-center.png"
);

function safe(v, max = 1000) {
  return String(v ?? "—").trim().slice(0, max) || "—";
}

function genRef() {
  return "EMS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function loadApps() {
  try {
    if (!fs.existsSync(DATA_FILE)) return new Map();
    const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    console.error("❌ loadApps error:", err.message);
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
    console.error("❌ saveApps error:", err.message);
  }
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

function buildReviewEmbed(data, title, color) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      {
        name: "👤 Applicant",
        value: `**${safe(data.fullName, 100)}**`,
        inline: true,
      },
      {
        name: "💬 Discord",
        value: `<@${safe(data.discordUser, 100)}>`,
        inline: true,
      },
      {
        name: "🧠 Score",
        value: `**${safe(data.mcqScore, 10)}/5**`,
        inline: true,
      },
      {
        name: "📌 Status",
        value: `**${safe(data.status, 30)}**`,
        inline: true,
      },
      {
        name: "📛 Reference",
        value: `\`${safe(data.ref, 50)}\``,
        inline: true,
      }
    )
    .setFooter({
      text: "Underwater Medical Center • Application System",
    })
    .setTimestamp();
}

function buildResultEmbed(data, action, ref) {
  const accepted = action === "accept";

  return new EmbedBuilder()
    .setColor(accepted ? 0x22c55e : 0xef4444)
    .setAuthor({
      name: "Underwater Medical Center",
      iconURL: "attachment://underwater-medical-center.png",
    })
    .setTitle(accepted ? "Application Approved" : "Application Update")
    .setDescription(
      accepted
        ? [
            `Dear **${safe(data.fullName, 80)}**,`,
            "",
            "We are pleased to inform you that your application has been **approved successfully**.",
            "",
            "Your submission demonstrated the level of understanding and professionalism required to join our medical team.",
            "",
            `**Reference ID:** \`${ref}\``,
            "",
            "Please contact the management team for the next steps of your recruitment process.",
            "",
            "Welcome to **Underwater Medical Center**.",
          ].join("\n")
        : [
            `Dear **${safe(data.fullName, 80)}**,`,
            "",
            "Thank you for your interest in joining **Underwater Medical Center**.",
            "",
            "After carefully reviewing your application, we regret to inform you that your application was **not approved** at this time.",
            "",
            `**Reference ID:** \`${ref}\``,
            "",
            "You are welcome to improve your preparation and apply again in the future.",
            "",
            "We appreciate your time and interest.",
          ].join("\n")
    )
    .addFields(
      {
        name: "Applicant",
        value: safe(data.fullName, 100),
        inline: true,
      },
      {
        name: "Discord ID",
        value: safe(data.discordUser, 100),
        inline: true,
      },
      {
        name: "Score",
        value: `${safe(data.mcqScore, 10)}/5`,
        inline: true,
      }
    )
    .setThumbnail("attachment://underwater-medical-center.png")
    .setFooter({
      text: accepted
        ? "Underwater Medical Center • Recruitment Department"
        : "Underwater Medical Center • Application Review",
    })
    .setTimestamp();
}

app.post("/submit", async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.fullName || !body.discordUser) {
      return res.status(400).json({
        error: "Missing fullName or discordUser",
      });
    }

    const ref = genRef();

    const appData = {
      ref,
      fullName: safe(body.fullName, 100),
      discordUser: safe(body.discordUser, 100),
      mcqScore: Number(body.mcqScore || 0),
      mcq: body.mcq || {},
      open: body.open || {},
      status: "Pending",
      createdAt: new Date().toISOString(),
    };

    const apps = loadApps();
    apps.set(ref, appData);
    saveApps(apps);

    const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      throw new Error("Review channel not found or not text based");
    }

    await channel.send({
      embeds: [
        buildReviewEmbed(
          appData,
          "📨 Underwater Medical Center — New Application",
          0x3b82f6
        ),
      ],
      components: makeButtons(ref),
    });

    console.log(`✅ New application sent: ${ref}`);
    return res.json({ ok: true, ref });
  } catch (err) {
    console.error("❌ Submit error:", err);
    return res.status(500).json({
      error: "Failed to send application to Discord",
    });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  await interaction.deferUpdate();

  const [action, ref] = interaction.customId.split("_");
  const apps = loadApps();
  const data = apps.get(ref);

  if (!data) {
    return interaction.followUp({
      content: "❌ Application not found.",
      ephemeral: true,
    });
  }

  if (data.status !== "Pending") {
    return interaction.followUp({
      content: `⚠️ Already ${data.status}`,
      ephemeral: true,
    });
  }

  const isAccepted = action === "accept";
  data.status = isAccepted ? "Approved" : "Rejected";
  data.reviewedAt = new Date().toISOString();

  apps.set(ref, data);
  saveApps(apps);

  const title = isAccepted
    ? "✅ Underwater Medical Center — APPROVED"
    : "❌ Underwater Medical Center — REJECTED";

  const color = isAccepted ? 0x22c55e : 0xef4444;

  await interaction.editReply({
    embeds: [buildReviewEmbed(data, title, color)],
    components: makeButtons(ref, true),
  });

  try {
    const user = await client.users.fetch(data.discordUser);

    const files = [];
    if (fs.existsSync(LOGO_FILE)) {
      files.push(
        new AttachmentBuilder(LOGO_FILE, {
          name: "underwater-medical-center.png",
        })
      );
    }

    await user.send({
      embeds: [buildResultEmbed(data, action, ref)],
      files,
    });
  } catch (err) {
    console.log("DM failed:", err.message);
  }
});

client.once(Events.ClientReady, () => {
  console.log(`✅ BOT READY: ${client.user.tag}`);
});

client
  .login(TOKEN)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 SERVER RUNNING ON ${APPLY_URL}`);
      console.log(`📨 Review Channel: ${REVIEW_CHANNEL_ID}`);
    });
  })
  .catch((err) => {
    console.error("❌ LOGIN ERROR:", err.message);
  });