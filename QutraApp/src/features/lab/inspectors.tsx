import { useRef, useState } from "react";
import {
  Paperclip,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb, useCollection } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { now } from "@/lib/time";
import type { MessageKey } from "@/lib/i18n/en";
import {
  evidenceFromText,
  setEvidenceFindingLink,
} from "@/domain/lab/evidenceOps";
import type { FindingStatus } from "@/domain/findings";
import { EvidenceOrigin } from "./EvidenceOrigin";
import {
  FINDING_STATUSES,
  UNPROVEN_NOTE,
  isDraft,
  leftUnproven,
  relinkEvidence,
  statusBlocked,
  withStatus,
} from "./findingDraft";
import { findingStatusLabel } from "./labels";

/* ============================================================
   Lab record details, shown inside their own Lab view (?item=).
   Each renders live domain data (never a mock) for a selected
   Finding or Evidence record. A tool's details are the Tools view
   itself; a run's live in the context panel's Runs output.
   ============================================================ */

function InspectorTabs<T extends string>({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: { id: T; labelKey: MessageKey }[];
  active: T;
  onSelect: (id: T) => void;
  label: string;
}) {
  const { t } = useT();
  return (
    <div className="inspector-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`inspector-tab${active === tab.id ? " is-active" : ""}`}
          onClick={() => onSelect(tab.id)}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  );
}

function timeLabel(locale: string, ts?: number): string {
  return ts ? new Date(ts).toLocaleString(locale) : "—";
}

/* ---------------- Finding inspector ---------------- */

const FINDING_TABS: { id: "overview" | "evidence" | "remediation" | "history"; labelKey: MessageKey }[] = [
  { id: "overview", labelKey: "lab.insp.tab.overview" },
  { id: "evidence", labelKey: "lab.insp.tab.evidence" },
  { id: "remediation", labelKey: "lab.insp.tab.remediation" },
  { id: "history", labelKey: "lab.insp.tab.history" },
];

/** One finding's details. Its tab and the evidence text typed into it belong
    to that finding alone, so they start over when another one is opened. */
export function FindingInspector({ id }: { id: string }) {
  return <FindingDetails key={id} id={id} />;
}

