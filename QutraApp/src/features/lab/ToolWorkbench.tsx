import { useState, type ReactNode } from "react";
import { FlaskConical, Power, RefreshCw, ShieldCheck } from "lucide-react";
import type { AuthorizationScope, Engagement, Target } from "@/domain/lab";
import type { FormPreset, ToolForm } from "@/domain/tools/toolForms";
import type { NativeToolInstallation, NativeToolRun } from "@/lib/bridge/types";
import { useT } from "@/lib/i18n";
import { useToolFormsT } from "@/lib/i18n/toolForms";
import type { FormRunStarted } from "@/lib/toolForms";
import { LabDisclosure } from "./LabDisclosure";
import { formKey, ToolFormRunner } from "./ToolFormRunner";
import { ToolRunResult } from "./ToolRunResult";
import {
  signatureLabel,
  toolCategoryLabel,
  toolRiskLabel,
  type ToolState,
} from "./toolLabels";
import "./workbench.css";

/** The run a form started, as the result section follows it. */
interface FormRunRef {
  runId: string;
  presetId: string;
  outputName?: string | null;
}

/** A form run's profile id is `form-<form>-<preset>` (tool_forms.rs). */
function formRunOf(form: ToolForm, run: NativeToolRun): FormRunRef | null {
  const prefix = `form-${form.id}-`;
  if (!run.profileId.startsWith(prefix)) return null;
  return { runId: run.id, presetId: run.profileId.slice(prefix.length) };
}

/**
 * One registered program as a workbench: first what it is
 * and what it is for, then its state and why, with the one step that fixes
 * it, then how to run it and what came out. Its record, its binding and the
 * hand-written command sit under Advanced. The sections follow the order a
 * person works in, and the spine on their left says so.
 */
