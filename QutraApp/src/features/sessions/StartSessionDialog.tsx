import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/lib/i18n";
import { useCollection } from "@/lib/db/database";
import { startSession } from "@/services/appService";
import { useUi } from "@/state/ui";
import type { Session } from "@/domain/types";

interface StartSessionDialogProps {
  open: boolean;
  onClose: () => void;
  defaultWorkspaceId?: string;
}

export function StartSessionDialog({
  open,
  onClose,
  defaultWorkspaceId,
}: StartSessionDialogProps) {
  const { t } = useT();
  const navigate = useNavigate();
  const { setActiveWorkspace } = useUi();
  const workspaces = useCollection("workspaces");
  const tasks = useCollection("tasks");
  const active = workspaces.filter((w) => w.status !== "archived");

  const [workspaceId, setWorkspaceId] = useState("");
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [duration, setDuration] = useState<string>("");
  const [linkedTasks, setLinkedTasks] = useState<string[]>([]);
  const [distraction, setDistraction] = useState(true);
  const [autoSnapshot, setAutoSnapshot] =
    useState<Session["autoSnapshot"]>("on_end");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setWorkspaceId(defaultWorkspaceId ?? active[0]?.id ?? "");
      setTitle("");
      setOutcome("");
      setDuration("");
      setLinkedTasks([]);
      setDistraction(true);
      setAutoSnapshot("on_end");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultWorkspaceId]);

  const wsTasks = tasks.filter(
    (task) =>
      task.workspaceId === workspaceId &&
      task.status !== "done" &&
      task.status !== "archived",
  );

  const start = () => {
    if (!workspaceId || !title.trim()) return;
    startSession({
      workspaceId,
      title: title.trim(),
      intendedOutcome: outcome.trim(),
      plannedMinutes: duration ? parseInt(duration, 10) : undefined,
      linkedTaskIds: linkedTasks,
      distractionTracking: distraction,
      autoSnapshot,
    });
    setActiveWorkspace(workspaceId);
    onClose();
    navigate("/sessions/focus");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("session.new")}
      initialFocusRef={titleRef}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t("action.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!workspaceId || !title.trim()}
            onClick={start}
          >
            {t("session.start")}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: "var(--sp-3)" }}>
        <div className="field">
          <label htmlFor="sess-ws">{t("common.workspace")}</label>
          <select
            id="sess-ws"
            className="select"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            {active.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sess-title">{t("session.sessionTitle")}</label>
          <input
            id="sess-title"
            ref={titleRef}
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") start();
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="sess-outcome">{t("session.outcome")}</label>
          <textarea
            id="sess-outcome"
            className="textarea"
            rows={2}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder={t("session.outcomePlaceholder")}
          />
        </div>
        <div className="two-col" style={{ gap: "var(--sp-3)" }}>
          <div className="field">
            <label htmlFor="sess-duration">
              {t("session.plannedDuration")}{" "}
              <span className="faint">({t("common.optional")})</span>
            </label>
            <select
              id="sess-duration"
              className="select"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option value="">{t("common.none")}</option>
              <option value="25">25 {t("today.minutes", { count: "" }).trim()}</option>
              <option value="50">50 {t("today.minutes", { count: "" }).trim()}</option>
              <option value="90">90 {t("today.minutes", { count: "" }).trim()}</option>
              <option value="120">120 {t("today.minutes", { count: "" }).trim()}</option>
              <option value="180">180 {t("today.minutes", { count: "" }).trim()}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="sess-snap">{t("session.autoSnapshot")}</label>
            <select
              id="sess-snap"
              className="select"
              value={autoSnapshot}
              onChange={(e) =>
                setAutoSnapshot(e.target.value as Session["autoSnapshot"])
              }
            >
              <option value="off">{t("session.autoSnapshot.off")}</option>
              <option value="on_end">{t("session.autoSnapshot.on_end")}</option>
              <option value="every_30m">
                {t("session.autoSnapshot.every_30m")}
              </option>
            </select>
          </div>
        </div>
        {wsTasks.length > 0 && (
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="section-label">{t("session.linkedTasks")}</legend>
            <div className="stack" style={{ gap: 4, maxHeight: 140, overflowY: "auto" }}>
              {wsTasks.slice(0, 8).map((task) => (
                <label key={task.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={linkedTasks.includes(task.id)}
                    onChange={(e) =>
                      setLinkedTasks((prev) =>
                        e.target.checked
                          ? [...prev, task.id]
                          : prev.filter((id) => id !== task.id),
                      )
                    }
                  />
                  <span className="truncate">{task.title}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={distraction}
            onChange={(e) => setDistraction(e.target.checked)}
          />
          {t("session.distractionTracking")}
        </label>
      </div>
    </Dialog>
  );
}
