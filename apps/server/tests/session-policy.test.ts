import { describe, expect, it } from "vitest";
import { shouldKeepStreamingUpstreamAlive } from "../src/lib/streaming/session-policy.js";

describe("shouldKeepStreamingUpstreamAlive", () => {
  it("treats providers that close each request as ephemeral", () => {
    expect(shouldKeepStreamingUpstreamAlive("deepgram")).toBe(false);
    expect(shouldKeepStreamingUpstreamAlive("soniox")).toBe(false);
    expect(shouldKeepStreamingUpstreamAlive("freestyle-cloud")).toBe(false);
  });

  it("keeps other streaming providers warm by default", () => {
    expect(shouldKeepStreamingUpstreamAlive("openai")).toBe(true);
    expect(shouldKeepStreamingUpstreamAlive("elevenlabs")).toBe(true);
  });
});