export function ToolWorkbench({
  installation,
  state,
  form,
  fixture,
  engagement,
  scope,
  targets,
  runs,
  busy,
  onReverify,
  onToggleEnabled,
  onShowOutput,
  onCancelRun,
  onRunStarted,
  genericRun,
  identity,
  profileEditor,
}: {
  installation: NativeToolInstallation;
  state: ToolState;
  form?: ToolForm;
  fixture: boolean;
  engagement?: Engagement;
  scope?: AuthorizationScope;
  targets: Target[];
  /** This program's runs, newest first. */
  runs: NativeToolRun[];
  busy: string;
  onReverify: (acceptChangedIdentity: boolean) => void;
  onToggleEnabled: () => void;
  onShowOutput: (runId: string) => void;
  onCancelRun: (runId: string) => void;
  /** A form run started: read the runs again so it shows at once. */
  onRunStarted: () => void;
  /** The hand-written run card: the run section for a program with no form. */
  genericRun: ReactNode;
  identity: ReactNode;
  profileEditor: ReactNode;
}) {
  const { t, locale } = useT();
  const tf = useToolFormsT();
  const [started, setStarted] = useState<FormRunRef | null>(null);

  const latest = form
    ? (started ?? runs.map((run) => formRunOf(form, run)).find(Boolean) ?? null)
    : null;
  const latestRun = latest ? runs.find((run) => run.id === latest.runId) : undefined;
  const latestPreset: FormPreset | undefined =
    form && latest ? form.presets.find((preset) => preset.id === latest.presetId) : undefined;

  const verifiedOn = new Date(installation.lastVerifiedAt).toLocaleDateString(locale, {
    dateStyle: "medium",
  });
  const purpose = form ? tf(formKey(form, "purpose")) : t("lab.wb.noPurpose");
  const initial = installation.displayName.trim().charAt(0).toLocaleUpperCase(locale) || "?";

  const onFormStarted = (result: FormRunStarted, preset: FormPreset) => {
    setStarted({ runId: result.run.id, presetId: preset.id, outputName: result.outputName });
    onRunStarted();
  };

  return (
    <section className="wb" aria-labelledby="wb-title" data-state={state}>
      <header className="wb-head">
        <span className={`wb-mark${fixture ? " wb-mark--fixture" : ""}`} aria-hidden>
          {fixture ? <FlaskConical size={20} /> : initial}
        </span>
        <div className="wb-head__text">
          <h3 id="wb-title">
            {installation.displayName}
            {installation.version && <span className="wb-version">{installation.version}</span>}
            {fixture && <span className="wb-tag">{t("lab.wb.fixtureBadge")}</span>}
          </h3>
          <p className="wb-head__meta">
            {toolCategoryLabel(t, installation.category)} · {toolRiskLabel(t, installation.riskTier)}
            {" · "}
            {signatureLabel(t, installation.signatureState)}
            {installation.publisher ? ` (${installation.publisher})` : ""}
          </p>
        </div>
      </header>

      <ol className="wb-flow">
        <li className="wb-step wb-step--what">
          <h4 className="wb-eyebrow">{t("lab.wb.what")}</h4>
          <p className="wb-purpose">{purpose}</p>
        </li>

        <li className={`wb-step wb-step--status is-${state}`}>
          <h4 className="wb-eyebrow">{t("lab.wb.status")}</h4>
          <div className="wb-status" data-testid="wb-status">
            <div className="wb-status__text">
              <strong>{t(`lab.wb.state.${state}.title`)}</strong>
              <p>
                {state === "ready"
                  ? t("lab.wb.state.ready.body", { date: verifiedOn })
                  : t(`lab.wb.state.${state}.body`)}
              </p>
            </div>
            {state === "disabled" && (
              <div className="wb-fix">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={onToggleEnabled}
                  disabled={busy === "toggle"}
                >
                  <Power size={13} aria-hidden /> {t("lab.wb.state.disabled.fix")}
                </button>
                <small>{t("lab.wb.state.disabled.fixHint")}</small>
              </div>
            )}
            {state === "changed" && (
              <div className="wb-fix">
                <div className="wb-fix__row">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => onReverify(false)}
                    disabled={busy === "verify"}
                  >
                    <RefreshCw size={13} aria-hidden /> {t("lab.tools.checkIdentity")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => onReverify(true)}
                    disabled={busy === "verify"}
                  >
                    <ShieldCheck size={13} aria-hidden /> {t("lab.tools.trustNewIdentity")}
                  </button>
                </div>
                <small>{t("lab.wb.state.changed.trustHint")}</small>
              </div>
            )}
            {state === "ready" && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onReverify(false)}
                disabled={busy === "verify"}
              >
                <RefreshCw size={13} aria-hidden /> {t("lab.tools.checkIdentity")}
              </button>
            )}
          </div>
        </li>

        <li className="wb-step wb-step--run">
          <h4 className="wb-eyebrow">{t("lab.wb.run")}</h4>
          {form ? (
            <ToolFormRunner
              key={`${installation.id}-${form.id}`}
              installation={installation}
              form={form}
              state={state}
              engagement={engagement}
              scope={scope}
              targets={targets}
              onStarted={onFormStarted}
            />
          ) : (
            genericRun
          )}
        </li>

        {form && (
          <li className={`wb-step wb-step--result${latestRun ? ` is-${latestRun.state}` : ""}`}>
            <h4 className="wb-eyebrow">{t("lab.wb.result")}</h4>
            {latestRun && latestPreset ? (
              <ToolRunResult
                key={latestRun.id}
                run={latestRun}
                output={latestPreset.output}
                outputName={latest?.outputName}
                toolName={installation.displayName}
                onStop={() => onCancelRun(latestRun.id)}
                onShowOutput={() => onShowOutput(latestRun.id)}
              />
            ) : (
              <p className="wb-note">{t("lab.wb.noResult")}</p>
            )}
          </li>
        )}
      </ol>

      <LabDisclosure
        key={`advanced-${installation.id}`}
        title={t("lab.tools.advanced")}
        summary={t("lab.wb.advancedSummary")}
      >
        <div className="wb-advanced">
          {identity}
          {form && (
            <section className="wb-advanced__custom" aria-label={t("lab.wb.customRun")}>
              <h5>{t("lab.wb.customRun")}</h5>
              <p className="wb-note">{t("lab.wb.customRunHint")}</p>
              {genericRun}
            </section>
          )}
          {profileEditor}
        </div>
      </LabDisclosure>
    </section>
  );
}
