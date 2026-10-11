//! Tauri commands — the whole surface the renderer may touch.
//!
//! Six commands, no endpoint argument among them. The renderer can say
//! "check health", "list the installed models", "start this turn",
//! "cancel that turn", "here is my decision on a proposed tool call",
//! "the previous renderer is gone" and nothing else; it cannot say *where*.
//! A turn runs on Qutra's local engine (ADR 0016), started for it on demand.

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{Emitter, Manager};

use super::{
    audit::AuditEntry,
    broker::{
        ApprovalDecision, AssistantState, StartOutcome, StartRequest, StreamEvent, TurnNonce,
        APPROVAL_TIMEOUT,
    },
    dispatch::DispatchGate,
    engine_chat::{self, StreamDecoder},
    error::AssistantError,
    tools::{self, AgentTool},
};
use crate::ai::{
    keys::{credential, KeyringStore},
    mask,
    providers::Target,
    web::{self, Gathered, Search, WebError},
};
use crate::consent::PrivateToolsConsent;
use crate::local_engine::models::{LocalModel, ModelState};
use crate::local_engine::process::{Lease, Phase};
use crate::local_engine::LocalEngine;
use crate::terminal::TerminalSessions;
use crate::tool_supervisor::ToolSupervisor;

/// Tauri event channel for streamed output.
pub const STREAM_EVENT: &str = "assistant://stream";

/// A model that keeps proposing tools must terminate on its own. Each step is
/// one model round-trip that ends either with no tool calls (the turn is
/// done) or with one approved-and-executed tool call fed back for the next
/// round; exceeding this many steps ends the turn as `too_many_steps`
/// (ADR 0012, Decision 4's cousin for the model side of the loop).
const MAX_TOOL_STEPS: usize = 5;

/// Stands in for the tool name when the name itself was refused. Only used for
/// `UnknownTool`: there the name is untrusted free text of arbitrary length and
/// `audit.rs` records shape, not content, so it is deliberately not written down.
const REFUSED_TOOL_PLACEHOLDER: &str = "<not-allowlisted>";

/// Stands in for the tool name when an *allowlisted* tool was refused over its
/// arguments. The name passed the exact-match check against the closed
/// three-element set, so it is a safe constant — but `parse_tool_call` has
/// already discarded which one by the time we see the error.
const REFUSED_ARGS_PLACEHOLDER: &str = "<invalid-arguments>";

/// A returned call on a turn that never offered the schema (TM-002).
const REFUSED_UNSOLICITED_PLACEHOLDER: &str = "<unsolicited>";

/// How to label an audit entry for a refused proposal.
///
/// `parse_tool_call` refuses for two materially different reasons and they must
/// not be filed under one label. A name outside the allowlist is a model
/// wandering off the menu. A *newline embedded in a `terminal_run` command* is
/// an attempt to turn one approval into several executed commands — the single
/// most interesting thing this log can hold. Recording that as
/// "not allowlisted" would bury it next to a typo. An unsolicited call is a
/// third reason: the name may be allowlisted, but the schema was not offered.
fn refusal_labels(err: &AssistantError) -> (&'static str, &'static str) {
    match err {
        AssistantError::UnknownTool => (REFUSED_TOOL_PLACEHOLDER, "refused_not_allowlisted"),
        AssistantError::UnsolicitedTool => (REFUSED_UNSOLICITED_PLACEHOLDER, "refused_unsolicited"),
        // Everything else out of `parse_tool_call` is an allowlisted name whose
        // arguments failed the typed parse or the embedded-newline ban.
        _ => (REFUSED_ARGS_PLACEHOLDER, "refused_invalid_arguments"),
    }
}

/// Upper bound on one whole turn's wall-clock lifetime — model time and human
/// approval time combined, across every step, drawn from a single shared
/// budget rather than a fresh allowance handed to each step. `TOTAL_TIMEOUT`
/// bounds one response; `APPROVAL_TIMEOUT` bounds one pending approval;
/// neither bounds the turn, which can visit up to `MAX_TOOL_STEPS` of each in
/// sequence. See ADR 0012 Decision 4 for why this is
/// `MAX_TOOL_STEPS * (TOTAL_TIMEOUT + APPROVAL_TIMEOUT)` — the true worst
/// case a turn can already reach today, made an explicit, enforced, single
/// deadline instead of an emergent property of independently-resetting
/// per-step clocks — rather than reusing `TOTAL_TIMEOUT` alone for the whole
/// turn, which would be too tight for a legitimate multi-step turn that needs
/// both model time and paced human review for several approvals.
const TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(
    (MAX_TOOL_STEPS as u64) * (engine_chat::TOTAL_TIMEOUT.as_secs() + APPROVAL_TIMEOUT.as_secs()),
);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// `disabled` | `ready` | `model_missing` | `engine_missing` |
    /// `needs_prepare` | `unsupported` | `error`
    pub status: String,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Where the engine listens, when it runs this model. Chosen by Rust.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// The model this check was asked about — not a silent substitute.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
}

/// The report for one model, from what Rust found on disk. "Ready" means
/// the engine can run it; the engine itself starts on the first question.
fn health_for(
    installed: bool,
    models: &[LocalModel],
    model: &str,
    running: Option<(String, String)>,
) -> HealthReport {
    let usable: Vec<String> = models
        .iter()
        .filter(|m| listed(m))
        .map(|m| m.id.clone())
        .collect();
    let found = models.iter().find(|m| m.id == model);
    let (status, detail) = match found.map(|m| &m.state) {
        _ if !installed => ("engine_missing", None),
        None => ("model_missing", None),
        Some(ModelState::Ready) => ("ready", None),
        Some(ModelState::NeedsPrepare { .. }) => ("needs_prepare", None),
        Some(ModelState::Unsupported { architecture }) => {
            ("unsupported", Some(architecture.clone()))
        }
        Some(ModelState::Unreadable { .. }) => ("error", Some("model_unreadable".to_string())),
    };
    HealthReport {
        status: status.into(),
        models: usable,
        detail,
        endpoint: running
            .filter(|(running_model, _)| running_model == model)
            .map(|(_, endpoint)| endpoint),
        selected_model: Some(model.to_string()),
    }
}

/// A model the picker offers: one the engine runs, or will after a copy.
fn listed(model: &LocalModel) -> bool {
    matches!(
        model.state,
        ModelState::Ready | ModelState::NeedsPrepare { .. }
    )
}

async fn local_models(app: &tauri::AppHandle) -> Result<Vec<LocalModel>, AssistantError> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || app.state::<LocalEngine>().models())
        .await
        .map_err(|e| AssistantError::Internal(e.to_string()))
}

fn running_engine(app: &tauri::AppHandle) -> Option<(String, String)> {
    let status = app.state::<LocalEngine>().engine.status();
    match (status.phase, status.model, status.endpoint) {
        (Phase::Ready, Some(model), Some(endpoint)) => Some((model, endpoint)),
        _ => None,
    }
}

