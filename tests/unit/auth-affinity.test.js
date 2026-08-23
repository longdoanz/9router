import { describe, it, expect, beforeEach } from "vitest";
import { selectLeastRecentlyUsed, affinityTtlMs, resolveAffinityPin, clearAffinityState } from "../../src/sse/services/affinity.js";

beforeEach(() => {
  clearAffinityState();
});

describe("selectLeastRecentlyUsed", () => {
  it("returns null for empty input", () => {
    expect(selectLeastRecentlyUsed([])).toBe(null);
    expect(selectLeastRecentlyUsed(null)).toBe(null);
  });

  it("prefers a never-used account over a recently-used one", () => {
    const conns = [
      { id: "a", lastUsedAt: "2026-08-23T10:00:00.000Z" },
      { id: "b" }, // never used
    ];
    expect(selectLeastRecentlyUsed(conns).id).toBe("b");
  });

  it("picks the account with the oldest lastUsedAt", () => {
    const conns = [
      { id: "new", lastUsedAt: "2026-08-23T12:00:00.000Z" },
      { id: "old", lastUsedAt: "2026-08-23T08:00:00.000Z" },
      { id: "mid", lastUsedAt: "2026-08-23T10:00:00.000Z" },
    ];
    expect(selectLeastRecentlyUsed(conns).id).toBe("old");
  });

  it("does not mutate the input array", () => {
    const conns = [
      { id: "new", lastUsedAt: "2026-08-23T12:00:00.000Z" },
      { id: "old", lastUsedAt: "2026-08-23T08:00:00.000Z" },
    ];
    const before = [...conns];
    selectLeastRecentlyUsed(conns);
    expect(conns).toEqual(before);
  });

  it("falls back to priority when all accounts have no lastUsedAt", () => {
    const conns = [{ id: "a", priority: 5 }, { id: "b", priority: 2 }];
    expect(selectLeastRecentlyUsed(conns).id).toBe("b");
  });
});

describe("affinityTtlMs", () => {
  it("defaults to 30 minutes when nothing is configured", () => {
    expect(affinityTtlMs({}, {})).toBe(30 * 60 * 1000);
  });

  it("uses the global setting", () => {
    expect(affinityTtlMs({}, { sessionAffinityTtlMinutes: 5 })).toBe(5 * 60 * 1000);
  });

  it("prefers the per-provider override over the global setting", () => {
    const override = { sessionAffinityTtlMinutes: 60 };
    const settings = { sessionAffinityTtlMinutes: 5 };
    expect(affinityTtlMs(override, settings)).toBe(60 * 60 * 1000);
  });

  it("rejects non-positive values by falling back to the default", () => {
    expect(affinityTtlMs({ sessionAffinityTtlMinutes: 0 }, {})).toBe(30 * 60 * 1000);
    expect(affinityTtlMs({ sessionAffinityTtlMinutes: -3 }, {})).toBe(30 * 60 * 1000);
    expect(affinityTtlMs({ sessionAffinityTtlMinutes: "abc" }, {})).toBe(30 * 60 * 1000);
  });
});

describe("resolveAffinityPin", () => {
  const conns = [
    { id: "a", lastUsedAt: "2026-08-23T12:00:00.000Z" },
    { id: "b", lastUsedAt: "2026-08-23T08:00:00.000Z" }, // least recently used
    { id: "c", lastUsedAt: "2026-08-23T10:00:00.000Z" },
  ];
  const ttl = 30 * 60 * 1000;
  const now = Date.parse("2026-08-23T12:05:00.000Z");

  it("pins a new conversation to the least-recently-used account", () => {
    expect(resolveAffinityPin("conv-1", conns, ttl, now)).toBe("b");
  });

  it("keeps the same account while the pin is fresh", () => {
    expect(resolveAffinityPin("conv-1", conns, ttl, now)).toBe("b");
    // 10 minutes later, still within TTL → same account
    expect(resolveAffinityPin("conv-1", conns, ttl, now + 10 * 60 * 1000)).toBe("b");
  });

  it("releases an expired pin and re-pins to the current LRU", () => {
    expect(resolveAffinityPin("conv-1", conns, ttl, now)).toBe("b");
    // Simulate account b being used elsewhere by advancing its lastUsedAt.
    const conns2 = [
      { id: "a", lastUsedAt: "2026-08-23T12:00:00.000Z" },
      { id: "b", lastUsedAt: "2026-08-23T13:00:00.000Z" }, // now the most recent
      { id: "c", lastUsedAt: "2026-08-23T10:00:00.000Z" },
    ];
    // Idle beyond TTL → re-pin to current LRU (c).
    expect(resolveAffinityPin("conv-1", conns2, ttl, now + 60 * 60 * 1000)).toBe("c");
  });

  it("re-pins when the pinned account is no longer available", () => {
    expect(resolveAffinityPin("conv-1", conns, ttl, now)).toBe("b");
    // Account b removed from available set (e.g. rate-limited/excluded).
    const withoutB = conns.filter((c) => c.id !== "b");
    const next = resolveAffinityPin("conv-1", withoutB, ttl, now + 1000);
    expect(next).not.toBe("b");
    expect(["a", "c"]).toContain(next);
  });

  it("returns null for an empty or id-less call", () => {
    expect(resolveAffinityPin("conv-1", [], ttl, now)).toBe(null);
    expect(resolveAffinityPin(null, conns, ttl, now)).toBe(null);
  });

  it("spreads distinct conversations across accounts via the affinity clock", () => {
    // Fresh connections with equal (no) lastUsedAt: priority order wins first,
    // then the affinity clock advances per selection so later conversations
    // land on the now-oldest account.
    const equalConns = [
      { id: "a", priority: 1 },
      { id: "b", priority: 2 },
      { id: "c", priority: 3 },
    ];
    const picks = [];
    for (let i = 0; i < 6; i++) {
      picks.push(resolveAffinityPin(`conv-${i}`, equalConns, ttl, now));
    }
    // Every account must have been used, and the distribution is roughly even
    // (2 each across 6 conversations).
    const counts = { a: 0, b: 0, c: 0 };
    picks.forEach((p) => counts[p]++);
    expect(counts.a).toBe(2);
    expect(counts.b).toBe(2);
    expect(counts.c).toBe(2);
  });

  it("keeps a fresh conversation pinned even as other conversations rotate", () => {
    const equalConns = [
      { id: "a", priority: 1 },
      { id: "b", priority: 2 },
      { id: "c", priority: 3 },
    ];
    // Pin conv-fixed to 'a' (first LRU).
    expect(resolveAffinityPin("conv-fixed", equalConns, ttl, now)).toBe("a");
    // Rotate other conversations.
    for (let i = 0; i < 10; i++) {
      resolveAffinityPin(`conv-other-${i}`, equalConns, ttl, now);
    }
    // conv-fixed is still within TTL → stays on 'a' regardless of rotation.
    expect(resolveAffinityPin("conv-fixed", equalConns, ttl, now + 1000)).toBe("a");
  });
});
