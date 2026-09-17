import { setEnv } from "./runtime.js";
import { getBotToken, getWebhookSecret } from "./config.js";
import { handleMainBot } from "./mainbot.js";
import { handleCloneBot } from "./storebot.js";
import { runCleanupJob } from "./cron.js";

const HOME_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>File Store Bot</title></head>
 <body style="background:#121212;color:#fff;text-align:center;padding:50px;font-family:sans-serif">
 <h1 style="color:#0088cc">🚀 File Store Bot — Cloudflare Workers</h1>
 <p>Bot is LIVE ✅</p></body></html>`;

export default {
  async fetch(request, env, ctx) {
    setEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(HOME_PAGE, { headers: { "Content-Type": "text/html" } });
    }

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!getBotToken()) return new Response("BOT_TOKEN not set", { status: 500 });

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== getWebhookSecret()) return new Response("Unauthorized", { status: 401 });

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const origin = url.origin;

    // Telegram expects a fast response to the webhook. We hand the actual
    // update handling to ctx.waitUntil() so the Worker keeps running it in
    // the background after the HTTP response below is already sent —
    // matters most for slower paths like /broadcast, which can involve a
    // lot of sequential KV writes.
    const work = (async () => {
      try {
        if (url.pathname === "/tg/main") {
          await handleMainBot(update, origin);
        } else if (url.pathname.startsWith("/tg/clone/")) {
          const botId = url.pathname.split("/").pop();
          if (botId) await handleCloneBot(update, botId, origin);
        }
      } catch (e) {
        console.error("Update handling error:", e);
      }
    })();
    ctx.waitUntil(work);

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  },

  // Registered via the `triggers.crons` entry in wrangler.jsonc — runs every
  // minute, same cadence as the original Deno.cron("cleanup", "* * * * *", ...).
  async scheduled(controller, env, ctx) {
    setEnv(env);
    ctx.waitUntil(runCleanupJob());
  },
};
