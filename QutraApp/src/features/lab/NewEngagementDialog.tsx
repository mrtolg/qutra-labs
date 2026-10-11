import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderOpen, FolderPlus, RotateCcw, Shield } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { getDb } from "@/lib/db/database";
import {
  engagementFolders,
  folderNameFor,
  type FolderInfo,
  type PickedParent,
} from "@/lib/engagementFolders";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { now } from "@/lib/time";
import { EngagementKind } from "@/domain/lab";
import { createEngagement } from "@/services/appService";

/**
 * Starting an investigation. It used to be one click that
 * made an engagement called "New engagement", so the list filled with
 * identical names and nothing said what had happened. Now it asks for a name
 * and what is being investigated (a Home tile chooses it first, spec
 * 2026-10-07 §5.2), shows where the app will keep the files, and makes
 * nothing until the user says Create.
 */
export function NewEngagementDialog({
  open,
  kind: initialKind,
  onClose,
  onCreated,
}: {
  open: boolean;
  kind?: EngagementKind;
  onClose: () => void;
  onCreated: (engagementId: string, title: string, folder: FolderInfo | null) => void;
}) {
  const { t } = useT();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [kind, setKind] = useState<EngagementKind | "">("");
  const [root, setRoot] = useState<string | null>(null);
  const [parent, setParent] = useState<PickedParent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const native = engagementFolders.available();

  useEffect(() => {
    if (!open) return;
    setName("");
    setNotes("");
    setKind(initialKind ?? "");
    setParent(null);
    setError("");
    if (!native) return;
    let cancelled = false;
    engagementFolders.root().then(
      (path) => !cancelled && setRoot(path),
      () => !cancelled && setRoot(null),
    );
    return () => {
      cancelled = true;
    };
  }, [open, native, initialKind]);

  const title = name.trim();
  const base = parent?.path ?? root;
  const preview = base ? `${base}\\${folderNameFor(title || t("lab.newEngagement"))}` : null;

  const pick = async () => {
    try {
      const picked = await engagementFolders.pickParent(t("lab.create.pickTitle"));
      if (picked) setParent(picked);
    } catch {
      setError(t("lab.create.pickFailed"));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title) {
      setError(t("lab.create.nameRequired"));
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    const id = createEngagement(title, kind || undefined);
    const db = getDb();
    if (notes.trim()) {
      const record = db.collection("engagements").get(id);
      if (record) db.collection("engagements").put({ ...record, notes: notes.trim() });
    }
    let folder: FolderInfo | null = null;
    if (native) {
      try {
        folder = await engagementFolders.create(id, title, parent?.token ?? null);
        const record = db.collection("engagements").get(id);
        if (record) {
          db.collection("engagements").put({ ...record, folderPath: folder.path, updatedAt: now() });
        }
      } catch (caught) {
        // The engagement stands; its header offers to make the folder again.
        console.error("engagement folder not created", caught);
      }
    }
    setBusy(false);
    onCreated(id, title, folder);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      preventClose={busy}
      initialFocusRef={nameRef}
      title={
        <span className="lab-create__title">
          <Shield size={16} aria-hidden /> {t("lab.create.title")}
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </button>
          <button
            type="submit"
            form="lab-create-form"
            className="btn btn--primary"
            disabled={busy}
            data-testid="lab-create-submit"
          >
            <FolderPlus size={15} aria-hidden /> {t("lab.create.submit")}
          </button>
        </>
      }
    >
      <form id="lab-create-form" className="lab-create" onSubmit={(e) => void submit(e)} noValidate>
        <p className="lab-create__lead">{t("lab.create.lead")}</p>
        <label className="field">
          <span>{t("lab.create.name")}</span>
          <input
            ref={nameRef}
            className="input"
            value={name}
            maxLength={120}
            placeholder={t("lab.create.namePlaceholder")}
            aria-invalid={error === t("lab.create.nameRequired") || undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError("");
            }}
          />
        </label>
        <label className="field">
          <span>{t("lab.create.notes")}</span>
          <textarea
            className="textarea lab-create__notes"
            value={notes}
            rows={2}
            maxLength={500}
            placeholder={t("lab.create.notesPlaceholder")}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("lab.create.kind")}</span>
          <select
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as EngagementKind | "")}
          >
            <option value="">{t("lab.kind.none")}</option>
            {EngagementKind.options.map((option) => (
              <option key={option} value={option}>
                {t(`lab.kind.${option}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <section className="lab-create__folder" aria-labelledby="lab-create-folder">
          <h3 id="lab-create-folder" className="lab-create__h">
            <FolderOpen size={14} aria-hidden /> {t("lab.create.folder")}
          </h3>
          {native ? (
            <>
              <p className="lab-create__hint">{t("lab.create.folderHint")}</p>
              <code className="lab-create__path" data-testid="lab-create-path">
                {preview ?? t("lab.create.folderUnknown")}
              </code>
              <div className="lab-create__folder-actions">
                <button type="button" className="btn btn--sm" onClick={() => void pick()}>
                  <FolderOpen size={14} aria-hidden /> {t("lab.create.pick")}
                </button>
                {parent && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setParent(null)}>
                    <RotateCcw size={13} aria-hidden /> {t("lab.create.useDefault")}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="lab-create__hint">{t("lab.create.folderDesktopOnly")}</p>
          )}
        </section>
        {error && (
          <p className="callout callout--warning lab-create__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
