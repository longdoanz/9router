/**
 * Mid-stream CommandCode failures must reach a Claude client as an error, not
 * as assistant text.
 *
 * Regression guard: the translator used to append "[CommandCode error: …]" to
 * the answer and close with finish_reason=stop. Because that is a clean 200
 * stop carrying model content, Claude Code read it as the final answer and
 * ended the turn instead of retrying — the client could not tell a truncated
 * turn from a successful one.
 */

import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { inspectAndWrapCommandCodeResponse } from "../../open-sse/executors/commandcode.js";

const encoder = new TextEncoder();

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Drive the real commandcode → openai → claude pipeline: the executor's
// NDJSON wrapper produces OpenAI-shaped SSE, which stream.js then translates.
async function runPipeline(ndjsonLines, sourceFormat = FORMATS.CLAUDE) {
  const upstream = new ReadableStream({
    start(controller) {
      for (const line of ndjsonLines) {
        controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      }
      controller.close();
    },
  });

  const response = await inspectAndWrapCommandCodeResponse(
    new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    "poolside/laguna-s-2.1-free"
  );

  const sse = await drain(
    response.body.pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, sourceFormat, "commandcode", null, null, "poolside/laguna-s-2.1-free")
    )
  );

  return { status: response.status, sse, events: parseEvents(sse) };
}

function parseEvents(sse) {
  const out = [];
  for (const block of sse.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    const payload = dataLine.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch { /* ignore */ }
  }
  return out;
}

describe("CommandCode mid-stream error → Claude client", () => {
  it("surfaces the failure as an Anthropic error event, not assistant text", async () => {
    // The upstream emits a real content event first, so the executor's head
    // snapshot commits to streaming and cannot convert the response to a 4xx.
    const { events } = await runPipeline([
      { type: "start" },
      { type: "text-delta", text: "Working on it" },
      { type: "error", error: { type: "server_error", message: "Upstream stream ended before terminal chunk" } },
    ]);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toContain("Upstream stream ended before terminal chunk");
    // server_error is not Anthropic vocabulary; a transient upstream failure
    // maps to overloaded_error, which clients retry.
    expect(errorEvent.error.type).toBe("overloaded_error");
  });

  it("never writes the error into the assistant's content", async () => {
    const { events } = await runPipeline([
      { type: "text-delta", text: "Working on it" },
      { type: "error", error: { message: "Upstream stream ended before terminal chunk" } },
    ]);

    const text = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("Working on it");
    expect(text).not.toContain("CommandCode error");
  });

  it("does not close the truncated turn with a message_stop", async () => {
    // message_stop means "the model finished its turn". Emitting it after a
    // failure is what stopped Claude Code from retrying.
    const { events } = await runPipeline([
      { type: "text-delta", text: "partial" },
      { type: "error", error: { message: "boom" } },
    ]);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  it("still completes a healthy stream normally", async () => {
    const { status, events } = await runPipeline([
      { type: "start" },
      { type: "text-delta", text: "All good" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish" },
    ]);

    expect(status).toBe(200);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    const text = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("All good");
  });

  it("ignores a trailing finish event after the error", async () => {
    // A failure is terminal. If a late `finish` still produced a finish chunk,
    // the Claude translator would emit message_stop and the client would again
    // read the truncated turn as a successful answer.
    const { events } = await runPipeline([
      { type: "text-delta", text: "partial" },
      { type: "error", error: { message: "boom" } },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish" },
    ]);

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
    const text = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("partial");
  });

  it("surfaces the failure to an OpenAI-format client too", async () => {
    // hasValuableContent() runs on the translated output for every client
    // format; an error chunk has no `choices`, so it was filtered out for
    // OpenAI clients and the failure vanished without a trace.
    const { events } = await runPipeline([
      { type: "text-delta", text: "partial" },
      { type: "error", error: { message: "Upstream stream ended before terminal chunk" } },
    ], FORMATS.OPENAI);

    const errorChunk = events.find((e) => e.error);
    expect(errorChunk).toBeDefined();
    expect(errorChunk.error.message).toContain("Upstream stream ended before terminal chunk");
  });
});