#[tauri::command]
pub async fn assistant_health(
    app: tauri::AppHandle,
    enabled: bool,
    model: String,
) -> Result<HealthReport, String> {
    // The opt-in is checked before anything is read, exactly as on the
    // renderer side — this is the enforcing copy of that rule.
    if !enabled {
        return Ok(HealthReport {
            status: "disabled".into(),
            models: vec![],
            detail: None,
            endpoint: None,
            selected_model: None,
        });
    }
    let models = local_models(&app).await?;
    let installed = app.state::<LocalEngine>().installed();
    Ok(health_for(installed, &models, &model, running_engine(&app)))
}

/// One local model and whether its chat template can call tools.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    /// `completion`, plus `tools` when the model's template names them.
    pub capabilities: Vec<String>,
    /// `Some(true)`/`Some(false)` from the model's chat template; `None`
    /// when it carries none and the engine uses a generic one. "We could
    /// not tell" is not "it said no", and the picker shows it as unknown.
    pub tools: Option<bool>,
}

/// Same status vocabulary as `HealthReport`, so the renderer treats both
/// surfaces the same way.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsReport {
    /// `disabled` | `ready`
    pub status: String,
    pub models: Vec<ModelInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

fn model_info(model: &LocalModel) -> ModelInfo {
    let mut capabilities = vec!["completion".to_string()];
    if model.tools == Some(true) {
        capabilities.push("tools".into());
    }
    ModelInfo {
        name: model.id.clone(),
        capabilities,
        tools: model.tools,
    }
}

/// The models the engine can run, read from the app's folder and Ollama's
/// store (ADR 0016). Capabilities come from each model's own header, read
/// once and cached, so listing asks no running server anything.
#[tauri::command]
pub async fn assistant_models(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<ModelsReport, String> {
    if !enabled {
        return Ok(ModelsReport {
            status: "disabled".into(),
            models: vec![],
            detail: None,
            endpoint: None,
        });
    }
    let models = local_models(&app).await?;
    Ok(ModelsReport {
        status: "ready".into(),
        models: models
            .iter()
            .filter(|m| listed(m))
            .map(model_info)
            .collect(),
        detail: None,
        endpoint: None,
    })
}

#[tauri::command]
pub async fn assistant_start(
    app: tauri::AppHandle,
    request: StartRequest,
) -> Result<StartOutcome, String> {
    let state = app.state::<AssistantState>();

    let reservation = match state.try_reserve(&request) {
        Ok(reservation) => reservation,
        Err(err) => {
            return Ok(StartOutcome {
                accepted: false,
                reason: Some(err.code()),
            })
        }
    };

    let nonce = reservation.nonce;
    let model = request.model.clone();
    let message_count = request.messages.len();
    let emitter = app.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        // `run_turn` mutates the message list across tool steps (appending
        // the assistant's tool call and the tool's result), so it needs an
        // owned, mutable copy rather than borrowing `request.messages`.
        let messages = request.messages.clone();
        let outcome = run_turn(&emitter, &request, nonce, messages).await;

        let code = match &outcome {
            Ok(()) => "completed".to_string(),
            Err(err) => err.code(),
        };
        if let Err(err) = outcome {
            let _ = emitter.emit(
                STREAM_EVENT,
                StreamEvent::error(&request.request_id, err.code()),
            );
        } else {
            let _ = emitter.emit(STREAM_EVENT, StreamEvent::done(&request.request_id));
        }

        let state = emitter.state::<AssistantState>();
        state.audit.record(AuditEntry {
            request_id: request.request_id.clone(),
            model,
            outcome: code,
            duration_ms: started.elapsed().as_millis(),
            message_count,
            // This is the turn-level entry, not about any single tool call.
            tool: None,
            decision: None,
        });
        state.finish(nonce);
    });

    state.attach(reservation, handle);
    Ok(StartOutcome {
        accepted: true,
        reason: None,
    })
}

/// One model round-trip's outcome: either the turn is finished, or the model
/// proposed tool calls to act on before continuing.
enum StepOutcome {
    Done,
    ToolCalls(Vec<engine_chat::ToolCall>),
}

/// Most assistant text kept for one step. Far beyond any answer a local model
/// streams within `TOTAL_TIMEOUT`; past it the step is refused, not truncated.
const MAX_STEP_TEXT_BYTES: usize = 1024 * 1024;

/// Stream one `/v1/chat/completions` response, enforcing both deadlines,
/// accumulating text tokens (emitted as `token` events, as before) and any
/// tool calls.
async fn stream_one_response(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    lease: &Lease,
    request_id: &str,
    body: &serde_json::Value,
) -> Result<(String, StepOutcome), AssistantError> {
    let _ = app.emit(STREAM_EVENT, StreamEvent::status(request_id, "generating"));

    let response = tokio::time::timeout(
        engine_chat::FIRST_TOKEN_TIMEOUT,
        engine_chat::open_chat_stream(client, &lease.origin, &lease.api_key, body),
    )
    .await
    .map_err(|_| AssistantError::TimeoutFirstToken)??;

    drain_chat_stream(response, request_id, &|event| {
        let _ = app.emit(STREAM_EVENT, event);
    })
    .await
}

/// Read an open stream to its end within `TOTAL_TIMEOUT` and the byte
/// budgets above. Separate from the opener so tests can feed it a local
/// listener; `emit` receives each `token` event.
async fn drain_chat_stream(
    response: reqwest::Response,
    request_id: &str,
    emit: &impl Fn(StreamEvent),
) -> Result<(String, StepOutcome), AssistantError> {
    let started = Instant::now();
    let mut stream = response.bytes_stream();
    let mut decoder = StreamDecoder::default();
    let mut saw_token = false;
    let mut assistant_text = String::new();

    let finish = |decoder: &StreamDecoder, text: String| {
        let calls = decoder.tool_calls();
        let outcome = if calls.is_empty() {
            StepOutcome::Done
        } else {
            StepOutcome::ToolCalls(calls)
        };
        (text, outcome)
    };

    loop {
        // The total ceiling applies for the whole response; the first-token
        // deadline stops applying once the model is actually producing.
        let remaining = engine_chat::TOTAL_TIMEOUT
            .checked_sub(started.elapsed())
            .ok_or(AssistantError::TimeoutTotal)?;
        let per_read = if saw_token {
            remaining
        } else {
            remaining.min(engine_chat::FIRST_TOKEN_TIMEOUT)
        };

        let next = match tokio::time::timeout(per_read, stream.next()).await {
            Ok(item) => item,
            Err(_) => {
                return Err(if saw_token {
                    AssistantError::TimeoutTotal
                } else {
                    AssistantError::TimeoutFirstToken
                })
            }
        };

        let Some(bytes) = next else { break };
        let bytes = bytes.map_err(|e| AssistantError::Internal(e.to_string()))?;

        // An event is decoded only once it is whole, so a character split
        // across two reads ("ğ" is two bytes) arrives in one piece.
        for piece in decoder.push(&bytes)? {
            match piece {
                engine_chat::Piece::Text(text) => {
                    saw_token = true;
                    if assistant_text.len() + text.len() > MAX_STEP_TEXT_BYTES {
                        return Err(AssistantError::ResponseTooLarge);
                    }
                    assistant_text.push_str(&text);
                    emit(StreamEvent::token(request_id, text));
                }
                engine_chat::Piece::Done => return Ok(finish(&decoder, assistant_text)),
            }
        }
    }

    Ok(finish(&decoder, assistant_text))
}

