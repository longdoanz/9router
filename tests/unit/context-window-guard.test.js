/**
 * Context-window overflow is a deterministic, request-scoped failure: the exact
 * same payload returns the exact same 400 from every account, so it must not
 * enter the account-fallback/lock loop (which locked a healthy account for 30s,
 * retried the identical body, and looped — one Telegram alert every 3 min).
 *
 * Two layers guard it:
 *   1. enforceContextWindow — clamp the completion ceiling so an over-window
 *      request still succeeds, or reject up front when the prompt alone
 *      overflows (nothing to salvage).
 *   2. ERROR_RULES "maximum context length" rule with noFallback — the safety net
 *      for whatever the estimator under-counts: no lock, no retry, error to client.
 */

import { describe, expect, it } from "vitest";

import { enforceContextWindow, estimateBodyTokens, isKnownContextWindow } from "../../open-sse/translator/concerns/contextWindow.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { DEFAULT_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

// Build a body whose serialized prompt is roughly `tokens * 4` chars.
function bodyWithPromptTokens(tokens, maxTokens) {
  const body = { messages: [{ role: "user", content: "x".repeat(tokens * 4) }] };
  if (maxTokens != null) body.max_tokens = maxTokens;
  return body;
}

describe("isKnownContextWindow", () => {
  it("accepts real per-model windows and rejects the generic DEFAULT floor", () => {
    expect(isKnownContextWindow(1000000)).toBe(true);
    expect(isKnownContextWindow(262144)).toBe(true);
    expect(isKnownContextWindow(DEFAULT_CAPABILITIES.contextWindow)).toBe(false);
    for (const w of [undefined, null, 0, -1, NaN]) {
      expect(isKnownContextWindow(w)).toBe(false);
    }
  });
});

describe("enforceContextWindow", () => {
  it("leaves a request that already fits untouched", () => {
    const body = bodyWithPromptTokens(10, 100);
    const res = enforceContextWindow(body, 100000);
    expect(res.action).toBe("ok");
    expect(body.max_tokens).toBe(100);
  });

  it("clamps the completion ceiling down when prompt + completion overflows", () => {
    const body = bodyWithPromptTokens(100, 5000); // prompt ~100, window 1000
    const res = enforceContextWindow(body, 1000);
    expect(res.action).toBe("clamped");
    expect(res.requestedOutput).toBe(5000);
    expect(body.max_tokens).toBe(res.clampedTo);
    // clamped completion + prompt must now fit the window
    expect(estimateBodyTokens({ messages: body.messages }) + body.max_tokens).toBeLessThanOrEqual(1000);
  });

  it("rejects when the prompt alone already exceeds the window", () => {
    const body = bodyWithPromptTokens(5000, 100); // prompt ~5000 > window 1000
    const res = enforceContextWindow(body, 1000);
    expect(res.action).toBe("reject");
    expect(res.message).toMatch(/context window/i);
    expect(body.max_tokens).toBe(100); // rejected, not mutated
  });

  it("reject message is classified noFallback (so it never locks/retries)", () => {
    const res = enforceContextWindow(bodyWithPromptTokens(5000, 100), 1000);
    // Coupling guard: the local reject text MUST match the ERROR_RULES
    // "maximum context length" rule. If it stops matching, the 400 is treated as
    // transient and the account gets locked for 30s on every overflow — the exact
    // loop this fix removes.
    expect(checkFallbackError(400, res.message).shouldFallback).toBe(false);
  });

  it("clamps max_completion_tokens and max_output_tokens too", () => {
    const a = { messages: [{ role: "user", content: "x".repeat(400) }], max_completion_tokens: 9000 };
    const b = { messages: [{ role: "user", content: "x".repeat(400) }], max_output_tokens: 9000 };
    expect(enforceContextWindow(a, 1000).action).toBe("clamped");
    expect(enforceContextWindow(b, 1000).action).toBe("clamped");
    expect(a.max_completion_tokens).toBeLessThan(9000);
    expect(b.max_output_tokens).toBeLessThan(9000);
  });

  it("is a no-op without a usable context window", () => {
    const body = bodyWithPromptTokens(100, 5000);
    for (const w of [undefined, null, 0, -1, NaN]) {
      expect(enforceContextWindow(body, w).action).toBe("ok");
    }
    expect(body.max_tokens).toBe(5000);
  });
});

describe("checkFallbackError — context overflow does not lock/retry", () => {
  const OVERFLOW =
    "This model's maximum context length is 1048576 tokens. However, you requested " +
    "1149012 tokens (1085012 in the messages, 64000 in the completion).";

  it("does not fall back (no cooldown, no lock) on a context-length overflow", () => {
    const res = checkFallbackError(400, OVERFLOW);
    expect(res.shouldFallback).toBe(false);
    expect(res.cooldownMs).toBe(0);
  });

  it("matches even when reworded, since matching is case-insensitive substring", () => {
    expect(checkFallbackError(400, "MAXIMUM CONTEXT LENGTH exceeded").shouldFallback).toBe(false);
  });

  it("does not fall back on an unrelated 400 either (request-scoped, not account-scoped)", () => {
    // Upstream v0.5.81 generalised this: any unmatched 4xx is caused by the
    // request itself, so cooling an account down only steals a healthy
    // connection. Account-scoped statuses keep their rules (401/402/403/404/429).
    const res = checkFallbackError(400, "some malformed field");
    expect(res.shouldFallback).toBe(false);
    expect(res.cooldownMs).toBe(0);
  });

  it("still falls back with a transient cooldown on unmatched server errors", () => {
    const res = checkFallbackError(503, "upstream exploded");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(30000);
  });
});
