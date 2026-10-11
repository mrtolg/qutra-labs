import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleDashed,
  Download,
  FilePlus2,
  FileQuestion,
  Loader2,
  Pin,
  Play,
  RotateCcw,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  analysis,
  type AnalysisRun,
  type AnalyzerDescriptor,
  type Observation,
} from "@/lib/analysis";
import { getBridge } from "@/lib/bridge";
import { getDb, useCollection } from "@/lib/db/database";
import { grantPrivateLab } from "@/lib/enablePrivateLab";
import { externalTools, type ExternalToolView } from "@/lib/externalTools";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { useUi } from "@/state/ui";
import { HINTS, STEP_NAMES, observationLabel, observationShown, own } from "./analysisLabels";
import {
  isRulesFile,
  latestRuns,
  planSteps,
  suggestedToRun,
  type Step,
  type StepOffer,
  type StepState,
} from "./analysisPlan";
import { fileKindLabelKey } from "./fileKinds";
import {
  evidenceFromObservation,
  findingFromObservation,
  observationTitle,
  pinnedEvidence,
} from "./observationEvidence";
import { useLocateTool, type LocatePreset } from "./useLocateTool";

/**
 * The suggested analysis of one file (spec 2026-10-07 §5.3),
 * under its card: the built-in steps for its kind with their states, a
 * button that runs the suggested ones, and what they found in three
 * layers: Özet, İlginç and the raw output. Rust checks the copy's SHA-256
 * before each step reads it; nothing here names a path or runs the file.
 */

const STATE_ICONS: Record<StepState, LucideIcon> = {
  done: CheckCircle2,
  failed: XCircle,
  running: Loader2,
  queued: Circle,
  optional: CircleDashed,
  install: Download,
  consent: ShieldAlert,
  rules: FileQuestion,
  check: AlertTriangle,
};

/** Examples shown before the rest fold away. */
const SHOWN_ITEMS = 5;

/** What a program said when it failed: beside other facts it is a warning
    about them, not a sign that there is no result. */
const isToolError = (o: Observation) => o.key.endsWith(".error");
/** Facts that say what was asked, not what was found. */
const NOT_A_RESULT = new Set(["yara.rulesFile"]);

const NO_FILES: readonly InvestigationFile[] = [];

/** What the form that locates a program preselects for this tool. */
const presetOf = (tool: ExternalToolView): LocatePreset => ({
  catalogId: tool.catalogId,
  name: tool.name,
  category: tool.category,
});

/** Words for Rust's code, from a refused call or a run that ended. A code
    this page has no words for gets the general one: some carry the system's
    own text and are not shown as they came. */
