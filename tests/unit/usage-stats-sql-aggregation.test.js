// getUsageStats("24h"/"today") aggregates in SQL rather than parsing every row's
// `tokens` blob in JS. These pin the semantics that rewrite has to preserve —
// they are the parts that a GROUP BY does not get for free.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

function insert(row) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.timestamp ?? new Date().toISOString(),
      row.provider ?? "openai",
      row.model ?? "gpt-5",
      row.connectionId ?? null,
      row.apiKey ?? null,
      row.endpoint ?? "/v1/chat/completions",
      row.promptTokensCol ?? 0,
      row.completionTokensCol ?? 0,
      row.cost ?? 0,
      "success",
      row.tokens === undefined ? "{}" : row.tokens,
      "{}",
    ]
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usagestats-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
  adapter.run(`DELETE FROM usageHistory`);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("getUsageStats 24h — SQL aggregation", () => {
  it("sums token counts out of the JSON blob and survives unparseable ones", async () => {
    adapter.run(`DELETE FROM usageHistory`);
    insert({ tokens: JSON.stringify({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 5 }) });
    insert({ tokens: JSON.stringify({ prompt_tokens: 200, completion_tokens: 20, cached_tokens: 7 }) });
    // A malformed blob must degrade to zeros, not abort the whole query:
    // json_extract raises on invalid JSON where JSON.parse merely fell back.
    insert({ tokens: "{ this is not json" });
    insert({ tokens: null });
    insert({ tokens: "null" });

    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(5);
    expect(stats.totalPromptTokens).toBe(300);
    expect(stats.totalCompletionTokens).toBe(30);
    expect(stats.totalCachedTokens).toBe(12);
  });

  it("falls back to cache_read_input_tokens when cached_tokens is zero, not just when absent", async () => {
    adapter.run(`DELETE FROM usageHistory`);
    insert({ tokens: JSON.stringify({ prompt_tokens: 1, cached_tokens: 0, cache_read_input_tokens: 77 }) });
    insert({ tokens: JSON.stringify({ prompt_tokens: 1, cache_read_input_tokens: 55 }) });
    insert({ tokens: JSON.stringify({ prompt_tokens: 1, cached_tokens: 3, cache_read_input_tokens: 999 }) });

    const stats = await db.getUsageStats("24h");
    expect(stats.totalCachedTokens).toBe(77 + 55 + 3);
  });

  it("ignores the promptTokens/completionTokens columns, exactly as the blob-reading loop did", async () => {
    adapter.run(`DELETE FROM usageHistory`);
    insert({ promptTokensCol: 9999, completionTokensCol: 8888, tokens: JSON.stringify({ prompt_tokens: 4, completion_tokens: 2 }) });
    // input_tokens/output_tokens are an Anthropic-shaped blob the 24h branch
    // deliberately does not read (the daily rollup does).
    insert({ tokens: JSON.stringify({ input_tokens: 500, output_tokens: 300 }) });

    const stats = await db.getUsageStats("24h");
    expect(stats.totalPromptTokens).toBe(4);
    expect(stats.totalCompletionTokens).toBe(2);
  });

  it("keeps every breakdown separate while collapsing rows into groups", async () => {
    adapter.run(`DELETE FROM usageHistory`);
    const tok = JSON.stringify({ prompt_tokens: 10, completion_tokens: 1 });
    for (let i = 0; i < 3; i++) insert({ provider: "openai", model: "gpt-5", connectionId: "c1", apiKey: "sk-aaaaaaaa11", endpoint: "/v1/chat/completions", tokens: tok, cost: 0.5 });
    for (let i = 0; i < 2; i++) insert({ provider: "anthropic", model: "claude-opus-5", connectionId: "c2", apiKey: null, endpoint: "/v1/messages", tokens: tok, cost: 0.25 });

    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(5);
    expect(stats.byProvider.openai.requests).toBe(3);
    expect(stats.byProvider.anthropic.requests).toBe(2);
    expect(stats.byModel["gpt-5 (openai)"].requests).toBe(3);
    expect(stats.byModel["gpt-5 (openai)"].promptTokens).toBe(30);
    expect(stats.byModel["claude-opus-5 (anthropic)"].requests).toBe(2);
    expect(Object.values(stats.byAccount).find((a) => a.connectionId === "c1").requests).toBe(3);
    expect(stats.byApiKey["local-no-key"].requests).toBe(2);
    expect(stats.byEndpoint["/v1/chat/completions|gpt-5|openai"].requests).toBe(3);
    expect(stats.totalCost).toBeCloseTo(3 * 0.5 + 2 * 0.25, 9);
  });

  it("reports the newest timestamp in a group as lastUsed", async () => {
    adapter.run(`DELETE FROM usageHistory`);
    const tok = JSON.stringify({ prompt_tokens: 1 });
    const oldest = new Date(Date.now() - 3600000).toISOString();
    const newest = new Date(Date.now() - 60000).toISOString();
    insert({ timestamp: newest, tokens: tok });
    insert({ timestamp: oldest, tokens: tok });

    const stats = await db.getUsageStats("24h");
    expect(stats.byModel["gpt-5 (openai)"].lastUsed).toBe(newest);
  });

  it("excludes rows outside the window", async () => {
    adapter.run(`DELETE FROM usageHistory`);
    const tok = JSON.stringify({ prompt_tokens: 10 });
    insert({ timestamp: new Date(Date.now() - 3600000).toISOString(), tokens: tok });
    insert({ timestamp: new Date(Date.now() - 86400000 * 2).toISOString(), tokens: tok });

    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(10);
  });
});