/// Whether a proposed tool call must pause for human approval before
/// `tools::execute` runs (ADR 0012, Decision 2). `auto_approve_reads` may
/// only ever *weaken* this for `read_context` — a side-effecting tool
/// (`terminal_run`, `launch_tool`) always requires approval regardless of
/// the preference. That is true by construction of the `||` below (a
/// side-effecting call makes the left side `true` unconditionally), and the
/// `debug_assert!` makes the invariant checked, not just implied, so a
/// future refactor that accidentally inverts the condition fails loudly in
/// any debug build (including every test run) instead of silently widening
/// the auto-approve exception to a side-effecting tool.
fn requires_approval(tool: &AgentTool, auto_approve_reads: bool) -> bool {
    let required = tool.is_side_effecting() || !auto_approve_reads;
    debug_assert!(
        !tool.is_side_effecting() || required,
        "auto_approve_reads must never bypass approval for a side-effecting tool"
    );
    required
}

/// Whether tool calls should be advertised to the model at all this turn
/// A deliberate conjunction of two independent gates, each
/// insufficient alone — this must not silently turn into an `||` the way
/// `requires_approval`'s invariant above warns against for its own `||`:
///
/// - `agent_tools_enabled` is the renderer's explicit, per-turn opt-in
///   (`StartRequest::agent_tools_enabled`, wire name `agentToolsEnabled`).
///   Without it, a user who enabled only the "answer only" local assistant
///   under ADR 0010 would get an agent with no deliberate action of their
///   own, purely because ADR 0012 shipped.
/// - `consent_granted` is Private Lab consent
///   (`consent::PrivateToolsConsent::is_granted`). Without it, `tools::
///   execute` refuses every side-effecting call *and* every `read_context`
///   call with `ConsentRequired` — which used to end the whole turn,
///   including the answer the user was actually waiting for, repeatedly,
///   with no way to make the model stop proposing tools it could never use.
///
/// When either is `false`, the caller passes `None` for the tool schema and
/// the model simply answers — exactly the behavior before ADR 0012 shipped.
/// A pure function of the two booleans (no `AppHandle`), so the conjunction
/// itself has a test, not just each flag checked in isolation.
fn agent_tools_should_be_offered(agent_tools_enabled: bool, consent_granted: bool) -> bool {
    agent_tools_enabled && consent_granted
}

/// A fresh internal id for one proposed tool call: Rust-random, never read
/// from `call.id` and never derived from the renderer's request id, so
/// neither a poisoned context nor a repeated request id can make two calls
/// share an id (see the call site in `run_turn` for why that matters:
/// `resolve_approval` matches on `request_id` + `call_id`, and
/// `request_id` alone is constant for the whole turn).
fn new_call_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Run `f` on tokio's blocking thread pool instead of the async worker
/// thread `run_turn` itself executes on, flattening a `JoinError` (the task
/// panicked) into `AssistantError::Internal` rather than propagating it as a
/// panic of its own.
///
/// `tools::execute` performs `openpty`, `Command::spawn`, and
/// `resolve_launchable`'s live SHA-256 re-hash of the binary on disk — all
/// blocking I/O or CPU work. Calling it directly, as `run_turn` used to,
/// ran that work on the same tokio worker thread driving every other
/// in-flight turn's streaming and timeouts; hashing a large executable could
/// stall the runtime for everyone, not just this turn. `spawn_blocking`
/// moves it to a thread meant for exactly this.
///
/// Generic and tested on its own (see the `tests` module below) because
/// `tools::execute` itself cannot be exercised without a real
/// `tauri::AppHandle` (see that function's doc comment in `tools.rs`) — this
/// is everything about the move that *can* be tested in isolation: the
/// flattening behaves correctly regardless of what `f` actually does.
///
/// Ordering note for the call site in `run_turn`: consent is checked as the
/// first line inside `tools::execute` itself, so it still runs before any
/// dispatch (the PTY open/spawn, the detached launch) — moving the *whole*
/// call onto the blocking pool moves the gate check there too, but does not
/// reorder it relative to the work it gates. Approval has already been
/// awaited (or the call auto-approved) by the time `run_turn` reaches this
/// call, exactly as before.
async fn run_blocking<T, F>(f: F) -> Result<T, AssistantError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AssistantError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(join_err) => Err(AssistantError::Internal(format!(
            "tool execution task did not complete: {join_err}"
        ))),
    }
}

/// The engine for this turn: the model resolved by Rust from its id, the
/// engine started for it if it is not running (the page hears
/// `engine_starting` first), and held until the turn ends so it cannot go
/// idle under an answer or an approval.
async fn bind_engine(
    app: &tauri::AppHandle,
    request: &StartRequest,
) -> Result<Lease, AssistantError> {
    let model = request.model.trim().to_string();
    if model.is_empty() {
        return Err(AssistantError::InvalidModel);
    }
    let resolver = app.clone();
    let id = model.clone();
    let target = tokio::task::spawn_blocking(move || resolver.state::<LocalEngine>().resolve(&id))
        .await
        .map_err(|e| AssistantError::Internal(e.to_string()))??;
    let local = app.state::<LocalEngine>();
    if local.engine.running_model().as_deref() != Some(model.as_str()) {
        let _ = app.emit(
            STREAM_EVENT,
            StreamEvent::status(&request.request_id, "engine_starting"),
        );
    }
    Ok(local.engine.ensure(&target, request.context_tokens).await?)
}

/// The whole internet step may take this long; each fetch inside it has its
/// own, shorter limit (`web::REQUEST_TIMEOUT`).
const WEB_STEP_TIMEOUT: Duration = Duration::from_secs(25);

/// A message of the kind the engine reads, from text.
fn plain_message(role: &str, content: String) -> engine_chat::ChatMessage {
    engine_chat::ChatMessage {
        role: role.into(),
        content,
        tool_calls: None,
        tool_name: None,
        tool_call_id: None,
    }
}

/// The guard line goes into the system message of every turn that has the
/// internet on, after anything already there (Jarvis's memory, the context
/// frame), and the web text goes ahead of the user's last question. The
/// frame's own markers are not touched.
fn apply_web(messages: &mut Vec<engine_chat::ChatMessage>, gathered: Option<&Gathered>) {
    match messages.first_mut() {
        Some(first) if first.role == "system" => {
            first.content.push_str("\n\n");
            first.content.push_str(web::GUARD_LINE);
        }
        _ => messages.insert(0, plain_message("system", web::GUARD_LINE.into())),
    }
    let Some(gathered) = gathered else { return };
    if let Some(last) = messages.iter_mut().rev().find(|m| m.role == "user") {
        last.content = format!("{}\n\n{}", gathered.block, last.content);
    }
}

/// How much page text a turn may carry: a quarter of the context window in
/// characters, between a small floor and what three pages can fill.
fn web_budget(context_tokens: u32) -> usize {
    (context_tokens as usize).clamp(3_000, 12_000)
}

