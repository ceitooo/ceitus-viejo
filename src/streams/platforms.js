// Consultas de estado por plataforma. Cada check devuelve:
// { live: { id, title, category, viewers, thumbnail, url } | null, video?: { id, title, url, thumbnail } | null, avatar? }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9", ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

// ── Tokens de app (client_credentials) ──────────────────────────────────────
const tokens = {};
async function getAppToken(key, tokenUrl, clientId, clientSecret) {
  const cached = tokens[key];
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" })
  });
  if (!res.ok) throw new Error(`No se pudo obtener token de ${key}: HTTP ${res.status}`);
  const json = await res.json();
  tokens[key] = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

// ── Twitch ──────────────────────────────────────────────────────────────────
// Fallback público vía GraphQL de Twitch (no requiere API keys ni app registrada)
async function checkTwitchGQL(username) {
  const login = username.toLowerCase();
  const query = JSON.stringify({
    query: `query {
      user(login: "${login}") {
        id
        displayName
        profileImageURL(width: 300)
        stream {
          id
          title
          type
          viewersCount
          game { name }
        }
      }
    }`
  });

  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
      "User-Agent": UA
    },
    body: query,
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Twitch GQL HTTP ${res.status}`);
  const json = await res.json();
  const user = json.data?.user;
  if (!user) return { notFound: true };
  const s = user.stream;
  return {
    displayName: user.displayName,
    avatar: user.profileImageURL,
    live: s
      ? {
          id: String(s.id),
          title: s.title || "En directo",
          category: s.game?.name || null,
          viewers: s.viewersCount ?? 0,
          thumbnail: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-1280x720.jpg?t=${Date.now()}`,
          url: `https://twitch.tv/${login}`
        }
      : null
  };
}

async function twitchGet(path, customCreds = null) {
  const clientId = customCreds?.clientId || process.env.TWITCH_CLIENT_ID;
  const clientSecret = customCreds?.clientSecret || process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const token = await getAppToken(`twitch:${clientId}`, "https://id.twitch.tv/oauth2/token", clientId, clientSecret);
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { "Client-Id": clientId, Authorization: `Bearer ${token}` }
  });
  if (res.status === 401) delete tokens[`twitch:${clientId}`];
  if (!res.ok) throw new Error(`Twitch HTTP ${res.status}`);
  return res.json();
}

async function checkTwitch(username, customCreds = null) {
  const clientId = customCreds?.clientId || process.env.TWITCH_CLIENT_ID;
  const clientSecret = customCreds?.clientSecret || process.env.TWITCH_CLIENT_SECRET;
  if (clientId && clientSecret) {
    try {
      const login = encodeURIComponent(username.toLowerCase());
      const [{ data: streams }, { data: users }] = await Promise.all([
        twitchGet(`streams?user_login=${login}`, customCreds),
        twitchGet(`users?login=${login}`, customCreds)
      ]);
      const user = users?.[0];
      if (!user) return { notFound: true };
      const s = streams?.[0];
      return {
        displayName: user.display_name,
        avatar: user.profile_image_url,
        live: s
          ? {
              id: String(s.id),
              title: s.title,
              category: s.game_name,
              viewers: s.viewer_count,
              thumbnail: s.thumbnail_url.replace("{width}", "1280").replace("{height}", "720") + `?t=${Date.now()}`,
              url: `https://twitch.tv/${user.login}`
            }
          : null
      };
    } catch (e) {
      console.warn(`[Twitch] Falló API Helix para ${username}, usando fallback público:`, e.message);
    }
  }
  return checkTwitchGQL(username);
}

// ── Kick ────────────────────────────────────────────────────────────────────
// Fallback público vía API v2 de Kick (no requiere API keys)
async function checkKickPublic(username) {
  const slug = encodeURIComponent(username.toLowerCase());
  const res = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`Kick HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.user) return { notFound: true };

  const s = data.livestream;
  return {
    displayName: data.user?.username || data.slug || username,
    avatar: data.user?.profile_pic || null,
    live: s
      ? {
          id: String(s.id || s.created_at || Date.now()),
          title: s.session_title || "En directo en Kick",
          category: s.categories?.[0]?.name || null,
          viewers: s.viewer_count ?? 0,
          thumbnail: s.thumbnail?.url ? `${s.thumbnail.url}?t=${Date.now()}` : null,
          url: `https://kick.com/${data.slug || username}`
        }
      : null
  };
}

async function checkKick(username, customCreds = null) {
  const clientId = customCreds?.clientId || process.env.KICK_CLIENT_ID;
  const clientSecret = customCreds?.clientSecret || process.env.KICK_CLIENT_SECRET;
  if (clientId && clientSecret) {
    try {
      const token = await getAppToken(`kick:${clientId}`, "https://id.kick.com/oauth/token", clientId, clientSecret);
      const slug = encodeURIComponent(username.toLowerCase());
      const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${slug}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.status === 401) delete tokens[`kick:${clientId}`];
      if (res.ok) {
        const ch = (await res.json()).data?.[0];
        if (!ch) return { notFound: true };
        const s = ch.stream;
        return {
          displayName: ch.slug,
          avatar: null,
          live: s?.is_live
            ? {
                id: String(s.start_time || `${ch.broadcaster_user_id}-${s.key ?? "live"}`),
                title: ch.stream_title,
                category: ch.category?.name,
                viewers: s.viewer_count,
                thumbnail: s.thumbnail ? `${s.thumbnail}?t=${Date.now()}` : null,
                url: `https://kick.com/${ch.slug}`
              }
            : null
        };
      }
    } catch (e) {
      console.warn(`[Kick] Falló API oficial para ${username}, usando fallback público:`, e.message);
    }
  }
  return checkKickPublic(username);
}

