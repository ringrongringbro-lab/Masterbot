# File Store Bot — Cloudflare Workers Setup

## Deno se Cloudflare Workers mein kya badla
Poora bot logic (commands, force-sub, shortener, batch links, multi-clone, broadcast, reply-bridge) **bilkul same hai** — sirf platform-specific wiring badli hai:

| Deno Deploy | Cloudflare Workers |
|---|---|
| `Deno.openKv()` | Workers KV namespace (binding `BOT_KV`) |
| `Deno.cron(...)` | Wrangler Cron Trigger (`wrangler.jsonc` → `triggers.crons`) |
| `Deno.serve(...)` | Worker ka `fetch` handler |
| `Deno.env.get()` (kahin se bhi call) | `env` sirf handler ke andar milta hai — isliye ek chhota `runtime.js` module hai jo request shuru hote hi env store kar leta hai taaki `config.js`/`kv.js` use kar sakein |

`kv.js` poora rewrite hua hai (Deno KV ke array-keys/atomic-batches ki jagah Cloudflare KV ke string-keys/get-per-key) lekin **exported function names bilkul same hain**, isliye `mainbot.js` aur `storebot.js` mein command logic wahi ka wahi hai.

## ⚠️ ZAROORI: Free tier limits jo is bot ko seedha affect karte hain
Cloudflare Workers KV ka FREE tier (**pure account ke liye, sab clones milakar**):
- Reads: 100,000/din (generous)
- **Writes: 1,000/din, Deletes: 1,000/din, List ops: 1,000/din (tight!)**

Isse yeh bot kis tarah touch hota hai:
- Auto-delete ON hone par (default 10 min) har delivered file = 1 write (schedule) + 1 delete (cron cleanup) = **2 KV ops per file**. Roughly ~500 files/din deliver hone par poora din ka write quota khatam ho sakta hai.
- `/broadcast` har target user ke liye 1 KV write karta hai — ek din mein 1,000 se zyada users ko broadcast nahi bhej paoge (quota khatam hote hi baaki writes fail ho jayenge).
- Worker Free plan har invocation mein sirf **50 "external" fetch calls** allow karta hai (Telegram API calls isi mein count hoti hain — KV calls nahi). Isliye `cron.js` mein batch sizes 50+20 se ghata kar 20+20 kar diye hain, taaki ek cron run mein 40 Telegram calls se zyada na ho.

**Agar traffic zyada hai to:**
- `/setautodelete` → **Off** kar do jab possible ho (per-file 1 write+delete bach jayega)
- Ya Cloudflare Workers **Paid plan** ($5/month) — KV allowance bahut zyada ho jaata hai
- Ya storage ko **D1** (Cloudflare ka SQL database, free tier 100K writes/din) par migrate karo — agar chahiye to bata dena, alag se bana dunga

Chhoti/personal-use bot ke liye (jaisa `config.js` mein sirf 2 OWNERS se lagta hai) yeh limits normally koi dikkat nahi denge.

## Files
```
src/
  runtime.js  - env/KV binding ko globally accessible banata hai (Workers-specific)
  config.js   - OWNERS (hardcoded), env vars/secrets, constants
  telegram.js - Telegram API wrapper (bina badlaav)
  linkutil.js - stateless signed get/batch links (bina badlaav, sirf secret-fetch function ban gaya)
  kv.js       - Cloudflare Workers KV storage (poora rewrite, same interface)
  mainbot.js  - Master bot: token receive, approve/reject, /broadcast, reply-bridge
  storebot.js - Har clone ka File Store logic (bina badlaav)
  cron.js     - auto-delete + broadcast queue draining (batch sizes adjusted)
  index.js    - entrypoint (fetch handler + scheduled/cron handler)
wrangler.jsonc - Worker config: KV binding + cron trigger
package.json    - sirf wrangler CLI ke liye
```

## Deploy Steps (Cloudflare Workers — free, no credit card)

1. **Node.js** installed hona chahiye (wrangler CLI ke liye). Phir project folder ke andar:
   ```
   npm install
   npx wrangler login
   ```
   Browser khulega — apne Cloudflare account se login/sign-up karo (free).

2. **KV namespace banao:**
   ```
   npx wrangler kv namespace create BOT_KV
   ```
   Output mein ek `id` milega. Use `wrangler.jsonc` ke andar `kv_namespaces[0].id` mein paste karo (abhi placeholder `PASTE_YOUR_KV_NAMESPACE_ID_HERE` likha hai).

3. **`OWNERS` set karo** — `src/config.js` file me apni Telegram User ID(s):
   ```js
   export const OWNERS = [5351848105, 5344078567];
   ```

4. **Deploy karo** (pehle deploy secrets ke bina bhi ho jayega, worker ban jayega):
   ```
   npx wrangler deploy
   ```
   Terminal mein ek URL milega jaisa: `https://file-store-bot.<your-subdomain>.workers.dev`

5. **Secrets set karo** (teeno zaroori hain):
   ```
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put LINK_SECRET_KEY
   ```
   Har command ke baad terminal value maangega — paste karke Enter dabao.
   - `BOT_TOKEN` — apne Master bot ka token (@BotFather se)
   - `WEBHOOK_SECRET` — koi random string
   - `LINK_SECRET_KEY` — **kam se kam 16+ character ki lambi random string** (jaise `openssl rand -hex 32` se generate karo) — kabhi kisi ko mat batana

6. **Webhook set karo** (Master bot ke liye) — is URL ko browser mein open karo:
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/tg/main&secret_token=<WEBHOOK_SECRET>
   ```

7. Telegram pe `/start` bhejke test karo.

## Naya clone banane ka tarika
Koi bhi user Master bot ko apna BotFather token bhejega:
- Tum ho (`OWNERS` me) → turant live
- Koi aur hai → tumhe notification (Approve/Reject) → Approve dabate hi clone turant live, webhook `/tg/clone/<bot_id>` pe khud set ho jayega

## Local testing (optional)
```
npx wrangler dev --remote
```
`--remote` zaroori hai kyunki bina iske KV local simulation use hoga (aapki asli data se disconnect).

## Zaroori: LINK_SECRET_KEY na bhoole
Agar ye set nahi ki, to `/getlink` aur `/batch` **error dega** (jaan-bujh kar aisa rakha hai — taaki koi default/guessable key se links forge na kar sake). Ek baar set karke kabhi mat badalna — badalte hi **saari purani links kaam karna band kar degi** (kyunki signature match nahi hoga).

## Cron Trigger note
Free plan mein account-wide max 5 Cron Triggers allowed hain — yeh bot sirf 1 use karta hai (`* * * * *`, har minute), so koi dikkat nahi.
