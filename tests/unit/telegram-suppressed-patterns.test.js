import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// looksLikeError is not exported; asserting on the module text keeps this test
// robust against refactors that move the function while still catching a
// regression that drops the suppression list entirely.
const src = readFileSync(new URL("../../src/lib/telegramNotifier.js", import.meta.url), "utf8");

describe("telegram notifier suppression of deterministic codex model errors", () => {
  it("keeps the suppression pattern for the ChatGPT-account model rejection", () => {
    expect(src).toMatch(/model is not supported when using codex with a chatgpt account/i);
  });

  it("checks SUPPRESSED_PATTERNS before the ERROR level short-circuit", () => {
    const suppressedIdx = src.indexOf("SUPPRESSED_PATTERNS.some");
    const errorIdx = src.indexOf('if (level === "error") return true;');
    expect(suppressedIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeGreaterThan(suppressedIdx);
  });
});
