import { getLinkSecretKey } from "./config.js";

// A link encodes: owner_id, chat_id (with its sign/type), first_message_id, count.
// It's signed with HMAC so it can never be forged or edited, and needs NO database
// row — the link itself IS the data. That's why get/batch links "never expire".

// Telegram chat IDs come in 3 shapes:
//   0 = channel/supergroup, always looks like -100XXXXXXXXXX
//   1 = a small/basic group, looks like -XXXXXXXXX (no "100")
//   2 = a positive ID (rare here, kept for safety)
// The earlier version always assumed shape 0, which silently broke group links.
function splitChatId(chatId) {
  const s = String(chatId);
  if (s.startsWith("-100")) return { type: 0, clean: BigInt(s.slice(4)) };
  if (s.startsWith("-")) return { type: 1, clean: BigInt(s.slice(1)) };
  return { type: 2, clean: BigInt(s) };
}

function rebuildChatId(type, clean) {
  if (type === 0) return Number(BigInt("-100" + clean.toString()));
  if (type === 1) return Number(BigInt("-" + clean.toString()));
  return Number(clean);
}

async function hmacSign(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

function requireSecret() {
  const secretKey = getLinkSecretKey();
  if (!secretKey || secretKey.length < 16) {
    throw new Error("LINK_SECRET_KEY is not set (or too short) — set a long random value with `wrangler secret put LINK_SECRET_KEY` before generating links.");
  }
  return new TextEncoder().encode(secretKey);
}

export async function packLink(ownerId, chatId, firstId, count = 1) {
  const secret = requireSecret();
  const { type, clean } = splitChatId(chatId);

  // layout: ownerId(8) + chatType(1) + cleanChatId(8) + firstId(4) + count(2) = 23 bytes
  const buf = new ArrayBuffer(23);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(ownerId), false);
  view.setUint8(8, type);
  view.setBigUint64(9, clean, false);
  view.setUint32(17, firstId, false);
  view.setUint16(21, count, false);

  const sigFull = await hmacSign(secret, buf);
  const sig = sigFull.slice(0, 6);
  const full = new Uint8Array(29);
  full.set(new Uint8Array(buf), 0);
  full.set(sig, 23);

  const b64 = btoa(String.fromCharCode(...full)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `get_${b64}`;
}

export async function unpackLink(payload) {
  if (!payload || typeof payload !== "string") return null;
  let raw = payload.trim();
  for (const p of ["pass_get_", "pass_get-", "get_", "get-"]) {
    if (raw.startsWith(p)) {
      raw = raw.slice(p.length);
      break;
    }
  }
  try {
    let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const binStr = atob(b64);
    const full = Uint8Array.from(binStr, (c) => c.charCodeAt(0));
    if (full.length !== 29) return null;

    const data = full.slice(0, 23);
    const sigGot = full.slice(23);
    const secret = requireSecret();
    const sigCalcFull = await hmacSign(secret, data.buffer);
    const sigCalc = sigCalcFull.slice(0, 6);
    for (let i = 0; i < 6; i++) if (sigGot[i] !== sigCalc[i]) return null;

    const view = new DataView(data.buffer);
    const ownerId = Number(view.getBigUint64(0, false));
    const chatType = view.getUint8(8);
    const clean = view.getBigUint64(9, false);
    const firstId = view.getUint32(17, false);
    const count = view.getUint16(21, false);
    const channelId = rebuildChatId(chatType, clean);

    return {
      owner_id: ownerId,
      channel_id: channelId,
      first_id: firstId,
      count,
      last_id: firstId + count - 1,
      link_type: count === 1 ? "single" : "batch",
    };
  } catch {
    return null;
  }
}

export function randomToken(len = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}
