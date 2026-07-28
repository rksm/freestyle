import { describe, expect, it } from "vitest";
import { parseContextSnapshot } from "../../validations/src/context-snapshot.js";

describe("parseContextSnapshot", () => {
  it("bounds capped strings and arrays", () => {
    const result = parseContextSnapshot({
      capturedAt: 1,
      terminal: { paneText: "t".repeat(3_001) },
      editor: {
        visibleText: "v".repeat(2_001),
        symbols: Array.from({ length: 101 }, () => "s".repeat(201)),
        openBuffers: Array.from({ length: 101 }, () => "b".repeat(201)),
      },
      focusText: {
        before: "p".repeat(2_001),
        selected: "s".repeat(501),
        after: "a".repeat(501),
      },
    });

    expect(result?.terminal?.paneText).toHaveLength(3_000);
    expect(result?.editor?.visibleText).toHaveLength(2_000);
    expect(result?.editor?.symbols).toHaveLength(100);
    expect(result?.editor?.symbols?.[0]).toHaveLength(200);
    expect(result?.editor?.openBuffers).toHaveLength(100);
    expect(result?.editor?.openBuffers?.[0]).toHaveLength(200);
    expect(result?.focusText?.before).toHaveLength(2_000);
    expect(result?.focusText?.selected).toHaveLength(500);
    expect(result?.focusText?.after).toHaveLength(500);
  });

  it("returns null for malformed snapshots", () => {
    expect(parseContextSnapshot(null)).toBeNull();
    expect(parseContextSnapshot("snapshot")).toBeNull();
    expect(parseContextSnapshot({})).toBeNull();
    expect(parseContextSnapshot({ capturedAt: "now" })).toBeNull();
  });

  it("accepts a minimal snapshot", () => {
    expect(parseContextSnapshot({ capturedAt: 1 })).toEqual({ capturedAt: 1 });
  });

  it("drops malformed optional fields", () => {
    expect(
      parseContextSnapshot({
        capturedAt: 1,
        app: { name: 42 },
        terminal: { paneText: 42 },
        editor: { file: 42, language: "typescript" },
        focusText: { before: 42 },
      }),
    ).toEqual({
      capturedAt: 1,
      editor: { file: undefined, language: "typescript" },
    });
  });

  it("strips unknown fields", () => {
    expect(
      parseContextSnapshot({
        capturedAt: 1,
        extra: true,
        app: { name: "Editor", extra: true },
      }),
    ).toEqual({
      capturedAt: 1,
      app: { name: "Editor" },
    });
  });
});