/// Read the web for the question being asked: search it (or fetch the
/// addresses in it) and return the block that goes ahead of it. The query
/// that leaves is masked like a cloud turn, exclusions included.
async fn read_web(
    app: &tauri::AppHandle,
    context_tokens: u32,
    question: &str,
) -> Result<Gathered, AssistantError> {
    let terms = crate::ai::exclusions::for_cloud(app)
        .await
        .map_err(|_| AssistantError::Web(WebError::SearchFailed.code()))?;
    let text = question.to_string();
    let query = run_blocking(move || {
        mask::preview_with(&text, &terms)
            .map(|preview| preview.text)
            .map_err(|_| AssistantError::RequestTooLarge)
    })
    .await?;
    let key = run_blocking(|| {
        credential(&KeyringStore, Target::Brave)
            .map_err(|_| AssistantError::Web(WebError::KeyRejected.code()))
    })
    .await?;
    let fetcher = web::Fetcher::new().map_err(|e| AssistantError::Web(e.code()))?;
    let client = crate::ai::http::client()
        .map_err(|_| AssistantError::Web(WebError::SearchFailed.code()))?;
    let search = key.as_ref().map(|cred| Search {
        client: &client,
        base_url: &cred.base_url,
        key: &cred.key,
    });
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    web::gather(
        question,
        &query,
        search.as_ref(),
        &fetcher,
        &nonce,
        web_budget(context_tokens),
    )
    .await
    .map_err(|e| AssistantError::Web(e.code()))
}

/// The internet step of a turn: the guard line, then the web text. Said to
/// the page as it starts (`web_searching`) and again with the pages read
/// (`web_sources`).
async fn add_web(
    app: &tauri::AppHandle,
    request: &StartRequest,
    messages: &mut Vec<engine_chat::ChatMessage>,
) -> Result<(), AssistantError> {
    let Some(question) = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
    else {
        apply_web(messages, None);
        return Ok(());
    };
    let _ = app.emit(
        STREAM_EVENT,
        StreamEvent::status(&request.request_id, "web_searching"),
    );
    let gathered = tokio::time::timeout(
        WEB_STEP_TIMEOUT,
        read_web(app, request.context_tokens, &question),
    )
    .await
    .map_err(|_| AssistantError::Web(WebError::SearchFailed.code()))??;
    let _ = app.emit(
        STREAM_EVENT,
        StreamEvent::web_sources(&request.request_id, gathered.sources.clone()),
    );
    apply_web(messages, Some(&gathered));
    Ok(())
}

