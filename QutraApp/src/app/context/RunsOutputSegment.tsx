import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Copy,
  Eraser,
  FileSearch,
  Paperclip,
  Play,
  ShieldCheck,
  Square,
  SquareTerminal,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb, useCollection } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { now } from "@/lib/time";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { evidenceFromArtifact, evidenceFromRunOutput } from "@/domain/lab/evidenceOps";
import { runStateLabel } from "@/features/lab/labels";
import { openLocalPath } from "@/features/files/linkedPaths";
import type { NativeToolRun } from "@/lib/bridge/types";
import { ContextEmpty } from "./ContextEmpty";

const ACTIVE_STATES = ["queued", "starting", "running", "cancelling"];
const PROBLEM_STATES = ["failed", "timed_out", "blocked", "orphaned"];
type View = "output" | "problems" | "audit";

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function duration(run: NativeToolRun, at: number): string {
  if (!run.startedAt) return "—";
  const s = Math.max(0, Math.round(((run.endedAt ?? at) - run.startedAt) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Runs output: the selected native run — what ran, its live output,
 * Stop, and saving the output as evidence once it has ended — with the old
 * bottom panel's Problems and Audit as a small inner switch.
 */
export function RunsOutputSegment() {
  const { t } = useT();
  const navigate = useNavigate();
  const runtime = useLabRuntime();
  const toast = useUi((s) => s.toast);
  const events = useCollection("events");
  const profiles = useCollection("toolProfiles");
  const [view, setView] = useState<View>("output");

  const run = runtime.runs.find((r) => r.id === runtime.selectedRunId);
  const installation = run
    ? runtime.installations.find((i) => i.id === run.installationId)
    : undefined;
  const profile = run ? profiles.find((p) => p.id === run.profileId) : undefined;
  const problems = runtime.runs.filter((r) => PROBLEM_STATES.includes(r.state));
  const active = run ? ACTIVE_STATES.includes(run.state) : false;

  const captured = runtime.logs[run?.id ?? ""] ?? [];
  const cleared = run ? runtime.clearedLogs[run.id] === true : false;
  const fallback = useMemo(() => {
    if (!run || captured.length > 0 || cleared) return [];
    const lines: { stream: "stdout" | "stderr"; text: string }[] = [];
    for (const l of run.stdoutTail.split(/\r?\n/)) if (l) lines.push({ stream: "stdout", text: l });
    for (const l of run.stderrTail.split(/\r?\n/)) if (l) lines.push({ stream: "stderr", text: l });
    return lines;
  }, [run, captured.length, cleared]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [captured.length, fallback.length, view]);

  const hasOutput = !!run && (run.stdoutTail.trim() !== "" || run.stderrTail.trim() !== "");
  const saveReason = active ? t("ctx.runs.saveWhenEnded") : !hasOutput ? t("ctx.runs.saveNoOutput") : "";

  /* Each action reports what actually happened: success only after it
     succeeded, a failure the user can act on otherwise. */
  const saveOutput = async () => {
    if (!run || saveReason) return;
    try {
      for (const stream of ["stdout", "stderr"] as const) {
        const content = stream === "stdout" ? run.stdoutTail : run.stderrTail;
        if (!content.trim()) continue;
        const evidence = await evidenceFromRunOutput({
          runId: run.id,
          engagementId: run.engagementId,
          targetId: run.targetId,
          content,
          stream,
          commandPreview: run.commandPreview,
          now: now(),
        });
        getDb().collection("evidence").put(evidence);
      }
    } catch {
      toast({ kind: "danger", messageKey: "ctx.runs.saveFailed" });
      return;
    }
    toast({ kind: "success", messageKey: "lab.evidence.saved" });
  };

  const saveArtifact = (path: string, kind: string, sizeBytes: number) => {
    if (!run) return;
    try {
      getDb()
        .collection("evidence")
        .put(
          evidenceFromArtifact({
            runId: run.id,
            engagementId: run.engagementId,
            targetId: run.targetId,
            path,
            kind: kind === "stderr" ? "stderr" : kind === "stdout" ? "stdout" : "file",
            sizeBytes,
            now: now(),
          }),
        );
    } catch {
      toast({ kind: "danger", messageKey: "ctx.runs.saveFailed" });
      return;
    }
    toast({ kind: "success", messageKey: "lab.evidence.saved" });
  };

  const copyOutput = async () => {
    const text = captured.length
      ? captured.map((l) => `[${clock(l.at)}] ${l.stream}: ${l.text}`).join("\n")
      : fallback.map((l) => `${l.stream}: ${l.text}`).join("\n");
    let ok = false;
    try {
      ok = (await getBridge().writeClipboard(text)).ok;
    } catch {
      ok = false;
    }
    toast(
      ok
        ? { kind: "success", messageKey: "panel.copied" }
        : { kind: "danger", messageKey: "ctx.runs.copyFailed" },
    );
  };

  /* Native cancel rejects when the run already ended or the supervisor is
     unavailable. Say so, then re-read: the stopped state itself arrives
     through native events, never from here. */
  const stop = async (target: NativeToolRun) => {
    try {
      await getBridge().toolSupervisor.cancel(target.id);
    } catch {
      toast({
        kind: "danger",
        messageKey: "ctx.runs.stopFailed",
        params: { tool: installation?.displayName ?? target.installationId },
      });
    }
    void runtime.refresh();
  };

  const tabs: { id: View; label: string; count?: number }[] = [
    { id: "output", label: t("panel.output") },
    { id: "problems", label: t("panel.problems"), count: problems.length },
    { id: "audit", label: t("panel.audit") },
  ];

  return (
    <div className="ctx-runs">
      {run && (
        <section className="ctx-run">
          <div className="ctx-run__head">
            <span className="ctx-ricon" aria-hidden>
              <SquareTerminal size={16} />
            </span>
            <div className="ctx-run__names">
              <strong>
                {installation?.displayName ?? run.installationId}
                {profile ? ` · ${profile.name}` : ""}
              </strong>
              {run.target && <span className="mono">{run.target}</span>}
            </div>
            <button
              type="button"
              className="ctx-icon-btn"
              onClick={() =>
                navigate(
                  run.engagementId
                    ? `/lab?e=${encodeURIComponent(run.engagementId)}&view=runs`
                    : "/lab?view=runs",
                )
              }
              aria-label={t("panel.goToRun")}
              title={t("panel.goToRun")}
            >
              <ArrowUpRight size={15} aria-hidden />
            </button>
          </div>
          <div className="ctx-run__chips">
            <span className={`lab-run-state state-${run.state}`}>
              {runStateLabel(t, run.state)} · {duration(run, now())}
            </span>
            {run.scopeId ? (
              <span className="lab-badge is-allowed">
                <ShieldCheck size={12} aria-hidden /> {t("lab.runs.scoped")}
              </span>
            ) : (
              <span className="lab-badge">{t("lab.runs.local")}</span>
            )}
            <span className="ctx-grow" />
            {active && (
              <button
                type="button"
                className="btn btn--danger-outline btn--sm"
                onClick={() => void stop(run)}
                disabled={run.state === "cancelling"}
              >
                <Square size={12} aria-hidden /> {t("lab.tools.stop")}
              </button>
            )}
          </div>
          <dl className="ctx-kv">
            <dt>{t("lab.insp.executable")}</dt>
            <dd className="mono" title={installation?.canonicalPath}>
              {installation?.canonicalPath ?? run.installationId}
            </dd>
            <dt>{t("lab.insp.args")}</dt>
            <dd className="mono">{run.argv.join(" ") || "—"}</dd>
            <dt>{t("lab.insp.started")}</dt>
            <dd className="mono">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</dd>
            {run.workingDir && (
              <>
                <dt>{t("lab.insp.workingDir")}</dt>
                <dd className="mono">{run.workingDir}</dd>
              </>
            )}
            {run.exitCode !== undefined && (
              <>
                <dt>{t("lab.insp.exitCode")}</dt>
                <dd className="mono">{run.exitCode}</dd>
              </>
            )}
            {(run.terminationReason || run.blockedReason) && (
              <>
                <dt>{t("lab.insp.reason")}</dt>
                <dd>{run.terminationReason || run.blockedReason}</dd>
              </>
            )}
          </dl>
          {run.artifacts.length > 0 && (
            <ul className="ctx-artifacts">
              {run.artifacts.map((a) => (
                <li key={a.path}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void openLocalPath(a.path)}
                    title={a.path}
                  >
                    <FileSearch size={13} aria-hidden /> {a.kind} · {a.sizeBytes} B
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => saveArtifact(a.path, a.kind, a.sizeBytes)}
                  >
                    <Paperclip size={12} aria-hidden /> {t("lab.insp.asEvidence")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="ctx-runs__bar">
        <div className="ctx-sseg" role="tablist" aria-label={t("ctx.runs.views")}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={view === tab.id}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className="ctx-n">{tab.count}</span>
              )}
            </button>
          ))}
        </div>
        <span className="ctx-grow" />
        {view === "output" && run && (
          <>
            <button
              type="button"
              className="ctx-icon-btn"
              onClick={() => void copyOutput()}
              aria-label={t("panel.copy")}
              title={t("panel.copy")}
            >
              <Copy size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ctx-icon-btn"
              onClick={() => runtime.clearLog(run.id)}
              aria-label={t("panel.clearView")}
              title={t("panel.clearView")}
            >
              <Eraser size={14} aria-hidden />
            </button>
          </>
        )}
      </div>

      {view === "output" &&
        (!run ? (
          <ContextEmpty
            icon={SquareTerminal}
            title={t("ctx.runs.emptyTitle")}
            hint={t("ctx.runs.emptyHint")}
            action={
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => navigate("/lab?view=runs")}
              >
                <Play size={13} aria-hidden /> {t("lab.openRuns")}
              </button>
            }
          />
        ) : (
          <div className="ctx-log" ref={logRef} role="log" aria-live="polite">
            {captured.length === 0 && fallback.length === 0 ? (
              <p className="ctx-log__wait">{t("lab.tools.waitingOutput")}</p>
            ) : captured.length > 0 ? (
              captured.map((l, i) => (
                <div key={i} className={`ctx-log__ln stream-${l.stream}`}>
                  <span className="ctx-log__time">{clock(l.at)}</span>
                  <span>
                    {l.stream === "stderr" && <span className="ctx-log__err">stderr</span>}
                    {l.text}
                  </span>
                </div>
              ))
            ) : (
              fallback.map((l, i) => (
                <div key={i} className={`ctx-log__ln ctx-log__ln--bare stream-${l.stream}`}>
                  <span>
                    {l.stream === "stderr" && <span className="ctx-log__err">stderr</span>}
                    {l.text}
                  </span>
                </div>
              ))
            )}
          </div>
        ))}

      {view === "problems" &&
        (problems.length === 0 ? (
          <p className="ctx-note">{t("ctx.runs.noProblems")}</p>
        ) : (
          <ul className="ctx-list">
            {problems.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="ctx-row"
                  onClick={() => {
                    runtime.selectRun(r.id);
                    setView("output");
                  }}
                >
                  <span className={`lab-run-state state-${r.state}`}>{runStateLabel(t, r.state)}</span>
                  <span className="ctx-row__main">
                    <span className="mono ctx-trunc">{r.commandPreview}</span>
                    <small>{r.terminationReason || r.blockedReason}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {view === "audit" &&
        (events.length === 0 ? (
          <p className="ctx-note">{t("ctx.runs.noAudit")}</p>
        ) : (
          <ul className="ctx-audit">
            {[...events]
              .sort((a, b) => b.at - a.at)
              .slice(0, 50)
              .map((e) => (
                <li key={e.id}>
                  <time className="mono">{clock(e.at)}</time>
                  <span className="ctx-trunc">{e.label}</span>
                </li>
              ))}
          </ul>
        ))}

      {run && (
        <footer className="ctx-foot">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => void saveOutput()}
            disabled={!!saveReason}
            aria-describedby={saveReason ? "ctx-save-reason" : undefined}
          >
            <Paperclip size={13} aria-hidden /> {t("ctx.runs.save")}
          </button>
          {saveReason && (
            <span id="ctx-save-reason" className="ctx-reason">
              {saveReason}
            </span>
          )}
        </footer>
      )}
    </div>
  );
}
