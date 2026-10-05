import { describe, expect, it } from "vitest";
import { openaiCleanupProviderOptions } from "../src/lib/llm/registry.js";

describe("openaiCleanupProviderOptions", () => {
  it("disables reasoning for gpt-5 cleanup models", () => {
    expect(openaiCleanupProviderOptions("gpt-5.6-luna")).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(openaiCleanupProviderOptions("openai/gpt-5.4-mini")).toEqual({
      openai: { reasoningEffort: "none" },
    });
  });

  it("leaves non-reasoning OpenAI models alone", () => {
    expect(openaiCleanupProviderOptions("gpt-4.1-nano")).toBeUndefined();
    expect(openaiCleanupProviderOptions("gpt-4o-mini")).toBeUndefined();
  });
});
