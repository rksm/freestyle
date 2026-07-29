import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import type {
  ContextSnapshot,
  Plugin,
  PluginContext,
  PluginOptions,
  ResolveRecognitionContextInput,
} from "freestyle-voice";

const WINDOW_SETTING = "context_source_window";
const TERMINAL_SETTING = "context_source_terminal";
const EDITOR_SETTING = "context_source_editor";
const ACCESSIBILITY_SETTING = "context_source_accessibility";
const ATSPI_ROOT = "/org/a11y/atspi/accessible/root";
const ATSPI_SHOWING = 1 << 25;
const ATSPI_LIST_ITEM_ROLE = 1;

const BRIDGES = [
  {
    name: "com.freestyle.FocusBridge",
    path: "/com/freestyle/FocusBridge",
  },
  {
    name: "com.vibetyper.FocusBridge",
    path: "/com/vibetyper/FocusBridge",
  },
] as const;

interface FocusedWindow {
  app?: unknown;
  appId?: unknown;
  name?: unknown;
  title?: unknown;
  windowTitle?: unknown;
  wmClass?: unknown;
  wmClassInstance?: unknown;
  gtkApplicationId?: unknown;
}

interface WindowIdentity {
  app: NonNullable<ContextSnapshot["app"]>;
  identifiers: string[];
  wmClass?: string;
  gtkApplicationId?: string;
}

function runFile(
  command: string,
  args: string[],
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, 200) : undefined;
}

function unwrapGdbusTuple(output: string): string | undefined {
  const match = /^\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*\)$/.exec(output.trim());
  return match?.[1]?.replace(/\\(['\\])/g, "$1");
}

function parseFocusedWindow(output: string): FocusedWindow {
  const json = unwrapGdbusTuple(output);
  if (!json) throw new Error("invalid gdbus response");

  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid FocusBridge payload");
  }

  const focused = value as FocusedWindow;
  if (
    ![
      focused.app,
      focused.appId,
      focused.name,
      focused.title,
      focused.windowTitle,
      focused.wmClass,
      focused.wmClassInstance,
      focused.gtkApplicationId,
    ].some(identifier)
  ) {
    throw new Error("empty FocusBridge payload");
  }
  return focused;
}

async function focusedWindow(): Promise<FocusedWindow> {
  for (const bridge of BRIDGES) {
    try {
      const output = await runFile(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          bridge.name,
          "--object-path",
          bridge.path,
          "--method",
          `${bridge.name}.GetActiveWindow`,
        ],
        500,
      );
      return parseFocusedWindow(output);
    } catch {
      // Try the compatibility bridge before giving up.
    }
  }
  throw new Error("FocusBridge unavailable");
}

function windowIdentity(
  focused: FocusedWindow | undefined,
  appContext: ResolveRecognitionContextInput["appContext"],
): WindowIdentity {
  const capturedName =
    identifier(appContext?.appName) ?? identifier(appContext?.bundleId);
  const focusedName =
    identifier(focused?.app) ??
    identifier(focused?.appId) ??
    identifier(focused?.name);
  const wmClass = identifier(focused?.wmClass);
  const name = capturedName ?? focusedName ?? wmClass ?? "Unknown";
  const windowTitle =
    boundedString(appContext?.windowTitle, 500) ??
    boundedString(focused?.title, 500) ??
    boundedString(focused?.windowTitle, 500) ??
    undefined;
  const gtkApplicationId = identifier(focused?.gtkApplicationId);
  const identifiers = capturedName
    ? [capturedName, identifier(appContext?.bundleId)]
    : focused
      ? [
          focusedName,
          wmClass,
          identifier(focused.wmClassInstance),
          gtkApplicationId,
        ]
      : [];

  return {
    app: {
      name: name.slice(0, 200),
      ...(windowTitle ? { windowTitle } : {}),
      ...(wmClass ? { wmClass } : {}),
    },
    identifiers: identifiers.filter((value): value is string => !!value),
    wmClass,
    gtkApplicationId,
  };
}

