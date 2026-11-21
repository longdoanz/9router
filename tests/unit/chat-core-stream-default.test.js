// OpenAI Chat Completions and Anthropic Messages both default `stream` to false.
// A client that omits it must get one JSON body; answering with SSE breaks every
// spec-following SDK (it parses the body as JSON and fails).
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function call(body, endpoint = "/v1/chat/completions") {
  return handleChatCore({
    body,
    modelInfo: { provider: "openrouter", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log,
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: { endpoint, body: {}, headers: { accept: "application/json" } },
  });
}

describe("handleChatCore stream default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async () => ({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
  });

  it("treats an omitted stream on chat/completions as non-streaming", async () => {
    await call({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] });
    expect(executeMock).toHaveBeenCalled();
    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });

  it("still streams when the client asks for it", async () => {
    await call({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hello" }] });
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
  });
});
