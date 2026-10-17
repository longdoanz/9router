/**
 * Chat account loop: a connection whose refresh token turns out to be dead
 * (checkAndRefreshToken flags refreshUnrecoverable) is skipped before any
 * upstream call, and the next account serves the request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const refreshMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(async () => true),
}));
const coreMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => refreshMocks);
vi.mock("open-sse/handlers/chatCore.js", () => coreMocks);
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: vi.fn((k) => k) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getComboByName: vi.fn(async () => null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
}));

import { handleChat } from "@/sse/handlers/chat.js";

const makeRequest = () =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "cc/claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
  });

const account = (id) => ({ connectionId: id, connectionName: id, accessToken: `tok-${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  coreMocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok", { status: 200 }) });
});

describe("chat — expired connection fallback", () => {
  it("skips a connection whose refresh is unrecoverable and uses the next one", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account("dead"))
      .mockResolvedValueOnce(account("live"));
    refreshMocks.checkAndRefreshToken
      .mockResolvedValueOnce({ ...account("dead"), refreshUnrecoverable: true, testStatus: "expired" })
      .mockImplementationOnce(async (_p, c) => c);

    const res = await handleChat(makeRequest());

    expect(res.status).toBe(200);
    expect(coreMocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(coreMocks.handleChatCore.mock.calls[0][0].connectionId).toBe("live");
    expect([...authMocks.getProviderCredentials.mock.calls[1][1]]).toEqual(["dead"]);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("returns 503 (not 401) when the only account is expired", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account("dead"))
      .mockResolvedValueOnce(null);
    refreshMocks.checkAndRefreshToken
      .mockResolvedValueOnce({ ...account("dead"), refreshUnrecoverable: true, testStatus: "expired" });

    const res = await handleChat(makeRequest());

    expect(res.status).toBe(503);
    expect(coreMocks.handleChatCore).not.toHaveBeenCalled();
  });
});
