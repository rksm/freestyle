import { execFile } from "node:child_process";

/**
 * Focused-window lookup through the Freestyle FocusBridge GNOME Shell
 * extension (`integrations/gnome-focus-bridge`).
 *
 * GNOME restricts `Introspect.GetWindows` to the portal and disables
 * `Shell.Eval`, so on GNOME Wayland an extension is the only way to learn
 * which window has focus. Falls back to the VibeTyper bridge, which exposes
 * the same method and may already be installed.
 *
 * This is the one authoritative home for the query: both the app-context
 * capture and the terminal-focus detection (which decides Ctrl+V vs
 * Ctrl+Shift+V) read from here.
 */

const BRIDGES = [
  { name: "com.freestyle.FocusBridge", path: "/com/freestyle/FocusBridge" },
  { name: "com.vibetyper.FocusBridge", path: "/com/vibetyper/FocusBridge" },
] as const;

const TIMEOUT_MS = 1500;

export interface FocusBridgeWindow {
  /** Shell app id (Freestyle bridge) or desktop id (VibeTyper bridge). */
  app?: string;
  appId?: string;
  name?: string;
  title?: string;
  wmClass?: string;
  wmClassInstance?: string;
  gtkApplicationId?: string;
  pid?: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** gdbus prints a single-string return as `('payload',)`. */
function unwrapGdbusString(output: string): string | null {
  const match = /^\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*\)$/.exec(output.trim());
  return match?.[1]?.replace(/\\(['\\])/g, "$1") ?? null;
}

function call(busName: string, objectPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        busName,
        "--object-path",
        objectPath,
        "--method",
        `${busName}.GetActiveWindow`,
      ],
      { encoding: "utf8", timeout: TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * The focused window, or `null` when no bridge is installed/enabled, nothing
 * is focused, or the payload carries no usable identity.
 */
export async function queryFocusBridge(): Promise<FocusBridgeWindow | null> {
  for (const bridge of BRIDGES) {
    try {
      const json = unwrapGdbusString(await call(bridge.name, bridge.path));
      if (!json) continue;
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      const raw = value as Record<string, unknown>;
      const window: FocusBridgeWindow = {
        ...(readString(raw.app) ? { app: readString(raw.app) } : {}),
        ...(readString(raw.appId) ? { appId: readString(raw.appId) } : {}),
        ...(readString(raw.name) ? { name: readString(raw.name) } : {}),
        ...(readString(raw.title) ? { title: readString(raw.title) } : {}),
        ...(readString(raw.wmClass)
          ? { wmClass: readString(raw.wmClass) }
          : {}),
        ...(readString(raw.wmClassInstance)
          ? { wmClassInstance: readString(raw.wmClassInstance) }
          : {}),
        ...(readString(raw.gtkApplicationId)
          ? { gtkApplicationId: readString(raw.gtkApplicationId) }
          : {}),
        ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
      };
      if (Object.keys(window).length === 0) continue;
      return window;
    } catch {
      // Try the compatibility bridge before giving up.
    }
  }
  return null;
}
