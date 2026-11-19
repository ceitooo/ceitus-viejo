const fs = require("node:fs");
const path = require("node:path");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { db, getGuildApiKeys } = require("../db/database");
const { PLATFORMS } = require("./platforms");

db.exec(`
CREATE TABLE IF NOT EXISTS stream_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  role_id TEXT,
  message TEXT,
  last_live_id TEXT,
  last_video_id TEXT,
  created_by TEXT,
  UNIQUE (guild_id, platform, username)
);
`);

const STORE_PATH = path.join(__dirname, "stream_subs_store.json");
const INTERVAL_MS = 60_000;
const TIKTOK_EVERY = 3; // TikTok cada 3 vueltas (~3 min)
let tick = 0;
let client = null;

function saveStore() {
  try {
    const all = db.prepare("SELECT guild_id, platform, username, channel_id, role_id, message, created_by FROM stream_subs").all();
    fs.writeFileSync(STORE_PATH, JSON.stringify(all, null, 2), "utf8");
  } catch (e) {
    console.warn("[streams] Error guardando stream_subs_store.json:", e.message);
  }
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      if (Array.isArray(data)) {
        for (const item of data) {
          addSub(
            {
              guildId: item.guild_id || item.guildId,
              platform: item.platform,
              username: item.username,
              channelId: item.channel_id || item.channelId,
              roleId: item.role_id || item.roleId,
              message: item.message,
              createdBy: item.created_by || item.createdBy || "store"
            },
            { syncStore: false }
          );
        }
        console.log(`[streams] ${data.length} suscripciones cargadas desde store persistente.`);
      }
    }
  } catch (e) {
    console.warn("[streams] Error cargando stream_subs_store.json:", e.message);
  }
}

function addSub(fields, { syncStore = true } = {}) {
  db.prepare(
    `INSERT INTO stream_subs (guild_id, platform, username, channel_id, role_id, message, last_live_id, last_video_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, platform, username) DO UPDATE SET
       channel_id = excluded.channel_id, role_id = excluded.role_id, message = excluded.message`
  ).run(
    fields.guildId,
    fields.platform,
    fields.username,
    fields.channelId,
    fields.roleId ?? null,
    fields.message ?? null,
    fields.lastLiveId ?? null,
    fields.lastVideoId ?? null,
    fields.createdBy
  );
  if (syncStore) saveStore();
}

function removeSub(guildId, platform, username) {
  const changes = db
    .prepare("DELETE FROM stream_subs WHERE guild_id = ? AND platform = ? AND username = ?")
    .run(guildId, platform, username).changes;
  if (changes > 0) saveStore();
  return changes;
}

function listSubs(guildId) {
  return db.prepare("SELECT * FROM stream_subs WHERE guild_id = ? ORDER BY platform, username").all(guildId);
}