function isWezterm(identity: WindowIdentity): boolean {
  return identity.identifiers.some((value) =>
    value.toLowerCase().includes("wezterm"),
  );
}

function isEmacs(identity: WindowIdentity): boolean {
  return (
    identity.wmClass?.toLowerCase() === "emacs" ||
    identity.gtkApplicationId?.toLowerCase() === "org.gnu.emacs" ||
    identity.identifiers.some((value) => value.toLowerCase() === "emacs")
  );
}

function isSlack(identity: WindowIdentity): boolean {
  return identity.identifiers.some((value) =>
    /(^|[.\s_-])slack($|[.\s_-])/i.test(value),
  );
}

async function weztermPaneText(): Promise<string> {
  const output = await runFile("wezterm", ["cli", "get-text"], 700);
  return output.slice(-3_000).trimEnd();
}

function boundedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, 100)
    .map((item) => item.slice(0, 200));
}

function decodeEditor(output: string): ContextSnapshot["editor"] {
  const encoded: unknown = JSON.parse(output.trim());
  if (typeof encoded !== "string") {
    throw new Error("invalid emacsclient response");
  }

  const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Emacs context payload");
  }
  const editor = value as Record<string, unknown>;
  const snapshot: NonNullable<ContextSnapshot["editor"]> = {};
  const file = boundedString(editor.file, 500);
  const language = boundedString(editor.language, 100);
  const visibleText = boundedString(editor.visibleText, 2_000);
  const symbols = boundedStringList(editor.symbols);
  const openBuffers = boundedStringList(editor.openBuffers);
  if (file !== undefined) snapshot.file = file;
  if (language !== undefined) snapshot.language = language;
  if (visibleText !== undefined) snapshot.visibleText = visibleText;
  if (symbols !== undefined) snapshot.symbols = symbols;
  if (openBuffers !== undefined) snapshot.openBuffers = openBuffers;
  return snapshot;
}

async function emacsEditor(): Promise<ContextSnapshot["editor"]> {
  const output = await runFile(
    "emacsclient",
    [
      "--timeout",
      "1",
      "--eval",
      "(base64-encode-string (freestyle-context-snapshot) t)",
    ],
    800,
  );
  return decodeEditor(output);
}

function busctlData(output: string): unknown {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid busctl response");
  }
  return (value as { data?: unknown }).data;
}

function atspiApplications(output: string): string[] {
  const data = busctlData(output);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("invalid AT-SPI application list");
  }

  return data[0]
    .map((reference) =>
      Array.isArray(reference) && typeof reference[0] === "string"
        ? reference[0]
        : undefined,
    )
    .filter((value): value is string => value !== undefined);
}

function busctlString(output: string): string | undefined {
  const data = busctlData(output);
  return typeof data === "string" ? data : undefined;
}

function atspiObjectPaths(output: string): string[] {
  const data = busctlData(output);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("invalid AT-SPI object list");
  }

  return data[0]
    .map((reference) =>
      Array.isArray(reference) && typeof reference[1] === "string"
        ? reference[1]
        : undefined,
    )
    .filter((value): value is string => value !== undefined);
}

function boundedAccessibilityText(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }

  const text = lines.join("\n").slice(-2_000).trim();
  return text || undefined;
}

