import { type ReactNode, useState } from "react";
import { Download, FolderOpen, Loader2, Play, Square, Trash2, Wand2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import {
  type EngineModel,
  type EngineReport,
  type LocalEngineClient,
  type LocalEngineError,
  type TaskEvent,
  formatBytes,
  localEngine,
} from "@/lib/localEngine/client";
import { clearAutoEngine, useAutoEngine } from "@/lib/localEngine/autoEngine";
import { useUi } from "@/state/ui";
import { useLocalEngine } from "./useLocalEngine";
import "./localEngine.css";

/* Jarvis's local engine, as one strip (ADR 0016): the three things a local
   answer needs, in the order it needs them -- the engine, the model, the
   answer -- and the one step that stands between the user and it. */

type Station = "done" | "active" | "todo" | "attention" | "error";

const ENGINE_ERROR: Partial<Record<LocalEngineError["code"], MessageKey>> = {
  download_failed: "engine.error.downloadFailed",
  download_hash_mismatch: "engine.error.downloadHashMismatch",
  unpack_failed: "engine.error.unpackFailed",
  engine_corrupt: "jarvis.error.engineCorrupt",
  engine_missing: "jarvis.error.engineMissing",
  model_needs_prepare: "jarvis.error.modelNeedsPrepare",
  model_unreadable: "jarvis.error.modelUnreadable",
  start_failed: "jarvis.error.engineStartFailed",
  load_timeout: "jarvis.error.engineLoadTimeout",
};

export function engineErrorMessage(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  error: LocalEngineError,
  locale: string,
): string {
  switch (error.code) {
    case "not_enough_disk":
      return t("engine.noSpace", {
        needed: formatBytes(error.needed, locale),
        free: formatBytes(error.free, locale),
      });
    case "load_failed":
      return t(
        error.reason === "out_of_memory"
          ? "jarvis.error.engineOutOfMemory"
          : "jarvis.error.engineLoadFailed",
      );
    case "model_unsupported":
      return t("jarvis.error.modelUnsupported");
    case "cancelled":
      return "";
    default: {
      const key = ENGINE_ERROR[error.code];
      return key ? t(key) : t("engine.error.generic");
    }
  }
}

function percent(task: TaskEvent): number {
  return task.totalBytes > 0 ? Math.min(100, Math.floor((task.doneBytes / task.totalBytes) * 100)) : 0;
}

function StationDot({ state }: { state: Station }) {
  return (
    <span className={`le-dot le-dot--${state}`} aria-hidden>
      {state === "active" && <span className="le-dot__ring" />}
    </span>
  );
}

function Progress({ task, label }: { task: TaskEvent; label: string }) {
  const value = percent(task);
  return (
    <div
      className="le-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span className="le-progress__bar" style={{ transform: `scaleX(${value / 100})` }} />
    </div>
  );
}

export function LocalEnginePanel({
  compact = false,
  onChanged,
  client = localEngine,
}: {
  /** In the conversation: the strip and its one step; the model list only
      when the chosen model cannot be used. */
  compact?: boolean;
  /** Something changed that a readiness check should see again. */
  onChanged?: () => void;
  client?: LocalEngineClient;
}) {
  const { t, locale } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const enabled = prefs.localAssistantEnabled;
  const view = useLocalEngine(
    enabled,
    (task) => {
      if (task.phase === "done") {
        toast({
          kind: "success",
          messageKey: task.kind === "install" ? "engine.installed" : "engine.prepare.done",
        });
      }
      onChanged?.();
    },
    client,
  );
  const [confirmDelete, setConfirmDelete] = useState<EngineModel | null>(null);
  // What choosing a model sets going on its own (src/lib/localEngine/autoEngine.ts).
  const auto = useAutoEngine();
  const autoForThis = auto.model === prefs.ollamaModel;
  const autoBusy =
    autoForThis &&
    (auto.phase === "installing" || auto.phase === "preparing" || auto.phase === "starting");

  if (!enabled || !client.available()) return null;
  const { report, models } = view;
  if (!report || !models) {
    return (
      <section className="le" data-testid="local-engine-panel" aria-busy="true">
        <p className="le-line faint">
          <Loader2 size={14} className="spin" aria-hidden /> {t("engine.title")}
        </p>
      </section>
    );
  }

  const selected = models.models.find((m) => m.id === prefs.ollamaModel) ?? null;
  const task = report.task?.phase === "running" ? report.task : null;
  const status = report.status;
  const runsSelected = status.model === prefs.ollamaModel;

  const engineStation: Station = report.installed
    ? "done"
    : task?.kind === "install"
      ? "active"
      : "attention";
  const modelStation: Station = !selected
    ? "error"
    : selected.state === "ready"
      ? "done"
      : task?.kind === "prepare" && task.model === selected.id
        ? "active"
        : selected.state === "needs_prepare"
          ? "attention"
          : "error";
  const answerStation: Station =
    !runsSelected || status.phase === "stopped"
      ? "todo"
      : status.phase === "ready"
        ? "done"
        : status.phase === "failed"
          ? "error"
          : "active";

  const use = (model: EngineModel) => {
    getDb().prefs.set({ ollamaModel: model.id });
    onChanged?.();
  };
  const startNow = async () => {
    clearAutoEngine();
    await view.run((c) => c.start(prefs.ollamaModel));
    onChanged?.();
  };
  const stop = () => view.run((c) => c.stop());
  const cancel = () => view.run((c) => c.cancelTask());
  const install = () => {
    clearAutoEngine();
    return view.run((c) => c.install());
  };
  const prepare = (model: EngineModel) => {
    clearAutoEngine();
    return view.run((c) => c.prepare(model.id));
  };
  const deleteCopy = async (model: EngineModel) => {
    setConfirmDelete(null);
    await view.run((c) => c.deleteCopy(model.id, true));
    toast({ kind: "success", messageKey: "engine.deleted" });
    await view.refresh();
    onChanged?.();
  };

  const engineLoading = runsSelected && (status.phase === "starting" || status.phase === "loading");
  // Between its own steps the engine offers no button to press: it is going on by itself.
  const step = autoBusy && !task && !engineLoading ? { text: t("engine.auto.working") } : nextStep();
  const showList = !compact || modelStation === "error";
  const failure =
    view.error ??
    (autoForThis && auto.phase === "failed" ? auto.error : null) ??
    (status.phase === "failed" && runsSelected ? status.error : null);
  const failureText = failure ? engineErrorMessage(t, failure, locale) : "";

  function nextStep(): { text: string; hint?: string; action?: ReactNode; progress?: ReactNode } {
    if (!report || !models) return { text: "" };
    if (!report.installed) {
      if (task?.kind === "install") {
        return {
          text: t("engine.installing", {
            done: formatBytes(task.doneBytes, locale),
            total: formatBytes(task.totalBytes, locale),
          }),
          progress: <Progress task={task} label={t("engine.missing.title")} />,
          action: (
            <button type="button" className="btn btn--sm" onClick={() => void cancel()}>
              <X size={13} aria-hidden /> {t("engine.cancel")}
            </button>
          ),
        };
      }
      return {
        text: t("engine.missing.title"),
        hint: t("engine.missing.body", { source: report.downloadSource, build: report.build }),
        action: (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void install()}
            disabled={task !== null}
            data-testid="local-engine-install"
          >
            <Download size={13} aria-hidden />
            {t("engine.install", { size: formatBytes(report.downloadBytes, locale) })}
          </button>
        ),
      };
    }
    if (!selected) {
      return { text: t("engine.modelMissing", { model: prefs.ollamaModel }) };
    }
    if (selected.state === "unsupported") {
      return {
        text: t("engine.unsupported", {
          model: selected.id,
          architecture: selected.unsupportedArchitecture,
        }),
      };
    }
    if (selected.state === "unreadable") {
      return { text: t("jarvis.error.modelUnreadable") };
    }
    if (selected.state === "needs_prepare") {
      if (task?.kind === "prepare") {
        return {
          text: t("engine.prepare.running", { model: task.model ?? selected.id, percent: percent(task) }),
          progress: <Progress task={task} label={t("engine.prepare.action")} />,
          action: (
            <button type="button" className="btn btn--sm" onClick={() => void cancel()}>
              <X size={13} aria-hidden /> {t("engine.cancel")}
            </button>
          ),
        };
      }
      const free = models.freeBytes;
      return {
        text: t("engine.prepare.title", { model: selected.id }),
        hint: `${t("engine.prepare.body")} ${t("engine.prepare.space", {
          size: formatBytes(selected.writeBytes, locale),
          free: free === null ? "?" : formatBytes(free, locale),
        })}`,
        action: (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void prepare(selected)}
            data-testid="local-engine-prepare"
          >
            <Wand2 size={13} aria-hidden /> {t("engine.prepare.action")}
          </button>
        ),
      };
    }
    if (runsSelected && (status.phase === "starting" || status.phase === "loading")) {
      return {
        text:
          status.phase === "starting"
            ? t("engine.phase.starting")
            : t("engine.phase.loading", { model: selected.id }),
        hint: t("engine.loadingHint"),
        action: (
          <button type="button" className="btn btn--sm" onClick={() => void stop()}>
            <Square size={12} aria-hidden /> {t("engine.stop")}
          </button>
        ),
      };
    }
    if (runsSelected && status.phase === "ready") {
      return {
        text: t("engine.phase.ready", { model: selected.id, minutes: status.idleMinutes }),
        action: (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void stop()}
            data-testid="local-engine-stop"
          >
            <Square size={12} aria-hidden /> {t("engine.stop")}
          </button>
        ),
      };
    }
    return {
      text: runsSelected && status.phase === "failed" ? t("engine.phase.failed") : t("engine.phase.off"),
      action: (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void startNow()}
          data-testid="local-engine-start"
        >
          <Play size={12} aria-hidden /> {t("engine.start")}
        </button>
      ),
    };
  }

  const stationText = (state: Station, done: string, todo: string): string =>
    state === "done" ? done : todo;

  return (
    <section className={`le${compact ? " le--compact" : ""}`} data-testid="local-engine-panel">
      <header className="le-head">
        <span className="le-head__title">{t("engine.title")}</span>
        <span className="le-head__build mono">llama.cpp {report.build}</span>
      </header>

      <ol className="le-rail" aria-label={t("engine.rail")}>
        <li className={`le-station le-station--${engineStation}`} data-testid="le-station-engine" data-state={engineStation}>
          <StationDot state={engineStation} />
          <span className="le-station__name">{t("engine.station.engine")}</span>
          <span className="le-station__value mono">
            {stationText(engineStation, report.build, "—")}
          </span>
        </li>
        <li className={`le-station le-station--${modelStation}`} data-testid="le-station-model" data-state={modelStation}>
          <StationDot state={modelStation} />
          <span className="le-station__name">{t("engine.station.model")}</span>
          <span className="le-station__value mono">{prefs.ollamaModel}</span>
        </li>
        <li className={`le-station le-station--${answerStation}`} data-testid="le-station-answer" data-state={answerStation}>
          <StationDot state={answerStation} />
          <span className="le-station__name">{t("engine.station.answer")}</span>
          <span className="le-station__value">
            {answerStation === "done"
              ? t("engine.state.ready")
              : answerStation === "active"
                ? "…"
                : "—"}
          </span>
        </li>
      </ol>

      <div className="le-step">
        <div className="le-step__text">
          <p className="le-line" role="status" aria-live="polite" data-testid="local-engine-step">
            {step.text}
          </p>
          {step.hint && <p className="le-hint">{step.hint}</p>}
          {step.progress}
        </div>
        {step.action && <div className="le-step__action">{step.action}</div>}
      </div>

      {failureText && (
        <p className="le-error" role="alert" data-testid="local-engine-error">
          {failureText}
        </p>
      )}

      {showList && (
        <ModelManifest
          report={report}
          models={models.models}
          selectedId={prefs.ollamaModel}
          busy={task !== null}
          onUse={use}
          onPrepare={(m) => void prepare(m)}
          onDelete={setConfirmDelete}
          onOpenFolder={() => void view.run((c) => c.openModelsFolder())}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("engine.deleteCopy")}
        body={
          confirmDelete
            ? t("engine.deleteCopy.confirm", {
                model: confirmDelete.id,
                size: formatBytes(confirmDelete.sizeBytes, locale),
              })
            : ""
        }
        confirmLabel={t("engine.deleteCopy")}
        danger
        onConfirm={() => confirmDelete && void deleteCopy(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </section>
  );
}

function stateLabel(model: EngineModel): MessageKey {
  if (model.state === "ready") return model.prepared ? "engine.state.prepared" : "engine.state.ready";
  if (model.state === "needs_prepare") return "engine.state.needsPrepare";
  if (model.state === "unsupported") return "engine.state.unsupported";
  return "engine.state.unreadable";
}

function ModelManifest({
  report,
  models,
  selectedId,
  busy,
  onUse,
  onPrepare,
  onDelete,
  onOpenFolder,
}: {
  report: EngineReport;
  models: EngineModel[];
  selectedId: string;
  busy: boolean;
  onUse: (m: EngineModel) => void;
  onPrepare: (m: EngineModel) => void;
  onDelete: (m: EngineModel) => void;
  onOpenFolder: () => void;
}) {
  const { t, locale } = useT();
  return (
    <div className="le-manifest">
      <div className="le-manifest__head">
        <h3 className="le-manifest__title">{t("engine.models.title")}</h3>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenFolder}>
          <FolderOpen size={13} aria-hidden /> {t("engine.models.openFolder")}
        </button>
      </div>
      {models.length === 0 ? (
        <p className="le-hint" data-testid="local-engine-models-empty">
          {t("engine.models.empty")}
        </p>
      ) : (
        <ul className="le-models" aria-label={t("engine.models.label")} data-testid="local-engine-models">
          {models.map((m) => {
            const chosen = m.id === selectedId;
            const usable = m.state === "ready" || m.state === "needs_prepare";
            return (
              <li
                key={m.id}
                className={`le-model${chosen ? " le-model--chosen" : ""}`}
                data-testid={`local-engine-model-${m.id}`}
              >
                <span className="le-model__name mono">{m.id}</span>
                <span className="le-model__meta">
                  {t(m.source === "ollama" ? "engine.source.ollama" : "engine.source.folder")}
                  {" · "}
                  <span className="mono">{formatBytes(m.sizeBytes, locale)}</span>
                </span>
                <span className={`le-chip le-chip--${m.state}`}>{t(stateLabel(m))}</span>
                <span className="le-model__actions">
                  {m.state === "needs_prepare" && chosen && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || !report.installed}
                      onClick={() => onPrepare(m)}
                    >
                      {t("engine.prepare.action")}
                    </button>
                  )}
                  {m.prepared && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => onDelete(m)}
                      aria-label={`${t("engine.deleteCopy")}: ${m.id}`}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  )}
                  {chosen ? (
                    <span className="le-model__chosen">{t("engine.models.inUse")}</span>
                  ) : (
                    usable && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => onUse(m)}
                        aria-label={`${t("engine.models.use")}: ${m.id}`}
                      >
                        {t("engine.models.use")}
                      </button>
                    )
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
