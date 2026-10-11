import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Brain,
  Check,
  Cloud,
  Cpu,
  Database as DataIcon,
  Download,
  KeyRound,
  Pencil,
  Plus,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { MAX_MEMORY_LENGTH, latestConversation, type JarvisMemory } from "@/domain/conversations";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CloudConnections } from "@/features/settings/CloudConnections";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { archiveAllConversations, setConversationModel } from "@/lib/db/conversations";
import { addMemory, clearMemories, deleteMemory, editMemory } from "@/lib/db/jarvis";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { useUi } from "@/state/ui";
import { JarvisMark } from "./AssistantParts";
import { chatsAsJson, chatsAsMarkdown, download } from "./exportChats";
import {
  choiceOf,
  defaultModel,
  resolveModel,
  sameModel,
  setDefaultModel,
  type ResolvedModel,
} from "./jarvisModel";
import { useJarvisUi, type JarvisSettingsSection } from "./jarvisUi";
import { cloudBlocker, modelLabel } from "./ModelChip";
import { personalBlock } from "./personal";
import { startConversation } from "./startConversation";
import { useModelOptions } from "./useModelOptions";
import "./settings.css";

/* Jarvis's own settings, opened from the Jarvis page:
   personalization, memory, the model, the cloud keys and the data controls.
   A sheet over the conversation from the right, with its sections down its
   left edge. Cloud keys are the same cards as in Settings: a key goes to
   Rust and only "saved, ends in …" comes back. */

const SECTIONS: { id: JarvisSettingsSection; labelKey: MessageKey; icon: typeof Brain }[] = [
  { id: "personal", labelKey: "jarvis.settings.personal", icon: Sparkles },
  { id: "memory", labelKey: "jarvis.settings.memory", icon: Brain },
  { id: "model", labelKey: "jarvis.settings.model", icon: Cpu },
  { id: "keys", labelKey: "jarvis.settings.keys", icon: KeyRound },
  { id: "data", labelKey: "jarvis.settings.data", icon: DataIcon },
];

export default function JarvisSettings() {
  const { t } = useT();
  const section = useJarvisUi((state) => state.settings);
  const openSection = useJarvisUi((state) => state.openSettings);
  const close = useJarvisUi((state) => state.closeSettings);
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    opener.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    const onClick = (e: MouseEvent) => {
      if (e.target === dialog) close();
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onClick);
      if (dialog.open) dialog.close();
      const back = opener.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
  }, [close]);

  return (
    <dialog ref={ref} className="jvs" aria-labelledby="jvs-title" data-testid="jarvis-settings">
      <div className="jvs__in">
        <header className="jvs__h">
          <JarvisMark size={18} />
          <h2 id="jvs-title" className="jvs__title">
            {t("jarvis.settings.title")}
          </h2>
          <button
            type="button"
            className="btn btn--icon btn--sm jvs__close"
            aria-label={t("action.close")}
            onClick={close}
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="jvs__body">
          <nav className="jvs__nav" aria-label={t("jarvis.settings.sections")}>
            {SECTIONS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="jvs__tab"
                aria-current={section === id ? "page" : undefined}
                onClick={() => openSection(id)}
              >
                <Icon size={15} aria-hidden />
                {t(labelKey)}
              </button>
            ))}
          </nav>
          <div className="jvs__pane" key={section ?? "none"}>
            {section === "personal" && <PersonalSection />}
            {section === "memory" && <MemorySection />}
            {section === "model" && <ModelSection />}
            {section === "keys" && <KeysSection />}
            {section === "data" && <DataSection />}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function Pane({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="jvs-sec" aria-labelledby="jvs-sec-title">
      <h3 id="jvs-sec-title" className="jvs-sec__t">
        {title}
      </h3>
      <p className="jvs-sec__lead">{lead}</p>
      {children}
    </section>
  );
}

/* ---------- Personalization ---------- */

const STYLES = ["balanced", "concise", "detailed"] as const;

