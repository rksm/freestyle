import {
  type ChildProcessWithoutNullStreams,
  exec,
  execFile,
  spawn,
} from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppLogger } from "@freestyle-voice/utils";
import { app, clipboard } from "electron";
import { tryEmacsInsert } from "./emacs-insert.js";
import { queryFocusBridge } from "./focus-bridge.js";
import { isLinuxTerminalFocused } from "./linux-terminal-focus";
import { getNativeBinaryPath } from "./native-binary";

const log = createAppLogger("paste");

function execAsync(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

async function tryExecAsync(cmd: string, label: string): Promise<boolean> {
  try {
    await execAsync(cmd);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${label} failed: ${message}`);
    return false;
  }
}

function execFileWithOutput(
  path: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(path, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        const status = (err as { status?: unknown }).status;
        const exitCode =
          typeof status === "number"
            ? status
            : typeof err.code === "number"
              ? err.code
              : undefined;
        if (exitCode !== undefined) {
          resolve({ code: exitCode, stdout: stdout ?? "" });
        } else {
          reject(err);
        }
      } else {
        resolve({ code: 0, stdout: stdout ?? "" });
      }
    });
  });
}

async function execFileAsync(
  path: string,
  args: string[] = [],
): Promise<number> {
  const { code } = await execFileWithOutput(path, args);
  return code;
}

export function isWaylandSession(): boolean {
  return (
    process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
    Boolean(process.env.WAYLAND_DISPLAY)
  );
}

async function pasteMac(): Promise<"native" | "legacy"> {
  const binaryPath = getNativeBinaryPath("macos-fast-paste");
  if (binaryPath) {
    const exitCode = await execFileAsync(binaryPath);
    if (exitCode === 2) {
      log.warn(
        "No accessibility permission (native binary exit 2), falling back to osascript",
      );
      await execAsync(
        `osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`,
      );
      return "legacy";
    } else if (exitCode !== 0) {
      throw new Error(`macos-fast-paste exited with code ${exitCode}`);
    }
    return "native";
  }
  await execAsync(
    `osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`,
  );
  return "legacy";
}

async function pasteWindows(): Promise<"native" | "legacy"> {
  const binaryPath = getNativeBinaryPath("windows-fast-paste");
  if (binaryPath) {
    const exitCode = await execFileAsync(binaryPath);
    if (exitCode !== 0) {
      throw new Error(`windows-fast-paste exited with code ${exitCode}`);
    }
    return "native";
  }
  await execAsync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
  );
  return "legacy";
}

type PasteMethod = "native" | "legacy";

let linuxUinputHelper: ChildProcessWithoutNullStreams | null = null;
let linuxUinputReady = false;
let linuxUinputStarting: Promise<boolean> | null = null;
let linuxUinputLineBuffer = "";
let linuxUinputPendingResponse: ((success: boolean) => void) | null = null;
let linuxUinputCommandChain: Promise<unknown> = Promise.resolve();

function settleLinuxUinputResponse(success: boolean): void {
  const resolve = linuxUinputPendingResponse;
  linuxUinputPendingResponse = null;
  resolve?.(success);
}

function clearLinuxUinputHelper(helper: ChildProcessWithoutNullStreams): void {
  if (linuxUinputHelper !== helper) return;
  linuxUinputHelper = null;
  linuxUinputReady = false;
  linuxUinputStarting = null;
  linuxUinputLineBuffer = "";
  settleLinuxUinputResponse(false);
}

function handleLinuxUinputLine(line: string): void {
  if (line === "READY") {
    linuxUinputReady = true;
    return;
  }
  if (line === "OK") {
    settleLinuxUinputResponse(true);
    return;
  }
  if (line.startsWith("ERROR")) {
    log.warn(`Persistent uinput helper: ${line}`);
    settleLinuxUinputResponse(false);
  }
}

export function startLinuxPasteHelper(force = false): Promise<boolean> {
  if (process.platform !== "linux" || (!force && !isWaylandSession())) {
    return Promise.resolve(false);
  }
  if (linuxUinputHelper && linuxUinputReady) {
    return Promise.resolve(true);
  }
  if (linuxUinputStarting) return linuxUinputStarting;

  const binaryPath = getNativeBinaryPath("linux-fast-paste");
  if (!binaryPath) return Promise.resolve(false);

  linuxUinputStarting = new Promise<boolean>((resolve) => {
    const helper = spawn(binaryPath, ["--uinput-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    linuxUinputHelper = helper;
    let settled = false;
    let stderr = "";

    const settleStart = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(success);
    };

    const timeout = setTimeout(() => {
      log.warn("Persistent uinput helper timed out during startup");
      settleStart(false);
      helper.kill("SIGTERM");
    }, 2_000);

    helper.stdout.on("data", (data: Buffer) => {
      linuxUinputLineBuffer += data.toString();
      const lines = linuxUinputLineBuffer.split("\n");
      linuxUinputLineBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        handleLinuxUinputLine(line);
        if (line === "READY") {
          log.debug("Persistent uinput paste helper ready");
          settleStart(true);
        }
      }
    });

    helper.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    helper.on("error", (err) => {
      log.warn(`Persistent uinput helper error: ${err.message}`);
      settleStart(false);
      clearLinuxUinputHelper(helper);
    });

    helper.on("close", (code) => {
      if (stderr.trim()) {
        log.warn(`Persistent uinput helper failed: ${stderr.trim()}`);
      } else if (linuxUinputReady && code !== 0) {
        log.warn(`Persistent uinput helper exited with code ${code}`);
      }
      settleStart(false);
      clearLinuxUinputHelper(helper);
    });
  });

  return linuxUinputStarting;
}

export function stopLinuxPasteHelper(): void {
  const helper = linuxUinputHelper;
  if (!helper) return;
  clearLinuxUinputHelper(helper);
  if (!helper.stdin.writable) {
    helper.kill("SIGTERM");
    return;
  }

  helper.stdin.end("QUIT\n");
  const forceKill = setTimeout(() => helper.kill("SIGTERM"), 250);
  forceKill.unref();
  helper.once("close", () => clearTimeout(forceKill));
}

async function sendPersistentUinputPaste(
  isTerminal: boolean,
  force = false,
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    if (!(await startLinuxPasteHelper(force))) return false;
    const helper = linuxUinputHelper;
    if (!helper?.stdin.writable) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (linuxUinputPendingResponse === settle) {
          linuxUinputPendingResponse = null;
        }
        resolve(success);
      };
      const timeout = setTimeout(() => {
        log.warn("Persistent uinput helper timed out while pasting");
        settle(false);
        clearLinuxUinputHelper(helper);
        helper.kill("SIGTERM");
      }, 1_000);

      linuxUinputPendingResponse = settle;
      const command = isTerminal ? "PASTE_TERMINAL\n" : "PASTE\n";
      helper.stdin.write(command, (err) => {
        if (err) {
          settle(false);
          clearLinuxUinputHelper(helper);
          helper.kill("SIGTERM");
        }
      });
    });
  };

  const result = linuxUinputCommandChain.then(run, run);
  linuxUinputCommandChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function linuxPasteArgs(isTerminal: boolean): string[] {
  return isTerminal ? ["--terminal"] : [];
}

function portalTokenPath(): string {
  return join(app.getPath("userData"), "portal-restore-token");
}

function readPortalToken(): string | null {
  try {
    const token = readFileSync(portalTokenPath(), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function savePortalToken(token: string): void {
  try {
    writeFileSync(portalTokenPath(), token, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to persist portal restore token: ${message}`);
  }
}

