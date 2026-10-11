import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Pause, Play, Square, AlertCircle, Timer } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useCollection } from "@/lib/db/database";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  pauseSession,
  resumeSession,
  logInterruption,
  returnFromInterruption,
  addTask,
} from "@/services/appService";
import { SessionReviewDialog } from "./SessionReviewDialog";
import { formatDuration, formatTime, formatRelative } from "@/lib/time";
import { useUi } from "@/state/ui";

/** Focus mode: calm, stable, always-visible End session. */
export default function FocusPage() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const { toast } = useUi();
  const sessions = useCollection("sessions");
  const workspaces = useCollection("workspaces");
  const events = useCollection("events");
  const session = sessions.find(
    (s) => s.status === "active" || s.status === "paused",
  );
  const ws = workspaces.find((w) => w.id === session?.workspaceId);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [interruptReason, setInterruptReason] = useState("");
  const [showInterrupt, setShowInterrupt] = useState(false);
  const [captureText, setCaptureText] = useState("");

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Arriving without a session used to replace this address with Projects
  // and say nothing about why; the page now says what is missing instead.
  if (!session) {
    return (
      <div className="page">
        <div className="page-body">
          <EmptyState
            icon={Timer}
            title={t("session.noneRunning")}
            hint={t("session.noneRunningHint")}
            action={
              <Link to="/workspaces" className="btn btn--primary">
                {t("session.goToProjects")}
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const paused = session.status === "paused";
  const elapsed =
    Date.now() -
    (session.startedAt ?? Date.now()) -
    session.pausedTotalMs -
    (paused && session.pausedAt ? Date.now() - session.pausedAt : 0);
  const remaining = session.plannedMinutes
    ? session.plannedMinutes * 60_000 - elapsed
    : null;

  const recentEvents = events
    .filter(
      (e) =>
        e.workspaceId === session.workspaceId &&
        e.at >= (session.startedAt ?? 0),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);

  const openInterruption = session.interruptions.find((i) => !i.returnedAt);

  const quickCapture = () => {
    if (!captureText.trim()) return;
    addTask({
      title: captureText.trim(),
      workspaceId: session.workspaceId,
    });
    setCaptureText("");
    toast({ kind: "success", messageKey: "capture.saved" });
  };

  return (
    <div className="page">
      <div className="page-body scroll-y">
        <div className="focus-screen">
          <div>
            <div className="breadcrumb">
              {/* A session outlives a deleted project; its controls must not. */}
              {ws && (
                <>
                  <span>{ws.name}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{t("session.focusMode")}</span>
            </div>
            <h1 style={{ fontSize: "var(--fs-24)" }}>{session.title}</h1>
            {session.intendedOutcome && (
              <p className="muted" style={{ marginTop: 4 }}>
                {session.intendedOutcome}
              </p>
            )}
          </div>

          <div className="flex" style={{ gap: "var(--sp-6)", flexWrap: "wrap" }}>
            <div>
              <div className="section-label">{t("session.elapsed")}</div>
              <div className="focus-timer" aria-live="off">
                {formatDuration(Math.max(0, elapsed))}
              </div>
            </div>
            {remaining !== null && (
              <div>
                <div className="section-label">{t("session.remaining")}</div>
                <div
                  className="focus-timer"
                  style={{ color: remaining < 0 ? "var(--warning)" : undefined }}
                >
                  {remaining < 0 ? "−" : ""}
                  {formatDuration(Math.abs(remaining))}
                </div>
              </div>
            )}
            <div className="flex" style={{ marginLeft: "auto", alignSelf: "center" }}>
              {paused ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => resumeSession(session.id)}
                >
                  <Play size={14} aria-hidden /> {t("session.resume")}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => pauseSession(session.id)}
                >
                  <Pause size={14} aria-hidden /> {t("session.pause")}
                </button>
              )}
              <button
                type="button"
                className="btn btn--danger-outline"
                onClick={() => setReviewOpen(true)}
              >
                <Square size={13} aria-hidden /> {t("session.end")}
              </button>
            </div>
          </div>

          {/* A task created here remains scoped to the active project session. */}
          <section className="panel">
            <div className="panel-body">
              <label className="field-label" htmlFor="focus-capture">
                {t("capture.label")}
              </label>
              <div className="flex">
                <input
                  id="focus-capture"
                  className="input"
                  value={captureText}
                  onChange={(e) => setCaptureText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && quickCapture()}
                  placeholder={t("capture.placeholder")}
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={quickCapture}
                  disabled={!captureText.trim()}
                >
                  {t("action.add")}
                </button>
              </div>
              <p className="faint" style={{ fontSize: "var(--fs-12)", marginTop: "var(--sp-2)" }}>
                {t("session.quickTask")}
              </p>
            </div>
          </section>

          <div className="two-col">
            {/* Interruptions */}
            {session.distractionTracking && (
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">
                    <AlertCircle size={14} aria-hidden />
                    {t("session.interruptions")} ({session.interruptions.length})
                  </span>
                  {openInterruption ? (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => returnFromInterruption(session.id)}
                    >
                      {t("session.return")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setShowInterrupt((v) => !v)}
                    >
                      {t("session.addInterruption")}
                    </button>
                  )}
                </div>
                <div className="panel-body">
                  {showInterrupt && !openInterruption && (
                    <div
                      className="flex"
                      style={{ marginBottom: "var(--sp-2)", alignItems: "flex-end" }}
                    >
                      <div className="field" style={{ flex: 1 }}>
                        <label htmlFor="focus-interruption">
                          {t("session.interruptionReason")}
                        </label>
                        <input
                          id="focus-interruption"
                          className="input"
                          value={interruptReason}
                          onChange={(e) => setInterruptReason(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && interruptReason.trim()) {
                              logInterruption(session.id, interruptReason.trim());
                              setInterruptReason("");
                              setShowInterrupt(false);
                            }
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={!interruptReason.trim()}
                        onClick={() => {
                          logInterruption(session.id, interruptReason.trim());
                          setInterruptReason("");
                          setShowInterrupt(false);
                        }}
                      >
                        {t("action.add")}
                      </button>
                    </div>
                  )}
                  {session.interruptions.length === 0 ? (
                    <p className="muted" style={{ fontSize: "var(--fs-12)" }}>
                      —
                    </p>
                  ) : (
                    <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
                      {session.interruptions.map((i) => (
                        <li key={i.id} className="flex" style={{ fontSize: "var(--fs-13)" }}>
                          <span style={{ flex: 1 }}>{i.reason}</span>
                          <span className="faint">
                            {i.returnedAt
                              ? `${i.minutes} ${t("today.minutes", { count: "" }).trim()}`
                              : formatTime(i.at, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )}

            {/* Recent activity */}
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">{t("session.recentActivity")}</span>
              </div>
              <div className="panel-body">
                {recentEvents.length === 0 ? (
                  <p className="muted" style={{ fontSize: "var(--fs-12)" }}>
                    —
                  </p>
                ) : (
                  <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
                    {recentEvents.map((e) => (
                      <li key={e.id} className="flex" style={{ fontSize: "var(--fs-13)" }}>
                        <span className="truncate" style={{ flex: 1 }}>
                          {e.label}
                        </span>
                        <span className="faint" style={{ flex: "none" }}>
                          {formatRelative(e.at, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
      <SessionReviewDialog
        session={session}
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onEnded={() => navigate("/overview")}
      />
    </div>
  );
}
