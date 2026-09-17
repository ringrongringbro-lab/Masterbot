import { getKvNamespace } from "./runtime.js";

// Deno KV uses array keys (["clones", botId]) and list({ prefix: [...] })
// returns full key+value pairs directly. Cloudflare Workers KV only has
// flat string keys, and list() returns key NAMES only — you must get() each
// value separately. This file re-implements every function from the
// original kv.js with that in mind, keeping the exact same exported names
// and signatures so mainbot.js / storebot.js / cron.js don't need to change.

const SEP = "::";
const k = (...parts) => parts.join(SEP);

async function kvGet(key) {
  const ns = getKvNamespace();
  return await ns.get(key, { type: "json" });
}

// ttlSeconds is optional. Cloudflare KV requires expirationTtl >= 60s, so
// anything shorter gets bumped up to 60.
async function kvPut(key, value, ttlSeconds) {
  const ns = getKvNamespace();
  const opts = {};
  if (ttlSeconds) opts.expirationTtl = Math.max(60, Math.floor(ttlSeconds));
  await ns.put(key, JSON.stringify(value), opts);
}

async function kvDelete(key) {
  const ns = getKvNamespace();
  await ns.delete(key);
}

// Lists key NAMES under a prefix (paginating up to maxPages x 1000 keys).
// Free-tier note: each page is one "list" operation against the 1,000/day
// KV quota, so maxPages is kept small — this bot's collections are small
// per-bot in practice (channels, shorteners, pending items), not millions.
async function listKeys(prefix, limit = null, maxPages = 5) {
  const ns = getKvNamespace();
  let cursor;
  const keys = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await ns.list({ prefix, cursor, limit: limit ? Math.min(limit, 1000) : 1000 });
    for (const entry of res.keys) keys.push(entry.name);
    if (limit && keys.length >= limit) return keys.slice(0, limit);
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return keys;
}

// Lists values under a prefix (one get() per key — list() alone can't give values).
async function listValues(prefix, limit = null) {
  const keys = await listKeys(prefix, limit);
  const out = [];
  for (const key of keys) {
    const v = await kvGet(key);
    if (v !== null) out.push(v);
  }
  return out;
}

// ---------- Clones (also doubles as the clone-request record via `status`) ----------

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

// Any status counts (pending + approved) so users can't dodge the limit by
// spamming requests — owners are exempt from this limit entirely.
export async function listClonesByOwner(ownerUid) {
  const all = await listValues(k("clones", ""));
  return all.filter((c) => Number(c.owner_id) === Number(ownerUid));
}

// ---------- Storage channels (multiple per bot) ----------

export async function addStorageChannel(botId, channelId, title) {
  await kvPut(k("storage", botId, String(channelId)), { channel_id: channelId, title, added_at: Date.now() });
}

export async function listStorageChannels(botId) {
  return await listValues(k("storage", botId, ""));
}

export async function removeStorageChannel(botId, channelId) {
  await kvDelete(k("storage", botId, String(channelId)));
}

// ---------- Force-sub channels/groups (multiple per bot) ----------

export async function addForcesubChannel(botId, channelId, title, chatType) {
  await kvPut(k("forcesub", botId, String(channelId)), { channel_id: channelId, title, chat_type: chatType, added_at: Date.now() });
}

export async function listForcesubChannels(botId) {
  return await listValues(k("forcesub", botId, ""));
}

export async function removeForcesubChannel(botId, channelId) {
  await kvDelete(k("forcesub", botId, String(channelId)));
}

// ---------- Settings (per bot) ----------

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

// ---------- Shortener accounts (multiple per bot) ----------

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

// ---------- Verified passes (shortener bypass window) ----------

export async function setVerified(botId, userId, minutes) {
  await kvPut(k("verified", botId, String(userId)), { valid_until: Date.now() + minutes * 60 * 1000 }, minutes * 60);
}

export async function isVerified(botId, userId) {
  const v = await kvGet(k("verified", botId, String(userId)));
  return !!(v && v.valid_until > Date.now());
}

// ---------- Short-lived "pass" tokens (for shortener redirect flow) ----------

export async function savePassToken(token, data, ttlMinutes = 15) {
  await kvPut(k("passes", token), data, ttlMinutes * 60);
}

export async function getPassToken(token) {
  return await kvGet(k("passes", token));
}

export async function deletePassToken(token) {
  await kvDelete(k("passes", token));
}

// ---------- FSM state (per user per bot, for multi-step commands) ----------

export async function getState(botId, userId) {
  return await kvGet(k("states", botId, String(userId)));
}

export async function setState(botId, userId, state) {
  await kvPut(k("states", botId, String(userId)), state, 30 * 60); // auto-clears after 30 min if abandoned
}

export async function clearState(botId, userId) {
  await kvDelete(k("states", botId, String(userId)));
}

// ---------- Users seen per bot (for /broadcast targeting) ----------

export async function recordUser(botId, userId) {
  const key = k("users", botId, String(userId));
  const existing = await kvGet(key);
  if (!existing) await kvPut(key, { first_seen: Date.now() });
}

export async function listUsers(botId) {
  // The uid is already in the key name, so this skips a get() per user
  // (saves KV read-quota vs. fetching every user's value just to discard it).
  const prefix = k("users", botId, "");
  const keys = await listKeys(prefix);
  return keys.map((name) => name.slice(prefix.length));
}

// ---------- Pending auto-deletes ----------

export async function schedulePendingDelete(botId, chatId, messageId, minutes) {
  const id = crypto.randomUUID();
  const deleteAt = Date.now() + minutes * 60 * 1000;
  // TTL a bit longer than delete_at as a safety net — the cron job normally
  // removes this explicitly, the TTL just prevents orphaned rows if it ever
  // doesn't (e.g. cron paused, delete fails silently).
  await kvPut(k("pending_deletes", id), { bot_id: botId, chat_id: chatId, message_id: messageId, delete_at: deleteAt }, minutes * 60 + 300);
}

export async function listDuePendingDeletes(limit = 50) {
  const now = Date.now();
  const keys = await listKeys(k("pending_deletes", ""), 200);
  const due = [];
  for (const key of keys) {
    const v = await kvGet(key);
    if (v && v.delete_at <= now) due.push({ key, value: v });
    if (due.length >= limit) break;
  }
  return due;
}

export async function removePendingDelete(key) {
  await kvDelete(key);
}

// ---------- Broadcast queue ----------

export async function enqueueBroadcast(botId, fromChatId, messageId, targetUids) {
  const now = Date.now();
  // No atomic batch API in Workers KV — writes go one at a time. This is
  // also naturally capped by the free tier's 1,000 writes/day, so a huge
  // audience will hit that ceiling before this loop becomes a real problem.
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

// ---------- Reply bridge (owner <-> requester chat) ----------

export async function saveBridge(ownerChatId, ownerMsgId, requesterUid) {
  await kvPut(k("bridge", String(ownerChatId), String(ownerMsgId)), { requester_uid: requesterUid }, 30 * 24 * 60 * 60);
}

export async function findBridge(ownerChatId, ownerMsgId) {
  return await kvGet(k("bridge", String(ownerChatId), String(ownerMsgId)));
}