function errorKey(code: string | undefined): MessageKey {
  switch (code) {
    case "file_changed":
      return "lab.analysis.error.fileChanged";
    case "file_missing":
      return "lab.analysis.error.fileMissing";
    case "unknown_file":
      return "lab.analysis.error.fileUnknown";
    case "busy":
      return "lab.analysis.error.busy";
    case "no_engagement_folder":
      return "lab.analysis.error.noFolder";
    case "tool_not_installed":
    case "tool_not_registered":
    case "unknown_tool":
      return "lab.analysis.error.toolMissing";
    // These two arrive as a refused call, or as a blocked run's reason.
    case "tool_identity_changed":
      return "lab.analysis.error.toolChanged";
    case "tool_disabled":
      return "lab.analysis.error.toolDisabled";
    case "tool_path_missing":
      return "lab.analysis.error.toolGone";
    case "tool_not_for_kind":
      return "lab.analysis.error.notForKind";
    case "private_tools_consent_required":
    case "consent_revoked":
      return "lab.analysis.error.consent";
    case "file_too_large":
      return "lab.analysis.error.tooLarge";
    case "input_too_large":
      return "lab.analysis.error.pathTooLong";
    case "input_not_delivered":
      return "lab.analysis.error.notDelivered";
    case "rules_required":
    case "rules_not_text":
      return "lab.analysis.error.rules";
    case "unknown_rules_file":
      return "lab.analysis.error.rulesUnknown";
    case "rules_too_large":
      return "lab.analysis.error.rulesTooLarge";
    case "rules_include_not_allowed":
      return "lab.analysis.error.rulesInclude";
    case "run_ledger_read_only":
      return "lab.analysis.error.ledgerReadOnly";
    case "run_ledger_backup_failed":
      return "lab.analysis.error.ledgerBackup";
    case "concurrency_limit_reached":
    case "exclusive_run_active":
      return "lab.analysis.error.toolBusy";
    case "timeout":
      return "lab.analysis.error.timeout";
    case "run_wait_timeout":
      return "lab.analysis.error.waitTimeout";
    case "spawn_failed":
      return "lab.analysis.error.spawnFailed";
    case "elevation_required":
      return "lab.analysis.error.elevation";
    case "external_tool_failed":
      return "lab.analysis.error.toolCrashed";
    case "non_zero_exit":
      return "lab.analysis.error.toolFailed";
    case "output_unreadable":
      return "lab.analysis.error.unreadable";
    case "user_cancelled":
    case "emergency_stop":
      return "lab.analysis.error.cancelled";
    // A run that was live when Qutra Labs closed, found at the next start.
    case "app_restarted":
      return "lab.analysis.error.appRestarted";
    default:
      return "lab.analysis.error.failed";
  }
}

/** The fix a step needs before it can run, when its program is not ready.
    A step that has run before keeps the state of its last run ("failed",
    "done") and has the same need: the state says what happened, this says
    what to do about it. */
function fixOf(step: Step): "install" | "consent" | "rules" | "check" | null {
  if (
    step.state === "install" ||
    step.state === "consent" ||
    step.state === "rules" ||
    step.state === "check"
  ) {
    return step.state;
  }
  if ((step.state !== "failed" && step.state !== "done") || !step.external) return null;
  switch (step.external.status) {
    case "needs_consent":
      return "consent";
    case "not_installed":
      return "install";
    case "disabled":
    case "changed":
      return "check";
    case "ready":
      return step.canRun ? null : "rules";
  }
}

/** Words for what the flow that locates a program answered with: a code of
    Rust's, or text the flow already put in the reader's language. */
function locateErrorKey(code: string): MessageKey {
  switch (code) {
    case "picker_unavailable":
    case "locate_dialog_failed":
      return "lab.analysis.locateError.picker";
    case "tool_already_registered":
      return "lab.analysis.locateError.registered";
    case "registry_read_only":
      return "lab.analysis.locateError.readOnly";
    case "unsupported_tool_type":
      return "lab.analysis.locateError.notProgram";
    case "invalid_tool_filename":
    case "tool_path_not_file":
    case "invalid_tool_path":
      return "lab.analysis.locateError.badFile";
    default:
      return "lab.analysis.locateError.general";
  }
}