function PersonalSection() {
  const { t } = useT();
  const prefs = usePreferences();
  const memories = useCollection("jarvisMemories");
  const toast = useUi((s) => s.toast);
  const [about, setAbout] = useState(prefs.jarvisAboutYou);
  const [instructions, setInstructions] = useState(prefs.jarvisInstructions);
  const dirty = about !== prefs.jarvisAboutYou || instructions !== prefs.jarvisInstructions;
  const preview = personalBlock(t, prefs, memories);

  return (
    <Pane title={t("jarvis.settings.personal")} lead={t("jarvis.personal.lead")}>
      <div className="jvs-field">
        <label htmlFor="jvs-about" className="jvs-field__l">
          {t("jarvis.personal.about")}
        </label>
        <textarea
          id="jvs-about"
          className="textarea jvs-text"
          rows={4}
          maxLength={1500}
          value={about}
          placeholder={t("jarvis.personal.aboutPlaceholder")}
          onChange={(e) => setAbout(e.target.value)}
        />
      </div>
      <div className="jvs-field">
        <label htmlFor="jvs-instructions" className="jvs-field__l">
          {t("jarvis.personal.instructions")}
        </label>
        <textarea
          id="jvs-instructions"
          className="textarea jvs-text"
          rows={4}
          maxLength={1500}
          value={instructions}
          placeholder={t("jarvis.personal.instructionsPlaceholder")}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <div className="jvs-actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!dirty}
          onClick={() => {
            getDb().prefs.set({ jarvisAboutYou: about.trim(), jarvisInstructions: instructions.trim() });
            setAbout(about.trim());
            setInstructions(instructions.trim());
            toast({ kind: "success", messageKey: "jarvis.personal.saved" });
          }}
        >
          {t("action.save")}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setAbout(prefs.jarvisAboutYou);
              setInstructions(prefs.jarvisInstructions);
            }}
          >
            {t("action.cancel")}
          </button>
        )}
      </div>

      <fieldset className="jvs-style">
        <legend className="jvs-field__l">{t("jarvis.personal.style")}</legend>
        <div className="jvs-style__opts">
          {STYLES.map((style) => (
            <label key={style} className="jvs-style__opt">
              <input
                type="radio"
                name="jvs-style"
                checked={prefs.jarvisResponseStyle === style}
                onChange={() => getDb().prefs.set({ jarvisResponseStyle: style })}
              />
              <span className="jvs-style__name">{t(`jarvis.personal.style.${style}`)}</span>
              <span className="jvs-style__hint">{t(`jarvis.personal.style.${style}Hint`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <details className="jvs-preview">
        <summary>{t("jarvis.personal.preview")}</summary>
        {preview ? (
          <pre className="jvs-preview__text">{preview}</pre>
        ) : (
          <p className="jvs-muted">{t("jarvis.personal.previewEmpty")}</p>
        )}
        <p className="jvs-muted">{t("jarvis.personal.previewNote")}</p>
      </details>
    </Pane>
  );
}

/* ---------- Memory ---------- */

function MemorySection() {
  const { t, locale } = useT();
  const prefs = usePreferences();
  const memories = useCollection("jarvisMemories");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "one"; memory: JarvisMemory } | { kind: "all" } | null>(null);
  const db = getDb();
  const sorted = [...memories].sort((a, b) => b.createdAt - a.createdAt);
  const date = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
  const fail = (what: string) => (caught: unknown) => console.error(what, caught);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    addMemory(db, text).then(() => setDraft(""), fail("memory not added"));
  };

  return (
    <Pane title={t("jarvis.settings.memory")} lead={t("jarvis.memory.lead")}>
      <label className="jvs-switch">
        <input
          type="checkbox"
          role="switch"
          checked={prefs.jarvisMemoryEnabled}
          onChange={(e) => db.prefs.set({ jarvisMemoryEnabled: e.target.checked })}
        />
        <span className="jvs-switch__track" aria-hidden />
        {t("jarvis.memory.use")}
        <span className="jvs-muted">
          {prefs.jarvisMemoryEnabled ? t("jarvis.memory.onHint") : t("jarvis.memory.offHint")}
        </span>
      </label>

      <form
        className="jvs-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label htmlFor="jvs-memory-new" className="sr-only">
          {t("jarvis.memory.newLabel")}
        </label>
        <input
          id="jvs-memory-new"
          className="input"
          value={draft}
          maxLength={MAX_MEMORY_LENGTH}
          placeholder={t("jarvis.memory.newPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim()}>
          <Plus size={13} aria-hidden /> {t("jarvis.memory.add")}
        </button>
      </form>

      {sorted.length === 0 ? (
        <div className="jvs-empty">
          <Brain size={18} aria-hidden />
          <p>{t("jarvis.memory.empty")}</p>
        </div>
      ) : (
        <>
          <ul className={prefs.jarvisMemoryEnabled ? "jvs-mems" : "jvs-mems is-off"} aria-label={t("jarvis.memory.list")}>
            {sorted.map((m) => (
              <li key={m.id} className="jvs-mem">
                {editing === m.id ? (
                  <MemoryEditor
                    memory={m}
                    onDone={(text) => {
                      setEditing(null);
                      if (text !== null) editMemory(db, m.id, text).catch(fail("memory not edited"));
                    }}
                  />
                ) : (
                  <>
                    <p className="jvs-mem__text">{m.text}</p>
                    <div className="jvs-mem__foot">
                      <span className="jvs-mem__date">{date(m.updatedAt)}</span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-label={t("jarvis.memory.editOne", { text: m.text })}
                        onClick={() => setEditing(m.id)}
                      >
                        <Pencil size={12} aria-hidden /> {t("jarvis.memory.edit")}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-label={t("jarvis.memory.deleteOne", { text: m.text })}
                        onClick={() => setConfirm({ kind: "one", memory: m })}
                      >
                        <Trash2 size={12} aria-hidden /> {t("jarvis.memory.delete")}
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="jvs-actions">
            <span className="jvs-muted">{t("jarvis.memory.count", { count: sorted.length })}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirm({ kind: "all" })}>
              <Trash2 size={12} aria-hidden /> {t("jarvis.memory.clear")}
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        danger
        title={confirm?.kind === "all" ? t("jarvis.memory.clearTitle") : t("jarvis.memory.deleteTitle")}
        body={confirm?.kind === "one" ? confirm.memory.text : t("jarvis.memory.clearBody", { count: sorted.length })}
        confirmLabel={confirm?.kind === "all" ? t("jarvis.memory.clear") : t("jarvis.memory.delete")}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target?.kind === "one") deleteMemory(db, target.memory.id).catch(fail("memory not deleted"));
          else if (target?.kind === "all") clearMemories(db).catch(fail("memory not cleared"));
        }}
      />
    </Pane>
  );
}

function MemoryEditor({ memory, onDone }: { memory: JarvisMemory; onDone: (text: string | null) => void }) {
  const { t } = useT();
  const [text, setText] = useState(memory.text);
  return (
    <form
      className="jvs-mem__edit"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(text.trim() ? text : null);
      }}
    >
      <label htmlFor={`jvs-mem-${memory.id}`} className="sr-only">
        {t("jarvis.memory.editLabel")}
      </label>
      <textarea
        id={`jvs-mem-${memory.id}`}
        className="textarea jvs-text"
        rows={2}
        maxLength={MAX_MEMORY_LENGTH}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone(null);
          }
        }}
      />
      <div className="jvs-actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!text.trim()}>
          <Check size={12} aria-hidden /> {t("action.save")}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDone(null)}>
          {t("action.cancel")}
        </button>
      </div>
    </form>
  );
}

