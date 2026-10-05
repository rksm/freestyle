import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capture,
  captureException,
  captureModelSelection,
  identifyCloudUser,
  invalidateTelemetrySetting,
  registerSuperProperties,
  resetCloudIdentity,
  setPersonProperties,
  shutdownSentry,
} from "../src/lib/sentry.js";

afterEach(() => vi.restoreAllMocks());

describe("telemetry is disabled", () => {
  it("sends nothing over the network from any telemetry function", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    capture("transcription completed", { duration_ms: 42 });
    captureException(new Error("boom"), { source: "test" });
    captureModelSelection({
      provider: "openai",
      modelId: "whisper-1",
      type: "voice",
      action: "selected",
    });
    identifyCloudUser({ id: "user-1" });
    setPersonProperties({ plan: "pro" });
    registerSuperProperties({ app_version: "1.2.3" });
    invalidateTelemetrySetting();
    resetCloudIdentity();
    await shutdownSentry();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("depends on no Sentry SDK", () => {
    for (const manifest of ["../package.json", "../../electron/package.json"]) {
      const { dependencies, devDependencies } = JSON.parse(
        readFileSync(new URL(manifest, import.meta.url), "utf8"),
      );
      const names = Object.keys({ ...dependencies, ...devDependencies });
      expect(names.filter((name) => name.startsWith("@sentry/"))).toEqual([]);
    }
  });
});
