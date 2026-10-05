import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "linux")(
  "Linux input disconnection",
  () => {
    let directory: string;
    let binary: string;

    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), "freestyle-input-test-"));
      binary = join(directory, "listener");
      writeFileSync(join(directory, "event0"), "");
      writeFileSync(join(directory, "event1"), "");
      execFileSync("gcc", [
        "-O2",
        "tests/native/linux-key-listener-disconnect.c",
        "-o",
        binary,
      ]);
    });

    afterAll(() => {
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    // Linux poll.h: POLLERR=8, POLLHUP=16, POLLNVAL=32, POLLIN=1.
    it.each([
      8,
      16,
      32,
      8 | 16 | 1,
    ])("retires the device and releases held keys for poll flags %i", (flags) => {
      for (const mode of ["Alt+Super+M", "--record"]) {
        const output = execFileSync(binary, [mode], {
          env: {
            ...process.env,
            TEST_INPUT_DIR: directory,
            TEST_POLL_FLAGS: String(flags),
          },
          encoding: "utf8",
          timeout: 2000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        expect(output).toBe(
          mode === "--record" ? "READY\nRECORD_RELEASE\n" : "READY\nKEY_UP\n",
        );
      }
    });
  },
);
