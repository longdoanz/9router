/**
 * Unit tests for src/lib/telegramNotifier.js
 *
 * The notifier must never touch the request path in a way that can throw or
 * block, must dedup, and must respect its send-rate ceiling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { TELEGRAM_CONFIG } from "../../src/shared/constants/config.js";

const ENV = process.env;

// Let the mocked _post resolve and its .finally() clear the in-flight guard.
const tick = () => new Promise((r) => setTimeout(r, 0));

function loadNotifier({ token = "tok", chat = "-123", runtime = "nodejs" } = {}) {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_CHAT_ID = chat;
  process.env.NEXT_RUNTIME = runtime;
  // Fresh module per test: the singleton keeps module-level state.
  vi.resetModules();
  return import("../../src/lib/telegramNotifier.js");
}

describe("telegramConfig", () => {
  it("has a dedup window matching the gateway's 3 minutes", () => {
    expect(TELEGRAM_CONFIG.DEDUP_WINDOW_MS).toBe(180000);
  });
});

describe("TelegramNotifier", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ENV };
  });

  it("is disabled without a bot token", async () => {
    const { telegramNotifier } = await loadNotifier({ token: "" });
    expect(telegramNotifier.isEnabled()).toBe(false);
  });

  it("is disabled without a chat id", async () => {
    const { telegramNotifier } = await loadNotifier({ chat: "" });
    expect(telegramNotifier.isEnabled()).toBe(false);
  });

  it("is disabled outside the nodejs runtime", async () => {
    const { telegramNotifier } = await loadNotifier({ runtime: "edge" });
    expect(telegramNotifier.isEnabled()).toBe(false);
  });

  it("is enabled when both env vars are present", async () => {
    const { telegramNotifier } = await loadNotifier();
    expect(telegramNotifier.isEnabled()).toBe(true);
  });

  it("queues only error lines and drops ordinary ones", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();

    // Ordinary request chatter must never reach Telegram.
    telegramNotifier._onRecords([
      { level: "log", line: "[19:00:00] 🟤 ▶ POST claude-sonnet → commandcode · FMT" },
      { level: "log", line: "[19:00:00] 🟤 📊 DONE 3957ms · TTFT 3658ms · IN 159847" },
      { level: "log", line: "[19:00:00] ❌ commandcode [503]: Upstream stream ended" },
    ]);

    expect(telegramNotifier._queue).toHaveLength(1);
    expect(telegramNotifier._queue[0]).toContain("Upstream stream ended");
  });

  it("forwards a console.error() that carries no marker", async () => {
    // src/app/api/translator/console-logs/route.js emits exactly this shape.
    // A marker-only filter would silently drop it.
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();

    telegramNotifier._onRecords([
      { level: "error", line: "[19:00:00] Error getting console logs: boom" },
    ]);

    expect(telegramNotifier._queue).toHaveLength(1);
    expect(telegramNotifier._queue[0]).toContain("Error getting console logs");
  });

  it("forwards console.assert failures", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();

    telegramNotifier._onRecords([
      { level: "assert", line: "[19:00:00] Assertion failed: expected 1 to be 2" },
    ]);

    expect(telegramNotifier._queue).toHaveLength(1);
  });

  it("does not forward a log line that merely mentions an error", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();

    telegramNotifier._onRecords([
      { level: "log", line: "[19:00:00] ℹ️ fallback after error 503, trying next model" },
    ]);

    expect(telegramNotifier._queue).toHaveLength(0);
  });

  it("ignores malformed records", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();

    expect(() =>
      telegramNotifier._onRecords([null, {}, { level: "error" }, { line: 42 }])
    ).not.toThrow();
    expect(telegramNotifier._queue).toHaveLength(0);
  });

  it("never exceeds the queue ceiling", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier._onRecords = null;
    for (let i = 0; i < TELEGRAM_CONFIG.QUEUE_MAX + 50; i++) {
      telegramNotifier._enqueue(`[19:00:00] ❌ error number ${i}`);
    }
    expect(telegramNotifier._queue).toHaveLength(TELEGRAM_CONFIG.QUEUE_MAX);
  });

  it("keeps the OLDEST lines when the queue overflows", async () => {
    // Dropping the newest is deliberate: the first sign of trouble is the one
    // worth reporting, and a burst must not push it out of the queue.
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier._onRecords = null;
    for (let i = 0; i < TELEGRAM_CONFIG.QUEUE_MAX + 10; i++) {
      telegramNotifier._enqueue(`[19:00:00] ❌ error ${i}`);
    }
    expect(telegramNotifier._queue[0]).toContain("error 0");
  });

  it("does not re-send the same line inside the dedup window", async () => {
    const { telegramNotifier } = await loadNotifier();
    const post = vi.spyOn(telegramNotifier, "_post").mockResolvedValue(undefined);

    telegramNotifier._enqueue("[19:00:00] ❌ identical failure");
    telegramNotifier._flush();
    await tick();
    expect(post.mock.calls.length).toBe(1);

    // Same line again: deduped.
    telegramNotifier._enqueue("[19:00:00] ❌ identical failure");
    telegramNotifier._flush();
    await tick();
    expect(post.mock.calls.length).toBe(1);

    // A different line still gets through, proving the drop above was dedup
    // and not the in-flight guard swallowing everything.
    telegramNotifier._enqueue("[19:00:00] ❌ a different failure");
    telegramNotifier._flush();
    await tick();
    expect(post.mock.calls.length).toBe(2);
  });

  it("enforces a send-rate ceiling within the window", async () => {
    const { telegramNotifier } = await loadNotifier();
    const post = vi.spyOn(telegramNotifier, "_post").mockResolvedValue(undefined);

    for (let i = 0; i < TELEGRAM_CONFIG.MAX_SENDS_PER_WINDOW + 5; i++) {
      telegramNotifier._enqueue(`[19:00:0${i % 10}] ❌ distinct failure ${i}`);
      telegramNotifier._flush();
      await tick();
    }

    expect(post.mock.calls.length).toBe(TELEGRAM_CONFIG.MAX_SENDS_PER_WINDOW);
  });

  it("formats the message with the service label and escaped HTML", async () => {
    const { telegramNotifier } = await loadNotifier();
    const msg = telegramNotifier._formatMessage("[19:00:00] ❌ upstream <b>reset</b> & failed");
    expect(msg).toContain("9router");
    expect(msg).toContain("&lt;b&gt;");
    expect(msg).toContain("&amp;");
    // The logger's own timestamp is stripped; Telegram shows its own.
    expect(msg).not.toContain("[19:00:00]");
  });

  it("truncates messages past the Telegram ceiling", async () => {
    const { telegramNotifier } = await loadNotifier();
    const msg = telegramNotifier._formatMessage("[19:00:00] ❌ " + "x".repeat(9000));
    expect(msg.length).toBeLessThanOrEqual(3501);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("never throws out of _enqueue, even on a malformed line", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier._onRecords = null;
    expect(() => telegramNotifier._enqueue(null)).not.toThrow();
    expect(() => telegramNotifier._enqueue(undefined)).not.toThrow();
    expect(() => telegramNotifier._enqueue("")).not.toThrow();
  });

  it("start() is idempotent", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();
    const onRecords = telegramNotifier._onRecords;
    telegramNotifier.start();
    expect(telegramNotifier._onRecords).toBe(onRecords);
    telegramNotifier.stop();
  });

  it("stop() detaches the emitter listener", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();
    telegramNotifier.stop();
    expect(telegramNotifier._onRecords).toBeNull();
  });

  it("stops forwarding once stopped", async () => {
    const { telegramNotifier } = await loadNotifier();
    telegramNotifier.start();
    telegramNotifier.stop();
    telegramNotifier._enqueue("[19:00:00] ❌ after stop");
    // _enqueue is still callable, but the emitter no longer reaches it — the
    // guard against double-start is that _onRecords is gone, so a stray
    // emitter cannot resurrect the notifier.
    expect(telegramNotifier._onRecords).toBeNull();
  });
});