export function FileAnalysis({ file }: { file: InvestigationFile }) {
  const { t } = useT();
  const available = analysis.available();
  const [offered, setOffered] = useState<AnalyzerDescriptor[]>([]);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  /** The programs outside Qutra Labs, and their runs on this investigation. */
  const [tools, setTools] = useState<ExternalToolView[]>([]);
  const [toolRuns, setToolRuns] = useState<AnalysisRun[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  /** "Önerilenleri çalıştır" is going through its steps. */
  const [series, setSeries] = useState(false);
  /** Why Rust refused the last step, in its code. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Why locating a program failed, in the words the locate flow gave. */
  const [locateError, setLocateError] = useState("");
  /** What the status line tells a screen reader: a step running or ended. */
  const [announcement, setAnnouncement] = useState("");
  const [rulesId, setRulesId] = useState("");
  const mounted = useRef(true);
  const siblings = useInvestigationFiles((s) => s.byEngagement[file.engagementId] ?? NO_FILES);
  const rulesFiles = useMemo(() => siblings.filter(isRulesFile), [siblings]);
  const rules = rulesFiles.find((item) => item.id === rulesId) ?? rulesFiles[0];
  const engagement = useCollection("engagements").find((item) => item.id === file.engagementId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!available) return;
    let live = true;
    Promise.all([analysis.analyzers(), analysis.list(file.engagementId)]).then(
      ([descriptors, list]) => {
        if (!live) return;
        setOffered(descriptors);
        setRuns(list);
      },
      (caught: unknown) => {
        console.error("built-in analysis not loaded", caught);
        if (live) setRefusal("analysis_failed");
      },
    );
    return () => {
      live = false;
    };
  }, [available, file.engagementId]);

  /** The outside programs and their runs. A failed read leaves the built-in
      steps alone; the runs need Private Lab, the list does not. `keep`: a run
      this page was just handed, which the ledger read may not hold yet. */
  const reloadTools = useCallback(
    async (keep?: AnalysisRun) => {
      try {
        const [list, ran] = await Promise.all([
          externalTools.list(),
          externalTools.runs(file.engagementId).catch((): AnalysisRun[] => []),
        ]);
        if (mounted.current) {
          setTools(list);
          setToolRuns(keep && !ran.some((item) => item.id === keep.id) ? [keep, ...ran] : ran);
        }
      } catch (caught) {
        console.error("outside tools not loaded", caught);
      }
    },
    [file.engagementId],
  );

  useEffect(() => {
    if (available) void reloadTools();
  }, [available, reloadTools]);

  // A run that began before this page opened still ends in Rust: look again
  // until it does.
  const inFlight = toolRuns.some((item) => item.state === "running");
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => void reloadTools(), 1500);
    return () => window.clearInterval(timer);
  }, [inFlight, reloadTools]);

  const locator = useLocateTool({
    engagement,
    onError: (message) =>
      setLocateError(
        message === "" || message === t("lab.tools.locateAgain")
          ? message
          : t(locateErrorKey(message)),
      ),
    onRegistered: () => void reloadTools(),
  });

  if (!available) {
    return (
      <section className="lab-ana" data-testid="lab-file-analysis">
        <h3 className="lab-fcard__sub">{t("lab.analysis.title")}</h3>
        <p className="lab-fcard__note">{t("lab.analysis.desktopOnly")}</p>
      </section>
    );
  }

  const offers: StepOffer[] = [
    ...offered,
    ...tools.map((tool) => ({
      id: tool.id,
      accepts: tool.accepts,
      external: { status: tool.status, needsRules: tool.needsRules },
    })),
  ];
  const all = [...runs, ...toolRuns];
  const rulesReady = Boolean(rules && !rules.missing);
  const steps = planSteps(file.kind, offers, all, file.id, running, rulesReady);
  const queued = suggestedToRun(steps);
  const blocked =
    running !== null || series || file.missing || steps.some((step) => step.state === "running");

  /** Run one step; false when Rust refused it. */
  const runStep = async (analyzer: string): Promise<boolean> => {
    const tool = tools.find((item) => item.id === analyzer);
    setRunning(analyzer);
    setRefusal(null);
    setLocateError("");
    setAnnouncement(t("lab.analysis.announceRunning", { name: stepName(t, analyzer) }));
    try {
      const run = tool
        ? await externalTools.run(file.engagementId, file.id, analyzer, tool.needsRules ? rules?.id : undefined)
        : await analysis.run(file.engagementId, file.id, analyzer);
      if (mounted.current) {
        if (tool) setToolRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)]);
        else setRuns((prev) => [run, ...prev]);
        // A run that came back blocked or failed can mean the program is not
        // what it was (changed, turned off, gone): read it again, so the row
        // says what to fix as it would after a reload.
        if (tool && run.state !== "finished") void reloadTools(run);
        setAnnouncement(
          t(
            run.state === "finished"
              ? "lab.analysis.announceDone"
              : "lab.analysis.announceFailed",
            { name: stepName(t, analyzer) },
          ),
        );
      }
      return true;
    } catch (caught) {
      if (mounted.current) {
        setRefusal(typeof caught === "string" ? caught : "analysis_failed");
        setAnnouncement("");
        // A refused start can still have left a row (a program that would
        // not start), and a wait that ran out leaves the run going: read the
        // ledger again so the step shows what it holds.
        if (tool) void reloadTools();
      }
      return false;
    } finally {
      if (mounted.current) setRunning(null);
    }
  };

  const runSuggested = async () => {
    if (blocked || queued.length === 0) return;
    setSeries(true);
    try {
      for (const step of queued) {
        if (!mounted.current || !(await runStep(step.analyzer))) break;
      }
    } finally {
      if (mounted.current) setSeries(false);
    }
  };

  /** Turn Private Lab on (Rust asks the user), then look at the tools again. */
  const enable = async () => {
    if ((await grantPrivateLab()) === "granted") await reloadTools();
  };

  /** Open a program's download page; say so when it cannot be opened. */
  const download = async (url: string) => {
    setLocateError("");
    try {
      const opened = await getBridge().openUrl(url);
      if (!opened.ok && mounted.current) setLocateError(t("lab.analysis.downloadFailed", { url }));
    } catch {
      if (mounted.current) setLocateError(t("lab.analysis.downloadFailed", { url }));
    }
  };

  const latest = latestRuns(all, file.id);
  // A run that failed still shows what it read before it did: a damaged
  // capture is read in part, and its facts are worth having.
  const shown = steps
    .map((step) => latest.get(step.analyzer))
    .filter(
      (run): run is AnalysisRun =>
        run !== undefined &&
        (run.state === "finished" || (run.state === "failed" && run.observations.length > 0)),
    );

  return (
    <section
      className="lab-ana"
      aria-labelledby={`lab-ana-${file.id}`}
      data-testid="lab-file-analysis"
    >
      <div className="lab-ana__head">
        <h3 id={`lab-ana-${file.id}`} className="lab-fcard__sub">
          {t("lab.analysis.title")}
        </h3>
        {/* aria-disabled, not disabled: a disabled button would drop the
            focus it just took. */}
        <button
          type="button"
          className="btn btn--primary btn--sm"
          aria-disabled={blocked || queued.length === 0 || undefined}
          onClick={() => void runSuggested()}
        >
          {series ? (
            <Loader2 size={13} className="spin" aria-hidden />
          ) : (
            <Play size={13} aria-hidden />
          )}{" "}
          {t("lab.analysis.runSuggested")}
        </button>
      </div>
      {file.missing && (
        <p className="lab-fcard__note is-warn">
          <AlertTriangle size={13} aria-hidden /> {t("lab.analysis.missing")}
        </p>
      )}
      <ol className="lab-ana__steps">
        <li className="lab-ana__step is-done">
          <CheckCircle2 size={14} aria-hidden />
          <span className="lab-ana__name">{t("lab.analysis.step.hashes")}</span>
          <span className="lab-ana__state">{t("lab.analysis.state.added")}</span>
        </li>
        {steps.map((step) => {
          const tool = tools.find((item) => item.id === step.analyzer);
          return (
            <StepRow
              key={step.analyzer}
              step={step}
              tool={tool}
              disabled={blocked}
              rules={
                tool?.needsRules
                  ? { files: rulesFiles, selected: rules?.id, onSelect: setRulesId }
                  : undefined
              }
              onRun={() => void runStep(step.analyzer)}
              onLocate={() => tool && void locator.locate(presetOf(tool))}
              onDownload={() => tool && void download(tool.installUrl)}
              onEnable={() => void enable()}
            />
          );
        })}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {refusal && (
        <p className="callout callout--warning lab-ana__refusal" role="alert">
          {t(errorKey(refusal))}
        </p>
      )}
      {locateError && (
        <p className="callout callout--warning lab-ana__refusal" role="alert">
          {locateError}
        </p>
      )}
      {shown.length > 0 && <Layers runs={shown} kind={file.kind} fileName={file.name} />}
      {locator.dialog}
    </section>
  );
}

