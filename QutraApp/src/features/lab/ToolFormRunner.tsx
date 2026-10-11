import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FilePlus2,
  Globe,
  Play,
  ShieldAlert,
} from "lucide-react";
import type { AuthorizationScope, Engagement, Target } from "@/domain/lab";
import { evaluateTarget, type ScopeDecisionReason } from "@/domain/lab/scope";
import {
  effectiveValue,
  executableName,
  formProblems,
  inputFields,
  presetUses,
  previewTokens,
  quoteToken,
  type FormField,
  type FormPreset,
  type ToolForm,
} from "@/domain/tools/toolForms";
import { getBridge } from "@/lib/bridge";
import type { NativeScopeAttestation, NativeToolInstallation } from "@/lib/bridge/types";
import { e2eTools } from "@/lib/e2eTools";
import { useT } from "@/lib/i18n";
import { useToolFormsT } from "@/lib/i18n/toolForms";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { launchFailureMessage } from "@/lib/launch/launchFailureMessage";
import { toolFormRuns, type FormRunStarted } from "@/lib/toolForms";
import { now } from "@/lib/time";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { Field } from "@/components/ui/Field";
import { scopeDecisionLabel, type ToolState } from "./toolLabels";

type Translate = ReturnType<typeof useT>["t"];

const NO_FILES: InvestigationFile[] = [];

/** The forms' words, keyed by the data file's ids, load with this page
    (src/lib/i18n/toolForms), not with the main catalogs. */
type FormsTranslate = ReturnType<typeof useToolFormsT>;
export const formKey = (form: ToolForm, rest: string) => `toolForms.${form.id}.${rest}`;
const fieldLabel = (tf: FormsTranslate, field: FormField) => tf(`toolForms.field.${field.id}`);
const fieldHelp = (tf: FormsTranslate, field: FormField) => tf(`toolForms.help.${field.id}`);

/** Rust's refusal codes for a form run, in the user's words. */
export function formRunError(
  t: Translate,
  tf: FormsTranslate,
  reason: string,
  name: string,
): string {
  const [code, fieldId] = reason.split(":");
  const field = fieldId ? tf(`toolForms.field.${fieldId}`) : "";
  switch (code) {
    case "field_required":
      return t("lab.wb.problem.required", { name: field });
    case "field_invalid":
      return t("lab.wb.problem.invalid", { name: field });
    case "file_kind_not_accepted":
      return t("lab.wb.err.fileKind", { name: field });
    case "no_engagement":
    case "no_engagement_folder":
      return t("lab.wb.needsInvestigation");
    case "unknown_file":
    case "file_missing":
      return t("lab.wb.err.fileMissing");
    case "file_changed":
      return t("lab.wb.err.fileChanged");
    case "rules_include_not_allowed":
      return t("lab.wb.err.rulesInclude");
    case "investigation_has_no_files":
      return t("lab.wb.fileNone");
    case "form_not_for_tool":
      return t("lab.wb.err.notForTool", { name });
    case "authorization_scope_required":
    case "authorization_scope_blocked":
    case "scope_target_argument_mismatch":
    case "scope_decision_stale":
    case "authorization_scope_expired":
      return t("lab.tools.blocked.scope");
    default:
      return launchFailureMessage(t, code, name);
  }
}

/** A translated sentence with its `{placeholders}` drawn as the values the
    user chose, so the preview reads as what will happen, in their words. */
export function Sentence({
  template,
  values,
}: {
  template: string;
  values: Record<string, string>;
}) {
  const parts = template.split(/(\{[A-Za-z0-9]+\})/g);
  return (
    <>
      {parts.map((part, index) => {
        const id = /^\{([A-Za-z0-9]+)\}$/.exec(part)?.[1];
        if (!id) return <Fragment key={index}>{part}</Fragment>;
        const value = values[id];
        return (
          <mark key={index} className={`wb-chip${value ? "" : " is-empty"}`}>
            {value || "…"}
          </mark>
        );
      })}
    </>
  );
}

/** The scope check the supervisor will ask for, made the way the launch
    gate makes it: a target is allowed only inside the investigation's scope. */
