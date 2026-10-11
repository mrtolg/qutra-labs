//! Stable error codes shared with the renderer.
//!
//! These strings are a contract: the UI maps them to translated copy, so they
//! are never reworded to "improve" a message. Anything the user should be told
//! differently gets a new code, not new text for an old one.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistantError {
    /// The user has not opted in. No request was made.
    Disabled,
    /// Another inference is already running — one at a time by design.
    Busy,
    /// Nothing is listening on the lab endpoint.
    Offline,
    /// The endpoint answered, but does not have the requested model.
    ModelMissing,
    /// The caller passed an empty model name.
    InvalidModel,
    TimeoutHealth,
    TimeoutFirstToken,
    TimeoutTotal,
    /// The turn's shared wall-clock budget (`TURN_TIMEOUT`, ADR 0012 Decision
    /// 4) ran out — model time and human approval time across every step,
    /// combined. Distinct from `TimeoutTotal` (one response overran) and
    /// `ApprovalTimeout` (one pending call sat unanswered): this fires when
    /// the *turn as a whole* has spent its budget, which earlier steps may
    /// have mostly consumed before this one ever started.
    TimeoutTurn,
    /// The user pressed Stop. A normal outcome, not a failure.
    Cancelled,
    /// A proposed tool call sat unanswered past `APPROVAL_TIMEOUT`.
    ApprovalTimeout,
    /// The user pressed Reject on a proposed tool call.
    ApprovalRejected,
    /// Private Lab consent (`consent::PrivateToolsConsent`) is not granted —
    /// never opted in, or revoked mid-session — for the process this agent
    /// tool call would act on. Carries the exact same wire code
    /// `consent.require()` returns to every human tool command
    /// (`consent::CONSENT_REQUIRED`, `"private_tools_consent_required"`), so
    /// the agent path and the human path report identically and the
    /// renderer's existing `private_tools_consent_required` copy
    /// (`src/lib/launch/launchFailureMessage.ts`) already covers it. Not
    /// `Disabled`: `Disabled` means the assistant feature itself is turned
    /// off and no request was even attempted; this can fire after a turn
    /// was already accepted, the moment a side-effecting or `read_context`
    /// tool call actually tries to act.
    ConsentRequired,
    /// The model proposed a tool name outside the closed allowlist.
    UnknownTool,
    /// The listener returned a tool call on a turn that did not offer the
    /// schema (agent tools off, or Private Lab consent missing). Distinct
    /// from `UnknownTool`: the name may be allowlisted, but the call was
    /// never solicited. Must be refused before the approval step (TM-002).
    UnsolicitedTool,
    /// An approved tool call's executor returned an error.
    ToolFailed,
    /// A `launch_tool` call's spawn failed with a permission-denied OS error
    /// -- the target needs administrator elevation this process does not
    /// have. Distinct from `ToolFailed` so the user is told to
    /// elevate rather than shown a generic failure, mirroring the
    /// human-driven `launch_tool_detached` (`lib.rs`), which has always made
    /// this same distinction for the identical failure. Carries the exact
    /// wire code that route already returns (`"elevation_required"`), so both
    /// error maps translate it: `launchFailureMessage.ts` for the human launch
    /// route and `assistantErrorMessage.ts` for an assistant turn.
    ElevationRequired,
    /// The turn proposed more tool calls than `MAX_TOOL_STEPS` allows.
    TooManySteps,
    /// A `terminal_run` call named a `sessionId` this assistant did not open
    /// (ADR 0012 Decision 3, extended to `terminal_run`'s session argument:
    /// "a tool call names an id, never a path" also means the id must resolve
    /// to something *this agent* is authorized to touch, not merely
    /// something that exists). Distinct from `ToolFailed`, which covers a
    /// session that once existed but is now gone or otherwise failed to
    /// execute — this fires before any write is attempted, for a session id
    /// the agent never opened in the first place, including the user's own
    /// hand-opened terminal tabs.
    SessionNotOwned,
    /// The engine refused a request with tools because the selected model's
    /// template does not support tool calling
    /// (`engine_chat::classify_chat_error`). Distinct
    /// from a generic `Http(400)` so the UI can explain the actual cause —
    /// an incompatible model, not a malformed request — rather than showing
    /// the generic upstream-error copy. The exact string is a contract with
    /// the renderer's i18n copy; see `engine_chat.rs` for how this is
    /// distinguished from any other 400.
    ModelToolsUnsupported,
    /// The selected model is a stub for a remote/cloud host (`remote_host`
    /// or `remote_model` on `/api/show`). Until cloud escalation ships,
    /// sending a turn would leave this computer. See Ollama OpenAPI
    /// `ModelSummary.remote_host` / `remote_model`.
    ModelCloudBacked,
    /// A start reused a request id this process already accepted. The
    /// renderer makes a fresh one per turn, so a repeat is a bug or a replay.
    RequestIdReused,
    /// The listener sent more than this crate will hold: an endless line, too
    /// much text or too many tool calls in one step, oversized tool arguments,
    /// or a probe body past its cap (TM-006).
    ResponseTooLarge,
    /// The renderer asked for a turn with more messages or more content than
    /// a start accepts. Refused before any network work.
    RequestTooLarge,
    /// The local engine could not serve the turn (ADR 0016): not
    /// installed, the model needs preparing or is not supported, the engine
    /// failed to start or load, or the conversation outgrew its context.
    /// Carries a fixed code from `local_engine_code`, never free text.
    LocalEngine(String),
    /// Upstream returned a non-success status.
    Http(u16),
    /// Anything unexpected. The detail is deliberately coarse: it is shown to
    /// the user and must never carry a prompt, a path or a token.
    Internal(String),
}

