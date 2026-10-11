//! Orchestration: one inference at a time, hard deadlines, real cancellation.
//!
//! The renderer can ask for things; this decides whether they happen. Every
//! rule that used to live in the UI (or nowhere) is enforced here, because a
//! webview is not a trust boundary.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;

use super::{audit::AuditLog, error::AssistantError, tools::ApprovalAction};
use crate::ai::web::WebSource;

/// Event payload pushed to the renderer on `assistant://stream`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub request_id: String,
    /// `token` | `status` | `done` | `error` | `tool_call` | `tool_result` | `bound` | `web_sources`
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The id of the proposed/executed tool call. Present on `tool_call` and
    /// `tool_result` events so the renderer can match a result back to the
    /// card it rendered for the call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// A human-readable, server-built description of the call or its
    /// outcome. Built from the parsed call, never from model prose verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The PTY session id a `terminal_run` call acted on (new or existing),
    /// present only on `tool_result`. A structured field, not text embedded
    /// in `summary`, so the renderer can link the result back to a terminal
    /// tab by parsing JSON rather than the result prose (the session id used
    /// to arrive only inside a sentence like "Sent to terminal session {id}").
    /// `None` for every other tool and
    /// for every other event kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// On `bound` only: the origin this turn is sent to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// On `bound` only: the model this turn is bound to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// On `tool_call` only: the proposed action as facts (data contracts §2), so the
    /// card shows the exact command without parsing `summary`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ApprovalAction>,
    /// On `web_sources` only: the pages the internet step read for this
    /// turn. Addresses Rust fetched, never text from the model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<WebSource>>,
}

impl StreamEvent {
    /// The pages read for a turn that has the internet on.
    pub fn web_sources(request_id: &str, sources: Vec<WebSource>) -> Self {
        Self {
            kind: "web_sources".into(),
            sources: Some(sources),
            ..Self::done(request_id)
        }
    }