/* ---------- Model ---------- */

function ModelSection() {
  const { t } = useT();
  const prefs = usePreferences();
  const openSection = useJarvisUi((state) => state.openSettings);
  const conversations = useCollection("conversations");
  const shown = latestConversation(conversations);
  const { local, cloud, cloudAvailable, retry } = useModelOptions(true);
  const current = defaultModel(prefs);
  const own = shown?.model ? resolveModel(shown.model, prefs) : null;

  const pick = (candidate: Pick<ResolvedModel, "provider" | "preset" | "model">) => {
    const choice = choiceOf(candidate);
    if (choice) setDefaultModel(getDb(), choice);
  };

  const localNames =
    local.kind === "ready"
      ? Array.from(
          new Set([
            ...local.models.map((m) => m.name),
            ...(current.provider === "local" ? [current.model] : []),
          ]),
        )
      : [];

  const row = (
    key: string,
    candidate: Pick<ResolvedModel, "provider" | "preset" | "model">,
    label: string,
    note: string | null,
    fix?: ReactNode,
  ) => {
    const checked = sameModel(candidate, current);
    return (
      <div key={key} className={note && !checked ? "jvs-model is-blocked" : "jvs-model"}>
        <label className="jvs-model__l">
          <input
            type="radio"
            name="jvs-default-model"
            checked={checked}
            disabled={(Boolean(note) && !checked) || !choiceOf(candidate)}
            onChange={() => pick(candidate)}
          />
          <span className="jvs-model__t">{label}</span>
          {checked && <span className="jvs-model__badge">{t("jarvis.model.default")}</span>}
          {note && <span className="jvs-model__note">{note}</span>}
        </label>
        {fix}
      </div>
    );
  };

  return (
    <Pane title={t("jarvis.settings.model")} lead={t("jarvis.modelSettings.lead")}>
      {own && shown && (
        <div className="jvs-callout">
          <span>{t("jarvis.modelSettings.ownChoice", { name: modelLabel(t, own) })}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              void setConversationModel(getDb(), shown.id, null).catch((caught: unknown) =>
                console.error("model choice not cleared", caught),
              )
            }
          >
            {t("jarvis.model.useDefault")}
          </button>
        </div>
      )}

      <div className="jvs-group" role="radiogroup" aria-labelledby="jvs-local-t">
        <h4 id="jvs-local-t" className="jvs-group__t">
          <Cpu size={13} aria-hidden /> {t("jarvis.model.local")}
        </h4>
        {local.kind === "loading" && <p className="jvs-muted">{t("jarvis.model.loading")}</p>}
        {local.kind === "off" && <p className="jvs-muted">{t("jarvis.model.localOff")}</p>}
        {local.kind === "unreachable" && (
          <p className="jvs-muted jvs-warn">
            {t("jarvis.model.localUnreachable")}{" "}
            <button type="button" className="asst-linkbtn" onClick={retry}>
              <RotateCw size={11} aria-hidden /> {t("jarvis.model.retry")}
            </button>
          </p>
        )}
        {local.kind === "ready" && localNames.length === 0 && (
          <p className="jvs-muted">{t("jarvis.model.localNone")}</p>
        )}
        {localNames.map((name) =>
          row(
            `local:${name}`,
            { provider: "local", model: name },
            name,
            local.kind === "ready" && !local.models.some((m) => m.name === name)
              ? t("jarvis.model.notInstalled")
              : null,
          ),
        )}
      </div>

      <div className="jvs-group" role="radiogroup" aria-labelledby="jvs-cloud-t">
        <h4 id="jvs-cloud-t" className="jvs-group__t">
          <Cloud size={13} aria-hidden /> {t("jarvis.model.cloud")}
        </h4>
        {!cloudAvailable && <p className="jvs-muted">{t("jarvis.model.cloudDesktopOnly")}</p>}
        {cloud.map((c) => {
          const candidate = {
            provider: c.target.provider,
            ...(c.target.provider === "openai_compat" ? { preset: c.target.preset } : {}),
            model: c.model,
          } as const;
          const blocker = cloudBlocker(t, c);
          return row(
            c.target.provider === "anthropic" ? "anthropic" : `compat:${c.target.preset}`,
            candidate,
            modelLabel(t, candidate),
            blocker,
            blocker ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openSection("keys")}>
                <KeyRound size={12} aria-hidden /> {t("jarvis.modelSettings.toKeys")}
              </button>
            ) : undefined,
          );
        })}
        {cloudAvailable && <p className="jvs-muted">{t("jarvis.modelSettings.cloudNote")}</p>}
      </div>
    </Pane>
  );
}