/// Drive one streamed, tool-calling turn, enforcing both deadlines and the
/// approval gate on every side-effecting (or non-auto-approved) tool call.
async fn run_turn(
    app: &tauri::AppHandle,
    request: &StartRequest,
    nonce: TurnNonce,
    mut messages: Vec<engine_chat::ChatMessage>,
) -> Result<(), AssistantError> {
    let client = engine_chat::client()?;
    let lease = bind_engine(app, request).await?;
    let _ = engine_chat::url_on(&lease.origin, "/v1/chat/completions")?;
    // Say where the conversation is going before any of it is sent.
    let _ = app.emit(
        STREAM_EVENT,
        StreamEvent::bound(&request.request_id, &lease.origin, &lease.model),
    );
    let state = app.state::<AssistantState>();
    // One shared clock for the whole turn: streaming time and approval-wait
    // time both draw down the same budget, so a slow early step leaves less
    // for a later one rather than every step re-earning a fresh allowance
    // (ADR 0012 Decision 4).
    let turn_deadline = Instant::now() + TURN_TIMEOUT;

    // The internet is read once, for the question asked now. It rides in this
    // turn's messages only; the page never stores it.
    if request.web_access {
        add_web(app, request, &mut messages).await?;
    }

    for _ in 0..MAX_TOOL_STEPS {
        let remaining_for_turn = turn_deadline
            .checked_duration_since(Instant::now())
            .ok_or(AssistantError::TimeoutTurn)?;

        // Captured before consent is read. A Stop or revoke that bumps the
        // generation after this point cannot be papered over by a later
        // regrant: `tools::execute` commits side effects only against this
        // ticket.
        let ticket = app.state::<DispatchGate>().ticket();

        // Re-checked every step, not just once at the start of the turn:
        // consent is revocable mid-turn (`consent.rs`), so a user who revokes
        // it partway through must stop being offered tools on the very next
        // round-trip rather than only failing once the model tries to call
        // one.
        let consent_granted = app.state::<PrivateToolsConsent>().is_granted();
        let tools_were_offered =
            agent_tools_should_be_offered(request.agent_tools_enabled, consent_granted);
        let tool_schema = tools_were_offered.then(tools::agent_tool_schema);

        let body = engine_chat::chat_request(&lease.model, &messages, tool_schema);

        let (assistant_text, step_outcome) = tokio::time::timeout(
            remaining_for_turn,
            stream_one_response(app, &client, &lease, &request.request_id, &body),
        )
        .await
        .map_err(|_| AssistantError::TimeoutTurn)??;

        let tool_calls = match step_outcome {
            StepOutcome::Done => return Ok(()),
            StepOutcome::ToolCalls(calls) => calls,
        };

        // Only the first proposed call is acted on; a model that proposed
        // several in one turn gets the rest dropped, not queued — the loop
        // will see whatever it proposes next once this one's result is fed
        // back, still bounded by MAX_TOOL_STEPS.
        let call = tool_calls
            .into_iter()
            .next()
            .expect("checked non-empty above");

        // Started before the parse so a refused proposal is timed too -- the
        // audit entry for a refusal is written from inside the Err arm below.
        let tool_started = Instant::now();

        // TM-002: omitting the schema is not a dispatch denial. A
        // listener can still return an allowlisted call. Refuse every
        // returned call *before* the approval step when tools were not
        // offered this step — including `read_context` with
        // `auto_approve_reads` on, which would otherwise execute with no
        // card. `tools::execute` re-checks the same authorization.
        if let Err(err) = tools::authorize_tool_dispatch(
            tools_were_offered,
            request.agent_tools_enabled,
            consent_granted,
        ) {
            let (tool_label, decision_label) = refusal_labels(&err);
            state.audit.record(AuditEntry {
                request_id: request.request_id.clone(),
                model: request.model.clone(),
                outcome: err.code(),
                duration_ms: tool_started.elapsed().as_millis(),
                message_count: messages.len(),
                tool: Some(tool_label.to_string()),
                decision: Some(decision_label.to_string()),
            });
            return Err(err);
        }

        let agent_tool = match tools::parse_tool_call(&call) {
            Ok(tool) => tool,
            Err(err) => {
                // A proposal the allowlist refused is still a proposal, and
                // `assistantPermissions.ts` requires the log to record every
                // one of them, approved or not — a log that only holds the
                // calls that got through answers the wrong question.
                //
                // The name the model actually sent is deliberately NOT
                // recorded. It is attacker-influenced free text of arbitrary
                // length, and `audit.rs`'s rule is shape, not content; the
                // fact worth keeping is that something outside the allowlist
                // was proposed and refused, which the outcome code carries.
                let (tool_label, decision_label) = refusal_labels(&err);
                state.audit.record(AuditEntry {
                    request_id: request.request_id.clone(),
                    model: request.model.clone(),
                    outcome: err.code(),
                    duration_ms: tool_started.elapsed().as_millis(),
                    message_count: messages.len(),
                    tool: Some(tool_label.to_string()),
                    decision: Some(decision_label.to_string()),
                });
                // A closed allowlist means a refusal is final: an unknown
                // tool name is not fed back for the model to retry. No event
                // is emitted here — the caller (`assistant_start`) emits
                // exactly one `error` event for every `Err` outcome, and an
                // extra emit here would double it.
                return Err(err);
            }
        };

        // Always generated here, never taken from model output. `call.id` is
        // the *sole* discriminator `resolve_approval` matches on alongside
        // `request_id` (`broker.rs`), and `request_id` is constant for the
        // whole turn — so if the model could choose `call_id`, a poisoned
        // context could make two different calls share an id and let an
        // approval the user read for one call resolve a different one (ADR
        // 0012 Decision 2: "A stale approval card must not resolve the call
        // that replaced it"). The id only needs to be internally consistent
        // between the emitted events and the echoed `ToolCall` below — the
        // model never needs to recognize it.
        let call_id = new_call_id();

        let decision_label: &str;

        if requires_approval(&agent_tool, request.auto_approve_reads) {
            // `summary_for_approval` (not the plain `agent_tool.summary()`)
            // so a `launch_tool` card names the tool by its registered
            // display name, resolved through the same identity gate
            // `execute` uses, rather than the bare installation uuid the
            // model was given — see that function's doc comment.
            let supervisor = app.state::<ToolSupervisor>();
            let (summary, action) = tools::approval_for(&supervisor, &agent_tool);
            let _ = app.emit(
                STREAM_EVENT,
                StreamEvent::tool_call(
                    &request.request_id,
                    &call_id,
                    agent_tool.name(),
                    &summary,
                    action,
                ),
            );

            // `unwrap_or(ZERO)` rather than an early `?` here: a zero-duration
            // `tokio::time::timeout` fires immediately and lands in this
            // match's own `Err(_)` arm below, which records the audit entry.
            // An early return would skip that — the turn already expired, but
            // the tool-level audit entry for *this* call would go missing.
            let remaining_for_turn = turn_deadline
                .checked_duration_since(Instant::now())
                .unwrap_or(std::time::Duration::ZERO);

            match tokio::time::timeout(
                remaining_for_turn,
                state.await_approval(&request.request_id, nonce, &call_id),
            )
            .await
            {
                Ok(Ok(ApprovalDecision::Approved)) => decision_label = "approved",
                Ok(Ok(ApprovalDecision::Rejected)) => {
                    state.audit.record(AuditEntry {
                        request_id: request.request_id.clone(),
                        model: request.model.clone(),
                        outcome: AssistantError::ApprovalRejected.code(),
                        duration_ms: tool_started.elapsed().as_millis(),
                        message_count: messages.len(),
                        tool: Some(agent_tool.name().to_string()),
                        decision: Some("rejected".to_string()),
                    });
                    return Err(AssistantError::ApprovalRejected);
                }
                Ok(Err(err)) => {
                    let decision = match &err {
                        AssistantError::ApprovalTimeout => "timeout",
                        AssistantError::Cancelled => "cancelled",
                        _ => "error",
                    };
                    state.audit.record(AuditEntry {
                        request_id: request.request_id.clone(),
                        model: request.model.clone(),
                        outcome: err.code(),
                        duration_ms: tool_started.elapsed().as_millis(),
                        message_count: messages.len(),
                        tool: Some(agent_tool.name().to_string()),
                        decision: Some(decision.to_string()),
                    });
                    return Err(err);
                }
                // The turn's shared budget ran out while this call sat
                // waiting — distinct from `ApprovalTimeout`, which means this
                // one call alone outlived `APPROVAL_TIMEOUT`. Dropping the
                // `await_approval` future here still leaves the pending slot
                // set in `AssistantState`; `assistant_start` calls
                // `state.finish` on every exit path and that clears it by
                // `request_id`, so nothing leaks.
                Err(_) => {
                    state.audit.record(AuditEntry {
                        request_id: request.request_id.clone(),
                        model: request.model.clone(),
                        outcome: AssistantError::TimeoutTurn.code(),
                        duration_ms: tool_started.elapsed().as_millis(),
                        message_count: messages.len(),
                        tool: Some(agent_tool.name().to_string()),
                        decision: Some("timeout".to_string()),
                    });
                    return Err(AssistantError::TimeoutTurn);
                }
            }
        } else {
            // Only reachable for `read_context`, per `requires_approval`'s
            // invariant above.
            decision_label = "auto_approved";
        }

        // Off the async worker thread (`run_blocking` above):
        // `tools::execute` does blocking PTY/spawn/hashing work that must
        // not run inline here.
        let execution = {
            let app_for_exec = app.clone();
            let tool_for_exec = agent_tool.clone();
            let call_id_for_exec = call_id.clone();
            let agent_tools_enabled = request.agent_tools_enabled;
            run_blocking(move || {
                tools::execute(
                    &app_for_exec,
                    &tool_for_exec,
                    &call_id_for_exec,
                    tools_were_offered,
                    agent_tools_enabled,
                    ticket,
                )
            })
            .await
        };
        let (outcome_code, tool_outcome) = match execution {
            Ok(outcome) => ("completed".to_string(), outcome),
            Err(err) => {
                state.audit.record(AuditEntry {
                    request_id: request.request_id.clone(),
                    model: request.model.clone(),
                    outcome: err.code(),
                    duration_ms: tool_started.elapsed().as_millis(),
                    message_count: messages.len(),
                    tool: Some(agent_tool.name().to_string()),
                    decision: Some(decision_label.to_string()),
                });
                // No emit here either, for the same reason as the
                // `unknown_tool` branch above: the caller emits one `error`
                // event per `Err` outcome already.
                return Err(err);
            }
        };

        let _ = app.emit(
            STREAM_EVENT,
            StreamEvent::tool_result_with_session(
                &request.request_id,
                &call_id,
                &tool_outcome.text,
                tool_outcome.session_id.clone(),
            ),
        );

        let mut call_for_message = call.clone();
        call_for_message.id = call_id.clone();
        messages.push(engine_chat::ChatMessage {
            role: "assistant".into(),
            content: assistant_text,
            tool_calls: Some(vec![call_for_message]),
            tool_name: None,
            tool_call_id: None,
        });
        messages.push(engine_chat::ChatMessage {
            role: "tool".into(),
            content: tool_outcome.text.clone(),
            tool_calls: None,
            tool_name: Some(agent_tool.name().to_string()),
            tool_call_id: Some(call_id.clone()),
        });

        state.audit.record(AuditEntry {
            request_id: request.request_id.clone(),
            model: request.model.clone(),
            outcome: outcome_code,
            duration_ms: tool_started.elapsed().as_millis(),
            message_count: messages.len(),
            tool: Some(agent_tool.name().to_string()),
            decision: Some(decision_label.to_string()),
        });
    }

    Err(AssistantError::TooManySteps)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    pub cancelled: bool,
}

