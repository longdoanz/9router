// Conversation → account affinity helpers for session pinning.
//
// Kept dependency-free so they can be unit-tested in isolation (auth.js pulls
// in the DB + network layer). The pin semantics:
//   - A conversation stays on its pinned account while active (preserves
//     upstream prompt cache).
//   - After an idle timeout, the pin is released and re-pinned to the
//     least-recently-used account, so idle accounts get used before busy ones.
//   - When the pinned account fails/rate-limits, the caller excludes it and
//     re-pins to another account.

const DEFAULT_AFFINITY_TTL_MINUTES = 30;
const AFFINITY_MAX_ENTRIES = 5000;

// In-memory conversation → account pin map. In-memory is fine: a process
// restart just re-pins conversations on their next request.
export const affinityStore = new Map(); // conversationId -> { connectionId, lastUsedAt }

// In-memory "last used" record per account, maintained by affinity pinning.
// We track this separately from the connection's DB `lastUsedAt` because the
// affinity path does not write to the DB (only sticky round-robin does); the
// DB field therefore never advances while affinity is on, which would make a
// least-recently-used pick collapse to a single account.
// Each record is { time, seq } where `seq` is a monotonic counter that breaks
// ties when several requests land in the same millisecond.
const affinityLastUsed = new Map(); // connectionId -> { time, seq }
let affinitySeq = 0;

/** Clear all affinity state (pins + per-account clock). Test helper. */
export function clearAffinityState() {
  affinityStore.clear();
  affinityLastUsed.clear();
  affinitySeq = 0;
}

/**
 * Resolve the idle TTL (ms) after which a pinned conversation is released and
 * re-pinned to a different account. Per-provider override wins, then global.
 *
 * @param {object} [providerOverride] - providerStrategies[providerId] settings
 * @param {object} [settings] - Global settings
 * @returns {number} TTL in milliseconds
 */
export function affinityTtlMs(providerOverride, settings) {
  const raw = providerOverride?.sessionAffinityTtlMinutes != null
    ? providerOverride.sessionAffinityTtlMinutes
    : (settings?.sessionAffinityTtlMinutes ?? DEFAULT_AFFINITY_TTL_MINUTES);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AFFINITY_TTL_MINUTES * 60 * 1000;
  return n * 60 * 1000;
}

/**
 * Effective "last used" record for an account: the affinity clock when known,
 * else the connection's DB lastUsedAt. A never-used account returns { time: 0 }.
 */
function lastUsedOf(conn) {
  const rec = affinityLastUsed.get(conn.id);
  if (rec) return rec;
  return { time: conn.lastUsedAt ? new Date(conn.lastUsedAt).getTime() : 0, seq: 0 };
}

/**
 * Pick the least-recently-used connection — the account unused the longest.
 * Prefers the in-memory affinity clock, falling back to the DB lastUsedAt.
 * Accounts never used are preferred first. A monotonic sequence breaks ties
 * when several requests land in the same millisecond, keeping the pick spread
 * across accounts even under a burst.
 *
 * @param {Array} availableConnections - Account list already filtered for availability
 * @returns {object|null} The LRU connection, or null when the list is empty
 */
export function selectLeastRecentlyUsed(availableConnections) {
  if (!Array.isArray(availableConnections) || availableConnections.length === 0) return null;
  const sorted = [...availableConnections].sort((a, b) => {
    const ra = lastUsedOf(a);
    const rb = lastUsedOf(b);
    if (ra.time !== rb.time) return ra.time - rb.time;
    if (ra.seq !== rb.seq) return ra.seq - rb.seq; // older pick first
    return (a.priority || 999) - (b.priority || 999);
  });
  return sorted[0];
}

/**
 * Record/refresh a conversation's pin, returning its pinned connection id.
 * Releases an expired pin (idle beyond the TTL) or a pin whose account is no
 * longer available, re-pinning to the least-recently-used account instead.
 * Every call advances the account's affinity clock, so distinct conversations
 * spread across accounts rather than all collapsing onto one.
 *
 * @param {string} conversationId - Stable conversation/session id
 * @param {Array} availableConnections - Account list already filtered for availability
 * @param {number} ttlMs - Idle timeout for a pin
 * @param {number} now - Current time in ms (injected for testability)
 * @returns {string|null} Pinned connection id, or null when none can be chosen
 */
export function resolveAffinityPin(conversationId, availableConnections, ttlMs, now = Date.now()) {
  if (!conversationId || !Array.isArray(availableConnections) || availableConnections.length === 0) return null;

  const existing = affinityStore.get(conversationId);
  let pinnedId = null;

  if (
    existing &&
    now - existing.lastUsedAt < ttlMs &&
    availableConnections.some((c) => c.id === existing.connectionId)
  ) {
    // Still valid and available → keep the same account (preserve cache).
    pinnedId = existing.connectionId;
  } else {
    // New conversation, expired pin, or pinned account gone → re-pin to LRU.
    pinnedId = selectLeastRecentlyUsed(availableConnections)?.id ?? null;
  }

  if (pinnedId) {
    affinityStore.set(conversationId, { connectionId: pinnedId, lastUsedAt: now });
    affinityLastUsed.set(pinnedId, { time: now, seq: ++affinitySeq });
    if (affinityStore.size > AFFINITY_MAX_ENTRIES) {
      affinityStore.delete(affinityStore.keys().next().value);
    }
  }
  return pinnedId;
}
