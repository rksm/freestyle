import { Buffer } from "node:buffer";
import type { ExecFileException } from "node:child_process";
import type {
  ContextSnapshot,
  Plugin,
  PluginContext,
  ResolveRecognitionContextInput,
} from "freestyle-voice";
import { createHookApi } from "freestyle-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import desktopContextPlugin from "./index.js";

type ExecCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

function queueExec(stdout: string, error: ExecFileException | null = null) {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") {
      throw new Error("execFile callback missing");
    }
    (callback as ExecCallback)(error, stdout, "");
    return {};
  });
}

function gdbusTuple(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
  return `('${json}',)\n`;
}

function emacsResponse(payload: Record<string, unknown>): string {
  return JSON.stringify(
    Buffer.from(JSON.stringify(payload)).toString("base64"),
  );
}

async function configuredPlugin(
  values: Record<string, string> = {},
): Promise<Plugin> {
  const plugin = desktopContextPlugin();
  const context: PluginContext = {
    name: plugin.name,
    mode: "server",
    directory: "/tmp/freestyle-test",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    settings: {
      get: (key) => values[key],
      getOwn: () => undefined,
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
  };
  await plugin.setup?.(context);
  return plugin;
}

async function resolve(
  plugin: Plugin,
  appContext?: ResolveRecognitionContextInput["appContext"],
): Promise<ContextSnapshot> {
  const output: { snapshot?: ContextSnapshot } = {};
  await plugin.resolveRecognitionContext?.(
    {
      providerId: "deepgram",
      modelId: "nova-3",
      streaming: true,
      appContext,
    },
    output,
    createHookApi(),
  );
  if (!output.snapshot) throw new Error("snapshot missing");
  return output.snapshot;
}

describe("desktop context plugin", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("unwraps the Freestyle FocusBridge tuple", async () => {
    queueExec(
      gdbusTuple({
        app: "org.mozilla.firefox",
        title: "Freestyle docs",
        wmClass: "firefox",
      }),
    );

    const snapshot = await resolve(await configuredPlugin());

    expect(snapshot.app).toEqual({
      name: "org.mozilla.firefox",
      windowTitle: "Freestyle docs",
      wmClass: "firefox",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual([
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "com.freestyle.FocusBridge",
        "--object-path",
        "/com/freestyle/FocusBridge",
        "--method",
        "com.freestyle.FocusBridge.GetActiveWindow",
      ],
      { encoding: "utf8", timeout: 500 },
    ]);
  });

  it("falls back to the VibeTyper FocusBridge payload shape", async () => {
    queueExec("", new Error("name unavailable"));
    queueExec(
      gdbusTuple({
        appId: "org.wezfurlong.wezterm",
        title: "shell",
        wmClass: "org.wezfurlong.wezterm",
      }),
    );
    queueExec("prompt");

    const snapshot = await resolve(await configuredPlugin());

    expect(snapshot.app).toEqual({
      name: "org.wezfurlong.wezterm",
      windowTitle: "shell",
      wmClass: "org.wezfurlong.wezterm",
    });
    expect(execFileMock.mock.calls[1]?.[1]).toContain(
      "com.vibetyper.FocusBridge",
    );
  });

  it("collects a bounded, trailing-blank-trimmed WezTerm pane", async () => {
    queueExec(
      gdbusTuple({
        app: "org.wezfurlong.wezterm",
        wmClass: "wezterm",
      }),
    );
    queueExec(`${"discard".repeat(10)}${"x".repeat(3_000)}\n\n`);

    const snapshot = await resolve(await configuredPlugin());

    expect(snapshot.terminal?.paneText).toBe("x".repeat(2_998));
    expect(snapshot.terminal?.paneText.length).toBeLessThanOrEqual(3_000);
    expect(execFileMock.mock.calls[1]?.slice(0, 2)).toEqual([
      "wezterm",
      ["cli", "get-text"],
    ]);
    expect(execFileMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 700 });
  });

  it("decodes the Emacs Lisp string literal and maps editor fields", async () => {
    const editor = {
      file: "/work/context.ts",
      language: "typescript-ts",
      visibleText: 'const greeting = "hello"; // Grüße — 你好\n',
      symbols: ["resolveContext", "decodeEditor"],
      openBuffers: ["context.ts", "PLAN.org"],
    };
    queueExec(
      gdbusTuple({
        app: "Emacs",
        wmClass: "emacs",
        gtkApplicationId: "org.gnu.emacs",
      }),
    );
    queueExec(emacsResponse(editor));

    const snapshot = await resolve(await configuredPlugin());

    expect(snapshot.editor).toEqual(editor);
    expect(execFileMock.mock.calls[1]?.slice(0, 2)).toEqual([
      "emacsclient",
      [
        "--timeout",
        "1",
        "--eval",
        "(base64-encode-string (freestyle-context-snapshot) t)",
      ],
    ]);
    expect(execFileMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 800 });
  });

  it("uses captured app context without querying current focus", async () => {
    const snapshot = await resolve(await configuredPlugin(), {
      appName: "Firefox",
      windowTitle: "Fallback title",
      bundleId: "org.mozilla.firefox",
    });

    expect(snapshot.app).toEqual({
      name: "Firefox",
      windowTitle: "Fallback title",
    });
    expect(snapshot.terminal).toBeUndefined();
    expect(snapshot.editor).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("collects WezTerm text from the captured pre-pill identity", async () => {
    queueExec("const resolveRecognitionContext = true;");

    const snapshot = await resolve(await configuredPlugin(), {
      appName: "org.wezfurlong.wezterm",
      windowTitle: "shell",
    });

    expect(snapshot.app).toEqual({
      name: "org.wezfurlong.wezterm",
      windowTitle: "shell",
    });
    expect(snapshot.terminal?.paneText).toBe(
      "const resolveRecognitionContext = true;",
    );
    expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual([
      "wezterm",
      ["cli", "get-text"],
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("collects Emacs context from the captured pre-pill identity", async () => {
    const editor = {
      file: "/work/context.ts",
      symbols: ["resolveRecognitionContext"],
    };
    queueExec(emacsResponse(editor));

    const snapshot = await resolve(await configuredPlugin(), {
      appName: "emacs",
      windowTitle: "context.ts",
    });

    expect(snapshot.editor).toEqual(editor);
    expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual([
      "emacsclient",
      [
        "--timeout",
        "1",
        "--eval",
        "(base64-encode-string (freestyle-context-snapshot) t)",
      ],
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("omits terminal context when the WezTerm collector times out", async () => {
    queueExec(gdbusTuple({ app: "wezterm", wmClass: "wezterm" }));
    queueExec("", new Error("timeout"));

    const snapshot = await resolve(await configuredPlugin());

    expect(snapshot.app?.name).toBe("wezterm");
    expect(snapshot.terminal).toBeUndefined();
  });

  it("omits editor context when the Emacs collector fails", async () => {
    queueExec(
      gdbusTuple({
        app: "Emacs",
        gtkApplicationId: "org.gnu.emacs",
      }),
    );
    queueExec("not an elisp string");

    const snapshot = await resolve(await configuredPlugin());

    expect(snapshot.app?.name).toBe("Emacs");
    expect(snapshot.editor).toBeUndefined();
  });

  it("does not invoke FocusBridge when the window source is disabled", async () => {
    const plugin = await configuredPlugin({
      context_source_window: "false",
    });

    const snapshot = await resolve(plugin, { appName: "Firefox" });

    expect(snapshot.app?.name).toBe("Firefox");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not invoke WezTerm when the terminal source is disabled", async () => {
    queueExec(gdbusTuple({ app: "wezterm", wmClass: "wezterm" }));
    const plugin = await configuredPlugin({
      context_source_terminal: "false",
    });

    const snapshot = await resolve(plugin);

    expect(snapshot.terminal).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not invoke Emacs when the editor source is disabled", async () => {
    queueExec(
      gdbusTuple({
        app: "Emacs",
        gtkApplicationId: "org.gnu.emacs",
      }),
    );
    const plugin = await configuredPlugin({
      context_source_editor: "false",
    });

    const snapshot = await resolve(plugin);

    expect(snapshot.editor).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