#[tauri::command]
pub fn assistant_cancel(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<CancelOutcome, String> {
    let state = app.state::<AssistantState>();
    let cancelled = state.cancel(&request_id);
    if cancelled {
        app.state::<DispatchGate>().invalidate();
        let _ = app.emit(
            STREAM_EVENT,
            StreamEvent::error(&request_id, AssistantError::Cancelled.code()),
        );
    }
    Ok(CancelOutcome { cancelled })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveOutcome {
    /// Whether the decision actually reached a waiting turn — see
    /// `AssistantState::resolve_approval`'s doc comment for what `false`
    /// covers (a stale card, or a waiter that already gave up).
    pub resolved: bool,
}

#[tauri::command]
pub fn assistant_approve_tool(
    app: tauri::AppHandle,
    request_id: String,
    call_id: String,
    approved: bool,
) -> Result<ApproveOutcome, String> {
    let state = app.state::<AssistantState>();
    let decision = if approved {
        ApprovalDecision::Approved
    } else {
        ApprovalDecision::Rejected
    };
    let resolved = state.resolve_approval(&request_id, &call_id, decision);
    Ok(ApproveOutcome { resolved })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbandonOutcome {
    /// A local (broker) or a cloud turn was running and was told to stop.
    pub cancelled_turn: bool,
    /// Stop requests sent, not confirmed ends; a session whose kill was
    /// refused stays in the registry (see `TerminalSessions::close_all`).
    pub closed_sessions: usize,
}

/// Cheap replacement for a heartbeat lease: a newly loaded renderer tells Rust
/// to drop work owned by the previous webview. Crash-without-reload is not
/// covered — a dead renderer that never loads again leaves the turn until
/// `TURN_TIMEOUT` and leaves PTYs until process exit.
#[tauri::command]
pub fn abandon_previous_renderer(app: tauri::AppHandle) -> Result<AbandonOutcome, String> {
    app.state::<DispatchGate>().invalidate();
    let state = app.state::<AssistantState>();
    let cancelled_turn = if let Some(id) = state.cancel_active() {
        let _ = app.emit(
            STREAM_EVENT,
            StreamEvent::error(&id, AssistantError::Cancelled.code()),
        );
        true
    } else {
        false
    };
    // A cloud turn the previous page started streams, and bills, into a page
    // that no longer listens, and would hold the one cloud slot.
    let cancelled_cloud_turn = app.state::<crate::ai::chat::CloudTurns>().cancel_active();
    let closed_sessions = app.state::<TerminalSessions>().close_all().requested;
    state.forget_all_agent_sessions();
    Ok(AbandonOutcome {
        cancelled_turn: cancelled_turn || cancelled_cloud_turn,
        closed_sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::super::engine_chat::MAX_TOOL_CALLS_PER_STEP;
    use super::super::tools::ContextKind;
    use super::*;

    /// Answer one request with a streamed 200 whose body `body` writes, then
    /// return a response the drain can read, as `open_chat_stream` would.
    async fn streamed(
        body: impl FnOnce(&mut std::net::TcpStream) + Send + 'static,
    ) -> reqwest::Response {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                );
                body(&mut stream);
            }
        });
        engine_chat::client()
            .unwrap()
            .post(format!("{origin}/v1/chat/completions"))
            .send()
            .await
            .unwrap()
    }

    fn text_event(text: &str) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({"choices":[{"delta":{"content": text}}]})
        )
    }

    fn calls_event(count: usize) -> String {
        let calls: Vec<_> = (0..count)
            .map(|index| {
                serde_json::json!({
                    "index": index,
                    "id": format!("c{index}"),
                    "type": "function",
                    "function": {"name": "read_context", "arguments": "{\"kind\":\"workspace\"}"}
                })
            })
            .collect();
        format!(
            "data: {}\n\ndata: {}\n\n",
            serde_json::json!({"choices":[{"delta":{"tool_calls": calls}}]}),
            serde_json::json!({"choices":[{"delta":{}, "finish_reason": "tool_calls"}]})
        )
    }

    #[tokio::test]
    async fn a_letter_split_across_two_reads_stays_whole() {
        use std::io::Write;
        let events = format!("{}data: [DONE]\n\n", text_event("ağaç"));
        let bytes = events.as_bytes().to_vec();
        // Split inside "ğ" (C4 9F): the first read ends on its lead byte.
        let cut = events.find('ğ').unwrap() + 1;
        let response = streamed(move |stream| {
            let _ = stream.set_nodelay(true);
            let _ = stream.write_all(&bytes[..cut]);
            let _ = stream.flush();
            std::thread::sleep(std::time::Duration::from_millis(80));
            let _ = stream.write_all(&bytes[cut..]);
        })
        .await;
        let tokens = std::sync::Mutex::new(String::new());
        let (text, _) = drain_chat_stream(response, "r1", &|event| {
            if let Some(token) = &event.text {
                tokens.lock().unwrap().push_str(token);
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "ağaç");
        assert_eq!(tokens.into_inner().unwrap(), "ağaç");
    }

    #[tokio::test]
    async fn an_endless_event_with_no_blank_line_is_response_too_large() {
        use std::io::Write;
        let response = streamed(|stream| {
            let _ = stream.write_all(b"data: ");
            let chunk = vec![b'x'; 64 * 1024];
            for _ in 0..64 {
                if stream.write_all(&chunk).is_err() {
                    return;
                }
            }
        })
        .await;
        let err = drain_chat_stream(response, "r1", &|_| {}).await.err();
        assert_eq!(err.map(|e| e.code()).as_deref(), Some("response_too_large"));
    }

    #[tokio::test]
    async fn nine_tool_calls_in_one_step_are_refused() {
        use std::io::Write;
        let events = calls_event(MAX_TOOL_CALLS_PER_STEP + 1);
        let response = streamed(move |stream| {
            let _ = stream.write_all(events.as_bytes());
        })
        .await;
        let err = drain_chat_stream(response, "r1", &|_| {}).await.err();
        assert_eq!(err.map(|e| e.code()).as_deref(), Some("response_too_large"));
    }

    #[tokio::test]
    async fn eight_tool_calls_are_still_collected() {
        use std::io::Write;
        let events = calls_event(MAX_TOOL_CALLS_PER_STEP);
        let response = streamed(move |stream| {
            let _ = stream.write_all(events.as_bytes());
        })
        .await;
        let (_, outcome) = drain_chat_stream(response, "r1", &|_| {}).await.unwrap();
        assert!(
            matches!(outcome, StepOutcome::ToolCalls(calls) if calls.len() == MAX_TOOL_CALLS_PER_STEP)
        );
    }

    #[tokio::test]
    async fn more_text_than_a_step_keeps_is_response_too_large() {
        use std::io::Write;
        let piece = "y".repeat(60 * 1024);
        let event = text_event(&piece);
        let response = streamed(move |stream| {
            for _ in 0..20 {
                if stream.write_all(event.as_bytes()).is_err() {
                    return;
                }
            }
        })
        .await;
        let tokens = std::sync::atomic::AtomicUsize::new(0);
        let err = drain_chat_stream(response, "r1", &|_| {
            tokens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .await
        .err();
        assert_eq!(err.map(|e| e.code()).as_deref(), Some("response_too_large"));
        // Everything kept before the cap was still streamed to the user.
        assert_eq!(
            tokens.load(std::sync::atomic::Ordering::SeqCst),
            MAX_STEP_TEXT_BYTES / piece.len()
        );
    }

    #[test]
    fn the_loop_is_bounded() {
        // A model that keeps proposing tools must terminate on its own.
        const {
            assert!(MAX_TOOL_STEPS >= 1 && MAX_TOOL_STEPS <= 10);
        }
    }

    /* ---------- what the page is told about local models ---------- */

    fn model(id: &str, state: ModelState, tools: Option<bool>) -> LocalModel {
        LocalModel {
            id: id.into(),
            name: id.into(),
            source: crate::local_engine::models::ModelSource::Ollama,
            size_bytes: 1,
            architecture: Some("gemma4".into()),
            tools,
            state,
            prepared: false,
            path: std::path::PathBuf::from("C:/m.gguf"),
            source_blob: None,
            prepared_path: None,
        }
    }

    fn local_gemma_models() -> Vec<LocalModel> {
        vec![
            model(
                "gemma4:26b",
                ModelState::NeedsPrepare { write_bytes: 10 },
                None,
            ),
            model("qwen2.5:7b", ModelState::Ready, Some(true)),
            model("tinyllama:latest", ModelState::Ready, Some(false)),
            model(
                "odd:1b",
                ModelState::Unsupported {
                    architecture: "odd".into(),
                },
                None,
            ),
        ]
    }

    #[test]
    fn health_says_what_stands_between_the_user_and_a_local_answer() {
        let models = local_gemma_models();
        let status = |installed, id: &str| health_for(installed, &models, id, None).status;
        assert_eq!(status(false, "qwen2.5:7b"), "engine_missing");
        assert_eq!(status(true, "qwen2.5:7b"), "ready");
        assert_eq!(status(true, "gemma4:26b"), "needs_prepare");
        assert_eq!(status(true, "odd:1b"), "unsupported");
        assert_eq!(status(true, "gone:1b"), "model_missing");
        let report = health_for(true, &models, "odd:1b", None);
        assert_eq!(report.detail.as_deref(), Some("odd"));
        // Only models the engine can run, or will after a copy, are offered.
        assert_eq!(
            report.models,
            ["gemma4:26b", "qwen2.5:7b", "tinyllama:latest"]
        );
    }

    #[test]
    fn health_names_the_engine_address_only_for_the_model_it_runs() {
        let models = local_gemma_models();
        let running = Some((
            "qwen2.5:7b".to_string(),
            "http://127.0.0.1:50000".to_string(),
        ));
        let report = health_for(true, &models, "qwen2.5:7b", running.clone());
        assert_eq!(report.endpoint.as_deref(), Some("http://127.0.0.1:50000"));
        assert_eq!(report.selected_model.as_deref(), Some("qwen2.5:7b"));
        let other = health_for(true, &models, "tinyllama:latest", running);
        assert_eq!(other.endpoint, None);
    }

    #[test]
    fn tool_support_comes_from_the_model_template_and_unknown_stays_unknown() {
        let models = local_gemma_models();
        let infos: Vec<_> = models
            .iter()
            .filter(|m| listed(m))
            .map(model_info)
            .collect();
        assert_eq!(infos.len(), 3);
        assert_eq!(infos[0].tools, None, "no template: unknown, never false");
        assert_eq!(infos[1].tools, Some(true));
        assert_eq!(infos[1].capabilities, ["completion", "tools"]);
        assert_eq!(infos[2].tools, Some(false));
        assert_eq!(infos[2].capabilities, ["completion"]);
    }

    #[test]
    fn auto_approve_reads_only_ever_weakens_the_gate_for_read_context() {
        let read = AgentTool::ReadContext {
            kind: ContextKind::Project,
        };
        assert!(requires_approval(&read, false));
        assert!(!requires_approval(&read, true));

        let run = AgentTool::TerminalRun {
            session_id: None,
            command: "whoami".into(),
        };
        // The preference must never weaken the gate for a side-effecting
        // tool, in either position.
        assert!(requires_approval(&run, false));
        assert!(requires_approval(&run, true));

        let launch = AgentTool::LaunchTool {
            tool_id: "tool-nmap".into(),
            args: vec![],
        };
        assert!(requires_approval(&launch, false));
        assert!(requires_approval(&launch, true));
    }

    // -- Tools are advertised only when both gates are true ----------

    #[test]
    fn neither_flag_alone_advertises_tools() {
        // Opt-in without consent: this is the case that used to kill the
        // whole turn with ConsentRequired on the very first proposed call.
        assert!(!agent_tools_should_be_offered(true, false));
        // Consent without opt-in: the default for every existing
        // "answer only" user — must not silently start acting.
        assert!(!agent_tools_should_be_offered(false, true));
        // Neither: obviously off.
        assert!(!agent_tools_should_be_offered(false, false));
    }

    #[test]
    fn both_flags_together_advertise_tools() {
        assert!(agent_tools_should_be_offered(true, true));
    }

    #[test]
    fn call_ids_are_unique_even_when_a_request_id_repeats() {
        // The generator takes no input at all, so neither a model-supplied
        // `call.id` nor the renderer's request id can shape it. Two turns
        // carrying the same request id (refused at start now, but this must
        // not be the only defence) still get distinct ids at every step.
        let ids: std::collections::HashSet<String> = (0..10_000).map(|_| new_call_id()).collect();
        assert_eq!(ids.len(), 10_000);
    }

    #[test]
    fn turn_timeout_is_the_true_worst_case_and_at_least_as_long_as_one_step() {
        // TURN_TIMEOUT must actually bound the turn (finite, matches the
        // documented `MAX_TOOL_STEPS * (TOTAL_TIMEOUT + APPROVAL_TIMEOUT)`
        // formula so the ADR's stated number and the code can't drift apart),
        // and it must be at least one step's worth of budget, or the very
        // first step would be cut off before it could ever complete a
        // response, let alone wait for approval.
        let one_step = engine_chat::TOTAL_TIMEOUT + APPROVAL_TIMEOUT;
        assert_eq!(
            TURN_TIMEOUT,
            one_step * u32::try_from(MAX_TOOL_STEPS).unwrap()
        );
        assert!(TURN_TIMEOUT >= one_step);
    }

    // -- tools::execute runs off the async worker thread -----------

    #[tokio::test]
    async fn run_blocking_returns_the_closures_own_ok_unchanged() {
        let result = run_blocking(|| Ok::<_, AssistantError>(42)).await;
        assert_eq!(result, Ok(42));
    }

    #[tokio::test]
    async fn run_blocking_returns_the_closures_own_err_unchanged() {
        let result: Result<i32, AssistantError> =
            run_blocking(|| Err(AssistantError::ToolFailed)).await;
        assert_eq!(result, Err(AssistantError::ToolFailed));
    }

    #[tokio::test]
    async fn run_blocking_flattens_a_panicking_closure_into_an_internal_error_instead_of_propagating_the_panic(
    ) {
        let result: Result<i32, AssistantError> =
            run_blocking(|| -> Result<i32, AssistantError> { panic!("boom") }).await;
        assert!(matches!(result, Err(AssistantError::Internal(_))));
    }

    #[tokio::test]
    async fn run_blocking_actually_runs_off_the_calling_task_so_it_cannot_deadlock_a_current_thread_runtime(
    ) {
        // A `current_thread` runtime (as `#[tokio::test]` uses by default)
        // has exactly one thread driving async tasks. If `run_blocking` ran
        // `f` inline rather than truly handing it to the separate blocking
        // pool, a blocking sleep inside `f` would starve that one thread and
        // this test itself would never resume -- so this test passing at
        // all (within its timeout) is direct evidence the work is not
        // running on the runtime's own worker thread. `spawn_blocking` is
        // available on a `current_thread` runtime precisely because it has
        // its own separate pool.
        let ran = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_blocking(|| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                Ok::<_, AssistantError>(())
            }),
        )
        .await;
        assert!(
            ran.is_ok(),
            "run_blocking did not complete off-thread in time"
        );
    }

    #[test]
    fn a_refusal_is_labelled_by_its_cause_not_lumped_under_the_allowlist() {
        // The first version of this filed all three of `parse_tool_call`'s
        // failure modes under "refused_not_allowlisted". A newline embedded in
        // a `terminal_run` command -- an attempt to turn one approval into
        // several executed commands -- was therefore logged as if the model had
        // merely named a tool that does not exist. These assertions are what
        // would have caught that.
        let (tool, decision) = refusal_labels(&AssistantError::UnknownTool);
        assert_eq!(tool, REFUSED_TOOL_PLACEHOLDER);
        assert_eq!(decision, "refused_not_allowlisted");

        let (tool, decision) = refusal_labels(&AssistantError::UnsolicitedTool);
        assert_eq!(tool, REFUSED_UNSOLICITED_PLACEHOLDER);
        assert_eq!(decision, "refused_unsolicited");

        // An allowlisted tool whose arguments were refused. `Internal` is what
        // `parse_tool_call` returns for the embedded-newline ban and for a
        // typed-parse failure.
        let (tool, decision) = refusal_labels(&AssistantError::Internal(
            "terminal_run command must not contain embedded newlines".into(),
        ));
        assert_eq!(tool, REFUSED_ARGS_PLACEHOLDER);
        assert_eq!(decision, "refused_invalid_arguments");
        assert_ne!(
            decision, "refused_not_allowlisted",
            "an argument refusal must stay distinguishable from an unknown name",
        );

        // Neither label may carry the model's own text: the name is untrusted
        // free text and `audit.rs` records shape, not content.
        for label in [REFUSED_TOOL_PLACEHOLDER, REFUSED_ARGS_PLACEHOLDER] {
            assert!(label.starts_with('<') && label.ends_with('>'), "{label}");
        }
    }

    #[test]
    fn a_refused_proposal_is_logged_without_the_model_supplied_name() {
        // `assistantPermissions.ts` requires a log of EVERY proposal, approved
        // or not. The refusal path used to return before writing one, so an
        // out-of-allowlist proposal left no trace at all.
        let log = crate::assistant::audit::AuditLog::default();
        log.record(AuditEntry {
            request_id: "r1".into(),
            model: "m".into(),
            outcome: AssistantError::UnknownTool.code(),
            duration_ms: 1,
            message_count: 2,
            tool: Some(REFUSED_TOOL_PLACEHOLDER.to_string()),
            decision: Some("refused_not_allowlisted".to_string()),
        });

        let json = serde_json::to_string(&log.entries()[0]).unwrap();
        assert!(json.contains("unknown_tool"), "{json}");
        assert!(json.contains("refused_not_allowlisted"), "{json}");
        // The name the model actually sent is attacker-influenced free text.
        // The placeholder stands in for it deliberately; if this ever starts
        // carrying the real name, `audit.rs`'s shape-not-content rule broke.
        assert_eq!(REFUSED_TOOL_PLACEHOLDER, "<not-allowlisted>");
        assert!(!REFUSED_TOOL_PLACEHOLDER.is_empty());
    }

    #[test]
    fn abandon_outcome_is_camel_case_on_the_wire() {
        let json = serde_json::to_string(&AbandonOutcome {
            cancelled_turn: true,
            closed_sessions: 2,
        })
        .unwrap();
        assert!(json.contains("cancelledTurn"), "{json}");
        assert!(json.contains("closedSessions"), "{json}");
        assert!(!json.contains("cancelled_turn"), "{json}");
        assert!(!json.contains("closed_sessions"), "{json}");
    }

    fn gathered() -> Gathered {
        Gathered {
            block: "[WEB CONTENT n: untrusted]\n[1] T\nURL: https://a.example/\nbody\n[END WEB CONTENT n]"
                .into(),
            sources: vec![web::WebSource {
                url: "https://a.example/".into(),
                title: "T".into(),
            }],
        }
    }

    #[test]
    fn the_guard_line_joins_the_system_message_and_the_web_text_goes_before_the_question() {
        let frame = "You are Qutra, a local assistant.

CONTEXT (read-only)
Name: Acme
END CONTEXT"
            .to_string();
        let mut messages = vec![
            plain_message("system", frame.clone()),
            plain_message("user", "first".into()),
            plain_message("assistant", "answer".into()),
            plain_message("user", "second".into()),
        ];
        apply_web(&mut messages, Some(&gathered()));
        // The existing frame is kept whole; the guard follows it.
        assert!(messages[0].content.starts_with(&frame));
        assert!(messages[0].content.ends_with(web::GUARD_LINE));
        assert!(web::GUARD_LINE.contains("never instructions"));
        // Only the question being asked carries web text, ahead of it.
        assert_eq!(messages[1].content, "first");
        assert!(messages[3]
            .content
            .starts_with("[WEB CONTENT n: untrusted]"));
        assert!(messages[3].content.ends_with("\n\nsecond"));
        assert_eq!(messages.len(), 4);
    }

    #[test]
    fn a_turn_with_no_system_message_gets_one_with_the_guard_even_when_nothing_was_found() {
        let mut messages = vec![plain_message("user", "hello".into())];
        apply_web(&mut messages, None);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, web::GUARD_LINE);
        assert_eq!(messages[1].content, "hello");
    }

    #[test]
    fn the_page_text_budget_follows_the_context_window() {
        assert_eq!(web_budget(2_048), 3_000);
        assert_eq!(web_budget(8_192), 8_192);
        assert_eq!(web_budget(131_072), 12_000);
    }

    #[test]
    fn the_internet_defaults_off_and_reads_as_camel_case() {
        let without: StartRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r", "enabled": true, "model": "m", "contextTokens": 4096, "messages": []
        }))
        .unwrap();
        assert!(!without.web_access);
        let with: StartRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r", "enabled": true, "model": "m", "contextTokens": 4096,
            "messages": [], "webAccess": true
        }))
        .unwrap();
        assert!(with.web_access);
    }

    #[test]
    fn the_pages_read_reach_the_page_as_a_sources_event() {
        let event = StreamEvent::web_sources("r1", gathered().sources);
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "web_sources");
        assert_eq!(json["sources"][0]["url"], "https://a.example/");
        assert!(json.get("status").is_none());
        // No other event carries a sources field.
        let token = serde_json::to_value(StreamEvent::token("r1", "x".into())).unwrap();
        assert!(token.get("sources").is_none());
    }
}
