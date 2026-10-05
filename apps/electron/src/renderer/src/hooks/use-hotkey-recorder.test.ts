import { describe, expect, it } from "vitest";
import { modifiersFromEvent } from "./use-hotkey-recorder";

describe("modifiersFromEvent", () => {
  it("records Meta as Super on non-macOS platforms", () => {
    expect(
      modifiersFromEvent({
        altKey: true,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toEqual(["Alt", "Super"]);
  });

  it("keeps Control and Super distinct", () => {
    expect(
      modifiersFromEvent({
        altKey: false,
        ctrlKey: true,
        metaKey: true,
        shiftKey: false,
      }),
    ).toEqual(["Control", "Super"]);
  });
});
