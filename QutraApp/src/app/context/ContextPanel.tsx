import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FileText, FolderOpen, GitBranch, SquareTerminal, X, type LucideIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb, usePreferences } from "@/lib/db/database";
import { clampSize, CONTEXT_PANEL } from "@/domain/workbench";
import { ResizeHandle } from "@/app/workbench/ResizeHandle";
import {
  CONTEXT_SEGMENTS,
  SEGMENT_LABEL,
  closeContextPanel,
  useOverlayForm,
  type ContextSegment,
} from "./panelState";
import { ProjectSegment } from "./ProjectSegment";
import { FilesSegment } from "./FilesSegment";
import { RepoSegment } from "./RepoSegment";
import { RunsOutputSegment } from "./RunsOutputSegment";
import "./context.css";

const SEGMENT_ICON: Record<ContextSegment, LucideIcon> = {
  project: FolderOpen,
  files: FileText,
  repo: GitBranch,
  runs: SquareTerminal,
};

/* Where focus goes back to when the panel closes: whatever held it when the
   panel was asked to open. Module scope, because the opener (top-bar toggle,
   Ctrl+B, a Lab row) is not a child of the panel. */
let returnFocus: HTMLElement | null = null;

/**
 * The one context panel: Project, Files, Repo and Runs
 * output in one right-hand panel that replaces the Inspector and the bottom
 * panel. One width (360 px, drag 320–480, remembered) on every surface. Wider
 * than 1100 px it takes layout space beside the surface; at 1100 and below it
 * overlays the surface over a dim backdrop that closes it, and the Workbench
 * makes what it covers inert. Ctrl+B or the top bar's toggle opens it on the
 * last segment; Escape closes it and focus goes back to where it was.
 */
export function ContextPanel() {
  const prefs = usePreferences();
  const open = prefs.contextPanelOpen;

  /* Recorded while rendering the opening frame: the panel moves focus to its
     tab in its own mount effect, which runs before any effect here. */
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    return () => {
      const target = returnFocus;
      returnFocus = null;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  return open ? <Panel /> : null;
}

function Panel() {
  const { t } = useT();
  const prefs = usePreferences();
  const overlay = useOverlayForm();
  const segment = prefs.contextPanelSegment;
  const tabRefs = useRef<Partial<Record<ContextSegment, HTMLButtonElement | null>>>({});
  const asideRef = useRef<HTMLElement>(null);

  const width = clampSize(prefs.contextPanelWidth, CONTEXT_PANEL);
  const [liveWidth, setLiveWidth] = useState(width);
  const liveRef = useRef(width);
  useEffect(() => {
    liveRef.current = width;
    setLiveWidth(width);
  }, [width]);
  const resizeBy = useCallback((delta: number) => {
    // The grip is on the left edge, so dragging left widens the panel.
    const next = clampSize(liveRef.current - delta, CONTEXT_PANEL);
    liveRef.current = next;
    setLiveWidth(next);
  }, []);
  const persistWidth = useCallback(() => {
    getDb().prefs.set({ contextPanelWidth: liveRef.current });
  }, []);

  useEffect(() => {
    tabRefs.current[getDb().prefs.get().contextPanelSegment]?.focus();
  }, []);

  /* As an overlay the panel covers the rail and the surface, which turn inert.
     Focus left there by a resize comes inside; only the top bar stays live
     outside it, and Escape pressed there closes the overlay too. */
  useEffect(() => {
    if (!overlay) return;
    if (!asideRef.current?.contains(document.activeElement)) {
      tabRefs.current[getDb().prefs.get().contextPanelSegment]?.focus();
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      closeContextPanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay]);

  const choose = (next: ContextSegment, focus = false) => {
    getDb().prefs.set({ contextPanelSegment: next });
    if (focus) tabRefs.current[next]?.focus();
  };

  const onTabKey = (e: KeyboardEvent) => {
    const at = CONTEXT_SEGMENTS.indexOf(segment);
    const last = CONTEXT_SEGMENTS.length - 1;
    const to =
      e.key === "ArrowRight"
        ? (at + 1) % CONTEXT_SEGMENTS.length
        : e.key === "ArrowLeft"
          ? (at + last) % CONTEXT_SEGMENTS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(CONTEXT_SEGMENTS[to]!, true);
  };

  return (
    <>
      {overlay && (
        // A pointer convenience (aria-hidden); Escape and the close button do the same.
        <div
          className="ctx-backdrop"
          data-testid="context-backdrop"
          aria-hidden
          onClick={closeContextPanel}
        />
      )}
      {/* Escape closes the panel it is pressed in. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <aside
        ref={asideRef}
        className="ctx"
        aria-label={t("ctx.title")}
        data-mode={overlay ? "overlay" : "push"}
        style={{ width: liveWidth }}
        onKeyDown={(e) => {
          // A dialog opened from a segment closes itself on Escape, not the panel.
          const inDialog = (e.target as HTMLElement).closest("dialog");
          if (e.key === "Escape" && !e.defaultPrevented && !inDialog) {
            e.stopPropagation();
            closeContextPanel();
          }
        }}
      >
        <ResizeHandle
          orientation="x"
          ariaLabel={t("ctx.resize")}
          value={liveWidth}
          min={CONTEXT_PANEL.min}
          max={CONTEXT_PANEL.max}
          onResize={resizeBy}
          onCommit={persistWidth}
        />
        <header className="ctx__h">
          <h2 className="ctx__title">{t("ctx.title")}</h2>
          <kbd aria-hidden>Ctrl B</kbd>
          <button
            type="button"
            className="ctx__close"
            onClick={closeContextPanel}
            aria-label={t("action.close")}
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="ctx__seg">
          {/* Arrow keys move between the tabs (WAI-ARIA tabs pattern). */}
          {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
          <div className="ctx-tabs" role="tablist" aria-label={t("ctx.segments")} onKeyDown={onTabKey}>
            {CONTEXT_SEGMENTS.map((id) => {
              const Icon = SEGMENT_ICON[id];
              const selected = id === segment;
              return (
                <button
                  key={id}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  id={`ctx-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`ctx-panel-${id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => choose(id)}
                >
                  <Icon size={14} aria-hidden />
                  <span>{t(SEGMENT_LABEL[id])}</span>
                </button>
              );
            })}
          </div>
        </div>
        {/* Focusable so the keyboard can scroll a segment longer than the panel. */}
        <div
          className="ctx__b"
          id={`ctx-panel-${segment}`}
          role="tabpanel"
          aria-labelledby={`ctx-tab-${segment}`}
          tabIndex={0}
        >
          {segment === "project" && <ProjectSegment />}
          {segment === "files" && <FilesSegment />}
          {segment === "repo" && <RepoSegment />}
          {segment === "runs" && <RunsOutputSegment />}
        </div>
      </aside>
    </>
  );
}
