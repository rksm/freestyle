import { Button } from "@renderer/components/ui/button";
import { Skeleton } from "@renderer/components/ui/skeleton";
import type { AvailableModel } from "@renderer/lib/models";
import { cn, ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import {
  CheckCircle,
  Key,
  Loader2,
  Pencil,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { MlxWarmingDialog } from "./mlx-memory-section";
import { ConfirmDialog, type ModalState, ModelModal } from "./model-modal";
import { Eyebrow, PageShell } from "./page-chrome";
import { PairCard } from "./pair-card";
import type { ApiKeyEntry, ConfiguredModel } from "./types";
import { useModels } from "./use-models";
import { displayName } from "./utils";

export default function ModelsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const m = useModels();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [pendingLocalDelete, setPendingLocalDelete] = useState<{
    defId: string;
    engine?: "whisper" | "mlx";
    name: string;
  } | null>(null);
  const [pendingProviderDelete, setPendingProviderDelete] = useState<
    string | null
  >(null);
  const [warmingOpen, setWarmingOpen] = useState(false);

  // -------------------------------------------------------------------------
  // Modal flow
  // -------------------------------------------------------------------------

  const closeModal = (): void => {
    setModal(null);
    setKeyError(null);
    setSaving(false);
  };

  const configureVoice = (
    model: AvailableModel,
    { closeAfter = false }: { closeAfter?: boolean } = {},
  ): void => {
    const needsKey =
      model.provider_id !== "local-llm" &&
      !m.keyProviders.has(model.provider_id);
    if (needsKey) {
      setKeyError(null);
      setModal({
        kind: "key",
        type: "voice",
        provider: model.provider_id,
        modelName: model.model_name,
        pendingModel: model,
      });
      return;
    }
    void m.configureModel(model, "voice").then(() => {
      if (closeAfter) closeModal();
    });
  };

  const openVoice = (): void =>
    setModal({ kind: "list", type: "voice", voiceView: "tiers" });

  const openLlm = (): void => {
    m.setCleanup(true);
    setModal({ kind: "list", type: "llm", llmView: "tiers" });
  };

  const onToggleCleanup = (next: boolean): void => {
    if (!next) {
      m.setCleanup(false);
      return;
    }
    m.setCleanup(true);
    if (!m.defaultLlm) {
      openLlm();
    }
  };

  const onPickCloud = (model: AvailableModel): void => {
    if (modal?.kind !== "list") return;
    const type = modal.type;

    if (type === "voice") {
      configureVoice(model, { closeAfter: true });
      return;
    }

    const needsKey =
      model.provider_id !== "local-llm" &&
      !m.keyProviders.has(model.provider_id);
    if (needsKey) {
      setKeyError(null);
      setModal({
        kind: "key",
        type,
        provider: model.provider_id,
        modelName: model.model_name,
        pendingModel: model,
      });
      return;
    }
    void m.configureModel(model, type).then(closeModal);
  };

  const onPickLocalVoice = (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ): void => {
    void m.selectLocalVoice(defId, name, engine).then((selected) => {
      if (selected && modal?.kind === "list") closeModal();
    });
  };

  const onRequestDeleteLocal = (
    defId: string,
    engine?: "whisper" | "mlx",
  ): void => {
    const item = m.voiceItems.find(
      (row) => row.defId === defId && row.localEngine === engine,
    );
    setPendingLocalDelete({ defId, engine, name: item?.name ?? defId });
  };

  const onBack = (): void => {
    if (modal?.kind !== "key") return;
    if (modal.type === "voice") {
      setModal({ kind: "list", type: "voice", voiceView: "tiers" });
    } else if (modal.type === "llm") {
      setModal({ kind: "list", type: "llm", llmView: "tiers" });
    } else if (modal.type === "remix") {
      setModal({ kind: "list", type: "remix" });
    } else {
      closeModal();
    }
  };

  const onSaveKey = (key: string): void => {
    if (modal?.kind !== "key") return;
    const { provider, pendingModel, type } = modal;
    setSaving(true);
    setKeyError(null);
    void (async () => {
      const err = await m.saveKey(provider, key);
      if (err) {
        setKeyError(err);
        setSaving(false);
        return;
      }
      if (pendingModel && type) {
        await m.configureModel(pendingModel, type);
      }
      closeModal();
    })();
  };

  const showMlxWarming = m.defaultVoice?.provider === "local-mlx";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (m.loading) {
    return (
      <PageShell>
        <ModelsSettingsFrame>
          <ModelsSettingsHeader
            title={t("models.title")}
            subtitle={t("models.subtitle")}
          />
          <ModelsLoadingSkeleton />
        </ModelsSettingsFrame>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <ModelsSettingsFrame>
        <ModelsSettingsHeader
          title={t("models.title")}
          subtitle={t("models.subtitle")}
        />
        <div className="space-y-6">
          <section aria-label="Dictation models" className="space-y-3">
            <Eyebrow text="Dictation models" mono={false} />
            <PairCard
              voice={m.defaultVoice}
              llm={m.defaultLlm}
              llmCleanup={m.llmCleanup}
              onToggleCleanup={onToggleCleanup}
              onChangeVoice={openVoice}
              onChangeLlm={openLlm}
              onConfigureWarming={
                showMlxWarming ? () => setWarmingOpen(true) : undefined
              }
            />
          </section>

          <KeysSection
            apiKeys={m.apiKeys}
            configured={m.configured}
            deletingProviders={m.deletingProviders}
            loading={m.keysLoading}
            onEdit={(provider) =>
              setModal({
                kind: "key",
                type: null,
                provider,
                pendingModel: null,
              })
            }
            onDelete={setPendingProviderDelete}
          />
        </div>

        {warmingOpen && (
          <MlxWarmingDialog
            keepAliveMinutes={m.mlxKeepAliveMinutes}
            blockedReason={m.mlxStatus?.blockedReason ?? null}
            onChange={m.saveMlxKeepAliveMinutes}
            onClose={() => setWarmingOpen(false)}
          />
        )}

        {modal && (
          <ModelModal
            modal={modal}
            m={m}
            saving={saving}
            keyError={keyError}
            catalogLoading={m.catalogLoading}
            onClose={closeModal}
            onPickCloud={onPickCloud}
            onPickLocalVoice={onPickLocalVoice}
            onRequestDeleteLocal={onRequestDeleteLocal}
            onBack={onBack}
            onSaveKey={onSaveKey}
          />
        )}

        {pendingLocalDelete && (
          <ConfirmDialog
            title={t("models.deleteLocalTitle")}
            message={
              <Trans
                i18nKey="models.deleteLocalMsg"
                values={{
                  name: pendingLocalDelete.name,
                  phrase: ON_DEVICE_PHRASE,
                }}
                components={{
                  b: <span className="text-foreground/80 font-medium" />,
                }}
              />
            }
            onCancel={() => setPendingLocalDelete(null)}
            onConfirm={() => {
              const { defId, engine } = pendingLocalDelete;
              setPendingLocalDelete(null);
              void m.deleteLocal(defId, engine);
            }}
          />
        )}

        {pendingProviderDelete && (
          <ConfirmDialog
            title={t("models.deleteProviderTitle")}
            message={
              <>
                <Trans
                  i18nKey="models.deleteProviderMsgBase"
                  values={{ provider: displayName(pendingProviderDelete) }}
                  components={{
                    b: <span className="text-foreground/80 font-medium" />,
                  }}
                />
                {(m.defaultVoice?.provider === pendingProviderDelete ||
                  m.defaultLlm?.provider === pendingProviderDelete ||
                  m.defaultRemix?.provider === pendingProviderDelete) &&
                  t("models.deleteProviderCurrentSuffix")}
                .
              </>
            }
            onCancel={() => setPendingProviderDelete(null)}
            onConfirm={() => {
              const provider = pendingProviderDelete;
              setPendingProviderDelete(null);
              void m.deleteProvider(provider);
            }}
          />
        )}
      </ModelsSettingsFrame>
    </PageShell>
  );
}

function ModelsSettingsFrame({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col pb-8"
      data-testid="models-settings-page"
    >
      {children}
    </div>
  );
}

function ModelsSettingsHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}): React.JSX.Element {
  return (
    <header className="border-border mb-6 border-b pb-5 sm:mb-7 sm:pb-6">
      <h1 className="serif text-foreground m-0 text-[30px] font-normal leading-none tracking-[-0.025em] sm:text-[36px]">
        {title}
      </h1>
      <p className="text-muted-foreground mt-2 max-w-xl text-[13px] leading-[1.55]">
        {subtitle}
      </p>
    </header>
  );
}

