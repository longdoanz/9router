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

import { getUsagePct } from "./accountUsage.js";

const DEFAULT_AFFINITY_TTL_MINUTES = 30;

// Usage-aware placement/switching (see accountUsage.js).
// Switching a pinned conversation drops its upstream prompt cache, so it only
// happens when that cost is already ~zero or the alternative is a failed request.
const USAGE_EXCLUDE_PCT = 95;      // do not pin NEW conversations at/above this
const USAGE_HOT_PCT = 80;          // pinned account considered hot at/above this
const USAGE_CRITICAL_PCT = 97;     // about to 429: move even if cache is warm
const USAGE_SWITCH_MARGIN = 15;    // target must have this much more headroom (anti ping-pong)
const USAGE_BUCKET = 5;            // usages within a bucket are treated as equal → LRU decides
const CACHE_WARM_MS = 5 * 60 * 1000; // prompt cache TTL; idle longer => cache already gone
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
export function selectLeastRecentlyUsed(availableConnections, now = Date.now()) {
  if (!Array.isArray(availableConnections) || availableConnections.length === 0) return null;
  const sorted = [...availableConnections].sort((a, b) => {
    // Usage first (coarse buckets), then LRU. Unknown usage counts as 0.
    const ua = Math.floor((getUsagePct(a.id, now) ?? 0) / USAGE_BUCKET);
    const ub = Math.floor((getUsagePct(b.id, now) ?? 0) / USAGE_BUCKET);
    if (ua !== ub) return ua - ub;
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
    // Still valid and available → keep the same account (preserve cache),
    // unless a switch is cheap or unavoidable.
    pinnedId = maybeSwitch(existing, availableConnections, now) ?? existing.connectionId;
  } else {
    // New conversation, expired pin, or pinned account gone → pick by usage, then LRU.
    pinnedId = pickForNewPin(availableConnections, now)?.id ?? null;
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

/** Best account for a new pin: skip nearly-exhausted ones unless nothing else is left. */
function pickForNewPin(availableConnections, now) {
  const roomy = availableConnections.filter((c) => (getUsagePct(c.id, now) ?? 0) < USAGE_EXCLUDE_PCT);
  return selectLeastRecentlyUsed(roomy.length ? roomy : availableConnections, now);
}

/**
 * Decide whether to move an active conversation off its pinned account.
 * Moving loses the prompt cache, so only when:
 *  - the account is critical (a 429 is imminent) and another has room; or
 *  - the account is hot, the cache has already expired from idleness (free
 *    move), and another account has clearly more headroom (hysteresis).
 * @returns {string|null} new connection id, or null to stay
 */
function maybeSwitch(existing, availableConnections, now) {
  const pinnedPct = getUsagePct(existing.connectionId, now);
  if (pinnedPct == null || pinnedPct < USAGE_HOT_PCT) return null;
  const others = availableConnections.filter((c) => c.id !== existing.connectionId);
  const target = pickForNewPin(others, now);
  if (!target) return null;
  const targetPct = getUsagePct(target.id, now) ?? 0;

  if (pinnedPct >= USAGE_CRITICAL_PCT && targetPct < USAGE_EXCLUDE_PCT) return target.id;
  const cacheCold = now - existing.lastUsedAt >= CACHE_WARM_MS;
  if (cacheCold && targetPct <= pinnedPct - USAGE_SWITCH_MARGIN) return target.id;
  return null;
}
