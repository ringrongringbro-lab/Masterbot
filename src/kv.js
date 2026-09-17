import { getEnv } from "./runtime.js";

const SEP = "::";
const k = (...parts) => parts.join(SEP);

function getDB() {
    return getEnv().DB;
}

// ==========================================
// D1 as a KV Store (No 1,000 list limit!)
// ==========================================

async function kvGet(key) {
    try {
        const db = getDB();
        const now = Math.floor(Date.now() / 1000);
        // Thoda garbage collection taaki DB bhare na (1% chance)
        if (Math.random() < 0.01) {
            db.prepare("DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now).run().catch(()=>{});
        }
        const row = await db.prepare("SELECT value FROM kv_store WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)").bind(key, now).first();
        return row ? JSON.parse(row.value) : null;
    } catch (e) {
        return null;
    }
}

async function kvPut(key, value, ttlSeconds) {
    try {
        const db = getDB();
        const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds) : null;
        await db.prepare("INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), expiresAt).run();
    } catch (e) {}
}

async function kvDelete(key) {
    try {
        await getDB().prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
    } catch (e) {}
}

async function listKeys(prefix, limit = null, maxPages = 5) {
    try {
        const db = getDB();
        const now = Math.floor(Date.now() / 1000);
        let query = "SELECT key FROM kv_store WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)";
        const binds = [prefix + "%", now];
        if (limit) {
            query += " LIMIT ?";
            binds.push(limit);
        }
        const { results } = await db.prepare(query).bind(...binds).all();
        return results.map(r => r.key);
    } catch (e) {
        return [];
    }
}

async function listValues(prefix, limit = null) {
    try {
        const db = getDB();
        const now = Math.floor(Date.now() / 1000);
        let query = "SELECT value FROM kv_store WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)";
        const binds = [prefix + "%", now];
        if (limit) {
            query += " LIMIT ?";
            binds.push(limit);
        }
        const { results } = await db.prepare(query).bind(...binds).all();
        return results.map(r => JSON.parse(r.value));
    } catch (e) {
        return [];
    }
}

// ==========================================
// Bot Logic (Aapka Original Code - Bina badle)
// ==========================================

export async function saveClone(botId, data) {
  await kvPut(k("clones", botId), data);
}

export async function getClone(botId) {
  return await kvGet(k("clones", botId));
}

export async function deleteClone(botId) {
  await kvDelete(k("clones", botId));
}

export async function listClones(statusFilter = null) {
  const all = await listValues(k("clones", ""));
  return statusFilter ? all.filter((c) => c.status === statusFilter) : all;
}

export async function listClonesByOwner(ownerUid) {
  const all = await listValues(k("clones", ""));
  return all.filter((c) => Number(c.owner_id) === Number(ownerUid));
}

export async function addStorageChannel(botId, channelId, title) {
  await kvPut(k("storage", botId, String(channelId)), { channel_id: channelId, title, added_at: Date.now() });
}

export async function listStorageChannels(botId) {
  return await listValues(k("storage", botId, ""));
}

export async function removeStorageChannel(botId, channelId) {
  await kvDelete(k("storage", botId, String(channelId)));
}

export async function addForcesubChannel(botId, channelId, title, chatType) {
  await kvPut(k("forcesub", botId, String(channelId)), { channel_id: channelId, title, chat_type: chatType, added_at: Date.now() });
}

export async function listForcesubChannels(botId) {
  return await listValues(k("forcesub", botId, ""));
}

export async function removeForcesubChannel(botId, channelId) {
  await kvDelete(k("forcesub", botId, String(channelId)));
}

const DEFAULT_SETTINGS = { autodelete_minutes: 10, protect_content: 1, shortener_enabled: 0, shortener_time: 960, welcome_images: [] };

export async function getSettings(botId) {
  const v = await kvGet(k("settings", botId));
  return v ? { ...DEFAULT_SETTINGS, ...v } : { ...DEFAULT_SETTINGS };
}

export async function updateSetting(botId, field, value) {
  const current = await getSettings(botId);
  current[field] = value;
  await kvPut(k("settings", botId), current);
}

export async function addShortener(botId, siteUrl, apiKey) {
  const id = crypto.randomUUID().slice(0, 8);
  await kvPut(k("shorteners", botId, id), { id, site_url: siteUrl, api_key: apiKey });
  return id;
}

export async function listShorteners(botId) {
  return await listValues(k("shorteners", botId, ""));
}

export async function removeShortener(botId, id) {
  await kvDelete(k("shorteners", botId, id));
}

export async function setVerified(botId, userId, minutes) {
  await kvPut(k("verified", botId, String(userId)), { valid_until: Date.now() + minutes * 60 * 1000 }, minutes * 60);
}

export async function isVerified(botId, userId) {
  const v = await kvGet(k("verified", botId, String(userId)));
  return !!(v && v.valid_until > Date.now());
}

export async function savePassToken(token, data, ttlMinutes = 15) {
  await kvPut(k("passes", token), data, ttlMinutes * 60);
}

export async function getPassToken(token) {
  return await kvGet(k("passes", token));
}

export async function deletePassToken(token) {
  await kvDelete(k("passes", token));
}

export async function getState(botId, userId) {
  return await kvGet(k("states", botId, String(userId)));
}

export async function setState(botId, userId, state) {
  await kvPut(k("states", botId, String(userId)), state, 30 * 60);
}

export async function clearState(botId, userId) {
  await kvDelete(k("states", botId, String(userId)));
}

export async function recordUser(botId, userId) {
  const key = k("users", botId, String(userId));
  const existing = await kvGet(key);
  if (!existing) await kvPut(key, { first_seen: Date.now() });
}

export async function listUsers(botId) {
  const prefix = k("users", botId, "");
  const keys = await listKeys(prefix);
  return keys.map((name) => name.slice(prefix.length));
}

export async function schedulePendingDelete(botId, chatId, messageId, minutes) {
  // Aapne auto-delete band karne bola hai, isliye hum isko DB me add hi nahi kar rahe
  // Taki aapka database faltoo mein bhare nahi!
  return;
}

export async function listDuePendingDeletes(limit = 50) {
  return [];
}

export async function removePendingDelete(key) {
  await kvDelete(key);
}

export async function enqueueBroadcast(botId, fromChatId, messageId, targetUids) {
  const now = Date.now();
  for (const uid of targetUids) {
    const id = crypto.randomUUID();
    await kvPut(k("broadcast_queue", id), { bot_id: botId, from_chat_id: fromChatId, message_id: messageId, target_uid: uid, created_at: now }, 24 * 60 * 60);
  }
}

export async function popBroadcastBatch(limit = 20) {
  const keys = await listKeys(k("broadcast_queue", ""), limit);
  const out = [];
  for (const key of keys) {
    const v = await kvGet(key);
    if (v) out.push({ key, value: v });
  }
  return out;
}

export async function removeBroadcastItem(key) {
  await kvDelete(key);
}

export async function saveBridge(ownerChatId, ownerMsgId, requesterUid) {
  await kvPut(k("bridge", String(ownerChatId), String(ownerMsgId)), { requester_uid: requesterUid }, 30 * 24 * 60 * 60);
}

export async function findBridge(ownerChatId, ownerMsgId) {
  return await kvGet(k("bridge", String(ownerChatId), String(ownerMsgId)));
}
