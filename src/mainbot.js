import { api, esc, looksLikeBotToken } from "./telegram.js";
import { OWNERS, getBotToken, getWebhookSecret, MAX_CLONES_PER_USER, CLONE_COMMANDS } from "./config.js";
import * as kv from "./kv.js";

const isOwner = (uid) => OWNERS.includes(Number(uid));

function approveRejectKeyboard(botId) {
  return { inline_keyboard: [[{ text: "✅ Approve", callback_data: `approve_${botId}` }, { text: "❌ Reject", callback_data: `reject_${botId}` }]] };
}

async function notifyAllOwners(tg, text, extra = {}) {
  const sent = [];
  for (const ownerId of OWNERS) {
    const res = await tg.send(ownerId, text, extra);
    if (res.ok) sent.push({ chatId: ownerId, msgId: res.result.message_id });
  }
  return sent;
}

async function activateClone(botId, botData, origin) {
  const cloneTg = api(botData.bot_token);
  const wh = await cloneTg.setWebhook(`${origin}/tg/clone/${botId}`, getWebhookSecret());
  if (wh.ok) {
    await kv.saveClone(botId, { ...botData, status: "approved" });
    await cloneTg.setMyCommands(CLONE_COMMANDS).catch(() => {}); // best-effort, don't block activation on this
  }
  return wh;
}

// ---------- Callback buttons ----------

async function handleCallback(cb, origin) {
  const tg = api(getBotToken());
  const [action, botId] = [cb.data.split("_")[0], cb.data.split("_").slice(1).join("_")];
  const botData = await kv.getClone(botId);
  if (!botData) return tg.answerCb(cb.id, "Not found / already processed", true);

  if (action === "approve") {
    const wh = await activateClone(botId, botData, origin);
    if (!wh.ok) {
      await tg.send(cb.message.chat.id, `⚠️ Webhook setup fail: ${esc(wh.description || "unknown")}`);
      return tg.answerCb(cb.id, "Webhook failed");
    }
    await tg.edit(cb.message.chat.id, cb.message.message_id, `${cb.message.text}\n\n✅ APPROVED`);
    await tg.send(
      botData.owner_id,
      `🎉 Badhai ho! Aapka bot @${esc(botData.bot_username)} approve ho gaya hai aur ab live hai!\n\n` +
        `━━━━━━━━━━━━━━\n🎉 Congrats! Your bot @${esc(botData.bot_username)} is approved and live now!`
    );
    return tg.answerCb(cb.id, "Approved!");
  }

  if (action === "reject") {
    const cloneTg = api(botData.bot_token);
    await cloneTg.deleteWebhook();
    await kv.deleteClone(botId);
    await tg.edit(cb.message.chat.id, cb.message.message_id, `${cb.message.text}\n\n❌ REJECTED`);
    await tg.send(
      botData.owner_id,
      `❌ Maaf kijiye, aapka bot @${esc(botData.bot_username)} approve nahi ho paya.\n\n━━━━━━━━━━━━━━\n❌ Sorry, your bot @${esc(botData.bot_username)} was not approved.`
    );
    return tg.answerCb(cb.id, "Rejected");
  }
}

// ---------- Commands ----------

async function cmdStart(msg, tg) {
  await kv.recordUser("main", msg.from.id);
  let text =
    `👋 Namaste ${esc(msg.from.first_name)}!\n\nApna Bot Token @BotFather se bhejein — hum aapka khud ka File Store Bot bana denge.\n\n` +
    `━━━━━━━━━━━━━━\n👋 Hello ${esc(msg.from.first_name)}!\n\nSend your Bot Token from @BotFather — we'll set up your own File Store Bot.`;
  if (isOwner(msg.from.id)) text += `\n\n👑 Owner: /list /pending /broadcast`;
  return tg.send(msg.chat.id, text);
}

async function cmdList(msg, tg) {
  if (!isOwner(msg.from.id)) return;
  const clones = await kv.listClones("approved");
  if (!clones.length) return tg.send(msg.chat.id, "No active bots.");
  const lines = ["🤖 <b>Active Bots:</b>", ...clones.map((c) => `@${esc(c.bot_username)} — Owner: <code>${esc(c.owner_id)}</code>`)];
  return tg.send(msg.chat.id, lines.join("\n"));
}

async function cmdPending(msg, tg) {
  if (!isOwner(msg.from.id)) return;
  const pending = await kv.listClones("pending");
  if (!pending.length) return tg.send(msg.chat.id, "📭 No pending requests.");
  for (const r of pending) {
    await tg.send(msg.chat.id, `🚨 <b>Pending</b>\nBot: @${esc(r.bot_username)}\nOwner: <code>${esc(r.owner_id)}</code>`, {
      reply_markup: approveRejectKeyboard(r.bot_id),
    });
  }
}