async function slackVisibleText(): Promise<string> {
  const addressOutput = await runFile(
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
    100,
  );
  const address = unwrapGdbusTuple(addressOutput);
  if (!address) throw new Error("AT-SPI bus unavailable");

  const busctlArgs = ["--address", address, "--json=short"];
  const applications = atspiApplications(
    await runFile(
      "busctl",
      [
        ...busctlArgs,
        "call",
        "org.a11y.atspi.Registry",
        ATSPI_ROOT,
        "org.a11y.atspi.Accessible",
        "GetChildren",
      ],
      100,
    ),
  );
  const names = await Promise.all(
    applications.map(async (application) => {
      try {
        return {
          application,
          name: busctlString(
            await runFile(
              "busctl",
              [
                ...busctlArgs,
                "get-property",
                application,
                ATSPI_ROOT,
                "org.a11y.atspi.Accessible",
                "Name",
              ],
              100,
            ),
          ),
        };
      } catch {
        return { application, name: undefined };
      }
    }),
  );
  const slack = names.find(({ name }) => name?.toLowerCase().includes("slack"));
  if (!slack) throw new Error("Slack accessibility tree unavailable");

  const messageObjects = atspiObjectPaths(
    await runFile(
      "busctl",
      [
        ...busctlArgs,
        "call",
        slack.application,
        ATSPI_ROOT,
        "org.a11y.atspi.Collection",
        "GetMatches",
        "(aiia{ss}iaiiasib)uib",
        "2",
        String(ATSPI_SHOWING),
        "0",
        "1",
        "0",
        "1",
        "4",
        "0",
        String(ATSPI_LIST_ITEM_ROLE),
        "0",
        "0",
        "1",
        "0",
        "1",
        "false",
        "1",
        "0",
        "true",
      ],
      100,
    ),
  );
  const messageNames = await Promise.all(
    messageObjects.map(async (objectPath) => {
      try {
        return busctlString(
          await runFile(
            "busctl",
            [
              ...busctlArgs,
              "get-property",
              slack.application,
              objectPath,
              "org.a11y.atspi.Accessible",
              "Name",
            ],
            100,
          ),
        );
      } catch {
        return undefined;
      }
    }),
  );
  const text = boundedAccessibilityText(messageNames);
  if (!text) throw new Error("Slack accessibility tree is empty");
  return text;
}

export default function desktopContextPlugin(_options?: PluginOptions): Plugin {
  let context: PluginContext | undefined;

  const sourceEnabled = (key: string): boolean => {
    try {
      return context?.settings.get(key) !== "false";
    } catch {
      return true;
    }
  };

  const collect = async <T>(
    collector: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    const startedAt = Date.now();
    let value: T | undefined;
    try {
      value = await action();
    } catch {
      value = undefined;
    }
    try {
      context?.logger.debug("desktop context collector", {
        collector,
        durationMs: Date.now() - startedAt,
        success: value !== undefined,
      });
    } catch {
      // Logging must never affect dictation.
    }
    return value;
  };

  return {
    name: "@freestyle-voice/plugin-desktop-context",

    setup(ctx) {
      context = ctx;
    },

    async resolveRecognitionContext(input, output) {
      try {
        const hasCapturedIdentity = Boolean(
          identifier(input.appContext?.appName) ??
            identifier(input.appContext?.bundleId),
        );
        const focused =
          sourceEnabled(WINDOW_SETTING) && !hasCapturedIdentity
            ? await collect("window", focusedWindow)
            : undefined;
        const identity = windowIdentity(focused, input.appContext);
        const snapshot: ContextSnapshot = {
          capturedAt: Date.now(),
          app: identity.app,
        };

        if (sourceEnabled(TERMINAL_SETTING) && isWezterm(identity)) {
          const paneText = await collect("terminal", weztermPaneText);
          if (paneText !== undefined) snapshot.terminal = { paneText };
        } else if (sourceEnabled(EDITOR_SETTING) && isEmacs(identity)) {
          const editor = await collect("editor", emacsEditor);
          if (editor !== undefined) snapshot.editor = editor;
        } else if (sourceEnabled(ACCESSIBILITY_SETTING) && isSlack(identity)) {
          const before = await collect("accessibility", slackVisibleText);
          if (before !== undefined) snapshot.focusText = { before };
        }

        output.snapshot = snapshot;
      } catch {
        output.snapshot = {
          capturedAt: Date.now(),
          app: windowIdentity(undefined, input.appContext).app,
        };
      }
    },
  };
}
