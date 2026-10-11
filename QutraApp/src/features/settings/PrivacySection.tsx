import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  CloudUpload,
  Database as DatabaseIcon,
  Download,
  Eye,
  HardDrive,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { clearAllConversations } from "@/lib/db/conversations";
import { aiConnections } from "@/lib/aiConnections";
import { useUi } from "@/state/ui";
import { createId } from "@/lib/id";
import { formatDate, formatNumber, now } from "@/lib/time";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { CollectionName, ExclusionRule } from "@/domain/types";
import {
  checkExclusion,
  EXCLUSION_MARKER,
  NEW_EXCLUSION_KINDS,
  type NewExclusionKind,
} from "./exclusionRules";
import "./settingsSections.css";

/** Where Rust keeps the database (`sqlite:contextos.db` in the app's data
    folder) and the investigation folders: data, so never translated. */
const DB_PATH = "%APPDATA%\\app.contextos.desktop\\contextos.db";
const FOLDERS_PATH = "Documents\\Qutra Labs";

const EXAMPLES: readonly { kind: NewExclusionKind; value: string }[] = [
  { kind: "pattern", value: "Acme Holding" },
  { kind: "domain", value: "corp.acme.local" },
  { kind: "path", value: "C:\\Clients\\Acme" },
];

/**
 * Settings › Privacy & exclusions: a map of what the app records, where it
 * keeps it, what never leaves and what goes to the cloud (and when); the
 * exclusions, which Rust masks in everything that goes out; and the stored
 * data, counted, with view, export and a confirmed clear.
 */
export function PrivacySection() {
  const { t } = useT();
  return (
    <section className="settings-section settings-section--wide privacy-page">
      <p className="muted settings-block-lede">{t("privacy2.lede")}</p>
      <DataMap />
      <Exclusions />
      <StoredData />
    </section>
  );
}

/* ---------- The data map ---------- */

function DataMap() {
  const { t } = useT();
  const prefs = usePreferences();
  const consents = useCollection("engagements").filter((e) => e.cloudConsent).length;
  const route =
    prefs.aiProvider === "anthropic"
      ? t("settings.cloud.anthropicName")
      : prefs.aiProvider === "openai_compat"
        ? t("settings.cloud.compatName")
        : t("settings.route.local");

  return (
    <div className="data-map" aria-label={t("privacy2.map.label")} role="group">
      <MapPanel tone="record" icon={<DatabaseIcon size={14} />} title={t("privacy2.map.recorded")}>
        <ul className="data-map__list">
          <li>{t("privacy2.map.recorded.investigations")}</li>
          <li>{t("privacy2.map.recorded.runs")}</li>
          <li>{t("privacy2.map.recorded.chats")}</li>
          <li>
            {t("privacy2.map.recorded.activity")}{" "}
            <span className={`data-map__chip${prefs.activityTrackingEnabled ? " is-on" : ""}`}>
              {prefs.activityTrackingEnabled ? t("perm2.stateOn") : t("perm2.stateOff")}
            </span>
          </li>
        </ul>
      </MapPanel>

      <MapPanel tone="where" icon={<HardDrive size={14} />} title={t("privacy2.map.where")}>
        <dl className="data-map__where">
          <dt>{t("privacy2.map.where.db")}</dt>
          <dd className="mono">{DB_PATH}</dd>
          <dt>{t("privacy2.map.where.folders")}</dt>
          <dd className="mono">{FOLDERS_PATH}</dd>
          <dt>{t("privacy2.map.where.keys")}</dt>
          <dd>{t("privacy2.map.where.keysValue")}</dd>
        </dl>
      </MapPanel>

      <MapPanel tone="never" icon={<ShieldCheck size={14} />} title={t("privacy2.map.never")}>
        <ul className="data-map__list">
          <li>{t("privacy2.map.never.files")}</li>
          <li>{t("privacy2.map.never.db")}</li>
          <li>{t("privacy2.map.never.local")}</li>
          <li>{t("privacy2.map.never.excluded")}</li>
        </ul>
      </MapPanel>

      <MapPanel tone="cloud" icon={<CloudUpload size={14} />} title={t("privacy2.map.cloud")}>
        <ul className="data-map__list">
          <li>
            {t("privacy2.map.cloud.questions")}
            <span className="data-map__live">{t("privacy2.map.cloud.route", { name: route })}</span>
          </li>
          <li>
            {t("privacy2.map.cloud.summary")}
            <span className="data-map__live">
              {t("privacy2.map.cloud.summaryCount", { count: consents })}
            </span>
          </li>
          <li>{t("privacy2.map.cloud.test")}</li>
        </ul>
        <p className="data-map__foot">{t("privacy2.map.cloud.sentLine")}</p>
      </MapPanel>
    </div>
  );
}