// ── YouTube (sin API key: página del canal + RSS) ───────────────────────────
const ytConsent = { Cookie: "CONSENT=YES+cb; SOCS=CAI" };
const ytChannelCache = new Map();

async function resolveYoutubeChannel(username) {
  if (/^UC[\w-]{22}$/.test(username)) return username;
  if (ytChannelCache.has(username)) return ytChannelCache.get(username);
  const handle = username.startsWith("@") ? username : `@${username}`;
  const html = await fetchText(`https://www.youtube.com/${encodeURIComponent(handle)}`, ytConsent).catch(() => null);
  const id = html?.match(/"externalId":"(UC[\w-]{22})"/)?.[1] || html?.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
  if (id) ytChannelCache.set(username, id);
  return id ?? null;
}

function decodeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function checkYoutube(username) {
  const channelId = await resolveYoutubeChannel(username);
  if (!channelId) return { notFound: true };

  let avatar = null;
  let displayName = username;

  // Directo: la ruta /live redirige al video en directo si lo hay
  let live = null;
  const liveHtml = await fetchText(`https://www.youtube.com/channel/${channelId}/live`, ytConsent).catch(() => "");
  // Solo es directo si la página redirige a un watch?v= (canonical) y está marcado como live ahora
  const canonicalId = liveHtml.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1];
  if (canonicalId && /"isLiveNow":true/.test(liveHtml)) {
    const videoId = canonicalId;
    if (videoId) {
      const title = liveHtml.match(/<meta name="title" content="([^"]*)"/)?.[1];
      live = {
        id: videoId,
        title: title ? decodeXml(title) : "En directo",
        category: null,
        viewers: null,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault_live.jpg?t=${Date.now()}`,
        url: `https://www.youtube.com/watch?v=${videoId}`
      };
    }
  }

  // Último video subido + metadata: pestaña /videos del canal
  let video = null;
  const page = await fetchText(`https://www.youtube.com/channel/${channelId}/videos`, ytConsent).catch(() => null);
  if (page) {
    const name = page.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
    if (name) displayName = decodeXml(name);
    avatar = page.match(/<meta property="og:image" content="([^"]*)"/)?.[1] || null;

    const id = page.match(/"contentId":"([\w-]{11})"/)?.[1] || page.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/)?.[1];
    const rawTitle = page.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/)?.[1];
    const title = rawTitle ? JSON.parse(`"${rawTitle}"`) : "Nuevo video";
    if (id) video = { id, title, url: `https://www.youtube.com/watch?v=${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }

  return { displayName, avatar, live, video };
}

// ── TikTok (sin API oficial de directos: página del perfil + webcast check) ─
async function checkTiktok(username) {
  let user = username.trim().replace(/^<|>$/g, "").replace(/^@/, "").replace(/[/?#].*$/, "");
  const res = await fetch(`https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=${encodeURIComponent(user)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`TikTok HTTP ${res.status}`);
  const json = await res.json();
  if (json.message === "user_not_found" || json.statusCode === 19881007) return { notFound: true };
  if (!json.data) throw new Error(`TikTok respondió ${json.message || json.statusCode}`);

  const { user: info, liveRoom: room } = json.data;
  let live = null;
  // status 2 = en directo, 4 = sin directo
  if (room?.status === 2 || info?.status === 2) {
    live = {
      id: String(info?.roomId || room?.startTime || (room?.status === 2 ? "live" : Date.now())),
      title: room?.title || "En directo en TikTok",
      category: room?.gameTagId ? "Gaming" : null,
      viewers: room?.liveRoomStats?.userCount ?? null,
      thumbnail: room?.coverUrl || info?.avatarLarger || null,
      url: `https://www.tiktok.com/@${user}/live`
    };
  }

  return { displayName: info?.nickname || user, avatar: info?.avatarMedium || null, live };
}

const PLATFORMS = {
  twitch: { name: "Twitch", color: 0x9146ff, emoji: "🟣", check: checkTwitch, profile: (u) => `https://twitch.tv/${u}` },
  youtube: { name: "YouTube", color: 0xff0000, emoji: "🔴", check: checkYoutube, profile: (u) => `https://www.youtube.com/${u.startsWith("@") || u.startsWith("UC") ? u : "@" + u}` },
  kick: { name: "Kick", color: 0x53fc18, emoji: "🟢", check: checkKick, profile: (u) => `https://kick.com/${u}` },
  tiktok: { name: "TikTok", color: 0x111111, emoji: "⚫", check: checkTiktok, profile: (u) => `https://www.tiktok.com/@${u.replace(/^@/, "")}` }
};

module.exports = { PLATFORMS };
