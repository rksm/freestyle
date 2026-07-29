import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import dbus, { type MessageBus } from "@particle/dbus-next";
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
const ATSPI_SHOWING_STATE = 25;
const ATSPI_ACCESSIBLE = "org.a11y.atspi.Accessible";
const ATSPI_COLLECTION = "org.a11y.atspi.Collection";
const ATSPI_COMPONENT = "org.a11y.atspi.Component";
const ATSPI_TEXT = "org.a11y.atspi.Text";
const DBUS_PROPERTIES = "org.freedesktop.DBus.Properties";
const ACCESSIBILITY_TIMEOUT_MS = 180;
// AT-SPI role numbers are stable protocol values. Document roles cover frame,
// text, web, and email documents. Text roles intentionally omit entry and
// password widgets.
const DOCUMENT_ROLES = [82, 94, 95, 96];
const TEXT_ROLES = [29, 43, 61, 73, 81, 83, 88, 116, 122, 123, 124];
const ATSPI_EDITABLE_STATE = 7;
const SLACK_LIST_ITEM_ROLE = 32;
const MAX_ACCESSIBLE_NODES = 500;

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

type AtspiReference = [service: string, path: string];
type AtspiRect = [x: number, y: number, width: number, height: number];
type DbusValue =
  | string
  | number
  | boolean
  | DbusValue[]
  | Record<string, string>;

async function dbusCall(
  bus: MessageBus,
  destination: string,
  path: string,
  interfaceName: string,
  member: string,
  signature = "",
  body: DbusValue[] = [],
): Promise<unknown[]> {
  const reply = await bus.call(
    new dbus.Message({
      destination,
      path,
      interface: interfaceName,
      member,
      signature,
      body,
    }),
  );
  return (reply?.body ?? []) as unknown[];
}

function atspiReferences(value: unknown): AtspiReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AtspiReference =>
      Array.isArray(item) &&
      typeof item[0] === "string" &&
      typeof item[1] === "string",
  );
}

function atspiRect(value: unknown): AtspiRect | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((item) => typeof item === "number")
  ) {
    return undefined;
  }
  return value as AtspiRect;
}

function bitMask(values: number[]): number[] {
  const words = [0, 0, 0, 0];
  for (const value of values) {
    const index = Math.floor(value / 32);
    const word = words[index];
    if (word !== undefined) words[index] = word | (1 << (value % 32));
  }
  return words;
}

function includesState(value: unknown, state: number): boolean {
  if (!Array.isArray(value)) return false;
  const word = value[Math.floor(state / 32)];
  return typeof word === "number" && (word & (1 << (state % 32))) !== 0;
}

function matchRule(roles: number[], states: number[] = []): DbusValue[] {
  return [
    states.length > 0 ? bitMask(states) : [],
    1,
    {},
    1,
    bitMask(roles),
    roles.length > 1 ? 2 : 1,
    [],
    1,
    false,
  ];
}

async function collectionMatches(
  bus: MessageBus,
  reference: AtspiReference,
  roles: number[],
  options: { count?: number; sort?: number; states?: number[] } = {},
): Promise<AtspiReference[]> {
  const [matches] = await dbusCall(
    bus,
    reference[0],
    reference[1],
    ATSPI_COLLECTION,
    "GetMatches",
    "(aiia{ss}iaiiasib)uib",
    [
      matchRule(roles, options.states),
      options.sort ?? 1,
      options.count ?? 0,
      true,
    ],
  );
  return atspiReferences(matches);
}

