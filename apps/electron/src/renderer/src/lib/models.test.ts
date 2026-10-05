import { describe, expect, it } from "vitest";
import { type AvailableModel, buildVoiceItems } from "./models";

// Mirrors the AssemblyAI rows of the server's voice catalog
// (apps/server/src/routes/models.ts).
const ASSEMBLYAI_MODELS: AvailableModel[] = [
  ["universal-3-6-pro", "AssemblyAI Universal-3.6 Pro"],
  ["universal-streaming-english", "AssemblyAI Universal-Streaming English"],
  [
    "universal-streaming-multilingual",
    "AssemblyAI Universal-Streaming Multilingual",
  ],
].map(([id, name]) => ({
  provider_id: "assemblyai",
  provider_name: "AssemblyAI",
  model_id: `assemblyai/${id}`,
  model_name: name,
  family: "assemblyai",
  type: "voice",
  curated: true,
}));

describe("buildVoiceItems", () => {
  it("offers every AssemblyAI catalog model with its metadata and key state", () => {
    const items = buildVoiceItems(ASSEMBLYAI_MODELS, null, null, {
      selectedProvider: "assemblyai",
      selectedModelId: "assemblyai/universal-streaming-english",
      keyProviders: new Set(["assemblyai"]),
    });

    expect(
      items.map((item) => ({
        modelId: item.modelId,
        provider: item.provider,
        hasCost: item.cost !== undefined,
        hasKey: item.hasKey,
        selected: item.selected,
      })),
    ).toEqual([
      {
        modelId: "assemblyai/universal-3-6-pro",
        provider: "AssemblyAI",
        hasCost: true,
        hasKey: true,
        selected: false,
      },
      {
        modelId: "assemblyai/universal-streaming-english",
        provider: "AssemblyAI",
        hasCost: true,
        hasKey: true,
        selected: true,
      },
      {
        modelId: "assemblyai/universal-streaming-multilingual",
        provider: "AssemblyAI",
        hasCost: true,
        hasKey: true,
        selected: false,
      },
    ]);
  });
});
