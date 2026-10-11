import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bug,
  Check,
  Compass,
  Upload,
  Square,
  RotateCcw,
  Paperclip,
  ShieldCheck,
  ShieldAlert,
  Play,
  Activity,
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  ArrowDownCircle,
  ArrowRight,
  BarChart3,
  ChevronRight,
  FileText,
  Info,
  Plus,
} from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { registeredToolsHref } from "@/domain/workbench";
import { LabEmpty, LabViewHeader } from "./LabViewHeader";
import { LabDetail, LabSplit, useLabItem } from "./LabDetail";
import { NewFindingDialog } from "./NewFindingDialog";
import { EvidenceInspector, FindingInspector } from "./inspectors";
import { useT } from "@/lib/i18n";
import { getDb, useCollection } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { useLabRuntime } from "@/state/labRuntime";
import { NativeToolsUnavailable } from "./NativeToolsUnavailable";
import { Field } from "@/components/ui/Field";
import { useUi } from "@/state/ui";
import { createId } from "@/lib/id";
import { now } from "@/lib/time";
import { evaluateTarget, type ScopeDecision } from "@/domain/lab/scope";
import { buildCommand } from "@/domain/lab/command";
import { parseSarif } from "@/domain/lab/parsers/sarif";
import { parseNmapXml } from "@/domain/lab/parsers/nmap";
import type { ParseResult } from "@/domain/lab/parsers/types";
import {
  dedupeFindings,
  importedToFinding,
  reimportDiff,
} from "@/domain/lab/findingsOps";
import {
  findingsMissingEvidence,
  evidenceCountByFinding,
  setEvidenceFindingLink,
} from "@/domain/lab/evidenceOps";
import { sha256Hex, sha256HexBytes } from "@/lib/hash";
import { evidenceFromImport, type ImportSource } from "./importEvidence";
import { importErrorKey, importWarningText } from "./importMessages";
import type { AuthorizationScope, Engagement, Target } from "@/domain/lab";
import type { FindingStatus, Severity } from "@/domain/findings";
import type { NativeToolRun } from "@/lib/bridge/types";
import type { MessageKey } from "@/lib/i18n/en";
import { findingStatusLabel, runStateLabel } from "./labels";
import { startsWithFile } from "./fileKinds";
import { openContextPanel } from "@/app/context/panelState";
import { useInvestigationFiles } from "@/state/investigationFiles";
import type { InvestigationFile } from "@/lib/investigationFiles";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const ACTIVE_STATES = ["queued", "starting", "running", "cancelling"];

const SEVERITIES: { id: Severity; icon: typeof Info }[] = [
  { id: "critical", icon: AlertOctagon },
  { id: "high", icon: AlertTriangle },
  { id: "medium", icon: AlertCircle },
  { id: "low", icon: ArrowDownCircle },
  { id: "info", icon: Info },
];

export interface LabViewProps {
  engagement?: Engagement;
  scope?: AuthorizationScope;
  targets: Target[];
}

export function DecisionBadge({ decision }: { decision: ScopeDecision }) {
  const { t } = useT();
  const key = `lab.decision.${decision.reason}` as MessageKey;
  const Icon = decision.allowed ? ShieldCheck : ShieldAlert;
  return (
    <span
      className={`lab-badge${decision.allowed ? " is-allowed" : " is-blocked"}`}
      role="status"
    >
      <Icon size={13} aria-hidden />
      {t(key)}
    </span>
  );
}

