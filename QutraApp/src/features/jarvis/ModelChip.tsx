import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, Cpu, RotateCw, SlidersHorizontal } from "lucide-react";
import type { ModelChoice } from "@/domain/conversations";
import { getDb, usePreferences } from "@/lib/db/database";
import { createConversation, setConversationModel } from "@/lib/db/conversations";
import { useT } from "@/lib/i18n";
import { ensureLocalEngine } from "@/lib/localEngine/autoEngine";
import { friendlyModelName } from "@/lib/modelNames";
import { connectionName } from "./CloudParts";
import {
  choiceOf,
  defaultModel,
  sameModel,
  setDefaultModel,
  targetOf,
  type ResolvedModel,
} from "./jarvisModel";
import { useJarvisUi } from "./jarvisUi";
import { useModelOptions, type CloudOption } from "./useModelOptions";

type Translate = ReturnType<typeof useT>["t"];

/** A model's name as the chip and the lists show it. */
export function modelLabel(t: Translate, model: Pick<ResolvedModel, "provider" | "preset" | "model">): string {
  const target = targetOf(model);
  if (!target) return model.model || t("jarvis.model.none");
  const name = connectionName(t, target);
  if (!model.model) return name;
  // A readable name stands on its own; an id this build cannot read keeps its connection.
  return friendlyModelName(model.model) ?? `${name} · ${model.model}`;
}

/** Why a cloud connection cannot be chosen yet, or null when it can. */
export function cloudBlocker(t: Translate, option: CloudOption): string | null {
  if (option.key?.present === false) return t("jarvis.model.noKey");
  if (!option.model) return t("jarvis.model.noModel");
  return null;
}

/**
 * The composer's model chip: the model this
 * conversation's next answer comes from, and a quick switch to another one.
 * A choice made here is this conversation's own; the default for the others
 * is set in Jarvis's settings, or from here with "Make default".
 */
export function ModelChip({
  conversationId,
  resolved,
  disabled,
}: {
  conversationId: string | null;
  resolved: ResolvedModel;
  disabled?: boolean;
}) {
  const { t } = useT();
  const prefs = usePreferences();
  const openSettings = useJarvisUi((state) => state.openSettings);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { local, cloud, cloudAvailable, retry } = useModelOptions(open);
  const name = useId();
  const fallback = defaultModel(prefs);
  const isLocal = resolved.provider === "local";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (choice: ModelChoice | null) => {
    // A local model, even for this conversation only, gets the engine ready now.
    if (choice?.provider === "local") void ensureLocalEngine(choice.model, { explicit: true });
    const db = getDb();
    const write = conversationId
      ? setConversationModel(db, conversationId, choice)
      : choice
        ? createConversation(db, { model: choice })
        : Promise.resolve();
    write.catch((caught: unknown) => console.error("model choice not kept", caught));
  };

  const chosen = (candidate: Pick<ResolvedModel, "provider" | "preset" | "model">) =>
    sameModel(candidate, resolved);

  const localNames =
    local.kind === "ready"
      ? Array.from(
          new Set([
            ...local.models.map((m) => m.name),
            // The chosen model stays listed when the engine does not report it.
            ...(isLocal && resolved.model ? [resolved.model] : []),
          ]),
        )
      : [];

  const option = (
    key: string,
    candidate: Pick<ResolvedModel, "provider" | "preset" | "model">,
    label: string,
    note?: string | null,
  ) => {
    const checked = chosen(candidate);
    const blocked = Boolean(note) && !checked;
    const choice = choiceOf(candidate);
    return (
      <label
        key={key}
        className={blocked ? "jvm-opt is-blocked" : "jvm-opt"}
        title={candidate.model || undefined}
      >
        <input
          type="radio"
          name={name}
          checked={checked}
          disabled={blocked || !choice}
          onChange={() => choice && choose(choice)}
        />
        <span className="jvm-opt__mark" aria-hidden>
          {checked && <Check size={12} />}
        </span>
        <span className="jvm-opt__t">{label}</span>
        {note && <span className="jvm-opt__note">{note}</span>}
      </label>
    );
  };

  return (
    <div className="jvm" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={resolved.own ? "jvm-chip is-own" : "jvm-chip"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={t("jarvis.model.chipTitle")}
        data-testid="jarvis-model-chip"
        onClick={() => setOpen((v) => !v)}
      >
        {isLocal ? <Cpu size={13} aria-hidden /> : <Cloud size={13} aria-hidden />}
        <span className="sr-only">{t("jarvis.model.label")}: </span>
        <span className="jvm-chip__name" title={resolved.model || undefined}>
          {modelLabel(t, resolved)}
        </span>
        {resolved.own && <span className="jvm-chip__own">{t("jarvis.model.own")}</span>}
        <ChevronDown size={13} className="jvm-chip__chev" aria-hidden />
      </button>

      {open && (
        <div className="jvm-pop" role="dialog" aria-label={t("jarvis.model.pick")}>
          <fieldset className="jvm-group">
            <legend className="jvm-group__t">
              <Cpu size={12} aria-hidden /> {t("jarvis.model.local")}
            </legend>
            {local.kind === "loading" && <p className="jvm-state">{t("jarvis.model.loading")}</p>}
            {local.kind === "off" && <p className="jvm-state">{t("jarvis.model.localOff")}</p>}
            {local.kind === "unreachable" && (
              <p className="jvm-state jvm-state--warn">
                <span>{t("jarvis.model.localUnreachable")}</span>
                <button type="button" className="asst-linkbtn" onClick={retry}>
                  <RotateCw size={11} aria-hidden /> {t("jarvis.model.retry")}
                </button>
              </p>
            )}
            {local.kind === "ready" && localNames.length === 0 && (
              <p className="jvm-state">{t("jarvis.model.localNone")}</p>
            )}
            {localNames.map((model) =>
              option(
                `local:${model}`,
                { provider: "local", model },
                model,
                local.kind === "ready" && !local.models.some((m) => m.name === model)
                  ? t("jarvis.model.notInstalled")
                  : null,
              ),
            )}
          </fieldset>

          <fieldset className="jvm-group">
            <legend className="jvm-group__t">
              <Cloud size={12} aria-hidden /> {t("jarvis.model.cloud")}
            </legend>
            {!cloudAvailable && <p className="jvm-state">{t("jarvis.model.cloudDesktopOnly")}</p>}
            {cloud.map((c) => {
              const candidate = {
                provider: c.target.provider,
                ...(c.target.provider === "openai_compat" ? { preset: c.target.preset } : {}),
                model: c.model,
              } as const;
              return option(
                c.target.provider === "anthropic" ? "anthropic" : `compat:${c.target.preset}`,
                candidate,
                modelLabel(t, candidate),
                cloudBlocker(t, c),
              );
            })}
          </fieldset>

          <div className="jvm-foot">
            <p className="jvm-foot__def">
              {t("jarvis.model.defaultIs", { name: modelLabel(t, fallback) })}
            </p>
            <div className="jvm-foot__acts">
              {resolved.own && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => choose(null)}>
                  {t("jarvis.model.useDefault")}
                </button>
              )}
              {resolved.own && !sameModel(resolved, fallback) && choiceOf(resolved) && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    const choice = choiceOf(resolved);
                    if (!choice) return;
                    setDefaultModel(getDb(), choice);
                    choose(null);
                  }}
                >
                  {t("jarvis.model.makeDefault")}
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setOpen(false);
                  openSettings("model");
                }}
              >
                <SlidersHorizontal size={12} aria-hidden /> {t("jarvis.model.settings")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
