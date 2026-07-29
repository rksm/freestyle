import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let clipboardText = "original clipboard";
const clipboard = {
  availableFormats: vi.fn(() => ["text/plain"]),
  readText: vi.fn(() => clipboardText),
  writeText: vi.fn((text: string) => {
    clipboardText = text;
  }),
  write: vi.fn((data: { text?: string }) => {
    clipboardText = data.text ?? "";
  }),
};

vi.mock("electron", () => ({
  app: { isPackaged: false },
  clipboard,
}));
vi.mock("@freestyle-voice/utils", () => ({
  createAppLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock("./emacs-insert.js", () => ({
  tryEmacsInsert: vi.fn(() => false),
}));
vi.mock("./focus-bridge.js", () => ({
  queryFocusBridge: vi.fn(() => null),
}));
vi.mock("./linux-terminal-focus", () => ({
  isLinuxTerminalFocused: vi.fn(() => false),
}));
vi.mock("./native-binary", () => ({
  getNativeBinaryPath: vi.fn(() => null),
}));

const { pasteIntoFocusedApp } = await import("./paste");

describe("pasteIntoFocusedApp", () => {
  beforeEach(() => {
    clipboardText = "original clipboard";
    vi.clearAllMocks();
    vi.stubEnv("XDG_SESSION_TYPE", "x11");
    vi.stubEnv("WAYLAND_DISPLAY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops cancelled output before touching the clipboard or target app", async () => {
    const beforePaste = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      pasteIntoFocusedApp(
        "cancelled transcript",
        beforePaste,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(beforePaste).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("restores the clipboard when cancellation wins before paste injection", async () => {
    const controller = new AbortController();
    const beforePaste = vi.fn(() => controller.abort());

    await expect(
      pasteIntoFocusedApp(
        "cancelled transcript",
        beforePaste,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(clipboard.writeText).toHaveBeenCalledWith("cancelled transcript ");
    expect(clipboard.write).toHaveBeenCalledWith({
      text: "original clipboard",
    });
    expect(clipboardText).toBe("original clipboard");
  });
});
