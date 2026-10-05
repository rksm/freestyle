import { readFileSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Callback = (err: Error | null, stdout: string) => void;

let emacsReply = "5";
let inserted: { path: string; text: string; mode: number } | null = null;
const execFile = vi.fn(
  (_file: string, args: string[], _opts: unknown, cb: Callback) => {
    // The Elisp side reads the temp file named in the expression.
    const path = /"(.+)"/.exec(args[args.indexOf("--eval") + 1])?.[1] ?? "";
    inserted = {
      path,
      text: readFileSync(path, "utf8"),
      mode: statSync(path).mode & 0o777,
    };
    cb(null, `${emacsReply}\n`);
  },
);
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("@freestyle-voice/utils", () => ({
  createAppLogger: () => ({ debug: vi.fn() }),
}));
const queryFocusBridge = vi.fn();
vi.mock("./focus-bridge", () => ({ queryFocusBridge }));

const { tryEmacsInsert } = await import("./emacs-insert");

describe("tryEmacsInsert", () => {
  beforeEach(() => {
    emacsReply = "5";
    inserted = null;
    execFile.mockClear();
  });

  it("hands the text to Emacs through a private temp file", async () => {
    queryFocusBridge.mockResolvedValue({ wmClass: "Emacs" });

    await expect(tryEmacsInsert(`say "hi"\n`)).resolves.toBe(true);

    expect(inserted?.text).toBe(`say "hi"\n`);
    expect(inserted?.mode).toBe(0o600);
    // The temp dir is removed even when Emacs does not delete the file.
    expect(() => statSync(inserted?.path ?? "")).toThrow();
  });

  it("reports a refusal (nil, e.g. a read-only buffer) so the caller can paste", async () => {
    queryFocusBridge.mockResolvedValue({ wmClass: "Emacs" });
    emacsReply = "nil";

    await expect(tryEmacsInsert("hi")).resolves.toBe(false);
  });

  it("does not call emacsclient when another app is focused", async () => {
    queryFocusBridge.mockResolvedValue({ wmClass: "gedit" });

    await expect(tryEmacsInsert("hi")).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
});
