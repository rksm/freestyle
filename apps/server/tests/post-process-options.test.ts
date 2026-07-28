import { describe, expect, it } from "vitest";
import {
  groqCleanupProviderOptions,
  openaiCleanupProviderOptions,
} from "../src/lib/llm/registry.js";

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

describe("groqCleanupProviderOptions", () => {
  it("disables visible reasoning for qwen3 cleanup", () => {
    expect(groqCleanupProviderOptions("qwen/qwen3-32b")).toEqual({
      groq: {
        reasoningFormat: "hidden",
        reasoningEffort: "none",
      },
    });
  });

  it("keeps hidden low-effort reasoning for gpt-oss cleanup", () => {
    expect(groqCleanupProviderOptions("openai/gpt-oss-20b")).toEqual({
      groq: {
        reasoningFormat: "hidden",
        reasoningEffort: "low",
      },
    });
    expect(groqCleanupProviderOptions("groq/openai/gpt-oss-120b")).toEqual({
      groq: {
        reasoningFormat: "hidden",
        reasoningEffort: "low",
      },
    });
  });

  it("leaves non-reasoning groq models alone", () => {
    expect(groqCleanupProviderOptions("llama-3.1-8b-instant")).toBeUndefined();
  });
});
