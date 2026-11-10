// proxyFetch.rawFetch calls undici's own fetch (undici 8 rejects dispatchers from another
// undici copy) and, on import, overwrites globalThis.fetch with patchedFetch. Both defeat
// tests that stub `globalThis.fetch`. Keep an installed stub alive across that overwrite and
// route undici's fetch to it; with no stub installed everything behaves as in production.
import { vi } from "vitest";

let current = globalThis.fetch;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  get: () => current,
  set: (value) => {
    if (current?._isMockFunction && value?.name === "patchedFetch") return;
    current = value;
  },
});

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetch: (...args) =>
      globalThis.fetch?._isMockFunction ? globalThis.fetch(...args) : actual.fetch(...args),
  };
});
