import { beforeEach, describe, expect, it } from "vitest";
import { clearAffinityState, resolveAffinityPin } from "../../src/sse/services/affinity.js";
import { clearAccountUsage, recordUsageFromHeaders } from "../../src/sse/services/accountUsage.js";

const NOW = 1_800_000_000_000;
const TTL = 30 * 60_000;
const accts = [{ id: "a" }, { id: "b" }];
const usage = (id, pct, now = NOW) =>
  recordUsageFromHeaders(id, new Headers({
    "x-codex-primary-used-percent": String(pct),
    "x-codex-primary-reset-after-seconds": "18000",
  }), now);

beforeEach(() => { clearAffinityState(); clearAccountUsage(); });

describe("usage-aware affinity", () => {
  it("pins a new conversation to the account with most headroom", () => {
    usage("a", 70); usage("b", 10);
    expect(resolveAffinityPin("c1", accts, TTL, NOW)).toBe("b");
  });

  it("skips accounts at/above 95% for new pins", () => {
    usage("a", 0); usage("b", 0);
    resolveAffinityPin("x", accts, TTL, NOW); // makes "a" most recent
    usage("b", 96);
    expect(resolveAffinityPin("c2", accts, TTL, NOW + 1)).toBe("a");
  });

  it("keeps a hot pin while the cache is warm", () => {
    usage("a", 0); usage("b", 50);
    expect(resolveAffinityPin("c", accts, TTL, NOW)).toBe("a");
    usage("a", 85); usage("b", 10);
    expect(resolveAffinityPin("c", accts, TTL, NOW + 60_000)).toBe("a");
  });

  it("moves a hot pin once the cache is cold and headroom is clearly larger", () => {
    usage("a", 0); usage("b", 50);
    resolveAffinityPin("c", accts, TTL, NOW);
    usage("a", 85, NOW + 400_000); usage("b", 10, NOW + 400_000);
    expect(resolveAffinityPin("c", accts, TTL, NOW + 400_000)).toBe("b");
  });

  it("does not ping-pong when the gap is under the margin", () => {
    usage("a", 0); usage("b", 50);
    resolveAffinityPin("c", accts, TTL, NOW);
    usage("a", 85, NOW + 400_000); usage("b", 75, NOW + 400_000);
    expect(resolveAffinityPin("c", accts, TTL, NOW + 400_000)).toBe("a");
  });

  it("moves immediately when the pinned account is critical", () => {
    usage("a", 0); usage("b", 50);
    resolveAffinityPin("c", accts, TTL, NOW);
    usage("a", 98); usage("b", 20);
    expect(resolveAffinityPin("c", accts, TTL, NOW + 1000)).toBe("b");
  });

  it("treats a window that already reset as unknown usage", () => {
    usage("a", 99);
    expect(resolveAffinityPin("c", accts, TTL, NOW + 18_001_000)).toBe("a");
  });
});