function buildLiveMessage(sub, result, { test = false } = {}) {
  const p = PLATFORMS[sub.platform];
  const live = result.live;
  const name = result.displayName || sub.username;
  const embed = new EmbedBuilder()
    .setColor(p.color)
    .setAuthor({ name: `${name} está en directo en ${p.name}`, iconURL: result.avatar || undefined, url: live.url })
    .setTitle(live.title || "En directo")
    .setURL(live.url)
    .setTimestamp();

  if (live.category) embed.addFields({ name: "🎮 Categoría", value: live.category, inline: true });
  if (live.viewers != null) embed.addFields({ name: "👀 Espectadores", value: String(live.viewers), inline: true });
  if (live.thumbnail) embed.setImage(live.thumbnail);
  if (test) embed.setFooter({ text: "Mensaje de prueba" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Ver directo").setURL(live.url)
  );

  const mention = sub.role_id ? (sub.role_id === sub.guild_id ? "@everyone " : `<@&${sub.role_id}> `) : "";
  const text = (sub.message || "{user} está en directo en {platform}! Pasate al directo: {link}")
    .replace(/\{user\}/g, name)
    .replace(/\{platform\}/g, p.name)
    .replace(/\{link\}/g, live.url)
    .replace(/\{perfil\}/g, p.profile(sub.username));

  return {
    content: `${mention}${p.emoji} ${text}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: ["roles", "everyone"] }
  };
}

function buildVideoMessage(sub, result) {
  const p = PLATFORMS[sub.platform];
  const v = result.video;
  const name = result.displayName || sub.username;
  const embed = new EmbedBuilder()
    .setColor(p.color)
    .setAuthor({ name: `${name} subió un nuevo video`, iconURL: result.avatar || undefined, url: v.url })
    .setTitle(v.title || "Nuevo video")
    .setURL(v.url)
    .setImage(v.thumbnail)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Ver video").setURL(v.url)
  );

  const mention = sub.role_id ? (sub.role_id === sub.guild_id ? "@everyone " : `<@&${sub.role_id}> `) : "";
  return {
    content: `${mention}📺 ¡Nuevo video de **${name}**!`,
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: ["roles", "everyone"] }
  };
}

async function send(sub, payload) {
  if (!client) return;
  const channel = await client.channels.fetch(sub.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send(payload).catch((e) => console.error(`[streams] No se pudo enviar en ${sub.channel_id}:`, e.message));
}

async function runCheck() {
  tick++;
  let subs;
  try {
    subs = db.prepare("SELECT * FROM stream_subs").all();
  } catch (e) {
    return;
  }
  if (!subs || !subs.length) return;
  const cache = new Map();

  for (const sub of subs) {
    if (sub.platform === "tiktok" && tick % TIKTOK_EVERY !== 1) continue;
    const creds = sub.guild_id ? getGuildApiKeys(sub.guild_id)?.[sub.platform] : null;
    const clientId = creds?.clientId || "default";
    const key = `${sub.platform}:${sub.username}:${clientId}`;
    try {
      if (!cache.has(key)) {
        const pObj = PLATFORMS[sub.platform];
        if (!pObj) continue;
        cache.set(key, pObj.check(sub.username, creds));
      }
      const res = await cache.get(key);
      if (!res || res.notFound) continue;

      if (res.live && res.live.id !== sub.last_live_id) {
        db.prepare("UPDATE stream_subs SET last_live_id = ? WHERE id = ?").run(res.live.id, sub.id);
        console.log(`[streams] ${sub.username} (${sub.platform}) está en directo. Enviando aviso a canal ${sub.channel_id}...`);
        await send(sub, buildLiveMessage(sub, res));
      } else if (!res.live && sub.last_live_id) {
        db.prepare("UPDATE stream_subs SET last_live_id = NULL WHERE id = ?").run(sub.id);
      }

      // Avisos de videos subidos desactivados: solo se avisa de directos
    } catch (e) {
      console.error(`[streams] Error comprobando ${sub.platform}/${sub.username}:`, e.message);
    }
  }
}

function seedDefaultSubs() {
  const defaults = [
    {
      guildId: "1339090100424019978",
      platform: "tiktok",
      username: "ceitotweaks",
      channelId: "1564345529163456523",
      roleId: "1339103137901969439",
      message: "{user} está en directo en {platform}! Pasate al directo: {link}",
      createdBy: "system"
    },
    {
      guildId: "1339090100424019978",
      platform: "youtube",
      username: "@ceitotweaks",
      channelId: "1564345529163456523",
      roleId: "1339103137901969439",
      message: "{user} está en directo en {platform}! Pasate al directo: {link}",
      createdBy: "system"
    },
    {
      guildId: "1339090100424019978",
      platform: "twitch",
      username: "ceitooo",
      channelId: "1564345529163456523",
      roleId: "1339103137901969439",
      message: "{user} está en directo en {platform}! Pasate al directo: {link}",
      createdBy: "system"
    },
    {
      guildId: "1544716660559192106",
      platform: "tiktok",
      username: "jugluc",
      channelId: "1544723106503983225",
      roleId: "1553650801577033779",
      message: "{user} está en directo en {platform}! Vengan a acompañarla 💗 {link}",
      createdBy: "system"
    }
  ];

  for (const item of defaults) {
    try {
      const existing = db.prepare("SELECT id FROM stream_subs WHERE guild_id = ? AND platform = ? AND username = ?").get(
        item.guildId,
        item.platform,
        item.username
      );
      if (!existing) {
        addSub(item, { syncStore: false });
        console.log(`[streams] Suscripción por defecto sembrada: ${item.platform}/${item.username}`);
      }
    } catch (e) {
      console.warn(`[streams] Error sembrando sub por defecto (${item.platform}/${item.username}):`, e.message);
    }
  }
}

function startStreamChecker(c) {
  client = c;
  loadStore();
  seedDefaultSubs();
  setInterval(runCheck, INTERVAL_MS);
  setTimeout(runCheck, 5_000); // Primer chequeo 5s tras arrancar
}

module.exports = {
  addSub,
  removeSub,
  listSubs,
  buildLiveMessage,
  buildVideoMessage,
  startStreamChecker
};
