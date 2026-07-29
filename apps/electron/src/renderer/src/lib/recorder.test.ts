import { afterEach, describe, expect, it, vi } from "vitest";
import { Recorder } from "./recorder";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Recorder", () => {
  it("does not request the microphone for an already-cancelled session", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const controller = new AbortController();
    controller.abort();

    await expect(
      new Recorder().acquireStream(undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("releases a microphone stream acquired after cancellation", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    const recorder = new Recorder();
    const controller = new AbortController();
    const acquisition = recorder.acquireStream(undefined, controller.signal);

    controller.abort();
    resolveStream?.(stream);

    await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalledOnce();
    expect(recorder.getStream()).toBeNull();
  });
});
