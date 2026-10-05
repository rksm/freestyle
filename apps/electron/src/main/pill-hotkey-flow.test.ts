import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

// index.ts cannot be imported under vitest (it starts the app), so these
// tests pin the ordering rules in its source.
function sourceForFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const nextFunction = source.slice(start + 1).search(/\n(?:async )?function /);
  const end = nextFunction === -1 ? -1 : start + 1 + nextFunction;
  return source.slice(start, end === -1 ? undefined : end);
}

describe("pill hotkey flow", () => {
  it("captures the frontmost app before the pill shows and sends it with hotkey:down", async () => {
    const source = await readFile(mainPath, "utf8");
    const down = sourceForFunction(source, "sendHotkeyDown");

    expect(down).toContain("getFrontmostApp()");
    expect(down.indexOf("getFrontmostApp()")).toBeLessThan(
      down.indexOf("showPill()"),
    );
    expect(down).toContain('send("hotkey:down", appContext)');
  });

  it("skips the probe while the pill is already visible", async () => {
    const source = await readFile(mainPath, "utf8");
    const down = sourceForFunction(source, "sendHotkeyDown");

    expect(down).toContain("mainWindow?.isVisible()");
    expect(down.indexOf("mainWindow?.isVisible()")).toBeLessThan(
      down.indexOf("getFrontmostApp()"),
    );
  });

  it("keeps hotkey:down and hotkey:up on one queue so down arrives first", async () => {
    const source = await readFile(mainPath, "utf8");

    expect(sourceForFunction(source, "sendHotkeyDown")).toContain(
      "enqueueHotkeyIpc(",
    );
    expect(sourceForFunction(source, "sendHotkeyUp")).toContain(
      "enqueueHotkeyIpc(",
    );
  });

  it("aborts the output session on Escape and passes its signal to delivery", async () => {
    const source = await readFile(mainPath, "utf8");

    expect(sourceForFunction(source, "cancelActivePill")).toContain(
      "pillOutputAbort.abort()",
    );
    expect(sourceForFunction(source, "deliverOutput")).toContain("{ signal }");
  });
});
