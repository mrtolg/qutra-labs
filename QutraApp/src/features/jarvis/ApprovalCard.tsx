import type { ReactNode } from "react";
import { Check, ShieldAlert, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import type { ApprovalAction } from "@/lib/localAssistant/client";
import { launchFailureMessage } from "@/lib/launch/launchFailureMessage";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";

/** A proposed tool call awaiting a human decision, or awaiting its result
    after one (ADR 0012, Decision 2). Keyed by `callId` -- the id the broker
    matches an approval against, so a stale card from an earlier step in the
    same turn can never be confused with the current one. */
export interface PendingApproval {
  requestId: string;
  callId: string;
  /** The exact proposed action as one sentence, built by Rust. Rendered as
      plain text, never as markup: a proposal must not be able to disguise
      what it is asking for by embedding markup in its own description. */
  summary: string;
  /** The tool's wire name (`terminal_run`, `launch_tool`, `read_context`). */
  tool: string;
  /** The same action as facts, when Rust sent them. */
  action?: ApprovalAction;
  decision: "awaiting" | "approved" | "rejected";
}

type Tone = "ok" | "warn" | "danger" | "neutral";

function Chip({ tone, icon, children, title }: { tone: Tone; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className={`asst-chip asst-chip--${tone}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

const RISK_TONE: Record<string, Tone> = { low: "ok", medium: "warn", high: "danger", critical: "danger" };

/**
 * The inline approval card. What it asks is said
 * once as a fact template, the exact command or argv is shown as written,
 * and the chips state only what Rust established: a scope or an effect
 * nobody assessed is said to be unassessed, never shown green.
 */
export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (approved: boolean) => void;
}) {
  const { t } = useT();
  const action = approval.action;
  const awaiting = approval.decision === "awaiting";

  let intent: string | null = null;
  let command = approval.summary;
  const chips: ReactNode[] = [];
  let blockedReason: string | null = null;

  if (action?.kind === "terminal_run") {
    intent = action.sessionId
      ? t("jarvis.approval.intentSession")
      : t("jarvis.approval.intentTerminal");
    command = action.command;
    chips.push(
      <Chip key="scope" tone="warn" icon={<ShieldQuestion size={12} aria-hidden />}>
        {t("jarvis.approval.scopeNotAssessed")}
      </Chip>,
      <Chip key="effects" tone="neutral">
        {t("jarvis.approval.effectsNotClassified")}
      </Chip>,
    );
  } else if (action?.kind === "launch_tool") {
    const name = action.displayName ?? action.installationId;
    intent = t("jarvis.approval.intentLaunch", { name });
    command = action.argsText ? `${name} ${action.argsText}` : name;
    if (action.identity.state === "verified") {
      const tier = action.identity.riskTier;
      chips.push(
        <Chip
          key="identity"
          tone="ok"
          icon={<ShieldCheck size={12} aria-hidden />}
          title={`SHA-256 ${action.identity.sha256}`}
        >
          {t("jarvis.approval.verified")}
        </Chip>,
        <Chip key="risk" tone={RISK_TONE[tier] ?? "neutral"}>
          {t("jarvis.approval.registeredRating", {
            rating: t(`lab.severity.${tier}` as MessageKey),
          })}
        </Chip>,
        <Chip key="scope" tone="warn" icon={<ShieldQuestion size={12} aria-hidden />}>
          {t("jarvis.approval.scopeNotAssessed")}
        </Chip>,
      );
    } else {
      blockedReason = launchFailureMessage(t, action.identity.reason, name);
      chips.push(
        <Chip key="blocked" tone="danger" icon={<ShieldAlert size={12} aria-hidden />}>
          {t("jarvis.approval.cannotRun")}
        </Chip>,
      );
    }
  } else if (action?.kind === "read_context") {
    intent = t("jarvis.approval.intentRead");
    command = action.contextKind;
    chips.push(
      <Chip key="read" tone="ok">
        {t("jarvis.approval.readOnly")}
      </Chip>,
    );
  }

  return (
    <section
      className="asst-approval"
      role="group"
      aria-label={t("jarvis.approval.title")}
      data-testid="assistant-approval-card"
    >
      <header className="asst-approval__h">
        <ShieldAlert size={14} aria-hidden />
        <span className="asst-approval__lbl">{t("jarvis.approval.title")}</span>
        <span className="asst-approval__state">
          {awaiting
            ? t("jarvis.approval.paused")
            : approval.decision === "approved"
              ? t("jarvis.approval.pending")
              : t("jarvis.approval.rejected")}
        </span>
      </header>
      <div className="asst-approval__b">
        {intent && <p className="asst-approval__intent">{intent}</p>}
        <pre className="asst-approval__cmd" data-testid="assistant-approval-summary">
          {command}
        </pre>
        {chips.length > 0 && <div className="asst-approval__chips">{chips}</div>}
        {blockedReason && <p className="asst-approval__blocked">{blockedReason}</p>}
        {approval.tool === "terminal_run" && (
          <p className="asst-approval__note" data-testid="assistant-approval-account-note">
            {t("jarvis.approval.terminalAccount")}
          </p>
        )}
        <div className="asst-approval__foot">
          {awaiting && (
            <>
              {!blockedReason && (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => onDecide(true)}
                >
                  <Check size={14} aria-hidden /> {t("jarvis.approval.approve")}
                </button>
              )}
              <button
                type="button"
                className="btn btn--danger-outline btn--sm"
                onClick={() => onDecide(false)}
              >
                <X size={14} aria-hidden /> {t("jarvis.approval.reject")}
              </button>
            </>
          )}
          <span className="asst-approval__gate">{t("jarvis.approval.gate")}</span>
        </div>
      </div>
    </section>
  );
}