function SkeletonLine({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return <Skeleton className={cn("rounded-full", className)} />;
}

function ModelsLoadingSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6" role="status" aria-label="Loading models">
      <section className="border-border bg-card/55 grid grid-cols-1 overflow-hidden rounded-[12px] border min-[820px]:grid-cols-2">
        {["voice", "cleanup"].map((key) => (
          <div
            key={key}
            className={cn(
              "flex min-h-[132px] flex-col gap-3 p-4 sm:p-5",
              key === "cleanup" &&
                "border-border border-t min-[820px]:border-l min-[820px]:border-t-0",
            )}
          >
            <SkeletonLine className="h-3 w-40" />
            <SkeletonLine className="h-6 w-52 max-w-full" />
            <SkeletonLine className="h-3 w-32" />
            <div className="mt-auto flex items-center gap-3">
              <SkeletonLine className="h-9 w-24 rounded-md" />
              <SkeletonLine className="h-5 w-28" />
            </div>
          </div>
        ))}
      </section>

      <section>
        <SkeletonLine className="h-3 w-28" />
        <div className="border-border bg-card mt-3 overflow-hidden rounded-[12px] border">
          {[0, 1].map((i) => (
            <div
              key={i}
              className={cn(
                "flex items-center justify-between gap-4 px-[18px] py-[13px]",
                i > 0 && "border-border border-t",
              )}
            >
              <SkeletonLine className="h-4 w-40" />
              <SkeletonLine className="h-8 w-16 rounded-md" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeysSection — compact list of stored provider keys (edit / remove)
// ---------------------------------------------------------------------------

function KeysSection({
  apiKeys,
  configured,
  deletingProviders,
  loading,
  onEdit,
  onDelete,
}: {
  apiKeys: ApiKeyEntry[];
  configured: ConfiguredModel[];
  deletingProviders: Set<string>;
  loading: boolean;
  onEdit: (provider: string) => void;
  onDelete: (provider: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      className="border-border bg-card/55 overflow-hidden rounded-[12px] border"
      data-testid="models-api-keys"
    >
      <div className="border-border border-b px-4 py-3.5 sm:px-5">
        <Eyebrow text={t("models.apiKeys")} />
        <p className="text-muted-foreground mt-1 text-[12px] leading-[1.5]">
          {t("models.apiKeysHint")}
        </p>
      </div>
      {loading ? (
        <div
          className="space-y-3 px-4 py-4 sm:px-5"
          role="status"
          aria-label="Loading API keys"
        >
          <SkeletonLine className="h-4 w-40" />
          <SkeletonLine className="h-3 w-28" />
        </div>
      ) : apiKeys.length === 0 ? (
        <p className="text-muted-foreground px-4 py-4 text-[13px] sm:px-5">
          {t("models.noApiKeys")}
        </p>
      ) : (
        apiKeys.map((entry, i) => (
          <KeyRow
            key={entry.provider}
            entry={entry}
            count={
              configured.filter((c) => c.provider === entry.provider).length
            }
            first={i === 0}
            deleting={deletingProviders.has(entry.provider)}
            onEdit={() => onEdit(entry.provider)}
            onDelete={() => onDelete(entry.provider)}
          />
        ))
      )}
    </section>
  );
}

function KeyRow({
  entry,
  count,
  first,
  deleting,
  onEdit,
  onDelete,
}: {
  entry: ApiKeyEntry;
  count: number;
  first: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const invalid = entry.status === "invalid";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 sm:flex-nowrap sm:px-5",
        !first && "border-border border-t",
      )}
    >
      <Key className="text-muted-foreground h-[15px] w-[15px] shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground text-[13.5px] font-semibold">
            {displayName(entry.provider)}
          </span>
          {entry.status === "valid" && (
            <CheckCircle className="text-primary h-3.5 w-3.5 shrink-0" />
          )}
          {invalid && (
            <XCircle className="text-destructive h-3.5 w-3.5 shrink-0" />
          )}
        </div>
        <div className="mono text-muted-foreground mt-0.5 text-[11px]">
          {invalid ? (
            <span className="text-destructive">{t("models.keyInvalid")}</span>
          ) : entry.hint ? (
            t("models.keyStoredWithHint", { hint: entry.hint })
          ) : (
            t("models.keyStored")
          )}
        </div>
      </div>
      <span className="text-muted-foreground order-3 w-full text-[11.5px] sm:order-none sm:w-auto">
        {count}{" "}
        {count === 1 ? t("models.modelSingular") : t("models.modelPlural")}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          disabled={deleting}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t("models.keyUpdate")}
          title={t("models.keyUpdate")}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={deleting}
          className="text-muted-foreground hover:text-destructive"
          aria-label={t("models.keyDelete")}
          title={t("models.keyDelete")}
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>
    </div>
  );
}
