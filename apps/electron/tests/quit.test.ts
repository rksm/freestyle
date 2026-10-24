import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

test("quitApp shuts down the whole app", async () => {
  const app = await electron.launch({
    args: [resolve(__dirname, "../out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
      FREESTYLE_E2E: "1",
      FREESTYLE_USER_DATA: mkdtempSync(join(tmpdir(), "freestyle-quit-")),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    timeout: 30_000,
  });
  const proc = app.process();
  const exitCode = new Promise<number | null>((done) =>
    proc.once("exit", (code) => done(code)),
  );

  try {
    const pill = await app.firstWindow();
    // Wait until the main process has registered its IPC handlers.
    await pill.evaluate(() => window.api.getServerPort());
    await pill.evaluate(() => window.api.quitApp());
    expect(await exitCode).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
});
