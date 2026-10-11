import { useId } from "react";
import { AlertTriangle, CheckCircle2, Play, Plus, ShieldAlert } from "lucide-react";
import type { ArgDef, AuthorizationScope, Target, ToolProfile } from "@/domain/lab";
import type { BuiltCommand } from "@/domain/lab/command";
import { evaluateTarget, type ScopeDecision } from "@/domain/lab/scope";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { Field } from "@/components/ui/Field";
import { useT } from "@/lib/i18n";
import {
  argErrorText,
  launchKindHint,
  scopeDecisionLabel,
  toolState,
} from "./toolLabels";

/** The target a profile runs against, if it has a field for one. */
export function targetValueOf(profile: ToolProfile): string {
  const arg = profile.args.find((item) => item.type === "target");
  return arg ? (profile.values[arg.id] ?? arg.default ?? "").trim() : "";
}

/** True when a profile is meant to run inside the scope but has nowhere to
    say against what: the launch gate would refuse it every time. */
export function needsTargetField(profile: ToolProfile): boolean {
  return profile.requiresScope && !profile.args.some((arg) => arg.type === "target");
}

/** What the launch gate will decide for this profile's target, shown before
    the click. The gate in the panel stays the authority; this mirrors it,
    including refusing every target when the engagement has no scope. */
export function previewScope(
  profile: ToolProfile,
  scope: AuthorizationScope | undefined,
): ScopeDecision | null {
  if (!profile.requiresScope) return null;
  const value = targetValueOf(profile);
  if (!value) return null;
  if (!scope) return { ...evaluateTarget(value, undefined), allowed: false, reason: "no_scope" };
  return evaluateTarget(value, scope);
}

/**
 * Run a registered tool: pick a saved setting, fill in what it asks for
 * (a target from this engagement first of all), see the exact command, run.
 * Defining arguments lives under Advanced settings; this card only fills
 * them in.
 */