function MapPanel({
  tone,
  icon,
  title,
  children,
}: {
  tone: "record" | "where" | "never" | "cloud";
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={`data-map__panel data-map__panel--${tone}`}>
      <h4 className="data-map__title">
        <span className="data-map__icon" aria-hidden>
          {icon}
        </span>
        {title}
      </h4>
      {children}
    </div>
  );
}

/* ---------- Exclusions ---------- */

function Exclusions() {
  const { t, locale } = useT();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const rules = useCollection("exclusions");
  const sorted = useMemo(() => [...rules].sort((a, b) => b.createdAt - a.createdAt), [rules]);
  const [kind, setKind] = useState<NewExclusionKind>("pattern");
  const [value, setValue] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const check = checkExclusion(kind, value, getDb().collection("exclusions").getAll());
    if (!check.ok) {
      setError(check.error);
      return;
    }
    getDb().collection("exclusions").put({
      id: createId("exc"),
      kind,
      value: check.value,
      note: "",
      demo: false,
      createdAt: now(),
    });
    setValue("");
    setError(null);
    const message = t("privacy2.added", { value: check.value });
    toast({ kind: "success", message });
    announce(message);
  };

  const remove = (rule: ExclusionRule) => {
    getDb().collection("exclusions").remove(rule.id);
    const message = t("privacy2.removed", { value: rule.value });
    toast({
      kind: "info",
      message,
      actionKey: "action.undo",
      onAction: () => getDb().collection("exclusions").put(rule),
    });
    announce(message);
  };

  const errorId = "exclusion-value-error";
  // The marker is data: shown as code inside the translated sentence.
  const [whatBefore, whatAfter = ""] = t("privacy2.exclusions.what", { marker: "\u0000" }).split(
    "\u0000",
  );
  return (
    <div className="privacy-block">
      <h4 className="settings-block-heading">{t("privacy.exclusions")}</h4>
      <p className="settings-block-lede privacy-block__what">
        {whatBefore}
        <code className="mono privacy-block__marker">{EXCLUSION_MARKER}</code>
        {whatAfter}
      </p>

      <div className="exclusion-examples">
        <span className="faint exclusion-examples__label">{t("privacy2.examples")}</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.value}
            type="button"
            className="exclusion-example"
            onClick={() => {
              setKind(example.kind);
              setValue(example.value);
              setError(null);
            }}
          >
            <span className="exclusion-example__kind">
              {t(`privacy.exclusion.${example.kind}` as MessageKey)}
            </span>
            <span className="mono">{example.value}</span>
          </button>
        ))}
      </div>

      <form className="exclusion-form" onSubmit={add} noValidate>
        <div className="exclusion-form__kinds" role="radiogroup" aria-label={t("privacy.exclusionKind")}>
          {NEW_EXCLUSION_KINDS.map((option) => (
            <label key={option} className={`exclusion-kind${kind === option ? " is-selected" : ""}`}>
              <input
                type="radio"
                className="sr-only"
                name="exclusion-kind"
                value={option}
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                  setError(null);
                }}
              />
              {t(`privacy.exclusion.${option}` as MessageKey)}
            </label>
          ))}
        </div>
        <div className="exclusion-form__field">
          <label className="field-label" htmlFor="exclusion-value">
            {t("privacy2.value")}
          </label>
          <div className="exclusion-form__row">
            <input
              id="exclusion-value"
              className="input mono"
              value={value}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : "exclusion-kind-hint"}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              placeholder={EXAMPLES.find((example) => example.kind === kind)?.value}
            />
            <button type="submit" className="btn btn--primary">
              {t("privacy.addExclusion")}
            </button>
          </div>
          {error ? (
            <p className="form-error" id={errorId} role="alert">
              {t(error)}
            </p>
          ) : (
            <p className="field-hint" id="exclusion-kind-hint">
              {t(`privacy2.kind.${kind}.hint` as MessageKey)}
            </p>
          )}
        </div>
      </form>

      {sorted.length === 0 ? (
        <p className="settings-empty-line">{t("privacy2.exclusions.none")}</p>
      ) : (
        <ul className="exclusion-list" aria-label={t("privacy2.exclusions.listLabel")}>
          {sorted.map((rule) => (
            <li key={rule.id} className="exclusion-list__row">
              <span className="exclusion-list__kind">
                {t(`privacy.exclusion.${rule.kind}` as MessageKey)}
              </span>
              <span className="mono exclusion-list__value">{rule.value}</span>
              <span className="faint exclusion-list__date">
                {t("privacy2.addedOn", { date: formatDate(rule.createdAt, locale) })}
              </span>
              <button
                type="button"
                className="btn btn--icon btn--sm exclusion-list__remove"
                aria-label={`${t("action.remove")}: ${rule.value}`}
                onClick={() => remove(rule)}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <MaskTester />
    </div>
  );
}

/** Type a text and see it as Rust would send it: secrets and exclusions
    masked. Nothing leaves the machine. */
function MaskTester() {
  const { t } = useT();
  const [text, setText] = useState("");
  const [result, setResult] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string; masked: number } | { kind: "failed" }
  >({ kind: "idle" });
  const desktop = aiConnections.available();

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || result.kind === "busy") return;
    setResult({ kind: "busy" });
    try {
      const preview = await aiConnections.maskPreview(text);
      setResult({ kind: "done", text: preview.text, masked: preview.masked });
    } catch {
      setResult({ kind: "failed" });
    }
  };

  return (
    <form className="mask-tester" onSubmit={(e) => void run(e)}>
      <div className="mask-tester__head">
        <label className="settings-block-heading mask-tester__title" htmlFor="mask-tester-text">
          {t("privacy2.test.title")}
        </label>
        <p className="muted mask-tester__hint">{t("privacy2.test.hint")}</p>
      </div>
      {desktop ? (
        <>
          <div className="exclusion-form__row">
            <input
              id="mask-tester-text"
              className="input"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (result.kind !== "busy") setResult({ kind: "idle" });
              }}
              placeholder={t("privacy2.test.placeholder")}
            />
            <button type="submit" className="btn btn--secondary" disabled={!text.trim()}>
              {result.kind === "busy" && <Loader2 size={13} className="spin" aria-hidden />}
              {t("privacy2.test.run")}
            </button>
          </div>
          {result.kind === "done" && (
            <div className="mask-tester__result" role="status">
              <span className="faint">{t("privacy2.test.result", { count: result.masked })}</span>
              <code className="mono">{result.text}</code>
            </div>
          )}
          {result.kind === "failed" && (
            <p className="form-error" role="alert">
              {t("privacy2.test.failed")}
            </p>
          )}
        </>
      ) : (
        <p className="settings-empty-line">{t("privacy2.test.desktopOnly")}</p>
      )}
    </form>
  );
}