impl AssistantError {
    /// The wire code the frontend switches on.
    pub fn code(&self) -> String {
        match self {
            Self::Disabled => "disabled".into(),
            Self::Busy => "busy".into(),
            Self::Offline => "offline".into(),
            Self::ModelMissing => "model_missing".into(),
            Self::InvalidModel => "invalid_model".into(),
            Self::TimeoutHealth => "timeout_health".into(),
            Self::TimeoutFirstToken => "timeout_first_token".into(),
            Self::TimeoutTotal => "timeout_total".into(),
            Self::TimeoutTurn => "timeout_turn".into(),
            Self::Cancelled => "cancelled".into(),
            Self::ApprovalTimeout => "approval_timeout".into(),
            Self::ApprovalRejected => "approval_rejected".into(),
            Self::ConsentRequired => crate::consent::CONSENT_REQUIRED.into(),
            Self::UnknownTool => "unknown_tool".into(),
            Self::UnsolicitedTool => "unsolicited_tool".into(),
            Self::ToolFailed => "tool_failed".into(),
            // Fixed spelling, matching the launch receipt's reason code
            // (`launch_receipts::spawn_reason`) for
            // the identical OS-level condition.
            Self::ElevationRequired => "elevation_required".into(),
            Self::TooManySteps => "too_many_steps".into(),
            Self::SessionNotOwned => "session_not_owned".into(),
            // Fixed spelling: the UI's six-locale copy for this code is
            // keyed to it.
            Self::ModelToolsUnsupported => "model_tools_unsupported".into(),
            Self::ModelCloudBacked => "model_cloud_backed".into(),
            Self::RequestIdReused => "request_id_reused".into(),
            Self::ResponseTooLarge => "response_too_large".into(),
            Self::RequestTooLarge => "request_too_large".into(),
            Self::LocalEngine(code) => code.clone(),
            Self::Http(status) => format!("http_{status}"),
            Self::Internal(_) => "internal".into(),
        }
    }
}

impl std::fmt::Display for AssistantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code())
    }
}

/// The assistant's code for a local engine failure. A missing model keeps
/// its old code; every other case is named for what the user can do.
pub fn local_engine_code(err: &crate::local_engine::LocalEngineError) -> &'static str {
    use crate::local_engine::LocalEngineError as E;
    match err {
        E::EngineMissing => "engine_missing",
        E::EngineCorrupt => "engine_corrupt",
        E::ModelNotFound => "model_missing",
        E::ModelNeedsPrepare => "model_needs_prepare",
        E::ModelUnsupported { .. } => "model_unsupported",
        E::ModelUnreadable => "model_unreadable",
        E::LoadFailed { reason } if reason == "out_of_memory" => "engine_out_of_memory",
        E::LoadFailed { .. } => "engine_load_failed",
        E::LoadTimeout => "engine_load_timeout",
        E::Busy => "busy",
        E::Cancelled => "cancelled",
        _ => "engine_start_failed",
    }
}

