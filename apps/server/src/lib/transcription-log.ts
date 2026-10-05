import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAppLogger } from "@freestyle-voice/utils";
import { parseAppContext } from "freestyle-voice";
import { readSetting } from "./db.js";
import type { RecognitionContext } from "./recognition-context.js";

const log = createAppLogger("transcription-log");

export const TRANSCRIPTION_DEBUG_LOG_SETTING = "transcription_debug_log";
const LOG_FILE = "transcriptions.jsonl";
/** One size-based rotation (file -> file.1) so the log cannot grow unbounded. */
const MAX_BYTES = 10 * 1024 * 1024;

export interface TranscriptionDebugEntry {
  source: "batch" | "streaming" | "multi_segment";
  raw: string;
  cleaned: string;
  /** Original per-recording context, reduced to the application name on disk. */
  appContext?: string | null;
  /**
   * The full resolved recognition context: merged bias terms plus the
   * cleanup block (exact spellings + excerpt) injected into the rewrite
   * prompt. Absent when no context was resolved for the dictation.
   */
  context?: RecognitionContext | null;
  timings: {
    contextMs?: number;
    sttMs?: number;
    handoffMs?: number;
    llmMs?: number;
    totalMs?: number;
  };
  voiceModel?: string;
  llmModel?: string | null;
}

function logPath(): string | null {
  const dbPath = process.env.FREESTYLE_DB_PATH;
  return dbPath ? join(dirname(dbPath), LOG_FILE) : null;
}

/**
 * Opt-in debugging aid: append one JSON line per dictation with the raw
 * transcript, the injected context (terms, spellings, excerpt), the cleanup
 * result, and stage timings.
 *
 * Off unless the `transcription_debug_log` setting is "true" — unlike the
 * normal logs this deliberately records captured desktop context CONTENT
 * (post-redaction), so it stays local, opt-in, and separate from
 * freestyle.log. Failures are swallowed: debugging must never break
 * dictation.
 */
export function logTranscriptionDebug(entry: TranscriptionDebugEntry): void {
  try {
    if (readSetting(TRANSCRIPTION_DEBUG_LOG_SETTING) !== "true") return;
    const path = logPath();
    if (!path) return;

    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // Missing file: nothing to rotate.
    }

    const { appContext, ...record } = entry;
    const parsedApp = parseAppContext(appContext);
    const app = parsedApp?.appName ?? parsedApp?.bundleId;
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...record,
        ...(app ? { app } : {}),
      })}\n`,
    );
  } catch (err) {
    log.warn(`failed to write transcription debug entry: ${err}`);
  }
}
