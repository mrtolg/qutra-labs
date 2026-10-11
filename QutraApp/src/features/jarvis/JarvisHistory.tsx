import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { latestConversation, type Conversation, type ConversationFolder } from "@/domain/conversations";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu, type MenuItemDef } from "@/components/ui/Menu";
import { getDb, useCollection } from "@/lib/db/database";
import {
  deleteConversation,
  moveToFolder,
  openConversation,
  renameConversation,
  setArchived,
  setPinned,
} from "@/lib/db/conversations";
import { createFolder, deleteFolder, renameFolder, setFolderArchived } from "@/lib/db/jarvis";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import {
  bucketOf,
  buildArchive,
  buildHistory,
  folderMap,
  isArchived,
  searchConversations,
  type DateBucket,
} from "./history";
import { startConversation } from "./startConversation";
import { useRowDrag } from "./useRowDrag";
import "./history.css";

/* The vertical history on the Jarvis page: search,
   pinned conversations, folders with what is filed in them, the rest by day,
   and the archive. It reads like a case log: a rail runs down each day's
   conversations and the open one's mark is lit. */

type Translate = ReturnType<typeof useT>["t"];

const fail = (what: string) => (caught: unknown) => console.error(what, caught);

function bucketLabel(t: Translate, bucket: DateBucket, locale: string): string {
  if (bucket.kind === "older") {
    const [year, month] = bucket.month.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
      new Date(year!, month! - 1, 1),
    );
  }
  return t(`jarvis.history.group.${bucket.kind}`);
}

function timeLabel(at: number, now: number, locale: string): string {
  const bucket = bucketOf(at, now);
  if (bucket.kind === "today" || bucket.kind === "yesterday") {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  }
  if (bucket.kind === "week") {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  }
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(at);
}

export function conversationLabel(t: Translate, c: Conversation): string {
  return c.title || (c.messages.length > 0 ? t("jarvis.conversation.untitled") : t("jarvis.conversation.new"));
}

/** What a menu was opened for. */
type MenuFor =
  | { kind: "conversation"; id: string; anchor: HTMLElement }
  | { kind: "move"; id: string; anchor: HTMLElement }
  | { kind: "folder"; id: string; anchor: HTMLElement };

type Confirm =
  | { kind: "conversation"; id: string; title: string }
  | { kind: "folder"; id: string; title: string };

