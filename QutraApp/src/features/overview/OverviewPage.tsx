import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  ChevronRight,
  CircleSlash,
  FileWarning,
  Folder,
  List,
  Loader,
  MessageSquare,
  Plus,
  Shield,
  ShieldQuestion,
  Square,
  TerminalSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useCollection, usePreferences } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import type { NativeToolRun } from "@/lib/bridge/types";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { formatRelative } from "@/lib/time";
import { EngagementKind, type Engagement } from "@/domain/lab";
import { engagementStatusLabel, runStateLabel } from "@/features/lab/labels";
import {
  attentionItems,
  openFindingsByEngagement,
  scopeStatusByEngagement,
  type AttentionItem,
  type SeverityCounts,
} from "@/features/lab/investigationFacts";
import { SeverityPips } from "@/features/lab/SeverityPips";
import { KIND_ICON, kindIcon } from "@/features/lab/kindIcon";
import { useRunCommand } from "@/app/useRunCommand";
import type { MessageKey } from "@/lib/i18n/en";
import "./overview.css";

/* Home is a briefing: one sentence on what needs
   the user now, the facts behind it, then the board. Spec 2026-10-07 §5.2
   still holds: what to investigate comes first, as the launch rail on the
   left, and every section renders only when its data exists. Nothing is
   invented: attention items, counts and severities all come from saved
   records and, in the desktop app, from tool runs Rust reports.

   Pending approvals and live terminal sessions are not here yet: both need a
   native source Home can read, and a section that guessed at them
   would lie. */

const ACTIVE_RUN = new Set<NativeToolRun["state"]>([
  "queued",
  "starting",
  "running",
  "cancelling",
]);
const FINISHED_RUN = new Set<NativeToolRun["state"]>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
  "orphaned",
]);
const RECENT_RUNS = 5;
const RECENT_INVESTIGATIONS = 5;
/** More than this and the rest is one link to the Investigations list. */
const ATTENTION_SHOWN = 5;

/** hh:mm:ss, the board's mono clock. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Counters read as instruments (DESIGN.md): two digits at least. */
const pad2 = (n: number) => n.toString().padStart(2, "0");

/** Re-render once a second while something on screen is counting. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}

function Panel({
  id,
  icon: Icon,
  title,
  live,
  className,
  after,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  live?: boolean;
  className?: string;
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={["home-panel", live && "home-panel--live", className].filter(Boolean).join(" ")}
      aria-labelledby={id}
    >
      <div className="home-panel__h">
        <Icon className="home-panel__ico" size={15} strokeWidth={1.8} aria-hidden />
        <h2 id={id} className="home-lbl">
          {title}
        </h2>
        {after}
      </div>
      {children}
    </section>
  );
}

function useToolName() {
  const { t } = useT();
  const installations = useLabRuntime((s) => s.installations);
  return (run: NativeToolRun) =>
    installations.find((i) => i.id === run.installationId)?.displayName ??
    t("home.unknownTool");
}

type Tone = "danger" | "warning" | "clear" | "first";

/** The briefing: today, one sentence on what needs the user, and the counts
    behind it. "Nothing is running" is said only when it is known. */
