import { api } from "./telegram.js";
import { getBotToken } from "./config.js";
import * as kv from "./kv.js";

// Cloudflare Workers' FREE plan allows only 50 "external" subrequests
// (real fetch() calls, like these Telegram API calls) per invocation — KV
// operations don't count against that number, only outbound HTTP does.
// Each pending-delete and each broadcast item costs exactly one Telegram
// fetch() call, so these two batch sizes are kept comfortably under 50
// combined. Running on a Paid plan? Feel free to raise both back toward
// the original 50 / 20.
const DELETE_BATCH = 20;
const BROADCAST_BATCH = 20;

async function resolveToken(botId) {
  if (botId === "main") return getBotToken();
  const clone = await kv.getClone(botId);
  return clone ? clone.bot_token : null;
}

export async function runCleanupJob() {
  // 1. delete expired delivered files
  const due = await kv.listDuePendingDeletes(DELETE_BATCH);
  for (const item of due) {
    const token = await resolveToken(item.value.bot_id);
    if (token) {
      const tg = api(token);
      await tg.deleteMessage(item.value.chat_id, item.value.message_id).catch(() => {});
    }
    await kv.removePendingDelete(item.key);
  }

  // 2. drain a batch of the broadcast queue
  const batch = await kv.popBroadcastBatch(BROADCAST_BATCH);
  for (const item of batch) {
    const token = await resolveToken(item.value.bot_id);
    if (token) {
      const tg = api(token);
      await tg.copyMessage(item.value.target_uid, item.value.from_chat_id, item.value.message_id).catch(() => {});
    }
    await kv.removeBroadcastItem(item.key);
  }
}
