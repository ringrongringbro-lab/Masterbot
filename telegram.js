export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function tgCall(token, method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

// Returns a small helper object bound to one bot token, so call-sites stay short.
export function api(token) {
  return {
    send: (chatId, text, extra = {}) => tgCall(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra }),
    edit: (chatId, messageId, text, extra = {}) => tgCall(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra }),
    answerCb: (id, text, alert = false) => tgCall(token, "answerCallbackQuery", { callback_query_id: id, text, show_alert: alert }),
    copyMessage: (chatId, fromChatId, messageId, extra = {}) => tgCall(token, "copyMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...extra }),
    forwardMessage: (chatId, fromChatId, messageId) => tgCall(token, "forwardMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }),
    getChatMember: (chatId, userId) => tgCall(token, "getChatMember", { chat_id: chatId, user_id: userId }),
    exportInviteLink: (chatId) => tgCall(token, "exportChatInviteLink", { chat_id: chatId }),
    deleteMessage: (chatId, messageId) => tgCall(token, "deleteMessage", { chat_id: chatId, message_id: messageId }),
    getMe: () => tgCall(token, "getMe", {}),
    setWebhook: (url, secret) => tgCall(token, "setWebhook", { url, secret_token: secret, drop_pending_updates: true }),
    deleteWebhook: () => tgCall(token, "deleteWebhook", { drop_pending_updates: true }),
    setMyCommands: (commands) => tgCall(token, "setMyCommands", { commands }),
  };
}

// Supports both the old (forward_from_chat) and new (forward_origin) Bot API shapes.
export function getForwardInfo(msg) {
  if (msg.forward_from_chat) {
    return {
      chatId: msg.forward_from_chat.id,
      messageId: msg.forward_from_message_id,
      title: msg.forward_from_chat.title || msg.forward_from_chat.username || "Unknown",
      type: msg.forward_from_chat.type,
    };
  }
  if (msg.forward_origin && msg.forward_origin.type === "channel") {
    return {
      chatId: msg.forward_origin.chat.id,
      messageId: msg.forward_origin.message_id,
      title: msg.forward_origin.chat.title || "Unknown",
      type: msg.forward_origin.chat.type,
    };
  }
  return null;
}

export function looksLikeBotToken(text) {
  return /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(text.trim());
}
