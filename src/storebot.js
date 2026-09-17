import { api, esc, tgCall, getForwardInfo } from "./telegram.js";
import { OWNERS, MAX_BATCH_PER_REQUEST, DEFAULT_AUTODELETE_MIN, DEFAULT_SHORTENER_MIN } from "./config.js";
import { packLink, unpackLink, randomToken } from "./linkutil.js";
import * as kv from "./kv.js";

const isOwnerOf = (uid, botData) => Number(uid) === Number(botData.owner_id) || OWNERS.includes(Number(uid));

async function fetchShortUrl(siteUrl, apiKey, destUrl) {
  try {
    const domain = siteUrl.replace(/^https?:\/\//, "").split("/")[0];
    const endpoint = `https://${domain}/api?api=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(destUrl)}`;
    const r = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.shortenedUrl || data.short_url || data.short || null;
  } catch {
    return null;
  }
}

async function buildJoinKeyboard(tg, missing, botUsername, startParam) {
  const buttons = [];
  for (const fs of missing) {
    let link = null;
    if (String(fs.channel_id).startsWith("@")) {
      link = `https://t.me/${String(fs.channel_id).replace("@", "")}`;
    } else {
      const inv = await tg.exportInviteLink(fs.channel_id);
      link = inv.ok ? inv.result : null;
    }
    if (link) buttons.push([{ text: `📢 Join ${fs.title}`, url: link }]);
  }
  buttons.push([{ text: "🔄 Try Again", url: `https://t.me/${botUsername}?start=${startParam}` }]);
  return { inline_keyboard: buttons };
}

// ---------- /start (welcome + deep-link delivery) ----------

async function cmdStart(msg, tg, botData, param, origin) {
  await kv.recordUser(botData.bot_id, msg.from.id);

  if (!param) {
    let text =
      `👋 Namaste ${esc(msg.from.first_name)}!\n\n@${esc(botData.bot_username)} me aapka swagat hai — main files store karke unke shareable links deta hoon.\n\n` +
      `━━━━━━━━━━━━━━\n👋 Hello ${esc(msg.from.first_name)}!\n\nWelcome to @${esc(botData.bot_username)} — I store files and give you shareable links.`;
    if (isOwnerOf(msg.from.id, botData)) text += `\n\nSend /help for admin commands.`;
    return tg.send(msg.chat.id, text);
  }

  let payload = param;
  let fromPass = false;
  if (param.startsWith("pass_")) {
    const passData = await kv.getPassToken(param.slice(5));
    if (!passData) return tg.send(msg.chat.id, "❌ Verification link expired. Please open the original link again.");
    await kv.deletePassToken(param.slice(5));
    payload = passData.payload;
    fromPass = true;
  }

  const link = await unpackLink(payload);
  if (!link) return tg.send(msg.chat.id, "❌ Invalid or corrupted link.");

  // Force-sub check
  const forcesubList = await kv.listForcesubChannels(botData.bot_id);
  const missing = [];
  for (const fs of forcesubList) {
    const member = await tg.getChatMember(fs.channel_id, msg.from.id);
    if (member.ok && ["left", "kicked"].includes(member.result.status)) missing.push(fs);
  }
  if (missing.length) {
    const kb = await buildJoinKeyboard(tg, missing, botData.bot_username, payload);
    return tg.send(msg.chat.id, "⚠️ Files access karne ke liye pehle ye join karein:\n\n━━━━━━━━━━━━━━\n⚠️ You must join these first to access the files:", { reply_markup: kb });
  }

  // Shortener check
  const settings = await kv.getSettings(botData.bot_id);
  if (!fromPass && settings.shortener_enabled) {
    const accounts = await kv.listShorteners(botData.bot_id);
    if (accounts.length && !(await kv.isVerified(botData.bot_id, msg.from.id))) {
      const acc = accounts[Math.floor(Math.random() * accounts.length)];
      const pToken = randomToken();
      await kv.savePassToken(pToken, { payload }, 15);
      const destUrl = `https://t.me/${botData.bot_username}?start=pass_${pToken}`;
      const shortUrl = await fetchShortUrl(acc.site_url, acc.api_key, destUrl);
      if (shortUrl) {
        return tg.send(msg.chat.id, "🔒 Files unlock karne ke liye niche wala link solve karein:\n\n━━━━━━━━━━━━━━\n🔒 Solve the link below to unlock your files:", {
          reply_markup: { inline_keyboard: [[{ text: "🔗 Unlock Files", url: shortUrl }]] },
        });
      }
    }
  }
  if (fromPass) await kv.setVerified(botData.bot_id, msg.from.id, settings.shortener_time || DEFAULT_SHORTENER_MIN);

  // Deliver
  const minutes = settings.autodelete_minutes ?? DEFAULT_AUTODELETE_MIN;
  const protect = !!settings.protect_content;
  const start = Math.min(link.first_id, link.last_id);
  const rawEnd = Math.max(link.first_id, link.last_id);
  const end = Math.min(rawEnd, start + MAX_BATCH_PER_REQUEST - 1);
  const total = rawEnd - start + 1;

  let sentCount = 0;
  for (let i = start; i <= end; i++) {
    const sent = await tg.copyMessage(msg.chat.id, link.channel_id, i, { protect_content: protect });
    if (sent.ok) {
      sentCount++;
      if (minutes > 0) await kv.schedulePendingDelete(botData.bot_id, msg.chat.id, sent.result.message_id, minutes);
    }
  }

  let footer =
    minutes > 0
      ? `⏱️ ${minutes} minute me auto-delete ho jayega.\n\n━━━━━━━━━━━━━━\n⏱️ Auto-deletes in ${minutes} minutes.`
      : `✅ ${sentCount} file(s) delivered.`;
  if (total > MAX_BATCH_PER_REQUEST) footer += `\n\n⚠️ Batch me ${total} files thi, sirf pehli ${MAX_BATCH_PER_REQUEST} bheji gayi (platform limit). Baaki ke liye admin se poochein.`;
  return tg.send(msg.chat.id, footer);
}

// ---------- Admin: storage / forcesub ----------

async function cmdAddStorage(msg, tg, botData) {
  await kv.setState(botData.bot_id, msg.from.id, { flow: "add_storage" });
  return tg.send(msg.chat.id, "Storage Channel se koi bhi message forward karein:\n\n━━━━━━━━━━━━━━\nForward any message from your Storage Channel:");
}

async function cmdMyStorage(msg, tg, botData) {
  const list = await kv.listStorageChannels(botData.bot_id);
  if (!list.length) return tg.send(msg.chat.id, "No Storage Channels added yet.");
  return tg.send(msg.chat.id, ["📁 <b>Storage Channels:</b>", ...list.map((c) => `• ${esc(c.title)} | ID: <code>${c.channel_id}</code>`)].join("\n"));
}

async function cmdRemoveStorage(msg, tg, botData, args) {
  if (!args[0]) return tg.send(msg.chat.id, "Usage: /removestorage <channel_id>");
  await kv.removeStorageChannel(botData.bot_id, args[0]);
  return tg.send(msg.chat.id, "✅ Removed.");
}

async function resolveAndAddForcesub(msg, tg, botData, rawInput) {
  const input = rawInput.trim();
  const chatIdOrUsername = /^-?\d+$/.test(input) ? Number(input) : input;
  const chatRes = await tgCall(botData.bot_token, "getChat", { chat_id: chatIdOrUsername });
  if (!chatRes.ok) {
    return tg.send(
      msg.chat.id,
      `❌ Chat nahi mila: ${esc(chatRes.description || "")}\n\nDhyan rakhein: bot pehle se us channel/group me member/admin hona chahiye.\n\n━━━━━━━━━━━━━━\n❌ Couldn't find that chat: ${esc(chatRes.description || "")}\n\nMake sure the bot is already a member/admin of that channel/group.`
    );
  }
  const chat = chatRes.result;
  const chatType = chat.type === "channel" ? "channel" : "group";
  await kv.addForcesubChannel(botData.bot_id, chat.id, chat.title || chat.username || "Unknown", chatType);
  return tg.send(msg.chat.id, `✅ Force-Sub Added: ${esc(chat.title || chat.username)} (${chatType})`);
}

async function cmdAddForcesub(msg, tg, botData, args) {
  if (args && args[0]) return resolveAndAddForcesub(msg, tg, botData, args[0]);
  await kv.setState(botData.bot_id, msg.from.id, { flow: "add_forcesub" });
  return tg.send(
    msg.chat.id,
    "Force-Sub Channel/Group se koi message forward karein — YA seedha channel/group ki ID ya @username bhejein (groups ke liye ye zaroori hai, kyunki groups me forward se pehchan nahi hoti).\n\n" +
      "━━━━━━━━━━━━━━\n" +
      "Forward a message from your Force-Sub Channel/Group — OR send its ID/@username directly (required for groups, since forwarding doesn't reliably identify the source group)."
  );
}

async function cmdMyForcesub(msg, tg, botData) {
  const list = await kv.listForcesubChannels(botData.bot_id);
  if (!list.length) return tg.send(msg.chat.id, "No Force-Sub channels/groups added yet.");
  return tg.send(msg.chat.id, ["📢 <b>Force-Sub List:</b>", ...list.map((c) => `• ${esc(c.title)} (${c.chat_type}) | ID: <code>${c.channel_id}</code>`)].join("\n"));
}

async function cmdRemoveForcesub(msg, tg, botData, args) {
  if (!args[0]) return tg.send(msg.chat.id, "Usage: /removeforcesub <channel_id>");
  await kv.removeForcesubChannel(botData.bot_id, args[0]);
  return tg.send(msg.chat.id, "✅ Removed.");
}

// ---------- Admin: link generation ----------

async function cmdGetlink(msg, tg, botData) {
  await kv.setState(botData.bot_id, msg.from.id, { flow: "getlink" });
  return tg.send(msg.chat.id, "Storage Channel se 1 file forward karein:\n\n━━━━━━━━━━━━━━\nForward 1 file from your Storage Channel:");
}

async function cmdBatch(msg, tg, botData) {
  await kv.setState(botData.bot_id, msg.from.id, { flow: "batch_first" });
  return tg.send(msg.chat.id, "FIRST file forward karein:\n\n━━━━━━━━━━━━━━\nForward the FIRST file:");
}

async function handleForward(msg, tg, botData) {
  const state = await kv.getState(botData.bot_id, msg.from.id);
  const fwd = getForwardInfo(msg);
  if (!fwd || !state) return;

  if (state.flow === "add_storage") {
    await kv.addStorageChannel(botData.bot_id, fwd.chatId, fwd.title);
    await kv.clearState(botData.bot_id, msg.from.id);
    return tg.send(msg.chat.id, `✅ Storage Added: ${esc(fwd.title)}`);
  }
  if (state.flow === "add_forcesub") {
    const chatType = fwd.type === "channel" ? "channel" : "group";
    await kv.addForcesubChannel(botData.bot_id, fwd.chatId, fwd.title, chatType);
    await kv.clearState(botData.bot_id, msg.from.id);
    return tg.send(msg.chat.id, `✅ Force-Sub Added: ${esc(fwd.title)} (${chatType})`);
  }
  if (state.flow === "getlink") {
    try {
      const payload = await packLink(botData.owner_id, fwd.chatId, fwd.messageId, 1);
      await kv.clearState(botData.bot_id, msg.from.id);
      return tg.send(msg.chat.id, `✅ Link Ready:\nhttps://t.me/${botData.bot_username}?start=${payload}`);
    } catch (e) {
      return tg.send(msg.chat.id, `❌ Link nahi ban paayi: ${esc(e.message)}\n\n━━━━━━━━━━━━━━\n❌ Could not create link: ${esc(e.message)}`);
    }
  }
  if (state.flow === "batch_first") {
    await kv.setState(botData.bot_id, msg.from.id, { flow: "batch_last", channelId: fwd.chatId, firstId: fwd.messageId });
    return tg.send(msg.chat.id, "✅ First saved! Ab LAST file forward karein:\n\n━━━━━━━━━━━━━━\n✅ First saved! Now forward the LAST file:");
  }
  if (state.flow === "batch_last") {
    if (fwd.chatId !== state.channelId) return tg.send(msg.chat.id, "❌ Same channel se forward karein!");
    const lo = Math.min(state.firstId, fwd.messageId);
    const hi = Math.max(state.firstId, fwd.messageId);
    const count = hi - lo + 1;
    try {
      const payload = await packLink(botData.owner_id, fwd.chatId, lo, count);
      await kv.clearState(botData.bot_id, msg.from.id);
      return tg.send(msg.chat.id, `✅ Batch Link Ready (${count} files):\nhttps://t.me/${botData.bot_username}?start=${payload}`);
    } catch (e) {
      return tg.send(msg.chat.id, `❌ Link nahi ban paayi: ${esc(e.message)}\n\n━━━━━━━━━━━━━━\n❌ Could not create link: ${esc(e.message)}`);
    }
  }
}

// ---------- Admin: settings ----------

async function cmdSetAutodelete(msg, tg) {
  const options = [5, 10, 15, 30, 60, 0];
  const buttons = [];
  for (let i = 0; i < options.length; i += 3) {
    buttons.push(options.slice(i, i + 3).map((x) => ({ text: x === 0 ? "Off" : `${x} Min`, callback_data: `ad_${x}` })));
  }
  return tg.send(msg.chat.id, "Auto-Delete Timer chunein:\n\n━━━━━━━━━━━━━━\nChoose Auto-Delete Timer:", { reply_markup: { inline_keyboard: buttons } });
}

async function cmdEnableShort(msg, tg, botData) {
  await kv.updateSetting(botData.bot_id, "shortener_enabled", 1);
  return tg.send(msg.chat.id, "✅ Shortener ENABLED.");
}

async function cmdDisableShort(msg, tg, botData) {
  await kv.updateSetting(botData.bot_id, "shortener_enabled", 0);
  return tg.send(msg.chat.id, "🚫 Shortener DISABLED.");
}

async function cmdAddShort(msg, tg, botData) {
  await kv.setState(botData.bot_id, msg.from.id, { flow: "ask_short_url" });
  return tg.send(msg.chat.id, "Step 1/2: Shortener Site URL bhejein (e.g. https://droplink.co):");
}

async function cmdDeleteAccount(msg, tg, botData) {
  const accs = await kv.listShorteners(botData.bot_id);
  if (!accs.length) return tg.send(msg.chat.id, "No shortener accounts found.");
  const buttons = accs.map((a) => [{ text: `❌ ${a.site_url.slice(0, 25)}`, callback_data: `delacc_${a.id}` }]);
  return tg.send(msg.chat.id, "Delete karne ke liye account chunein:", { reply_markup: { inline_keyboard: buttons } });
}

async function cmdShortTime(msg, tg) {
  const options = { "30m": 30, "1h": 60, "5h": 300, "9h": 540, "16h": 960 };
  const keys = Object.keys(options);
  const buttons = [];
  for (let i = 0; i < keys.length; i += 2) buttons.push(keys.slice(i, i + 2).map((k) => ({ text: k, callback_data: `stime_${options[k]}` })));
  return tg.send(msg.chat.id, "Shortener validity duration chunein:", { reply_markup: { inline_keyboard: buttons } });
}

async function cmdBroadcast(msg, tg, botData) {
  if (!msg.reply_to_message) return tg.send(msg.chat.id, "❌ Reply to a message with /broadcast.");
  const uids = await kv.listUsers(botData.bot_id);
  if (!uids.length) return tg.send(msg.chat.id, "No users recorded yet.");
  await kv.enqueueBroadcast(botData.bot_id, msg.chat.id, msg.reply_to_message.message_id, uids);
  return tg.send(msg.chat.id, `📢 Queued for ${uids.length} users.`);
}

async function cmdHelp(msg, tg) {
  return tg.send(
    msg.chat.id,
    `🛠 <b>Admin Commands:</b>\n\n` +
      `/addstorage /mystorage /removestorage &lt;id&gt;\n` +
      `/addforcesub /myforcesub /removeforcesub &lt;id&gt;\n` +
      `/getlink /batch\n` +
      `/setautodelete\n` +
      `/enableshort /disableshort /addshort /deleteaccount /shorttime\n` +
      `/broadcast (reply to a message)\n` +
      `/cancel`
  );
}

// ---------- Callback buttons ----------

async function handleCallback(cb, tg, botData) {
  if (cb.data.startsWith("ad_")) {
    const minutes = parseInt(cb.data.split("_")[1], 10);
    await kv.updateSetting(botData.bot_id, "autodelete_minutes", minutes);
    await tg.edit(cb.message.chat.id, cb.message.message_id, minutes === 0 ? "✅ Auto-Delete OFF." : `✅ Auto-Delete set to ${minutes} minutes.`);
    return tg.answerCb(cb.id, "Saved");
  }
  if (cb.data.startsWith("delacc_")) {
    await kv.removeShortener(botData.bot_id, cb.data.split("_")[1]);
    await tg.edit(cb.message.chat.id, cb.message.message_id, "✅ Deleted.");
    return tg.answerCb(cb.id, "Deleted");
  }
  if (cb.data.startsWith("stime_")) {
    const minutes = parseInt(cb.data.split("_")[1], 10);
    await kv.updateSetting(botData.bot_id, "shortener_time", minutes);
    await tg.edit(cb.message.chat.id, cb.message.message_id, `✅ Shortener validity set to ${minutes} minutes.`);
    return tg.answerCb(cb.id, "Saved");
  }
}

// ---------- FSM continuation for two-step text flows ----------

async function handleTextFsm(msg, tg, botData) {
  const state = await kv.getState(botData.bot_id, msg.from.id);
  if (!state) return false;

  if (state.flow === "add_forcesub" && msg.text && !msg.text.startsWith("/")) {
    await kv.clearState(botData.bot_id, msg.from.id);
    await resolveAndAddForcesub(msg, tg, botData, msg.text);
    return true;
  }

  if (state.flow === "ask_short_url" && msg.text) {
    await kv.setState(botData.bot_id, msg.from.id, { flow: "ask_short_api", siteUrl: msg.text.trim() });
    await tg.send(msg.chat.id, "Step 2/2: API Key bhejein:");
    return true;
  }
  if (state.flow === "ask_short_api" && msg.text) {
    await kv.addShortener(botData.bot_id, state.siteUrl, msg.text.trim());
    await kv.clearState(botData.bot_id, msg.from.id);
    await tg.send(msg.chat.id, `✅ Shortener Added!\nURL: <code>${esc(state.siteUrl)}</code>`);
    return true;
  }
  return false;
}

// ---------- Router ----------

export async function handleCloneBot(update, botId, origin) {
  const botData = await kv.getClone(botId);
  if (!botData || botData.status !== "approved") return;
  const tg = api(botData.bot_token);

  try {
    return await routeCloneUpdate(update, botData, tg, origin);
  } catch (e) {
    console.error("Clone bot error:", e);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      await tg.send(chatId, `⚠️ Kuch galat ho gaya: ${esc(e.message)}\n\n━━━━━━━━━━━━━━\n⚠️ Something went wrong: ${esc(e.message)}`).catch(() => {});
    }
  }
}

