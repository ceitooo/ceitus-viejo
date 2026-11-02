const { PermissionFlagsBits } = require("discord.js");
const { saveLockout, getLockout, listLockouts, deleteLockout } = require("../db/database");

const CHECK_INTERVAL_MS = 15 * 1000;
const CHUNK_SIZE = 8;

function lockableChannels(guild) {
  return guild.channels.cache.filter((c) => !c.isThread() && c.type !== 4 && c.permissionOverwrites);
}

async function inChunks(items, fn) {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    await Promise.all(items.slice(i, i + CHUNK_SIZE).map((item) => fn(item).catch(() => {})));
  }
}

// Oculta todos los canales al miembro con overrides propios (los de miembro
// pisan a los de rol), guardando el valor previo de ViewChannel para restaurarlo.
async function lockoutMember(guild, member, durationMs) {
  // Aplicar timeout nativo de Discord si está disponible
  if (member && typeof member.timeout === "function") {
    await member.timeout(durationMs, "Castigo: reenvió un mensaje").catch(() => {});
  }

  const existing = getLockout(guild.id, member.id);
  const previous = existing ? JSON.parse(existing.previous_json) : {};
  const channels = [...lockableChannels(guild).values()];

  for (const channel of channels) {
    if (previous[channel.id] !== undefined) continue;
    const overwrite = channel.permissionOverwrites.cache.get(member.id);
    if (overwrite?.deny.has(PermissionFlagsBits.ViewChannel)) previous[channel.id] = false;
    else if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel)) previous[channel.id] = true;
    else previous[channel.id] = null;
  }

  saveLockout(guild.id, member.id, Date.now() + durationMs, previous);
  await inChunks(channels, (channel) => channel.permissionOverwrites.edit(member.id, { ViewChannel: false }, { reason: "Castigo: reenvió un mensaje" }));
}

async function restoreMember(guild, userId) {
  const lockout = getLockout(guild.id, userId);
  if (!lockout) return;

  let previous = {};
  try {
    previous = JSON.parse(lockout.previous_json || "{}");
  } catch (_) {
    previous = {};
  }

  const channels = [...lockableChannels(guild).values()];

  await inChunks(channels, async (channel) => {
    const prevVal = previous[channel.id];
    // Si el usuario tenía un permiso previo específico (true o false), restaurarlo
    if (prevVal === true || prevVal === false) {
      await channel.permissionOverwrites.edit(userId, { ViewChannel: prevVal }, { reason: "Fin del castigo" }).catch(() => {});
    } else {
      // Si antes no tenía permiso individual (era null), borrar la excepción por completo
      // para restaurar la sincronización de la categoría y no dejar permisos explícitos
      if (channel.permissionOverwrites.cache.has(userId)) {
        await channel.permissionOverwrites.delete(userId, "Fin del castigo").catch(() => {});
      }
    }
  });

  // Quitar timeout nativo de Discord si aún estuviera activo
  try {
    const member = guild.members.cache.get(userId) || (await guild.members.fetch(userId).catch(() => null));
    if (member && typeof member.timeout === "function") {
      if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
        await member.timeout(null, "Fin del castigo").catch(() => {});
      }
    }
  } catch (_) {}

  deleteLockout(guild.id, userId);
}

async function processExpired(client) {
  const now = Date.now();
  for (const lockout of listLockouts()) {
    if (lockout.expires_at > now) continue;
    const guild = client.guilds.cache.get(lockout.guild_id);
    if (!guild) continue;
    await restoreMember(guild, lockout.user_id).catch((e) => console.error("[lockout] Error restaurando:", e.message));
  }
}

function startLockoutChecker(client) {
  processExpired(client);
  setInterval(() => processExpired(client), CHECK_INTERVAL_MS);
}

module.exports = { lockoutMember, restoreMember, startLockoutChecker };
