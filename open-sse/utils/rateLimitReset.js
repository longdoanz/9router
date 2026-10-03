/**
 * Extract the moment a rate-limited account becomes usable again from the
 * upstream response headers of a 429.
 *
 * Covered (first match wins):
 *  - `retry-after` (seconds or HTTP date) — authoritative when present
 *  - Claude subscription: `anthropic-ratelimit-unified-reset` (epoch seconds)
 *  - Claude API: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`
 *    (RFC 3339) for every bucket whose `-remaining` is 0 → latest of them
 *  - Codex: `x-codex-{primary,secondary}-reset-after-seconds` for every window
 *    whose `-used-percent` is >= 100 → latest of them
 *
 * @param {Headers|{get:Function}|null} headers
 * @param {number} [now] - epoch ms (injectable for tests)
 * @returns {number|null} epoch ms in the future, or null when nothing usable
 */
export function parseResetFromHeaders(headers, now = Date.now()) {
  if (typeof headers?.get !== "function") return null;
  const get = (name) => {
    const v = headers.get(name);
    return v == null || v === "" ? null : String(v).trim();
  };
  const future = (ms) => (Number.isFinite(ms) && ms > now ? ms : null);

  const retryAfter = get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? now + secs * 1000 : Date.parse(retryAfter);
    const hit = future(ms);
    if (hit) return hit;
  }

  const unified = get("anthropic-ratelimit-unified-reset");
  if (unified) {
    const n = Number(unified);
    const hit = future(Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(unified));
    if (hit) return hit;
  }

  let latest = null;
  for (const bucket of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    const remaining = get(`anthropic-ratelimit-${bucket}-remaining`);
    const reset = get(`anthropic-ratelimit-${bucket}-reset`);
    if (remaining !== "0" || !reset) continue;
    const hit = future(Date.parse(reset));
    if (hit && (!latest || hit > latest)) latest = hit;
  }
  if (latest) return latest;

  for (const win of ["primary", "secondary"]) {
    const used = Number(get(`x-codex-${win}-used-percent`));
    const after = Number(get(`x-codex-${win}-reset-after-seconds`));
    if (!(used >= 100) || !(after > 0)) continue;
    const hit = future(now + after * 1000);
    if (hit && (!latest || hit > latest)) latest = hit;
  }
  return latest;
}
