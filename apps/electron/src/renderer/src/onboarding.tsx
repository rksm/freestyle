import { apiKeySchema } from "@freestyle-voice/validations";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyComboDisplay } from "@renderer/components/key-combo";
import { ModelSetupPanel } from "@renderer/components/model-setup-panel";
import { TutorialDemo } from "@renderer/components/tutorial-demo";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { RevealToggle } from "@renderer/components/ui/reveal-toggle";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { VoiceRow } from "@renderer/components/voice-row";
import {
  comboDisplayKeys,
  formatAcceleratorKeys,
  keyDisplayLabel,
  useHotkeyRecorder,
} from "@renderer/hooks/use-hotkey-recorder";
import { getClient } from "@renderer/lib/api";
import { defaultLanguage, ONBOARDING_LANGUAGES } from "@renderer/lib/languages";
import {
  type AvailableModel,
  buildVoiceItems,
  type MlxAsrStatus,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_KEY_URLS,
  type VoiceItem,
  type WhisperStatus,
} from "@renderer/lib/models";
import { requestMicAccess, resolveMicStatus } from "@renderer/lib/permissions";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@renderer/lib/platform";
import { settingsQueryOptions } from "@renderer/lib/query";
import { cn, ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ClipboardPaste,
  HardDrive,
  Key,
  Keyboard,
  Loader2,
  Mic,
  Shield,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { getDefaultHotkey } from "../../shared/hotkey-defaults";
import { SETTINGS_KEYS } from "../../shared/settings-keys";

type Step = "permissions" | "language" | "tutorial";

const DEFAULT_HOTKEY =
  (typeof window !== "undefined" && window.api?.defaultHotkey) ||
  getDefaultHotkey();

// Linux system-setup state reported by the main process (input-group access
// for the hotkey listener, xdotool/wtype for the paste fallback).
type LinuxSetup = {
  wayland: boolean;
  inputAccess: boolean;
  uinputAccess: boolean;
  pasteToolRequired: string;
  pasteTool: string | null;
};

// The opinionated on-device pick, in order of preference. Qwen3 ASR (MLX)
// is the hero when the machine can run it; whisper.cpp's Balanced model is
// the universal fallback (it builds its own binary, no Python required).
// It is selected while the user picks a language and a hotkey, so first-time
// users never need to choose a model.
const RECOMMENDED_MLX_DEF = "qwen3-0.6b-8bit";
const RECOMMENDED_WHISPER_DEF = "small-q5_1";

/** True while any local model is downloading or verifying. */
function hasActiveDownload(
  models: { status: string }[] | undefined | null,
): boolean {
  return !!models?.some(
    (m) => m.status === "downloading" || m.status === "verifying",
  );
}

export default function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("permissions");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Permissions state
  const [micStatus, setMicStatus] = useState<string>("unknown");
  const [accessibilityStatus, setAccessibilityStatus] = useState(false);
  const [linuxSetup, setLinuxSetup] = useState<LinuxSetup | null>(null);

  // Voice model state
  const [available, setAvailable] = useState<AvailableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<AvailableModel | null>(
    null,
  );
  const [selectedWhisperDefId, setSelectedWhisperDefId] = useState<
    string | null
  >(null);
  const [selectedMlxDefId, setSelectedMlxDefId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<Set<string>>(new Set());
  const [language, setLanguage] = useState<string>(defaultLanguage);
  const autoPicked = useRef(false);
  const warmed = useRef(false);
  // Tracks the most recent explicit local pick so the setup panel follows it.
  const lastLocalSetupRef = useRef<{
    defId: string;
    engine: "whisper" | "mlx";
  } | null>(null);
  // Full model selector overlay (cloud + everything else)
  const [showSelector, setShowSelector] = useState(false);
  const [selectorSource, setSelectorSource] = useState<"cloud" | "local">(
    "cloud",
  );
  const apiKeyForm = useForm<{ provider: string; key: string }>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: { provider: "", key: "" },
  });
  const [showKey, setShowKey] = useState(false);

  // Hotkey recorder state (tutorial step)
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);

  const handleHotkeyRecorded = useCallback((accelerator: string) => {
    setHotkey(accelerator);
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.hotkey },
        json: { value: accelerator },
      })
      .catch(() => {});
  }, []);

  const {
    state: recorderState,
    liveModifiers,
    capturedCombo,
    canSaveRecording,
    needsModifierOrMouseButton,
    startRecording: startHotkeyRecording,
    cancelRecording: cancelHotkeyRecording,
  } = useHotkeyRecorder(handleHotkeyRecorded);

  const liveKeys = liveModifiers.map(keyDisplayLabel);
  const draftKeys = capturedCombo ? comboDisplayKeys(capturedCombo) : liveKeys;
  const captureHint = needsModifierOrMouseButton
    ? "Add a modifier or side mouse button · Esc to cancel"
    : canSaveRecording
      ? "Release to save · Esc to cancel"
      : "Press a modifier or side mouse button… · Esc to cancel";

  // Load permissions
  useEffect(() => {
    resolveMicStatus()
      .then(setMicStatus)
      .catch(() => {});
    window.api
      ?.checkAccessibilityPermission()
      .then(setAccessibilityStatus)
      .catch(() => {});
    if (IS_LINUX) {
      window.api
        ?.checkLinuxSetup()
        .then((setup) => setup && setLinuxSetup(setup))
        .catch(() => {});
    }
  }, []);

  // Saved hotkey, read from the shared settings cache (deduped with every other
  // settings consumer instead of a dedicated GET /api/settings/:key).
  const { data: settingsData } = useQuery(settingsQueryOptions());
  useEffect(() => {
    const value = settingsData?.[SETTINGS_KEYS.hotkey];
    if (value) setHotkey(value);
  }, [settingsData]);

  useEffect(() => {
    return window.api?.onFullscreenChanged(setIsFullscreen);
  }, []);

  // Load models + keys
  useEffect(() => {
    const client = getClient();
    client.api.models.available
      .$get()
      .then((r) => (r.ok ? r.json() : []))
      .then((models: AvailableModel[]) => setAvailable(models))
      .catch(() => {});
    client.api.keys
      .$get()
      .then((r) => (r.ok ? r.json() : []))
      .then((keys: { provider: string }[]) =>
        setApiKeys(new Set(keys.map((k) => k.provider))),
      )
      .catch(() => {});
  }, []);

  // Whisper / MLX status via React Query. refetchInterval replaces the manual
  // 500ms setInterval polling: it polls only while a download/verify is active
  // and stops automatically once everything settles.
  const whisperQuery = useQuery({
    queryKey: ["whisper-status"],
    queryFn: async () => {
      const res = await getClient().api.whisper.status.$get();
      if (!res.ok) throw new Error("Failed to load whisper status");
      return (await res.json()) as WhisperStatus;
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.binaryDownloading || hasActiveDownload(d.models))
        ? 500
        : false;
    },
    staleTime: 0,
  });

  const mlxQuery = useQuery({
    queryKey: ["mlx-status"],
    enabled: IS_MAC,
    queryFn: async () => {
      const res = await getClient().api["mlx-asr"].status.$get();
      if (!res.ok) throw new Error("Failed to load MLX ASR status");
      return (await res.json()) as MlxAsrStatus;
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && hasActiveDownload(d.models) ? 500 : false;
    },
    staleTime: 0,
  });

  const whisperStatus = whisperQuery.data ?? null;
  const mlxStatus = mlxQuery.data ?? null;
  // True once we know whether MLX can run — the auto-pick waits for the
  // Qwen-vs-Whisper decision instead of settling on Whisper Base while the MLX
  // probe is in flight. Non-Mac has nothing to wait for.
  const mlxResolved = !IS_MAC || mlxQuery.isFetched;

  const requestMic = useCallback(async () => {
    const status = await requestMicAccess();
    if (status) setMicStatus(status);
  }, []);

  const recheckLinuxSetup = useCallback(async () => {
    const setup = await window.api?.checkLinuxSetup();
    if (setup) setLinuxSetup(setup);
  }, []);

  const openMicSettings = useCallback(() => {
    window.api?.openMicSettings();
    const interval = setInterval(async () => {
      const mic = await window.api?.checkMicPermission();
      if (mic === "granted") {
        setMicStatus("granted");
        clearInterval(interval);
      }
    }, 1000);
    setTimeout(() => clearInterval(interval), 30000);
  }, []);

  const openAccessibility = useCallback(() => {
    window.api?.openAccessibilitySettings();
    const interval = setInterval(async () => {
      const ok = await window.api?.checkAccessibilityPermission();
      if (ok) {
        setAccessibilityStatus(true);
        clearInterval(interval);
      }
    }, 1000);
    setTimeout(() => clearInterval(interval), 30000);
  }, []);

  // Commit a model as the default. Selection in this flow IS commitment —
  // there is no separate "save" step anymore.
  const commitCloudModel = useCallback((model: AvailableModel) => {
    getClient()
      .api.models.configured.$post({
        json: {
          provider: model.provider_id,
          model_id: model.model_id,
          model_name: model.model_name,
          type: "voice",
          is_default: true,
        },
      })
      .catch(() => {});
  }, []);

  const selectCloudModel = useCallback(
    (model: AvailableModel) => {
      setSelectedModel(model);
      setSelectedWhisperDefId(null);
      setSelectedMlxDefId(null);
      if (apiKeys.has(model.provider_id)) {
        commitCloudModel(model);
      } else {
        // Reset the key form so the key-entry view opens empty for a
        // provider we don't have a key for yet; commit happens on key save.
        apiKeyForm.reset({ provider: model.provider_id, key: "" });
      }
    },
    [apiKeys, apiKeyForm, commitCloudModel],
  );

  const selectLocalModel = useCallback(
    (
      defId: string,
      name: string,
      engine?: "whisper" | "mlx",
      makeDefault = true,
    ) => {
      if (makeDefault) {
        if (engine === "mlx") {
          setSelectedMlxDefId(defId);
          setSelectedWhisperDefId(null);
        } else if (engine === "whisper") {
          setSelectedWhisperDefId(defId);
          setSelectedMlxDefId(null);
        }
        if (engine) {
          lastLocalSetupRef.current = { defId, engine };
        }
        setSelectedModel(null);
      }
      const provider = engine === "mlx" ? "local-mlx" : "local-whisper";
      getClient()
        .api.models.configured.$post({
          json: {
            provider,
            model_id: `${provider}/${defId}`,
            model_name: name,
            type: "voice",
            is_default: makeDefault,
          },
        })
        .catch(() => {});
    },
    [],
  );

  const downloadWhisperModel = useCallback(
    async (modelId: string) => {
      await getClient().api.whisper.models[":model"].download.$post({
        param: { model: modelId },
      });
      void queryClient.invalidateQueries({ queryKey: ["whisper-status"] });
    },
    [queryClient],
  );

  const downloadMlxModel = useCallback(
    async (modelId: string) => {
      await getClient().api["mlx-asr"].models[":model"].download.$post({
        param: { model: modelId },
      });
      void queryClient.invalidateQueries({ queryKey: ["mlx-status"] });
    },
    [queryClient],
  );

  const downloadLocalModel = useCallback(
    (modelId: string, engine?: "whisper" | "mlx") => {
      if (engine === "mlx") {
        void downloadMlxModel(modelId);
        return;
      }
      void downloadWhisperModel(modelId);
    },
    [downloadMlxModel, downloadWhisperModel],
  );

  const allVoiceItems = buildVoiceItems(available, whisperStatus, mlxStatus, {
    selectedModelId: selectedModel?.model_id,
    selectedProvider:
      selectedModel?.provider_id ??
      (selectedWhisperDefId
        ? "local-whisper"
        : selectedMlxDefId
          ? "local-mlx"
          : undefined),
    selectedWhisperModelId: selectedWhisperDefId ?? undefined,
    selectedMlxModelId: selectedMlxDefId ?? undefined,
    keyProviders: apiKeys,
  });

  // Resolve the opinionated recommendation: Qwen3 on-device when MLX can run,
  // otherwise whisper.cpp Base (universal).
  const mlxQwen = allVoiceItems.find(
    (v) => v.localEngine === "mlx" && v.defId === RECOMMENDED_MLX_DEF,
  );
  const whisperBase = allVoiceItems.find(
    (v) => v.localEngine === "whisper" && v.defId === RECOMMENDED_WHISPER_DEF,
  );
  const recommended: VoiceItem | undefined =
    mlxQwen && mlxStatus?.canRun ? mlxQwen : (whisperBase ?? mlxQwen);

  // Auto-setup: once the MLX capability check settles, commit the recommended
  // local model. The download starts from the setup panel when the user asks.
  useEffect(() => {
    if (
      autoPicked.current ||
      !mlxResolved ||
      !recommended?.defId ||
      !recommended.localEngine
    )
      return;
    autoPicked.current = true;
    lastLocalSetupRef.current = {
      defId: recommended.defId,
      engine: recommended.localEngine,
    };
    selectLocalModel(
      recommended.defId,
      recommended.name,
      recommended.localEngine,
      true,
    );
  }, [recommended, selectLocalModel, mlxResolved]);

  // Pre-warm the local engine the moment its download lands, so the first
  // dictation in the tutorial is fast.
  const warmTarget = allVoiceItems.find((v) => v.selected) ?? recommended;
  useEffect(() => {
    if (
      warmed.current ||
      warmTarget?.kind !== "local" ||
      warmTarget.status !== "ready" ||
      !warmTarget.defId
    )
      return;
    warmed.current = true;
    if (warmTarget.localEngine === "mlx") {
      getClient()
        .api["mlx-asr"].server.start.$post({
          json: { modelId: warmTarget.defId },
        })
        .catch(() => {});
    } else {
      getClient()
        .api.whisper.server.start.$post({ json: { modelId: warmTarget.defId } })
        .catch(() => {});
    }
  }, [warmTarget]);

  // The model the card reflects: whatever is currently selected, falling
  // back to the recommendation before the user has touched anything.
  const chosen = allVoiceItems.find((v) => v.selected) ?? recommended;

  // Persist the language choice (the transcribe path reads it per request).
  const persistLanguage = useCallback((value: string) => {
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.language },
        json: { value },
      })
      .catch(() => {});
  }, []);

  const saveLanguage = useCallback(
    (value: string) => {
      setLanguage(value);
      persistLanguage(value);
    },
    [persistLanguage],
  );

  // Validate + persist a freshly entered cloud key. Returns true when stored
  // so the selector can commit and close.
  const saveCloudKey = useCallback(async () => {
    const valid = await apiKeyForm.trigger();
    if (!valid) return false;
    const { provider, key } = apiKeyForm.getValues();
    if (!key.trim()) return false;
    await getClient()
      .api.keys.$post({ json: { provider, key: key.trim() } })
      .catch(() => {});
    setApiKeys((prev) => new Set([...prev, provider]));
    if (selectedModel) commitCloudModel(selectedModel);
    return true;
  }, [apiKeyForm, selectedModel, commitCloudModel]);

  const finishSetup = useCallback(() => {
    window.api?.setOnboardingComplete();
    navigate("/today", { replace: true });
  }, [navigate]);

  // Whether the chosen voice model is ready to use (downloaded / has a key).
  const chosenReady =
    !!chosen &&
    (chosen.kind === "cloud" ? !!chosen.hasKey : chosen.status === "ready");

  const localSetupModel = ((): VoiceItem | undefined => {
    if (chosen?.kind === "local") return chosen;
    if (lastLocalSetupRef.current) {
      const { defId, engine } = lastLocalSetupRef.current;
      return allVoiceItems.find(
        (v) =>
          v.kind === "local" && v.defId === defId && v.localEngine === engine,
      );
    }
    return recommended;
  })();
  const mustHaveLocalReady = chosen?.kind === "local" && !chosenReady;
  const localSetupActive =
    localSetupModel?.kind === "local" &&
    (localSetupModel.status === "downloading" ||
      localSetupModel.status === "verifying" ||
      localSetupModel.state?.phase === "building_binary");

  const startLocalDownload = useCallback(() => {
    if (!localSetupModel?.defId || window.api?.isE2E) return;
    downloadLocalModel(localSetupModel.defId, localSetupModel.localEngine);
  }, [localSetupModel, downloadLocalModel]);

  const retryLocalDownload = useCallback(() => {
    if (!localSetupModel?.defId || window.api?.isE2E) return;
    downloadLocalModel(localSetupModel.defId, localSetupModel.localEngine);
  }, [localSetupModel, downloadLocalModel]);

  return (
    <div className="glass-window-shell glass-content flex h-screen flex-col">
      {!isFullscreen && (
        <div
          className="h-9 shrink-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
      )}

      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 py-8"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {step === "permissions" && (
          <PermissionsStep
            micStatus={micStatus}
            accessibilityStatus={accessibilityStatus}
            linuxSetup={linuxSetup}
            onRequestMic={requestMic}
            onOpenMicSettings={openMicSettings}
            onOpenAccessibility={openAccessibility}
            onRecheckLinuxSetup={recheckLinuxSetup}
            onContinue={() => setStep("language")}
          />
        )}

        {step === "language" && (
          <LanguageStep
            language={language}
            onSelect={saveLanguage}
            localModel={localSetupModel}
            onDownloadLocal={startLocalDownload}
            onRetryLocal={retryLocalDownload}
            onBack={() => setStep("permissions")}
            onContinue={() => {
              // Persist even when the pre-selected locale was never clicked.
              persistLanguage(language);
              setStep("tutorial");
            }}
          />
        )}

        {step === "tutorial" && (
          <TutorialStep
            hotkey={hotkey}
            recorderState={recorderState}
            draftKeys={draftKeys}
            captureHint={captureHint}
            modelReady={chosenReady}
            localModel={localSetupModel}
            onDownloadLocal={startLocalDownload}
            onRetryLocal={retryLocalDownload}
            canFinish={!mustHaveLocalReady}
            finishBlockedReason={
              mustHaveLocalReady
                ? localSetupActive
                  ? "downloading"
                  : "notReady"
                : null
            }
            onStartRecording={startHotkeyRecording}
            onCancelRecording={cancelHotkeyRecording}
            onBack={() => setStep("language")}
            onFinish={finishSetup}
          />
        )}
      </div>

      {showSelector && (
        <ModelSelectorOverlay
          source={selectorSource}
          onSourceChange={setSelectorSource}
          voiceItems={allVoiceItems}
          keyProviders={apiKeys}
          selectedCloud={selectedModel}
          apiKeyForm={apiKeyForm}
          showKey={showKey}
          onToggleShowKey={() => setShowKey((v) => !v)}
          onSelectCloud={selectCloudModel}
          onSelectLocal={selectLocalModel}
          onDownload={downloadLocalModel}
          onRetryLocal={(defId, engine) => {
            if (engine === "mlx") {
              // Force a fresh MLX capability probe, prime the cache, then
              // download only if the machine can actually run it.
              void (async () => {
                const res = await getClient()
                  .api["mlx-asr"].status.$get({ query: { refresh: "1" } })
                  .catch(() => null);
                if (!res?.ok) return;
                const data = (await res.json()) as MlxAsrStatus;
                queryClient.setQueryData(["mlx-status"], data);
                if (data.canRun) void downloadMlxModel(defId);
              })();
            } else {
              downloadWhisperModel(defId);
            }
          }}
          onClose={() => setShowSelector(false)}
          onSaveKey={saveCloudKey}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Permissions
// ---------------------------------------------------------------------------
function PermissionsStep({
  micStatus,
  accessibilityStatus,
  linuxSetup,
  onRequestMic,
  onOpenMicSettings,
  onOpenAccessibility,
  onRecheckLinuxSetup,
  onContinue,
}: {
  micStatus: string;
  accessibilityStatus: boolean;
  linuxSetup: LinuxSetup | null;
  onRequestMic: () => void;
  onOpenMicSettings: () => void;
  onOpenAccessibility: () => void;
  onRecheckLinuxSetup: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const micGranted = micStatus === "granted";
  // On Wayland there is no hotkey fallback without /dev/input access, so
  // missing input access blocks. On X11 the Electron globalShortcut still
  // works (toggle mode), so the card only warns.
  const linuxBlocked = !!linuxSetup?.wayland && !linuxSetup.inputAccess;
  // Accessibility is macOS-only; elsewhere the mic alone unblocks.
  const allGranted =
    micGranted && (!IS_MAC || accessibilityStatus) && !linuxBlocked;
  // macOS and Windows can deep-link to the OS mic privacy settings.
  const canOpenMicSettings = IS_MAC || IS_WINDOWS;

  return (
    <div className="w-full max-w-[440px]">
      <div className="flex flex-col gap-2.5">
        <PermCard
          icon={Mic}
          title={t("onboarding.permissions.microphone.title")}
          desc={t("onboarding.permissions.microphone.desc")}
          granted={micGranted}
          action={
            micStatus === "denied" && canOpenMicSettings ? (
              <PermButton onClick={onOpenMicSettings}>
                {t("common.openSettings")}
              </PermButton>
            ) : (
              <PermButton onClick={onRequestMic}>
                {t("common.allow")}
              </PermButton>
            )
          }
        />

        {IS_MAC && (
          <PermCard
            icon={Shield}
            title={t("onboarding.permissions.accessibility.title")}
            desc={t("onboarding.permissions.accessibility.desc")}
            granted={accessibilityStatus}
            action={
              <PermButton onClick={onOpenAccessibility}>
                {t("common.openSettings")}
              </PermButton>
            }
          />
        )}

        {IS_LINUX && linuxSetup && (
          <PermCard
            icon={Keyboard}
            title={t("onboarding.permissions.keyboardAccess.title")}
            desc={
              linuxSetup.inputAccess ? (
                t("onboarding.permissions.keyboardAccess.descGranted")
              ) : (
                <>
                  <Trans
                    i18nKey="onboarding.permissions.keyboardAccess.descDenied"
                    components={{ code: <code className="text-foreground" /> }}
                  />
                  {!linuxSetup.wayland &&
                    t("onboarding.permissions.keyboardAccess.toggleNote")}
                </>
              )
            }
            granted={linuxSetup.inputAccess}
            action={
              <PermButton onClick={onRecheckLinuxSetup}>
                {t("common.recheck")}
              </PermButton>
            }
          />
        )}

        {IS_LINUX &&
          linuxSetup &&
          !linuxSetup.pasteTool &&
          !(linuxSetup.wayland && linuxSetup.uinputAccess) && (
            <PermCard
              icon={ClipboardPaste}
              title={t("onboarding.permissions.pasteTool.title")}
              desc={
                <Trans
                  i18nKey="onboarding.permissions.pasteTool.desc"
                  values={{ tool: linuxSetup.pasteToolRequired }}
                  components={{ code: <code className="text-foreground" /> }}
                />
              }
              granted={false}
              action={
                <PermButton onClick={onRecheckLinuxSetup}>
                  {t("common.recheck")}
                </PermButton>
              }
            />
          )}
      </div>

      <div className="mt-7 flex items-center justify-end gap-3.5">
        <div className="flex items-center gap-3.5">
          {!allGranted && (
            <span className="mono text-muted-foreground text-[10.5px] tracking-[0.1em] uppercase">
              {IS_MAC
                ? t("onboarding.permissions.grantBoth")
                : t("onboarding.permissions.grantAccess")}
            </span>
          )}
          <Button variant="ink" disabled={!allGranted} onClick={onContinue}>
            {t("common.continue")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermCard({
  icon: Icon,
  title,
  desc,
  granted,
  action,
}: {
  icon: typeof Mic;
  title: string;
  desc: React.ReactNode;
  granted: boolean;
  action: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border bg-card flex items-center gap-3.5 rounded-[12px] border p-4">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border",
          granted
            ? "bg-accent border-primary/20"
            : "bg-background border-border",
        )}
      >
        <Icon
          size={16}
          className={
            granted ? "text-accent-foreground" : "text-muted-foreground"
          }
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-[14px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
          {desc}
        </div>
      </div>
      {granted ? (
        <span className="mono text-accent-foreground inline-flex items-center gap-1.5 text-[10.5px] tracking-[0.14em] uppercase">
          <Check size={13} strokeWidth={2.2} />
          {t("common.granted")}
        </span>
      ) : (
        action
      )}
    </div>
  );
}

function PermButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button variant="ink" size="sm" onClick={onClick} className="shrink-0">
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Language (the model sets itself up in the background)
// ---------------------------------------------------------------------------
function LanguageStep({
  language,
  onSelect,
  localModel,
  onDownloadLocal,
  onRetryLocal,
  onBack,
  onContinue,
}: {
  language: string;
  onSelect: (id: string) => void;
  localModel: VoiceItem | undefined;
  onDownloadLocal: () => void;
  onRetryLocal: () => void;
  onBack: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-[560px]">
      <h1 className="serif text-foreground m-0 mb-7 text-center text-[56px] leading-[0.95] font-normal tracking-[-0.025em]">
        <span>{t("onboarding.language.titlePrefix")}</span>
        <span className="serif-italic text-primary">
          {t("onboarding.language.titleEmphasis")}
        </span>
      </h1>

      <div className="flex flex-wrap justify-center gap-2">
        {ONBOARDING_LANGUAGES.map((l) => (
          <Button
            key={l.id}
            variant={language === l.id ? "default" : "outline"}
            size="sm"
            onClick={() => onSelect(l.id)}
            className="rounded-full px-4 text-[13.5px]"
          >
            {l.nativeLabel}
          </Button>
        ))}
        <Button
          variant={language === "auto" ? "default" : "outline"}
          size="sm"
          onClick={() => onSelect("auto")}
          className="rounded-full px-4 text-[13.5px]"
        >
          {t("onboarding.language.autoDetect")}
        </Button>
      </div>

      <ModelSetupPanel
        model={localModel}
        onDownload={onDownloadLocal}
        onRetry={onRetryLocal}
      />

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button variant="ink" onClick={onContinue}>
          {t("common.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full model selector — opened from the model step as an option. Two views:
//   "list" — browse cloud / on-device models, pick one
//   "key"  — a focused, full-width API-key entry for a cloud pick that needs
//            one (no more burying the input at the bottom of a scroll area)
// ---------------------------------------------------------------------------
function ModelSelectorOverlay({
  source,
  onSourceChange,
  voiceItems,
  keyProviders,
  selectedCloud,
  apiKeyForm,
  showKey,
  onToggleShowKey,
  onSelectCloud,
  onSelectLocal,
  onDownload,
  onRetryLocal,
  onClose,
  onSaveKey,
}: {
  source: "cloud" | "local";
  onSourceChange: (s: "cloud" | "local") => void;
  voiceItems: VoiceItem[];
  keyProviders: Set<string>;
  selectedCloud: AvailableModel | null;
  apiKeyForm: ReturnType<typeof useForm<{ provider: string; key: string }>>;
  showKey: boolean;
  onToggleShowKey: () => void;
  onSelectCloud: (m: AvailableModel) => void;
  onSelectLocal: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => void;
  onDownload: (defId: string, engine?: "whisper" | "mlx") => void;
  onRetryLocal: (defId: string, engine: "whisper" | "mlx") => void;
  onClose: () => void;
  onSaveKey: () => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<"list" | "key">("list");
  const [savingKey, setSavingKey] = useState(false);

  const items = voiceItems.filter((v) =>
    source === "local" ? v.kind === "local" : v.kind === "cloud",
  );

  // Pick a cloud model: commit immediately when its key is already stored,
  // otherwise move into the focused key-entry view.
  const handleSelectCloud = (model: AvailableModel) => {
    onSelectCloud(model);
    if (keyProviders.has(model.provider_id)) {
      onClose();
    } else {
      setView("key");
    }
  };

  // Picking a ready on-device model commits straight away.
  const handleSelectLocal = (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => {
    onSelectLocal(defId, name, engine);
    onClose();
  };

  const handleSaveKey = async () => {
    setSavingKey(true);
    try {
      const ok = await onSaveKey();
      if (ok) onClose();
    } finally {
      setSavingKey(false);
    }
  };

  const providerName = selectedCloud
    ? (PROVIDER_DISPLAY_NAMES[selectedCloud.provider_id] ??
      selectedCloud.provider_id)
    : "";
  const keyValue = apiKeyForm.watch("key") ?? "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          // Esc steps back from key entry to the list before closing.
          if (view === "key") {
            e.preventDefault();
            setView("list");
          }
        }}
        className="flex max-h-[calc(100vh-5rem)] w-full max-w-[600px] flex-col gap-0 overflow-hidden rounded-[16px] border-border bg-background p-0 sm:max-w-[600px]"
      >
        <DialogTitle className="sr-only">Choose a voice model</DialogTitle>
        {view === "list" ? (
          <>
            {/* Header */}
            <div className="border-border/60 flex shrink-0 items-center justify-between border-b px-[22px] py-[18px]">
              <div>
                <div className="mono text-muted-foreground text-[10px] tracking-[0.16em] uppercase">
                  {t("onboarding.modelSelector.chooseModel")}
                </div>
                <div className="serif text-foreground mt-0.5 text-[26px] leading-[1.05]">
                  {t("onboarding.modelSelector.allVoiceModels")}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                aria-label="Close"
              >
                <X />
              </Button>
            </div>

            {/* Source toggle */}
            <div className="flex shrink-0 justify-center pt-4">
              <SegmentedControl
                size="sm"
                value={source}
                onValueChange={(v) => onSourceChange(v as "cloud" | "local")}
                options={[
                  {
                    value: "cloud",
                    label: t("onboarding.modelSelector.cloudApi"),
                  },
                  {
                    value: "local",
                    label: t("onboarding.modelSelector.onDevice"),
                    icon: HardDrive,
                  },
                ]}
              />
            </div>

            {/* List */}
            <div className="overflow-y-auto px-[22px] py-4 [scrollbar-gutter:stable]">
              <div className="border-border overflow-hidden rounded-[14px] border">
                {items.length === 0 && (
                  <div className="flex items-center gap-2 px-5 py-6">
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                    <span className="text-muted-foreground text-sm">
                      {t("onboarding.modelSelector.loading")}
                    </span>
                  </div>
                )}
                {items.map((item, i) => (
                  <VoiceRow
                    key={item.key}
                    item={item}
                    first={i === 0}
                    onSelectCloud={handleSelectCloud}
                    onSelectLocal={handleSelectLocal}
                    onDownload={onDownload}
                    onRetryLocal={onRetryLocal}
                  />
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="border-border/60 flex shrink-0 items-center justify-between border-t px-[22px] py-4">
              <span className="text-muted-foreground text-[11.5px]">
                {source === "cloud"
                  ? t("onboarding.modelSelector.cloudNote")
                  : t("onboarding.modelSelector.onDeviceNote", {
                      phrase: ON_DEVICE_PHRASE,
                    })}
              </span>
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Key-entry header */}
            <div className="border-border/60 flex shrink-0 items-center gap-3 border-b px-[22px] py-[18px]">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setView("list")}
                aria-label={t("onboarding.modelSelector.backToModels")}
              >
                <ChevronLeft />
              </Button>
              <div>
                <div className="mono text-muted-foreground text-[10px] tracking-[0.16em] uppercase">
                  {t("onboarding.modelSelector.connect", {
                    provider: providerName,
                  })}
                </div>
                <div className="serif text-foreground mt-0.5 text-[26px] leading-[1.05]">
                  {t("onboarding.modelSelector.addKey", {
                    provider: providerName,
                  })}
                </div>
              </div>
            </div>

            {/* Key-entry body — the input is the whole view */}
            <div className="px-[22px] py-7">
              {selectedCloud && (
                <p className="text-muted-foreground mb-4 text-[13px] leading-relaxed">
                  {t("onboarding.modelSelector.requiredFor", {
                    model: selectedCloud.model_name,
                  })}
                </p>
              )}

              <InputGroup className="h-10">
                <InputGroupInput
                  autoFocus
                  type={showKey ? "text" : "password"}
                  {...apiKeyForm.register("key")}
                  placeholder={t("onboarding.modelSelector.keyPlaceholder")}
                  aria-invalid={!!apiKeyForm.formState.errors.key}
                  className="font-mono text-[14px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && keyValue.trim()) handleSaveKey();
                  }}
                />
                <InputGroupAddon>
                  <Key />
                </InputGroupAddon>
                <RevealToggle
                  revealed={showKey}
                  onToggle={onToggleShowKey}
                  label="key"
                />
              </InputGroup>
              {apiKeyForm.formState.errors.key && (
                <p className="text-destructive mt-2 text-[12px]">
                  {apiKeyForm.formState.errors.key.message}
                </p>
              )}
              {selectedCloud &&
                PROVIDER_KEY_URLS[selectedCloud.provider_id] && (
                  <p className="mt-3 text-[12.5px]">
                    <a
                      href={PROVIDER_KEY_URLS[selectedCloud.provider_id]}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      {t("onboarding.modelSelector.getKey", {
                        provider: providerName,
                      })}
                    </a>
                  </p>
                )}
            </div>

            {/* Key-entry footer */}
            <div className="border-border/60 flex shrink-0 items-center justify-between border-t px-[22px] py-4">
              <Button variant="outline" onClick={() => setView("list")}>
                {t("common.back")}
              </Button>
              <Button
                variant="ink"
                onClick={handleSaveKey}
                disabled={!keyValue.trim() || savingKey}
              >
                {savingKey ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Check data-icon="inline-start" />
                )}
                {savingKey
                  ? t("common.saving")
                  : t("onboarding.modelSelector.saveKey", {
                      provider: providerName,
                    })}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — How to use (live tutorial + hotkey rebind)
// ---------------------------------------------------------------------------
function TutorialStep({
  hotkey,
  recorderState,
  draftKeys,
  captureHint,
  modelReady,
  localModel,
  onDownloadLocal,
  onRetryLocal,
  canFinish,
  finishBlockedReason,
  onStartRecording,
  onCancelRecording,
  onBack,
  onFinish,
}: {
  hotkey: string;
  recorderState: string;
  draftKeys: string[];
  captureHint: string;
  modelReady: boolean;
  localModel: VoiceItem | undefined;
  onDownloadLocal: () => void;
  onRetryLocal: () => void;
  canFinish: boolean;
  finishBlockedReason: "downloading" | "notReady" | null;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onBack: () => void;
  onFinish: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-[600px]">
      <TutorialDemo hotkey={hotkey} interactive={modelReady} />

      <ModelSetupPanel
        model={localModel}
        onDownload={onDownloadLocal}
        onRetry={onRetryLocal}
      />

      {/* Hotkey rebind — a single minimal control */}
      <div className="mt-5 flex justify-center">
        {recorderState === "idle" ? (
          <Button
            variant="outline"
            onClick={onStartRecording}
            className="bg-card hover:bg-secondary h-auto gap-3 rounded-[10px] px-3.5 py-2.5"
          >
            <Keyboard className="text-muted-foreground shrink-0" />
            <KeyComboDisplay keys={formatAcceleratorKeys(hotkey)} />
            <span className="text-muted-foreground ml-1 text-[12.5px]">
              {t("common.change")}
            </span>
          </Button>
        ) : (
          <div className="border-primary bg-accent inline-flex items-center gap-3 rounded-[10px] border px-3.5 py-2.5">
            <Keyboard className="text-accent-foreground h-4 w-4 shrink-0" />
            {draftKeys.length > 0 ? (
              <KeyComboDisplay keys={draftKeys} variant="dim" />
            ) : null}
            <span className="text-accent-foreground text-[12px]">
              {captureHint}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={onCancelRecording}
              className="ml-1"
            >
              {t("common.cancel")}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-7 flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <div className="flex flex-col items-end gap-1.5">
          {!canFinish && finishBlockedReason && (
            <p className="text-muted-foreground text-[11px]">
              {finishBlockedReason === "downloading"
                ? t("onboarding.modelSetup.waitingWhileDownloading")
                : t("onboarding.modelSetup.waitingToFinish")}
            </p>
          )}
          <Button variant="default" onClick={onFinish} disabled={!canFinish}>
            {t("onboarding.tutorial.finish")}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}
