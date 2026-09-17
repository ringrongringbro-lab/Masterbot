import { getEnv } from "./runtime.js";

// ---------- Hardcoded config ----------
// Add/remove owner Telegram User IDs here (comma separated numbers).
export const OWNERS = [5351848105, 5344078567];

// ---------- Environment variables / secrets ----------
// Set these with `wrangler secret put <NAME>` (or in the Cloudflare dashboard
// under Workers & Pages -> your worker -> Settings -> Variables).
export function env(key, def = "") {
  const e = getEnv();
  return (e && e[key]) || def;
}

// BOT_TOKEN       - your MAIN bot's token (the one users message to request a clone)
// WEBHOOK_SECRET  - any random string, must match what you pass to Telegram's setWebhook
// LINK_SECRET_KEY - a long random string used to sign get/batch links — KEEP PRIVATE.
//                   If this leaks, anyone could forge file links. Never use the
//                   placeholder default in production; always set your own.
export function getBotToken() {
  return env("BOT_TOKEN");
}
export function getWebhookSecret() {
  return env("WEBHOOK_SECRET", "change_me");
}
export function getLinkSecretKey() {
  return env("LINK_SECRET_KEY", "");
}

export const MAX_BATCH_PER_REQUEST = 25; // how many files /getlink+/batch delivers in one go
export const DEFAULT_AUTODELETE_MIN = 10;
export const DEFAULT_SHORTENER_MIN = 960; // 16h

// Max clones a NON-owner can create via the main bot (owners are unlimited)
export const MAX_CLONES_PER_USER = 3;

// Auto-installed on every clone via setMyCommands — user never needs BotFather for this
export const CLONE_COMMANDS = [
  { command: "start", description: "Bot shuru karein" },
  { command: "help", description: "Admin commands dekhein" },
  { command: "cancel", description: "Chal rahi action cancel karein" },
  { command: "addstorage", description: "Storage Channel add karein" },
  { command: "mystorage", description: "Storage Channels dekhein" },
  { command: "removestorage", description: "Storage Channel hatayein" },
  { command: "addforcesub", description: "Force-Sub Channel/Group add karein" },
  { command: "myforcesub", description: "Force-Sub list dekhein" },
  { command: "removeforcesub", description: "Force-Sub hatayein" },
  { command: "getlink", description: "Single file ka link banayein" },
  { command: "batch", description: "Multiple files ka link banayein" },
  { command: "setautodelete", description: "Auto-delete timer set karein" },
  { command: "enableshort", description: "Shortener chalu karein" },
  { command: "disableshort", description: "Shortener band karein" },
  { command: "addshort", description: "Shortener account add karein" },
  { command: "deleteaccount", description: "Shortener account hatayein" },
  { command: "shorttime", description: "Shortener validity time set karein" },
  { command: "broadcast", description: "Sabhi users ko message bhejein" },
];
