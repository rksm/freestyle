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
const dbusCallMock = vi.hoisted(() => vi.fn());
const dbusDisconnectMock = vi.hoisted(() => vi.fn());
const dbusOnMock = vi.hoisted(() => vi.fn());
const dbusSessionBusMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));
vi.mock("@particle/dbus-next", () => {
  class Message {
    constructor(value: Record<string, unknown>) {
      Object.assign(this, value);
    }
  }
  return {
    default: {
      Message,
      sessionBus: dbusSessionBusMock,
    },
  };
});

import desktopContextPlugin from "./index.js";

type ExecCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

interface MockDbusMessage {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature: string;
  body: unknown[];
}

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

function mockAccessibilityTree(
  applicationName: string,
  handler: (message: MockDbusMessage) => unknown[],
) {
  dbusCallMock.mockImplementation(async (message: MockDbusMessage) => {
    if (
      message.destination === "org.a11y.atspi.Registry" &&
      message.member === "GetChildren"
    ) {
      return {
        body: [[["org.example.Accessible", "/org/a11y/atspi/accessible/root"]]],
      };
    }
    if (
      message.member === "Get" &&
      message.path === "/org/a11y/atspi/accessible/root"
    ) {
      return { body: [{ value: applicationName }] };
    }
    return { body: handler(message) };
  });
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
    dbusCallMock.mockReset();
    dbusDisconnectMock.mockReset();
    dbusOnMock.mockReset();
    dbusSessionBusMock.mockReset();
    dbusSessionBusMock.mockReturnValue({
      call: dbusCallMock,
      disconnect: dbusDisconnectMock,
      on: dbusOnMock,
    });
  });

  it("unwraps the Freestyle FocusBridge tuple", async () => {
    queueExec(
      gdbusTuple({
        app: "org.mozilla.firefox",
        title: "Freestyle docs",
        wmClass: "firefox",
      }),
    );

    const snapshot = await resolve(
      await configuredPlugin({ context_source_accessibility: "false" }),
    );

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
    const snapshot = await resolve(
      await configuredPlugin({ context_source_accessibility: "false" }),
      {
        appName: "Firefox",
        windowTitle: "Fallback title",
        bundleId: "org.mozilla.firefox",
      },
    );

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

  it("collects visible Slack messages from its accessibility collection", async () => {
    queueExec("('unix:path=/run/user/1000/at-spi/bus',)\n");
    const names: Record<string, string> = {
      "/org/a11y/atspi/accessible/20": "github-feed GitHub",
      "/org/a11y/atspi/accessible/21":
        "Alice: Please review resolveRecognitionContext",
      "/org/a11y/atspi/accessible/22":
        "Alice: Please review resolveRecognitionContext",
    };
    mockAccessibilityTree("Slack", (message) => {
      if (message.member === "GetMatches") {
        return [
          Object.keys(names).map((path) => ["org.example.Accessible", path]),
        ];
      }
      if (message.member === "Get") {
        return [{ value: names[message.path] }];
      }
      throw new Error(`unexpected D-Bus call: ${message.member}`);
    });

    const snapshot = await resolve(await configuredPlugin(), {
      appName: "Slack",
      windowTitle: "context-team",
    });

    expect(snapshot.focusText).toEqual({
      before:
        "github-feed GitHub\nAlice: Please review resolveRecognitionContext",
    });
    expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual([
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.a11y.Bus",
        "--object-path",
        "/org/a11y/bus",
        "--method",
        "org.a11y.Bus.GetAddress",
      ],
    ]);
    const getMatches = dbusCallMock.mock.calls.find(
      ([message]) => message.member === "GetMatches",
    )?.[0] as MockDbusMessage;
    expect(getMatches.body).toEqual([
      [[1 << 25, 0, 0, 0], 1, {}, 1, [0, 1, 0, 0], 1, [], 1, false],
      1,
      0,
      true,
    ]);
    expect(dbusSessionBusMock).toHaveBeenCalledWith({
      busAddress: "unix:path=/run/user/1000/at-spi/bus",
    });
    expect(dbusDisconnectMock).toHaveBeenCalledOnce();
  });

  it("bounds Slack accessibility text to the trailing 2,000 characters", async () => {
    queueExec("('unix:path=/run/user/1000/at-spi/bus',)\n");
    mockAccessibilityTree("Slack", (message) => {
      if (message.member === "GetMatches") {
        return [[["org.example.Accessible", "/org/a11y/atspi/accessible/20"]]];
      }
      if (message.member === "Get") {
        return [{ value: "x".repeat(2_500) }];
      }
      throw new Error(`unexpected D-Bus call: ${message.member}`);
    });

    const snapshot = await resolve(await configuredPlugin(), {
      appName: "com.slack.Slack",
    });

    expect(snapshot.focusText?.before).toBe("x".repeat(2_000));
  });

  it("collects visible text from the active accessible document", async () => {
    queueExec("('unix:path=/run/user/1000/at-spi/bus',)\n");
    const document = "/org/a11y/atspi/accessible/document";
    const first = "/org/a11y/atspi/accessible/20";
    const second = "/org/a11y/atspi/accessible/21";
    const hidden = "/org/a11y/atspi/accessible/22";
    const editable = "/org/a11y/atspi/accessible/23";
    const extents: Record<string, [number, number, number, number]> = {
      [document]: [100, 100, 800, 600],
      [first]: [120, 140, 300, 20],
      [second]: [120, 180, 300, 20],
      [hidden]: [120, 800, 300, 20],
      [editable]: [120, 220, 300, 20],
    };
    mockAccessibilityTree("Firefox", (message) => {
      if (
        message.member === "GetMatches" &&
        message.path === "/org/a11y/atspi/accessible/root"
      ) {
        return [[["org.example.Accessible", document]]];
      }
      if (message.member === "GetMatches" && message.path === document) {
        return [
          [first, second, hidden, editable].map((path) => [
            "org.example.Accessible",
            path,
          ]),
        ];
      }
      if (message.member === "GetExtents") {
        return [extents[message.path]];
      }
      if (message.member === "GetState") {
        return [[message.path === editable ? 1 << 7 : 0, 0]];
      }
      if (message.member === "GetText") {
        const text =
          message.path === first
            ? "Firefox accessibility context"
            : message.path === second
              ? "\uFFFC"
              : message.path === hidden
                ? "hidden text"
                : "editable text";
        return [text];
      }
      if (message.member === "Get") {
        return [
          {
            value:
              message.path === second
                ? "Visible fallback label"
                : "duplicate accessible name",
          },
        ];
      }
      throw new Error(`unexpected D-Bus call: ${message.member}`);
    });

    const snapshot = await resolve(await configuredPlugin(), {
      appName: "org.mozilla.firefox",
      windowTitle: "Accessibility",
    });

    expect(snapshot.focusText).toEqual({
      before: "Firefox accessibility context\nVisible fallback label",
    });
    const documentQueries = dbusCallMock.mock.calls
      .map(([message]) => message as MockDbusMessage)
      .filter(
        (message) =>
          message.member === "GetMatches" && message.path === document,
      );
    expect(documentQueries).toHaveLength(2);
    expect(documentQueries.map((message) => message.body[1])).toEqual([1, 4]);
    expect(
      dbusCallMock.mock.calls.some(
        ([message]) =>
          [hidden, editable].includes(message.path) &&
          message.member === "GetText",
      ),
    ).toBe(false);
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
      context_source_accessibility: "false",
    });

    const snapshot = await resolve(plugin, { appName: "Firefox" });

    expect(snapshot.app?.name).toBe("Firefox");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not invoke WezTerm when the terminal source is disabled", async () => {
    queueExec(gdbusTuple({ app: "wezterm", wmClass: "wezterm" }));
    const plugin = await configuredPlugin({
      context_source_terminal: "false",
      context_source_accessibility: "false",
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
      context_source_accessibility: "false",
    });

    const snapshot = await resolve(plugin);

    expect(snapshot.editor).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not query AT-SPI when the accessibility source is disabled", async () => {
    const plugin = await configuredPlugin({
      context_source_accessibility: "false",
    });

    const snapshot = await resolve(plugin, { appName: "Slack" });

    expect(snapshot.focusText).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
