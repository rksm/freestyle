import { beforeEach, describe, expect, it, vi } from "vitest";

type Callback = (err: Error | null, stdout: string) => void;

const replies = new Map<string, string | Error>();
const execFile = vi.fn(
  (_file: string, args: string[], _opts: unknown, cb: Callback) => {
    const bus = args[args.indexOf("--dest") + 1];
    const reply = replies.get(bus) ?? new Error("no such bus name");
    if (reply instanceof Error) cb(reply, "");
    else cb(null, reply);
  },
);
vi.mock("node:child_process", () => ({ execFile }));

const { queryFocusBridge } = await import("./focus-bridge");

describe("queryFocusBridge", () => {
  beforeEach(() => {
    replies.clear();
    execFile.mockClear();
  });

  it("parses the gdbus string reply", async () => {
    replies.set(
      "com.freestyle.FocusBridge",
      `('{"wmClass":"org.wezfurlong.wezterm","title":"it\\'s fish","pid":42}',)\n`,
    );

    await expect(queryFocusBridge()).resolves.toEqual({
      wmClass: "org.wezfurlong.wezterm",
      title: "it's fish",
      pid: 42,
    });
  });

  it("falls back to the VibeTyper bridge when Freestyle's is absent", async () => {
    replies.set("com.vibetyper.FocusBridge", `('{"app":"emacs"}',)`);

    await expect(queryFocusBridge()).resolves.toEqual({ app: "emacs" });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("returns null when no bridge reports an identifiable window", async () => {
    replies.set("com.freestyle.FocusBridge", `('{}',)`);

    await expect(queryFocusBridge()).resolves.toBeNull();
  });
});
