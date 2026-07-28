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
  const focusedName =
    identifier(focused?.app) ??
    identifier(focused?.appId) ??
    identifier(focused?.name);
  const wmClass = identifier(focused?.wmClass);
  const fallbackName =
    identifier(appContext?.appName) ?? identifier(appContext?.bundleId);
  const name = focusedName ?? wmClass ?? fallbackName ?? "Unknown";
  const windowTitle =
    boundedString(focused?.title, 500) ??
    boundedString(focused?.windowTitle, 500) ??
    boundedString(appContext?.windowTitle, 500);
  const gtkApplicationId = identifier(focused?.gtkApplicationId);
  const identifiers = focused
    ? [
        focusedName,
        wmClass,
        identifier(focused.wmClassInstance),
        gtkApplicationId,
      ]
    : [fallbackName, identifier(appContext?.bundleId)];

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
  const json: unknown = JSON.parse(output.trim());
  if (typeof json !== "string") throw new Error("invalid emacsclient response");

  const value: unknown = JSON.parse(json);
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
    ["--timeout", "1", "--eval", "(freestyle-context-snapshot)"],
    800,
  );
  return decodeEditor(output);
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
        const focused = sourceEnabled(WINDOW_SETTING)
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