    pub fn token(request_id: &str, text: String) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "token".into(),
            text: Some(text),
            status: None,
            message: None,
            call_id: None,
            summary: None,
            session_id: None,
            endpoint: None,
            model: None,
            action: None,
            sources: None,
        }
    }
    pub fn status(request_id: &str, status: &str) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "status".into(),
            text: None,
            status: Some(status.into()),
            message: None,
            call_id: None,
            summary: None,
            session_id: None,
            endpoint: None,
            model: None,
            action: None,
            sources: None,
        }
    }
    pub fn done(request_id: &str) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "done".into(),
            text: None,
            status: None,
            message: None,
            call_id: None,
            summary: None,
            session_id: None,
            endpoint: None,
            model: None,
            action: None,
            sources: None,
        }
    }
    pub fn error(request_id: &str, code: String) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "error".into(),
            text: None,
            status: None,
            message: Some(code),
            call_id: None,
            summary: None,
            session_id: None,
            endpoint: None,
            model: None,
            action: None,
            sources: None,
        }
    }
    /// A proposed tool call, awaiting approval. `tool` names which of the
    /// allowlisted tools was proposed; `summary` is the server-built,
    /// plain-text description of the exact action (never model prose).
    pub fn tool_call(
        request_id: &str,
        call_id: &str,
        tool: &str,
        summary: &str,
        action: ApprovalAction,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "tool_call".into(),
            text: None,
            status: Some(tool.into()),
            message: None,
            call_id: Some(call_id.into()),
            summary: Some(summary.into()),
            session_id: None,
            endpoint: None,
            model: None,
            action: Some(action),
            sources: None,
        }
    }
    /// The outcome of an executed tool call. `session_id` is `Some` only for
    /// a `terminal_run` call, carrying the PTY session id it acted on (new
    /// or existing) as a structured field — see the doc comment on
    /// `StreamEvent::session_id`. `None` for every other tool.
    pub fn tool_result_with_session(
        request_id: &str,
        call_id: &str,
        summary: &str,
        session_id: Option<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "tool_result".into(),
            text: None,
            status: None,
            message: None,
            call_id: Some(call_id.into()),
            summary: Some(summary.into()),
            session_id,
            endpoint: None,
            model: None,
            action: None,
            sources: None,
        }
    }
    /// Where this turn's conversation is being sent: the origin and model
    /// `bind_turn` fixed for the whole turn. Emitted once, before any token,
    /// because the health panel's endpoint is the answer to an earlier probe
    /// and may already be stale (security review #2).
    pub fn bound(request_id: &str, endpoint: &str, model: &str) -> Self {
        Self {
            request_id: request_id.into(),
            kind: "bound".into(),
            text: None,
            status: None,
            message: None,
            call_id: None,
            summary: None,
            session_id: None,
            endpoint: Some(endpoint.into()),
            model: Some(model.into()),
            action: None,
            sources: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub request_id: String,
    pub enabled: bool,
    pub model: String,
    pub context_tokens: u32,
    pub messages: Vec<super::engine_chat::ChatMessage>,
    /// Opt-in preference (ADR 0012, Decision 2), passed per turn from the
    /// renderer rather than read from a preference file in Rust — so this is
    /// a value on the request, not a global a side-effecting path could ever
    /// consult. It may only ever *weaken* the approval gate for
    /// `read_context`; `commands::requires_approval` asserts, in code, that
    /// it can never affect a side-effecting tool (`terminal_run`,
    /// `launch_tool`). `#[serde(default)]` so a caller that predates this
    /// field gets the safe default (`false`, i.e. still gated).
    #[serde(default)]
    pub auto_approve_reads: bool,
    /// Opt-in preference for the agent itself (following ADR 0012's
    /// approval machinery): whether *this turn's* renderer asked for the
    /// model to be offered tools at all. ADR 0010 promised the local
    /// assistant would "answer only" by default; ADR 0012 built the
    /// approval-gated exception to that but never gated it behind a switch,
    /// so every turn silently became tool-using the moment tool calling shipped
    /// — including for a user who never consented to Private Lab, for whom
    /// every tool-proposing turn used to die outright (`ConsentRequired` ends
    /// the whole turn, `read_context` included) with no way to make the model
    /// stop proposing. Passed per turn from the renderer, exactly like
    /// `auto_approve_reads`, rather than read from a preference file here —
    /// so, like that field, it is a value on the request, never a global a
    /// side-effecting path could consult on its own. `#[serde(default)]` so a
    /// caller that predates this field gets the safe default (`false`, i.e.
    /// answer-only, matching the pre-agent behavior exactly). This alone does
    /// not turn tools on: `commands::agent_tools_should_be_offered` also
    /// requires Private Lab consent to be currently granted — see that
    /// function for the conjunction and why either flag alone must not be
    /// enough.
    #[serde(default)]
    pub agent_tools_enabled: bool,
    /// The conversation's "İnternet" switch. Off unless the page says so.
    /// Turns on a search-then-answer step in Rust (`commands::add_web`); the
    /// model itself still gets no network and no new tool.
    #[serde(default)]
    pub web_access: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Rust's own identity for an accepted turn. The renderer's request id stays
/// a correlation label for stream events; the slot and the pending approval
/// are owned by this nonce, so a late `finish` of an old turn can never clear
/// a newer one, whatever request id either of them carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnNonce(u64);

/// Most messages a start may carry. The renderer keeps 50 and adds a context
/// message; four times that is a caller that is not the chat surface.
pub const MAX_START_MESSAGES: usize = 200;

/// Most message content, in bytes, a start may carry. Several times the
/// packed context plus a long conversation; it bounds what a renderer can
/// make Rust hold and forward before any network work starts.
pub const MAX_START_CONTENT_BYTES: usize = 2 * 1024 * 1024;

/// A held slot, returned by `try_reserve` and consumed by `attach`.
#[derive(Debug)]
pub struct Reservation {
    pub nonce: TurnNonce,
}

/// How many recent request ids `try_reserve` remembers in order to refuse a
/// reuse. The renderer makes a fresh UUID per turn, so a repeat is a bug or
/// a replay; 256 covers far more turns than one session runs between
/// restarts while keeping the set's memory fixed.
const RECENT_REQUEST_IDS: usize = 256;

/// The in-flight turn, if any. `handle` is `None` between `try_reserve` and
/// `attach`; the slot is already taken then, so no second start can pass.
struct Active {
    request_id: String,
    nonce: TurnNonce,
    handle: Option<JoinHandle<()>>,
}

/// How long a proposed tool call may sit unanswered. An indefinite pause would
/// hold the single-flight slot forever and leave the user with an assistant
/// that is silently "busy" with nothing to show for it.
pub const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The human's decision on a proposed tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Rejected,
}

/// A tool call awaiting a human decision. Both ids must match on resolution —
/// a stale card left over from a previous turn must never resolve the call
/// that replaced it.
struct Pending {
    request_id: String,
    nonce: TurnNonce,
    call_id: String,
    tx: tokio::sync::oneshot::Sender<ApprovalDecision>,
}

#[derive(Default)]
pub struct AssistantState {
    active: Mutex<Option<Active>>,
    pending: Mutex<Option<Pending>>,
    /// Lock order: taken only while `active` is held, never the other way.
    recent_request_ids: Mutex<VecDeque<String>>,
    next_nonce: AtomicU64,
    pub audit: AuditLog,
    /// Terminal PTY session ids this assistant itself opened (ADR
    /// 0012 Decision 3 extended to `terminal_run`'s session argument). A
    /// user's own hand-opened terminal tab is never a member, no matter how
    /// its id reaches the model's context — the whole point of the fix is
    /// that "the model can name an id" must not mean "the model can act on
    /// any id". `terminal::commands::terminal_close`/`_close_all`
    /// evicts a member as soon as its session closes, via
    /// `forget_agent_session`/`forget_all_agent_sessions` below.
    agent_sessions: Mutex<HashSet<String>>,
}

impl AssistantState {
    /// Validate a start request and take the slot, under one lock, before any
    /// network work happens. Checking busy and storing the handle as two
    /// steps let two concurrent starts both pass, and the second store then
    /// orphaned the first turn's handle where Stop could no longer reach it.
    ///
    /// Order matters: the opt-in is checked first, so a disabled assistant with
    /// an otherwise valid request still reports `disabled` and never reaches
    /// the endpoint.
    pub fn try_reserve(&self, request: &StartRequest) -> Result<Reservation, AssistantError> {
        if !request.enabled {
            return Err(AssistantError::Disabled);
        }
        if request.model.trim().is_empty() {
            return Err(AssistantError::InvalidModel);
        }
        let content_bytes: usize = request.messages.iter().map(|m| m.content.len()).sum();
        if request.messages.len() > MAX_START_MESSAGES || content_bytes > MAX_START_CONTENT_BYTES {
            return Err(AssistantError::RequestTooLarge);
        }
        let mut active = self.lock();
        if active.is_some() {
            // One inference at a time. A second start is refused rather than
            // queued: queueing would let a user stack work they cannot see.
            return Err(AssistantError::Busy);
        }
        let mut recent = self.recent_lock();
        if recent.iter().any(|id| *id == request.request_id) {
            return Err(AssistantError::RequestIdReused);
        }
        if recent.len() == RECENT_REQUEST_IDS {
            recent.pop_front();
        }
        recent.push_back(request.request_id.clone());
        drop(recent);

        let nonce = TurnNonce(self.next_nonce.fetch_add(1, Ordering::Relaxed));
        *active = Some(Active {
            request_id: request.request_id.clone(),
            nonce,
            handle: None,
        });
        Ok(Reservation { nonce })
    }

    /// Give the reserved slot its task handle. If the turn was cancelled (or
    /// already finished) between `try_reserve` and here, the slot no longer
    /// holds this nonce and the handle is aborted at once.
    pub fn attach(&self, reservation: Reservation, handle: JoinHandle<()>) {
        let mut active = self.lock();
        match active.as_mut() {
            Some(slot) if slot.nonce == reservation.nonce => slot.handle = Some(handle),
            _ => handle.abort(),
        }
    }

    #[cfg(test)]
    pub fn is_busy(&self) -> bool {
        self.lock().is_some()
    }

    #[cfg(test)]
    pub fn active_request_id(&self) -> Option<String> {
        self.lock().as_ref().map(|a| a.request_id.clone())
    }

    /// The pending call id, for tests that must distinguish "the slot was
    /// cleared" from "the send failed" -- `resolve_approval` returns false in
    /// both cases, so it cannot tell them apart.
    #[cfg(test)]
    pub fn pending_call_id(&self) -> Option<String> {
        self.pending_lock().as_ref().map(|p| p.call_id.clone())
    }

    /// Clear the slot, but only if it still holds this turn — a late
    /// finisher must not wipe a newer turn that already started. The same
    /// guard applies to a pending approval: a late finisher for a turn that
    /// has already been replaced must not drop the newer turn's waiter.
    pub fn finish(&self, nonce: TurnNonce) {
        let mut guard = self.lock();
        if guard.as_ref().is_some_and(|a| a.nonce == nonce) {
            *guard = None;
        }
        drop(guard);
        self.drop_pending_of(nonce);
    }

    /// Abort the in-flight turn the renderer knows as `request_id`. Returns
    /// whether anything was actually stopped. The request id only finds the
    /// turn; what is aborted and cleared is matched on that turn's nonce.
    ///
    /// Also drops any pending approval belonging to this turn, so a turn
    /// waiting on a human decision wakes with a receive error instead of
    /// blocking until `APPROVAL_TIMEOUT` — a Stop button that only worked
    /// while tokens were streaming would be a lie at exactly the moment it
    /// matters most, the instant before a side effect.
    pub fn cancel(&self, request_id: &str) -> bool {
        let mut guard = self.lock();
        let nonce = match guard.as_ref() {
            Some(active) if active.request_id == request_id => active.nonce,
            _ => return false,
        };
        if let Some(handle) = guard.take().and_then(|a| a.handle) {
            handle.abort();
        }
        drop(guard);
        self.drop_pending_of(nonce);
        true
    }

    fn drop_pending_of(&self, nonce: TurnNonce) {
        let mut pending = self.pending_lock();
        if pending.as_ref().is_some_and(|p| p.nonce == nonce) {
            // Dropping the sender is what wakes the waiter with a RecvError.
            *pending = None;
        }
    }

    /// Drop a pending approval without aborting the turn task.
    ///
    /// Private Lab revoke uses this so a card that was already showing can
    /// never be approved, including after a later regrant. Dropping the
    /// sender wakes `await_approval` with `Cancelled`.
    pub fn drop_pending_approval(&self) {
        *self.pending_lock() = None;
    }

    /// Cancel whichever turn currently owns the slot, if any. Used when a new
    /// renderer loads and the previous webview's work must not keep running.
    pub fn cancel_active(&self) -> Option<String> {
        let id = self.lock().as_ref().map(|a| a.request_id.clone());
        if let Some(ref id) = id {
            self.cancel(id);
        }
        id
    }

    /// Register a pending approval for `call_id` within turn `request_id`,
    /// returning the receiver the turn awaits. Replaces any prior pending
    /// entry (single-flight: at most one turn, at most one pending call).
    ///
    /// Private: the only non-test caller is `await_approval`, which wraps the
    /// receiver in the `APPROVAL_TIMEOUT` deadline before anyone can await it.
    /// A `pub` building block here would let a future caller `rx.await`
    /// directly and skip the deadline — exactly the failure mode this type
    /// exists to rule out. Kept as a separate step (rather than folded into
    /// `await_approval`) only so the resolve-approval tests can drive the
    /// pending slot without going through the timeout machinery.
    fn begin_approval(
        &self,
        request_id: &str,
        nonce: TurnNonce,
        call_id: &str,
    ) -> tokio::sync::oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.pending_lock() = Some(Pending {
            request_id: request_id.into(),
            nonce,
            call_id: call_id.into(),
            tx,
        });
        rx
    }

    /// Register the pending entry and await the human's decision, enforcing
    /// `APPROVAL_TIMEOUT` here rather than leaving it to the caller. A later
    /// author who wrote `begin_approval(..).await` directly would reproduce
    /// the indefinite-pause bug `APPROVAL_TIMEOUT` exists to prevent, with
    /// nothing in the type system to catch the omission — so the deadline
    /// lives in the one place that can't be skipped.
    ///
    /// No mutex guard is held across the `.await`: `begin_approval` takes and
    /// releases `pending_lock` synchronously before this method ever awaits,
    /// and the timeout-clearing branch below takes it again, separately,
    /// after the await resolves.
    pub async fn await_approval(
        &self,
        request_id: &str,
        nonce: TurnNonce,
        call_id: &str,
    ) -> Result<ApprovalDecision, AssistantError> {
        let rx = self.begin_approval(request_id, nonce, call_id);
        match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(decision)) => Ok(decision),
            // The sender was dropped without sending — `cancel` released us.
            Ok(Err(_)) => Err(AssistantError::Cancelled),
            Err(_) => {
                // Deadline elapsed. Clear the slot only if it is still ours:
                // a `resolve_approval` or a newer turn's `begin_approval` may
                // have already taken it, and this arm must not disturb that.
                let mut pending = self.pending_lock();
                if pending
                    .as_ref()
                    .is_some_and(|p| p.nonce == nonce && p.call_id == call_id)
                {
                    *pending = None;
                }
                Err(AssistantError::ApprovalTimeout)
            }
        }
    }

    /// Deliver a human decision to the waiting turn. Returns whether the
    /// decision was actually handed to a live waiter — `false` covers both a
    /// ***stale card***: `request_id`/`call_id` don't match the pending entry
    /// (a card left over from a turn that has since been replaced), and a
    /// ***dead waiter***: the ids match, but the receiver was already dropped
    /// (e.g. the turn was cancelled or timed out) before this call landed. A
    /// command layer that reports "approved" to the UI on a `true` here is
    /// reporting a decision that actually reached a turn, not merely one that
    /// matched an id.
    ///
    /// A mismatch never disturbs the real pending entry, in either case: the
    /// entry is taken and, if it doesn't match, put back untouched.
    ///
    /// Invoked from the `assistant_approve_tool` command (`commands.rs`).
    pub fn resolve_approval(
        &self,
        request_id: &str,
        call_id: &str,
        decision: ApprovalDecision,
    ) -> bool {
        let mut guard = self.pending_lock();
        match guard.take() {
            Some(pending) if pending.request_id == request_id && pending.call_id == call_id => {
                // `send` fails if the receiver was already dropped (cancelled
                // or timed out) — that is not a delivered decision.
                pending.tx.send(decision).is_ok()
            }
            Some(other) => {
                // Didn't match: leave the real pending entry in place so the
                // genuine waiter is unaffected by a stale resolution attempt.
                *guard = Some(other);
                false
            }
            None => false,
        }
    }

    /// Record that this assistant just opened `id` as a `terminal_run`
    /// session (a fresh default shell, because the model did not name an
    /// existing one). Called once, right after `terminal_open` succeeds, so
    /// a subsequent call in the same or a later turn that names this id back
    /// (the only way the model can currently learn it — see `owns_session`)
    /// is recognized as the agent's own session, not refused.
    pub fn note_agent_session(&self, id: &str) {
        self.agent_sessions_lock().insert(id.to_string());
    }

    /// Whether `id` is a terminal session this assistant itself opened.
    /// `terminal_run`'s only legitimate use of an existing `sessionId` is one
    /// the tool itself handed back in an earlier step's result — never a
    /// session the user opened by hand from the terminal UI, and never one
    /// merely guessed or read out of some other context. Called by
    /// `tools::execute_terminal_run` before writing to an existing session.
    pub fn owns_agent_session(&self, id: &str) -> bool {
        self.agent_sessions_lock().contains(id)
    }

    /// Evict `id` from the ownership set. Called from
    /// `terminal::commands::terminal_close` right after
    /// `TerminalSessions::close` succeeds, so a closed session's id stops
    /// being a member the instant it stops being a live session — not
    /// because leaving it were unsafe (session ids are UUIDv4, so a stale
    /// entry could never later name a *different* session; it would just
    /// name one that no longer exists, which `TerminalSessions::write`
    /// already reports as `unknown_session`, mapped to
    /// `AssistantError::ToolFailed`), but so the set does not grow for the
    /// life of the process and a `terminal_run` naming a since-closed id gets
    /// the more precise `SessionNotOwned` refusal instead of a generic
    /// `ToolFailed` from a doomed PTY write. Removing an id that was never a
    /// member (the user's own session, or one already evicted) is a no-op,
    /// matching `TerminalSessions::close`'s own idempotence.
    pub fn forget_agent_session(&self, id: &str) {
        self.agent_sessions_lock().remove(id);
    }

    /// Evict every currently-tracked id. Called from
    /// `terminal::commands::terminal_close_all` for the same reason
    /// `forget_agent_session` is called from `terminal_close`: every session
    /// that command just closed no longer exists, agent-opened or not.
    pub fn forget_all_agent_sessions(&self) {
        self.agent_sessions_lock().clear();
    }

    fn agent_sessions_lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        match self.agent_sessions.lock() {
            Ok(guard) => guard,
            // Same reasoning as `lock()`/`pending_lock()`: recovering from a
            // poisoned mutex is strictly better than wedging every future
            // `terminal_run` call behind a permanently poisoned gate.
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Active>> {
        match self.active.lock() {
            Ok(guard) => guard,
            // Losing the slot to a panic would wedge the assistant as
            // permanently "busy"; recovering is strictly better.
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn pending_lock(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        match self.pending.lock() {
            Ok(guard) => guard,
            // Same reasoning as `lock()`: losing the pending slot to a panic
            // would strand a waiting turn until `APPROVAL_TIMEOUT`; recovering
            // is strictly better.
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn recent_lock(&self) -> std::sync::MutexGuard<'_, VecDeque<String>> {
        match self.recent_request_ids.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with_id(request_id: &str, enabled: bool, model: &str) -> StartRequest {
        StartRequest {
            request_id: request_id.into(),
            enabled,
            model: model.into(),
            context_tokens: 4096,
            messages: vec![],
            auto_approve_reads: false,
            agent_tools_enabled: false,
            web_access: false,
        }
    }

    fn request(enabled: bool, model: &str) -> StartRequest {
        request_with_id("r1", enabled, model)
    }

    fn sleeper() -> JoinHandle<()> {
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        })
    }

    /// Reserve and attach a long-running turn, as `assistant_start` does.
    fn start(state: &AssistantState, request_id: &str) -> TurnNonce {
        let reservation = state
            .try_reserve(&request_with_id(request_id, true, "m"))
            .unwrap();
        let nonce = reservation.nonce;
        state.attach(reservation, sleeper());
        nonce
    }

    #[test]
    fn refuses_while_disabled_before_anything_else() {
        let state = AssistantState::default();
        // Disabled wins even though the model is also invalid: no path may
        // reach the endpoint by fixing the model while the feature is off.
        let err = state.try_reserve(&request(false, "")).unwrap_err();
        assert_eq!(err.code(), "disabled");
        assert!(!state.is_busy());
    }

    #[test]
    fn refuses_an_empty_model() {
        let state = AssistantState::default();
        let err = state.try_reserve(&request(true, "   ")).unwrap_err();
        assert_eq!(err.code(), "invalid_model");
        assert!(!state.is_busy());
    }

    #[test]
    fn a_valid_request_reserves_the_slot_at_once() {
        let state = AssistantState::default();
        state.try_reserve(&request(true, "m")).unwrap();
        // Busy before any handle is attached: the gap is what used to let a
        // second start through.
        assert!(state.is_busy());
    }

    #[tokio::test]
    async fn refuses_a_second_start_while_one_is_running() {
        let state = AssistantState::default();
        start(&state, "r1");

        let err = state
            .try_reserve(&request_with_id("r2", true, "m"))
            .unwrap_err();
        assert_eq!(err.code(), "busy");
    }

    #[test]
    fn concurrent_starts_never_both_win() {
        use std::sync::{Arc, Barrier};
        for round in 0..1_000 {
            let state = Arc::new(AssistantState::default());
            let barrier = Arc::new(Barrier::new(2));
            let racers: Vec<_> = (0..2)
                .map(|n| {
                    let state = state.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        state
                            .try_reserve(&request_with_id(&format!("r{round}-{n}"), true, "m"))
                            .is_ok()
                    })
                })
                .collect();
            let wins = racers
                .into_iter()
                .map(|r| r.join().unwrap())
                .filter(|won| *won)
                .count();
            assert_eq!(wins, 1, "round {round}");
        }
    }

    #[tokio::test]
    async fn a_reused_request_id_is_refused_even_after_its_turn_ended() {
        let state = AssistantState::default();
        let nonce = start(&state, "r1");
        state.finish(nonce);

        let err = state
            .try_reserve(&request_with_id("r1", true, "m"))
            .unwrap_err();
        assert_eq!(err.code(), "request_id_reused");
        assert!(!state.is_busy());
    }

    fn message(content: String) -> super::super::engine_chat::ChatMessage {
        super::super::engine_chat::ChatMessage {
            role: "user".into(),
            content,
            tool_calls: None,
            tool_name: None,
            tool_call_id: None,
        }
    }

    #[test]
    fn an_oversized_start_is_refused_before_it_takes_the_slot() {
        let state = AssistantState::default();
        let mut too_many = request_with_id("many", true, "m");
        too_many.messages = (0..=MAX_START_MESSAGES)
            .map(|_| message("hi".into()))
            .collect();
        assert_eq!(
            state.try_reserve(&too_many).unwrap_err().code(),
            "request_too_large"
        );

        let mut too_big = request_with_id("big", true, "m");
        too_big.messages = vec![message("x".repeat(MAX_START_CONTENT_BYTES + 1))];
        assert_eq!(
            state.try_reserve(&too_big).unwrap_err().code(),
            "request_too_large"
        );

        // Nothing was reserved or remembered: the same ids can start once
        // they fit, and no listener was contacted (this path has none).
        assert!(!state.is_busy());
        too_big.messages = vec![message("x".repeat(MAX_START_CONTENT_BYTES))];
        assert!(state.try_reserve(&too_big).is_ok());
    }

    #[test]
    fn the_reused_id_memory_is_bounded() {
        let state = AssistantState::default();
        for n in 0..=RECENT_REQUEST_IDS {
            let reservation = state
                .try_reserve(&request_with_id(&format!("r{n}"), true, "m"))
                .unwrap();
            state.finish(reservation.nonce);
        }
        assert_eq!(state.recent_lock().len(), RECENT_REQUEST_IDS);
        assert_eq!(
            state
                .try_reserve(&request_with_id("r1", true, "m"))
                .unwrap_err()
                .code(),
            "request_id_reused"
        );
        // The oldest id fell out of the window and is accepted again.
        assert!(state.try_reserve(&request_with_id("r0", true, "m")).is_ok());
    }

    #[tokio::test]
    async fn attach_after_a_cancel_aborts_the_handle() {
        let state = AssistantState::default();
        let reservation = state.try_reserve(&request(true, "m")).unwrap();
        assert!(state.cancel("r1"));

        let handle = sleeper();
        state.attach(reservation, handle);
        assert!(!state.is_busy());
    }

    #[tokio::test]
    async fn cancel_stops_the_active_turn_and_frees_the_slot() {
        let state = AssistantState::default();
        start(&state, "r1");

        assert!(state.cancel("r1"));
        assert!(!state.is_busy());
        // A second cancel has nothing to stop.
        assert!(!state.cancel("r1"));
    }

    #[tokio::test]
    async fn cancel_active_stops_whoever_owns_the_slot() {
        let state = AssistantState::default();
        start(&state, "r-live");

        assert_eq!(state.cancel_active().as_deref(), Some("r-live"));
        assert!(!state.is_busy());
        assert_eq!(state.cancel_active(), None);
    }

    #[tokio::test]
    async fn cancel_ignores_a_stale_request_id() {
        let state = AssistantState::default();
        start(&state, "current");

        // A Stop for a turn that already ended must not kill the current one.
        assert!(!state.cancel("old"));
        assert!(state.is_busy());
    }

    #[tokio::test]
    async fn a_late_finisher_does_not_clear_a_newer_turn() {
        let state = AssistantState::default();
        let old = start(&state, "old");
        state.cancel("old");
        start(&state, "new");

        state.finish(old);
        assert_eq!(state.active_request_id().as_deref(), Some("new"));
    }

    #[test]
    fn agent_tools_enabled_is_camel_case_on_the_wire_and_defaults_false() {
        // A caller that predates the field must still deserialize,
        // landing on the safe default — answer-only, matching pre-agent
        // behavior exactly.
        let without_field: StartRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r1",
            "enabled": true,
            "model": "m",
            "contextTokens": 4096,
            "messages": [],
        }))
        .unwrap();
        assert!(!without_field.agent_tools_enabled);

        let with_field: StartRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r1",
            "enabled": true,
            "model": "m",
            "contextTokens": 4096,
            "messages": [],
            "agentToolsEnabled": true,
        }))
        .unwrap();
        assert!(with_field.agent_tools_enabled);
    }

    #[test]
    fn stream_events_carry_their_request_id() {
        let token = StreamEvent::token("r1", "hi".into());
        assert_eq!(token.kind, "token");
        assert_eq!(token.request_id, "r1");
        assert_eq!(StreamEvent::error("r1", "offline".into()).kind, "error");
        assert_eq!(StreamEvent::done("r1").kind, "done");
        assert_eq!(StreamEvent::status("r1", "generating").kind, "status");
    }

    #[tokio::test]
    async fn an_approval_is_delivered_to_the_waiting_turn() {
        let state = AssistantState::default();
        let rx = state.begin_approval("r1", TurnNonce(0), "c1");
        assert!(state.resolve_approval("r1", "c1", ApprovalDecision::Approved));
        assert!(matches!(rx.await.unwrap(), ApprovalDecision::Approved));
    }

    #[tokio::test]
    async fn a_late_finisher_does_not_clear_a_newer_turns_pending_approval() {
        let state = AssistantState::default();
        let rx = state.begin_approval("new", TurnNonce(1), "c1");

        // A turn that already ended calls finish() with its own id. It must not
        // wipe the approval the turn that replaced it is currently waiting on --
        // the same hazard the active slot is guarded against.
        state.finish(TurnNonce(0));

        assert!(state.resolve_approval("new", "c1", ApprovalDecision::Approved));
        assert!(matches!(rx.await.unwrap(), ApprovalDecision::Approved));
    }

    #[tokio::test]
    async fn an_approval_for_a_different_call_is_refused() {
        let state = AssistantState::default();
        let rx = state.begin_approval("r1", TurnNonce(0), "c1");
        // A stale card in the UI must not approve the call that replaced it.
        assert!(!state.resolve_approval("r1", "c2", ApprovalDecision::Approved));
        assert!(!state.resolve_approval("other", "c1", ApprovalDecision::Approved));

        // The mismatches above must not have disturbed the genuine waiter —
        // it still resolves normally. (Verified this test actually catches a
        // regression: temporarily changed the `Some(other)` arm in
        // `resolve_approval` to discard the entry — `guard.take()` without
        // putting `other` back — instead of restoring it, and this assertion
        // went red as expected; reverted after confirming.)
        assert!(state.resolve_approval("r1", "c1", ApprovalDecision::Approved));
        assert!(matches!(rx.await.unwrap(), ApprovalDecision::Approved));
    }

    #[tokio::test]
    async fn cancelling_a_turn_that_is_waiting_on_approval_releases_it() {
        let state = AssistantState::default();
        let nonce = start(&state, "r1");
        let rx = state.begin_approval("r1", nonce, "c1");

        assert!(state.cancel("r1"));
        // The waiter must not hang: cancel drops the sender. Wrapped in a
        // short timeout so a regression here fails fast instead of hanging
        // the whole suite.
        let received = tokio::time::timeout(std::time::Duration::from_secs(5), rx).await;
        assert!(received.expect("must not hang").is_err());
        assert!(!state.is_busy());
    }

    #[tokio::test]
    async fn await_approval_returns_the_decision_once_resolved() {
        let state = std::sync::Arc::new(AssistantState::default());
        let waiter = tokio::spawn({
            let state = state.clone();
            async move { state.await_approval("r1", TurnNonce(0), "c1").await }
        });
        // Give the spawned task a chance to register the pending entry
        // before we try to resolve it.
        tokio::task::yield_now().await;

        assert!(state.resolve_approval("r1", "c1", ApprovalDecision::Approved));
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("must not hang")
            .unwrap();
        assert!(matches!(outcome, Ok(ApprovalDecision::Approved)));
    }

    #[tokio::test]
    async fn await_approval_errors_when_the_turn_is_cancelled() {
        let state = std::sync::Arc::new(AssistantState::default());
        let nonce = start(&state, "r1");

        let waiter = tokio::spawn({
            let state = state.clone();
            async move { state.await_approval("r1", nonce, "c1").await }
        });
        tokio::task::yield_now().await;

        assert!(state.cancel("r1"));
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("must not hang")
            .unwrap();
        assert!(matches!(outcome, Err(AssistantError::Cancelled)));
    }

    #[tokio::test]
    async fn revoke_with_a_pending_approval_wakes_the_waiter_with_cancelled() {
        let state = std::sync::Arc::new(AssistantState::default());
        let waiter = tokio::spawn({
            let state = state.clone();
            async move { state.await_approval("r1", TurnNonce(0), "c1").await }
        });
        tokio::task::yield_now().await;

        state.drop_pending_approval();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("must not hang")
            .unwrap();
        assert!(matches!(outcome, Err(AssistantError::Cancelled)));
        // Granting Private Lab again does not put the old card back.
        assert!(!state.resolve_approval("r1", "c1", ApprovalDecision::Approved));
    }

    // Uses tokio's paused virtual clock rather than a real 300s sleep: time
    // only advances when `tokio::time::advance` is called, so this test is
    // instant in wall-clock terms while still exercising the real
    // `APPROVAL_TIMEOUT` deadline.
    #[tokio::test(start_paused = true)]
    async fn await_approval_times_out_and_clears_the_pending_slot() {
        let state = std::sync::Arc::new(AssistantState::default());
        let waiter = tokio::spawn({
            let state = state.clone();
            async move { state.await_approval("r1", TurnNonce(0), "c1").await }
        });
        // Let the spawned task register the pending entry before the clock
        // moves, so the timeout it starts is the one under test.
        tokio::task::yield_now().await;

        tokio::time::advance(APPROVAL_TIMEOUT + std::time::Duration::from_secs(1)).await;

        let outcome = waiter.await.unwrap();
        assert!(matches!(outcome, Err(AssistantError::ApprovalTimeout)));

        // A stale card for this call must not be able to resolve anything
        // after the deadline — the slot must already be clear.
        // Assert the slot directly. `resolve_approval` would return false here
        // even with the clear removed: the timeout future already consumed the
        // receiver, so the send fails regardless. Only the slot discriminates a
        // leaked `Pending`.
        assert_eq!(state.pending_call_id(), None);
        assert!(!state.resolve_approval("r1", "c1", ApprovalDecision::Approved));
    }

    // -- terminal_run may only act on a session the agent itself opened --

    #[test]
    fn a_session_the_agent_never_opened_is_not_owned() {
        let state = AssistantState::default();
        // A user's own hand-opened terminal tab, or any other id the agent
        // never saw come back from its own `terminal_open` call.
        assert!(!state.owns_agent_session("s-user-opened"));
    }

    #[test]
    fn a_session_the_agent_opened_is_owned_afterwards() {
        let state = AssistantState::default();
        state.note_agent_session("s-agent-opened");
        assert!(state.owns_agent_session("s-agent-opened"));
        // Noting one session must not make every session look owned.
        assert!(!state.owns_agent_session("s-someone-else"));
    }

    #[test]
    fn noting_the_same_session_twice_is_harmless() {
        let state = AssistantState::default();
        state.note_agent_session("s-1");
        state.note_agent_session("s-1");
        assert!(state.owns_agent_session("s-1"));
    }

    #[test]
    fn ownership_spans_turns_within_the_process_lifetime() {
        // The model can only learn a session id from a prior tool result, and
        // that can happen in a step of a *different* turn once the id is in
        // the conversation history fed back to it — ownership is per-process,
        // not scoped to the turn that opened it.
        let state = AssistantState::default();
        state.note_agent_session("s-cross-turn");
        assert!(state.owns_agent_session("s-cross-turn"));
    }

    // -- Eviction on close -----------------------------------------

    #[test]
    fn forgetting_an_agent_session_removes_it_from_the_ownership_set() {
        let state = AssistantState::default();
        state.note_agent_session("s-1");
        assert!(state.owns_agent_session("s-1"));

        state.forget_agent_session("s-1");
        assert!(!state.owns_agent_session("s-1"));
    }

    #[test]
    fn forgetting_one_session_never_disturbs_another() {
        let state = AssistantState::default();
        state.note_agent_session("s-1");
        state.note_agent_session("s-2");

        state.forget_agent_session("s-1");
        assert!(!state.owns_agent_session("s-1"));
        assert!(state.owns_agent_session("s-2"));
    }

    #[test]
    fn forgetting_a_session_never_noted_is_a_harmless_no_op() {
        let state = AssistantState::default();
        // The user's own session, or one already evicted -- either way,
        // `terminal_close` calls this unconditionally on every closed id,
        // not only ones it knows are agent-opened.
        state.forget_agent_session("s-user-opened");
        assert!(!state.owns_agent_session("s-user-opened"));
    }

    #[test]
    fn forgetting_all_agent_sessions_clears_every_member() {
        let state = AssistantState::default();
        state.note_agent_session("s-1");
        state.note_agent_session("s-2");

        state.forget_all_agent_sessions();
        assert!(!state.owns_agent_session("s-1"));
        assert!(!state.owns_agent_session("s-2"));
    }

    #[test]
    fn tool_stream_events_carry_their_ids() {
        let ev = StreamEvent::tool_call(
            "r1",
            "c1",
            "launch_tool",
            "Launch tool-nmap",
            ApprovalAction::LaunchTool {
                installation_id: "tool-nmap".into(),
                display_name: None,
                args_text: String::new(),
                identity: crate::assistant::tools::LaunchIdentity::Blocked {
                    reason: "tool_not_found".into(),
                },
            },
        );
        assert_eq!(ev.kind, "tool_call");
        assert_eq!(ev.call_id.as_deref(), Some("c1"));
        let res = StreamEvent::tool_result_with_session("r1", "c1", "ok", None);
        assert_eq!(res.kind, "tool_result");
        assert_eq!(res.session_id, None);
    }

    #[test]
    fn a_terminal_run_result_carries_the_session_id_as_a_structured_field_not_in_text() {
        let res = StreamEvent::tool_result_with_session(
            "r1",
            "c1",
            "Sent to terminal session s-42",
            Some("s-42".into()),
        );
        assert_eq!(res.session_id.as_deref(), Some("s-42"));
        // The renderer must be able to get the id from the field alone,
        // without parsing `summary`'s prose.
        let json = serde_json::to_string(&res).unwrap();
        assert!(json.contains("\"sessionId\":\"s-42\""), "{json}");
    }

    #[test]
    fn a_bound_event_names_the_endpoint_and_model_the_turn_is_sent_to() {
        // The health panel's endpoint can be stale by the time a
        // turn binds, so the turn itself says where the conversation went.
        let ev = StreamEvent::bound("r1", "http://127.0.0.1:11434", "qwen2.5:14b");
        assert_eq!(ev.kind, "bound");
        let json = serde_json::to_string(&ev).unwrap();
        assert!(
            json.contains("\"endpoint\":\"http://127.0.0.1:11434\""),
            "{json}"
        );
        assert!(json.contains("\"model\":\"qwen2.5:14b\""), "{json}");

        // Every other event keeps its old wire shape.
        let token = serde_json::to_string(&StreamEvent::token("r1", "hi".into())).unwrap();
        assert!(
            !token.contains("endpoint") && !token.contains("\"model\""),
            "{token}"
        );
    }
}