function clearPortalToken(): void {
  try {
    unlinkSync(portalTokenPath());
  } catch {}
}

async function pasteLinuxPortal(isTerminal: boolean): Promise<boolean> {
  const binaryPath = getNativeBinaryPath("linux-fast-paste");
  if (!binaryPath) return false;

  const args = ["--portal", ...linuxPasteArgs(isTerminal)];
  const token = readPortalToken();
  if (token) args.push("--restore-token", token);

  try {
    const { code, stdout } = await execFileWithOutput(binaryPath, args, 15_000);
    if (code === 0) {
      const newToken = stdout.trim().split("\n").pop()?.trim();
      if (newToken) savePortalToken(newToken);
      return true;
    }
    if (token && (code === 2 || code === 3)) {
      clearPortalToken();
    }
    log.warn(`Portal paste failed (exit ${code})`);
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Portal paste error: ${message}`);
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Upper bound on waiting for the compositor to move focus off the pill. */
const FOCUS_RETURN_TIMEOUT_MS = 400;
const FOCUS_POLL_INTERVAL_MS = 20;

function isFreestyleWindow(window: {
  app?: string;
  wmClass?: string;
  gtkApplicationId?: string;
}): boolean {
  const fields = [window.wmClass, window.app, window.gtkApplicationId];
  return fields.some((value) => value && /freestyle/i.test(value));
}

/**
 * Wayland has no "never focus me" surface hint, so on some compositors
 * (notably GNOME) the dictation pill takes keyboard focus despite
 * `focusable: false` + `showInactive()`. Hiding it hands focus back
 * asynchronously — injecting the paste chord before that lands types into
 * nothing, which is why pastes appeared to vanish intermittently.
 *
 * Poll the FocusBridge until the focused window is no longer ours. Returns
 * immediately when focus is already elsewhere (the common case on
 * compositors that honor the hint), and gives up after a bounded wait so a
 * missing bridge only costs a short fixed delay.
 */
async function waitForFocusToLeavePill(): Promise<void> {
  const deadline = Date.now() + FOCUS_RETURN_TIMEOUT_MS;
  let sawBridge = false;

  while (Date.now() < deadline) {
    const focused = await queryFocusBridge();
    if (focused) {
      sawBridge = true;
      if (!isFreestyleWindow(focused)) return;
    } else if (sawBridge) {
      // The bridge answered before but reports nothing focused now; keep
      // waiting for the compositor to settle on the next window.
    } else {
      break;
    }
    await wait(FOCUS_POLL_INTERVAL_MS);
  }

  if (!sawBridge) {
    // No bridge to observe focus with: fall back to a fixed settle delay.
    await wait(FOCUS_POLL_INTERVAL_MS * 4);
  }
}

async function pasteLinux(isTerminal: boolean): Promise<PasteMethod> {
  const binaryPath = getNativeBinaryPath("linux-fast-paste");
  const wayland = isWaylandSession();

  if (wayland) {
    await waitForFocusToLeavePill();
    return pasteLinuxWayland(isTerminal);
  }

  if (binaryPath) {
    const exitCode = await execFileAsync(
      binaryPath,
      linuxPasteArgs(isTerminal),
    );
    if (exitCode === 0) {
      return "native";
    }
    log.warn(`Native paste failed (exit ${exitCode}), falling back to xdotool`);
  }

  try {
    await pasteLinuxLegacy(false, isTerminal);
    return "legacy";
  } catch (err) {
    log.warn("X11 paste backends failed, cross-trying Wayland backends");
    if (await sendPersistentUinputPaste(isTerminal, true)) return "native";
    if (await pasteLinuxPortal(isTerminal)) return "native";
    throw err;
  }
}

async function pasteLinuxWayland(isTerminal: boolean): Promise<PasteMethod> {
  if (await sendPersistentUinputPaste(isTerminal)) {
    return "native";
  }

  log.warn("Persistent uinput paste failed, trying RemoteDesktop portal");
  if (await pasteLinuxPortal(isTerminal)) {
    return "native";
  }

  log.warn("Portal paste failed, falling back to wtype");
  try {
    await pasteLinuxLegacy(true, isTerminal);
    return "legacy";
  } catch (err) {
    log.warn("Wayland paste backends failed, cross-trying X11 backends");
    const binary = getNativeBinaryPath("linux-fast-paste");
    if (binary) {
      const exitCode = await execFileAsync(binary, linuxPasteArgs(isTerminal));
      if (exitCode === 0) return "native";
    }
    try {
      await pasteLinuxLegacy(false, isTerminal);
      return "legacy";
    } catch {
      throw err;
    }
  }
}

async function pasteLinuxLegacy(
  wayland: boolean,
  isTerminal: boolean,
): Promise<void> {
  if (wayland) {
    const cmd = isTerminal
      ? "wtype -M ctrl -M shift -P v -p v -m shift -m ctrl"
      : "wtype -M ctrl -P v -p v -m ctrl";
    const pasted = await tryExecAsync(cmd, "wtype paste");
    if (!pasted) {
      throw new Error("No supported Wayland paste backend succeeded");
    }
  } else {
    const key = isTerminal ? "ctrl+shift+v" : "ctrl+v";
    await execAsync(`xdotool key ${key}`);
  }
}

const PASTE_SETTLE_MS: Record<string, number> = {
  darwin: 300,
  win32: 300,
  linux: 300,
};

const PASTE_SETTLE_LEGACY_MS: Record<string, number> = {
  darwin: 500,
  win32: 600,
  linux: 500,
};

function pasteSettleMs(method: PasteMethod): number {
  const override = Number(process.env.FREESTYLE_PASTE_SETTLE_MS);
  if (Number.isFinite(override) && override >= 0) return override;
  const table = method === "native" ? PASTE_SETTLE_MS : PASTE_SETTLE_LEGACY_MS;
  return table[process.platform] ?? 500;
}

const RESTORABLE_TEXT_FORMATS = new Set([
  "text/plain",
  "text/html",
  "text/rtf",
]);

type ClipboardSnapshot =
  | { restorable: false }
  | {
      restorable: true;
      text: string;
      html?: string;
      rtf?: string;
      image?: Electron.NativeImage;
    };

function snapshotClipboard(): ClipboardSnapshot {
  try {
    const formats = clipboard.availableFormats();
    const unknown = formats.filter(
      (f) => !RESTORABLE_TEXT_FORMATS.has(f) && !f.startsWith("image/"),
    );
    if (unknown.length > 0) {
      log.debug(
        `clipboard holds non-restorable formats (${unknown.join(", ")}); leaving transcript on clipboard after paste`,
      );
      return { restorable: false };
    }
    const hasImage = formats.some((f) => f.startsWith("image/"));
    return {
      restorable: true,
      text: clipboard.readText(),
      html: formats.includes("text/html") ? clipboard.readHTML() : undefined,
      rtf: formats.includes("text/rtf") ? clipboard.readRTF() : undefined,
      image: hasImage ? clipboard.readImage() : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to snapshot clipboard: ${message}`);
    return { restorable: false };
  }
}