function stepName(t: ReturnType<typeof useT>["t"], analyzer: string): string {
  const key = own(STEP_NAMES, analyzer);
  return key ? t(key) : analyzer;
}

function StepRow({
  step,
  tool,
  disabled,
  rules,
  onRun,
  onLocate,
  onDownload,
  onEnable,
}: {
  step: Step;
  /** The outside program behind the step, when it is one. */
  tool: ExternalToolView | undefined;
  disabled: boolean;
  /** YARA's rules files in the investigation, and the chosen one. */
  rules: { files: InvestigationFile[]; selected: string | undefined; onSelect: (id: string) => void } | undefined;
  onRun: () => void;
  onLocate: () => void;
  onDownload: () => void;
  onEnable: () => void;
}) {
  const { t, locale } = useT();
  const Icon = STATE_ICONS[step.state];
  const name = stepName(t, step.analyzer);
  const again = step.state === "done" || step.state === "failed";
  // What the program needs before it can run again. Its state says how the
  // last run ended; this says what to do about it.
  const fix = fixOf(step);
  const state =
    step.state === "done" && step.run
      ? t("lab.analysis.state.doneAt", {
          time: new Date(step.run.endedAt).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        })
      : step.state === "failed"
        ? t("lab.analysis.state.failed", { reason: t(errorKey(step.run?.error)) })
        : step.state === "running"
          ? t("lab.analysis.running")
          : step.state === "queued"
            ? t("lab.analysis.state.queued")
            : step.state === "install"
              ? t("lab.analysis.state.install")
              : step.state === "consent"
                ? t("lab.analysis.state.consent")
                : step.state === "rules"
                  ? t("lab.analysis.state.rules")
                  : step.state === "check"
                    ? t("lab.analysis.state.check")
                    : t("lab.analysis.state.optional");
  const note =
    fix === "install" && tool
      ? t("lab.analysis.installHint", { name: tool.name, file: tool.executables[0] ?? tool.name })
      : fix === "consent"
        ? t("lab.analysis.consentHint")
        : fix === "rules"
          ? t("lab.analysis.rulesHint")
          : fix === "check"
            ? t("lab.analysis.checkHint")
            : null;
  const verb = again ? t("lab.analysis.rerun") : t("lab.analysis.run");
  const busy = step.state === "running";
  return (
    <li className={`lab-ana__step is-${step.state}`}>
      <Icon size={14} className={busy ? "spin" : undefined} aria-hidden />
      <span className="lab-ana__name">{name}</span>
      <span className="lab-ana__state">{state}</span>
      <span className="lab-ana__actions">
        {fix === "install" ? (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-disabled={disabled || undefined}
              aria-label={`${t("lab.analysis.locate")}: ${name}`}
              onClick={() => {
                if (!disabled) onLocate();
              }}
            >
              {t("lab.analysis.locate")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-label={`${t("lab.analysis.download")}: ${name}`}
              onClick={onDownload}
            >
              {t("lab.analysis.download")}
            </button>
          </>
        ) : fix === "consent" ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={`${t("tools.enable")}: ${name}`}
            onClick={onEnable}
          >
            {t("tools.enable")}
          </button>
        ) : fix === "rules" || fix === "check" ? null : (
          /* Kept while its step runs, with aria-disabled: unmounting or
             disabling it would drop the keyboard focus it holds. */
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-disabled={disabled || !step.canRun || undefined}
            aria-label={`${verb}: ${name}`}
            onClick={() => {
              if (!disabled && step.canRun) onRun();
            }}
          >
            {busy ? (
              <Loader2 size={13} className="spin" aria-hidden />
            ) : again ? (
              <RotateCcw size={13} aria-hidden />
            ) : (
              <Play size={13} aria-hidden />
            )}{" "}
            {verb}
          </button>
        )}
      </span>
      {rules && rules.files.length > 1 && fix !== "install" && (
        <label className="lab-ana__rules">
          {t("lab.analysis.rulesFile")}
          <select
            className="select"
            value={rules.selected ?? ""}
            onChange={(event) => rules.onSelect(event.target.value)}
          >
            {rules.files.map((item) => (
              <option key={item.id} value={item.id}>
                {item.originalName}
              </option>
            ))}
          </select>
        </label>
      )}
      {note && <p className="lab-ana__step-note">{note}</p>}
      {fix === "install" && tool?.id === "exiftool" && (
        <p className="lab-ana__step-note">{t("lab.analysis.installRename")}</p>
      )}
      {fix === "install" && tool?.id === "yara" && (
        <p className="lab-ana__step-note">{t("lab.analysis.installYara")}</p>
      )}
    </li>
  );
}

