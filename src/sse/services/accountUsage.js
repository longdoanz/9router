// Per-account usage snapshot (RAM only), fed from upstream rate-limit headers
// that Claude and Codex attach to EVERY response, not only to 429s.
//
// Used by affinity.js to (a) pin new conversations to the account with the most
// headroom and (b) decide when moving a pinned conversation is worth losing its
// prompt cache. Dependency-free so it can be unit-tested in isolation.
//
// Snapshot per account: { pct, resetAt, at } where pct is the usage of the most
// consumed window (0-100) and resetAt the epoch-ms reset of that window.

const store = new Map(); // connectionId -> { pct, resetAt, at }

export function clearAccountUsage() {
  store.clear();
}

const num = (headers, name) => {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Extract the most consumed window from response headers.
 * Claude: anthropic-ratelimit-unified-{5h,7d}-{utilization(0..1),reset(epoch s)},
 *         -unified-status "rejected" => 100%.
 * Codex:  x-codex-{primary,secondary}-{used-percent,reset-after-seconds}.
 * @returns {{pct:number, resetAt:number|null}|null}
 */
export function parseUsageFromHeaders(headers, now = Date.now()) {
  if (typeof headers?.get !== "function") return null;
  let best = null;
  const consider = (pct, resetAt) => {
    if (pct == null) return;
    if (!best || pct > best.pct) best = { pct: Math.min(Math.max(pct, 0), 100), resetAt };
  };

  for (const win of ["5h", "7d"]) {
    const util = num(headers, `anthropic-ratelimit-unified-${win}-utilization`);
    const reset = num(headers, `anthropic-ratelimit-unified-${win}-reset`);
    consider(util == null ? null : util * 100, reset ? reset * 1000 : null);
  }
  if (headers.get("anthropic-ratelimit-unified-status") === "rejected") {
    const reset = num(headers, "anthropic-ratelimit-unified-reset");
    consider(100, reset ? reset * 1000 : null);
  }

  for (const win of ["primary", "secondary"]) {
    const used = num(headers, `x-codex-${win}-used-percent`);
    const after = num(headers, `x-codex-${win}-reset-after-seconds`);
    consider(used, after > 0 ? now + after * 1000 : null);
  }
  return best;
}

/** Record a snapshot from response headers; no-op when none are present. */
export function recordUsageFromHeaders(connectionId, headers, now = Date.now()) {
  if (!connectionId || connectionId === "noauth") return;
  const snap = parseUsageFromHeaders(headers, now);
  if (snap) store.set(connectionId, { ...snap, at: now });
}

/**
 * Current usage % of an account, or null when unknown. A snapshot whose window
 * has already reset is stale (the account is fresh again) and reads as null.
 */
export function getUsagePct(connectionId, now = Date.now()) {
  const snap = store.get(connectionId);
  if (!snap) return null;
  if (snap.resetAt && snap.resetAt <= now) return null;
  return snap.pct;
}
