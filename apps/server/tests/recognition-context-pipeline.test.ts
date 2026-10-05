import { PluginRegistry } from "freestyle-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSetting, writeSetting } from "../src/lib/db.js";

const registry = { current: new PluginRegistry() };

vi.mock("../src/lib/plugins/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/plugins/index.js")>();
  return { ...actual, plugins: () => registry.current };
});

const { resolveRecognitionContextSnapshot } = await import(
  "../src/lib/plugins/pipeline.js"
);

const input = {
  providerId: "deepgram",
  modelId: "nova-3",
  streaming: true,
};

describe("resolveRecognitionContextSnapshot", () => {
  beforeEach(() => {
    registry.current = new PluginRegistry();
    deleteSetting("context_enabled");
    vi.clearAllTimers();
  });

  it("returns immediately when no plugin implements the hook", async () => {
    const run = vi.spyOn(registry.current, "run");

    await expect(resolveRecognitionContextSnapshot(input)).resolves.toBe(
      undefined,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("does not dispatch when the master switch is disabled", async () => {
    registry.current = new PluginRegistry([
      {
        name: "collector",
        resolveRecognitionContext: (_input, output) => {
          output.snapshot = { capturedAt: 1 };
        },
      },
    ]);
    const run = vi.spyOn(registry.current, "run");
    writeSetting("context_enabled", "false");

    await expect(resolveRecognitionContextSnapshot(input)).resolves.toBe(
      undefined,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("abandons a hook that exceeds the hard deadline", async () => {
    registry.current = new PluginRegistry([
      {
        name: "blocked-collector",
        resolveRecognitionContext: async () => {
          await new Promise<void>(() => {});
        },
      },
    ]);

    const result = resolveRecognitionContextSnapshot(input);
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBeUndefined();
  });

  it("bounds the untrusted snapshot before returning it", async () => {
    registry.current = new PluginRegistry([
      {
        name: "oversized-collector",
        resolveRecognitionContext: (_input, output) => {
          output.snapshot = {
            capturedAt: 1,
            terminal: { paneText: "x".repeat(4_000) },
            editor: {
              symbols: Array.from(
                { length: 120 },
                (_, index) => `${index}-${"s".repeat(250)}`,
              ),
            },
          };
        },
      },
    ]);

    const snapshot = await resolveRecognitionContextSnapshot(input);

    expect(snapshot?.terminal?.paneText).toHaveLength(3_000);
    expect(snapshot?.editor?.symbols).toHaveLength(100);
    expect(snapshot?.editor?.symbols?.[0]).toHaveLength(200);
  });
});