async function cmdBroadcast(msg, tg) {
  if (!isOwner(msg.from.id)) return;
  if (!msg.reply_to_message) return tg.send(msg.chat.id, "❌ Reply to a message with /broadcast to send it to all users.");
  const uids = await kv.listUsers("main");
  if (!uids.length) return tg.send(msg.chat.id, "No users recorded yet.");
  await kv.enqueueBroadcast("main", msg.chat.id, msg.reply_to_message.message_id, uids);
  return tg.send(msg.chat.id, `📢 Broadcast queued for ${uids.length} users. Sending gradually in the background.`);
}

// ---------- Token submission -> new clone request ----------

async function handleTokenSubmission(msg, tg, origin) {
  const token = msg.text.trim();
  const ownerId = msg.from.id;

  if (!isOwner(ownerId)) {
    const existing = await kv.listClonesByOwner(ownerId);
    if (existing.length >= MAX_CLONES_PER_USER) {
      return tg.send(
        msg.chat.id,
        `❌ Aap max ${MAX_CLONES_PER_USER} bots hi clone kar sakte hain. Naya banane se pehle koi purana hatwayein.\n\n` +
          `━━━━━━━━━━━━━━\n❌ You can clone a maximum of ${MAX_CLONES_PER_USER} bots. Remove an existing one before requesting a new one.`
      );
    }
  }

  const checkTg = api(token);
  const me = await checkTg.getMe();
  if (!me.ok) return tg.send(msg.chat.id, `❌ Invalid Token! ${esc(me.description || "")}`);

  const botId = String(me.result.id);
  const botUsername = me.result.username || "bot";
  const botData = { bot_id: botId, owner_id: ownerId, bot_token: token, bot_username: botUsername, status: isOwner(ownerId) ? "approved" : "pending" };
  await kv.saveClone(botId, botData);

  if (isOwner(ownerId)) {
    const wh = await checkTg.setWebhook(`${origin}/tg/clone/${botId}`, getWebhookSecret());
    if (!wh.ok) return tg.send(msg.chat.id, `⚠️ Saved but webhook failed: ${esc(wh.description || "")}`);
    await checkTg.setMyCommands(CLONE_COMMANDS).catch(() => {});
    return tg.send(msg.chat.id, `✅ Owner mode: @${esc(botUsername)} is LIVE immediately!`);
  }

  await tg.send(msg.chat.id, `⏳ Aapki request Admin ko bhej di gayi hai.\n\n━━━━━━━━━━━━━━\n⏳ Your request has been sent to the Admin for approval.`);
  const notice =
    `🚨 <b>New Bot Request!</b>\nUser: ${esc(msg.from.first_name)} (ID: <code>${esc(ownerId)}</code>)\nBot: @${esc(botUsername)}\n\n` +
    `Reply to this message to chat with the user directly.`;
  const sent = await notifyAllOwners(tg, notice, { reply_markup: approveRejectKeyboard(botId) });
  for (const s of sent) await kv.saveBridge(s.chatId, s.msgId, ownerId);
}

// ---------- Reply bridge (owner <-> requester) ----------

async function tryBridge(msg, tg) {
  const fromId = msg.from.id;

  if (isOwner(fromId) && msg.reply_to_message) {
    const bridge = await kv.findBridge(msg.chat.id, msg.reply_to_message.message_id);
    if (bridge) {
      await tg.copyMessage(bridge.requester_uid, msg.chat.id, msg.message_id);
      await tg.send(msg.chat.id, "✅ Sent.");
      return true;
    }
  }

  if (!isOwner(fromId)) {
    const header = `💬 <b>Message from ${esc(msg.from.first_name)}</b> (ID: <code>${esc(fromId)}</code>):`;
    const sent = await notifyAllOwners(tg, header);
    for (const s of sent) await kv.saveBridge(s.chatId, s.msgId, fromId);
    for (const s of sent) {
      const copy = await tg.copyMessage(s.chatId, msg.chat.id, msg.message_id);
      if (copy.ok) await kv.saveBridge(s.chatId, copy.result.message_id, fromId);
    }
    await tg.send(msg.chat.id, "✅ Message sent to Admin.");
    return true;
  }
  return false;
}

// ---------- Router ----------

export async function handleMainBot(update, origin) {
  const tg = api(getBotToken());

  if (update.callback_query) return handleCallback(update.callback_query, origin);

  const msg = update.message;
  if (!msg || !msg.from) return;

  if (msg.text && msg.text.startsWith("/")) {
    const cmd = msg.text.split(/[\s@]/)[0].slice(1).toLowerCase();
    if (cmd === "start") return cmdStart(msg, tg);
    if (cmd === "list") return cmdList(msg, tg);
    if (cmd === "pending") return cmdPending(msg, tg);
    if (cmd === "broadcast") return cmdBroadcast(msg, tg);
    return;
  }

  if (msg.text && looksLikeBotToken(msg.text)) return handleTokenSubmission(msg, tg, origin);

  return tryBridge(msg, tg);
}
