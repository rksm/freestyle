import { readSetting } from "./db.js";

export const CONTEXT_ENABLED_SETTING = "context_enabled";
export const CONTEXT_TO_ASR_SETTING = "context_to_asr";
export const CONTEXT_TO_CLEANUP_SETTING = "context_to_cleanup";
export const CONTEXT_SOURCE_WINDOW_SETTING = "context_source_window";
export const CONTEXT_SOURCE_TERMINAL_SETTING = "context_source_terminal";
export const CONTEXT_SOURCE_EDITOR_SETTING = "context_source_editor";

function settingDefaultsToEnabled(key: string): boolean {
  return readSetting(key) !== "false";
}

export function isContextEnabled(): boolean {
  return settingDefaultsToEnabled(CONTEXT_ENABLED_SETTING);
}

export function contextToAsr(): boolean {
  return settingDefaultsToEnabled(CONTEXT_TO_ASR_SETTING);
}

export function contextToCleanup(): boolean {
  return settingDefaultsToEnabled(CONTEXT_TO_CLEANUP_SETTING);
}
