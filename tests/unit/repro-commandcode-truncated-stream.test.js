/**
 * Streaming path: CommandCode NDJSON that stops mid-turn must reach the client
 * as an error, NOT as a clean end of stream.
 *
 * Covers the executor's own SSE wrapper, which the forced-SSE→JSON path also
 * sits behind — a wrapper that always appended [DONE] would mask the
 * truncation from every downstream handler.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
const { inspectAndWrapCommandCodeResponse } = await import("../../open-sse/executors/commandcode.js");
const enc = new TextEncoder();
function ndjson(lines) {
  const up = new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + "\n")); c.close(); },
  });
  return new Response(up, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
async function collect(lines) {
  const r = await inspectAndWrapCommandCodeResponse(ndjson(lines), "deepseek/deepseek-v4-flash");
  return await r.text();
}
describe("streaming path truncation", () => {
  it("truncated NDJSON surfaces an error, not a clean finish", async () => {
    const out = await collect([
      { type: "start" },
      { type: "text-delta", text: "partial answer" },
    ]);
    console.log("TRUNCATED STREAM →", out.slice(0, 300));
    expect(out).toContain("error");
    expect(out).not.toContain("[DONE]");
  });
  it("finished NDJSON still closes with [DONE]", async () => {
    const out = await collect([
      { type: "start" },
      { type: "text-delta", text: "ok" },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish" },
    ]);
    expect(out).toContain("[DONE]");
    expect(out).not.toContain('"error"');
  });
});