export function JarvisHistory() {
  const { t, locale } = useT();
  const db = getDb();
  const toast = useUi((s) => s.toast);
  const conversations = useCollection("conversations");
  const folders = useCollection("conversationFolders");
  const active = latestConversation(conversations);
  const activeId = active?.id ?? null;
  const now = Date.now();

  const [query, setQuery] = useState("");
  const [view, setView] = useState<"history" | "archive">("history");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(active?.folderId ? [active.folderId] : []),
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<{ moveId: string | null } | null>(null);
  const [menu, setMenu] = useState<MenuFor | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => folderMap(folders), [folders]);
  const history = buildHistory(conversations, folders, { activeId, now });
  const archive = useMemo(() => buildArchive(conversations, folders), [conversations, folders]);
  const archivedCount =
    archive.conversations.length + archive.folders.reduce((n, f) => n + f.conversations.length, 0);
  const hits = useMemo(() => {
    const pool =
      view === "archive"
        ? conversations.filter((c) => isArchived(c, byId))
        : conversations.filter((c) => !isArchived(c, byId));
    return searchConversations(pool, query, locale);
  }, [conversations, byId, query, locale, view]);

  const expand = (id: string, open = true) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const open = (id: string) => {
    openConversation(db, id).catch(fail("conversation not opened"));
  };

  const move = (id: string, folderId: string | null) => {
    const c = conversations.find((x) => x.id === id);
    if (!c || (c.folderId ?? null) === folderId) return;
    if (folderId) expand(folderId);
    moveToFolder(db, id, folderId).then(
      () => {
        const folder = folderId ? byId.get(folderId) : undefined;
        toast({
          kind: "success",
          ...(folder
            ? { messageKey: "jarvis.history.movedTo", params: { title: conversationLabel(t, c), folder: folder.name } }
            : { messageKey: "jarvis.history.movedOut", params: { title: conversationLabel(t, c) } }),
        });
      },
      fail("conversation not moved"),
    );
  };

  const { drag, begin, consumeClick } = useRowDrag(move);

  /** The chat shows the conversation opened last. One that leaves the
      history while open gives way to a new conversation, so nothing asked
      next goes into a conversation the history no longer shows. */
  const leaveIfOpen = (ids: readonly string[]) => {
    if (activeId && ids.includes(activeId)) {
      startConversation(db).catch(fail("conversation not created"));
    }
  };

  const archiveConversation = (c: Conversation) => {
    setArchived(db, c.id, true).then(() => {
      leaveIfOpen([c.id]);
      toast({
        kind: "success",
        messageKey: "jarvis.history.archived",
        params: { title: conversationLabel(t, c) },
        actionKey: "jarvis.history.undo",
        onAction: () => void setArchived(db, c.id, false).catch(fail("conversation not restored")),
      });
    }, fail("conversation not archived"));
  };

  const archiveFolder = (f: ConversationFolder) => {
    setFolderArchived(db, f.id, true).then(() => {
      leaveIfOpen(conversations.filter((c) => c.folderId === f.id).map((c) => c.id));
      toast({
        kind: "success",
        messageKey: "jarvis.history.folderArchived",
        params: { name: f.name },
        actionKey: "jarvis.history.undo",
        onAction: () => void setFolderArchived(db, f.id, false).catch(fail("folder not restored")),
      });
    }, fail("folder not archived"));
  };

  const conversationItems = (c: Conversation): (MenuItemDef | "separator")[] => {
    const archived = isArchived(c, byId);
    if (archived) {
      return [
        {
          key: "restore",
          icon: <ArchiveRestore size={14} aria-hidden />,
          label: t("jarvis.history.restore"),
          disabled: c.archivedAt === undefined,
          onSelect: () => void setArchived(db, c.id, false).catch(fail("conversation not restored")),
        },
        "separator",
        {
          key: "delete",
          danger: true,
          icon: <Trash2 size={14} aria-hidden />,
          label: t("jarvis.history.delete"),
          onSelect: () => setConfirm({ kind: "conversation", id: c.id, title: conversationLabel(t, c) }),
        },
      ];
    }
    return [
      {
        key: "rename",
        icon: <Pencil size={14} aria-hidden />,
        label: t("jarvis.history.rename"),
        onSelect: () => setRenaming(c.id),
      },
      {
        key: "pin",
        icon: c.pinnedAt ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />,
        label: c.pinnedAt ? t("jarvis.history.unpin") : t("jarvis.history.pin"),
        onSelect: () => void setPinned(db, c.id, !c.pinnedAt).catch(fail("pin not changed")),
      },
      {
        key: "move",
        icon: <FolderInput size={14} aria-hidden />,
        label: t("jarvis.history.moveTo"),
        // The folder list opens where this menu was.
        onSelect: () => {
          const anchor = menu?.anchor;
          if (anchor) queueMicrotask(() => setMenu({ kind: "move", id: c.id, anchor }));
        },
      },
      {
        key: "archive",
        icon: <Archive size={14} aria-hidden />,
        label: t("jarvis.history.archive"),
        onSelect: () => archiveConversation(c),
      },
      "separator",
      {
        key: "delete",
        danger: true,
        icon: <Trash2 size={14} aria-hidden />,
        label: t("jarvis.history.delete"),
        onSelect: () => setConfirm({ kind: "conversation", id: c.id, title: conversationLabel(t, c) }),
      },
    ];
  };

  const moveItems = (c: Conversation): (MenuItemDef | "separator")[] => [
    ...history.folders.map(({ folder }) => ({
      key: folder.id,
      icon: <Folder size={14} aria-hidden />,
      label: folder.name,
      disabled: c.folderId === folder.id,
      onSelect: () => move(c.id, folder.id),
    })),
    ...(c.folderId
      ? [
          {
            key: "out",
            icon: <X size={14} aria-hidden />,
            label: t("jarvis.history.moveOut"),
            onSelect: () => move(c.id, null),
          },
        ]
      : []),
    ...(history.folders.length > 0 || c.folderId ? ["separator" as const] : []),
    {
      key: "new",
      icon: <FolderPlus size={14} aria-hidden />,
      label: t("jarvis.history.newFolderWith"),
      onSelect: () => setNewFolder({ moveId: c.id }),
    },
  ];

  const folderItems = (f: ConversationFolder): (MenuItemDef | "separator")[] =>
    f.archivedAt !== undefined
      ? [
          {
            key: "restore",
            icon: <ArchiveRestore size={14} aria-hidden />,
            label: t("jarvis.history.restore"),
            onSelect: () => void setFolderArchived(db, f.id, false).catch(fail("folder not restored")),
          },
          "separator",
          {
            key: "delete",
            danger: true,
            icon: <Trash2 size={14} aria-hidden />,
            label: t("jarvis.history.deleteFolder"),
            onSelect: () => setConfirm({ kind: "folder", id: f.id, title: f.name }),
          },
        ]
      : [
          {
            key: "new",
            icon: <SquarePen size={14} aria-hidden />,
            label: t("jarvis.history.newInFolder"),
            onSelect: () => {
              expand(f.id);
              startConversation(db, { folderId: f.id }).catch(fail("conversation not created"));
            },
          },
          {
            key: "rename",
            icon: <Pencil size={14} aria-hidden />,
            label: t("jarvis.history.renameFolder"),
            onSelect: () => setRenaming(f.id),
          },
          {
            key: "archive",
            icon: <Archive size={14} aria-hidden />,
            label: t("jarvis.history.archiveFolder"),
            onSelect: () => archiveFolder(f),
          },
        ];

  const menuItems = (): (MenuItemDef | "separator")[] => {
    if (!menu) return [];
    if (menu.kind === "folder") {
      const f = byId.get(menu.id);
      return f ? folderItems(f) : [];
    }
    const c = conversations.find((x) => x.id === menu.id);
    if (!c) return [];
    return menu.kind === "move" ? moveItems(c) : conversationItems(c);
  };

  const row = (c: Conversation, options: { pinMark?: boolean } = {}) => (
    <ConversationRow
      key={c.id}
      c={c}
      label={conversationLabel(t, c)}
      time={timeLabel(c.updatedAt, now, locale)}
      active={c.id === activeId}
      dragging={drag?.id === c.id}
      pinMark={options.pinMark === true && c.pinnedAt !== undefined}
      renaming={renaming === c.id}
      menuOpen={menu !== null && menu.kind !== "folder" && menu.id === c.id}
      onOpen={() => {
        if (consumeClick()) return;
        open(c.id);
      }}
      onPointerDown={(e) => begin(e, c.id, conversationLabel(t, c))}
      onMenu={(anchor) => setMenu({ kind: "conversation", id: c.id, anchor })}
      onRename={(title) => {
        setRenaming(null);
        if (title !== null) renameConversation(db, c.id, title).catch(fail("conversation not renamed"));
      }}
    />
  );

  const folderBlock = ({ folder, conversations: items }: { folder: ConversationFolder; conversations: Conversation[] }) => {
    const isOpen = expanded.has(folder.id);
    const over = drag !== null && drag.over === folder.id;
    const archived = folder.archivedAt !== undefined;
    return (
      <div key={folder.id} className={over ? "jvh-folder is-over" : "jvh-folder"} data-drop-folder={archived ? undefined : folder.id}>
        <div className="jvh-folder__row">
          {renaming === folder.id ? (
            <NameInput
              label={t("jarvis.history.folderName")}
              initial={folder.name}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null) renameFolder(db, folder.id, name).catch(fail("folder not renamed"));
              }}
            />
          ) : (
            <button
              type="button"
              className="jvh-folder__open"
              aria-expanded={isOpen}
              onClick={() => expand(folder.id, !isOpen)}
            >
              <ChevronRight size={13} className="jvh-folder__chev" aria-hidden />
              {isOpen ? <FolderOpen size={14} aria-hidden /> : <Folder size={14} aria-hidden />}
              <span className="jvh-folder__name">{folder.name}</span>
              <span className="jvh-count" aria-hidden>
                {items.length}
              </span>
              <span className="sr-only"> {t("jarvis.history.folderCount", { count: items.length })}</span>
            </button>
          )}
          <button
            type="button"
            className="jvh-more"
            aria-label={t("jarvis.history.folderActions", { name: folder.name })}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "folder" && menu.id === folder.id}
            onClick={(e) => setMenu({ kind: "folder", id: folder.id, anchor: e.currentTarget })}
          >
            <MoreHorizontal size={14} aria-hidden />
          </button>
        </div>
        {isOpen && (
          <div className="jvh-folder__items" role="group" aria-label={folder.name}>
            {items.length === 0 ? (
              <p className="jvh-hint">{t("jarvis.history.folderEmpty")}</p>
            ) : (
              items.map((c) => row(c))
            )}
          </div>
        )}
      </div>
    );
  };

  const searching = query.trim() !== "";
  const nothingYet =
    history.pinned.length === 0 && history.folders.length === 0 && history.groups.length === 0;

  let body: ReactNode;
  if (searching) {
    body = (
      <Section label={t("jarvis.history.results", { count: hits.length })}>
        {hits.length === 0 ? (
          <p className="jvh-hint">{t("jarvis.history.noResults", { query: query.trim() })}</p>
        ) : (
          hits.map(({ conversation: c, snippet }) => (
            <div key={c.id} className="jvh-hit">
              {row(c)}
              {snippet && <p className="jvh-hit__snip">{snippet}</p>}
            </div>
          ))
        )}
      </Section>
    );
  } else if (view === "archive") {
    body =
      archive.folders.length === 0 && archive.conversations.length === 0 ? (
        <p className="jvh-empty">{t("jarvis.history.archiveEmpty")}</p>
      ) : (
        <>
          {archive.folders.length > 0 && (
            <Section label={t("jarvis.history.folders")}>{archive.folders.map(folderBlock)}</Section>
          )}
          {archive.conversations.length > 0 && (
            <Section label={t("jarvis.history.conversations")}>
              <div className="jvh-log">{archive.conversations.map((c) => row(c))}</div>
            </Section>
          )}
        </>
      );
  } else {
    body = (
      <>
        {history.pinned.length > 0 && (
          <Section label={t("jarvis.history.pinned")}>
            {history.pinned.map((c) => row(c, { pinMark: true }))}
          </Section>
        )}
        <Section
          label={t("jarvis.history.folders")}
          action={
            <button
              type="button"
              className="jvh-sec__add"
              aria-label={t("jarvis.history.newFolder")}
              title={t("jarvis.history.newFolder")}
              onClick={() => setNewFolder({ moveId: null })}
            >
              <Plus size={13} aria-hidden />
            </button>
          }
        >
          {newFolder && (
            <div className="jvh-folder jvh-folder--new">
              <NameInput
                label={t("jarvis.history.folderName")}
                initial=""
                placeholder={t("jarvis.history.folderPlaceholder")}
                onDone={(name) => {
                  const moveId = newFolder.moveId;
                  setNewFolder(null);
                  if (name === null) return;
                  createFolder(db, name).then((folder) => {
                    if (!folder) return;
                    expand(folder.id);
                    if (moveId) move(moveId, folder.id);
                  }, fail("folder not created"));
                }}
              />
            </div>
          )}
          {history.folders.map(folderBlock)}
          {history.folders.length === 0 && !newFolder && (
            <button type="button" className="jvh-hint jvh-hint--btn" onClick={() => setNewFolder({ moveId: null })}>
              <FolderPlus size={13} aria-hidden /> {t("jarvis.history.foldersEmpty")}
            </button>
          )}
        </Section>
        {/* Dropped here, a conversation leaves its folder. */}
        <div
          className={drag?.over === "" ? "jvh-dates is-over" : "jvh-dates"}
          data-drop-folder=""
        >
          {history.groups.map((group) => (
            <Section key={group.key} label={bucketLabel(t, group.bucket, locale)}>
              <div className="jvh-log">{group.conversations.map((c) => row(c))}</div>
            </Section>
          ))}
          {nothingYet && <p className="jvh-empty">{t("jarvis.history.empty")}</p>}
        </div>
      </>
    );
  }

  const menuConversation =
    menu && menu.kind !== "folder" ? conversations.find((c) => c.id === menu.id) : undefined;

  return (
    <aside className="jvh" aria-label={t("jarvis.history.label")} data-testid="jarvis-history">
      <div className="jvh__top">
        {view === "archive" && (
          <button
            type="button"
            className="jvh-back"
            onClick={() => {
              setView("history");
              setQuery("");
            }}
          >
            <ArrowLeft size={14} aria-hidden /> {t("jarvis.history.back")}
          </button>
        )}
        <div className="jvh-search">
          <label htmlFor="jvh-search" className="jvh-search__l">
            <Search size={14} aria-hidden />
            {t("action.search")}
          </label>
          <input
            id="jvh-search"
            ref={searchRef}
            type="search"
            value={query}
            aria-label={view === "archive" ? t("jarvis.history.searchArchive") : t("jarvis.history.search")}
            placeholder={t("jarvis.history.searchHint")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="jvh-search__clear"
              aria-label={t("jarvis.history.clearSearch")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>

      <nav className="jvh__scroll" aria-label={t("jarvis.history.list")}>
        {body}
      </nav>

      {view === "history" && (
        <div className="jvh__foot">
          <button
            type="button"
            className="jvh-archive"
            onClick={() => {
              setView("archive");
              setQuery("");
            }}
          >
            <Archive size={14} aria-hidden />
            <span>{t("jarvis.history.archiveView")}</span>
            <span className="jvh-count">{archivedCount}</span>
          </button>
        </div>
      )}

      {drag && (
        <div className="jvh-ghost" aria-hidden style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 10}px)` }}>
          {drag.over !== undefined && drag.over !== "" ? (
            <FolderInput size={13} aria-hidden />
          ) : (
            <MoreHorizontal size={13} aria-hidden />
          )}
          <span>{drag.title}</span>
        </div>
      )}

      <Menu
        key={menu ? `${menu.kind}:${menu.id}` : "none"}
        anchorEl={menu?.anchor ?? null}
        items={menuItems()}
        onClose={() => setMenu(null)}
        ariaLabel={
          menu?.kind === "folder"
            ? t("jarvis.history.folderActions", { name: byId.get(menu.id)?.name ?? "" })
            : menu?.kind === "move"
              ? t("jarvis.history.moveTo")
              : t("jarvis.history.actionsFor", {
                  title: menuConversation ? conversationLabel(t, menuConversation) : "",
                })
        }
      />

      <ConfirmDialog
        open={confirm !== null}
        danger
        title={
          confirm?.kind === "folder"
            ? t("jarvis.history.deleteFolderTitle", { name: confirm.title })
            : t("jarvis.history.deleteTitle", { title: confirm?.title ?? "" })
        }
        body={
          confirm?.kind === "folder"
            ? t("jarvis.history.deleteFolderBody")
            : t("jarvis.history.deleteBody")
        }
        confirmLabel={confirm?.kind === "folder" ? t("jarvis.history.deleteFolder") : t("jarvis.history.delete")}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (!target) return;
          if (target.kind === "folder") {
            deleteFolder(db, target.id).catch(fail("folder not deleted"));
          } else {
            deleteConversation(db, target.id).then(() => {
              leaveIfOpen([target.id]);
              toast({ kind: "success", messageKey: "jarvis.history.deleted", params: { title: target.title } });
            }, fail("conversation not deleted"));
          }
        }}
      />
    </aside>
  );
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="jvh-sec">
      <div className="jvh-sec__h">
        <h3 className="jvh-sec__t">{label}</h3>
        <span className="jvh-sec__rule" aria-hidden />
        {action}
      </div>
      {children}
    </section>
  );
}

function ConversationRow({
  c,
  label,
  time,
  active,
  dragging,
  pinMark,
  renaming,
  menuOpen,
  onOpen,
  onPointerDown,
  onMenu,
  onRename,
}: {
  c: Conversation;
  label: string;
  time: string;
  active: boolean;
  dragging: boolean;
  pinMark: boolean;
  renaming: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  onMenu: (anchor: HTMLElement) => void;
  onRename: (title: string | null) => void;
}) {
  const { t } = useT();
  const cls = ["jvh-row", active && "is-active", dragging && "is-dragging", menuOpen && "is-menu"]
    .filter(Boolean)
    .join(" ");
  if (renaming) {
    return (
      <div className={cls}>
        <NameInput label={t("jarvis.history.renameLabel")} initial={c.title || label} onDone={onRename} />
      </div>
    );
  }
  return (
    <div className={cls} data-conversation={c.id}>
      <button
        type="button"
        className="jvh-row__open"
        aria-current={active ? "page" : undefined}
        title={label}
        onClick={onOpen}
        onPointerDown={onPointerDown}
      >
        {pinMark && <Pin size={11} className="jvh-row__pin" aria-hidden />}
        <span className="jvh-row__t">{label}</span>
        {/* The row is named by its title; the time is for the eye. */}
        <span className="jvh-row__time" aria-hidden>
          {time}
        </span>
      </button>
      <button
        type="button"
        className="jvh-more"
        aria-label={t("jarvis.history.actionsFor", { title: label })}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => onMenu(e.currentTarget)}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
    </div>
  );
}

/** Inline name field: Enter keeps, Escape leaves it as it was. Leaving the
    field keeps what was typed. */
function NameInput({
  label,
  initial,
  placeholder,
  onDone,
}: {
  label: string;
  initial: string;
  placeholder?: string;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(value.trim() ? value : null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }
  };
  return (
    <input
      className="jvh-name"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      autoFocus
      maxLength={80}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value.trim() && value !== initial ? value : null)}
    />
  );
}
