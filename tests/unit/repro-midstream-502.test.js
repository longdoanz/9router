/**
 * REPRO (pre-fix characterisation): what does a Claude client get when the
 * upstream dies mid-stream on the non-streaming retry path?
 *
 * Claude Code's sequence observed in production:
 *   1. streaming request → upstream dies mid-stream
 *   2. client retries WITHOUT streaming
 *   3. the retry's upstream read also fails
 *   4. client receives 502 "Failed to convert streaming response to JSON"
 * and gives up, because that message names a *conversion* failure while the
 * real cause (a broken upstream read) is swallowed by the catch block.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const encoder = new TextEncoder();

// Emits one content frame, then ERRORS the stream — the shape of a killed
// upstream connection. `Response.text()` rejects on this.
function erroredAfterFirstFrame() {
  let sent = false;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
      ));
      sent = true;
    },
    pull(controller) {
      if (sent) controller.error(new Error("terminated"));
    },
  });
}

// Same, but the stream just ends without an error event and without [DONE] —
// a clean-looking truncation.
function truncatedWithoutTerminal() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
      ));
      controller.close();
    },
  });
}

function ctx(body) {
  return {
    providerResponse: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.OPENAI,
    provider: "commandcode",
    model: "deepseek/deepseek-v4-flash",
    body: { model: "deepseek/deepseek-v4-flash", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
  };
}

describe("REPRO: upstream read failure on the forced-SSE→JSON path", () => {
  it("shows what the client receives when the upstream stream ERRORS", async () => {
    const result = await handleForcedSSEToJson(ctx(erroredAfterFirstFrame()));
    console.log("ERRORED  →", JSON.stringify({ success: result.success, status: result.status, error: result.error }));
    expect(result.success).toBe(false);
  });

  it("shows what the client receives when the stream is silently truncated", async () => {
    const result = await handleForcedSSEToJson(ctx(truncatedWithoutTerminal()));
    console.log("TRUNCATED →", JSON.stringify({ success: result.success, status: result.status, error: result.error }));
    if (result.success) {
      const j = await result.response.json();
      console.log("TRUNCATED body →", JSON.stringify(j).slice(0, 200));
    }
  });
});
