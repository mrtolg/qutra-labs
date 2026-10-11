import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  Layers,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import type { Engagement } from "@/domain/lab";
import { archivePatch, restorePatch } from "@/domain/lab/archive";
import { getBridge } from "@/lib/bridge";
import { getDb, useCollection } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { now } from "@/lib/time";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { engagementStatusLabel } from "./labels";
import { useEngagementFolder } from "./useEngagementFolder";

/* The engagement's name, the switch between engagements and its folder, in
   the Lab header. The name used to be an unmarked input
   that looked like a heading and fell back to "New engagement" when emptied;
   the switch was a plain select of identical names. */

/** The engagement's name as the page heading, renamed in place. */
export function EngagementTitle({ engagement }: { engagement: Engagement }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(engagement.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(engagement.title);
    setEditing(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    if (title !== engagement.title) {
      getDb()
        .collection("engagements")
        .put({ ...engagement, title, updatedAt: now() });
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="lab-head__name">
        <h1 className="lab-head__h1" title={engagement.title}>
          {engagement.title}
        </h1>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm lab-head__rename"
          onClick={start}
          aria-label={t("lab.rename.action", { name: engagement.title })}
          title={t("lab.rename.label")}
        >
          <Pencil size={14} aria-hidden />
        </button>
        <span className={`lab-status-chip status-${engagement.status}`}>
          {engagementStatusLabel(t, engagement.status)}
        </span>
      </div>
    );
  }

  return (
    <form className="lab-head__name" onSubmit={save}>
      <label className="sr-only" htmlFor="lab-eng-title">
        {t("lab.engagementName")}
      </label>
      <input
        ref={inputRef}
        id="lab-eng-title"
        className="lab-head__input"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim()}>
        <Check size={14} aria-hidden /> {t("action.save")}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
        {t("action.cancel")}
      </button>
    </form>
  );
}

/** All engagements, newest work first, told apart by when they were made.
    `defaultOpen` shows the list on arrival (Home's "All investigations"). */
