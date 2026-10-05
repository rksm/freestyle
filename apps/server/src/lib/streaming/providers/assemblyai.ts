import { Buffer } from "node:buffer";
import WebSocket from "ws";
import { createPendingAudio } from "../pending-audio.js";
import type {
  StreamingSessionOptions,
  StreamSession,
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { CLOUD_TRANSCRIBE_TIMEOUT_MS, stripProviderPrefix } from "../types.js";

const STREAMING_URL = "wss://streaming.assemblyai.com/v3/ws";
const SYNC_URL = "https://sync.assemblyai.com/v1/transcribe";
/** The only model the Sync API documents; it serves every model id. */
const SYNC_MODEL = "universal-3-5-pro";
/** Termination arrived 0.5-1.1 s after Terminate in live tests. */
const COMMIT_TIMEOUT_MS = 5_000;
/**
 * AssemblyAI bills an open session by wall-clock time, idle or not. Audio
 * flows for the whole recording, so silence on the socket means a leaked
 * session; let the server end it.
 */
const INACTIVITY_TIMEOUT_SECONDS = "30";

/** `language_codes` accepted by Universal-3.6 Pro; others fail the session. */
const PRO_LANGUAGES = new Set(
  (
    "af ar yue ca da nl en et fi fr gl de he hi it ja " +
    "ko zh mr no nn fa pt ro ru es sv tr ur vi xh zu"
  ).split(" "),
);

function keyterms(bias: TranscribeOptions["bias"]): string[] | undefined {
  return bias?.kind === "assemblyai-keyterms" ? bias.terms : undefined;
}

export class AssemblyAITranscriptionProvider implements TranscriptionProvider {
  readonly providerId = "assemblyai";

  /**
   * Batch uses Sync STT: one HTTP call for clips up to 120 s. In live tests it
   * returned the same text as the Dictation API in about half the time (about
   * 280 ms against 520 ms), and the Dictation API's LLM rewrite duplicates our
   * own cleanup. Longer audio fails with the API's `audio_too_large` error.
   */
  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const english =
      stripProviderPrefix(opts.model) === "universal-streaming-english";
    const language = english ? "en" : opts.language;
    const config: Record<string, unknown> = {};
    if (language) config.language_codes = [language];
    const terms = keyterms(opts.bias);
    if (terms) config.keyterms_prompt = terms;

    const form = new FormData();
    form.append(
      "config",
      new Blob([JSON.stringify(config)], { type: "application/json" }),
    );
    form.append(
      "audio",
      new Blob([Buffer.from(opts.audio)], { type: "audio/wav" }),
      "audio.wav",
    );
    const res = await fetch(SYNC_URL, {
      method: "POST",
      headers: { Authorization: opts.apiKey, "X-AAI-Model": SYNC_MODEL },
      body: form,
      signal: AbortSignal.timeout(CLOUD_TRANSCRIBE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `AssemblyAI transcription failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const data = (await res.json()) as {
      text?: string;
      audio_duration_ms?: number;
    };
    return {
      text: data.text?.trim() ?? "",
      durationInSeconds:
        data.audio_duration_ms === undefined
          ? undefined
          : data.audio_duration_ms / 1000,
    };
  }

  supportsStreaming(_modelId: string): boolean {
    return true;
  }

  /**
   * One session per recording, ended with Terminate. Terminate finalizes the
   * open turn, and Termination is always the last message, so it is a
   * definitive end of the transcript. ForceEndpoint on a warm session would
   * finish sooner, but it may get no reply when no turn is open (the Deepgram
   * Finalize trap), and a warm session is billed while it idles. Live tests
   * put Termination 0.5-1.1 s after Terminate, the last Turn at 0.1 s.
   * `session-policy.ts` marks the provider as ephemeral to match.
   */
  openStreamingSession(opts: StreamingSessionOptions): StreamSession {
    const { apiKey, model, languages, bias, callbacks } = opts;
    const speechModel = stripProviderPrefix(model);

    const params = new URLSearchParams({
      speech_model: speechModel,
      encoding: "pcm_s16le",
      sample_rate: "16000",
      inactivity_timeout: INACTIVITY_TIMEOUT_SECONDS,
    });
    // Universal-Streaming sends unformatted turns unless asked; Pro always
    // formats. Only Pro takes `language_codes`: the English model is English
    // only, and the multilingual model detects its six languages per turn.
    // No model translates, so `translate` is ignored.
    if (speechModel.startsWith("universal-streaming")) {
      params.set("format_turns", "true");
    } else {
      const codes = (languages ?? []).filter((l) => PRO_LANGUAGES.has(l));
      if (codes.length > 0) params.set("language_codes", JSON.stringify(codes));
    }
    const terms = keyterms(bias);
    if (terms) params.set("keyterms_prompt", JSON.stringify(terms));

    const ws = new WebSocket(`${STREAMING_URL}?${params}`, {
      headers: { Authorization: apiKey },
    });
    const pending = createPendingAudio();
    /** Latest transcript per `turn_order`; a later message replaces an earlier one. */
    const turns = new Map<number, string>();
    let commitRequested = false;
    let finalDelivered = false;
    let closing = false;
    let errorMessage: string | null = null;
    let commitTimeout: ReturnType<typeof setTimeout> | null = null;

    function text(): string {
      return [...turns.values()].join(" ").trim();
    }

    function deliverFinal(): void {
      if (finalDelivered) return;
      finalDelivered = true;
      if (commitTimeout) clearTimeout(commitTimeout);
      callbacks.onFinal(text());
    }

    function terminate(): void {
      ws.send(JSON.stringify({ type: "Terminate" }));
    }

    ws.on("open", () => {
      pending.flush((chunk) => ws.send(chunk));
      if (commitRequested) terminate();
      callbacks.onReady(speechModel);
    });

    ws.on("message", (raw) => {
      let msg: {
        type?: string;
        turn_order?: number;
        transcript?: string;
        error?: string;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (
        msg.type === "Turn" &&
        msg.transcript &&
        msg.turn_order !== undefined
      ) {
        turns.set(msg.turn_order, msg.transcript);
        if (!commitRequested) callbacks.onPartial(text());
      } else if (msg.type === "Termination" && commitRequested) {
        deliverFinal();
      } else if (msg.type === "Error") {
        // The close frame that follows carries only a truncated reason.
        errorMessage = msg.error ?? null;
      }
    });

    ws.on("error", (err) => {
      callbacks.onError(err instanceof Error ? err.message : String(err));
    });

    ws.on("close", (code, reason) => {
      // After a commit, any close settles the dictation with what has
      // arrived. Before one, a close other than 1000 (bad key, rejected
      // parameter, inactivity) is an error the route falls back on.
      if (commitRequested) {
        deliverFinal();
      } else if (!closing && code !== 1000) {
        callbacks.onError(
          `AssemblyAI closed the session (${code}): ${errorMessage ?? reason.toString()}`,
        );
      }
      callbacks.onClose();
    });

    return {
      sendAudio(chunk: ArrayBuffer): void {
        if (commitRequested) return;
        if (ws.readyState === WebSocket.CONNECTING) {
          pending.hold(chunk);
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      },
      commit(): void {
        if (commitRequested) return;
        commitRequested = true;
        commitTimeout = setTimeout(deliverFinal, COMMIT_TIMEOUT_MS);
        if (ws.readyState === WebSocket.CONNECTING) return;
        if (ws.readyState === WebSocket.OPEN) terminate();
        else deliverFinal();
      },
      cancel(): void {
        // The route closes per-recording sessions on cancel; this only drops
        // the transcript in case a caller keeps the session.
        pending.clear();
        turns.clear();
      },
      close(): void {
        closing = true;
        if (commitTimeout) clearTimeout(commitTimeout);
        if (ws.readyState <= WebSocket.OPEN) ws.close();
      },
    };
  }
}