/* ---------- Cloud keys ---------- */

function KeysSection() {
  const { t } = useT();
  return (
    <Pane title={t("jarvis.settings.keys")} lead={t("jarvis.keys.lead")}>
      <div className="jvs-keys">
        <CloudConnections />
      </div>
    </Pane>
  );
}

/* ---------- Data controls ---------- */

function DataSection() {
  const { t, locale } = useT();
  const conversations = useCollection("conversations");
  const folders = useCollection("conversationFolders");
  const memories = useCollection("jarvisMemories");
  const toast = useUi((s) => s.toast);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const open = conversations.filter((c) => c.archivedAt === undefined);
  const stamp = new Date().toISOString().slice(0, 10);

  const stats: { labelKey: MessageKey; value: number }[] = [
    { labelKey: "jarvis.data.statConversations", value: conversations.length },
    { labelKey: "jarvis.data.statArchived", value: conversations.length - open.length },
    { labelKey: "jarvis.data.statFolders", value: folders.length },
    { labelKey: "jarvis.data.statMemories", value: memories.length },
  ];

  return (
    <Pane title={t("jarvis.settings.data")} lead={t("jarvis.data.lead")}>
      <dl className="jvs-stats">
        {stats.map((s) => (
          <div key={s.labelKey} className="jvs-stat">
            <dt>{t(s.labelKey)}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="jvs-data">
        <div className="jvs-data__row">
          <div>
            <h4 className="jvs-data__t">{t("jarvis.data.export")}</h4>
            <p className="jvs-muted">{t("jarvis.data.exportHint")}</p>
          </div>
          <div className="jvs-data__acts">
            <button
              type="button"
              className="btn btn--sm"
              disabled={conversations.length === 0}
              onClick={() => {
                const file = `${t("jarvis.data.fileName")}-${stamp}.md`;
                download(
                  file,
                  chatsAsMarkdown(t, locale, conversations, folders, Date.now()),
                  "text/markdown;charset=utf-8",
                );
                toast({ kind: "success", messageKey: "jarvis.data.exported", params: { file } });
              }}
            >
              <Download size={13} aria-hidden /> {t("jarvis.data.exportMarkdown")}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={conversations.length === 0}
              onClick={() => {
                const file = `${t("jarvis.data.fileName")}-${stamp}.json`;
                download(file, chatsAsJson(conversations, folders, Date.now()), "application/json");
                toast({ kind: "success", messageKey: "jarvis.data.exported", params: { file } });
              }}
            >
              <Download size={13} aria-hidden /> {t("jarvis.data.exportJson")}
            </button>
          </div>
        </div>
        <div className="jvs-data__row">
          <div>
            <h4 className="jvs-data__t">{t("jarvis.data.archiveAll")}</h4>
            <p className="jvs-muted">{t("jarvis.data.archiveAllHint")}</p>
          </div>
          <div className="jvs-data__acts">
            <button
              type="button"
              className="btn btn--sm"
              disabled={open.length === 0}
              onClick={() => setConfirmArchive(true)}
            >
              <Archive size={13} aria-hidden /> {t("jarvis.data.archiveAllButton", { count: open.length })}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        title={t("jarvis.data.archiveAllTitle", { count: open.length })}
        body={t("jarvis.data.archiveAllBody")}
        confirmLabel={t("jarvis.data.archiveAll")}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => {
          setConfirmArchive(false);
          archiveAllConversations(getDb()).then(
            (count) => {
              toast({ kind: "success", messageKey: "jarvis.data.archivedAll", params: { count } });
              // The chat starts afresh instead of showing an archived one.
              return startConversation(getDb());
            },
            (caught: unknown) => console.error("conversations not archived", caught),
          );
        }}
      />
    </Pane>
  );
}
