import { spawnSync } from "node:child_process";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("../src/lib/db.js", () => ({
  closeDb: vi.fn(),
  readSetting: vi.fn(() => "true"),
}));

import { logTranscriptionDebug } from "../src/lib/transcription-log.js";

const formatter = fileURLToPath(
  new URL("../../../scripts/format-transcription-log.mjs", import.meta.url),
);

describe("transcription debug log", () => {
  beforeEach(() => {
    vi.mocked(appendFileSync).mockReset();
    vi.mocked(renameSync).mockReset();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("missing");
    });
    process.env.FREESTYLE_DB_PATH = "/tmp/freestyle-test/freestyle.db";
  });

  afterEach(() => {
    delete process.env.FREESTYLE_DB_PATH;
  });

  it("records only the target application from app context", () => {
    logTranscriptionDebug({
      source: "streaming",
      raw: "raw transcript",
      cleaned: "cleaned transcript",
      appContext: JSON.stringify({
        app: "Firefox",
        title: "Private window title",
        url: "https://example.test/private",
      }),
      timings: { totalMs: 42 },
    });

    const line = vi.mocked(appendFileSync).mock.calls[0]?.[1];
    expect(typeof line).toBe("string");
    const entry = JSON.parse(String(line));
    expect(entry).toMatchObject({
      source: "streaming",
      app: "Firefox",
      raw: "raw transcript",
    });
    expect(entry).not.toHaveProperty("appContext");
    expect(String(line)).not.toContain("Private window title");
    expect(String(line)).not.toContain("example.test");
  });

  it("shows the target application in formatted logs", () => {
    const result = spawnSync(process.execPath, [formatter], {
      encoding: "utf8",
      input: `${JSON.stringify({
        ts: "2026-07-29T12:34:56.000Z",
        source: "streaming",
        app: "Firefox",
        raw: "hello",
        cleaned: "hello",
        timings: {},
      })}\n`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("streaming  Firefox");
  });
});