async function routeCloneUpdate(update, botData, tg, origin) {
  if (update.callback_query) return handleCallback(update.callback_query, tg, botData);

  const msg = update.message;
  if (!msg || !msg.from) return;

  if (msg.text && msg.text.startsWith("/")) {
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].split("@")[0].slice(1).toLowerCase();
    const args = parts.slice(1);

    if (cmd === "start") return cmdStart(msg, tg, botData, args[0] || null, origin);
    if (cmd === "cancel") {
      await kv.clearState(botData.bot_id, msg.from.id);
      return tg.send(msg.chat.id, "❌ Cancelled.");
    }
    if (!isOwnerOf(msg.from.id, botData)) return; // rest is admin-only

    if (cmd === "help") return cmdHelp(msg, tg);
    if (cmd === "addstorage") return cmdAddStorage(msg, tg, botData);
    if (cmd === "mystorage") return cmdMyStorage(msg, tg, botData);
    if (cmd === "removestorage") return cmdRemoveStorage(msg, tg, botData, args);
    if (cmd === "addforcesub") return cmdAddForcesub(msg, tg, botData, args);
    if (cmd === "myforcesub") return cmdMyForcesub(msg, tg, botData);
    if (cmd === "removeforcesub") return cmdRemoveForcesub(msg, tg, botData, args);
    if (cmd === "getlink") return cmdGetlink(msg, tg, botData);
    if (cmd === "batch") return cmdBatch(msg, tg, botData);
    if (cmd === "setautodelete") return cmdSetAutodelete(msg, tg);
    if (cmd === "enableshort") return cmdEnableShort(msg, tg, botData);
    if (cmd === "disableshort") return cmdDisableShort(msg, tg, botData);
    if (cmd === "addshort") return cmdAddShort(msg, tg, botData);
    if (cmd === "deleteaccount") return cmdDeleteAccount(msg, tg, botData);
    if (cmd === "shorttime") return cmdShortTime(msg, tg);
    if (cmd === "broadcast") return cmdBroadcast(msg, tg, botData);
    return;
  }

  if (getForwardInfo(msg) && isOwnerOf(msg.from.id, botData)) return handleForward(msg, tg, botData);
  if (isOwnerOf(msg.from.id, botData) && (await handleTextFsm(msg, tg, botData))) return;
}
