import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Segmented } from "@/components/ui/Segmented";
import { useT } from "@/lib/i18n";
import { getDb } from "@/lib/db/database";
import { endSession } from "@/services/appService";
import { SnapshotCaptureDialog } from "@/features/snapshots/SnapshotCaptureDialog";
import { useUi } from "@/state/ui";
import type { Session } from "@/domain/types";

interface SessionReviewDialogProps {
  session: Session;
  open: boolean;
  onClose: () => void;
  onEnded?: () => void;
}

/** End-of-session review; prefilled from evidence, always editable. */
export function SessionReviewDialog({
  session,
  open,
  onClose,
  onEnded,
}: SessionReviewDialogProps) {
  const { t } = useT();
  const { toast } = useUi();
  const [achieved, setAchieved] = useState<"yes" | "partial" | "no">("partial");
  const [completedWork, setCompletedWork] = useState("");
  const [unresolved, setUnresolved] = useState("");
  const [learned, setLearned] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [withSnapshot, setWithSnapshot] = useState(true);
  const [captureOpen, setCaptureOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Prefill from explicit local evidence: linked tasks completed during
    // the session and linked project tasks. The user always edits before saving.
    const db = getDb();
    const tasks = db.collection("tasks").getAll();
    const doneLinked = tasks.filter(
      (task) =>
        session.linkedTaskIds.includes(task.id) &&
        task.status === "done" &&
        (task.completedAt ?? 0) >= (session.startedAt ?? 0),
    );
    const openLinked = tasks.filter(
      (task) =>
        session.linkedTaskIds.includes(task.id) && task.status !== "done",
    );
    setCompletedWork(doneLinked.map((task) => task.title).join("; "));
    setUnresolved(openLinked.map((task) => task.title).join("; "));
    setLearned("");
    setNextAction(openLinked[0]?.title ?? "");
    setAchieved(
      doneLinked.length > 0 && openLinked.length === 0
        ? "yes"
        : doneLinked.length > 0
          ? "partial"
          : "partial",
    );
    setWithSnapshot(session.autoSnapshot !== "off");
  }, [open, session]);

  const finish = (snapshotId?: string) => {
    endSession(session.id, {
      outcomeAchieved: achieved,
      completedWork: completedWork.trim(),
      unresolved: unresolved.trim(),
      learned: learned.trim(),
      nextAction: nextAction.trim(),
      snapshotId,
    });
    toast({ kind: "success", messageKey: "toast.saved" });
    onClose();
    onEnded?.();
  };

  const save = () => {
    if (withSnapshot) {
      setCaptureOpen(true);
    } else {
      finish();
    }
  };

  return (
    <>
      <Dialog
        open={open && !captureOpen}
        onClose={onClose}
        title={t("session.review.title")}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              {t("action.cancel")}
            </button>
            <button type="button" className="btn btn--primary" onClick={save}>
              {t("session.review.save")}
            </button>
          </>
        }
      >
        <div className="stack" style={{ gap: "var(--sp-3)" }}>
          <p className="faint" style={{ fontSize: "var(--fs-12)" }}>
            {t("session.prefillHint")}
          </p>
          <div className="field">
            <label>{t("session.review.achieved")}</label>
            <Segmented
              ariaLabel={t("session.review.achieved")}
              value={achieved}
              onChange={setAchieved}
              options={[
                { value: "yes", label: t("session.review.yes") },
                { value: "partial", label: t("session.review.partial") },
                { value: "no", label: t("session.review.no") },
              ]}
            />
          </div>
          <div className="field">
            <label htmlFor="rev-completed">
              {t("session.review.completedWork")}
            </label>
            <textarea
              id="rev-completed"
              className="textarea"
              rows={2}
              value={completedWork}
              onChange={(e) => setCompletedWork(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="rev-unresolved">
              {t("session.review.unresolved")}
            </label>
            <textarea
              id="rev-unresolved"
              className="textarea"
              rows={2}
              value={unresolved}
              onChange={(e) => setUnresolved(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="rev-learned">{t("session.review.learned")}</label>
            <textarea
              id="rev-learned"
              className="textarea"
              rows={2}
              value={learned}
              onChange={(e) => setLearned(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="rev-next">{t("session.review.nextAction")}</label>
            <input
              id="rev-next"
              className="input"
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
            />
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={withSnapshot}
              onChange={(e) => setWithSnapshot(e.target.checked)}
            />
            {t("session.review.snapshot")}
          </label>
        </div>
      </Dialog>
      <SnapshotCaptureDialog
        workspaceId={session.workspaceId}
        sessionId={session.id}
        open={captureOpen}
        onClose={() => {
          setCaptureOpen(false);
          finish();
        }}
        onCaptured={(snapshotId) => {
          setCaptureOpen(false);
          finish(snapshotId);
        }}
        defaultName={`${session.title} — handoff`}
        defaultHandoff={nextAction ? `${t("session.review.nextAction")}: ${nextAction}` : ""}
      />
    </>
  );
}
