import { describe, expect, it } from "vitest";
import {
  applyNeedsAppContextForCleanup,
  getNeedsAppContextForCleanup,
} from "./cleanup-app-context";

const cleanupOff = {
  llm_cleanup: "false",
  cleanup_personal_tone: "off",
  cleanup_work_tone: "off",
  cleanup_email_tone: "off",
  cleanup_overall_tone: "off",
};

describe("applyNeedsAppContextForCleanup", () => {
  it("captures the app by default: context collection is on when unset", () => {
    expect(applyNeedsAppContextForCleanup(cleanupOff)).toBe(true);
    expect(getNeedsAppContextForCleanup()).toBe(true);
  });

  it("skips the app when context is off and cleanup does not route by app", () => {
    const settings = { ...cleanupOff, context_enabled: "false" };

    expect(applyNeedsAppContextForCleanup(settings)).toBe(false);
    expect(getNeedsAppContextForCleanup()).toBe(false);
  });

  it("still captures the app for cleanup routing when context is off", () => {
    const settings = {
      ...cleanupOff,
      context_enabled: "false",
      llm_cleanup: "true",
      cleanup_overall_tone: "professional",
    };

    expect(applyNeedsAppContextForCleanup(settings)).toBe(true);
  });
});
