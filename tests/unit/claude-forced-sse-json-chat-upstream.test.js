import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// A Claude-format client (Claude Code) routed to a chat-native upstream that is
// forced to stream. The provider emits OpenAI SSE; the client wants JSON back and
// speaks the Anthropic Messages API, so it must receive an Anthropic Message —
// not a chat.completion body, which it rejects as "empty or malformed response".
describe("forced-SSE JSON path for a Claude client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat, raw) => {
    const encoder = new TextEncoder();
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "commandcode",
      model: "deepseek/deepseek-v4-flash",
      body: { model: "deepseek/deepseek-v4-flash", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/messages" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  const textSse = [
    'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4-flash","choices":[{"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4-flash","choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4-flash","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
    "data: [DONE]",
    ""
  ].join("\n\n");

  const toolSse = [
    'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4-flash","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4-flash","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-v4-flash","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n");

  it("returns an Anthropic Message, not a chat.completion body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.CLAUDE, FORMATS.OPENAI, textSse));
    expect(result.success).toBe(true);

    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json).not.toHaveProperty("choices");
    expect(json).not.toHaveProperty("object");

    const text = (json.content || []).find((b) => b.type === "text");
    expect(text?.text).toBe("Hello world");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
  });

  it("maps tool_calls into Anthropic tool_use blocks", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.CLAUDE, FORMATS.OPENAI, toolSse));
    expect(result.success).toBe(true);

    const json = await result.response.json();
    expect(json.type).toBe("message");
    const tu = (json.content || []).find((b) => b.type === "tool_use");
    expect(tu).toBeTruthy();
    expect(tu.id).toBe("call_9");
    expect(tu.name).toBe("shell");
    expect(tu.input).toEqual({ cmd: "pwd" });
    expect(json.stop_reason).toBe("tool_use");
  });
});