export function ToolRunCard({
  installation,
  profiles,
  selectedProfileId,
  onSelectProfile,
  draft,
  onDraftChange,
  built,
  scope,
  targets,
  busy,
  onLaunch,
  onAddTargetField,
  onCreateProfile,
}: {
  installation: NativeToolInstallation;
  profiles: ToolProfile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  draft: ToolProfile | null;
  onDraftChange: (next: ToolProfile) => void;
  built: BuiltCommand | null;
  scope?: AuthorizationScope;
  targets: Target[];
  busy: boolean;
  onLaunch: () => void;
  onAddTargetField: () => void;
  onCreateProfile: () => void;
}) {
  const { t } = useT();
  const headingId = useId();

  // Registered but never set up: say so and offer the one step that fixes
  // it, instead of an empty picker and a disabled Run.
  if (!draft) {
    return (
      <section className="lab-tool-run" aria-labelledby={headingId}>
        <h4 id={headingId} className="lab-tool-run__title">
          {t("lab.tools.run.title")}
        </h4>
        <div className="lab-tool-run__empty">
          <p>{t("lab.tools.run.noSetting")}</p>
          <button type="button" className="btn btn--primary" onClick={onCreateProfile}>
            <Plus size={14} aria-hidden /> {t("lab.tools.run.createDefault")}
          </button>
        </div>
      </section>
    );
  }

  const state = toolState(installation);
  const errors = built?.errors ?? [];
  // An empty required field is not a mistake yet: it is named in the hint,
  // not listed in red before the user has typed anything.
  const missing = errors.filter((error) => error.code === "required");
  const invalid = errors.filter((error) => error.code !== "required");
  const missingTarget = needsTargetField(draft);
  const verdict = previewScope(draft, scope);
  const args = [...draft.args].sort((a, b) => a.order - b.order);

  const blockedReason =
    state === "changed"
      ? t("lab.tools.blocked.changed")
      : state === "disabled"
        ? t("lab.tools.blocked.disabled")
        : missingTarget
          ? t("lab.tools.blocked.needsTarget")
          : draft.requiresScope && !targetValueOf(draft)
            ? t("lab.tools.blocked.pickTarget")
            : invalid.length > 0
              ? t("lab.tools.blocked.values")
              : missing.length > 0
                ? t("lab.tools.blocked.fill", {
                    names: missing.map((error) => error.name).join(", "),
                  })
                : verdict && !verdict.allowed
                  ? t("lab.tools.blocked.scope")
                  : "";

  const setValue = (arg: ArgDef, value: string) =>
    onDraftChange({ ...draft, values: { ...draft.values, [arg.id]: value } });

  return (
    <section className="lab-tool-run" aria-labelledby={headingId}>
      <h4 id={headingId} className="lab-tool-run__title">
        {t("lab.tools.run.title")}
      </h4>

      <div className="lab-tool-run__grid">
        <Field label={t("lab.tools.profile")}>
          {(id) => (
            <select
              id={id}
              className="select"
              value={selectedProfileId}
              onChange={(event) => onSelectProfile(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.favorite ? "★ " : ""}
                  {profile.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {args.map((arg) => (
          <ArgValueField
            key={arg.id}
            arg={arg}
            value={draft.values[arg.id] ?? arg.default}
            targets={targets}
            onChange={(value) => setValue(arg, value)}
          />
        ))}
      </div>

      {args.length === 0 && !missingTarget && (
        <p className="lab-tool-run__note">{t("lab.tools.run.noArgs")}</p>
      )}

      {missingTarget && (
        <div className="lab-tool-run__callout">
          <ShieldAlert size={15} aria-hidden />
          <p>{t("lab.tools.run.needsTarget")}</p>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onAddTargetField}>
            <Plus size={13} aria-hidden /> {t("lab.tools.run.addTarget")}
          </button>
        </div>
      )}

      {draft.requiresScope && !missingTarget && (
        <p
          className={`lab-tool-verdict${
            verdict ? (verdict.allowed ? " is-ok" : " is-blocked") : ""
          }`}
          data-testid="lab-tool-verdict"
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

      <div className="lab-command-preview">
        <span>{t("lab.tools.commandPreview")}</span>
        <code>{built?.preview || installation.displayName}</code>
      </div>

      {invalid.length > 0 && (
        <ul className="lab-command-errors">
          {invalid.map((error) => (
            <li key={`${error.argId}-${error.code}`}>{argErrorText(t, error, draft.args)}</li>
          ))}
        </ul>
      )}

      <div className="lab-tool-run__foot">
        <p className={`lab-tool-run__hint${blockedReason ? " is-blocked" : ""}`}>
          {blockedReason || launchKindHint(t, draft.launchKind)}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onLaunch}
          disabled={busy || Boolean(blockedReason)}
        >
          <Play size={14} aria-hidden /> {t("lab.tools.launch")}
        </button>
      </div>
    </section>
  );
}

function ArgValueField({
  arg,
  value,
  targets,
  onChange,
}: {
  arg: ArgDef;
  value: string;
  targets: Target[];
  onChange: (value: string) => void;
}) {
  const { t } = useT();
  const listId = useId();
  const label = (
    <>
      {arg.name}
      {arg.required && <span className="lab-arg-req"> *</span>}
      {arg.flag && <code className="lab-arg-flag">{arg.flag}</code>}
    </>
  );

  if (arg.type === "boolean") {
    return (
      <label className="lab-arg-bool">
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        {label}
      </label>
    );
  }

  return (
    <Field label={label} className={arg.type === "target" ? "lab-arg-wide" : undefined}>
      {(id) =>
        arg.type === "enum" ? (
          <select
            id={id}
            className="select"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            {!arg.required && <option value="">—</option>}
            {arg.enumValues.filter(Boolean).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id={id}
              className={`input${arg.type === "string" ? "" : " input--mono"}`}
              type={arg.sensitive ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              list={arg.type === "target" && targets.length > 0 ? listId : undefined}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder={arg.type === "target" ? t("lab.tools.run.targetPlaceholder") : undefined}
            />
            {arg.type === "target" && targets.length > 0 && (
              <datalist id={listId}>
                {targets.map((target) => (
                  <option key={target.id} value={target.normalized || target.raw} />
                ))}
              </datalist>
            )}
            {arg.help && <small className="lab-arg-help">{arg.help}</small>}
          </>
        )
      }
    </Field>
  );
}
