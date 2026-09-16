/**
 * End-to-end: CommandCode NDJSON that stops mid-turn (no `finish`) must not be
 * served to a non-streaming client as a completed answer.
 *
 * This drives the REAL pipeline — executor wrapper → forced-SSE→JSON handler —
 * because the wrapper appends `[DONE]` in its transform flush, which can mask a
 * truncation from any terminal-marker check downstream.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { inspectAndWrapCommandCodeResponse } = await import("../../open-sse/executors/commandcode.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const encoder = new TextEncoder();

function ndjsonResponse(lines) {
  const upstream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(JSON.stringify(l) + "\n"));
      controller.close();
    },
  });
  return new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function viaForcedJson(lines) {
  const wrapped = await inspectAndWrapCommandCodeResponse(ndjsonResponse(lines), "deepseek/deepseek-v4-flash");
  return handleForcedSSEToJson({
    providerResponse: wrapped,
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
  });
}

describe("CommandCode truncated NDJSON on the non-streaming path", () => {
  it("reports a truncated turn as a failure, not a completed answer", async () => {
    const result = await viaForcedJson([
      { type: "start" },
      { type: "text-delta", text: "I started answering" },
      // No finish-step / finish: the upstream died here.
    ]);

    if (result.success) {
      const body = await result.response.json();
      console.log("TRUNCATED-NDJSON → success with body:", JSON.stringify(body).slice(0, 220));
    } else {
      console.log("TRUNCATED-NDJSON → failure:", result.status, result.error);
    }
    expect(result.success).toBe(false);
  });

  it("still completes a normally-finished NDJSON turn", async () => {
    const result = await viaForcedJson([
      { type: "start" },
      { type: "text-delta", text: "All good" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish" },
    ]);

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(JSON.stringify(body)).toContain("All good");
  });
});
