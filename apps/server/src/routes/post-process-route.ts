import { postProcessSchema } from "@freestyle-voice/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { contextToAsr, contextToCleanup } from "../lib/context-settings.js";
import {
  FreestyleCloudAuthError,
  FreestyleCloudUsageError,
} from "../lib/freestyle-cloud.js";
import { getLanguageSetting } from "../lib/language.js";
import { PipelineStage, parseAppContext } from "../lib/plugins/index.js";
import {
  createHookApi,
  dispositionFromControl,
  emitAbortEvent,
  resolveRecognitionContextSnapshot,
} from "../lib/plugins/pipeline.js";
import { postProcess } from "../lib/post-process.js";
import { getDefaultModels } from "../lib/providers.js";
import { buildRecognitionContext } from "../lib/recognition-context.js";
import { invalidateSession } from "../lib/sessions.js";
import { logTranscriptionDebug } from "../lib/transcription-log.js";

const postProcessRoute = new Hono().post(
  "/",
  zValidator("json", postProcessSchema),
  async (c) => {
    const body = c.req.valid("json");

    const appContext: string | null = body.appContext ?? null;
    const language = body.language ?? getLanguageSetting();
    const api = await createHookApi();
    const voice = getDefaultModels().voice;
    const parsedAppContext = parseAppContext(appContext);
    const snapshot = voice
      ? await resolveRecognitionContextSnapshot({
          providerId: voice.provider,
          modelId: voice.model_id,
          streaming: false,
          ...(parsedAppContext ? { appContext: parsedAppContext } : {}),
        })
      : undefined;
    const recognitionContext = buildRecognitionContext({
      snapshot,
      contextToAsr: contextToAsr(),
      contextToCleanup: contextToCleanup(),
    });

    let pp: Awaited<ReturnType<typeof postProcess>>;
    try {
      pp = await postProcess(body.text, appContext, {
        language,
        source: "multi_segment",
        recognitionContext: recognitionContext.cleanup,
        includeTimings: true,
        api,
      });
    } catch (err) {
      if (err instanceof FreestyleCloudAuthError) {
        invalidateSession();
        return c.json({ error: "cloud_auth_required" }, 401);
      }
      if (err instanceof FreestyleCloudUsageError) {
        return c.json({ error: "usage_exceeded", resetsAt: err.resetsAt }, 429);
      }
      throw err;
    }

    logTranscriptionDebug({
      source: "multi_segment",
      raw: body.text,
      cleaned: pp.cleaned,
      context: recognitionContext,
      timings: {
        ...(pp.timings
          ? { handoffMs: pp.timings.handoffMs, llmMs: pp.timings.llmMs }
          : {}),
      },
      ...(voice ? { voiceModel: voice.model_id } : {}),
      llmModel: pp.llmModel,
    });

    // `beforeCleanup`/`afterCleanup` can consume/abort during the multi-segment
    // merge too; surface the disposition (blanking the text when terminal) and
    // emit the abort event, so the renderer suppresses delivery just like the
    // single-segment `/transcribe` path.
    const suppressed = api.control.state !== "running";
    emitAbortEvent(api, PipelineStage.Cleanup);
    return c.json({
      cleaned: suppressed ? "" : pp.cleaned,
      inputTokens: pp.inputTokens,
      outputTokens: pp.outputTokens,
      costUsd: pp.costUsd,
      disposition: dispositionFromControl(api.control.state),
      ...(api.control.reason ? { reason: api.control.reason } : {}),
    });
  },
);

export default postProcessRoute;
