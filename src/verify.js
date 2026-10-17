import { getPassToken, savePassToken, getClone } from "./kv.js";
import { HOLD_SECONDS, PASS_TTL_MIN, getTurnstileSiteKey, getTurnstileSecret } from "./config.js";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

const TOKEN_RE = /^[A-Za-z0-9]{8,64}$/;
const turnstileOn = () => !!(getTurnstileSiteKey() && getTurnstileSecret());

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function usable(tok) {
  return !!(tok && tok.needs_hold && Date.now() - tok.created_at <= PASS_TTL_MIN * 60 * 1000);
}

function shell(body, extraHead = "") {
  return `<!DOCTYPE html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>Verify</title>${extraHead}
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#fff;font-family:system-ui,sans-serif;padding:24px;text-align:center}
.card{max-width:380px;width:100%;background:#181b22;border-radius:18px;padding:28px 22px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
h2{margin:0 0 8px;font-size:21px}p{margin:6px 0 18px;color:#aab;font-size:14px;line-height:1.5}
#hold{position:relative;overflow:hidden;width:100%;padding:18px;border:0;border-radius:14px;background:#2a2f3a;color:#fff;font-size:17px;font-weight:600;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none}
#hold:disabled{opacity:.5}
#bar{position:absolute;left:0;top:0;bottom:0;width:0;background:#1f8fff;opacity:.85}
#hold span{position:relative}
#msg{min-height:20px;margin-top:14px;font-size:13px;color:#ffb4b4}
a.btn{display:inline-block;margin-top:10px;padding:12px 20px;background:#1f8fff;color:#fff;border-radius:12px;text-decoration:none}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function messagePage(title, text) {
  return new Response(shell(`<h2>${title}</h2><p>${text}</p>`), { headers: HEADERS });
}

export async function handleVerifyPage(request) {
  const t = new URL(request.url).searchParams.get("t") || "";
  if (!TOKEN_RE.test(t)) return messagePage("❌ Invalid link", "Ye verification link galat hai. Bot me original link dobara kholein.");
  const tok = await getPassToken(t);
  if (!usable(tok)) return messagePage("⌛ Link expire ho gaya", "Bot me jaakar original link dobara kholein aur naya verify link lein.");

  const ts = turnstileOn();
  const head = ts ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : "";
  const widget = ts ? `<div class="cf-turnstile" data-sitekey="${getTurnstileSiteKey().replace(/[^A-Za-z0-9_-]/g, "")}" data-callback="onTs" data-theme="dark" style="margin-bottom:14px"></div>` : "";

  const body = `<h2>🔒 Verification</h2>
<p>Files unlock karne ke liye niche wale button ko <b>${HOLD_SECONDS} second</b> tak dabake rakhein.</p>
${widget}
<button id="hold" ${ts ? "disabled" : ""}><div id="bar"></div><span id="lbl">${ts ? "Wait..." : "Press &amp; Hold"}</span></button>
<div id="msg"></div>
<script>
(function(){
  var T=${JSON.stringify(t)},HOLD=${HOLD_SECONDS * 1000},USE_TS=${ts ? "true" : "false"};
  var btn=document.getElementById("hold"),bar=document.getElementById("bar"),lbl=document.getElementById("lbl"),msg=document.getElementById("msg");
  var start=0,raf=0,beginP=null,busy=false,tsTok="";
  window.onTs=function(tok){tsTok=tok;btn.disabled=false;lbl.textContent="Press & Hold";};
  function post(a,x){var b={a:a,t:T};for(var k in (x||{}))b[k]=x[k];
    return fetch("/verify/api",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json();});}
  function reset(){cancelAnimationFrame(raf);start=0;bar.style.width="0";if(!busy)lbl.textContent="Press & Hold";}
  function tick(){
    if(!start)return;
    var p=Math.min(1,(Date.now()-start)/HOLD);bar.style.width=(p*100)+"%";
    lbl.textContent=p<1?"Hold... "+Math.ceil((HOLD*(1-p))/1000)+"s":"Verifying...";
    if(p>=1){finish();return;}
    raf=requestAnimationFrame(tick);
  }
  function finish(){
    busy=true;btn.disabled=true;start=0;
    (beginP||Promise.resolve({ok:false})).then(function(b){
      if(!b||!b.ok)throw new Error("begin");
      return post("done",{ts:tsTok});
    }).then(function(d){
      if(d&&d.ok&&d.url){
        lbl.textContent="✅ Verified";
        msg.style.color="#9fe0a8";msg.textContent="Telegram khul raha hai...";
        window.location.href=d.url;
        setTimeout(function(){msg.innerHTML='<a class="btn" href="'+d.url+'">Open Telegram</a>';},2500);
      } else {
        var e=(d&&d.error)||"";
        msg.style.color="#ffb4b4";
        msg.textContent=e==="expired"?"Link expire ho gaya. Bot se naya link lein.":e==="captcha"?"Captcha fail hua, page reload karein.":"Verification fail hui. Dobara try karein.";
        busy=false;btn.disabled=false;reset();
        if(USE_TS&&window.turnstile){try{window.turnstile.reset();}catch(_){} btn.disabled=true;lbl.textContent="Wait...";}
      }
    }).catch(function(){
      msg.style.color="#ffb4b4";msg.textContent="Network error. Dobara try karein.";
      busy=false;btn.disabled=false;reset();
    });
  }
  function down(e){
    if(busy||btn.disabled)return;
    e.preventDefault();msg.textContent="";
    start=Date.now();beginP=post("begin").catch(function(){return {ok:false};});
    raf=requestAnimationFrame(tick);
  }
  function up(){if(busy)return;reset();}
  btn.addEventListener("pointerdown",down);
  btn.addEventListener("pointerup",up);btn.addEventListener("pointerleave",up);btn.addEventListener("pointercancel",up);
  btn.addEventListener("contextmenu",function(e){e.preventDefault();});
})();
</script>`;
  return new Response(shell(body, head), { headers: HEADERS });
}

async function checkTurnstile(token, ip) {
  if (!turnstileOn()) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", getTurnstileSecret());
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const d = await r.json();
    return !!d.success;
  } catch {
    return false;
  }
}

export async function handleVerifyApi(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const t = String(body.t || "");
  if (!TOKEN_RE.test(t)) return json({ ok: false, error: "bad_request" }, 400);

  const tok = await getPassToken(t);
  if (!usable(tok)) return json({ ok: false, error: "expired" });

  if (body.a === "begin") {
    tok.hold_start = Date.now();
    await savePassToken(t, tok, PASS_TTL_MIN);
    return json({ ok: true });
  }

  if (body.a === "done") {
    const now = Date.now();
    if (!tok.hold_start || now - tok.hold_start < HOLD_SECONDS * 1000 - 700) return json({ ok: false, error: "too_early" });
    const ok = await checkTurnstile(body.ts, request.headers.get("CF-Connecting-IP"));
    if (!ok) return json({ ok: false, error: "captcha" });

    const clone = await getClone(tok.bot_id);
    if (!clone) return json({ ok: false, error: "expired" });

    tok.held = true;
    tok.held_at = now;
    await savePassToken(t, tok, PASS_TTL_MIN);
    return json({ ok: true, url: `https://t.me/${clone.bot_username}?start=pass_${t}` });
  }

  return json({ ok: false, error: "bad_request" }, 400);
}
