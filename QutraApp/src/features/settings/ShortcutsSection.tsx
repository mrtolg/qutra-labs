import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, RotateCcw, Search, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { getDb, usePreferences } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  assignBinding,
  bindingKeys,
  bindingText,
  checkBinding,
  effectiveBindings,
  eventToBinding,
  keyLabel,
  shortcutDef,
  type BindingWarnings,
  type Overrides,
  type ShortcutDef,
} from "@/lib/shortcuts";
import "./shortcuts.css";

/** A binding waiting for the user's yes, because it takes something away. */
interface Pending {
  id: string;
  binding: string;
  warnings: BindingWarnings;
}

/**
 * Settings › Shortcuts: every shortcut by group, with a search. Choosing a
 * binding records the next key combination; one that another shortcut uses,
 * or that text editing or the window needs, waits for a yes. Changes are
 * stored at once and the app's one key handler reads them from the registry.
 */
export function ShortcutsSection() {
  const { t } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const overrides: Overrides = prefs.shortcutBindings;
  const map = useMemo(() => effectiveBindings(overrides), [overrides]);

  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const label = (def: ShortcutDef) =>
    def.areaKey ? `${t(def.areaKey)} › ${t(def.labelKey)}` : t(def.labelKey);
  const customized = SHORTCUTS.filter((def) => def.id in overrides).length;

  const save = async (next: Overrides, message: string) => {
    try {
      await getDb().prefs.setDurable({ shortcutBindings: next });
      announce(message);
    } catch {
      toast({ kind: "danger", messageKey: "settings.prefsSaveFailed" });
    }
  };

  const assign = (id: string, binding: string | null) => {
    const def = shortcutDef(id);
    if (!def) return;
    setPending(null);
    setError(null);
    void save(
      assignBinding(overrides, id, binding),
      binding
        ? t("shortcuts.assigned", { action: label(def), keys: bindingText(binding) })
        : t("shortcuts.cleared", { action: label(def) }),
    );
  };

  /** Assign now, or ask first when the binding takes something away. */
  const offer = (id: string, binding: string): boolean => {
    const check = checkBinding(id, binding, map);
    if (!check.ok) {
      const { block } = check;
      setError({
        id,
        message:
          block.kind === "needsModifier"
            ? t("shortcuts.needsModifier")
            : t("shortcuts.systemKey", { keys: bindingText(binding), reason: t(block.reasonKey) }),
      });
      return false;
    }
    if (check.warnings.reservedKey || check.warnings.takenBy) {
      setPending({ id, binding, warnings: check.warnings });
      return true;
    }
    assign(id, binding);
    return true;
  };

  const stopRecording = () => {
    setRecording(null);
    setHeld(null);
  };

  const onRecordKey = (id: string, e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      stopRecording();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      stopRecording();
      return;
    }
    const binding = eventToBinding(e.nativeEvent);
    if (!binding) {
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
      setHeld(mods.length ? mods.join("+") : null);
      return;
    }
    if (offer(id, binding)) stopRecording();
    else setHeld(null);
  };

  const resetOne = (def: ShortcutDef) => {
    if (def.defaultBinding === null) assign(def.id, null);
    else if (offer(def.id, def.defaultBinding)) stopRecording();
  };

  const resetAll = () => {
    setConfirmResetAll(false);
    setPending(null);
    setError(null);
    void save({}, t("shortcuts.allReset"));
  };

  const q = query.trim().toLocaleLowerCase();
  const matches = (def: ShortcutDef) => {
    if (!q) return true;
    const binding = map[def.id];
    // "ctrl+shift+t" is a key search: whole keys from the left, so it finds
    // Ctrl+Shift+T and not Ctrl+Shift+Tab; "ctrl+shift" finds both.
    if (q.includes("+") && q.length > 1) {
      if (!binding) return false;
      const want = q.split("+").map((k) => k.trim());
      const have = bindingKeys(binding).map((k) => k.toLocaleLowerCase());
      return want.length <= have.length && want.every((k, i) => k === have[i]);
    }
    const group = SHORTCUT_GROUPS.find((g) => g.id === def.group);
    return [label(def), group ? t(group.labelKey) : "", binding ? bindingText(binding) : ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(q);
  };
  const groups = SHORTCUT_GROUPS.map((group) => ({
    ...group,
    items: SHORTCUTS.filter((def) => def.group === group.id && matches(def)),
  })).filter((group) => group.items.length > 0);

  return (
    <section className="settings-section shortcuts">
      <div className="shortcuts-tools">
        <div className="shortcuts-search-field">
          <label className="field-label" htmlFor="shortcuts-search">
            {t("shortcuts.search")}
          </label>
          <label className="shortcuts-search">
            <Search size={14} aria-hidden />
            <input
              id="shortcuts-search"
              type="search"
              value={query}
              placeholder={t("shortcuts.searchPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={customized === 0}
          onClick={() => setConfirmResetAll(true)}
        >
          <RotateCcw size={13} aria-hidden /> {t("shortcuts.resetAll")}
        </button>
      </div>
      <p className="shortcuts-intro">{t("shortcuts.intro")}</p>

      {confirmResetAll && (
        <div className="shortcuts-confirm" role="alert">
          <span>{t("shortcuts.resetAllConfirm", { count: customized })}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmResetAll(false)}>
            {t("action.cancel")}
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={resetAll}>
            {t("shortcuts.resetAllYes")}
          </button>
        </div>
      )}

      {groups.length === 0 && <p className="shortcuts-empty">{t("shortcuts.noMatch", { query })}</p>}

      {groups.map((group) => (
        <div className="shortcuts-group" key={group.id} role="group" aria-labelledby={`shortcuts-${group.id}`}>
          <h4 className="shortcuts-group__title" id={`shortcuts-${group.id}`}>
            {t(group.labelKey)}
            <span className="shortcuts-group__count">{group.items.length}</span>
          </h4>
          <ul className="shortcuts-list">
            {group.items.map((def) => {
              const binding = map[def.id];
              const isRecording = recording === def.id;
              const changed = def.id in overrides;
              const name = label(def);
              return (
                <li key={def.id} className="shortcut-row" data-changed={changed || undefined}>
                  <span className="shortcut-row__name">
                    {def.areaKey && <span className="shortcut-row__area">{t(def.areaKey)} › </span>}
                    {t(def.labelKey)}
                  </span>
                  <div className="shortcut-row__binding">
                    <button
                      type="button"
                      className="shortcut-keys"
                      data-recording={isRecording || undefined}
                      aria-label={
                        isRecording
                          ? t("shortcuts.recordingLabel", { action: name })
                          : binding
                            ? t("shortcuts.changeLabel", { action: name, keys: bindingText(binding) })
                            : t("shortcuts.assignLabel", { action: name })
                      }
                      onClick={() => {
                        setError(null);
                        setPending(null);
                        setRecording(isRecording ? null : def.id);
                        setHeld(null);
                      }}
                      onKeyDown={isRecording ? (e) => onRecordKey(def.id, e) : undefined}
                      onBlur={isRecording ? stopRecording : undefined}
                    >
                      {isRecording ? (
                        <span className="shortcut-keys__prompt">
                          {held ? <Keys binding={held} trailing /> : t("shortcuts.pressKeys")}
                        </span>
                      ) : binding ? (
                        <Keys binding={binding} />
                      ) : (
                        <span className="shortcut-keys__none">{t("shortcuts.none")}</span>
                      )}
                    </button>
                    <span className="shortcut-row__actions">
                      {binding && !isRecording && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm"
                          aria-label={t("shortcuts.clearLabel", { action: name })}
                          title={t("shortcuts.clear")}
                          onClick={() => assign(def.id, null)}
                        >
                          <X size={13} aria-hidden />
                        </button>
                      )}
                      {changed && !isRecording && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm"
                          aria-label={t("shortcuts.resetLabel", { action: name })}
                          title={
                            def.defaultBinding
                              ? t("shortcuts.resetTo", { keys: bindingText(def.defaultBinding) })
                              : t("shortcuts.resetToNone")
                          }
                          onClick={() => resetOne(def)}
                        >
                          <RotateCcw size={13} aria-hidden />
                        </button>
                      )}
                    </span>
                  </div>
                  {isRecording && !error && <p className="shortcut-row__hint">{t("shortcuts.recordingHint")}</p>}
                  {error?.id === def.id && (
                    <p className="shortcut-row__error" role="alert">
                      {error.message}
                    </p>
                  )}
                  {pending?.id === def.id && (
                    <ConflictNote
                      pending={pending}
                      otherName={(id) => {
                        const other = shortcutDef(id);
                        return other ? label(other) : id;
                      }}
                      onCancel={() => setPending(null)}
                      onConfirm={() => assign(pending.id, pending.binding)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Keys({ binding, trailing = false }: { binding: string; trailing?: boolean }) {
  const keys = bindingKeys(binding);
  return (
    <span className="keycaps" aria-hidden>
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} className="keycap">
          {keyLabel(key)}
        </kbd>
      ))}
      {trailing && <span className="keycaps__more">+ …</span>}
    </span>
  );
}

function ConflictNote({
  pending,
  otherName,
  onCancel,
  onConfirm,
}: {
  pending: Pending;
  otherName: (id: string) => string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  const keys = bindingText(pending.binding);
  const lines: string[] = [];
  if (pending.warnings.takenBy) {
    lines.push(t("shortcuts.takenBy", { keys, action: otherName(pending.warnings.takenBy) }));
  }
  if (pending.warnings.reservedKey) {
    lines.push(t("shortcuts.reservedWarn", { keys, reason: t(pending.warnings.reservedKey as MessageKey) }));
  }
  return (
    <div className="shortcut-conflict" role="alert">
      <AlertTriangle size={15} aria-hidden className="shortcut-conflict__icon" />
      <div className="shortcut-conflict__text">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="shortcut-conflict__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel}>
          {t("action.cancel")}
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onConfirm} ref={confirmRef}>
          {pending.warnings.takenBy ? t("shortcuts.replace") : t("shortcuts.assignAnyway")}
        </button>
      </div>
    </div>
  );
}
