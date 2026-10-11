import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  CheckSquare,
  CornerDownLeft,
  File,
  FolderKanban,
  Search,
  Zap,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { getDb, useCollection } from "@/lib/db/database";
import { rankSearch, type SearchDoc } from "@/domain/search";
import type { MessageKey } from "@/lib/i18n/en";
import {
  PALETTE_GROUPS,
  PALETTE_TARGETS,
  type PaletteGroup,
} from "./commands";
import { useRunCommand } from "./useRunCommand";

const RECENT_KEY = "palette_recent";

function getRecent(): string[] {
  try {
    return JSON.parse(getDb().prefs.get().viewSettings[RECENT_KEY] ?? "[]");
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  const prefs = getDb().prefs;
  const recent = [id, ...getRecent().filter((item) => item !== id)].slice(0, 6);
  prefs.set({
    viewSettings: {
      ...prefs.get().viewSettings,
      [RECENT_KEY]: JSON.stringify(recent),
    },
  });
}

interface Item {
  id: string;
  title: string;
  subtitle?: string;
  type: SearchDoc["type"];
  group?: PaletteGroup | "recent";
}

const GROUP_LABEL = new Map<PaletteGroup, MessageKey>(PALETTE_GROUPS);

export function CommandPalette() {
  const { t } = useT();
  const navigate = useNavigate();
  const { paletteOpen, setPaletteOpen, activeWorkspaceId, announce, openSettings } =
    useUi();
  const workspaces = useCollection("workspaces");
  const tasks = useCollection("tasks");
  const resources = useCollection("resources");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const runAction = useRunCommand();

  const targetDocs = useMemo<(SearchDoc & { group: PaletteGroup })[]>(
    () =>
      PALETTE_TARGETS.map((target) => ({
        id: target.id,
        type: "command",
        group: target.group,
        title: t(target.labelKey),
        subtitle: t(GROUP_LABEL.get(target.group)!),
        keywords: target.keywords,
      })),
    [t],
  );

  const docs = useMemo<SearchDoc[]>(() => {
    const out: SearchDoc[] = [...targetDocs];
    for (const workspace of workspaces) {
      if (workspace.status === "archived") continue;
      out.push({
        id: `ws:${workspace.id}`,
        type: "workspace",
        title: workspace.name,
        subtitle: workspace.purpose,
        keywords: workspace.tags.join(" "),
        updatedAt: workspace.lastActivityAt,
        favorite: workspace.favorite,
      });
    }
    for (const task of tasks) {
      if (task.status === "archived") continue;
      out.push({
        id: `task:${task.id}`,
        type: "task",
        title: task.title,
        subtitle: t(`task.${task.status}` as MessageKey),
        workspaceId: task.workspaceId,
        updatedAt: task.updatedAt,
      });
    }
    for (const resource of resources) {
      if (resource.kind !== "file" && resource.kind !== "folder") continue;
      out.push({
        id: `resource:${resource.id}`,
        type: "resource",
        title: resource.title,
        subtitle: resource.target,
        workspaceId: resource.workspaceId,
        updatedAt: resource.lastOpenedAt,
      });
    }
    return out;
  }, [targetDocs, resources, t, tasks, workspaces]);

  const results = useMemo(
    () =>
      query.trim()
        ? rankSearch(docs, query, {
            currentWorkspaceId: activeWorkspaceId ?? undefined,
            limit: 24,
          })
        : [],
    [activeWorkspaceId, docs, query],
  );

  /* With nothing typed the palette is a map of the app: Recent first, then
     every group in full, so a place is findable without knowing its name. */
  const browseItems = useMemo<Item[]>(() => {
    const byId = new Map(targetDocs.map((doc) => [doc.id, doc]));
    const recent = paletteOpen
      ? getRecent().flatMap((id) => {
          const doc = byId.get(id);
          return doc ? [{ ...doc, group: "recent" as const }] : [];
        })
      : [];
    return [...recent.slice(0, 5), ...targetDocs];
  }, [targetDocs, paletteOpen]);

  const items: Item[] = query.trim()
    ? results.map((result) => ({
        id: result.id,
        title: result.title,
        subtitle: result.subtitle,
        type: result.type,
      }))
    : browseItems.map((item) => ({ ...item, subtitle: undefined }));

  /* Focus goes back where it came from when the palette closes (docs/design/shell-spec.md
     §6). The dialog is unmounted rather than closed, which leaves focus on
     <body>, so this is done by hand. It runs before a Settings section chosen
     here opens, so the Settings modal records the same origin. */
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (paletteOpen && dialog && !dialog.open) {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
      dialog.showModal();
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!paletteOpen) {
      if (dialog?.open) dialog.close();
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && document.contains(opener)) opener.focus();
    }
  }, [paletteOpen]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    if (query.trim()) announce(t("common.results", { count: results.length }));
  }, [announce, query, results.length, t]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const execute = (id: string) => {
    setPaletteOpen(false);
    pushRecent(id);
    const target = PALETTE_TARGETS.find((item) => item.id === id);
    if (target?.to) navigate(target.to);
    if (target?.action) runAction(target.action);
    if (target?.settings) openSettings(target.settings);
    const [kind, ...parts] = id.split(":");
    const ref = parts.join(":");
    if (kind === "ws") navigate(`/workspaces/${ref}`);
    if (kind === "task") {
      const task = tasks.find((item) => item.id === ref);
      navigate(
        task?.workspaceId
          ? `/workspaces/${task.workspaceId}/tasks`
          : "/workspaces",
      );
    }
    if (kind === "resource") {
      // Selecting a specific file used to drop the choice and open the generic
      // Files page. Go to the project that owns it, on its resources tab.
      const resource = resources.find((item) => item.id === ref);
      navigate(
        resource?.workspaceId
          ? `/workspaces/${resource.workspaceId}/resources`
          : "/files",
      );
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((value) => Math.min(value + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[selected]) execute(items[selected].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setPaletteOpen(false);
    }
  };

  const typeIcon = (item: Item) => {
    if (item.type === "workspace") return <FolderKanban size={14} aria-hidden />;
    if (item.type === "task") return <CheckSquare size={14} aria-hidden />;
    if (item.type === "resource") return <File size={14} aria-hidden />;
    if (item.id.startsWith("cmd:")) return <Zap size={14} aria-hidden />;
    return <CornerDownLeft size={14} aria-hidden />;
  };

  const groupLabel = (group: Item["group"]) =>
    group === "recent" ? t("palette.recent") : group ? t(GROUP_LABEL.get(group)!) : "";

  if (!paletteOpen) return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      className="palette"
      aria-label={t("titlebar.commandPalette")}
      onCancel={(event) => {
        event.preventDefault();
        setPaletteOpen(false);
      }}
    >
      <label className="palette-label" htmlFor="palette-input">
        {t("palette.label")}
      </label>
      <div className="palette-input-row">
        <Search size={15} aria-hidden />
        <input
          ref={inputRef}
          id="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={
            items[selected] ? `palette-item-${selected}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div
        className="palette-list"
        id="palette-list"
        role="listbox"
        ref={listRef}
        aria-label={t("palette.results")}
      >
        {query.trim() && items.length === 0 && (
          <div className="empty" style={{ padding: 24 }}>
            <p>{t("palette.noResults", { query })}</p>
          </div>
        )}
        {items.map((item, index) => (
          <Fragment key={`${item.group ?? "result"}:${item.id}`}>
            {item.group && item.group !== items[index - 1]?.group && (
              <div className="palette-group" role="presentation">
                {groupLabel(item.group)}
              </div>
            )}
            <button
              id={`palette-item-${index}`}
              type="button"
              role="option"
              aria-selected={index === selected}
              className="palette-item"
              data-command-id={item.id}
              data-group={item.group}
              onMouseEnter={() => setSelected(index)}
              onClick={() => execute(item.id)}
            >
              {typeIcon(item)}
              <span className="truncate">{item.title}</span>
              {item.subtitle && <span className="palette-sub">{item.subtitle}</span>}
            </button>
          </Fragment>
        ))}
      </div>
      <div className="palette-footer" aria-hidden>
        <span>
          <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd>{" "}
          {t("palette.hint.navigate")}
        </span>
        <span>
          <kbd className="kbd">Enter</kbd> {t("palette.hint.open")}
        </span>
        <span>
          <kbd className="kbd">Esc</kbd> {t("palette.hint.close")}
        </span>
      </div>
    </dialog>,
    document.body,
  );
}