/** Under a flagged observation: keep it as evidence, or make it a finding
    with that evidence (spec §5.3 "Kanıt olarak sabitle", "Bulgu oluştur").
    One evidence row belongs to one finding, so a kept observation already in
    a finding says so instead of offering another. */
function FlagActions({
  run,
  observation,
  label,
  shown,
  hint,
  fileName,
}: {
  run: AnalysisRun;
  observation: Observation;
  label: string;
  shown: string;
  hint?: string;
  fileName: string;
}) {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const evidence = useCollection("evidence");
  const findings = useCollection("findings");
  const kept = pinnedEvidence(evidence, run, observation, observationTitle(observation, label, shown));
  // Linked only while that finding is there: a finding removed since leaves
  // the evidence free to make another.
  const linked = Boolean(kept?.findingId && findings.some((f) => f.id === kept.findingId));
  const [busy, setBusy] = useState(false);
  // The first button stays mounted in every state, so focus can rest on it
  // when "Make a finding" goes away.
  const keepRef = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (refocus && linked) {
      keepRef.current?.focus();
      setRefocus(false);
    }
  }, [refocus, linked]);

  const keep = async () => {
    if (busy || kept) return;
    setBusy(true);
    try {
      const item = await evidenceFromObservation({ run, observation, label, shown, hint, now: Date.now() });
      getDb().collection("evidence").put(item);
      toast({ kind: "success", messageKey: "lab.evidence.saved" });
    } catch {
      toast({ kind: "danger", messageKey: "lab.analysis.pinFailed" });
    } finally {
      setBusy(false);
    }
  };

  const makeFinding = async () => {
    if (busy || linked) return;
    // Before the writes: they re-render, and this button goes away.
    const focusHere = Boolean(keepRef.current?.parentElement?.contains(document.activeElement));
    setBusy(true);
    try {
      const db = getDb();
      const now = Date.now();
      const finding = findingFromObservation({ run, observation, label, shown, hint, target: fileName, now });
      const item = kept
        ? { ...kept, findingId: finding.id }
        : await evidenceFromObservation({ run, observation, label, shown, hint, now, findingId: finding.id });
      // The finding first: if the evidence write fails, it is a draft, not
      // evidence pointing at nothing. Evidence.findingId is the link;
      // Finding.evidenceIds its mirror.
      db.collection("findings").put({ ...finding, evidenceIds: [item.id] });
      db.collection("evidence").put(item);
      if (focusHere) setRefocus(true);
      toast({ kind: "success", messageKey: "lab.analysis.findingMade" });
    } catch {
      toast({ kind: "danger", messageKey: "lab.analysis.pinFailed" });
    } finally {
      setBusy(false);
    }
  };

  const keepText = linked
    ? t("lab.analysis.linked")
    : kept
      ? t("lab.analysis.pinned")
      : t("lab.analysis.pin");
  return (
    <div className="lab-ana__keep">
      <button
        ref={keepRef}
        type="button"
        className={`btn btn--ghost btn--sm${kept ? " lab-ana__kept" : ""}`}
        aria-label={`${keepText}: ${label}`}
        aria-disabled={busy || Boolean(kept) || undefined}
        onClick={() => void keep()}
      >
        {kept ? <CheckCircle2 size={13} aria-hidden /> : <Pin size={13} aria-hidden />} {keepText}
      </button>
      {!linked && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label={`${t("lab.analysis.makeFinding")}: ${label}`}
          aria-disabled={busy || undefined}
          onClick={() => void makeFinding()}
        >
          <FilePlus2 size={13} aria-hidden /> {t("lab.analysis.makeFinding")}
        </button>
      )}
    </div>
  );
}

