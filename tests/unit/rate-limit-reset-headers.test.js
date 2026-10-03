import { describe, expect, it } from "vitest";
import { parseResetFromHeaders } from "../../open-sse/utils/rateLimitReset.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const NOW = 1_800_000_000_000;
const h = (o) => new Headers(o);

describe("parseResetFromHeaders", () => {
  it("prefers retry-after seconds", () => {
    expect(parseResetFromHeaders(h({ "retry-after": "120" }), NOW)).toBe(NOW + 120_000);
  });
  it("reads Claude subscription unified reset (epoch seconds)", () => {
    const at = NOW / 1000 + 3600 * 5;
    expect(parseResetFromHeaders(h({ "anthropic-ratelimit-unified-reset": String(at) }), NOW)).toBe(at * 1000);
  });
  it("reads Claude API buckets only when remaining is 0", () => {
    const iso = new Date(NOW + 60_000).toISOString();
    const other = new Date(NOW + 999_000).toISOString();
    expect(parseResetFromHeaders(h({
      "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": iso,
      "anthropic-ratelimit-tokens-remaining": "10", "anthropic-ratelimit-tokens-reset": other,
    }), NOW)).toBe(Date.parse(iso));
  });
  it("reads Codex windows at 100%", () => {
    expect(parseResetFromHeaders(h({
      "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "18000",
      "x-codex-secondary-used-percent": "40", "x-codex-secondary-reset-after-seconds": "600000",
    }), NOW)).toBe(NOW + 18_000_000);
  });
  it("returns null with nothing usable", () => {
    expect(parseResetFromHeaders(h({}), NOW)).toBeNull();
    expect(parseResetFromHeaders(h({ "retry-after": "0" }), NOW)).toBeNull();
  });
});

describe("parseUpstreamError header fallback", () => {
  it("exposes resetsAtMs from headers on 429", async () => {
    const res = new Response("{}", { status: 429, headers: { "retry-after": "300" } });
    const out = await parseUpstreamError(res);
    expect(out.resetsAtMs).toBeGreaterThan(Date.now() + 290_000);
  });
});
