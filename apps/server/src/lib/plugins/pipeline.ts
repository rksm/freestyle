import { createAppLogger } from "@freestyle-voice/utils";
import {
  type ContextSnapshot,
  parseContextSnapshot,
} from "@freestyle-voice/validations";
import {
  type AppContext,
  FreestyleEventType,
  type HookApi,
  type PipelineControlState,
  type PipelineStage,
  createHookApi as sdkCreateHookApi,
} from "freestyle-voice";
import {
  contextToAsr,
  contextToCleanup,
  isContextEnabled,
} from "../context-settings.js";
import {
  buildRecognitionContext,
  type RecognitionContext,
} from "../recognition-context.js";
import { plugins } from "./index.js";
import { buildPluginLlm } from "./llm.js";

const log = createAppLogger("plugins");

/**
 * Host deadline for `resolveRecognitionContext`. It is much shorter than the
 * registry's per-hook timeout (3 s), so this one is what bounds dictation.
 */
const RECOGNITION_CONTEXT_TIMEOUT_MS = 250;

/**
 * Build the {@link HookApi} for one server-side pipeline run (one dictation).
 * Reuse the same instance across every stage of that dictation
 * (`beforeTranscribe` → `afterTranscribe` → `beforeCleanup` → `afterCleanup`)
 * so `api.control` carries state between them — a plugin calling
 * `api.control.consume()` in `afterTranscribe` should be visible to the route
 * handler when it checks `api.control.state` before running cleanup.
 *
 * Building the LLM capability resolves the configured chat model once per
 * request; failures (no key, unsupported provider) degrade to `llm: undefined`
 * rather than failing the whole request.
 */
export async function createHookApi(): Promise<HookApi> {
  const llm = await buildPluginLlm();
  return sdkCreateHookApi({ llm });
}

/**
 * Dispatch `resolveRecognitionContext` with a hard deadline so desktop
 * collectors can never delay recognition. The hook gets a fresh API whose
 * control state is discarded: context collection cannot consume or abort the
 * dictation. A timed-out run may finish in the background, but its output is
 * no longer observed.
 */
export async function resolveRecognitionContextSnapshot(input: {
  providerId: string;
  modelId: string;
  streaming: boolean;
  appContext?: AppContext;
}): Promise<ContextSnapshot | undefined> {
  const registry = plugins();
  if (!registry.has("resolveRecognitionContext") || !isContextEnabled()) {
    return undefined;
  }

  const startedAt = Date.now();
  const api = await createHookApi();
  const timedOut = Symbol("recognition-context-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), RECOGNITION_CONTEXT_TIMEOUT_MS);
  });
  const output = await Promise.race([
    registry.run(
      "resolveRecognitionContext",
      input,
      { snapshot: undefined },
      api,
    ),
    deadline,
  ]).finally(() => clearTimeout(timer));
  const elapsedMs = Date.now() - startedAt;

  if (output === timedOut) {
    log.warn(`recognition context timed out duration_ms=${elapsedMs}`);
    return undefined;
  }

  // Plugin output is untrusted: re-validate and bound it.
  const snapshot = parseContextSnapshot(output.snapshot) ?? undefined;
  log.info(
    `recognition context resolved duration_ms=${elapsedMs} snapshot=${snapshot !== undefined} symbol_count=${snapshot?.editor?.symbols?.length ?? 0} buffer_count=${snapshot?.editor?.openBuffers?.length ?? 0}`,
  );
  return snapshot;
}

/**
 * Resolve the one {@link RecognitionContext} a dictation uses for both ASR
 * bias and cleanup. `pluginTerms` (from `beforeTranscribe`) augment the
 * persistent vocabulary.
 */
export async function resolveRecognitionContext(
  input: Parameters<typeof resolveRecognitionContextSnapshot>[0] & {
    pluginTerms?: string[];
  },
): Promise<RecognitionContext> {
  const { pluginTerms, ...hookInput } = input;
  return buildRecognitionContext({
    snapshot: await resolveRecognitionContextSnapshot(hookInput),
    pluginTerms,
    contextToAsr: contextToAsr(),
    contextToCleanup: contextToCleanup(),
  });
}

/**
 * A {@link HookApi} for the `beforeOutput` stage, which the SDK contract says
 * never receives the LLM capability. Skips resolving a chat model (the work
 * {@link createHookApi} does) since it would only be discarded.
 */
export function createOutputHookApi(): HookApi {
  return sdkCreateHookApi();
}

/** Response-facing disposition, derived from a dictation's control state. */
export type Disposition = "deliver" | "suppressed" | "aborted";

/** Map a terminal {@link PipelineControlState} to the response disposition. */
export function dispositionFromControl(
  state: PipelineControlState,
): Disposition {
  if (state === "consumed") return "suppressed";
  if (state === "aborted") return "aborted";
  return "deliver";
}

/**
 * Emit a `pipelineError` event when a plugin aborted the dictation, so the
 * documented `abort()` semantics ("the host reports a `pipelineError` event
 * with `reason`") hold on every terminal path. No-op unless aborted.
 */
export function emitAbortEvent(api: HookApi, stage: PipelineStage): void {
  if (api.control.state !== "aborted") return;
  void plugins().emit({
    type: FreestyleEventType.PipelineError,
    stage,
    message: api.control.reason ?? "aborted",
  });
}
