import { describe, it, expect } from "vitest";
import {
  UPSTREAM_SOCKET_TIMEOUT_MS,
  STREAM_STALL_TIMEOUT_MS,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  FETCH_NONSTREAM_TIMEOUT_MS,
} from "../../open-sse/config/runtimeConfig.js";

// undici defaults headersTimeout/bodyTimeout to 300s. If the socket backstop ever
// drops below our own watchdogs, long non-stream completions and slow reasoning
// streams get cut by undici with an opaque UND_ERR_* instead of our error.
describe("UPSTREAM_SOCKET_TIMEOUT_MS", () => {
  it("outlasts every request watchdog", () => {
    expect(UPSTREAM_SOCKET_TIMEOUT_MS).toBeGreaterThan(STREAM_STALL_TIMEOUT_MS);
    expect(UPSTREAM_SOCKET_TIMEOUT_MS).toBeGreaterThan(STREAM_FIRST_CHUNK_TIMEOUT_MS);
    expect(UPSTREAM_SOCKET_TIMEOUT_MS).toBeGreaterThan(FETCH_NONSTREAM_TIMEOUT_MS);
  });

  it("is above undici's 300s default", () => {
    expect(UPSTREAM_SOCKET_TIMEOUT_MS).toBeGreaterThan(300_000);
  });
});

describe("proxyAwareFetch global dispatcher", () => {
  it("installs a global dispatcher carrying the backstop timeouts", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    // data: URLs never touch the network but still go through proxyAwareFetch.
    await proxyAwareFetch("data:text/plain,ok").catch(() => {});
    const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
    expect(dispatcher).toBeDefined();
    const optsKey = Object.getOwnPropertySymbols(dispatcher).find((k) => k.description === "options");
    expect(dispatcher[optsKey]).toMatchObject({
      headersTimeout: UPSTREAM_SOCKET_TIMEOUT_MS,
      bodyTimeout: UPSTREAM_SOCKET_TIMEOUT_MS,
    });
  });
});
