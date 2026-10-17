/**
 * Unrecoverable OAuth refresh (expired/revoked refresh token).
 *
 * The generic refresh path must report `invalid_grant` as unrecoverable, the
 * connection is then marked `testStatus: "expired"` once, and both background
 * refresh and account selection skip it until the user re-authorizes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

function mockFetchOnce(body, { ok = true, status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
  });
  global.fetch = fn;
  return fn;
}

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("refreshAccessToken — unrecoverable classification", () => {
  beforeEach(() => { vi.resetModules(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("claude 400 invalid_grant → unrecoverable_refresh_error", async () => {
    mockFetchOnce(
      { error: "invalid_grant", error_description: "Refresh token expired" },
      { ok: false, status: 400 }
    );
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const { isUnrecoverableRefreshError } = await import("open-sse/services/tokenRefresh.js");

    const out = await refreshAccessToken("claude", "rt-dead-1", {}, silentLog);

    expect(out).toEqual({ error: "unrecoverable_refresh_error", code: "invalid_grant", status: 400 });
    expect(isUnrecoverableRefreshError(out)).toBe(true);
  });

  it("5xx stays retryable (null)", async () => {
    mockFetchOnce({ error: "server_error" }, { ok: false, status: 503 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    expect(await refreshAccessToken("claude", "rt-5xx", {}, silentLog)).toBeNull();
  });

  it("network error stays retryable (null)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    expect(await refreshAccessToken("claude", "rt-net", {}, silentLog)).toBeNull();
  });
});

const db = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(async () => true),
  getProviderConnections: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(async () => true),
}));
const credManager = vi.hoisted(() => ({
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(() => true),
}));

vi.mock("@/lib/localDb.js", () => db);
vi.mock("@/lib/localDb", () => db);
vi.mock("@/sse/utils/logger.js", () => silentLog);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock("open-sse/services/oauthCredentialManager.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshProviderCredentials: credManager.refreshProviderCredentials,
  shouldRefreshCredentials: credManager.shouldRefreshCredentials,
}));

const DEAD = { error: "unrecoverable_refresh_error", code: "invalid_grant", status: 400 };

function creds(overrides = {}) {
  return {
    connectionId: "conn-dead",
    connectionName: "dead@example.com",
    authType: "oauth",
    refreshToken: "rt-dead",
    accessToken: "at-old",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

describe("checkAndRefreshToken — marks connection expired", () => {
  let consoleError;
  beforeEach(() => {
    vi.clearAllMocks();
    credManager.refreshProviderCredentials.mockResolvedValue(DEAD);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("persists testStatus=expired, alerts once, flags the result", async () => {
    db.getProviderConnectionById.mockResolvedValue({ id: "conn-dead", refreshToken: "rt-dead", testStatus: "active" });
    const { checkAndRefreshToken } = await import("@/sse/services/tokenRefresh.js");

    const out = await checkAndRefreshToken("claude", creds());

    expect(out.refreshUnrecoverable).toBe(true);
    expect(out.testStatus).toBe("expired");
    expect(db.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, patch] = db.updateProviderConnection.mock.calls[0];
    expect(id).toBe("conn-dead");
    expect(patch).toMatchObject({ testStatus: "expired", errorCode: 400 });
    expect(patch.lastError).toMatch(/re-authorize/);
    expect(patch.lastErrorAt).toBeTruthy();
    const alerts = consoleError.mock.calls.filter(([msg]) => String(msg).includes("[expired]"));
    expect(alerts).toHaveLength(1);
  });

  it("does not mark expired when the refresh token was rotated concurrently", async () => {
    db.getProviderConnectionById.mockResolvedValue({ id: "conn-dead", refreshToken: "rt-rotated", testStatus: "active" });
    const { markConnectionExpired } = await import("@/sse/services/tokenRefresh.js");

    const marked = await markConnectionExpired("claude", creds(), DEAD);

    expect(marked).toBe(false);
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not re-write or re-alert an already-expired connection", async () => {
    db.getProviderConnectionById.mockResolvedValue({ id: "conn-dead", refreshToken: "rt-dead", testStatus: "expired" });
    const { checkAndRefreshToken } = await import("@/sse/services/tokenRefresh.js");

    const out = await checkAndRefreshToken("claude", creds());

    expect(out.refreshUnrecoverable).toBe(true);
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.filter(([m]) => String(m).includes("[expired]"))).toHaveLength(0);
  });

  it("transient failure (null) leaves the connection untouched", async () => {
    credManager.refreshProviderCredentials.mockResolvedValue(null);
    db.getProviderConnectionById.mockResolvedValue({ id: "conn-dead", refreshToken: "rt-dead" });
    const { checkAndRefreshToken } = await import("@/sse/services/tokenRefresh.js");

    const out = await checkAndRefreshToken("claude", creds());

    expect(out.refreshUnrecoverable).toBeUndefined();
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("account selection skips expired connections", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("getProviderCredentials never returns an expired connection", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "dead", provider: "claude", authType: "oauth", testStatus: "expired", priority: 1, isActive: true },
      { id: "live", provider: "claude", authType: "oauth", testStatus: "active", priority: 2, isActive: true },
    ]);
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const picked = await getProviderCredentials("claude", null, "claude-sonnet-4-5");

    expect(picked.connectionId).toBe("live");
  });

  it("returns null when every connection is expired", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "dead", provider: "claude", authType: "oauth", testStatus: "expired", priority: 1, isActive: true },
    ]);
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    expect(await getProviderCredentials("claude", null, "claude-sonnet-4-5")).toBeNull();
  });

  it("markAccountUnavailable keeps testStatus=expired", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "dead", provider: "claude", authType: "oauth", testStatus: "expired" },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    await markAccountUnavailable("dead", 401, "unauthorized", "claude", "claude-sonnet-4-5");

    errSpy.mockRestore();
    const patch = db.updateProviderConnection.mock.calls.at(-1)?.[1];
    expect(patch?.testStatus).toBe("expired");
  });
});
