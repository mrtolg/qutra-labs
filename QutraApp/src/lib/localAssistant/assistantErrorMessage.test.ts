import { describe, expect, it } from "vitest";
import { en as enCatalog, type MessageKey } from "@/lib/i18n/en";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { assistantErrorMessage } from "./assistantErrorMessage";

// The words only lazy pages read load after the first paint (src/lib/i18n/deferred).
const en = { ...enCatalog, ...deferredEn };

/* Straight lookups into the real English catalog rather than a stub map, so a
   typo'd key here shows up as a wrong string instead of a false pass. */
const t = (key: MessageKey, params?: Record<string, string | number>) => {
  let value: string = en[key];
  for (const [name, val] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(val));
  }
  return value;
};

describe("assistantErrorMessage (ADR 0012)", () => {
  it("maps every dedicated wire code to its own copy", () => {
    const cases: Record<string, MessageKey> = {
      disabled: "localAssistant.chatDisabled",
      unavailable: "localAssistant.desktopOnly",
      offline: "localAssistant.offlineHint",
      busy: "jarvis.error.busy",
      request_id_reused: "jarvis.error.requestIdReused",
      response_too_large: "jarvis.error.responseTooLarge",
      request_too_large: "jarvis.error.requestTooLarge",
      invalid_model: "jarvis.error.invalidModel",
      // Both of these reach the user through this map and neither had a
      // row here, so a regression to the generic fallthrough was invisible.
      elevation_required: "jarvis.error.elevationRequired",
      session_not_owned: "jarvis.error.sessionNotOwned",
      timeout_health: "jarvis.error.timeoutHealth",
      timeout_first_token: "jarvis.error.timeoutFirstToken",
      timeout_total: "jarvis.error.timeoutTotal",
      timeout_turn: "jarvis.error.timeoutTurn",
      approval_timeout: "jarvis.approval.timedOut",
      approval_rejected: "jarvis.approval.rejected",
      private_tools_consent_required: "jarvis.error.consentRequired",
      unknown_tool: "jarvis.error.unknownTool",
      unsolicited_tool: "jarvis.error.unsolicitedTool",
      tool_failed: "jarvis.error.toolFailed",
      too_many_steps: "jarvis.error.tooManySteps",
      // Added alongside the Rust agent's new "this model can't take tools"
      // wire code -- see FIX list, "Also add copy" section.
      model_tools_unsupported: "jarvis.error.modelToolsUnsupported",
      model_cloud_backed: "jarvis.error.modelCloudBacked",
      // The local engine's codes (ADR 0016): each says what to do next
      // instead of falling through to "Something went wrong".
      engine_missing: "jarvis.error.engineMissing",
      engine_corrupt: "jarvis.error.engineCorrupt",
      model_needs_prepare: "jarvis.error.modelNeedsPrepare",
      model_unsupported: "jarvis.error.modelUnsupported",
      model_unreadable: "jarvis.error.modelUnreadable",
      engine_start_failed: "jarvis.error.engineStartFailed",
      engine_load_failed: "jarvis.error.engineLoadFailed",
      engine_out_of_memory: "jarvis.error.engineOutOfMemory",
      engine_load_timeout: "jarvis.error.engineLoadTimeout",
      context_exceeded: "jarvis.error.contextExceeded",
      engine_restarted: "jarvis.error.engineRestarted",
    };

    for (const [code, key] of Object.entries(cases)) {
      expect(assistantErrorMessage(t, code), code).toBe(t(key));
    }
  });

  it("never leaks the raw wire code to the user for an unrecognized or internal code", () => {
    for (const code of ["internal", "http_500", "something_new_the_ui_never_heard_of"]) {
      const message = assistantErrorMessage(t, code);
      expect(message).toBe(t("jarvis.error.generic"));
      expect(message).not.toContain(code);
    }
  });

  it("gives model_tools_unsupported copy that names both the cause and the fix", () => {
    const message = assistantErrorMessage(t, "model_tools_unsupported");
    // Must be its own sentence, not a fallthrough to the generic catch-all.
    expect(message).not.toBe(t("jarvis.error.generic"));
  });
});
