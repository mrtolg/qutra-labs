import { describe, expect, it } from "vitest";
import { PreferencesSchema } from "./types";
import {
  AGENT_CONSENT_EPOCH,
  grantAnswerOnly,
  grantToolProposals,
  migrateAgentConsentOnLoad,
  restoreToolProposals,
  sanitizeImportedAgentConsent,
  setToolProposalsFromSettings,
  switchToAnswerOnly,
} from "./assistantConsent";

function flags(L: boolean, P: boolean, G: boolean, extra: Record<string, unknown> = {}) {
  return PreferencesSchema.parse({
    localAssistantEnabled: L,
    privateToolsEnabled: P,
    assistantAgentToolsEnabled: G,
    assistantAgentConsentEpoch: 0,
    assistantAgentAwaitingConfirmation: false,
    ...extra,
  });
}

describe("migrateAgentConsentOnLoad", () => {
  it.each([
    [false, false, true],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ] as const)("maps %s/%s/1 to G=false and awaits confirmation", (L, P, G) => {
    const next = migrateAgentConsentOnLoad(flags(L, P, G));
    expect(next.localAssistantEnabled).toBe(L);
    expect(next.privateToolsEnabled).toBe(P);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(true);
    expect(next.assistantAgentConsentEpoch).toBe(AGENT_CONSENT_EPOCH);
    expect(G).toBe(true);
  });

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, false],
  ] as const)("leaves %s/%s/0 unchanged", (L, P, G) => {
    const start = flags(L, P, G);
    const next = migrateAgentConsentOnLoad(start);
    expect(next).toEqual(start);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(false);
  });

  it("does not derive G from L and P", () => {
    const next = migrateAgentConsentOnLoad(flags(true, true, false));
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(false);
  });

  it("does not re-migrate a confirmed epoch", () => {
    const start = flags(true, true, true, {
      assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
      assistantAgentAwaitingConfirmation: false,
    });
    expect(migrateAgentConsentOnLoad(start).assistantAgentToolsEnabled).toBe(true);
  });

  it("preserves auto-approve-reads while stripping unproven G", () => {
    const next = migrateAgentConsentOnLoad(
      flags(true, true, true, { assistantAutoApproveReads: true }),
    );
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAutoApproveReads).toBe(true);
  });
});

describe("sanitizeImportedAgentConsent", () => {
  it("does not copy G=true even with a current epoch", () => {
    const imported = flags(true, true, true, {
      assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
      assistantAgentAwaitingConfirmation: false,
    });
    const next = sanitizeImportedAgentConsent(imported);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(true);
    expect(next.localAssistantEnabled).toBe(true);
    expect(next.privateToolsEnabled).toBe(true);
  });

  it("does not treat an imported confirmation marker as a grant", () => {
    const imported = flags(false, false, true, {
      assistantAgentConsentEpoch: 99,
      assistantAgentAwaitingConfirmation: false,
    });
    const next = sanitizeImportedAgentConsent(imported);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(true);
    expect(next.assistantAgentConsentEpoch).toBe(AGENT_CONSENT_EPOCH);
  });

  it("keeps a G=false import from inventing a restore prompt", () => {
    const imported = flags(true, true, false, {
      assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
    });
    const next = sanitizeImportedAgentConsent(imported);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(false);
  });

  it("still offers restore when the payload was already awaiting", () => {
    const imported = flags(true, false, false, {
      assistantAgentAwaitingConfirmation: true,
    });
    const next = sanitizeImportedAgentConsent(imported);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.assistantAgentAwaitingConfirmation).toBe(true);
  });
});

describe("explicit answers", () => {
  it("answer-only sets L and clears G without touching P", () => {
    const patch = grantAnswerOnly();
    expect(patch.localAssistantEnabled).toBe(true);
    expect(patch.assistantAgentToolsEnabled).toBe(false);
    expect("privateToolsEnabled" in patch).toBe(false);
  });

  it("tool proposals set L and G without touching P or auto-approve", () => {
    const patch = grantToolProposals();
    expect(patch.localAssistantEnabled).toBe(true);
    expect(patch.assistantAgentToolsEnabled).toBe(true);
    expect("privateToolsEnabled" in patch).toBe(false);
    expect("assistantAutoApproveReads" in patch).toBe(false);
  });

  it("restore sets only G", () => {
    const patch = restoreToolProposals();
    expect(patch.assistantAgentToolsEnabled).toBe(true);
    expect("localAssistantEnabled" in patch).toBe(false);
    expect("privateToolsEnabled" in patch).toBe(false);
  });

  it("switch to answer-only performs a real G=false transition", () => {
    expect(switchToAnswerOnly().assistantAgentToolsEnabled).toBe(false);
  });

  it("the Settings toggle is an explicit answer, not a fourth stored switch", () => {
    expect(setToolProposalsFromSettings(true).assistantAgentToolsEnabled).toBe(true);
    expect(setToolProposalsFromSettings(false).assistantAgentToolsEnabled).toBe(false);
  });
});
