import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Plus, Square, X } from "lucide-react";
import { EnablePrivateLabButton } from "@/components/EnablePrivateLabButton";
import { getBridge } from "@/lib/bridge";
import type { TerminalSessionInfo } from "@/lib/bridge/terminal";
import { usePreferences } from "@/lib/db/database";
import { TerminalTab } from "./TerminalTab";
import { useTerminalTabs, type TerminalTab as TerminalTabRecord } from "./terminalTabs";
import { closeManagedTerminals } from "./managedTerminals";
import { useTerminalSessionFacts } from "./terminalSessionFacts";
import { useT } from "@/lib/i18n";
import "./terminal.css";

/** hh:mm:ss, the board's mono clock. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Re-render once a second while something on screen is counting. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

/** Rust's facts for a tab's session, or undefined while they are not live:
 * after a failed list or a runtime change the old record is history. */
function useSessionInfo(sessionId: string | undefined): TerminalSessionInfo | undefined {
  return useTerminalSessionFacts((f) =>
    sessionId && f.status === "live" ? f.byId[sessionId] : undefined,
  );
}

type TabState = "live" | "stopping" | "ended" | "unknown";

function tabState(info: TerminalSessionInfo | undefined): TabState {
  if (!info) return "unknown";
  if (info.state === "running") return "live";
  if (info.state === "stopping") return "stopping";
  return "ended";
}

function WorkTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TerminalTabRecord;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const state = tabState(useSessionInfo(tab.sessionId));
  return (
    <div className={`work-tab${active ? " is-active" : ""}`} data-testid="work-tab">
      <button
        type="button"
        className="work-tab__label"
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
      >
        <span className={`work-dot is-${state}`} aria-hidden />
        <span className="work-tab__title">{tab.title}</span>
      </button>
      <button
        type="button"
        className="work-tab__close"
        aria-label={t("terminal.closeTab", { title: tab.title })}
        title={t("terminal.closeTab", { title: tab.title })}
        onClick={onClose}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

/** The active session's facts as Rust reports them. The exit code is
 * the shell process's own, shown once it ended; nothing here guesses a last
 * command's result. */
function WorkStatus({ sessionId }: { sessionId: string | undefined }) {
  const { t } = useT();
  const status = useTerminalSessionFacts((f) => f.status);
  const info = useSessionInfo(sessionId);
  const state = tabState(info);
  const now = useNow(state === "live" || state === "stopping");

  let body;
  if (!info) {
    body = (
      <span>{t(status === "unavailable" ? "work.unavailable" : "work.reading")}</span>
    );
  } else {
    const ended = state === "ended";
    const chip =
      state === "live" ? (
        <span className="work-chip work-chip--live">
          <span className="work-dot is-live" aria-hidden />
          {t("work.live")}
        </span>
      ) : state === "stopping" ? (
        <span className="work-chip work-chip--warn">{t("work.stopping")}</span>
      ) : (
        <span className="work-chip">
          {t(info.exit?.reason === "stopped" ? "work.stopped" : "work.ended")}
        </span>
      );
    body = (
      <>
        {chip}
        <span>{info.programName}</span>
        {info.initialCwd && (
          <span className="work-status__trunc" title={info.initialCwd}>
            {info.initialCwd}
          </span>
        )}
        {info.pid !== null && <span>{t("work.pid", { pid: info.pid })}</span>}
        <span className="work-status__end">
          {ended &&
            (info.exit ? (
              <span
                className={`work-chip ${info.exit.code === 0 ? "work-chip--ok" : "work-chip--danger"}`}
              >
                {info.exit.code === 0 ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
                {t("work.exit", { code: info.exit.code })}
              </span>
            ) : (
              <span className="work-chip">{t("work.exitUnknown")}</span>
            ))}
          <span>
            {ended
              ? t("work.ran", { time: clock(info.elapsedMs) })
              : t("work.up", { time: clock(now - info.startedAt) })}
          </span>
        </span>
      </>
    );
  }
  return (
    <section className="work-status" aria-label={t("work.statusLabel")}>
      {body}
    </section>
  );
}

/** Where the terminal would be, while it cannot run here: the same calm,
 * dark well the live terminal fills, saying why and what to do. */
function TerminalGate({
  testId,
  title,
  hint,
  action,
}: {
  testId: string;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="page work-gate" data-scroll-owner="page">
      <h1 className="sr-only">{t("terminal.title")}</h1>
      <div className="work-gate__well" data-testid={testId}>
        <div className="work-empty">
          <span className="work-empty__prompt" aria-hidden>
            <ChevronRight size={22} strokeWidth={2.2} />
            <span className="work-empty__caret" />
          </span>
          <h2 className="work-empty__title">{title}</h2>
          <p className="work-empty__hint">{hint}</p>
          {action}
        </div>
      </div>
    </div>
  );
}

/**
 * Real interactive terminal. Three states:
 *   1. Browser build — honest "native runtime required" surface. No PTY
 *      exists outside the native runtime, so this never renders a fake shell.
 *   2. Native runtime, Private Lab not yet consented — an opt-in surface.
 *      Enabling here is the Private Lab question only (ADR 0007 / 0012 1b):
 *      it changes neither the assistant nor tool-proposal consent.
 *   3. Native runtime, Private Lab consented — the Work surface:
 *      session tabs over the live xterm, and the active session's facts.
 *      With every tab closed it offers a new terminal instead of a blank.
 */
export default function TerminalPage() {
  const { t } = useT();
  const prefs = usePreferences();
  const bridge = getBridge();
  const controller = bridge.terminal;
  const nativeAvailable = controller.available();
  const canRunTerminal = nativeAvailable && prefs.privateToolsEnabled;

  const tabs = useTerminalTabs((s) => s.tabs);
  const activeId = useTerminalTabs((s) => s.activeId);
  const reseedAllowed = useTerminalTabs((s) => s.reseedAllowed);
  const openShellTab = useTerminalTabs((s) => s.openShellTab);
  const closeTab = useTerminalTabs((s) => s.closeTab);
  const setActive = useTerminalTabs((s) => s.setActive);
  const [resolvedProgram, setResolvedProgram] = useState<string | null>(null);

  useEffect(() => {
    if (!nativeAvailable) return;
    let cancelled = false;
    void controller
      .resolvedShell()
      .then((report) => {
        if (!cancelled) setResolvedProgram(report.program);
      })
      .catch(() => {
        if (!cancelled) setResolvedProgram("");
      });
    return () => {
      cancelled = true;
    };
  }, [nativeAvailable, controller]);

  useEffect(() => {
    if (!canRunTerminal || tabs.length > 0 || !reseedAllowed) return;
    if (resolvedProgram === null) return;
    openShellTab("pwsh", resolvedProgram || undefined);
  }, [canRunTerminal, tabs.length, reseedAllowed, openShellTab, resolvedProgram]);

  if (!nativeAvailable) {
    return (
      <TerminalGate
        testId="terminal-native-required"
        title={t("terminal.nativeRequired")}
        hint={t("terminal.nativeRequiredHint")}
      />
    );
  }

  if (!prefs.privateToolsEnabled) {
    return (
      <TerminalGate
        testId="terminal-consent-required"
        title={t("terminal.consentRequired")}
        hint={t("terminal.consentRequiredHint")}
        action={<EnablePrivateLabButton testId="terminal-enable" />}
      />
    );
  }

  const activeTab = tabs.find((tab) => tab.id === activeId);
  return (
    <div className="page work">
      <h1 className="sr-only">{t("terminal.title")}</h1>
      <div className="work-bar">
        <div className="work-tabs" role="group" aria-label={t("work.sessions")}>
          {tabs.map((tab) => (
            <WorkTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              onSelect={() => setActive(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
          <button
            type="button"
            className="work-tab-new"
            data-guide="terminal-new"
            aria-label={t("terminal.newTab")}
            title={t("terminal.newTab")}
            onClick={() => openShellTab("pwsh", resolvedProgram || undefined)}
          >
            <Plus size={15} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="btn btn--danger-outline btn--sm work-stop-all"
          onClick={() => {
            void closeManagedTerminals();
          }}
          data-testid="terminal-kill-all"
        >
          <Square size={12} aria-hidden />
          {t("terminal.killAll")}
        </button>
      </div>
      <div className="terminal-body">
        {tabs.map((tab) => (
          <TerminalTab
            key={tab.id}
            tabId={tab.id}
            spec={tab.spec}
            active={tab.id === activeId}
            title={tab.title}
          />
        ))}
        {tabs.length === 0 && (
          <div className="work-empty" data-testid="terminal-empty">
            <span className="work-empty__prompt" aria-hidden>
              <ChevronRight size={22} strokeWidth={2.2} />
              <span className="work-empty__caret" />
            </span>
            <h2 className="work-empty__title">{t("terminal.empty.title")}</h2>
            <p className="work-empty__hint">{t("terminal.empty.hint")}</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => openShellTab("pwsh", resolvedProgram || undefined)}
            >
              <Plus size={14} aria-hidden /> {t("terminal.newTab")}
            </button>
          </div>
        )}
      </div>
      {activeTab && <WorkStatus sessionId={activeTab.sessionId} />}
    </div>
  );
}
