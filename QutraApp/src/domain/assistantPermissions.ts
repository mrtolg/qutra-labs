/* ============================================================
   Risk-surface vocabulary for the tool-using assistant (ADR 0012).

   ADR 0012 (docs/decisions/0012-agentic-assistant.md) is the explicit,
   reviewed decision that crossed the boundary this file used to guard as a
   design skeleton. The skeleton's four preconditions — a visible summary of
   the exact action, explicit per-action approval, a working cancel, and a
   local action log — are now enforced by running Rust code, not by anything
   in this file or by a TypeScript mirror of it:

   - **A visible summary of the exact action** — built server-side from the
     *parsed* call by `AgentTool::summary()` / `summary_for_approval()` in
     `src-tauri/src/assistant/tools.rs`, and rendered verbatim (no markup) by
     the approval card. There is no TypeScript-side renderer of this summary
     — the UI displays the string the Rust broker sends over the wire.
   - **Explicit per-action approval** — `requires_approval()` and
     `assistant_approve_tool` in `src-tauri/src/assistant/commands.rs` decide
     whether a call needs a decision at all; `AssistantState::await_approval`
     / `resolve_approval` and the `ApprovalDecision` enum in
     `src-tauri/src/assistant/broker.rs` hold the call open until one arrives,
     matching on both `requestId` and `callId` so a stale card can never
     resolve the call that replaced it.
   - **A working cancel** — `assistant_cancel` in `commands.rs` and
     `AssistantState::cancel` in `broker.rs`: cancelling a turn drops the
     pending approval sender so a call waiting on a decision wakes up as
     `cancelled` instead of hanging.
   - **A local action log** — `AuditLog::record` / `entries` in
     `src-tauri/src/assistant/audit.rs`, on that module's existing
     shape-not-content terms.

   This file previously also held a hand-synced TypeScript copy of that
   contract — `AssistantPermissionGate`, `ProposedAssistantAction`,
   `AssistantActionDecision`, `AssistantActionLogEntry`, and
   `ASSISTANT_ACTIONS_ENABLED` — plus a sibling module, `assistantTools.ts`,
   that mirrored the Rust tool allowlist and its approval-summary formatting
   (`describeToolCall`, its tokenizer, `agentToolSchemaJson`). Three
   executors and the agent loop were built directly against the Rust types
   above; none of them were built against that TypeScript copy, which stayed
   imported by nothing but its own tests. A duplicate of a security
   allowlist that nothing runs is not a safety net, it is a drift risk: it
   can silently fall out of sync with the Rust original and gives a future
   reader the false impression that the renderer enforces something it does
   not. Both were deleted; `AssistantActionKind` below is the only piece
   that survived, kept as a plain vocabulary list rather than as a claimed
   contract.

   The standing rule stays in force regardless of what implements any of
   this: adding a *new* action kind (beyond `terminal_run`, `launch_tool`,
   `read_context`) is still a decision that needs its own ADR, not a quiet
   extension of an existing one.
   ============================================================ */

/** Categories the tool-using assistant's action surface falls into. Enumerated
    here — independent of any single implementation — so the risk surface is
    named in one place rather than left implicit in whichever code happens to
    branch on it. Has no implementer in TypeScript; the Rust side (see the
    module header above) is what actually gates and logs by these terms. */
export type AssistantActionKind =
  | "read_file"
  | "write_file"
  | "run_command"
  | "network_request"
  | "clipboard_write";
