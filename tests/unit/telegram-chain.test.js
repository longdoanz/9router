/**
 * End-to-end chain test: real consoleLogBuffer -> real emitter -> real notifier.
 *
 * The unit test drives _onRecords directly; this one proves the level actually
 * survives the real capture path, which is where the marker-only filter was
 * silently dropping markerless console.error() calls.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const ENV = process.env;

async function setup() {
  process.env.TELEGRAM_BOT_TOKEN = "tok";
  process.env.TELEGRAM_CHAT_ID = "-123";
  process.env.NEXT_RUNTIME = "nodejs";

  vi.resetModules();
  const buf = await import("../../src/lib/consoleLogBuffer.js");
  const mod = await import("../../src/lib/telegramNotifier.js");
  buf.initConsoleLogCapture();
  mod.telegramNotifier.start();

  const sent = [];
  mod.telegramNotifier._post = async (text) => {
    sent.push(text);
    return 200;
  };
  return { buf, notifier: mod.telegramNotifier, sent };
}

afterEach(() => {
  process.env = { ...ENV };
});

describe("console -> emitter -> Telegram chain", () => {
  it("forwards markerless console.error but not log-level chatter", async () => {
    const { notifier, sent } = await setup();

    console.log("[19:00:00] 🟤 ▶ POST claude-sonnet → commandcode");
    console.log("[19:00:00] ❌ [AUTH] no credentials for provider");
    console.error("Error getting console logs: boom");
    console.log("[19:00:00] ℹ️ fallback after error 503, trying next");

    // Batching flushes on a 100ms timer. _flush() delivers one message per
    // call (the caller is a 1s interval), so drain the queue explicitly.
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 5; i++) {
      notifier._flush();
      await new Promise((r) => setTimeout(r, 20));
    }

    const joined = sent.join("\n");
    expect(joined).toContain("no credentials for provider");
    expect(joined).toContain("Error getting console logs");
    // Chatter must not leak through.
    expect(joined).not.toContain("POST claude-sonnet");
    expect(joined).not.toContain("fallback after error");

    notifier.stop();
  });
});
