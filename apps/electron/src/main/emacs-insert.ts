import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppLogger } from "@freestyle-voice/utils";
import { queryFocusBridge } from "./focus-bridge.js";

const log = createAppLogger("emacs-insert");

const EMACSCLIENT_TIMEOUT_MS = 2000;

/**
 * Programmatic delivery into Emacs, used instead of the clipboard + synthetic
 * keystroke path.
 *
 * Emacs binds no paste command to C-v (that scrolls), and the generic path
 * also depends on the compositor handing focus back before the chord is
 * injected. `emacsclient` needs neither: it inserts at point in the window the
 * user is looking at, leaves the clipboard untouched, and reports whether it
 * worked.
 *
 * Requires `(server-start)` and `freestyle-context.el` loaded in the user's
 * Emacs (see integrations/emacs/README.md). Every failure returns false so the
 * caller falls back to its keystroke path.
 */

function isEmacsFocused(window: {
  app?: string;
  wmClass?: string;
  gtkApplicationId?: string;
}): boolean {
  const wmClass = window.wmClass?.toLowerCase();
  if (wmClass === "emacs") return true;
  if (window.gtkApplicationId?.toLowerCase() === "org.gnu.emacs") return true;
  return window.app?.toLowerCase() === "emacs";
}

function evalInEmacs(expression: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "emacsclient",
      ["--timeout", "1", "--eval", expression],
      { encoding: "utf8", timeout: EMACSCLIENT_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

/**
 * Insert `text` into the focused Emacs frame. Returns false when Emacs is not
 * the focused window, the server is unreachable, or the buffer refused the
 * insert (e.g. read-only) — the caller then uses its normal paste path.
 */
export async function tryEmacsInsert(text: string): Promise<boolean> {
  if (process.platform !== "linux" || !text) return false;

  const focused = await queryFocusBridge();
  if (!focused || !isEmacsFocused(focused)) return false;

  // The text travels through a file so no shell or Elisp string quoting can
  // corrupt it; the Elisp side deletes the file once it has read it.
  const dir = mkdtempSync(join(tmpdir(), "freestyle-insert-"));
  const path = join(dir, "text");
  try {
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    const result = await evalInEmacs(
      `(freestyle-insert-file ${JSON.stringify(path)})`,
    );
    // The Elisp function returns the inserted length, or nil on refusal.
    const inserted = result !== "nil" && Number.parseInt(result, 10) > 0;
    if (!inserted) {
      log.debug(`emacsclient declined the insert (returned ${result})`);
    }
    return inserted;
  } catch (err) {
    log.debug(`emacsclient insert failed: ${err}`);
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
