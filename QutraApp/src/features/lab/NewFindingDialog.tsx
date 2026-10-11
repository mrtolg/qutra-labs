import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Bug, Plus } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import type { Severity } from "@/domain/findings";
import type { Target } from "@/domain/lab";
import { manualFinding } from "@/domain/lab/findingsOps";
import { getDb } from "@/lib/db/database";
import { createId } from "@/lib/id";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { now } from "@/lib/time";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/**
 * Writing a finding down by hand: what was seen, how bad it is and where.
 * Evidence, a fix and the status are added on the finding itself, which
 * opens as soon as it is saved.
 */
export function NewFindingDialog({
  open,
  onClose,
  engagementId,
  targets,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  engagementId: string;
  targets: Target[];
  onCreated: (findingId: string, title: string) => void;
}) {
  const { t } = useT();
  const titleRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [target, setTarget] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setSeverity("medium");
    setTarget("");
    setDescription("");
    setError("");
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError(t("lab.newFinding.titleRequired"));
      titleRef.current?.focus();
      return;
    }
    const finding = manualFinding(
      { title, severity, target, description },
      { id: createId("fnd"), engagementId, now: now() },
    );
    getDb().collection("findings").put(finding);
    onCreated(finding.id, finding.title);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      initialFocusRef={titleRef}
      title={
        <span className="lab-create__title">
          <Bug size={16} aria-hidden /> {t("lab.newFinding.title")}
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t("action.cancel")}
          </button>
          <button type="submit" form="lab-finding-form" className="btn btn--primary">
            <Plus size={15} aria-hidden /> {t("lab.newFinding.submit")}
          </button>
        </>
      }
    >
      <form id="lab-finding-form" className="lab-create" onSubmit={submit} noValidate>
        <p className="lab-create__lead">{t("lab.newFinding.lead")}</p>
        <label className="field">
          <span>{t("lab.newFinding.name")}</span>
          <input
            ref={titleRef}
            className="input"
            value={title}
            maxLength={200}
            placeholder={t("lab.newFinding.namePlaceholder")}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              if (error) setError("");
            }}
          />
        </label>
        <div className="lab-finding-row">
          <label className="field">
            <span>{t("lab.insp.severity")}</span>
            <select
              className="select"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as Severity)}
            >
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`lab.severity.${value}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("lab.newFinding.target")}</span>
            <input
              className="input input--mono"
              value={target}
              maxLength={300}
              spellCheck={false}
              list={targets.length > 0 ? listId : undefined}
              placeholder={t("lab.newFinding.targetPlaceholder")}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          {targets.length > 0 && (
            <datalist id={listId}>
              {targets.map((item) => (
                <option key={item.id} value={item.normalized || item.raw} />
              ))}
            </datalist>
          )}
        </div>
        <label className="field">
          <span>{t("lab.newFinding.description")}</span>
          <textarea
            className="textarea"
            rows={4}
            maxLength={4000}
            value={description}
            placeholder={t("lab.newFinding.descriptionPlaceholder")}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <p className="callout callout--warning lab-create__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
