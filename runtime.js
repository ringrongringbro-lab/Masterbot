// Deno gives you `Deno.env.get()` and `Deno.openKv()` as globals you can call
// from anywhere. Cloudflare Workers doesn't have globals like that — env vars
// and bindings (like the KV namespace) only exist inside the `env` argument
// that fetch(request, env, ctx) and scheduled(event, env, ctx) receive.
//
// Rather than rewriting every function in this project to thread an `env`
// parameter through, we stash it here once at the top of each request/cron
// invocation. This is safe because `env` never changes between requests for
// a given deployed Worker — it's fixed at deploy time (secrets, vars, KV
// bindings), not something that varies per-request. So even if the same
// Worker isolate handles several requests concurrently, they're all setting
// this to the same value.

let currentEnv = null;

export function setEnv(env) {
  currentEnv = env;
}

export function getEnv() {
  if (!currentEnv) {
    throw new Error("Runtime env not initialized — setEnv(env) must run first, at the top of fetch()/scheduled().");
  }
  return currentEnv;
}

export function getKvNamespace() {
  const env = getEnv();
  if (!env.BOT_KV) {
    throw new Error("BOT_KV namespace binding missing — check the kv_namespaces entry in wrangler.jsonc.");
  }
  return env.BOT_KV;
}
