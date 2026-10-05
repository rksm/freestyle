import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dictation prices its LLM call with `getModelCostCached`. It must never wait
// on the 4 MB models.dev download: it serves stale data past the TTL and
// refreshes in the background.

const registry = (inputPerMillion: number) => ({
  openai: {
    id: "openai",
    name: "OpenAI",
    models: { "gpt-x": { id: "gpt-x", cost: { input: inputPerMillion } } },
  },
});

const fetchSpy = vi.fn();
const TTL_MS = 6 * 60 * 60 * 1000;

/** Fresh module per test: the registry cache is module-level state. */
async function loadModels() {
  vi.resetModules();
  return import("../src/routes/models.js");
}

/** Let the in-flight fetch settle (fetch mock + res.json + finally). */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("models.dev registry cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => registry(2),
    }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns null before the first fetch and never awaits the network", async () => {
    const { getModelCostCached } = await loadModels();
    fetchSpy.mockReturnValue(new Promise(() => {})); // never resolves

    expect(getModelCostCached("openai", "gpt-x")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("serves the prefetched registry", async () => {
    const { prewarmModelCostRegistry, getModelCostCached } = await loadModels();
    prewarmModelCostRegistry();
    await settle();

    expect(getModelCostCached("openai", "gpt-x")).toEqual({
      input: 2 / 1_000_000,
      output: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    const { prewarmModelCostRegistry } = await loadModels();
    prewarmModelCostRegistry();
    prewarmModelCostRegistry();
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("serves stale data past the TTL and refreshes in the background", async () => {
    const { prewarmModelCostRegistry, getModelCostCached } = await loadModels();
    prewarmModelCostRegistry();
    await settle();

    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => registry(4),
    }));
    vi.advanceTimersByTime(TTL_MS + 1);

    expect(getModelCostCached("openai", "gpt-x")?.input).toBe(2 / 1_000_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await settle();
    expect(getModelCostCached("openai", "gpt-x")?.input).toBe(4 / 1_000_000);
  });

  it("keeps serving stale data when the refresh fails", async () => {
    const { prewarmModelCostRegistry, getModelCostCached } = await loadModels();
    prewarmModelCostRegistry();
    await settle();

    fetchSpy.mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(TTL_MS + 1);

    expect(getModelCostCached("openai", "gpt-x")?.input).toBe(2 / 1_000_000);
    await settle();
    expect(getModelCostCached("openai", "gpt-x")?.input).toBe(2 / 1_000_000);
  });
});
