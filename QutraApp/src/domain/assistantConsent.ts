import type { Preferences } from "./types";

/** Current agent-consent question. Stored G=true below this epoch is not a grant. */
export const AGENT_CONSENT_EPOCH = 1;

export type AgentConsentSlice = Pick<
  Preferences,
  | "localAssistantEnabled"
  | "privateToolsEnabled"
  | "assistantAgentToolsEnabled"
  | "assistantAutoApproveReads"
  | "assistantAgentConsentEpoch"
  | "assistantAgentAwaitingConfirmation"
  | "assistantPrivateLabPromptDismissed"
>;

function agentFieldsDiffer(a: AgentConsentSlice, b: AgentConsentSlice): boolean {
  return (
    a.assistantAgentToolsEnabled !== b.assistantAgentToolsEnabled ||
    a.assistantAgentAwaitingConfirmation !== b.assistantAgentAwaitingConfirmation ||
    a.assistantAgentConsentEpoch !== b.assistantAgentConsentEpoch
  );
}

/**
 * One-time load migration. Preserve L and P. Force G to false until the user
 * answers the explicit agent question. Awaiting confirmation is metadata, not
 * a grant. Never derive G from L∧P, from an installed model, or from prior use.
 */
export function migrateAgentConsentOnLoad<T extends AgentConsentSlice>(prefs: T): T {
  if (prefs.assistantAgentConsentEpoch >= AGENT_CONSENT_EPOCH) {
    return prefs;
  }
  if (!prefs.assistantAgentToolsEnabled) {
    return prefs;
  }
  return {
    ...prefs,
    assistantAgentToolsEnabled: false,
    assistantAgentAwaitingConfirmation: true,
    assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
  };
}

export function agentConsentNeedsPersist(
  before: AgentConsentSlice,
  after: AgentConsentSlice,
): boolean {
  return agentFieldsDiffer(before, after);
}

/**
 * Whole-profile import/restore must not skip the question by copying G=true
 * or an already-confirmed epoch. Offer Restore when the payload had G or was
 * already awaiting confirmation. Never fill missing L or P.
 */
export function sanitizeImportedAgentConsent<T extends AgentConsentSlice>(
  prefs: T,
): T {
  const hadAgentGrantOrAwaiting =
    prefs.assistantAgentToolsEnabled || prefs.assistantAgentAwaitingConfirmation;
  return {
    ...prefs,
    assistantAgentToolsEnabled: false,
    assistantAgentAwaitingConfirmation: hadAgentGrantOrAwaiting,
    assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
  };
}

/** Enable answer-only chat. P unchanged. */
export function grantAnswerOnly(): Pick<
  Preferences,
  | "localAssistantEnabled"
  | "assistantAgentToolsEnabled"
  | "assistantAgentAwaitingConfirmation"
  | "assistantAgentConsentEpoch"
> {
  return {
    localAssistantEnabled: true,
    assistantAgentToolsEnabled: false,
    assistantAgentAwaitingConfirmation: false,
    assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
  };
}

/** Enable chat and tool proposals. P unchanged. Does not touch auto-approve reads. */
export function grantToolProposals(): Pick<
  Preferences,
  | "localAssistantEnabled"
  | "assistantAgentToolsEnabled"
  | "assistantAgentAwaitingConfirmation"
  | "assistantAgentConsentEpoch"
  | "assistantPrivateLabPromptDismissed"
> {
  return {
    localAssistantEnabled: true,
    assistantAgentToolsEnabled: true,
    assistantAgentAwaitingConfirmation: false,
    assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
    assistantPrivateLabPromptDismissed: false,
  };
}

/** Inline restore: only G becomes true. Missing L or P is never filled in. */
export function restoreToolProposals(): Pick<
  Preferences,
  | "assistantAgentToolsEnabled"
  | "assistantAgentAwaitingConfirmation"
  | "assistantAgentConsentEpoch"
> {
  return {
    assistantAgentToolsEnabled: true,
    assistantAgentAwaitingConfirmation: false,
    assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
  };
}

/** Real G=false transition, not a hidden warning. */
export function switchToAnswerOnly(): Pick<
  Preferences,
  | "assistantAgentToolsEnabled"
  | "assistantAgentAwaitingConfirmation"
  | "assistantAgentConsentEpoch"
> {
  return {
    assistantAgentToolsEnabled: false,
    assistantAgentAwaitingConfirmation: false,
    assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
  };
}

/** Settings Advanced toggle is an explicit answer to the agent question. */
export function setToolProposalsFromSettings(enabled: boolean): Pick<
  Preferences,
  | "assistantAgentToolsEnabled"
  | "assistantAgentAwaitingConfirmation"
  | "assistantAgentConsentEpoch"
> {
  return enabled ? restoreToolProposals() : switchToAnswerOnly();
}

export function dismissPrivateLabPrompt(): Pick<
  Preferences,
  "assistantPrivateLabPromptDismissed"
> {
  return { assistantPrivateLabPromptDismissed: true };
}
