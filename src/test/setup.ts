import { afterEach, beforeEach, vi } from "vitest";

// No test reaches the network: any fetch a test didn't stub fails loudly.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(`Unexpected network call in a test: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
