import { Copy, Plus, Save, Star, Trash2 } from "lucide-react";
import type { ArgDef, ToolProfile } from "@/domain/lab";
import { Field } from "@/components/ui/Field";
import { useT } from "@/lib/i18n";
import { newArg } from "./toolArgs";
import { ARG_TYPES, argTypeLabel } from "./toolLabels";

/**
 * Advanced settings of one run setting (a "profile"): how the program opens,
 * how long it may run, which arguments it takes and how each is passed.
 * Values are filled in on the run card; here the arguments are defined.
 */
export function ToolProfileEditor({
  draft,
  onDraftChange,
  onSave,
  onNewProfile,
  onDuplicate,
  onDelete,
}: {
  draft: ToolProfile;
  onDraftChange: (next: ToolProfile) => void;
  onSave: () => void;
  onNewProfile: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const set = (changes: Partial<ToolProfile>) => onDraftChange({ ...draft, ...changes });

  const updateArg = (id: string, changes: Partial<ArgDef>) =>
    set({ args: draft.args.map((arg) => (arg.id === id ? { ...arg, ...changes } : arg)) });

  const removeArg = (id: string) =>
    set({
      args: draft.args.filter((arg) => arg.id !== id).map((arg, order) => ({ ...arg, order })),
      values: Object.fromEntries(Object.entries(draft.values).filter(([key]) => key !== id)),
    });

  const addArg = () =>
    set({
      args: [
        ...draft.args,
        newArg(t("lab.tools.argDefaultName", { n: draft.args.length + 1 }), draft.args.length),
      ],
    });

  return (
    <div className="lab-profile-editor">
      <div className="lab-profile-bar">
        <Field label={t("lab.tools.profileName")} className="lab-profile-name">
          {(id) => (
            <input
              id={id}
              className="input"
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          )}
        </Field>
        <button type="button" className="btn btn--sm" onClick={onNewProfile}>
          <Plus size={13} aria-hidden /> {t("lab.tools.newProfile")}
        </button>
        <button type="button" className="btn btn--sm" onClick={onDuplicate}>
          <Copy size={13} aria-hidden /> {t("action.duplicate")}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDelete}>
          <Trash2 size={13} aria-hidden /> {t("action.delete")}
        </button>
      </div>

      <div className="lab-profile-grid">
        <Field label={t("lab.tools.launchKind")}>
          {(id) => (
            <select
              id={id}
              className="select"
              value={draft.launchKind}
              onChange={(event) =>
                set({ launchKind: event.target.value as ToolProfile["launchKind"] })
              }
            >
              <option value="gui">{t("lab.tools.kindGui")}</option>
              <option value="interactive">{t("lab.tools.kindInteractive")}</option>
              <option value="batch">{t("lab.tools.kindBatch")}</option>
            </select>
          )}
        </Field>
        <Field label={t("lab.tools.timeout")}>
          {(id) => (
            <input
              id={id}
              className="input"
              type="number"
              min={1}
              max={3600}
              value={draft.timeoutSec}
              onChange={(event) => set({ timeoutSec: Number(event.target.value) })}
            />
          )}
        </Field>
        <Field label={t("lab.tools.outputFormat")}>
          {(id) => (
            <select
              id={id}
              className="select"
              value={draft.parser}
              onChange={(event) => set({ parser: event.target.value })}
            >
              <option value="">{t("lab.tools.plainText")}</option>
              <option value="sarif">SARIF</option>
              <option value="nmap">Nmap XML</option>
            </select>
          )}
        </Field>
        <Field label={t("lab.tools.concurrency")}>
          {(id) => (
            <select
              id={id}
              className="select"
              value={draft.concurrencyClass}
              onChange={(event) => set({ concurrencyClass: event.target.value })}
            >
              <option value="default">{t("lab.tools.shared")}</option>
              <option value="exclusive">{t("lab.tools.exclusive")}</option>
            </select>
          )}
        </Field>
      </div>

      <div className="lab-profile-checks">
        <label>
          <input
            type="checkbox"
            checked={draft.requiresScope}
            onChange={(event) => set({ requiresScope: event.target.checked })}
          />
          {t("lab.tools.requireScope")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.favorite}
            onChange={(event) => set({ favorite: event.target.checked })}
          />
          <Star size={13} aria-hidden /> {t("action.favorite")}
        </label>
      </div>

      <div className="lab-args-head">
        <div>
          <h5>{t("lab.tools.arguments")}</h5>
          <p>{t("lab.tools.argumentsHint")}</p>
        </div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={addArg}>
          <Plus size={13} aria-hidden /> {t("lab.tools.addArgument")}
        </button>
      </div>

      {draft.args.length > 0 && (
        <div className="lab-arg-list">
          {draft.args.map((arg) => (
            <div className="lab-arg-row" key={arg.id}>
              <Field label={t("lab.tools.argumentName")}>
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    value={arg.name}
                    onChange={(event) => updateArg(arg.id, { name: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t("lab.tools.flag")}>
                {(id) => (
                  <input
                    id={id}
                    className="input input--mono"
                    value={arg.flag}
                    onChange={(event) => updateArg(arg.id, { flag: event.target.value })}
                    placeholder="--flag"
                  />
                )}
              </Field>
              <Field label={t("lab.tools.argumentType")}>
                {(id) => (
                  <select
                    id={id}
                    className="select"
                    value={arg.type}
                    onChange={(event) =>
                      updateArg(arg.id, { type: event.target.value as ArgDef["type"] })
                    }
                  >
                    {ARG_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {argTypeLabel(t, type)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <label className="lab-arg-check">
                <input
                  type="checkbox"
                  checked={arg.required}
                  onChange={(event) => updateArg(arg.id, { required: event.target.checked })}
                />
                {t("lab.tools.required")}
              </label>
              <label className="lab-arg-check">
                <input
                  type="checkbox"
                  checked={arg.sensitive}
                  onChange={(event) => updateArg(arg.id, { sensitive: event.target.checked })}
                />
                {t("lab.tools.sensitive")}
              </label>
              <button
                type="button"
                className="btn btn--icon btn--sm"
                onClick={() => removeArg(arg.id)}
                aria-label={`${t("action.remove")}: ${arg.name}`}
                title={t("action.remove")}
              >
                <Trash2 size={13} aria-hidden />
              </button>
              {arg.type === "enum" && (
                <Field label={t("lab.tools.enumValues")} className="lab-arg-row__wide">
                  {(id) => (
                    <input
                      id={id}
                      className="input input--mono"
                      value={arg.enumValues.join(", ")}
                      onChange={(event) =>
                        // Empty entries stay while typing ("a, " must keep its
                        // comma); the run card ignores them.
                        updateArg(arg.id, {
                          enumValues: event.target.value.split(",").map((value) => value.trim()),
                        })
                      }
                    />
                  )}
                </Field>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="lab-profile-save">
        <button type="button" className="btn btn--secondary" onClick={onSave}>
          <Save size={14} aria-hidden /> {t("lab.tools.saveProfile")}
        </button>
      </div>
    </div>
  );
}
