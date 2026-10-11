import type { MessageKey } from "@/lib/i18n/en";

/* ============================================================
   Assistant error code -> translated copy (ADR 0012).

   `AssistantError` (`src-tauri/src/assistant/error.rs`) is a closed set of
   wire codes shared with the renderer; this is the one place that turns one
   of those codes into a sentence a user reads. It exists because it did not
   before: `LocalAssistantChat`'s catch block used to stringify whatever
   `Error` it caught and show the same static "start the isolated server"
   hint regardless of what actually went wrong, so `approval_rejected` and
   `timeout_health` and everything else all looked identical to the user.

   Mirrors the shape of `src/lib/launch/launchFailureMessage.ts` (a `code ->
   MessageKey` switch with a translated fallback) but is NOT that map and does
   not reuse it: the launch map takes a tool `name` and covers the *launch*
   refusal codes (`tool_disabled`, `tool_identity_changed`, ...) returned by
   `resolve_launchable`. This one covers the *assistant turn* codes returned
   by `assistant_start`/the `assistant://stream` `error` event, and none of
   those carry a tool name to interpolate -- the wire event has no such field
   (`AssistantStreamEvent` only ever carries `summary`, already prose).

   Codes that already have dedicated copy elsewhere are reused rather than
   duplicated, per the same instinct as `launchFailureMessage`'s fallback:
   one sentence per meaning, not one sentence per call site.
     - `disabled` / `unavailable` / `offline` / `model_missing` reuse the
       existing chat and settings copy (`localAssistant.*`).
     - `approval_timeout` / `approval_rejected` reuse the approval card's own
       `jarvis.approval.timedOut` / `jarvis.approval.rejected` -- the same
       words a user watching the card already saw apply here too.
   `cancelled` is not a case here: the client resolves (not rejects) the
   turn's promise on `cancelled`, so it never reaches a caller of this
   function -- Stop is a normal outcome, not an error to explain.

   `http_<status>` is dynamic (one entry per upstream status code) and
   `internal` is deliberately coarse (the Rust side never puts a path, a
   prompt or a token in it) -- both fall through to the generic message
   rather than getting per-code copy. That generic case also covers the
   newline rejection in `terminal_run`: it is re-checked at the point the PTY
   write happens and surfaces as the same wire code `internal`, so it cannot
   get a distinct message without inventing a new Rust code for it, which is
   out of scope here. */
export function assistantErrorMessage(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  code: string,
): string {
  switch (code) {
    case "disabled":
      return t("localAssistant.chatDisabled");
    case "unavailable":
      return t("localAssistant.desktopOnly");
    case "offline":
      return t("localAssistant.offlineHint");
    case "model_missing":
      return t("localAssistant.modelMissingHint");
    case "busy":
      return t("jarvis.error.busy");
    case "request_id_reused":
      return t("jarvis.error.requestIdReused");
    // Byte budgets (TM-006): the listener sent more than one step keeps,
    // or the renderer asked to send more than a start accepts.
    case "response_too_large":
      return t("jarvis.error.responseTooLarge");
    case "request_too_large":
      return t("jarvis.error.requestTooLarge");
    case "invalid_model":
      return t("jarvis.error.invalidModel");
    case "timeout_health":
      return t("jarvis.error.timeoutHealth");
    case "timeout_first_token":
      return t("jarvis.error.timeoutFirstToken");
    case "timeout_total":
      return t("jarvis.error.timeoutTotal");
    case "timeout_turn":
      return t("jarvis.error.timeoutTurn");
    case "approval_timeout":
      return t("jarvis.approval.timedOut");
    case "approval_rejected":
      return t("jarvis.approval.rejected");
    case "private_tools_consent_required":
      return t("jarvis.error.consentRequired");
    case "unknown_tool":
      return t("jarvis.error.unknownTool");
    case "unsolicited_tool":
      return t("jarvis.error.unsolicitedTool");
    case "tool_failed":
      return t("jarvis.error.toolFailed");
    // The selected model has no chat template support for tool calling, so
    // Ollama 400s the instant a `tools` array is attached to the request.
    // Distinct from `tool_failed` (an approved call that ran and errored):
    // here nothing was ever proposed -- the model can't be sent tools at
    // all, so the fix is a different model or turning the agent off.
    case "model_tools_unsupported":
      return t("jarvis.error.modelToolsUnsupported");
    case "model_cloud_backed":
      return t("jarvis.error.modelCloudBacked");
    // Qutra's local engine (ADR 0016): fixed codes from Rust's
    // `local_engine_code` and `engine_chat`, each with its own next step.
    case "engine_missing":
      return t("jarvis.error.engineMissing");
    case "engine_corrupt":
      return t("jarvis.error.engineCorrupt");
    case "model_needs_prepare":
      return t("jarvis.error.modelNeedsPrepare");
    case "model_unsupported":
      return t("jarvis.error.modelUnsupported");
    case "model_unreadable":
      return t("jarvis.error.modelUnreadable");
    case "engine_start_failed":
      return t("jarvis.error.engineStartFailed");
    case "engine_load_failed":
      return t("jarvis.error.engineLoadFailed");
    case "engine_out_of_memory":
      return t("jarvis.error.engineOutOfMemory");
    case "engine_load_timeout":
      return t("jarvis.error.engineLoadTimeout");
    case "context_exceeded":
      return t("jarvis.error.contextExceeded");
    case "engine_restarted":
      return t("jarvis.error.engineRestarted");
    // The approved launch needs elevation. The human-driven launch route has
    // always distinguished this; the agent route collapsed it into a generic
    // failure, which sent the user looking for the wrong problem.
    case "elevation_required":
      return t("jarvis.error.elevationRequired");
    // The model named a terminal session the assistant did not open -- one of
    // the user's own shells, or one it opened earlier that has since closed.
    // Refusing is the point: the agent may only write to terminals it created.
    case "session_not_owned":
      return t("jarvis.error.sessionNotOwned");
    case "too_many_steps":
      return t("jarvis.error.tooManySteps");
    default:
      // Covers `internal`, every `http_<status>`, and anything unrecognized.
      // Never the raw code itself -- a user must not see a wire identifier.
      return t("jarvis.error.generic");
  }
}