function Brief({
  tone,
  headline,
  hint,
  stats,
  idleKnown,
}: {
  tone: Tone;
  headline: string;
  hint?: string;
  stats: { label: string; value: number; tone?: "danger" | "live" }[];
  idleKnown: boolean;
}) {
  const { t, locale } = useT();
  const today = new Date().toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return (
    <header className="home-brief" data-tone={tone}>
      <h2 className="home-brief__h">{headline}</h2>
      {hint && <p className="home-brief__hint">{hint}</p>}
      {/* The date is context for the counts, so it sits with them rather
          than as a label over the headline. */}
      <div className="home-brief__facts">
        <p className="home-brief__date">
          <span className="home-brief__beacon" aria-hidden />
          {today}
        </p>
        {stats.length > 0 && (
          <dl className="home-brief__stats" aria-label={t("home.stats")}>
            {stats.map((s) => (
              <div key={s.label} className="home-stat" data-tone={s.tone}>
                <dt>{s.label}</dt>
                <dd>{pad2(s.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {idleKnown && (
          <p className="home-brief__idle">
            <span className="home-brief__idle-dot" aria-hidden />
            {t("home.new.idle")}
          </p>
        )}
      </div>
    </header>
  );
}

/** The first thing Home offers (spec 2026-10-07 §5.2): what to investigate.
    A kind opens the named dialog in Investigations with that kind chosen.
    The whole row is the button's target; its hint describes it. */
function NewInvestigationPanel({ solo }: { solo: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const runCommand = useRunCommand();
  return (
    <section
      className={solo ? "home-panel home-launch is-solo" : "home-panel home-launch"}
      aria-labelledby="home-new"
    >
      <div className="home-panel__h">
        <Plus className="home-panel__ico" size={15} strokeWidth={1.8} aria-hidden />
        <h2 id="home-new" className="home-lbl">
          {t("home.new.title")}
        </h2>
      </div>
      <p className="home-launch__lead">{t("home.new.lead")}</p>
      <ul className="home-launch__list">
        {EngagementKind.options.map((kind) => {
          const Icon = KIND_ICON[kind];
          return (
            <li key={kind} className="home-launch__item">
              <span className="home-launch__ico" aria-hidden>
                <Icon size={17} strokeWidth={1.7} />
              </span>
              <button
                type="button"
                className="home-launch__btn"
                aria-describedby={`home-kind-${kind}`}
                onClick={() => navigate(`/lab?new=1&kind=${kind}`)}
              >
                {t(`lab.kind.${kind}` as MessageKey)}
              </button>
              <span id={`home-kind-${kind}`} className="home-launch__hint">
                {t(`home.kind.${kind}` as MessageKey)}
              </span>
              <ArrowRight className="home-launch__go" size={15} aria-hidden />
            </li>
          );
        })}
      </ul>
      <div className="home-launch__more">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => runCommand("new-terminal")}>
          <TerminalSquare size={14} aria-hidden /> {t("terminal.newTab")}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate("/jarvis")}>
          <MessageSquare size={14} aria-hidden /> {t("home.askJarvis")}
        </button>
      </div>
    </section>
  );
}

const ATTENTION_ICON: Record<AttentionItem["kind"], LucideIcon> = {
  blocked: Ban,
  findings: AlertTriangle,
  scope: ShieldQuestion,
  failedRun: FileWarning,
};

/** What needs the user now, most urgent first, each with the one action
    that deals with it. */
function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const { t } = useT();
  const toolName = useToolName();
  const shown = items.slice(0, ATTENTION_SHOWN);
  const rest = items.length - shown.length;

  const describe = (item: AttentionItem): { what: string; action: string; href: string } => {
    const at = (e: Engagement, view: string) =>
      `/lab?e=${encodeURIComponent(e.id)}&view=${view}`;
    switch (item.kind) {
      case "blocked":
        return {
          what: t("home.attn.blocked", { count: item.count }),
          action: t("home.attn.blockedAction"),
          href: at(item.engagement, "scope"),
        };
      case "findings":
        return {
          what: t("home.attn.findings", { count: item.count }),
          action: t("home.attn.findingsAction"),
          href: at(item.engagement, "findings"),
        };
      case "scope":
        return {
          what: t(item.reason === "not_configured" ? "home.attn.scopeMissing" : "home.attn.scopeAck"),
          action: t("home.attn.scopeAction"),
          href: at(item.engagement, "scope"),
        };
      case "failedRun":
        return {
          what: t("home.attn.failedRun", {
            tool: toolName(item.run),
            state: runStateLabel(t, item.run.state),
          }),
          action: t("home.attn.runsAction"),
          href: item.engagement ? at(item.engagement, "runs") : "/lab?list=1",
        };
    }
  };

  return (
    <Panel
      id="home-attn"
      icon={AlertTriangle}
      title={t("home.attn.title")}
      className="home-attn"
      after={<span className="home-count home-panel__end">{pad2(items.length)}</span>}
    >
      <ul className="home-attn__list">
        {shown.map((item) => {
          const { what, action, href } = describe(item);
          const Icon = ATTENTION_ICON[item.kind];
          const where = item.engagement;
          const WhereIcon = where ? kindIcon(where) : Activity;
          const key =
            item.kind === "failedRun" ? `run-${item.run.id}` : `${item.kind}-${item.engagement.id}`;
          return (
            <li key={key} className="home-attn__item" data-tone={item.tone}>
              <Icon className="home-attn__ico" size={17} strokeWidth={1.8} aria-hidden />
              <div className="home-attn__text">
                <p className="home-attn__what">{what}</p>
                <p className="home-attn__where">
                  <WhereIcon size={13} aria-hidden />
                  <span className="home-trunc" title={where?.title}>
                    {where ? where.title : t("home.attn.noInvestigation")}
                  </span>
                </p>
              </div>
              <Link className="btn btn--sm home-attn__go" to={href}>
                {action}
                <ArrowRight size={13} aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
      {rest > 0 && (
        <Link className="home-link home-link--sm home-attn__more" to="/lab?list=1">
          {t("home.attn.more", { count: rest })}
          <ArrowRight size={14} aria-hidden />
        </Link>
      )}
    </Panel>
  );
}

/** The investigations worked on last, newest first; each opens itself and
    shows its state and open findings without being opened. */
function RecentInvestigationsPanel({
  engagements,
  openFindings,
}: {
  engagements: Engagement[];
  openFindings: Map<string, SeverityCounts>;
}) {
  const { t, locale } = useT();
  return (
    <Panel
      id="home-recent-inv"
      icon={Shield}
      title={t("home.recent.title")}
      after={
        <Link className="home-link home-link--sm home-panel__end" to="/lab?list=1">
          {t("home.recent.all")}
          <ArrowRight size={14} aria-hidden />
        </Link>
      }
    >
      <ul className="home-panel__b">
        {engagements.map((e) => {
          const Icon = kindIcon(e);
          return (
            <li key={e.id}>
              <Link className="home-row home-row--link" to={`/lab?e=${encodeURIComponent(e.id)}`}>
                <span className="home-ricon" aria-hidden>
                  <Icon size={15} strokeWidth={1.7} />
                </span>
                <span className="home-row__main">
                  <span className="home-row__title home-trunc" title={e.title}>
                    {e.title}
                  </span>
                  <span className="home-faint home-small home-row__meta">
                    {t(`lab.kind.${e.kind ?? "general"}` as MessageKey)} ·{" "}
                    <span className={`home-status is-${e.status}`}>
                      {engagementStatusLabel(t, e.status)}
                    </span>{" "}
                    · {t("home.recent.updated", { when: formatRelative(e.updatedAt, locale) })}
                  </span>
                </span>
                <span className="home-row__end">
                  <SeverityPips counts={openFindings.get(e.id)} />
                  <ChevronRight size={16} className="home-faint" aria-hidden />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function RunningPanel({ runs }: { runs: NativeToolRun[] }) {
  const { t } = useT();
  const toolName = useToolName();
  const now = useNow(true);
  const toast = useUi((s) => s.toast);
  const refresh = useLabRuntime((s) => s.refresh);

  /* Native cancel rejects when the run already ended or the supervisor is
     unavailable. Say so, then re-read: the stopped state itself arrives
     through native events, never from here. */
  const stop = async (run: NativeToolRun, tool: string) => {
    try {
      await getBridge().toolSupervisor.cancel(run.id);
    } catch {
      toast({ kind: "danger", messageKey: "home.stopFailed", params: { tool } });
      void refresh();
    }
  };
  return (
    <Panel
      id="home-running"
      icon={Activity}
      title={t("home.running")}
      live
      after={
        <span className="home-chip home-chip--live home-panel__end">
          <span className="home-dot" aria-hidden />
          {t("home.liveCount", { count: runs.length })}
        </span>
      }
    >
      <ul className="home-panel__b">
        {runs.map((run) => {
          const name = toolName(run);
          return (
            <li key={run.id} className="home-row">
              <span className="home-ricon home-ricon--live" aria-hidden>
                <Activity size={15} strokeWidth={1.7} />
              </span>
              <span className="home-row__main">
                <span className="home-row__title home-trunc" title={name}>
                  {name}
                </span>
                {run.target && (
                  <span className="home-mono home-faint home-trunc" title={run.target}>
                    {run.target}
                  </span>
                )}
              </span>
              <span className="home-row__end">
                <span className="home-chip home-chip--live">
                  <Loader size={12} aria-hidden />
                  {runStateLabel(t, run.state)}
                </span>
                <span className="home-mono home-sec">
                  {run.startedAt ? clock(now - run.startedAt) : "—"}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  aria-label={t("home.stopRun", { tool: name })}
                  title={t("home.stopRun", { tool: name })}
                  disabled={run.state === "cancelling"}
                  onClick={() => void stop(run, name)}
                >
                  <Square size={13} aria-hidden />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function ResumePanel({ workspaceId }: { workspaceId: string }) {
  const { t, locale } = useT();
  const workspaces = useCollection("workspaces");
  const setActiveWorkspace = useUi((s) => s.setActiveWorkspace);
  const ws = workspaces.find((w) => w.id === workspaceId)!;
  return (
    <Panel id="home-resume" icon={Folder} title={t("home.resume")}>
      <div className="home-panel__b">
        <Link
          className="home-row home-row--link"
          to={`/workspaces/${encodeURIComponent(ws.id)}`}
          onClick={() => setActiveWorkspace(ws.id)}
        >
          <span className="home-ricon" aria-hidden>
            <Folder size={15} strokeWidth={1.7} />
          </span>
          <span className="home-row__main">
            <span className="home-row__title home-trunc" title={ws.name}>
              {t("home.resumeProject", { name: ws.name })}
            </span>
            <span className="home-faint home-small">
              {t("home.lastActive", { when: formatRelative(ws.lastActivityAt, locale) })}
            </span>
          </span>
          <ChevronRight size={16} className="home-faint" aria-hidden />
        </Link>
      </div>
    </Panel>
  );
}

const OUTCOME: Partial<Record<NativeToolRun["state"], [string, LucideIcon]>> = {
  succeeded: ["home-chip--ok", Check],
  failed: ["home-chip--danger", X],
  timed_out: ["home-chip--danger", X],
  blocked: ["home-chip--danger", CircleSlash],
  cancelled: ["home-chip--warn", CircleSlash],
  orphaned: ["home-chip--warn", CircleSlash],
};

function RecentRunsPanel({ runs }: { runs: NativeToolRun[] }) {
  const { t, locale } = useT();
  const toolName = useToolName();
  return (
    // No "all runs" link: an investigation's Runs show only its own runs.
    <Panel id="home-recent" icon={List} title={t("home.recentRuns")}>
      <div className="home-tbl" role="table" aria-labelledby="home-recent">
        <div className="home-tbl__h" role="row">
          <span className="home-lbl" role="columnheader">{t("lab.runs.tool")}</span>
          <span className="home-lbl" role="columnheader">{t("lab.runs.target")}</span>
          <span className="home-lbl" role="columnheader">{t("home.outcome")}</span>
          <span className="home-lbl" role="columnheader">{t("lab.runs.duration")}</span>
          <span className="home-lbl" role="columnheader">{t("home.when")}</span>
        </div>
        {runs.map((run) => {
          const [tone, Icon] = OUTCOME[run.state] ?? ["", Check];
          return (
            <div key={run.id} className="home-tbl__r" role="row">
              <span className="home-row__title home-trunc" role="cell">
                {toolName(run)}
              </span>
              <span className="home-mono home-sec home-trunc" role="cell" title={run.target}>
                {run.target ?? "—"}
              </span>
              <span role="cell">
                <span className={`home-chip ${tone}`}>
                  <Icon size={12} aria-hidden />
                  {runStateLabel(t, run.state)}
                </span>
              </span>
              <span className="home-mono home-sec" role="cell">
                {run.startedAt && run.endedAt ? clock(run.endedAt - run.startedAt) : "—"}
              </span>
              <span className="home-faint home-small" role="cell">
                {run.endedAt ? formatRelative(run.endedAt, locale) : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** The native read failed: Home cannot say whether anything is running. */
function RunsReadFailed() {
  const { t } = useT();
  const refresh = useLabRuntime((s) => s.refresh);
  return (
    <Panel id="home-running" icon={Activity} title={t("home.running")}>
      <div className="home-notice">
        <AlertTriangle size={16} className="home-notice__ico" aria-hidden />
        <p>{t("home.runsReadFailed")}</p>
        <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
          {t("action.retry")}
        </button>
      </div>
    </Panel>
  );
}

export default function OverviewPage() {
  const { t } = useT();
  const engagements = useCollection("engagements");
  const findings = useCollection("findings");
  const targets = useCollection("targets");
  const scopes = useCollection("authorizationScopes");
  const workspaces = useCollection("workspaces");
  const nativeRuns = useLabRuntime((s) => s.runs);
  const outsideLive = useLabRuntime((s) => s.outsideLive);
  const runtimeAvailable = useLabRuntime((s) => s.available);
  const runtimeReady = useLabRuntime((s) => s.ready);
  const readFailed = useLabRuntime((s) => s.readFailed);
  const consented = usePreferences().privateToolsEnabled;

  /* The browser build cannot run tools, so there "none" is the truth. In the
     desktop app Home knows only after a good read with Private Lab consent:
     withdrawing consent gates listing but stops nothing (lib.rs keeps
     emergency stop ungated for exactly that), so it proves no absence. */
  const native = runtimeAvailable && consented;
  const runsFailed = native && readFailed;
  const runsKnown = !runtimeAvailable || (native && runtimeReady && !readFailed);
  const runs = useMemo(() => (native ? nativeRuns : []), [native, nativeRuns]);
  const running = runsFailed ? [] : runs.filter((r) => ACTIVE_RUN.has(r.state));
  const recent = useMemo(
    () =>
      runs
        .filter((r) => FINISHED_RUN.has(r.state))
        .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
        .slice(0, RECENT_RUNS),
    [runs],
  );
  const recentInvestigations = useMemo(
    () =>
      engagements
        .filter((e) => e.status !== "archived")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT_INVESTIGATIONS),
    [engagements],
  );
  const lastProject = useMemo(
    () =>
      workspaces
        .filter((w) => w.status !== "archived")
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0],
    [workspaces],
  );
  const openFindings = useMemo(() => openFindingsByEngagement(findings), [findings]);
  const scopeStatus = useMemo(
    () => scopeStatusByEngagement(engagements, scopes, targets),
    [engagements, scopes, targets],
  );
  const attention = useMemo(
    () =>
      attentionItems({
        engagements: [...engagements].sort((a, b) => b.updatedAt - a.updatedAt),
        findings,
        scopeStatus,
        // A failed run counts only when runs are known.
        runs: runsKnown ? runs : [],
      }),
    [engagements, findings, scopeStatus, runs, runsKnown],
  );

  const unarchived = engagements.filter((e) => e.status !== "archived");
  const openInvestigations = unarchived.filter((e) => e.status !== "completed").length;
  let openTotal = 0;
  let criticalTotal = 0;
  for (const e of unarchived) {
    const counts = openFindings.get(e.id);
    if (!counts) continue;
    openTotal += counts.critical + counts.high + counts.medium + counts.low + counts.info;
    criticalTotal += counts.critical;
  }

  const first = engagements.length === 0 && runs.length === 0;
  const worst = attention[0]?.tone;
  const tone: Tone = first
    ? "first"
    : worst === "danger"
      ? "danger"
      : attention.length > 0
        ? "warning"
        : "clear";
  const headline = first
    ? t("home.brief.first")
    : attention.length === 0
      ? t("home.brief.clear")
      : attention.length === 1
        ? t("home.brief.one")
        : t("home.brief.many", { count: attention.length });
  const hint = first
    ? t("home.brief.firstHint")
    : attention.length === 0
      ? t(runsKnown && native ? "home.brief.clearHint" : "home.brief.clearHintNoRuns")
      : undefined;
  const stats = first
    ? []
    : [
        { label: t("home.stat.open"), value: openInvestigations },
        { label: t("home.stat.findings"), value: openTotal },
        {
          label: t("home.stat.critical"),
          value: criticalTotal,
          tone: criticalTotal > 0 ? ("danger" as const) : undefined,
        },
        // Outside-tool runs on an investigation's files count too; they are
        // not in `running`, which holds no path-carrying rows for them.
        ...(native && runsKnown && running.length + outsideLive.length > 0
          ? [
              {
                label: t("home.stat.running"),
                value: running.length + outsideLive.length,
                tone: "live" as const,
              },
            ]
          : []),
      ];

  const runningSlot = runsFailed ? (
    <RunsReadFailed />
  ) : running.length > 0 ? (
    <RunningPanel runs={running} />
  ) : null;
  const board = [
    runningSlot,
    attention.length > 0 && <AttentionPanel key="attn" items={attention} />,
    recentInvestigations.length > 0 && (
      <RecentInvestigationsPanel
        key="recent-inv"
        engagements={recentInvestigations}
        openFindings={openFindings}
      />
    ),
    recent.length > 0 && <RecentRunsPanel key="recent-runs" runs={recent} />,
  ].filter(Boolean);
  const solo = board.length === 0;

  /* The launch rail on the left, the board on the right; reading order and
     visual order agree, so "what to investigate" is first for every reader.
     With nothing on the board, the rail takes the whole width. */
  return (
    <div className="page home" data-scroll-owner="page">
      <h1 className="sr-only">{t("nav.overview")}</h1>
      <div className="home-wrap">
        <Brief
          tone={tone}
          headline={headline}
          hint={hint}
          stats={stats}
          idleKnown={runsKnown && running.length === 0 && outsideLive.length === 0}
        />
        <div className={solo ? "home-board is-solo" : "home-board"}>
          <div className="home-rail">
            <NewInvestigationPanel solo={solo} />
            {lastProject && <ResumePanel workspaceId={lastProject.id} />}
          </div>
          {!solo && <div className="home-main">{board}</div>}
        </div>
      </div>
    </div>
  );
}
