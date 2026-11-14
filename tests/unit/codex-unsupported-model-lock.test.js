import { describe, it, expect } from "vitest";
import { checkFallbackError } from "open-sse/services/accountFallback.js";
import { CODEX_UNSUPPORTED_MODEL_COOLDOWN_MS } from "open-sse/config/errorConfig.js";

const MSG = 'The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account.';

describe("codex unsupported-model 400", () => {
  it("locks model-scoped with the long cooldown (not the 30min rate-limit cap)", () => {
    const r = checkFallbackError(400, MSG, 0, "codex");
    expect(r.shouldFallback).toBe(true);
    expect(r.modelScoped).toBe(true);
    expect(r.cooldownMs).toBe(CODEX_UNSUPPORTED_MODEL_COOLDOWN_MS);
  });

  it("defaults to 12 hours", () => {
    expect(CODEX_UNSUPPORTED_MODEL_COOLDOWN_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("does not affect other providers' identical wording", () => {
    const r = checkFallbackError(400, MSG, 0, "openai");
    // Falls through to the generic 4xx request-scoped rule: no account lock.
    expect(r.shouldFallback).toBe(false);
    expect(r.requestScoped).toBe(true);
  });

  it("does not shadow earlier noFallback rules (context overflow first)", () => {
    const r = checkFallbackError(400, "maximum context length is 1 tokens", 0, "codex");
    expect(r.shouldFallback).toBe(false);
  });
});