function FindingDetails({ id }: { id: string }) {
  const { t, locale } = useT();
  const findings = useCollection("findings");
  const evidence = useCollection("evidence");
  const remediations = useCollection("remediations");
  const [tab, setTab] = useState<"overview" | "evidence" | "remediation" | "history">("overview");
  const [draft, setDraft] = useState("");
  /** Set before the first await, so a second click meanwhile adds nothing. */
  const addingRef = useRef(false);
  const [adding, setAdding] = useState(false);
  const finding = findings.find((f) => f.id === id);

  if (!finding) return <p className="muted">{t("lab.insp.findingGone")}</p>;

  const linked = evidence.filter((e) => e.findingId === finding.id);
  /** No evidence points at it: a draft that cannot be confirmed. */
  const unproven = isDraft(finding, evidence);
  const engagementEvidence = evidence.filter(
    (e) =>
      e.engagementId === finding.engagementId &&
      !linked.some((l) => l.id === e.id),
  );
  // Evidence of another finding moves when attached here: listed apart.
  const freeEvidence = engagementEvidence.filter((e) => !e.findingId);
  const otherEvidence = engagementEvidence.filter((e) => e.findingId);
  const findingRemediations = remediations.filter((r) => r.findingId === finding.id);

  /** Attach (`target` = this finding) or detach. Taking the last evidence of
      a confirmed finding asks first, and that finding goes back to "new". */
  const relink = (evidenceId: string, target: string | undefined) => {
    const unproven = leftUnproven(findings, evidence, evidenceId, target);
    if (unproven && !window.confirm(t("lab.insp.unprovenConfirm", { title: unproven.title }))) {
      return;
    }
    const next = relinkEvidence(findings, evidence, evidenceId, target, now());
    getDb().collection("evidence").bulkPut(next.evidence);
    getDb().collection("findings").bulkPut(next.findings);
  };
  const attach = (evidenceId: string) => relink(evidenceId, finding.id);
  const detach = (evidenceId: string) => relink(evidenceId, undefined);
  const addText = () => {
    if (!draft.trim() || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    void (async () => {
      try {
        const ev = await evidenceFromText({
          engagementId: finding.engagementId,
          findingId: finding.id,
          content: draft.trim(),
          now: now(),
        });
        const next = setEvidenceFindingLink(
          findings,
          [...evidence, ev],
          ev.id,
          finding.id,
          now(),
        );
        getDb().collection("evidence").bulkPut(next.evidence);
        getDb().collection("findings").bulkPut(next.findings);
        setDraft("");
      } finally {
        addingRef.current = false;
        setAdding(false);
      }
    })();
  };

  return (
    <div className="inspector-stack">
      <h3 className="inspector-heading">{finding.title}</h3>
      <InspectorTabs
        tabs={FINDING_TABS}
        active={tab}
        onSelect={setTab}
        label={t("lab.insp.findingTabs")}
      />

      {tab === "overview" && (
        <dl className="kv-list">
          <div>
            <dt>{t("lab.insp.severity")}</dt>
            <dd>
              <span className={`lab-sev sev-${finding.severity}`}>
                {t(`lab.severity.${finding.severity}` as MessageKey)}
              </span>
            </dd>
          </div>
          <div>
            <dt>
              <label htmlFor={`finding-status-${finding.id}`}>{t("lab.insp.status")}</label>
            </dt>
            <dd>
              <select
                id={`finding-status-${finding.id}`}
                className="select"
                aria-describedby={unproven ? `finding-status-note-${finding.id}` : undefined}
                value={finding.status}
                onChange={(e) => {
                  const next = e.target.value as FindingStatus;
                  if (statusBlocked(next, unproven)) return;
                  getDb().collection("findings").put(withStatus(finding, next, now()));
                }}
              >
                {FINDING_STATUSES.map((status) => (
                  <option
                    key={status}
                    value={status}
                    disabled={status !== finding.status && statusBlocked(status, unproven)}
                  >
                    {findingStatusLabel(t, status)}
                  </option>
                ))}
              </select>
              {unproven && (
                <p className="lab-draft-note" id={`finding-status-note-${finding.id}`}>
                  <span className="lab-draft">{t("lab.findings.draft")}</span>{" "}
                  {t("lab.insp.confirmNeedsEvidence")}
                </p>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("lab.insp.sourceTool")}</dt>
            <dd>{finding.sourceTool || "—"}</dd>
          </div>
          {finding.sourceRunId && (
            <div>
              <dt>{t("lab.insp.sourceRun")}</dt>
              <dd>
                <code>{finding.sourceRunId}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>{t("lab.insp.targets")}</dt>
            <dd className="wrap">{finding.affectedTargets.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>{t("lab.insp.description")}</dt>
            <dd className="wrap">{finding.description || "—"}</dd>
          </div>
        </dl>
      )}

      {tab === "evidence" && (
        <div className="inspector-stack">
          {linked.length === 0 ? (
            <p className="muted">{t("lab.insp.noEvidence")}</p>
          ) : (
            <ul className="evidence-list">
              {linked.map((e) => (
                <li key={e.id} className="evidence-item lab-evidence-row">
                  <Paperclip size={13} aria-hidden />
                  <span className="truncate" title={e.title}>
                    {e.title}
                  </span>
                  <span className="tag-chip">{e.kind}</span>
                  <button
                    type="button"
                    className="btn btn--icon btn--sm"
                    aria-label={t("lab.insp.detach")}
                    title={t("lab.insp.detach")}
                    onClick={() => detach(e.id)}
                  >
                    <X size={12} aria-hidden />
                  </button>
                  <EvidenceOrigin evidence={e} />
                </li>
              ))}
            </ul>
          )}

          {engagementEvidence.length > 0 && (
            <label className="field">
              <span>{t("lab.insp.attachExisting")}</span>
              <select
                className="select"
                value=""
                onChange={(e) => e.target.value && attach(e.target.value)}
              >
                <option value="">{t("lab.insp.chooseEvidence")}</option>
                {freeEvidence.length > 0 && (
                  <optgroup label={t("lab.insp.attachFree")}>
                    {freeEvidence.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </optgroup>
                )}
                {otherEvidence.length > 0 && (
                  <optgroup label={t("lab.insp.attachMove")}>
                    {otherEvidence.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}

          <label className="field">
            <span>{t("lab.insp.addText")}</span>
            <textarea
              className="input lab-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("lab.insp.addTextHint")}
            />
          </label>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={addText}
            disabled={!draft.trim() || adding}
          >
            <Plus size={13} aria-hidden /> {t("lab.insp.addEvidence")}
          </button>
        </div>
      )}

      {tab === "remediation" && (
        <div className="inspector-stack">
          <dl className="kv-list">
            <div>
              <dt>{t("lab.insp.remediationText")}</dt>
              <dd className="wrap">{finding.remediation || "—"}</dd>
            </div>
          </dl>
          {findingRemediations.length > 0 && (
            <ul className="evidence-list">
              {findingRemediations.map((r) => (
                <li key={r.id} className="evidence-item">
                  <ShieldCheck size={13} aria-hidden />
                  <span className="truncate">{r.title}</span>
                  <span className="tag-chip">{r.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "history" && (
        <ul className="history-list">
          {finding.history.length === 0 ? (
            <li className="muted">{t("lab.insp.noHistory")}</li>
          ) : (
            finding.history.map((h, i) => (
              <li key={i}>
                <time>{timeLabel(locale, h.at)}</time>
                <span>
                  {h.from ? `${findingStatusLabel(t, h.from)} → ` : ""}
                  {findingStatusLabel(t, h.to)}
                </span>
                {h.note && (
                  <em>
                    {h.note === "imported"
                      ? t("lab.findings.historyImported")
                      : h.note === UNPROVEN_NOTE
                        ? t("lab.findings.historyUnproven")
                        : h.note}
                  </em>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Evidence inspector ---------------- */

export function EvidenceInspector({ id }: { id: string }) {
  const { t, locale } = useT();
  const { toast } = useUi();
  const evidence = useCollection("evidence");
  const findings = useCollection("findings");
  const ev = evidence.find((e) => e.id === id);

  if (!ev) return <p className="muted">{t("lab.insp.evidenceGone")}</p>;

  const finding = ev.findingId ? findings.find((f) => f.id === ev.findingId) : undefined;
  const remove = () => {
    // The last evidence of a confirmed finding says what removing it does.
    const unproven = leftUnproven(findings, evidence, ev.id);
    const question = unproven
      ? t("lab.insp.unprovenConfirm", { title: unproven.title })
      : t("lab.insp.deleteEvidenceConfirm");
    if (!window.confirm(question)) return;
    // Audit trail: record the deletion as an activity event before removing.
    getDb().collection("events").put({
      id: `ev-del-${ev.id}`,
      type: "app_activity",
      at: now(),
      label: t("lab.evidence.removedEvent", { title: ev.title }),
      detail: `kind=${ev.kind} source=${ev.source}`,
      minutes: 0,
      demo: false,
    });
    if (finding) {
      const next = relinkEvidence(findings, evidence, ev.id, undefined, now());
      getDb().collection("findings").bulkPut(next.findings);
    }
    getDb().collection("evidence").remove(ev.id);
    toast({ kind: "info", messageKey: "lab.evidence.removed" });
  };

  return (
    <div className="inspector-stack">
      <dl className="kv-list">
        <div>
          <dt>{t("lab.insp.kind")}</dt>
          <dd>{ev.kind}</dd>
        </div>
        <div>
          <dt>{t("lab.insp.source")}</dt>
          <dd className="mono truncate">{ev.source || "—"}</dd>
        </div>
        {ev.path && (
          <div>
            <dt>{t("lab.insp.path")}</dt>
            <dd className="mono truncate" title={ev.path}>
              {ev.path}
            </dd>
          </div>
        )}
        <div>
          <dt>{t("lab.insp.linkedFinding")}</dt>
          <dd className="truncate">{finding?.title ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("lab.insp.captured")}</dt>
          <dd>{timeLabel(locale, ev.capturedAt)}</dd>
        </div>
      </dl>
      {ev.content && (
        <section>
          <div className="section-label">{t("lab.insp.content")}</div>
          <pre className="evidence-content">{ev.content}</pre>
        </section>
      )}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={remove}
      >
        <Trash2 size={13} aria-hidden /> {t("lab.insp.deleteEvidence")}
      </button>
    </div>
  );
}