export function EngagementSwitcher({
  engagements,
  current,
  onSelect,
  onCreate,
  defaultOpen = false,
}: {
  engagements: readonly Engagement[];
  current: Engagement;
  onSelect: (engagementId: string) => void;
  onCreate: () => void;
  defaultOpen?: boolean;
}) {
  const { t, locale } = useT();
  const findings = useCollection("findings");
  const targets = useCollection("targets");
  const evidence = useCollection("evidence");
  const scopes = useCollection("authorizationScopes");
  const runs = useLabRuntime((s) => s.runs);
  const toast = useUi((s) => s.toast);
  const [open, setOpen] = useState(defaultOpen);
  // Arriving again with the list asked for (?switch=1) opens it again; the
  // Lab is not re-mounted when only its search changes.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const [query, setQuery] = useState("");
  const [archivedView, setArchivedView] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const archivedCount = engagements.filter((e) => e.status === "archived").length;
  const activeCount = engagements.length - archivedCount;
  const findingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of findings) {
      if (f.engagementId) counts.set(f.engagementId, (counts.get(f.engagementId) ?? 0) + 1);
    }
    return counts;
  }, [findings]);
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = engagements
    .filter((e) => (archivedView ? e.status === "archived" : e.status !== "archived"))
    .filter((e) => !needle || e.title.toLocaleLowerCase(locale).includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  /* Engagements nobody has started: no targets, findings, evidence or runs,
     an untouched scope and no note. Archiving them clears the list in one
     go; archive is reversible and the toast offers Undo. The open one is
     never among them. */
  const empty = engagements.filter((e) => {
    if (e.id === current.id || e.status === "archived" || e.notes.trim()) return false;
    const scope = scopes.find((sc) => sc.id === e.scopeId);
    const scopeTouched =
      !!scope &&
      (scope.testerAck || scope.allowedTargets.length > 0 || scope.excludedTargets.length > 0);
    return (
      !scopeTouched &&
      !targets.some((tg) => tg.engagementId === e.id) &&
      !findingCounts.has(e.id) &&
      !evidence.some((ev) => ev.engagementId === e.id) &&
      !runs.some((r) => r.engagementId === e.id)
    );
  });
  const archiveEmpty = () => {
    const db = getDb();
    const before = empty.map((e) => ({
      id: e.id,
      status: e.status,
      statusBeforeArchive: e.statusBeforeArchive,
      updatedAt: e.updatedAt,
    }));
    const at = now();
    for (const e of empty) {
      db.collection("engagements").patch(e.id, archivePatch(e, at));
    }
    toast({
      kind: "success",
      messageKey: "lab.switch.archivedEmpty",
      params: { count: before.length },
      actionKey: "action.undo",
      // Undo puts back only what archiving changed. The toast stays until
      // dismissed, and a whole old copy would also put back anything changed
      // since, such as a cloud allowance the user revoked.
      onAction: () => {
        for (const { id, ...was } of before) {
          db.collection("engagements").patch(id, was);
        }
      },
    });
  };

  const setArchived = (engagement: Engagement, archived: boolean) => {
    getDb()
      .collection("engagements")
      .patch(engagement.id, archived ? archivePatch(engagement, now()) : restorePatch(engagement, now()));
    if (archived && engagement.id === current.id) {
      const next = engagements
        .filter((e) => e.id !== engagement.id && e.status !== "archived")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) onSelect(next.id);
    }
  };

  return (
    <div className="lab-switch" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="lab-switch__btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Layers size={14} aria-hidden />
        {t("lab.switch.button", { count: activeCount })}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="lab-switch__panel" role="dialog" aria-label={t("lab.switchEngagement")}>
          {engagements.length > 5 && (
            <div className="lab-switch__search">
              <Search size={14} aria-hidden />
              <input
                type="search"
                className="input"
                value={query}
                autoFocus
                aria-label={t("lab.switch.search")}
                placeholder={t("lab.switch.search")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <ul className="lab-switch__list">
            {shown.length === 0 && (
              <li className="lab-switch__empty">
                {archivedView ? t("lab.switch.noArchived") : t("lab.switch.noMatch")}
              </li>
            )}
            {shown.map((e) => {
              const isCurrent = e.id === current.id;
              const count = findingCounts.get(e.id) ?? 0;
              return (
                <li key={e.id} className={isCurrent ? "lab-switch__item is-current" : "lab-switch__item"}>
                  <button
                    type="button"
                    className="lab-switch__row"
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                      if (!isCurrent) onSelect(e.id);
                    }}
                  >
                    <span className="lab-switch__check" aria-hidden>
                      {isCurrent && <Check size={14} />}
                    </span>
                    <span className="lab-switch__text">
                      <span className="lab-switch__name">{e.title}</span>
                      <span className="lab-switch__meta">
                        {t("lab.switch.created", {
                          date: new Date(e.createdAt).toLocaleString(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        })}
                        {" · "}
                        {engagementStatusLabel(t, e.status)}
                        {count > 0 && ` · ${t("lab.switch.findings", { count })}`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm lab-switch__archive"
                    aria-label={t(archivedView ? "lab.switch.restore" : "lab.switch.archive", {
                      name: e.title,
                    })}
                    title={t(archivedView ? "lab.switch.restoreShort" : "lab.switch.archiveShort")}
                    onClick={() => setArchived(e, !archivedView)}
                  >
                    {archivedView ? (
                      <ArchiveRestore size={14} aria-hidden />
                    ) : (
                      <Archive size={14} aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="lab-switch__foot">
            {!archivedView && empty.length >= 2 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={archiveEmpty}>
                <Archive size={13} aria-hidden />
                {t("lab.switch.archiveEmpty", { count: empty.length })}
              </button>
            )}
            {(archivedCount > 0 || archivedView) && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setArchivedView((v) => !v)}
              >
                {archivedView
                  ? t("lab.switch.showActive")
                  : t("lab.switch.showArchived", { count: archivedCount })}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary btn--sm lab-switch__new"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              <Plus size={14} aria-hidden /> {t("lab.newEngagement")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "…\Qutra Labs\Recon" for a long path; the full path is in the tooltip. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : path;
}

/** Where the app keeps this engagement's files, with a way to open it. */
export function EngagementFolder({ engagement }: { engagement: Engagement }) {
  const { t } = useT();
  const { native, info, busy, create } = useEngagementFolder(engagement);

  if (!native || info === undefined) return null;

  if (info && info.exists) {
    return (
      <span className="lab-folder" data-testid="lab-folder">
        <FolderOpen size={13} aria-hidden />
        <code className="lab-folder__path" title={info.path}>
          {shortPath(info.path)}
        </code>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void getBridge().openPath(info.path)}
        >
          {t("lab.folder.open")}
        </button>
      </span>
    );
  }
  return (
    <span className="lab-folder is-none" data-testid="lab-folder">
      <FolderOpen size={13} aria-hidden />
      {info ? t("lab.folder.missing") : t("lab.folder.none")}
      <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void create()}>
        <FolderPlus size={13} aria-hidden /> {t("lab.folder.create")}
      </button>
    </span>
  );
}
