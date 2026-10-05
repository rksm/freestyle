import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIOR = "prior clipboard";

// Electron's clipboard stands for the X11 one under XWayland; `wayland` is the
// real Wayland clipboard that wl-copy/wl-paste talk to.
let electronText = PRIOR;
let wayland: string | null = PRIOR;
let wlCopyExitCode = 0;
/** What the Wayland clipboard held each time a paste chord was injected. */
let waylandAtInjection: Array<string | null> = [];
let injected: string[] = [];

const clipboard = {
  availableFormats: vi.fn(() => ["text/plain"]),
  readText: vi.fn(() => electronText),
  writeText: vi.fn((text: string) => {
    electronText = text;
  }),
  write: vi.fn((data: { text?: string }) => {
    electronText = data.text ?? "";
  }),
};

function fakeProcess(command: string) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stdin: {
      end: (text: string) => {
        if (wlCopyExitCode === 0) wayland = text;
        setImmediate(() => child.emit("exit", wlCopyExitCode));
      },
    },
    kill: vi.fn(),
  });
  if (command === "wl-paste") {
    setImmediate(() => {
      if (wayland !== null) child.stdout.emit("data", Buffer.from(wayland));
      child.emit("exit", wayland === null ? 1 : 0);
    });
  }
  return child;
}

vi.mock("node:child_process", () => ({
  exec: vi.fn(
    (cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
      injected.push(cmd);
      waylandAtInjection.push(wayland);
      cb(null);
    },
  ),
  execFile: vi.fn(),
  spawn: vi.fn((command: string) => fakeProcess(command)),
}));
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
vi.mock("./emacs-insert", () => ({
  tryEmacsInsert: vi.fn(async () => false),
}));
vi.mock("./focus-bridge", () => ({
  queryFocusBridge: vi.fn(async () => null),
}));
vi.mock("./linux-terminal-focus", () => ({
  isLinuxTerminalFocused: vi.fn(async () => false),
}));
vi.mock("./native-binary", () => ({
  getNativeBinaryPath: vi.fn(() => null),
}));

const { spawn } = await import("node:child_process");
const { tryEmacsInsert } = await import("./emacs-insert");
const { queryFocusBridge } = await import("./focus-bridge");
const { isFreestyleWindow, pasteIntoFocusedApp } = await import("./paste");
const { app } = await import("electron");

const pill = { wmClass: "freestyle" };
const editor = { wmClass: "gedit" };

describe("pasteIntoFocusedApp on Linux", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    electronText = PRIOR;
    wayland = PRIOR;
    wlCopyExitCode = 0;
    waylandAtInjection = [];
    injected = [];
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("FREESTYLE_PASTE_SETTLE_MS", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (platform) Object.defineProperty(process, "platform", platform);
  });

  describe("on Wayland", () => {
    beforeEach(() => {
      vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    });

    it("hides the pill, waits for focus to leave it, then inserts into Emacs", async () => {
      const order: string[] = [];
      vi.mocked(queryFocusBridge)
        .mockImplementationOnce(async () => {
          order.push("query");
          return pill;
        })
        .mockImplementationOnce(async () => {
          order.push("query");
          return editor;
        });
      vi.mocked(tryEmacsInsert).mockImplementationOnce(async () => {
        order.push("emacs");
        return true;
      });

      await pasteIntoFocusedApp("hello", () => {
        order.push("hide");
      });

      expect(order).toEqual(["hide", "query", "query", "emacs"]);
      expect(tryEmacsInsert).toHaveBeenCalledWith("hello ");
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(injected).toEqual([]);
    });

    it("puts the transcript on the Wayland clipboard before injecting, then restores it", async () => {
      vi.mocked(queryFocusBridge).mockResolvedValue(editor);

      await pasteIntoFocusedApp("hello");

      expect(injected).toEqual(["wtype -M ctrl -P v -p v -m ctrl"]);
      expect(waylandAtInjection).toEqual(["hello "]);
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(wayland).toBe(PRIOR);
    });

    it("falls back to Electron's clipboard when wl-copy fails", async () => {
      wlCopyExitCode = 1;
      vi.mocked(queryFocusBridge).mockResolvedValue(editor);

      await pasteIntoFocusedApp("hello");

      expect(injected).toEqual(["wtype -M ctrl -P v -p v -m ctrl"]);
      expect(clipboard.writeText).toHaveBeenCalledWith("hello ");
      expect(electronText).toBe(PRIOR);
      expect(wayland).toBe(PRIOR);
    });

    it("leaves a non-text Wayland clipboard alone when restoring", async () => {
      wayland = null;
      vi.mocked(queryFocusBridge).mockResolvedValue(editor);

      await pasteIntoFocusedApp("hello");

      expect(wayland).toBe("hello ");
    });
  });

  describe("when the user cancels", () => {
    beforeEach(() => {
      vi.stubEnv("XDG_SESSION_TYPE", "x11");
      vi.stubEnv("WAYLAND_DISPLAY", "");
    });

    it("drops output cancelled before delivery starts", async () => {
      const beforePaste = vi.fn();
      const controller = new AbortController();
      controller.abort();

      await expect(
        pasteIntoFocusedApp("hello", beforePaste, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(beforePaste).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(injected).toEqual([]);
    });

    it("leaves the clipboard alone when cancelled while the pill hides", async () => {
      const controller = new AbortController();

      await expect(
        pasteIntoFocusedApp("hello", () => controller.abort(), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(injected).toEqual([]);
    });

    it("restores the clipboard when cancelled after it was written", async () => {
      const controller = new AbortController();
      clipboard.writeText.mockImplementationOnce((text: string) => {
        electronText = text;
        controller.abort();
      });

      await expect(
        pasteIntoFocusedApp("hello", undefined, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(injected).toEqual([]);
      expect(electronText).toBe(PRIOR);
    });
  });

  it("does not use Wayland tools or the focus bridge on X11", async () => {
    vi.stubEnv("XDG_SESSION_TYPE", "x11");
    vi.stubEnv("WAYLAND_DISPLAY", "");

    await pasteIntoFocusedApp("hello");

    expect(injected).toEqual(["xdotool key ctrl+v"]);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello ");
    expect(electronText).toBe(PRIOR);
    expect(spawn).not.toHaveBeenCalled();
    expect(queryFocusBridge).not.toHaveBeenCalled();
    expect(tryEmacsInsert).not.toHaveBeenCalled();
  });
});

describe("isFreestyleWindow", () => {
  // The electron mock's `app` is a plain object; its type marks isPackaged read-only.
  const setPackaged = (isPackaged: boolean) =>
    Object.assign(app, { isPackaged });

  afterEach(() => setPackaged(false));

  it("matches Freestyle by class, app or application id", () => {
    expect(isFreestyleWindow({ wmClass: "freestyle" })).toBe(true);
    expect(isFreestyleWindow({ app: "Freestyle.desktop" })).toBe(true);
    expect(isFreestyleWindow({ gtkApplicationId: "com.freestyle" })).toBe(true);
    expect(isFreestyleWindow({ wmClass: "gedit" })).toBe(false);
  });

  it("matches the dev binary only when not packaged", () => {
    setPackaged(false);
    expect(isFreestyleWindow({ wmClass: "Electron" })).toBe(true);
    setPackaged(true);
    expect(isFreestyleWindow({ wmClass: "Electron" })).toBe(false);
  });
});