function fmtDuration(run: NativeToolRun): string {
  if (!run.startedAt) return "—";
  const end = run.endedAt ?? Date.now();
  const ms = Math.max(0, end - run.startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/* Rebuild + relaunch a run from its profile (never from stored, redacted argv). */
function useRerun(
  engagement?: Engagement,
  scope?: AuthorizationScope,
  targets: Target[] = [],
) {
  const profiles = useCollection("toolProfiles");
  const runtime = useLabRuntime();
  const { toast } = useUi();
  return async (run: NativeToolRun) => {
    const installation = runtime.installations.find((i) => i.id === run.installationId);
    const profile = profiles.find((p) => p.id === run.profileId);
    if (!installation || !profile) {
      toast({ kind: "danger", messageKey: "lab.runs.rerunUnavailable" });
      return;
    }
    const built = buildCommand(profile, { executableLabel: installation.displayName });
    if (built.errors.length > 0) {
      toast({ kind: "danger", messageKey: "lab.runs.rerunUnavailable" });
      return;
    }
    const targetArg = profile.args.find((a) => a.type === "target");
    const targetValue = targetArg ? profile.values[targetArg.id] : "";
    const targetRecord = targetValue
      ? targets.find(
          (target) =>
            target.raw === targetValue || target.normalized === targetValue,
        )
      : undefined;
    let scopeAttestation;
    if (profile.requiresScope) {
      if (!targetValue || !scope) {
        toast({ kind: "danger", messageKey: "lab.tools.scopeRequired" });
        return;
      }
      const decision = evaluateTarget(targetValue, scope);
      if (!decision.allowed) {
        toast({ kind: "danger", messageKey: "lab.tools.scopeBlocked" });
        return;
      }
      scopeAttestation = {
        scopeId: scope.id,
        scopeRevision: scope.revision,
        target: targetValue,
        allowed: decision.allowed,
        reason: decision.reason,
        decidedAt: now(),
        expiresAt: scope.expiresAt,
      };
    }
    // As they went into argv: an untrimmed value would not be found.
    const redactions = built.sensitive.filter((value) => value.length >= 3);
    try {
      const started = await getBridge().toolSupervisor.start({
        installationId: installation.id,
        profileId: profile.id,
        requestId: createId("request"),
        engagementId: engagement?.id,
        targetId: targetRecord?.id ?? run.targetId,
        argv: built.argv,
        workingDir: profile.workingDir || installation.workingDir,
        environment: [],
        redactions,
        scope: scopeAttestation,
        requiresScope: profile.requiresScope,
        timeoutSec: profile.timeoutSec,
        outputLimitBytes: 1024 * 1024,
        concurrencyClass: profile.concurrencyClass === "exclusive" ? "exclusive" : "default",
      });
      runtime.selectRun(started.id);
      await runtime.refresh();
    } catch (caught) {
      toast({ kind: "danger", message: String(caught) });
    }
  };
}

/* ---------------- Runs ---------------- */

export function LabRuns({ engagement, scope, targets }: LabViewProps) {
  const { t } = useT();
  const runtime = useLabRuntime();
  const profiles = useCollection("toolProfiles");
  const rerun = useRerun(engagement, scope, targets);

  const runs = useMemo(
    () =>
      runtime.runs.filter(
        (r) => !engagement || r.engagementId === engagement.id,
      ),
    [runtime.runs, engagement],
  );

  const targetForRun = (run: NativeToolRun): string => {
    if (run.target) return run.target;
    if (run.targetId) {
      const saved = targets.find((target) => target.id === run.targetId);
      if (saved) return saved.normalized || saved.raw;
    }
    const match = run.argv.find((a) =>
      targets.some((tg) => tg.raw === a || tg.normalized === a),
    );
    return match ?? "—";
  };

  const openRun = (run: NativeToolRun) => {
    runtime.selectRun(run.id);
    openContextPanel("runs");
  };
  // Running a tool happens in Tools › Registered tools, for this investigation.
  const navigate = useNavigate();
  const openTools = () => navigate(registeredToolsHref(engagement?.id));

  if (!runtime.available) {
    return <NativeUnavailable />;
  }
  const header = (
    <LabViewHeader icon={Play} title={t("lab.view.runs")} purpose={t("lab.purpose.runs")} />
  );
  if (runs.length === 0) {
    return (
      <div className="lab-view-stack">
        {header}
        <LabEmpty
          icon={Play}
          title={t("lab.runs.emptyTitle")}
          hint={t("lab.runs.emptyHint")}
          action={
            <button type="button" className="btn btn--primary" onClick={openTools}>
              {t("lab.road.run.action")} <ArrowRight size={14} aria-hidden />
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="lab-view-stack">
    {header}
    <div className="lab-table-wrap">
      <table className="lab-table">
        <thead>
          <tr>
            <th>{t("lab.runs.tool")}</th>
            <th>{t("lab.runs.profile")}</th>
            <th>{t("lab.runs.target")}</th>
            <th>{t("lab.runs.scope")}</th>
            <th>{t("lab.runs.status")}</th>
            <th>{t("lab.runs.started")}</th>
            <th>{t("lab.runs.duration")}</th>
            <th>{t("lab.runs.exitCode")}</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const installation = runtime.installations.find((i) => i.id === run.installationId);
            const profile = profiles.find((p) => p.id === run.profileId);
            const active = ACTIVE_STATES.includes(run.state);
            return (
              <tr
                key={run.id}
                className={run.id === runtime.selectedRunId ? "is-selected" : ""}
                onClick={() => openRun(run)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openRun(run);
                }}
              >
                <td className="truncate">{installation?.displayName ?? run.installationId}</td>
                <td className="truncate">{profile?.name ?? "—"}</td>
                <td className="mono truncate">{targetForRun(run)}</td>
                <td>
                  {run.scopeId ? (
                    <span className="lab-badge is-allowed">
                      <ShieldCheck size={12} aria-hidden /> {t("lab.runs.scoped")}
                    </span>
                  ) : (
                    <span className="muted">{t("lab.runs.local")}</span>
                  )}
                </td>
                <td>
                  <span className={`lab-run-state state-${run.state}`}>
                    {runStateLabel(t, run.state)}
                  </span>
                </td>
                <td>{run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "—"}</td>
                <td>{fmtDuration(run)}</td>
                <td>{run.exitCode ?? "—"}</td>
                <td className="lab-table-actions" onClick={(e) => e.stopPropagation()}>
                  {active ? (
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      aria-label={t("lab.tools.stop")}
                      title={t("lab.tools.stop")}
                      onClick={() => void getBridge().toolSupervisor.cancel(run.id)}
                    >
                      <Square size={13} aria-hidden />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      aria-label={t("lab.runs.rerun")}
                      title={t("lab.runs.rerun")}
                      onClick={() => void rerun(run)}
                    >
                      <RotateCcw size={13} aria-hidden />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}

/* Runs and Tools share one native-boundary surface. They used to render two
   different dead ends for the same condition; keeping a single component means
   the guidance cannot drift apart again. */
const NativeUnavailable = NativeToolsUnavailable;

/* ---------------- Findings ---------------- */

export function LabFindings({ engagement, targets }: LabViewProps) {
  const { t } = useT();
  const { toast } = useUi();
  const findings = useCollection("findings");
  const evidence = useCollection("evidence");
  const { item, open, close } = useLabItem();
  const [adding, setAdding] = useState(false);
  const addButton = (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      onClick={() => setAdding(true)}
      disabled={!engagement}
    >
      <Plus size={14} aria-hidden /> {t("lab.newFinding.action")}
    </button>
  );

  const [sev, setSev] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [missing, setMissing] = useState(false);

  const engFindings = useMemo(
    () =>
      (engagement ? findings.filter((f) => f.engagementId === engagement.id) : []).sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
      ),
    [findings, engagement],
  );
  const evCount = useMemo(() => evidenceCountByFinding(evidence), [evidence]);
  const sources = useMemo(
    () => [...new Set(engFindings.map((f) => f.sourceTool).filter(Boolean))],
    [engFindings],
  );
  const findingTargets = useMemo(
    () =>
      [...new Set(engFindings.flatMap((finding) => finding.affectedTargets))]
        .filter(Boolean)
        .sort(),
    [engFindings],
  );

  const [, setParams] = useSearchParams();
  const openImport = () =>
    setParams(
      engagement
        ? { e: engagement.id, view: "findings", focus: "import" }
        : { view: "findings", focus: "import" },
    );

  const filtered = engFindings.filter((f) => {
    if (sev && f.severity !== sev) return false;
    if (status && f.status !== status) return false;
    if (source && f.sourceTool !== source) return false;
    if (target && !f.affectedTargets.includes(target)) return false;
    if (missing && (evCount.get(f.id) ?? 0) > 0) return false;
    return true;
  });

  return (
    <LabSplit
      detail={
        item && (
          <LabDetail title={t("lab.insp.title.finding")} onClose={close}>
            <FindingInspector id={item} />
          </LabDetail>
        )
      }
    >
    <div className="lab-view-stack">
      <LabViewHeader
        icon={Bug}
        title={t("lab.view.findings")}
        purpose={t("lab.purpose.findings")}
        action={
          <div className="lab-tools-actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={openImport}>
              <Upload size={14} aria-hidden /> {t("lab.import")}
            </button>
            {addButton}
          </div>
        }
      />
      {engFindings.length > 0 && (
      <div className="lab-filter-bar">
        <Field label={t("lab.findings.filterSeverity")}>
          {(id) => (
            <select id={id} className="select select--sm" value={sev} onChange={(e) => setSev(e.target.value)}>
              <option value="">{t("lab.findings.allSeverity")}</option>
              {(["critical", "high", "medium", "low", "info"] as Severity[]).map((s) => (
                <option key={s} value={s}>{t(`lab.severity.${s}` as MessageKey)}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("lab.findings.filterStatus")}>
          {(id) => (
            <select id={id} className="select select--sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("lab.findings.allStatus")}</option>
              {["new", "confirmed", "in_progress", "mitigated", "verified", "reopened", "false_positive", "risk_accepted", "out_of_scope", "duplicate"].map((s) => (
                <option key={s} value={s}>
                  {findingStatusLabel(t, s as FindingStatus)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("lab.findings.filterSource")}>
          {(id) => (
            <select id={id} className="select select--sm" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{t("lab.findings.allSources")}</option>
              {sources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("lab.findings.filterTarget")}>
          {(id) => (
            <select
              id={id}
              className="select select--sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{t("lab.findings.allTargets")}</option>
              {findingTargets.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          )}
        </Field>
        <label className="lab-filter-check">
          <input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} />
          {t("lab.findings.filterEvidenceMissing")}
        </label>
      </div>
      )}

      {engFindings.length === 0 ? (
        <LabEmpty
          icon={Bug}
          title={t("lab.findings.emptyTitle")}
          hint={t("lab.findings.emptyHint")}
          action={addButton}
        />
      ) : filtered.length === 0 ? (
        <p className="lab-empty-note">{t("lab.noFindings")}</p>
      ) : (
        <div className="lab-table-wrap">
          <table className="lab-table" data-testid="lab-findings">
            <thead>
              <tr>
                <th>{t("lab.findings.colSeverity")}</th>
                <th>{t("lab.findings.colTitle")}</th>
                <th>{t("lab.findings.colTarget")}</th>
                <th>{t("lab.findings.colStatus")}</th>
                <th>{t("lab.findings.colEvidence")}</th>
                <th>{t("lab.findings.colSource")}</th>
                <th>{t("lab.findings.colLastSeen")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => {
                const count = evCount.get(f.id) ?? 0;
                return (
                  <tr
                    key={f.id}
                    className={item === f.id ? "is-selected" : ""}
                    aria-selected={item === f.id}
                    tabIndex={0}
                    onClick={() => open(f.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") open(f.id);
                    }}
                  >
                    <td>
                      <span className={`lab-sev sev-${f.severity}`}>
                        {t(`lab.severity.${f.severity}` as MessageKey)}
                      </span>
                    </td>
                    <td className="truncate">{f.title}</td>
                    <td className="mono truncate">{f.affectedTargets[0] ?? "—"}</td>
                    <td>
                    {findingStatusLabel(t, f.status)}
                    {(evCount.get(f.id) ?? 0) === 0 && (
                      <>
                        {" "}
                        <span className="lab-draft">{t("lab.findings.draft")}</span>
                      </>
                    )}
                  </td>
                    <td className={count === 0 ? "lab-evidence-missing" : ""}>
                      {count === 0 ? (
                        <span title={t("lab.findings.noEvidenceWarn")}>0 ⚠</span>
                      ) : (
                        count
                      )}
                    </td>
                    <td className="truncate">{f.sourceTool || "—"}</td>
                    <td>{new Date(f.lastSeen).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <FindingsImport engagement={engagement} />
      {engagement && (
        <NewFindingDialog
          open={adding}
          onClose={() => setAdding(false)}
          engagementId={engagement.id}
          targets={targets}
          onCreated={(id, title) => {
            setAdding(false);
            open(id);
            toast({ kind: "success", messageKey: "lab.newFinding.added", params: { title } });
          }}
        />
      )}
    </div>
    </LabSplit>
  );
}

function FindingsImport({ engagement }: { engagement?: Engagement }) {
  const { t } = useT();
  const findings = useCollection("findings");
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"sarif" | "nmap">("sarif");
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [importMsg, setImportMsg] = useState("");
  // The loaded file's name and the hash of its bytes; editing the text
  // after loading drops them, since the text is no longer that file.
  const [loaded, setLoaded] = useState<ImportSource | null>(null);
  const importRef = useRef<HTMLTextAreaElement>(null);
  const [params, setParams] = useSearchParams();
  const focusImport = params.get("focus") === "import";

  // The Lab rail's "Import scan output" lands here; the param is spent once.
  useEffect(() => {
    if (!focusImport) return;
    importRef.current?.focus();
    importRef.current?.scrollIntoView?.({ block: "center" });
    const next = new URLSearchParams(params);
    next.delete("focus");
    setParams(next, { replace: true });
  }, [focusImport, params, setParams]);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    setImportText(text);
    setLoaded({ name: file.name, sha256: await sha256HexBytes(bytes) });
    setPreview(null);
    setImportMsg("");
    // Nmap writes XML; SARIF is JSON. The name usually says which.
    if (/\.xml$/i.test(file.name) || text.trimStart().startsWith("<")) setImportFormat("nmap");
    else setImportFormat("sarif");
  };

  const runPreview = () => {
    setImportMsg("");
    if (!importText.trim()) return;
    try {
      const result = importFormat === "sarif" ? parseSarif(importText) : parseNmapXml(importText);
      setPreview(result);
    } catch (err) {
      setPreview(null);
      setImportMsg(t(importErrorKey(err)));
    }
  };

  const commitImport = async () => {
    if (!engagement || !preview) return;
    const source: ImportSource = loaded ?? {
      name: t("lab.import.pasted"),
      sha256: await sha256Hex(importText),
    };
    const batchId = createId("imp");
    const parsed = preview.findings.map((f) =>
      importedToFinding(f, {
        sourceTool: preview.meta.tool ?? preview.parser,
        engagementId: engagement.id,
        importBatchId: batchId,
        parserVersion: preview.parserVersion,
        now: now(),
      }),
    );
    const incoming = dedupeFindings(parsed);
    const existing = findings.filter((f) => f.engagementId === engagement.id);
    const diff = reimportDiff(existing, incoming);
    const existingByFp = new Map(existing.map((f) => [f.fingerprint, f]));
    const db = getDb();
    /** Findings this scan is evidence for: each it reopens, and each that
        has no evidence yet. A finding the user dismissed is left alone. */
    const proven: string[] = [];
    const withEvidence = new Set(
      db.collection("evidence").getAll().map((item) => item.findingId).filter(Boolean),
    );
    for (const inc of incoming) {
      const prev = existingByFp.get(inc.fingerprint);
      if (!diff.preserved.includes(inc.fingerprint)) {
        const id = prev?.id ?? inc.id;
        if (diff.reopened.includes(inc.fingerprint) || !withEvidence.has(id)) {
          proven.push(id);
        }
      }
      if (!prev) {
        db.collection("findings").put(inc);
        continue;
      }
      const patch = { ...prev, lastSeen: inc.lastSeen, updatedAt: now() };
      if (diff.reopened.includes(inc.fingerprint)) {
        patch.status = "reopened";
        patch.history = [
          ...prev.history,
          { at: now(), from: prev.status, to: "reopened" as const, note: "reappeared on reimport" },
        ];
      } else if (diff.changed.includes(inc.fingerprint)) {
        patch.severity = inc.severity;
        patch.description = inc.description;
      }
      db.collection("findings").put(patch);
    }
    if (proven.length > 0) {
      const at = now();
      const rows = proven.map((findingId) =>
        evidenceFromImport({ engagementId: engagement.id, findingId, source, parser: preview.parser, now: at }),
      );
      // Evidence.findingId is the link. The rows already carry it, so one
      // call rebuilds every finding's evidenceIds mirror.
      const state = setEvidenceFindingLink(
        db.collection("findings").getAll(),
        [...db.collection("evidence").getAll(), ...rows],
        rows[0]!.id,
        rows[0]!.findingId,
        at,
      );
      const linked = new Set(proven);
      db.collection("evidence").bulkPut(rows);
      db.collection("findings").bulkPut(state.findings.filter((f) => linked.has(f.id)));
    }
    setImportMsg(
      t("lab.importResult", {
        new: diff.created.length,
        changed: diff.changed.length,
        reopened: diff.reopened.length,
        resolved: diff.resolved.length,
      }),
    );
    setPreview(null);
    setImportText("");
    setLoaded(null);
  };

  return (
    <section className="lab-card lab-import" aria-labelledby="lab-import-title">
      <h3 id="lab-import-title" className="lab-card-title">
        <Upload size={15} aria-hidden /> {t("lab.import")}
      </h3>
      <p className="lab-field-hint">{t("lab.import.hint")}</p>
      <div className="lab-import-head">
        <label className="field" style={{ maxWidth: 160 }}>
          <span>{t("lab.format")}</span>
          <select
            className="input"
            value={importFormat}
            onChange={(e) => setImportFormat(e.target.value as "sarif" | "nmap")}
            aria-label={t("lab.format")}
          >
            <option value="sarif">SARIF</option>
            <option value="nmap">Nmap XML</option>
          </select>
        </label>
        <label className="btn btn--secondary lab-file-btn">
          <Upload size={14} aria-hidden /> {t("lab.import.fromFile")}
          <input
            type="file"
            className="sr-only"
            accept=".sarif,.json,.xml"
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <Field label={t("lab.import")}>
        {(id) => (
          <textarea
            id={id}
            ref={importRef}
            className="input lab-textarea"
            value={importText}
            placeholder={t("lab.importPlaceholder")}
            onChange={(e) => {
              // Edited text is no longer the loaded file, nor what was previewed.
              setImportText(e.target.value);
              setLoaded(null);
              setPreview(null);
            }}
          />
        )}
      </Field>
      <div className="lab-add-row">
        <button type="button" className="btn btn--secondary" onClick={runPreview} disabled={!importText.trim()}>
          {t("lab.preview")}
        </button>
        {preview && (
          <button type="button" className="btn btn--primary" onClick={() => void commitImport()} disabled={!engagement}>
            {t("lab.commit")}
          </button>
        )}
      </div>
      {preview && (
        <p className="lab-parsed" data-testid="lab-parsed-count">
          {t("lab.parsedCount", { count: preview.findings.length })}
          {preview.warnings.length > 0 &&
            ` · ${preview.warnings.map((warning) => importWarningText(t, warning)).join("; ")}`}
        </p>
      )}
      {importMsg && (
        <p className="lab-import-msg" data-testid="lab-import-msg">{importMsg}</p>
      )}
    </section>
  );
}

/* ---------------- Evidence ---------------- */

export function LabEvidence({ engagement }: LabViewProps) {
  const { t } = useT();
  const evidence = useCollection("evidence");
  const findings = useCollection("findings");
  const { item, open, close } = useLabItem();
  const [, setParams] = useSearchParams();

  const engEvidence = engagement
    ? evidence.filter((e) => e.engagementId === engagement.id)
    : [];

  if (engEvidence.length === 0) {
    return (
      <EmptyState
        icon={Paperclip}
        title={t("lab.evidence.emptyTitle")}
        hint={t("lab.evidence.emptyHint")}
        action={
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() =>
              setParams(engagement ? { e: engagement.id, view: "runs" } : { view: "runs" })
            }
          >
            <Play size={14} aria-hidden /> {t("lab.openRuns")}
          </button>
        }
      />
    );
  }

  return (
    <LabSplit
      detail={
        item && (
          <LabDetail
            title={t("lab.insp.title.evidence")}
            subtitle={engEvidence.find((e) => e.id === item)?.title}
            onClose={close}
          >
            <EvidenceInspector id={item} />
          </LabDetail>
        )
      }
    >
    <div className="lab-view-stack">
    <LabViewHeader icon={Paperclip} title={t("lab.view.evidence")} purpose={t("lab.purpose.evidence")} />
    <div className="lab-table-wrap">
      <table className="lab-table">
        <thead>
          <tr>
            <th>{t("lab.insp.kind")}</th>
            <th>{t("common.name")}</th>
            <th>{t("lab.insp.linkedFinding")}</th>
            <th>{t("lab.insp.source")}</th>
            <th>{t("lab.insp.captured")}</th>
          </tr>
        </thead>
        <tbody>
          {engEvidence.map((e) => {
            const finding = e.findingId ? findings.find((f) => f.id === e.findingId) : undefined;
            return (
              <tr
                key={e.id}
                className={item === e.id ? "is-selected" : ""}
                aria-selected={item === e.id}
                tabIndex={0}
                onClick={() => open(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") open(e.id);
                }}
              >
                <td><Paperclip size={12} aria-hidden /> {e.kind}</td>
                <td className="truncate">{e.title}</td>
                <td className="truncate">{finding?.title ?? t("lab.evidence.unlinked")}</td>
                <td className="mono truncate">{e.source || "—"}</td>
                <td>{new Date(e.capturedAt).toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
    </LabSplit>
  );
}

/* ---------------- Scope ---------------- */

const linesToList = (s: string) =>
  s.split("\n").map((l) => l.trim()).filter(Boolean);

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * What the user is authorised to test, reached from the scope strip. It is
 * saved as it is typed out of a field. The targets are their own section
 * (LabTargets).
 */
export function LabScope({ engagement, scope }: LabViewProps) {
  const { t } = useT();
  const [allowedText, setAllowedText] = useState((scope?.allowedTargets ?? []).join("\n"));
  const [excludedText, setExcludedText] = useState((scope?.excludedTargets ?? []).join("\n"));
  const [authRef, setAuthRef] = useState(scope?.authorizationRef ?? "");

  useEffect(() => {
    setAllowedText((scope?.allowedTargets ?? []).join("\n"));
    setExcludedText((scope?.excludedTargets ?? []).join("\n"));
    setAuthRef(scope?.authorizationRef ?? "");
  }, [scope?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitScope = (changes: Record<string, unknown>) => {
    if (!scope) return;
    getDb().collection("authorizationScopes").put({
      ...scope,
      ...changes,
      revision: scope.revision + 1,
      updatedAt: now(),
    });
  };

  if (!engagement) return <p className="lab-empty-note">{t("lab.empty")}</p>;

  const allowedCount = linesToList(allowedText).length;
  const excludedCount = linesToList(excludedText).length;

  return (
    <div className="lab-view-stack">
      <LabViewHeader icon={ShieldCheck} title={t("lab.view.scope")} purpose={t("lab.purpose.scope")} />
      <div className="lab-scope-grid lab-scope-grid--one">
        <section className="lab-card" aria-labelledby="lab-scope-auth">
          <h3 id="lab-scope-auth" className="lab-card-title">
            {t("lab.scope")}
          </h3>
          <label className="field">
            <span className="lab-field-label">
              {t("lab.allowedTargets")}
              <span className="lab-count">{allowedCount}</span>
            </span>
            <textarea
              className="input lab-textarea"
              value={allowedText}
              rows={4}
              placeholder={t("lab.scope.allowedPlaceholder")}
              onChange={(e) => setAllowedText(e.target.value)}
              onBlur={() => {
                // Only an edit is a new revision: tabbing through changes nothing.
                const list = linesToList(allowedText);
                if (!sameList(list, scope?.allowedTargets ?? [])) commitScope({ allowedTargets: list });
              }}
              aria-label={t("lab.allowedTargets")}
            />
          </label>
          <label className="field">
            <span className="lab-field-label">
              {t("lab.excludedTargets")}
              <span className="lab-count">{excludedCount}</span>
            </span>
            <textarea
              className="input lab-textarea"
              value={excludedText}
              rows={3}
              placeholder={t("lab.scope.excludedPlaceholder")}
              onChange={(e) => setExcludedText(e.target.value)}
              onBlur={() => {
                const list = linesToList(excludedText);
                if (!sameList(list, scope?.excludedTargets ?? [])) commitScope({ excludedTargets: list });
              }}
              aria-label={t("lab.excludedTargets")}
            />
          </label>
          <p className="lab-field-hint">{t("lab.onePerLine")}</p>
          <Field label={t("lab.scope.authRef")}>
            {(id) => (
              <input
                id={id}
                className="input"
                value={authRef}
                placeholder={t("lab.scope.authRefPlaceholder")}
                onChange={(e) => setAuthRef(e.target.value)}
                onBlur={() => {
                  if (authRef.trim() !== (scope?.authorizationRef ?? "")) {
                    commitScope({ authorizationRef: authRef.trim() });
                  }
                }}
              />
            )}
          </Field>
          <label className={scope?.testerAck ? "lab-ack is-on" : "lab-ack"}>
            <input
              type="checkbox"
              checked={scope?.testerAck ?? false}
              onChange={(e) => commitScope({ testerAck: e.target.checked })}
            />
            <span className="lab-ack__text">
              {t("lab.testerAck")}
              <small>{t("lab.scope.ackHint")}</small>
            </span>
          </label>
        </section>
      </div>
    </div>
  );
}

/* ---------------- Overview ---------------- */

type RoadStepId = "scope" | "targets" | "run" | "finding" | "evidence" | "remediation";

/** Where each road step is done; "run" goes to Tools › Registered tools. */
const ROAD_VIEW: Record<Exclude<RoadStepId, "run">, "scope" | "targets" | "evidence" | "findings"> = {
  scope: "scope",
  targets: "targets",
  finding: "findings",
  evidence: "evidence",
  remediation: "findings",
};

const NO_FILES: readonly InvestigationFile[] = [];

export function LabOverview({ engagement, scope, targets }: LabViewProps) {
  const { t, locale } = useT();
  const findings = useCollection("findings");
  const files = useInvestigationFiles((s) => (engagement && s.byEngagement[engagement.id]) || NO_FILES);
  const engagementId = engagement?.id;
  // The files are read here too: the second step is done by a file as well.
  useEffect(() => {
    if (engagementId) void useInvestigationFiles.getState().load(engagementId);
  }, [engagementId]);
  const evidence = useCollection("evidence");
  const reports = useCollection("reports");
  const runtime = useLabRuntime();
  const [, setParams] = useSearchParams();

  const engFindings = useMemo(
    () =>
      engagement
        ? findings.filter((finding) => finding.engagementId === engagement.id)
        : [],
    [engagement, findings],
  );
  const engEvidence = engagement ? evidence.filter((e) => e.engagementId === engagement.id) : [];
  const engRuns = runtime.runs.filter((r) => !engagement || r.engagementId === engagement.id);
  const recentRuns = engRuns.slice(0, 6);
  const missingEvidence = findingsMissingEvidence(engFindings, engEvidence);
  const engReports = engagement
    ? reports
        .filter((r) => r.engagementId === engagement.id)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const shortDate = (ts: number) =>
    new Date(ts).toLocaleDateString(locale, { day: "numeric", month: "short" });

  const sevCounts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of engFindings) c[f.severity]++;
    return c;
  }, [engFindings]);

  // The way through an investigation, worded as what to do next, so a new
  // investigation never leaves the question "I opened it, so what now?". The
  // old Methodology road folded in here (spec 2026-10-07 §5.1); each step is
  // done only from real records.
  const steps: { id: RoadStepId; done: boolean }[] = [
    { id: "scope", done: !!scope && (scope.testerAck || scope.allowedTargets.length > 0) },
    { id: "targets", done: targets.length > 0 || files.length > 0 },
    { id: "run", done: engRuns.some((r) => r.state === "succeeded" || r.state === "failed") },
    { id: "finding", done: engFindings.length > 0 },
    { id: "evidence", done: engEvidence.length > 0 },
    { id: "remediation", done: engFindings.some((f) => f.remediation.trim().length > 0) },
  ];
  const next = steps.find((step) => !step.done);
  const doneCount = steps.filter((step) => step.done).length;

  const open = (
    view: "findings" | "runs" | "scope" | "targets" | "evidence" | "report",
    item?: string,
    extra: Record<string, string> = {},
  ) => {
    const params: Record<string, string> = { view, ...extra };
    if (engagement) params.e = engagement.id;
    if (item) params.item = item;
    setParams(params);
  };
  const navigate = useNavigate();
  // A file, capture or forensic investigation adds files in its second step.
  const fileStep = startsWithFile(engagement?.kind);
  const stepKey = (id: RoadStepId): string => (id === "targets" && fileStep ? "files" : id);
  const goStep = (id: RoadStepId) => {
    // Running a tool happens in Tools › Registered tools, for this investigation.
    if (id === "run") navigate(registeredToolsHref(engagement?.id));
    else if (id === "targets" && fileStep) open("targets", undefined, { add: "file" });
    else open(ROAD_VIEW[id]);
  };

  return (
    <div className="lab-view-stack">
      {next && engagement && (
        <section className="lab-panel lab-start" aria-labelledby="lab-ov-start">
          <header className="lab-panel__h">
            <Compass size={15} className="lab-panel__ico" aria-hidden />
            <h2 id="lab-ov-start" className="lab-panel__t">
              {t("lab.start.title")}
            </h2>
            <span className="lab-views__n">
              {t("lab.method.progress", { done: doneCount, total: steps.length })}
            </span>
          </header>
          <p className="lab-start__lead">
            {t("lab.start.lead", { name: engagement.title })}
            {engagement.notes && <span className="lab-start__note">{engagement.notes}</span>}
          </p>
          <ol className="lab-start__steps">
            {steps.map((step, index) => {
              const isNext = step === next;
              return (
                <li
                  key={step.id}
                  className={`lab-start__step${step.done ? " is-done" : ""}${isNext ? " is-next" : ""}`}
                >
                  <span className="lab-start__n" aria-hidden>
                    {step.done ? <Check size={14} /> : index + 1}
                  </span>
                  <div className="lab-start__body">
                    <h3 className="lab-start__t">
                      {t(`lab.road.${stepKey(step.id)}.title` as MessageKey)}{" "}
                      <span className="lab-road__state">
                        {step.done
                          ? t("lab.method.done")
                          : isNext
                            ? t("lab.road.next")
                            : t("lab.method.pending")}
                      </span>
                    </h3>
                    <p>{t(`lab.road.${stepKey(step.id)}.body` as MessageKey)}</p>
                    {!step.done && (
                      <button
                        type="button"
                        className={isNext ? "btn btn--primary btn--sm" : "btn btn--sm lab-start__go"}
                        onClick={() => goStep(step.id)}
                      >
                        {t(`lab.road.${stepKey(step.id)}.action` as MessageKey)}
                        <ArrowRight size={13} aria-hidden />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="lab-panel" aria-labelledby="lab-ov-sev">
        <header className="lab-panel__h">
          <BarChart3 size={15} className="lab-panel__ico" aria-hidden />
          <h2 id="lab-ov-sev" className="lab-panel__t">
            {t("lab.overview.findingSummary")}
          </h2>
          {engFindings.length > 0 && <span className="lab-views__n">{engFindings.length}</span>}
          <button type="button" className="lab-panel__link" onClick={() => open("findings")}>
            {t("lab.overview.openFindings")} <ArrowRight size={13} aria-hidden />
          </button>
        </header>
        <div className="lab-sevband">
          {SEVERITIES.map(({ id, icon: Icon }) => (
            <div key={id} className={`lab-sevband__c sev-${id}`}>
              <strong className={sevCounts[id] === 0 ? "is-zero" : undefined}>{sevCounts[id]}</strong>
              <span>
                <Icon size={13} aria-hidden />
                {t(`lab.severity.${id}` as MessageKey)}
              </span>
            </div>
          ))}
          <div className="lab-sevband__c">
            <strong className={engEvidence.length === 0 ? "is-zero" : undefined}>
              {engEvidence.length}
            </strong>
            <span>
              <Paperclip size={13} aria-hidden />
              {t("lab.view.evidence")}
            </span>
          </div>
        </div>
      </section>

      <div className="lab-ov-grid">
        <section className="lab-panel" aria-labelledby="lab-ov-runs">
          <header className="lab-panel__h">
            <Activity size={15} className="lab-panel__ico" aria-hidden />
            <h2 id="lab-ov-runs" className="lab-panel__t">
              {t("lab.overview.recentRuns")}
            </h2>
            <button type="button" className="lab-panel__link" onClick={() => open("runs")}>
              {t("lab.openRuns")} <ArrowRight size={13} aria-hidden />
            </button>
          </header>
          {recentRuns.length === 0 ? (
            <p className="lab-panel__b lab-panel__empty">{t("lab.runs.noRuns")}</p>
          ) : (
            <table className="lab-ov-runs">
              <thead>
                <tr>
                  <th>{t("lab.runs.status")}</th>
                  <th>{t("lab.runs.command")}</th>
                  <th>{t("lab.runs.scope")}</th>
                  <th>{t("lab.runs.duration")}</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className={`lab-run-state state-${r.state}`}>{runStateLabel(t, r.state)}</span>
                    </td>
                    <td className="mono lab-ov-runs__cmd">{r.commandPreview}</td>
                    <td>
                      {r.scopeId ? (
                        <span className="lab-badge is-allowed">
                          <ShieldCheck size={12} aria-hidden /> {t("lab.runs.scoped")}
                        </span>
                      ) : (
                        <span className="lab-badge">{t("lab.runs.local")}</span>
                      )}
                    </td>
                    <td className="mono">{fmtDuration(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div className="lab-ov-side">
          <section className="lab-panel" aria-labelledby="lab-ov-evidence">
            <header className="lab-panel__h">
              <Paperclip size={15} className="lab-panel__ico" aria-hidden />
              <h2 id="lab-ov-evidence" className="lab-panel__t">
                {t("lab.overview.evidenceMissing")}
              </h2>
              {missingEvidence.length > 0 && (
                <span className="lab-views__n">{missingEvidence.length}</span>
              )}
            </header>
            {missingEvidence.length === 0 ? (
              <p className="lab-panel__b lab-panel__empty">
                {engFindings.length === 0
                  ? t("lab.overview.noFindings")
                  : t("lab.overview.allHaveEvidence")}
              </p>
            ) : (
              <ul className="lab-panel__b lab-ov-needs">
                {missingEvidence.slice(0, 6).map((f) => (
                  <li key={f.id}>
                    <button type="button" onClick={() => open("findings", f.id)}>
                      <span className={`lab-sev sev-${f.severity}`}>
                        {t(`lab.severity.${f.severity}` as MessageKey)}
                      </span>
                      <span className="lab-ov-needs__main">
                        <strong>{f.title}</strong>
                        {f.affectedTargets[0] && <small className="mono">{f.affectedTargets[0]}</small>}
                      </span>
                      <ChevronRight size={15} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* The report itself is the Report section; this only says how many
              were saved and leads there. */}
          <section className="lab-panel" aria-labelledby="lab-ov-report">
            <header className="lab-panel__h">
              <FileText size={15} className="lab-panel__ico" aria-hidden />
              <h2 id="lab-ov-report" className="lab-panel__t">
                {t("lab.report.title")}
              </h2>
              <button type="button" className="lab-panel__link" onClick={() => open("report")}>
                {t("lab.view.report")} <ArrowRight size={13} aria-hidden />
              </button>
            </header>
            <p className="lab-panel__b lab-panel__empty">
              {engReports.length > 0
                ? `${t("lab.report.count", { count: engReports.length })} · ${shortDate(engReports[0]!.createdAt)}`
                : t("lab.report.none")}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