export function scopeAttestationFor(
  target: string,
  scope: AuthorizationScope | undefined,
):
  | { ok: true; attestation: NativeScopeAttestation }
  | { ok: false; reason: ScopeDecisionReason } {
  if (!target || !scope) return { ok: false, reason: "no_scope" };
  const decision = evaluateTarget(target, scope);
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  return {
    ok: true,
    attestation: {
      scopeId: scope.id,
      scopeRevision: scope.revision,
      target,
      allowed: true,
      reason: decision.reason,
      decidedAt: now(),
      expiresAt: scope.expiresAt,
    },
  };
}

/**
 * A known tool's own run form: pick a preset, fill in only
 * what it asks for, read in a sentence what will happen and the exact
 * command, run. Rust builds the arguments from the same data file.
 */
export function ToolFormRunner({
  installation,
  form,
  state,
  engagement,
  scope,
  targets,
  onStarted,
}: {
  installation: NativeToolInstallation;
  form: ToolForm;
  state: ToolState;
  engagement?: Engagement;
  scope?: AuthorizationScope;
  targets: Target[];
  onStarted: (started: FormRunStarted, preset: FormPreset) => void;
}) {
  const { t } = useT();
  const tf = useToolFormsT();
  const groupId = useId();
  const listId = useId();
  const [presetId, setPresetId] = useState(form.presets[0]!.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const engagementId = engagement?.id;
  const loadFiles = useInvestigationFiles((s) => s.load);
  const pickFiles = useInvestigationFiles((s) => s.pick);
  const storeFiles = useInvestigationFiles((s) =>
    engagementId ? (s.byEngagement[engagementId] ?? NO_FILES) : NO_FILES,
  );
  const files = e2eTools()?.files ?? storeFiles;

  useEffect(() => {
    if (engagementId) void loadFiles(engagementId);
  }, [engagementId, loadFiles]);

  const preset = form.presets.find((item) => item.id === presetId) ?? form.presets[0]!;
  const fields = inputFields(form, preset);
  const problems = formProblems(form, preset, values);
  const needsInvestigation =
    presetUses(form, preset, "file") ||
    presetUses(form, preset, "folder") ||
    presetUses(form, preset, "output");
  const targetField = fields.find((field) => field.type === "target");
  const targetValue = targetField ? effectiveValue(targetField, values) : "";
  const verdict = useMemo(
    () =>
      targetField && targetValue && !problems[targetField.id]
        ? scope
          ? evaluateTarget(targetValue, scope)
          : { ...evaluateTarget(targetValue, undefined), allowed: false, reason: "no_scope" as const }
        : null,
    [targetField, targetValue, problems, scope],
  );
  const fileName = (id: string) => files.find((file) => file.id === id)?.originalName ?? id;
  const tokens = previewTokens(form, preset, values, {
    file: fileName,
    folder: t("lab.wb.folderToken"),
    output: t("lab.wb.outputToken"),
  });
  const eula = preset.argv.includes("-accepteula");
  const gui = preset.launch === "gui";

  const sentenceValues: Record<string, string> = {};
  for (const field of form.fields) {
    const value = effectiveValue(field, values);
    sentenceValues[field.id] = field.type === "file" && value ? fileName(value) : value;
  }

  const missing = fields.filter((field) => problems[field.id] === "required");
  const invalid = fields.filter((field) => problems[field.id] === "invalid");
  const blockedReason =
    state === "changed"
      ? t("lab.tools.blocked.changed")
      : state === "disabled"
        ? t("lab.tools.blocked.disabled")
        : needsInvestigation && !engagementId
          ? t("lab.wb.needsInvestigation")
          : invalid.length > 0
            ? t("lab.wb.problem.invalid", { name: invalid.map((f) => fieldLabel(tf, f)).join(", ") })
            : missing.length > 0
              ? t("lab.tools.blocked.fill", { names: missing.map((f) => fieldLabel(tf, f)).join(", ") })
              : verdict && !verdict.allowed
                ? t("lab.tools.blocked.scope")
                : "";

  const setValue = (id: string, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));
    setError("");
  };

  const run = async () => {
    if (blockedReason) return;
    setError("");
    if (gui) {
      setBusy(true);
      try {
        const result = await getBridge().toolSupervisor.launchDetached(installation.id, []);
        if (!result.ok) setError(launchFailureMessage(t, result.reason, installation.displayName));
      } finally {
        setBusy(false);
      }
      return;
    }
    let attestation: NativeScopeAttestation | undefined;
    if (targetField) {
      const gate = scopeAttestationFor(targetValue, scope);
      if (!gate.ok) {
        setError(`${t("lab.tools.scopeBlocked")}: ${scopeDecisionLabel(t, gate.reason)}`);
        return;
      }
      attestation = gate.attestation;
    }
    const sent: Record<string, string> = {};
    for (const field of fields) sent[field.id] = effectiveValue(field, values);
    const targetRecord = targetValue
      ? targets.find((target) => target.raw === targetValue || target.normalized === targetValue)
      : undefined;
    setBusy(true);
    try {
      const started = await toolFormRuns.run({
        installationId: installation.id,
        formId: form.id,
        presetId: preset.id,
        engagementId,
        targetId: targetRecord?.id,
        values: sent,
        scope: attestation,
      });
      // A refused start shows its reason in the result below.
      onStarted(started, preset);
    } catch (caught) {
      setError(formRunError(t, tf, String(caught).replace(/^Error:\s*/, ""), installation.displayName));
    } finally {
      setBusy(false);
    }
  };

  const fileField = (field: FormField): ReactNode => {
    const usable = files.filter(
      (file) => !file.missing && (!field.accepts?.length || field.accepts.includes(file.kind)),
    );
    const current = values[field.id] ?? "";
    return (
      <Field key={field.id} label={fieldLabel(tf, field)} className="wb-field wb-field--wide">
        {(id) => (
          <>
          <div className="wb-file">
            <select
              id={id}
              className="select"
              value={usable.some((file) => file.id === current) ? current : ""}
              onChange={(event) => setValue(field.id, event.target.value)}
              disabled={!engagementId}
            >
              <option value="">{usable.length ? t("lab.wb.filePick") : t("lab.wb.fileNone")}</option>
              {usable.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.originalName} · {file.kind}
                </option>
              ))}
            </select>
            {engagementId && getBridge().mode === "tauri" && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() =>
                  void pickFiles(engagementId, t("lab.wb.fileAdd")).catch((caught: unknown) =>
                    setError(formRunError(t, tf, String(caught), installation.displayName)),
                  )
                }
              >
                <FilePlus2 size={13} aria-hidden /> {t("lab.wb.fileAdd")}
              </button>
            )}
          </div>
          {field.accepts?.length ? (
            <small className="wb-field__note">
              {t("lab.wb.fileKinds", { kinds: field.accepts.join(", ") })}
            </small>
          ) : null}
          </>
        )}
      </Field>
    );
  };

  const valueField = (field: FormField): ReactNode => {
    const showProblem = touched[field.id] && problems[field.id];
    return (
      <Field
        key={field.id}
        label={fieldLabel(tf, field)}
        className={`wb-field${field.type === "target" || field.type === "text" ? " wb-field--wide" : ""}`}
      >
        {(id) => (
          <>
            <input
              id={id}
              className={`input${field.type === "text" && field.id !== "expr" && field.id !== "filter" ? "" : " input--mono"}`}
              type={field.type === "int" ? "number" : "text"}
              min={field.min}
              max={field.max}
              inputMode={field.type === "int" || field.type === "ports" ? "numeric" : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.default || undefined}
              value={values[field.id] ?? ""}
              list={field.type === "target" && targets.length > 0 ? listId : undefined}
              aria-invalid={showProblem ? true : undefined}
              aria-describedby={`${id}-note`}
              onChange={(event) => setValue(field.id, event.target.value)}
              onBlur={() => setTouched((current) => ({ ...current, [field.id]: true }))}
            />
            <small
              id={`${id}-note`}
              className={`wb-field__note${showProblem ? " is-error" : ""}`}
            >
              {showProblem
                ? t(
                    problems[field.id] === "required"
                      ? "lab.wb.problem.required"
                      : "lab.wb.problem.invalid",
                    { name: fieldLabel(tf, field) },
                  )
                : fieldHelp(tf, field)}
            </small>
            {field.type === "target" && targets.length > 0 && (
              <datalist id={listId}>
                {targets.map((target) => (
                  <option key={target.id} value={target.normalized || target.raw} />
                ))}
              </datalist>
            )}
          </>
        )}
      </Field>
    );
  };

  return (
    <div className="wb-form">
      {form.presets.length > 1 && (
        <div className="wb-presets" role="radiogroup" aria-labelledby={groupId}>
          <span id={groupId} className="wb-eyebrow wb-presets__label">
            {t("lab.wb.presets")}
          </span>
          {form.presets.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === preset.id}
              className={`wb-preset${item.id === preset.id ? " is-active" : ""}`}
              onClick={() => {
                setPresetId(item.id);
                setError("");
              }}
            >
              {item.network && <Globe size={12} aria-hidden />}
              {tf(formKey(form, `${item.id}.label`))}
            </button>
          ))}
        </div>
      )}

      {needsInvestigation && !engagementId && (
        <p className="wb-note wb-note--warn">
          <ShieldAlert size={14} aria-hidden /> {t("lab.wb.needsInvestigation")}
        </p>
      )}

      {fields.length > 0 && (
        <div className="wb-fields">
          {fields.map((field) => (field.type === "file" ? fileField(field) : valueField(field)))}
        </div>
      )}

      {presetUses(form, preset, "folder") && engagementId && (
        <p className="wb-note">{t("lab.wb.folderNote", { count: files.length })}</p>
      )}
      {presetUses(form, preset, "output") && (
        <p className="wb-note">{t("lab.wb.outputNote")}</p>
      )}

      {targetField && (
        <p
          className={`lab-tool-verdict${verdict ? (verdict.allowed ? " is-ok" : " is-blocked") : ""}`}
          data-testid="wb-scope-verdict"
        >
          {verdict ? (
            verdict.allowed ? (
              <CheckCircle2 size={14} aria-hidden />
            ) : (
              <AlertTriangle size={14} aria-hidden />
            )
          ) : (
            <ShieldAlert size={14} aria-hidden />
          )}
          {verdict ? scopeDecisionLabel(t, verdict.reason) : t("lab.tools.scopeNoTarget")}
        </p>
      )}

      <figure className="wb-sentence" aria-live="polite">
        <figcaption className="wb-eyebrow">{t("lab.wb.willRun")}</figcaption>
        <p className="wb-sentence__text">
          <Sentence template={tf(formKey(form, `${preset.id}.summary`))} values={sentenceValues} />
        </p>
        {!gui && (
          <code className="wb-sentence__cmd" aria-label={t("lab.wb.command")}>
            <span aria-hidden>$ </span>
            {[executableName(installation).replace(/\.exe$/i, ""), ...tokens].map(quoteToken).join(" ")}
          </code>
        )}
        {preset.network && (
          <p className="wb-note wb-note--warn">
            <Globe size={13} aria-hidden /> {t("lab.wb.network", { hosts: preset.network })}
          </p>
        )}
        {eula && <p className="wb-note">{t("lab.wb.eula")}</p>}
      </figure>

      {error && (
        <p className="wb-note wb-note--danger" role="alert">
          <AlertTriangle size={14} aria-hidden /> {error}
        </p>
      )}

      <div className="wb-run-bar">
        {/* A field not filled in yet is a hint, not a mistake: it stays quiet. */}
        <p
          className={`wb-run-bar__hint${
            blockedReason && !(missing.length > 0 && invalid.length === 0 && state === "ready")
              ? " is-blocked"
              : ""
          }`}
        >
          {blockedReason || (gui ? t("lab.tools.kindHint.gui") : t("lab.wb.ready"))}
        </p>
        <button
          type="button"
          className="btn btn--primary wb-run-btn"
          onClick={() => void run()}
          disabled={busy || Boolean(blockedReason)}
        >
          {gui ? <ExternalLink size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          {gui ? t("lab.wb.open") : t("lab.tools.launch")}
        </button>
      </div>
    </div>
  );
}
