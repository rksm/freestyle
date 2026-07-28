import { beforeEach, describe, expect, it } from "vitest";
import {
  contextToAsr,
  contextToCleanup,
  isContextEnabled,
} from "../src/lib/context-settings.js";
import { deleteSetting } from "../src/lib/db.js";
import settings from "../src/routes/settings.js";

const coreKeys = ["context_enabled", "context_to_asr", "context_to_cleanup"];
const sourceKeys = [
  "context_source_window",
  "context_source_terminal",
  "context_source_editor",
];
const keys = [...coreKeys, ...sourceKeys];

describe("context settings", () => {
  beforeEach(() => {
    for (const key of keys) deleteSetting(key);
  });

  it("defaults every switch to enabled when absent", () => {
    expect(isContextEnabled()).toBe(true);
    expect(contextToAsr()).toBe(true);
    expect(contextToCleanup()).toBe(true);
  });

  it.each([
    ["context_enabled", isContextEnabled],
    ["context_to_asr", contextToAsr],
    ["context_to_cleanup", contextToCleanup],
  ] as const)("accepts and reads %s", async (key, read) => {
    const response = await settings.request(`/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "false" }),
    });

    expect(response.status).toBe(200);
    expect(read()).toBe(false);
    const all = (await (await settings.request("/")).json()) as Record<
      string,
      string
    >;
    expect(all[key]).toBe("false");
  });

  it.each(sourceKeys)("accepts plugin source switch %s", async (key) => {
    const response = await settings.request(`/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "false" }),
    });

    expect(response.status).toBe(200);
  });

  it.each(keys)("rejects invalid boolean value for %s", async (key) => {
    const response = await settings.request(`/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });

    expect(response.status).toBe(400);
  });
});
