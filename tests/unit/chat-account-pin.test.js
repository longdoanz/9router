/**
 * Integration tests for per-combo account pinning through the chat handler.
 *
 * A combo entry may carry an account pin as a `@uuid` suffix
 * (`cc/claude-opus-4-5@3f2a9c1e-...`). `getModelInfo` splits it off and surfaces
 * it as `connectionId`, and `handleSingleModelChat` forwards it to
 * `getProviderCredentials` as `preferredConnectionId`. These tests assert that
 * wiring for both a pinned combo entry and a plain single-model request, and
 * that the pin never leaks into the upstream model string.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PIN = "3f2a9c1e-4b7d-4e02-9a11-8b7d6c5e4f3a";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));

const coreMocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));

const combos = vi.hoisted(() => ({ models: null }));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("open-sse/handlers/chatCore.js", () => coreMocks);
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: vi.fn((k) => k) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getComboByName: vi.fn(async (name) => (combos.models ? { name, models: combos.models } : null)),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));

import { handleChat } from "@/sse/handlers/chat.js";

const makeRequest = (body) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const account = (overrides = {}) => ({
  connectionId: "conn-1",
  connectionName: "acc-1",
  accessToken: "tok-1",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  combos.models = null;
  authMocks.getProviderCredentials.mockResolvedValue(account());
  coreMocks.handleChatCore.mockResolvedValue({
    success: true,
    response: new Response("ok", { status: 200 }),
  });
});

describe("chat account pinning", () => {
  it("forwards a combo entry's pinned account as preferredConnectionId", async () => {
    combos.models = ["cc/claude-opus-4-5@" + PIN];
    coreMocks.handleChatCore.mockResolvedValueOnce({
      success: false, status: 400, error: "nope", response: new Response("nope", { status: 400 }),
    });

    await handleChat(makeRequest({ model: "my-combo", messages: [{ role: "user", content: "hi" }] }));

    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "claude", expect.anything(), "claude-opus-4-5",
      expect.objectContaining({ preferredConnectionId: PIN })
    );
  });

  it("passes no preferredConnectionId for an unpinned entry", async () => {
    combos.models = ["cc/claude-opus-4-5"];
    coreMocks.handleChatCore.mockResolvedValueOnce({
      success: false, status: 400, error: "nope", response: new Response("nope", { status: 400 }),
    });

    await handleChat(makeRequest({ model: "my-combo", messages: [{ role: "user", content: "hi" }] }));

    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "claude", expect.anything(), "claude-opus-4-5",
      expect.objectContaining({ preferredConnectionId: null })
    );
  });

  it("honors a pin on a plain provider/model request", async () => {
    await handleChat(makeRequest({
      model: `cc/claude-opus-4-5@${PIN}`,
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "claude", expect.anything(), "claude-opus-4-5",
      expect.objectContaining({ preferredConnectionId: PIN })
    );
  });

  it("never leaks the pin suffix into the upstream model string", async () => {
    await handleChat(makeRequest({
      model: `cc/claude-opus-4-5@${PIN}`,
      messages: [{ role: "user", content: "hi" }],
    }));

    const call = coreMocks.handleChatCore.mock.calls[0][0];
    expect(call.modelInfo).toEqual({ provider: "claude", model: "claude-opus-4-5" });
    expect(call.body.model).toBe("claude/claude-opus-4-5");
    expect(JSON.stringify(call.body)).not.toContain(PIN);
  });

  it("falls back to the next account when the pinned one has failed", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account({ connectionId: PIN }))
      .mockResolvedValueOnce(account({ connectionId: "conn-2" }));
    coreMocks.handleChatCore
      .mockResolvedValueOnce({
        success: false, status: 500, error: "boom", response: new Response("boom", { status: 500 }),
      })
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200 }) });

    const res = await handleChat(makeRequest({
      model: `cc/claude-opus-4-5@${PIN}`,
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(res.status).toBe(200);
    // Second selection excludes the failed pin, so the strategy picks another account.
    const secondExclude = authMocks.getProviderCredentials.mock.calls[1][1];
    expect([...secondExclude]).toEqual([PIN]);
  });
});