function Layers({
  runs,
  kind,
  fileName,
}: {
  runs: AnalysisRun[];
  kind: string;
  fileName: string;
}) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const all = runs.flatMap((run) => run.observations);
  const label = (o: Observation) => observationLabel(t, o);
  const shown = (o: Observation) => observationShown(t, locale, o);
  const facts = (group: Observation["group"]) =>
    all
      .filter((o) => o.group === group)
      .map((o) => (
        <div key={o.id} className={isToolError(o) ? "is-warn" : undefined}>
          <dt>{label(o)}</dt>
          <dd>
            {shown(o)}
            <Items items={o.items} />
          </dd>
        </div>
      ));
  // A program's output that was cut, or that said it failed but still gave
  // facts: either way the results may be incomplete, and the page says so.
  const outside = runs.filter((run) => run.kind === "external");
  const cut = outside.filter((run) => run.limited);
  const partial = outside.filter(
    (run) =>
      run.observations.some(isToolError) &&
      run.observations.some((o) => !isToolError(o) && !NOT_A_RESULT.has(o.key)),
  );
  // Each flagged observation with its run: pinning needs both.
  const flagged = runs.flatMap((run) =>
    run.observations.filter((o) => o.group === "interesting").map((o) => ({ run, o })),
  );
  const details = facts("detail");

  return (
    <div className="lab-ana__layers">
      <h4 className="lab-ana__layer">{t("lab.analysis.layer.summary")}</h4>
      <dl className="lab-fcard__facts">{facts("summary")}</dl>
      {[
        ...cut.map((run) => ({
          id: `cut-${run.id}`,
          text: t("lab.analysis.outputCut", { name: stepName(t, run.analyzer) }),
        })),
        ...partial.map((run) => ({
          id: `partial-${run.id}`,
          text: t("lab.analysis.partial", { name: stepName(t, run.analyzer) }),
        })),
      ].map((note) => (
        <p key={note.id} className="lab-fcard__note is-warn">
          <AlertTriangle size={13} aria-hidden /> {note.text}
        </p>
      ))}
      <h4 className="lab-ana__layer">{t("lab.analysis.layer.interesting")}</h4>
      {flagged.length === 0 ? (
        <p className="lab-fcard__note">{t("lab.analysis.layer.nothing")}</p>
      ) : (
        <ul className="lab-ana__flags">
          {flagged.map(({ run, o }) => {
            const hintKey = o.hint ? own(HINTS, o.hint) : undefined;
            const hint = hintKey
              ? t(hintKey, { value: String(o.value), kind: t(fileKindLabelKey(kind)) })
              : undefined;
            return (
              <li key={o.id} className="lab-ana__flag">
                <AlertTriangle size={14} aria-hidden />
                <div>
                  <p className="lab-ana__flag-head">
                    <strong>{label(o)}</strong> {shown(o)}
                  </p>
                  {hint && <p className="lab-ana__hint">{hint}</p>}
                  <Items items={o.items} />
                  <FlagActions
                    run={run}
                    observation={o}
                    label={label(o)}
                    shown={String(shown(o))}
                    hint={hint}
                    fileName={fileName}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {runs.some((run) => run.kind !== "external" && run.limited) && (
        <p className="lab-fcard__note is-warn">
          <AlertTriangle size={13} aria-hidden /> {t("lab.analysis.limited")}
        </p>
      )}
      <details className="lab-ana__raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>{t("lab.analysis.layer.raw")}</summary>
        {open && (
          <>
            {details.length > 0 && (
              <>
                <h5 className="lab-ana__layer">{t("lab.analysis.layer.details")}</h5>
                <dl className="lab-fcard__facts">{details}</dl>
              </>
            )}
            {runs.map((run) => (
              <RawOutput key={run.id} run={run} />
            ))}
          </>
        )}
      </details>
    </div>
  );
}

/** Examples under an observation; past the first five they fold away. */
function Items({ items }: { items?: string[] }) {
  const { t } = useT();
  if (!items?.length) return null;
  const first = items.slice(0, SHOWN_ITEMS);
  const rest = items.slice(SHOWN_ITEMS);
  return (
    <ul className="lab-ana__items">
      {first.map((item) => (
        <li key={item}>
          <code>{item}</code>
        </li>
      ))}
      {rest.length > 0 && (
        <li>
          <details>
            <summary>{t("lab.analysis.more", { count: rest.length })}</summary>
            <ul className="lab-ana__items">
              {rest.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          </details>
        </li>
      )}
    </ul>
  );
}

/** One step's raw output, read from Rust when the layer opens: a built-in
    step has one text, a program outside Qutra Labs a log of what it printed
    and a log of what it said. A log that no longer matches the hash Rust kept
    is not shown. */
function RawOutput({ run }: { run: AnalysisRun }) {
  const { t } = useT();
  const [parts, setParts] = useState<Array<{ name: string; text: string }> | null>(null);
  const [failed, setFailed] = useState<"" | "missing" | "changed">("");
  // The logs to read, as a value: the page looks at a run again while one of
  // its investigation is going, and the same run comes back as a new object.
  const { id, kind } = run;
  const logs = run.outputs
    .filter((output) => output.bytes > 0)
    .map((output) => `${output.name}:${output.sha256}`)
    .join("|");

  useEffect(() => {
    let live = true;
    setFailed("");
    const read: Promise<Array<{ name: string; text: string }>> =
      kind === "external"
        ? Promise.all(
            logs
              .split("|")
              .filter(Boolean)
              .map(async (log) => {
                const name = log.slice(0, log.indexOf(":"));
                return { name, text: await externalTools.output(id, name) };
              }),
          )
        : analysis.output(id).then((text) => [{ name: "", text }]);
    read.then(
      (value) => {
        if (live) setParts(value);
      },
      (caught: unknown) => {
        console.error("analysis output not read", caught);
        if (live) setFailed(caught === "output_changed" ? "changed" : "missing");
      },
    );
    return () => {
      live = false;
    };
  }, [id, kind, logs]);

  return (
    <section className="lab-ana__out">
      <h5 className="lab-ana__layer">{stepName(t, run.analyzer)}</h5>
      {failed === "changed" ? (
        <p className="lab-fcard__note is-warn">
          <AlertTriangle size={13} aria-hidden /> {t("lab.analysis.outputChanged")}
        </p>
      ) : failed ? (
        <p className="lab-fcard__note is-warn">{t("lab.analysis.outputMissing")}</p>
      ) : parts === null ? (
        <Loader2 size={13} className="spin" aria-hidden />
      ) : parts.length === 0 ? (
        <p className="lab-fcard__note">{t("lab.analysis.out.empty")}</p>
      ) : (
        parts.map((part) => (
          <div key={part.name}>
            {part.name && (
              <h6 className="lab-ana__layer">
                {t(part.name === "stderr.log" ? "lab.analysis.out.messages" : "lab.analysis.out.output")}
              </h6>
            )}
            <pre>{part.text}</pre>
          </div>
        ))
      )}
    </section>
  );
}