/* ---------- Stored data ---------- */

interface Category {
  id: CollectionName;
  name: MessageKey;
  hint: MessageKey;
  /** The page that shows these records, if one does. */
  view?: string;
  /** Only records nothing else points at can be cleared from here. */
  clearable: boolean;
}

const CATEGORIES: readonly Category[] = [
  { id: "engagements", name: "privacy2.data.engagements", hint: "privacy2.data.engagements.hint", view: "/lab", clearable: false },
  { id: "findings", name: "privacy2.data.findings", hint: "privacy2.data.findings.hint", view: "/lab", clearable: false },
  { id: "evidence", name: "privacy2.data.evidence", hint: "privacy2.data.evidence.hint", view: "/lab", clearable: false },
  { id: "toolRuns", name: "privacy2.data.toolRuns", hint: "privacy2.data.toolRuns.hint", view: "/tools", clearable: false },
  { id: "conversations", name: "privacy2.data.conversations", hint: "privacy2.data.conversations.hint", view: "/jarvis", clearable: true },
  { id: "events", name: "privacy2.data.events", hint: "privacy2.data.events.hint", clearable: true },
];

function StoredData() {
  const { t, locale } = useT();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const closeSettings = useUi((s) => s.closeSettings);
  // Subscribing keeps the counts live while the page is open.
  const counts: Record<string, number> = {
    engagements: useCollection("engagements").length,
    findings: useCollection("findings").length,
    evidence: useCollection("evidence").length,
    toolRuns: useCollection("toolRuns").length,
    conversations: useCollection("conversations").length,
    events: useCollection("events").length,
  };
  const [clearing, setClearing] = useState<Category | null>(null);
  const [busy, setBusy] = useState<CollectionName | null>(null);

  const exportCategory = (category: Category) => {
    const records = getDb().collection(category.id).getAll();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `qutra-labs-${category.id}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast({ kind: "success", message: t("privacy2.data.exported", { name: t(category.name) }) });
  };

  const clear = async (category: Category) => {
    setClearing(null);
    setBusy(category.id);
    try {
      if (category.id === "conversations") await clearAllConversations(getDb());
      else await getDb().collection(category.id).clearDurable();
      const message = t("privacy2.data.cleared", { name: t(category.name) });
      toast({ kind: "success", message });
      announce(message);
    } catch {
      toast({ kind: "danger", messageKey: "privacy2.data.clearFailed" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="privacy-block">
      <h4 className="settings-block-heading">{t("privacy2.data.title")}</h4>
      <p className="muted settings-block-lede">{t("privacy2.data.lede")}</p>
      <table className="data-table">
        <caption className="sr-only">{t("privacy2.data.title")}</caption>
        <colgroup>
          <col />
          <col className="data-table__col-num" />
          <col className="data-table__col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t("privacy2.data.kind")}</th>
            <th scope="col" className="data-table__num">
              {t("privacy2.data.count")}
            </th>
            <th scope="col">
              <span className="sr-only">{t("privacy2.data.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((category) => {
            const count = counts[category.id] ?? 0;
            const name = t(category.name);
            return (
              <tr key={category.id} data-category={category.id}>
                <th scope="row">
                  <span className="data-table__name">{name}</span>
                  <span className="data-table__hint">{t(category.hint)}</span>
                </th>
                <td className="data-table__num mono">{formatNumber(count, locale)}</td>
                <td className="data-table__actions">
                  <div className="data-table__buttons">
                    {category.view && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-label={`${t("privacy2.data.view")}: ${name}`}
                        onClick={() => {
                          closeSettings();
                          window.location.hash = `#${category.view}`;
                        }}
                      >
                        <Eye size={13} aria-hidden /> {t("privacy2.data.view")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      aria-label={`${t("privacy2.data.export")}: ${name}`}
                      disabled={count === 0}
                      onClick={() => exportCategory(category)}
                    >
                      <Download size={13} aria-hidden /> {t("privacy2.data.export")}
                    </button>
                    {category.clearable && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm data-table__clear"
                        aria-label={`${t("privacy2.data.clear")}: ${name}`}
                        disabled={count === 0 || busy === category.id}
                        onClick={() => setClearing(category)}
                      >
                        {busy === category.id ? (
                          <Loader2 size={13} className="spin" aria-hidden />
                        ) : (
                          <Trash2 size={13} aria-hidden />
                        )}{" "}
                        {t("privacy2.data.clear")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="faint privacy-block__foot">{t("privacy2.data.foot")}</p>

      <ConfirmDialog
        open={clearing !== null}
        title={clearing ? t("privacy2.data.clearTitle", { name: t(clearing.name) }) : ""}
        body={
          clearing
            ? t("privacy2.data.clearBody", { count: counts[clearing.id] ?? 0 })
            : ""
        }
        confirmLabel={t("privacy2.data.clear")}
        danger
        onClose={() => setClearing(null)}
        onConfirm={() => {
          if (clearing) void clear(clearing);
        }}
      />
    </div>
  );
}