function restoreClipboard(
  snapshot: ClipboardSnapshot,
  transcript: string,
): void {
  if (!snapshot.restorable) return;
  try {
    if (clipboard.readText() !== transcript) {
      log.debug("clipboard changed since paste; skipping restore");
      return;
    }
    const data: Electron.Data = { text: snapshot.text };
    if (snapshot.html !== undefined) data.html = snapshot.html;
    if (snapshot.rtf !== undefined) data.rtf = snapshot.rtf;
    if (snapshot.image && !snapshot.image.isEmpty()) {
      data.image = snapshot.image;
    }
    clipboard.write(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to restore clipboard: ${message}`);
  }
}

let pasteChain: Promise<void> = Promise.resolve();

export function pasteIntoFocusedApp(
  text: string,
  beforePaste?: () => Promise<void> | void,
): Promise<void> {
  const run = (): Promise<void> => doPasteIntoFocusedApp(text, beforePaste);
  const result = pasteChain.then(run, run);
  pasteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const WL_CLIPBOARD_TIMEOUT_MS = 1500;
const WL_VERIFY_DEADLINE_MS = 400;

function wlCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("wl-copy timed out"));
    }, WL_CLIPBOARD_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // wl-copy forks a child that keeps serving the selection; the parent
    // exits promptly once the offer is registered.
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`wl-copy exited ${code}`));
    });
    child.stdin.end(text);
  });
}

function wlPaste(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("wl-paste", ["--no-newline"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, WL_CLIPBOARD_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/**
 * Put the transcript on the WAYLAND clipboard and wait until the compositor
 * serves it back. Electron in the packaged AppImage runs via XWayland, and
 * its X11 clipboard writes were not reliably bridged to the Wayland
 * clipboard the target apps read — so every paste delivered stale clipboard
 * content instead of the transcript. Writing through wl-copy talks to the
 * compositor directly; the read-back verify closes any remaining
 * propagation race before the paste chord is injected.
 */
async function setWaylandClipboardVerified(text: string): Promise<boolean> {
  try {
    await wlCopy(text);
  } catch (err) {
    log.warn(`wl-copy failed, falling back to Electron clipboard: ${err}`);
    return false;
  }
  const deadline = Date.now() + WL_VERIFY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if ((await wlPaste()) === text) return true;
    await wait(20);
  }
  log.warn("wayland clipboard verify timed out; injecting anyway");
  return true;
}

async function restoreWaylandClipboard(
  prior: string | null,
  transcript: string,
): Promise<void> {
  if (prior === null) return;
  try {
    if ((await wlPaste()) !== transcript) return;
    await wlCopy(prior);
  } catch {
    // Best-effort: worst case the transcript stays on the clipboard.
  }
}

async function doPasteIntoFocusedApp(
  text: string,
  beforePaste?: () => Promise<void> | void,
): Promise<void> {
  // Apps we can insert into programmatically skip the clipboard and the
  // synthetic keystroke entirely. The check must run AFTER the pill is hidden
  // and focus has moved back: on GNOME the pill holds keyboard focus while
  // visible, so querying the bridge earlier reports Freestyle itself as the
  // focused window and the programmatic route never triggers.
  if (process.platform === "linux" && isWaylandSession() && text?.trim()) {
    await beforePaste?.();
    beforePaste = undefined;
    await waitForFocusToLeavePill();
    if (await tryEmacsInsert(text)) {
      log.debug("delivered via emacsclient");
      return;
    }
  }

  // Never log the transcript itself (it's persisted to the shared log file);
  // length is enough to diagnose paste issues.
  log.debug(`pasting ${text?.length ?? 0} chars`);
  if (!text?.trim()) return;

  text = `${text} `;

  const wayland = process.platform === "linux" && isWaylandSession();
  const prior = snapshotClipboard();
  let waylandPrior: string | null = null;
  if (wayland) {
    waylandPrior = await wlPaste();
    if (!(await setWaylandClipboardVerified(text))) {
      clipboard.writeText(text);
    }
  } else {
    clipboard.writeText(text);
  }

  let pasted = false;
  try {
    await beforePaste?.();

    let method: PasteMethod = "legacy";
    switch (process.platform) {
      case "darwin":
        method = await pasteMac();
        break;
      case "win32":
        method = await pasteWindows();
        break;
      default: {
        const isTerminal = await isLinuxTerminalFocused();
        if (isTerminal) {
          log.debug("focused app is a terminal, using Ctrl+Shift+V");
        }
        method = await pasteLinux(isTerminal);
        break;
      }
    }
    pasted = true;

    await new Promise((r) => setTimeout(r, pasteSettleMs(method)));
  } finally {
    // When every paste backend failed, the clipboard is the only copy of the
    // transcript the user still has — leave it there instead of restoring.
    if (pasted) {
      if (wayland) {
        await restoreWaylandClipboard(waylandPrior, text);
      } else {
        restoreClipboard(prior, text);
      }
    }
  }
}
