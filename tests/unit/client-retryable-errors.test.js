// Client-facing error contract for spec-following SDKs (OpenAI/Anthropic):
//  - a temporary failure on our side (quota, rejected upstream credential, 5xx,
//    empty generation) surfaces as 429/503 so the client retries, never as a 4xx
//    that reads as "your request is wrong";
//  - a client that omits `stream` on chat/completions or messages gets one JSON
//    body (both specs default stream to false), not SSE;
//  - a translated chat/completions stream ends with `data: [DONE]`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

import { clientStatusForUpstreamFailure } from "../../open-sse/utils/error.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("clientStatusForUpstreamFailure", () => {
  it("keeps a rate limit as 429", () => {
    expect(clientStatusForUpstreamFailure(429)).toBe(429);
  });

  it.each([400, 404, 413, 422])("passes request fault %i through", (status) => {
    expect(clientStatusForUpstreamFailure(status)).toBe(status);
  });

  it.each([401, 402, 403, 500, 502, 504, null, undefined])(
    "maps our-side failure %s to 503",
    (status) => {
      expect(clientStatusForUpstreamFailure(status)).toBe(503);
    },
  );
});

describe("checkFallbackError — temporary upstream conditions", () => {
  it("treats OpenCode's 400 'Model is unavailable' as temporary, not a request fault", () => {
    const r = checkFallbackError(400, "Upstream request failed: Model is unavailable.", 0, "opencode");
    expect(r.shouldFallback).toBe(true);
    expect(r.requestScoped).toBeUndefined();
    expect(clientStatusForUpstreamFailure(400)).toBe(400); // the reason the rule is needed
  });

  it("still treats a validation 400 as a request fault", () => {
    expect(checkFallbackError(400, "Request validation failed").requestScoped).toBe(true);
  });
});

describe("combo — status when every member failed", () => {
  const run = (responses) => handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: Object.keys(responses),
    handleSingleModel: vi.fn(async (_body, modelStr) => responses[modelStr]()),
    log: silentLog,
    comboStrategy: "fallback",
  });

  it("returns 429 when every member was rate-limited", async () => {
    const result = await run({
      "p-a/m-a": () => jsonResponse({ error: { message: "weekly usage limit" } }, 429),
      "p-b/m-b": () => jsonResponse({ error: { message: "rate limited" } }, 429),
    });
    expect(result.status).toBe(429);
    expect((await result.json()).error.message).toBeTruthy();
  });

  it("returns 503, not the first member's 401, for mixed transient failures", async () => {
    const result = await run({
      "p-a/m-a": () => jsonResponse({ error: { message: "invalid api key" } }, 401),
      "p-b/m-b": () => jsonResponse({ error: { message: "upstream exploded" } }, 500),
    });
    expect(result.status).toBe(503);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect((await result.json()).error.message).toBeTruthy();
  });

  it("returns 503 when a member throws", async () => {
    const result = await run({
      "p-a/m-a": () => { throw new Error("socket hang up"); },
      "p-b/m-b": () => jsonResponse({ error: { message: "rate limited" } }, 429),
    });
    expect(result.status).toBe(503);
  });
});

describe("translated chat/completions stream", () => {
  it("ends with a single data: [DONE]", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

    const stream = createSSEStream({
      targetFormat: FORMATS.CLAUDE,
      sourceFormat: FORMATS.OPENAI,
      provider: "claude",
      model: "claude-x",
    });
    const writer = stream.writable.getWriter();
    const readPromise = readAll(stream.readable);
    await writer.write(new TextEncoder().encode(sse));
    await writer.close();
    const out = await readPromise;

    expect(out).toContain("hello");
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
