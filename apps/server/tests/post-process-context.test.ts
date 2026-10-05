import { PluginRegistry } from "freestyle-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeSetting } from "../src/lib/db.js";

// Recognition context reaches the local cleanup prompt as untrusted reference
// material, and local cleanup runs under a deadline so a stalled provider can
// never hold a dictation hostage.

const cleanupSpy = vi.fn().mockResolvedValue({
  model: "test-model",
  cleaned: "CLEANED",
  inputTokens: 1,
  outputTokens: 1,
});

vi.mock("../src/lib/providers.js", () => ({
  createChatModel: vi.fn().mockResolvedValue({}),
  createCleanupModel: vi.fn().mockResolvedValue({}),
  getDefaultModels: () => ({
    llm: { provider: "test-llm", model_id: "test-model" },
  }),
}));

vi.mock("@freestyle-voice/stt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@freestyle-voice/stt")>();
  return { ...actual, postProcess: cleanupSpy };
});

vi.mock("../src/routes/models.js", () => ({
  getModelCostCached: () => null,
  isCleanupModelSupported: async () => true,
}));

const registry = { current: new PluginRegistry() };
vi.mock("../src/lib/plugins/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/plugins/index.js")>();
  return { ...actual, plugins: () => registry.current };
});

const { postProcess } = await import("../src/lib/post-process.js");
const { createHookApi } = await import("../src/lib/plugins/pipeline.js");

describe("postProcess — recognition context", () => {
  beforeEach(() => {
    cleanupSpy.mockClear();
    writeSetting("llm_cleanup", "true");
  });

  it("threads recognition context into local cleanup with a timeout", async () => {
    const api = await createHookApi();

    await postProcess("say freestyle", null, {
      api,
      recognitionContext: {
        spellings: ["Freestyle"],
        excerpt: "const product = Freestyle;",
      },
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    const params = cleanupSpy.mock.calls[0]?.[0];
    expect(params.prompt).toContain(
      "Exact spellings that may occur in the dictation: Freestyle",
    );
    expect(params.prompt).toContain(
      "Excerpt from the destination:\nconst product = Freestyle;",
    );
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });
});
