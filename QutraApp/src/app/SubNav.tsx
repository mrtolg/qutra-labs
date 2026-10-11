import { useLocation, useNavigate } from "react-router-dom";
import {
  Download,
  File,
  Folder,
  Github,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  List,
  Plus,
  Shield,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { Engagement } from "@/domain/lab";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { resolveLabView, resolveToolsView, toolsHref, type LabView } from "@/domain/workbench";
import { useLabEngagement } from "@/features/lab/useLabEngagement";
import { useJarvisUi } from "@/features/jarvis/jarvisUi";
import { startConversation } from "@/features/jarvis/startConversation";
import { LAB_VIEW_DEFS, TOOLS_VIEW_DEFS } from "./workbench/navConfig";
import { areaFor, type Area } from "./surfaces";
import { useGlideThumb, type GlideThumb } from "./useGlideThumb";
import "./subnav.css";

/* The second row of the one navigation bar (it replaces
   the side rail). Choosing an area in the top bar slides that area's
   sections in here, so a screen shows its own choices only after the user
   picked where to be. As in the top bar, one highlight glides to the current
   section. The Lab's row names the engagement its views belong to and slides
   in again when another engagement opens, so the switch is felt, not only
   read. Reduced motion drops the slide and the glide (base.css). */

interface Section {
  to: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  /** First path segments this section is current for. */
  owns: readonly string[];
}

const SECTIONS: Record<"home" | "terminal", readonly Section[]> = {
  home: [
    { to: "/overview", labelKey: "nav.overview", icon: Home, owns: ["overview"] },
    // A project's focus session is part of the project.
    { to: "/workspaces", labelKey: "nav.workspaces", icon: Folder, owns: ["workspaces", "sessions"] },
    { to: "/files", labelKey: "nav.files", icon: File, owns: ["files"] },
    { to: "/github", labelKey: "nav.github", icon: Github, owns: ["github"] },
  ],
  terminal: [
    { to: "/terminal", labelKey: "terminal.title", icon: SquareTerminal, owns: ["terminal"] },
  ],
};

const LABEL: Record<Area, MessageKey> = {
  home: "subnav.home",
  lab: "subnav.lab",
  tools: "subnav.tools",
  assistant: "subnav.assistant",
  terminal: "subnav.terminal",
};

export function SubNav() {
  const { pathname } = useLocation();
  const area = areaFor(pathname);
  return (
    <div className="subnav">
      {/* A new area mounts a new row, which slides in. */}
      {area === "lab" ? (
        <LabRow />
      ) : area === "assistant" ? (
        <AssistantRow />
      ) : area === "tools" ? (
        <ToolsRow />
      ) : (
        <AreaRow key={area} area={area} />
      )}
    </div>
  );
}

function Thumb({ thumb }: { thumb: GlideThumb | null }) {
  if (!thumb) return null;
  return (
    <span
      className="subnav__thumb"
      aria-hidden
      style={{ transform: `translateX(${thumb.x}px)`, width: thumb.width }}
    />
  );
}

/** The Tools area's sections; `?view` picks one. Every section keeps the
    investigation it was opened for (`?e`). */
function ToolsRow() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const view = resolveToolsView(params.get("view"));
  const { ref, thumb } = useGlideThumb<HTMLElement>(`${view}|${locale}`);
  return (
    <div className="subnav__in">
      <nav
        ref={ref}
        className={thumb ? "subnav__tabs has-thumb" : "subnav__tabs"}
        aria-label={t(LABEL.tools)}
      >
        <Thumb thumb={thumb} />
        {TOOLS_VIEW_DEFS.map(({ view: id, labelKey, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="subnav__tab"
            aria-current={id === view ? "page" : undefined}
            onClick={() => navigate(toolsHref(id, params.get("e")))}
          >
            <Icon size={14} aria-hidden />
            {t(labelKey)}
          </button>
        ))}
      </nav>
    </div>
  );
}

function AreaRow({ area }: { area: "home" | "terminal" }) {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const segment = pathname.split("/")[1] ?? "";
  const { ref, thumb } = useGlideThumb<HTMLElement>(`${pathname}|${locale}`);
  return (
    <div className="subnav__in">
      <nav
        ref={ref}
        className={thumb ? "subnav__tabs has-thumb" : "subnav__tabs"}
        aria-label={t(LABEL[area])}
      >
        <Thumb thumb={thumb} />
        {SECTIONS[area].map((s) => (
          <button
            key={s.to}
            type="button"
            className="subnav__tab"
            aria-current={s.owns.includes(segment) ? "page" : undefined}
            onClick={() => navigate(s.to)}
          >
            <s.icon size={14} aria-hidden />
            {t(s.labelKey)}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** The Jarvis page's row. Its conversations are in the history panel on
    the page, so the row holds what acts on the page:
    showing or hiding that panel, Jarvis's settings and New conversation. */
function AssistantRow() {
  const { t } = useT();
  const navigate = useNavigate();
  const historyOpen = usePreferences().jarvisHistoryOpen;
  const openJarvisSettings = useJarvisUi((state) => state.openSettings);
  const settingsOpen = useJarvisUi((state) => state.settings !== null);

  const startNew = () => {
    navigate("/jarvis");
    startConversation(getDb()).catch((caught: unknown) =>
      console.error("conversation not created", caught),
    );
  };

  return (
    <div className="subnav__in">
      <button
        type="button"
        className="subnav__action"
        aria-pressed={historyOpen}
        onClick={() => getDb().prefs.set({ jarvisHistoryOpen: !historyOpen })}
      >
        {historyOpen ? <PanelLeftClose size={14} aria-hidden /> : <PanelLeftOpen size={14} aria-hidden />}
        {t("subnav.history")}
      </button>
      <div className="subnav__actions">
        <button
          type="button"
          className="subnav__action"
          aria-expanded={settingsOpen}
          onClick={() => {
            navigate("/jarvis");
            openJarvisSettings();
          }}
        >
          <SlidersHorizontal size={14} aria-hidden />
          {t("subnav.jarvisSettings")}
        </button>
        <button type="button" className="subnav__action" onClick={startNew}>
          <Plus size={14} aria-hidden />
          {t("subnav.newConversation")}
        </button>
      </div>
    </div>
  );
}

/** Keyed by the open engagement: opening another one slides its row in.
    The list of every investigation (?list=1) has a row of its own. */
function LabRow() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const { current, counts } = useLabEngagement(params.get("e"));
  if (params.get("list") === "1") return <LabListRow key="list" />;
  return <LabRowIn key={current?.id ?? "none"} current={current} counts={counts} />;
}

/** The way to every investigation, first in the Lab's row. */
function AllInvestigations({ current }: { current: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="subnav__tab subnav__all"
      aria-current={current ? "page" : undefined}
      onClick={() => navigate("/lab?list=1")}
    >
      <List size={14} aria-hidden />
      {t("lab.list.title")}
    </button>
  );
}

function LabListRow() {
  return (
    <div className="subnav__in">
      <AllInvestigations current />
    </div>
  );
}

/** An investigation's six sections, with their counts. Every link names the
    investigation, so a section never loses it. */
function LabRowIn({
  current,
  counts,
}: {
  current: Engagement | undefined;
  counts: Partial<Record<LabView, number>>;
}) {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const { search } = useLocation();
  const view = resolveLabView(new URLSearchParams(search).get("view"));
  const { ref, thumb } = useGlideThumb<HTMLElement>(`${view}|${current?.id ?? ""}|${locale}`);
  const open = (id: LabView) =>
    navigate(current ? `/lab?e=${encodeURIComponent(current.id)}&view=${id}` : `/lab?view=${id}`);
  return (
    <div className="subnav__in">
      <AllInvestigations current={false} />
      <span className="subnav__div" aria-hidden />
      {current && (
        <button
          type="button"
          className="subnav__eng"
          title={current.title}
          onClick={() => open("overview")}
        >
          <Shield size={13} aria-hidden />
          <span className="subnav__eng-name">{current.title}</span>
        </button>
      )}
      <nav
        ref={ref}
        className={thumb ? "subnav__tabs has-thumb" : "subnav__tabs"}
        aria-label={
          current ? t("subnav.labOf", { name: current.title }) : t(LABEL.lab)
        }
      >
        <Thumb thumb={thumb} />
        {LAB_VIEW_DEFS.map(({ view: id, labelKey, icon: Icon }) => {
          const count = counts[id];
          return (
            <button
              key={id}
              type="button"
              className="subnav__tab"
              aria-current={id === view ? "page" : undefined}
              disabled={!current}
              onClick={() => open(id)}
            >
              <Icon size={14} aria-hidden />
              {t(labelKey)}
              {count !== undefined && count > 0 && (
                <span className={`subnav__n${id === "runs" ? " is-live" : ""}`}>{count}</span>
              )}
            </button>
          );
        })}
      </nav>
      {current && <LabActions current={current} />}
    </div>
  );
}

/** Import stays at the row's end; the report is the Report section now. */
function LabActions({ current }: { current: Engagement }) {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <div className="subnav__actions">
      <button
        type="button"
        className="subnav__action"
        onClick={() =>
          navigate(`/lab?e=${encodeURIComponent(current.id)}&view=findings&focus=import`)
        }
      >
        <Download size={14} aria-hidden />
        {t("lab.import")}
      </button>
    </div>
  );
}