async function accessibleName(
  bus: MessageBus,
  reference: AtspiReference,
): Promise<string | undefined> {
  const [variant] = await dbusCall(
    bus,
    reference[0],
    reference[1],
    DBUS_PROPERTIES,
    "Get",
    "ss",
    [ATSPI_ACCESSIBLE, "Name"],
  );
  if (!variant || typeof variant !== "object" || !("value" in variant)) {
    return undefined;
  }
  const value = (variant as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

async function componentExtents(
  bus: MessageBus,
  reference: AtspiReference,
): Promise<AtspiRect | undefined> {
  const [value] = await dbusCall(
    bus,
    reference[0],
    reference[1],
    ATSPI_COMPONENT,
    "GetExtents",
    "u",
    [0],
  );
  return atspiRect(value);
}

async function accessibleStates(
  bus: MessageBus,
  reference: AtspiReference,
): Promise<unknown> {
  const [value] = await dbusCall(
    bus,
    reference[0],
    reference[1],
    ATSPI_ACCESSIBLE,
    "GetState",
  );
  return value;
}

async function accessibleText(
  bus: MessageBus,
  reference: AtspiReference,
): Promise<string | undefined> {
  const [text, name] = await Promise.all([
    dbusCall(
      bus,
      reference[0],
      reference[1],
      ATSPI_TEXT,
      "GetText",
      "ii",
      [0, -1],
    )
      .then(([value]) => (typeof value === "string" ? value : undefined))
      .catch(() => undefined),
    accessibleName(bus, reference).catch(() => undefined),
  ]);
  const normalizedText = text?.replaceAll("\uFFFC", " ").trim();
  return normalizedText || name;
}

function normalizedAppIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchesApplicationName(name: string, identity: WindowIdentity) {
  const candidate = normalizedAppIdentifier(name);
  if (!candidate) return false;
  return identity.identifiers.some((value) => {
    const identifier = normalizedAppIdentifier(value);
    if (!identifier) return false;
    return (
      identifier === candidate ||
      identifier.endsWith(candidate) ||
      candidate.endsWith(identifier)
    );
  });
}

async function findAtspiApplication(
  bus: MessageBus,
  identity: WindowIdentity,
): Promise<AtspiReference> {
  const [children] = await dbusCall(
    bus,
    "org.a11y.atspi.Registry",
    ATSPI_ROOT,
    ATSPI_ACCESSIBLE,
    "GetChildren",
  );
  const applications = atspiReferences(children);
  const names = await Promise.all(
    applications.map(async (reference) => ({
      reference,
      name: await accessibleName(bus, reference).catch(() => undefined),
    })),
  );
  const application = names.find(
    ({ name }) => name && matchesApplicationName(name, identity),
  );
  if (!application)
    throw new Error("application accessibility tree unavailable");
  return application.reference;
}

function boundedAccessibilityText(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.replaceAll("\uFFFC", " ").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }

  const text = lines.join("\n").slice(-2_000).trim();
  return text || undefined;
}

async function slackVisibleText(
  bus: MessageBus,
  application: AtspiReference,
): Promise<string> {
  const messageObjects = await collectionMatches(
    bus,
    application,
    [SLACK_LIST_ITEM_ROLE],
    { states: [ATSPI_SHOWING_STATE] },
  );
  const messageNames = await Promise.all(
    messageObjects.map((reference) =>
      accessibleName(bus, reference).catch(() => undefined),
    ),
  );
  const text = boundedAccessibilityText(messageNames);
  if (!text) throw new Error("Slack accessibility tree is empty");
  return text;
}

function intersects(first: AtspiRect, second: AtspiRect): boolean {
  return (
    first[2] > 0 &&
    first[3] > 0 &&
    second[2] > 0 &&
    second[3] > 0 &&
    first[0] < second[0] + second[2] &&
    first[0] + first[2] > second[0] &&
    first[1] < second[1] + second[3] &&
    first[1] + first[3] > second[1]
  );
}

async function activeDocument(
  bus: MessageBus,
  application: AtspiReference,
): Promise<{ reference: AtspiReference; rect: AtspiRect }> {
  const documents = await collectionMatches(bus, application, DOCUMENT_ROLES, {
    count: 20,
  });
  const candidates = await Promise.all(
    documents.map(async (reference) => ({
      reference,
      rect: await componentExtents(bus, reference).catch(() => undefined),
    })),
  );
  const visible = candidates
    .filter(
      (
        candidate,
      ): candidate is { reference: AtspiReference; rect: AtspiRect } =>
        candidate.rect !== undefined &&
        candidate.rect[2] > 0 &&
        candidate.rect[3] > 0,
    )
    .sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]);
  const document = visible[0];
  if (!document) throw new Error("active accessible document unavailable");
  return document;
}

async function visibleDocumentText(
  bus: MessageBus,
  application: AtspiReference,
): Promise<string> {
  const document = await activeDocument(bus, application);
  const [forward, backward] = await Promise.all([
    collectionMatches(bus, document.reference, TEXT_ROLES, {
      count: MAX_ACCESSIBLE_NODES,
    }),
    collectionMatches(bus, document.reference, TEXT_ROLES, {
      count: MAX_ACCESSIBLE_NODES,
      sort: 4,
    }),
  ]);
  const references = new Map<string, AtspiReference>();
  for (const reference of [...forward, ...backward]) {
    references.set(`${reference[0]}\0${reference[1]}`, reference);
  }
  const candidates = await Promise.all(
    [...references.values()].map(async (reference) => {
      const [rect, states] = await Promise.all([
        componentExtents(bus, reference).catch(() => undefined),
        accessibleStates(bus, reference).catch(() => undefined),
      ]);
      return { reference, rect, states };
    }),
  );
  const visible = candidates
    .filter(
      (
        candidate,
      ): candidate is {
        reference: AtspiReference;
        rect: AtspiRect;
        states: unknown;
      } =>
        candidate.rect !== undefined &&
        candidate.states !== undefined &&
        !includesState(candidate.states, ATSPI_EDITABLE_STATE) &&
        intersects(candidate.rect, document.rect),
    )
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
  const values = await Promise.all(
    visible.map(({ reference }) => accessibleText(bus, reference)),
  );
  const text = boundedAccessibilityText(values);
  if (!text) throw new Error("accessible document is empty");
  return text;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("accessibility collector timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function accessibilityText(identity: WindowIdentity): Promise<string> {
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
  const bus = dbus.sessionBus({ busAddress: address });
  bus.on("error", () => {});
  try {
    return await withTimeout(
      (async () => {
        const application = await findAtspiApplication(bus, identity);
        return isSlack(identity)
          ? slackVisibleText(bus, application)
          : visibleDocumentText(bus, application);
      })(),
      ACCESSIBILITY_TIMEOUT_MS,
    );
  } finally {
    bus.disconnect();
  }
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
        } else if (sourceEnabled(ACCESSIBILITY_SETTING)) {
          const before = await collect("accessibility", () =>
            accessibilityText(identity),
          );
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
