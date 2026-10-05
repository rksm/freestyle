import {
  areAllCleanupTonesOff,
  parseCleanupEmailTone,
  parseCleanupOverallTone,
  parseCleanupPersonalTone,
  parseCleanupWorkTone,
} from "@freestyle-voice/validations";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";
import { getClient } from "./api";

let cachedNeedsAppContext: boolean | null = null;

/**
 * Synchronously read the last-derived "should we capture the frontmost app?"
 * decision without touching the network. Returns `true` conservatively until
 * the cache has been primed (from a settings snapshot at mount or a
 * `cleanup-context-changed` refresh), so context is never silently skipped on
 * a cold cache.
 */
export function getNeedsAppContextForCleanup(): boolean {
  return cachedNeedsAppContext ?? true;
}

/**
 * Derive (and cache) whether we should capture the frontmost app, for context
 * collection or for cleanup destination routing, from an already-loaded
 * settings snapshot. Lets callers that have just fetched `/api/settings` avoid
 * a second round-trip. Context collection is on unless its setting is
 * "false"; cleanup routing needs the app only when cleanup tones are active.
 */
export function applyNeedsAppContextForCleanup(
  settings: Record<string, string>,
): boolean {
  const cleanupNeedsAppContext =
    settings[SETTINGS_KEYS.llmCleanup] === "true" &&
    !areAllCleanupTonesOff({
      personalTone: parseCleanupPersonalTone(
        settings[SETTINGS_KEYS.cleanupPersonalTone],
      ),
      workTone: parseCleanupWorkTone(settings[SETTINGS_KEYS.cleanupWorkTone]),
      emailTone: parseCleanupEmailTone(
        settings[SETTINGS_KEYS.cleanupEmailTone],
      ),
      overallTone: parseCleanupOverallTone(
        settings[SETTINGS_KEYS.cleanupOverallTone],
      ),
    });
  const contextEnabled = settings.context_enabled !== "false";

  cachedNeedsAppContext = contextEnabled || cleanupNeedsAppContext;
  return cachedNeedsAppContext;
}

/**
 * Re-read server settings and cache whether we should capture the frontmost
 * app.
 */
export async function refreshNeedsAppContextForCleanup(): Promise<boolean> {
  try {
    const res = await getClient().api.settings.$get();
    if (!res.ok) {
      return cachedNeedsAppContext ?? true;
    }

    return applyNeedsAppContextForCleanup(await res.json());
  } catch {
    return cachedNeedsAppContext ?? true;
  }
}