impl From<crate::local_engine::LocalEngineError> for AssistantError {
    fn from(err: crate::local_engine::LocalEngineError) -> Self {
        match local_engine_code(&err) {
            "model_missing" => Self::ModelMissing,
            "busy" => Self::Busy,
            "cancelled" => Self::Cancelled,
            code => Self::LocalEngine(code.into()),
        }
    }
}

/// Tauri commands must return a serializable error; the code is all the
/// renderer needs and all it is trusted with.
impl From<AssistantError> for String {
    fn from(value: AssistantError) -> Self {
        value.code()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_and_snake_case() {
        assert_eq!(AssistantError::Disabled.code(), "disabled");
        assert_eq!(AssistantError::Busy.code(), "busy");
        assert_eq!(AssistantError::ModelMissing.code(), "model_missing");
        assert_eq!(
            AssistantError::TimeoutFirstToken.code(),
            "timeout_first_token"
        );
        assert_eq!(AssistantError::Http(503).code(), "http_503");
        assert_eq!(AssistantError::TimeoutTurn.code(), "timeout_turn");
        assert_eq!(AssistantError::ApprovalTimeout.code(), "approval_timeout");
        assert_eq!(AssistantError::ApprovalRejected.code(), "approval_rejected");
        assert_eq!(
            AssistantError::ConsentRequired.code(),
            crate::consent::CONSENT_REQUIRED
        );
        assert_eq!(AssistantError::UnknownTool.code(), "unknown_tool");
        assert_eq!(AssistantError::UnsolicitedTool.code(), "unsolicited_tool");
        assert_eq!(AssistantError::ToolFailed.code(), "tool_failed");
        // Must match `launch_receipts::spawn_reason`'s literal exactly --
        // both routes report the same OS condition and the renderer's copy
        // is keyed to this spelling.
        assert_eq!(
            AssistantError::ElevationRequired.code(),
            "elevation_required"
        );
        assert_eq!(
            AssistantError::ElevationRequired.code(),
            crate::launch_receipts::spawn_reason(&std::io::Error::from(
                std::io::ErrorKind::PermissionDenied
            ))
        );
        assert_eq!(AssistantError::TooManySteps.code(), "too_many_steps");
        assert_eq!(AssistantError::SessionNotOwned.code(), "session_not_owned");
        // These codes are the keys of the localized copy in the UI; changing
        // a spelling here breaks that copy.
        assert_eq!(
            AssistantError::ModelToolsUnsupported.code(),
            "model_tools_unsupported"
        );
        assert_eq!(
            AssistantError::ModelCloudBacked.code(),
            "model_cloud_backed"
        );
        assert_eq!(AssistantError::RequestIdReused.code(), "request_id_reused");
        assert_eq!(
            AssistantError::ResponseTooLarge.code(),
            "response_too_large"
        );
        assert_eq!(AssistantError::RequestTooLarge.code(), "request_too_large");
    }

    #[test]
    fn local_engine_failures_reach_the_page_as_fixed_codes() {
        use crate::local_engine::LocalEngineError as E;
        let code = |err: E| AssistantError::from(err).code();
        assert_eq!(code(E::EngineMissing), "engine_missing");
        assert_eq!(code(E::ModelNotFound), "model_missing");
        assert_eq!(code(E::ModelNeedsPrepare), "model_needs_prepare");
        assert_eq!(
            code(E::ModelUnsupported {
                architecture: "x".into()
            }),
            "model_unsupported"
        );
        assert_eq!(
            code(E::LoadFailed {
                reason: "out_of_memory".into()
            }),
            "engine_out_of_memory"
        );
        assert_eq!(
            code(E::LoadFailed {
                reason: "tensor_count".into()
            }),
            "engine_load_failed"
        );
        assert_eq!(code(E::LoadTimeout), "engine_load_timeout");
        assert_eq!(code(E::Cancelled), "cancelled");
        assert_eq!(code(E::StartFailed), "engine_start_failed");
    }

    #[test]
    fn internal_detail_never_reaches_the_wire_code() {
        // The detail may hold a low-level message; the code the UI sees must not.
        let err = AssistantError::Internal("connect to C:\\secret\\path failed".into());
        assert_eq!(err.code(), "internal");
        assert!(!err.code().contains("secret"));
    }
}
