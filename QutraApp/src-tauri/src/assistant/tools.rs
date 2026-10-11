//! The three allowlisted agent tools (ADR 0012, Decisions 1 and 3).
//!
//! This module is the only place a parsed model tool call turns into an
//! action. `parse_tool_call` accepts exactly the three literal names below —
//! no trimming, no case folding, no prefix or fuzzy matching — and an
//! unrecognized name is `AssistantError::UnknownTool`, final. `execute` never
//! receives a path or a working directory from the model: `launch_tool`
//! carries a `toolId` resolved through `ToolSupervisor::resolve_launchable`,
//! and `terminal_run` carries an optional existing PTY session id, never a
//! program.
//!
//! This is the SOLE definition of the closed allowlist. A TypeScript mirror
//! (`src/domain/assistantTools.ts`) existed during development and was
//! deleted: nothing called it — the approval card renders the summary this
//! module sends over the wire — so it was a hand-synced second copy of a
//! security allowlist that could drift silently while inviting a reader to
//! believe the renderer enforced something. See ADR 0012, Decision 1
//! (amended). Do not reintroduce one.
//!
//! `argv` (the `args: Vec<String>` on `LaunchTool`) holds only what
//! actually gets spawned; a destination id (`tool_id`, `session_id`) is never
//! folded into it.

use tauri::Manager;

use super::broker::AssistantState;
use super::dispatch::{DispatchGate, Ticket};
use super::engine_chat::ToolCall;
use super::error::AssistantError;
use crate::consent::PrivateToolsConsent;
use crate::launch_receipts::{
    self, LaunchOrigin, LaunchOutcome, LaunchReceipt, LaunchReceipts, LaunchRequest,
};
use crate::terminal::{commands::open_shell_session, lifecycle::SessionOrigin, TerminalSessions};
use crate::tool_supervisor::{self, ToolSupervisor};

/// Hard ceiling, in characters, on what `read_context` may return. Named so
/// a reviewer can find the one place that bounds it — an unbounded project
/// summary would blow both the model's context window and the
/// `tool_result` event payload. Mirrors the role of `CONTEXT_LIMITS.total`
/// in `src/domain/assistantContext.ts`, though the two are not the same
/// number: that constant bounds a renderer-assembled block of project/
/// resource metadata; this one bounds the plain-text block this module
/// assembles from the Rust-side records it actually has access to.
pub const READ_CONTEXT_CHAR_LIMIT: usize = 2_000;

/// Most registered tools `read_context("resources")` lists individually
/// before summarizing the rest as a count, so a large registry cannot by
/// itself blow `READ_CONTEXT_CHAR_LIMIT` open one entry at a time.
const READ_CONTEXT_MAX_TOOLS_LISTED: usize = 10;

/// A default, unattached terminal session for `terminal_run` when the model
/// did not name an existing one — the same shell `openShellTab` opens by
/// default in the terminal UI (`src/features/terminal/terminalTabs.ts`).
const DEFAULT_TERMINAL_SHELL: &str = "pwsh";
const DEFAULT_TERMINAL_COLS: u16 = 80;
const DEFAULT_TERMINAL_ROWS: u16 = 24;

/// Which part of the context `read_context` was asked for. The closed `kind` set
/// is `["project", "resources", "findings"]` — deriving `Deserialize`
/// over this enum, rather than accepting a bare `String`, means an
/// unrecognized kind is rejected by the same typed parse as a malformed
/// `command` or `toolId`, with no separate validation step to forget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    Project,
    Resources,
    Findings,
}

impl ContextKind {
    fn label(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Resources => "resources",
            Self::Findings => "findings",
        }
    }
}

/// The Ollama tool-schema array sent to the model on a turn that allows tool
/// calls — which, since ADR 0012 Decision 1b, means a turn where the user
/// opted in AND Private Lab consent is granted. This is the only definition
/// of the tool surface anywhere in the app; this is the definition the agent loop
/// (`commands.rs::run_turn`) references, so there is only one place here
/// that can drift from the TS side, not two.
pub fn agent_tool_schema() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "terminal_run",
                "description": "Run a command in a terminal PTY session that is visible to the user. The command text is sent as-is to the PTY; it is not assembled from unrelated fragments.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sessionId": {
                            "type": "string",
                            "description": "Existing terminal session to run the command in, if any."
                        },
                        "command": {
                            "type": "string",
                            "description": "The exact command line to send to the PTY."
                        }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "launch_tool",
                "description": "Launch a registered lab tool by its tool id. `toolId` identifies an entry in the tool registry, not a filesystem path or an arbitrary executable.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "toolId": {
                            "type": "string",
                            "description": "Id of a registered lab tool, e.g. \"tool-nmap\"."
                        },
                        "args": {
                            "type": "string",
                            "description": "Optional argument string passed to the tool."
                        }
                    },
                    "required": ["toolId"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_context",
                "description": "Read-only: fetch a summary of the requested context. Never writes, never executes anything.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["project", "resources", "findings"],
                            "description": "Which part of the context to read."
                        }
                    },
                    "required": ["kind"],
                    "additionalProperties": false
                }
            }
        }
    ])
}

/// One parsed, allowlisted tool call. Produced only by `parse_tool_call`, so
/// every value in the wild has already passed the exact-name check and the
/// typed argument parse — there is no other constructor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentTool {
    /// Send `command` to the PTY session named by `session_id`, or a fresh
    /// default shell session when `session_id` is `None`.
    TerminalRun {
        session_id: Option<String>,
        command: String,
    },
    /// Launch a registered installation named by `tool_id`. `args` is
    /// already a parsed argv — never an assembled shell string — and the
    /// model never supplies a path: `tool_id` is resolved server-side.
    LaunchTool { tool_id: String, args: Vec<String> },
    /// Read-only: assemble a bounded summary of the requested part of the context.
    ReadContext { kind: ContextKind },
}

impl AgentTool {
    /// The allowlisted name this value was parsed from — one of the three
    /// literals `parse_tool_call` matches on. Used for the audit entry's
    /// `tool` field and for the `tool_call`/`tool_result` stream events.
    pub fn name(&self) -> &'static str {
        match self {
            AgentTool::TerminalRun { .. } => "terminal_run",
            AgentTool::LaunchTool { .. } => "launch_tool",
            AgentTool::ReadContext { .. } => "read_context",
        }
    }

    /// Every tool except `read_context` can change something outside the
    /// model's own context window, and therefore requires explicit approval
    /// (ADR 0012, Decision 2).
    pub fn is_side_effecting(&self) -> bool {
        !matches!(self, AgentTool::ReadContext { .. })
    }

    /// The exact action, in plain text, for the approval card. Built purely
    /// from the parsed call — never from the model's own prose — and always
    /// from the same `argv` `execute` runs, so what the user reads and what
    /// runs cannot disagree.
    ///
    /// A pure function of `self` alone, with no `ToolSupervisor` to resolve
    /// `LaunchTool`'s `tool_id` against — so for that variant this is a
    /// fallback shape (`"Launch tool: {tool_id}"`), not the string the
    /// approval card actually shows. `run_turn` (`commands.rs`), the one
    /// call site that builds a card, calls `summary_for_approval` below
    /// instead, which has the `ToolSupervisor` this method lacks. Kept pure
    /// and public because it's still what `Debug`-ish call sites and the
    /// tests in this module want: something that needs no app state.
    ///
    /// Invisible and direction-changing characters are shown as escapes (see
    /// `show_hidden_characters`), so the card cannot read differently from
    /// what runs.
    pub fn summary(&self) -> String {
        show_hidden_characters(&self.raw_summary())
    }

    fn raw_summary(&self) -> String {
        match self {
            AgentTool::TerminalRun {
                session_id,
                command,
            } => match session_id {
                Some(id) => format!("Run in terminal session {id}: {command}"),
                None => format!("Run in a new terminal session: {command}"),
            },
            AgentTool::LaunchTool { tool_id, args } => {
                if args.is_empty() {
                    format!("Launch tool: {tool_id}")
                } else {
                    format!("Launch tool: {tool_id} {}", format_argv_for_summary(args))
                }
            }
            AgentTool::ReadContext { kind } => format!("Read context: {}", kind.label()),
        }
    }
}

/// The string `run_turn` actually shows on the approval card (ADR 0012
/// Decision 2's "visible summary of the exact action"). Identical to
/// `AgentTool::summary()` for every variant except `LaunchTool`, where a
/// bare installation uuid is not something a human can recognize: this
/// resolves `tool_id` through `ToolSupervisor::resolve_launch_display_name`
/// — the same identity gate `execute_launch_tool` resolves through at
/// execution time, not a second, weaker lookup — and renders the display
/// name alongside the id instead.
///
/// Never renders a path or a working directory: `resolve_launch_display_name`
/// hands back only the name precisely so this function has no path to leak
/// even by accident (ADR 0012 Decision 3 extended to what the approval card
/// may say, not only to what the model may supply).
///
/// A resolution failure — unregistered, disabled, drifted since verify —
/// is rendered as a plain-language reason, never silently swallowed into a
/// summary that looks like a normal, healthy launch. The id alone is not
/// "the exact action" either, so on failure the id is kept in the summary
/// alongside the reason rather than dropped.
///
/// `run_turn` now takes the sentence and the facts together from
/// `approval_for`; this stays for the tests that pin the sentence alone.
#[cfg(test)]
pub fn summary_for_approval(supervisor: &ToolSupervisor, tool: &AgentTool) -> String {
    approval_for(supervisor, tool).0
}

/// The proposed action as facts (data contracts §2), sent on the
/// `tool_call` event beside the sentence so the card can show the exact
/// command, and for a launch the identity evidence, without parsing prose.
/// Every text in it has hidden characters shown as escapes, as the summary
/// does. Nothing here is an assessment: there is no scope or effect verdict,
/// and the card must say so rather than imply one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalAction {
    TerminalRun {
        session_id: Option<String>,
        command: String,
    },
    LaunchTool {
        installation_id: String,
        /// `None` when the identity gate refused the installation.
        display_name: Option<String>,
        /// The argv exactly as `execute` passes it, rendered once
        /// (`format_argv_for_summary`).
        args_text: String,
        identity: LaunchIdentity,
    },
    ReadContext {
        context_kind: String,
    },
}

/// What the identity gate found for a proposed launch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LaunchIdentity {
    /// The file still hashes to the registered SHA-256. It is checked again
    /// when the launch runs.
    Verified { sha256: String, risk_tier: String },
    /// The gate refused; `reason` is its stable code.
    Blocked { reason: String },
}

/// The approval card's sentence and the same action as facts, from one
/// resolution of a launch's identity.
pub fn approval_for(supervisor: &ToolSupervisor, tool: &AgentTool) -> (String, ApprovalAction) {
    match tool {
        AgentTool::TerminalRun {
            session_id,
            command,
        } => (
            tool.summary(),
            ApprovalAction::TerminalRun {
                session_id: session_id.clone(),
                command: show_hidden_characters(command),
            },
        ),
        AgentTool::LaunchTool { tool_id, args } => {
            let args_text = show_hidden_characters(&format_argv_for_summary(args));
            let installation_id = show_hidden_characters(tool_id);
            match supervisor.resolve_launch_facts(tool_id) {
                Ok(facts) => {
                    let raw = if args.is_empty() {
                        format!("Launch tool: {} ({tool_id})", facts.display_name)
                    } else {
                        format!(
                            "Launch tool: {} ({tool_id}) {}",
                            facts.display_name,
                            format_argv_for_summary(args)
                        )
                    };
                    (
                        show_hidden_characters(&raw),
                        ApprovalAction::LaunchTool {
                            installation_id,
                            display_name: Some(show_hidden_characters(&facts.display_name)),
                            args_text,
                            identity: LaunchIdentity::Verified {
                                sha256: facts.sha256,
                                risk_tier: facts.risk_tier,
                            },
                        },
                    )
                }
                Err(reason) => (
                    show_hidden_characters(&format!(
                        "Launch tool: {tool_id} ({})",
                        describe_resolution_failure(&reason)
                    )),
                    ApprovalAction::LaunchTool {
                        installation_id,
                        display_name: None,
                        args_text,
                        identity: LaunchIdentity::Blocked { reason },
                    },
                ),
            }
        }
        AgentTool::ReadContext { kind } => (
            tool.summary(),
            ApprovalAction::ReadContext {
                context_kind: kind.label().to_string(),
            },
        ),
    }
}

/// Plain-language rendering of a `resolve_launch_display_name` /
/// `resolve_launchable` failure code, for the one place (the approval card)
/// that must show a human a reason rather than a bare internal string. An
/// unrecognized code — a future addition to the identity gate this wasn't
/// updated for — still gets an honest, generic phrase rather than silently
/// falling through to something that reads like success.
fn describe_resolution_failure(reason: &str) -> &'static str {
    match reason {
        "tool_not_found" => "no installation with this id is registered",
        "tool_disabled" => "this installation is disabled",
        "tool_identity_changed" => {
            "this installation's file has changed since it was last verified"
        }
        "tool_path_missing" => "this installation's file is missing",
        "tool_path_not_file" => "this installation's path is not a file",
        "unsupported_tool_type" => "this installation's file type is not supported",
        "invalid_tool_id" => "this id is not a valid installation id",
        _ => "this installation's identity could not be verified",
    }
}

// `deny_unknown_fields` on all three: `agent_tool_schema()` declares
// `additionalProperties: false` for every tool, so a stray field the model
// invents is rejected here too rather than silently ignored while the schema
// sent to the model says it cannot happen.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalRunArgs {
    #[serde(default)]
    session_id: Option<String>,
    command: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchToolArgs {
    tool_id: String,
    #[serde(default)]
    args: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadContextArgs {
    kind: ContextKind,
}

/// Parse one model-proposed call against the closed allowlist.
///
/// `call.function.name` is matched against exactly the three literals
/// below — no `.trim()`, no `.to_lowercase()`, no `starts_with`, no
/// alias table. Anything else, including a name that merely looks close
/// (trailing space, different case, an extra character, a shortened form),
/// is `AssistantError::UnknownTool`. A refusal here is final: there is no
/// second, fuzzier attempt to resolve it.
///
/// A recognized name whose `arguments` do not fit that tool's shape is
/// `AssistantError::Internal` — the detail carries the low-level serde
/// message and is never shown verbatim to the user (see
/// `AssistantError::Internal`'s own contract). The same code covers a
/// `terminal_run.command` that parses fine as a string but contains an
/// embedded `\r` or `\n`: ADR 0012 Decision 2 makes approval per-call, and a
/// command is not the single call it was approved as once it can drive the
/// PTY through more than one line — so that shape is rejected here,
/// outright, rather than silently normalized. `execute`'s own errors, by
/// contrast, are `AssistantError::ToolFailed` (see that function) — this is
/// the parse boundary, before any executor runs.
/// Longest `terminal_run` command, in characters. Long enough for any
/// one-liner a person would type; short enough to read on an approval card.
pub const MAX_COMMAND_CHARS: usize = 4096;

/// Most `launch_tool` arguments after tokenizing; a real tool invocation
/// has a handful, and every one is shown on the card.
pub const MAX_LAUNCH_ARGS: usize = 32;

/// Longest single `launch_tool` argument, in characters.
pub const MAX_LAUNCH_ARG_CHARS: usize = 1024;

pub fn parse_tool_call(call: &ToolCall) -> Result<AgentTool, AssistantError> {
    match call.function.name.as_str() {
        "terminal_run" => {
            let args: TerminalRunArgs = serde_json::from_value(call.function.arguments.clone())
                .map_err(|e| AssistantError::Internal(e.to_string()))?;
            if args.command.chars().count() > MAX_COMMAND_CHARS {
                return Err(AssistantError::ResponseTooLarge);
            }
            if args.command.contains('\r') || args.command.contains('\n') {
                return Err(AssistantError::Internal(
                    "terminal_run command must not contain embedded newlines".into(),
                ));
            }
            if args.command.chars().any(is_forbidden_control) {
                return Err(AssistantError::Internal(
                    "terminal_run command must not contain control characters".into(),
                ));
            }
            Ok(AgentTool::TerminalRun {
                session_id: args.session_id,
                command: args.command,
            })
        }
        "launch_tool" => {
            let args: LaunchToolArgs = serde_json::from_value(call.function.arguments.clone())
                .map_err(|e| AssistantError::Internal(e.to_string()))?;
            let argv = args
                .args
                .as_deref()
                .map(tokenize_tool_args)
                .unwrap_or_default();
            if argv.len() > MAX_LAUNCH_ARGS
                || argv
                    .iter()
                    .any(|a| a.chars().count() > MAX_LAUNCH_ARG_CHARS)
            {
                return Err(AssistantError::ResponseTooLarge);
            }
            if argv.iter().any(|a| a.chars().any(is_forbidden_control)) {
                return Err(AssistantError::Internal(
                    "launch_tool args must not contain control characters".into(),
                ));
            }
            Ok(AgentTool::LaunchTool {
                tool_id: args.tool_id,
                args: argv,
            })
        }
        "read_context" => {
            let args: ReadContextArgs = serde_json::from_value(call.function.arguments.clone())
                .map_err(|e| AssistantError::Internal(e.to_string()))?;
            Ok(AgentTool::ReadContext { kind: args.kind })
        }
        _ => Err(AssistantError::UnknownTool),
    }
}

/// Split a `launch_tool` argument string into argv tokens. Quoting rules:
/// whitespace separates tokens outside quotes; a double quote opens a segment
/// that runs to the next one; an unterminated quote keeps the literal `"` and
/// swallows the rest of the string, including whitespace, into one token —
/// visibly odd rather than silently mangled, so the card shows what will run.
/// Kept in lockstep with the TS version deliberately: the two sides parse
/// the same model output and must agree on what argv it produces.
///
/// One accepted micro-divergence: the TS tokenizer's whitespace test is the
/// JS regex `/\s/`, which — per the ECMAScript spec's own special case —
/// matches `U+FEFF` (zero-width no-break space / byte-order mark) in
/// addition to the Unicode `White_Space` set. Rust's `char::is_whitespace`
/// follows Unicode `White_Space` only, which excludes `U+FEFF`. Left
/// un-aligned on purpose: a `U+FEFF` landing mid-argument in model-proposed
/// text is not a realistic case worth a hand-rolled whitespace predicate to
/// chase, and the two sides already agree on the entire ASCII and
/// common-Unicode-whitespace surface that model output actually exercises.
fn tokenize_tool_args(input: &str) -> Vec<String> {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let mut tokens = Vec::new();

    while i < n {
        while i < n && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }

        let mut token = String::new();
        while i < n && !chars[i].is_whitespace() {
            if chars[i] == '"' {
                match chars[i + 1..].iter().position(|&c| c == '"') {
                    Some(rel) => {
                        let close = i + 1 + rel;
                        token.extend(chars[i + 1..close].iter().copied());
                        i = close + 1;
                    }
                    None => {
                        token.extend(chars[i..].iter().copied());
                        i = n;
                    }
                }
            } else {
                token.push(chars[i]);
                i += 1;
            }
        }
        tokens.push(token);
    }

    tokens
}

/// Render one argv token for a summary line, quoting it if it contains
/// whitespace (or is empty) so it cannot be mistaken for a token boundary
/// once printed.
fn format_argv_token(token: &str) -> String {
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        format!("\"{}\"", token.replace('"', "\\\""))
    } else {
        token.to_string()
    }
}

/// A C0 control character other than TAB. Such a character in a command or
/// an argument can rewrite the terminal (ESC sequences), ring it (BEL) or end
/// a line, so what was approved would not be what the PTY sees.
fn is_forbidden_control(c: char) -> bool {
    (c as u32) < 0x20 && c != '\t'
}

/// Characters that change or hide what a reader sees without being visible
/// themselves: C0 (bar TAB) and C1 controls, zero-width and bidi marks,
/// invisible operators, isolates, and the BOM.
fn is_hidden_character(c: char) -> bool {
    matches!(
        c as u32,
        0x00..=0x08
            | 0x0A..=0x1F
            | 0x7F..=0x9F
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x2069
            | 0xFEFF
    )
}

/// Render every hidden character as `\u{XXXX}` for an approval card.
fn show_hidden_characters(text: &str) -> String {
    let mut shown = String::with_capacity(text.len());
    for c in text.chars() {
        if is_hidden_character(c) {
            shown.push_str(&format!("\\u{{{:04X}}}", c as u32));
        } else {
            shown.push(c);
        }
    }
    shown
}

/// The only place that renders argv as text, so `summary()` can never drift
/// from the argv `execute` actually runs.
fn format_argv_for_summary(argv: &[String]) -> String {
    argv.iter()
        .map(|t| format_argv_token(t))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Truncate `text` to at most `limit` characters, appending an ellipsis
/// when something was cut. Character-counted (not byte-counted) so a
/// multi-byte character is never split in half.
fn cap_text(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let truncated: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{truncated}\u{2026}")
}

/// The result of running one approved tool call. `text` is what feeds both
/// the `tool_result` stream event's `summary` and the `role: "tool"` message
/// appended to the conversation for the model to see.
///
/// `session_id` is populated only by `TerminalRun`, carrying the PTY session
/// id actually used (an existing one, or a freshly opened default shell) —
/// a structured field rather than something the renderer would have to
/// parse out of `text`'s prose (`"Sent to terminal session {id}"`). An
/// agent-opened terminal session needs a tab in the UI, and the id reaching
/// the renderer in a parseable field is what the renderer needs to create
/// one; creating the tab itself is the renderer's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    pub text: String,
    pub session_id: Option<String>,
}

/// Whether a returned tool call may reach an executor.
///
/// Omitting the schema is not a dispatch denial (TM-002). A listener can
/// still emit an allowlisted call, and `read_context` with
/// `auto_approve_reads` would otherwise run with no card. This check is
/// therefore a pure function of the three facts that decide authorization:
/// the schema was offered on this step, the agent-tools preference is still
/// on, and Private Lab consent is still granted. `auto_approve_reads` is
/// deliberately **not** an input — it may only skip the human card for a
/// *solicited* read, never admit an unsolicited one.
///
/// Tested against every combination, including the TM-002 case (Private Lab
/// on, agent off) and a solicited `read_context` with auto-approve on.
pub fn authorize_tool_dispatch(
    tools_were_offered: bool,
    agent_tools_enabled: bool,
    consent_granted: bool,
) -> Result<(), AssistantError> {
    if !tools_were_offered || !agent_tools_enabled {
        return Err(AssistantError::UnsolicitedTool);
    }
    if !consent_granted {
        return Err(AssistantError::ConsentRequired);
    }
    Ok(())
}

/// Gate, then run `executor`. Extracted so tests can assert the executor is
/// never entered when agent consent is absent, without a `tauri::AppHandle`.
pub fn execute_if_authorized<F, T>(
    tools_were_offered: bool,
    agent_tools_enabled: bool,
    consent_granted: bool,
    executor: F,
) -> Result<T, AssistantError>
where
    F: FnOnce() -> Result<T, AssistantError>,
{
    authorize_tool_dispatch(tools_were_offered, agent_tools_enabled, consent_granted)?;
    executor()
}

/// Run one parsed, already-approved (for the side-effecting variants) tool
/// call. This is the only place in the crate that turns an `AgentTool` into
/// a spawn or a PTY write.
///
/// Gated on agent authorization **and** Private Lab consent before the
/// match. Omitting the tool schema is not enough: `authorize_tool_dispatch`
/// re-checks the same conjunction `run_turn` uses to decide whether to
/// advertise tools, so an unsolicited call cannot reach a PTY or a launch
/// even if `run_turn` is skipped. Consent is revocable mid-turn
/// (`consent.rs`); this is not redundant with the check at turn start.
///
/// Called by the agent loop (`commands.rs::run_turn`) only after
/// `AssistantState::await_approval` has resolved `Approved` for a
/// side-effecting tool (or immediately, for an auto-approved read) — and
/// only after that loop has already refused unsolicited calls. The
/// authorization half is tested via `execute_if_authorized`; the native
/// dispatch still needs a production `AppHandle` and is not mocked here.
pub fn execute(
    app: &tauri::AppHandle,
    tool: &AgentTool,
    call_id: &str,
    tools_were_offered: bool,
    agent_tools_enabled: bool,
    ticket: Ticket,
) -> Result<ToolOutcome, AssistantError> {
    let consent_granted = app.state::<PrivateToolsConsent>().is_granted();
    execute_if_authorized(
        tools_were_offered,
        agent_tools_enabled,
        consent_granted,
        || dispatch_execute(app, tool, call_id, ticket),
    )
}

fn dispatch_execute(
    app: &tauri::AppHandle,
    tool: &AgentTool,
    call_id: &str,
    ticket: Ticket,
) -> Result<ToolOutcome, AssistantError> {
    match tool {
        AgentTool::LaunchTool { tool_id, args } => {
            execute_launch_tool(app, tool_id, args, call_id, ticket).map(|text| ToolOutcome {
                text,
                session_id: None,
            })
        }
        AgentTool::TerminalRun {
            session_id,
            command,
        } => execute_terminal_run(app, session_id.as_deref(), command, ticket),
        AgentTool::ReadContext { kind } => {
            execute_read_context(app, *kind).map(|text| ToolOutcome {
                text,
                session_id: None,
            })
        }
    }
}

/// Resolve `tool_id` through `ToolSupervisor::resolve_launchable` — the
/// same identity gate `launch_tool_detached` (`lib.rs`) uses — and spawn it
/// exactly as that command does, via `build_detached_command`. The model
/// supplies only an id; the executable path and working directory come
/// from the registry, never from `tool` or `args`.
///
/// Almost every failure here is `AssistantError::ToolFailed`: `tool_id` and
/// `args` already passed `parse_tool_call`'s typed parse, consent already
/// passed in `execute`, so nothing left to fail is a malformed call or an
/// unauthorized one — a missing/disabled/identity-changed installation or a
/// generic spawn error is this approved call's own executor failing to do
/// what it was approved to do, which is exactly `ToolFailed`'s contract.
///
/// The one exception is a `PermissionDenied` spawn error, mapped to
/// `AssistantError::ElevationRequired` instead — mirroring
/// `launch_tool_detached` (`lib.rs`), which makes the identical distinction
/// for the identical OS condition on the human-driven launch route, so an
/// agent-launched tool that needs administrator privileges tells the user to
/// elevate rather than reporting the same generic failure as a missing
/// installation or a crashed child.
///
/// The attempt is recorded through `launch_receipts::launch_recorded`, the
/// path the manual route uses (data contracts §4): the call id is the operation
/// id, so the receipt names the approved call that caused it. Recording runs
/// inside the gate, so a revoke that wins the gate leaves no receipt and no
/// process; a refusal before spawning is recorded as a failed receipt.
fn execute_launch_tool(
    app: &tauri::AppHandle,
    tool_id: &str,
    args: &[String],
    call_id: &str,
    ticket: Ticket,
) -> Result<String, AssistantError> {
    // Hash check stays outside the dispatch lock: it is not the side effect,
    // and the gate must not be taken while another lock is held.
    let resolution = app
        .state::<ToolSupervisor>()
        .resolve_launch_for_receipt(tool_id);
    let gate = app.state::<DispatchGate>();
    let consent = app.state::<PrivateToolsConsent>();
    let receipts = app.state::<LaunchReceipts>();
    gate.commit(
        ticket,
        || consent.is_granted(),
        || {
            let receipt = launch_receipts::launch_recorded(
                &receipts,
                LaunchRequest {
                    operation_id: call_id,
                    installation_id: tool_id,
                    origin: LaunchOrigin::Assistant,
                },
                resolution,
                |target| {
                    tool_supervisor::build_detached_command(target, args)
                        .spawn()
                        .map(|child| child.id())
                },
            )
            .map_err(|_| AssistantError::ToolFailed)?;
            launch_reply(&receipt, tool_id)
        },
    )
}

/// What the model is told about a recorded launch: success names the tool
/// id only (the pid and times are native facts for the UI, not context);
/// `elevation_required` becomes `ElevationRequired`; every other failure,
/// and an outcome Rust could not observe, is `ToolFailed`. Pulled out of
/// `execute_launch_tool` so the mapping has a direct unit test — that
/// function needs a real `tauri::AppHandle` (see `execute`'s doc comment).
fn launch_reply(receipt: &LaunchReceipt, tool_id: &str) -> Result<String, AssistantError> {
    match (receipt.outcome, receipt.reason_code.as_deref()) {
        (LaunchOutcome::Launched, _) => Ok(format!("Launched tool {tool_id}")),
        (LaunchOutcome::Failed, Some("elevation_required")) => {
            Err(AssistantError::ElevationRequired)
        }
        _ => Err(AssistantError::ToolFailed),
    }
}

/// Write `command` to the PTY session named by `session_id`, opening a
/// fresh default shell session first when none was given — through
/// `terminal::commands::open_shell_session`, the exact same path the
/// terminal UI's "new shell tab" action uses, so a new session here gets the
/// same `terminal://data` event wiring an interactively-opened tab does. Its
/// origin is recorded as `assistant`, so the session list tells the two apart.
///
/// An existing `session_id` must be one this assistant itself opened (ADR
/// 0012 Decision 3 extended to `terminal_run`'s session argument): a
/// session the *user* opened by hand, in the terminal surface they already
/// own, is not a valid agent target just because its id happens to be
/// syntactically well-formed — that is precisely the point of keeping the
/// terminal visible to the user in the first place. `AssistantState::
/// owns_agent_session` is checked before any write, so a name for a session
/// this agent never opened is refused with `SessionNotOwned` rather than
/// falling through to `TerminalSessions::write` (which has no notion of
/// *whose* session it is — it would happily write to any live session,
/// agent-opened or not). This is currently unreachable in practice, because
/// the only session id the model can ever learn is one this same function
/// just returned in a prior step's result, but it stops being unreachable
/// the moment `read_context` (or any other channel) is widened to surface
/// something that happens to look like a session id — see ADR 0012's note on
/// `read_context`'s narrower-than-it-sounds `resources` kind for exactly the
/// kind of widening this guards against.
///
/// Returns the session id used (new or existing) as `ToolOutcome::session_id`
/// so the UI can link the tool result to the terminal tab it landed in.
///
/// `open_shell_session` failing or the PTY write failing are both this approved
/// call's executor falling over after every parse and consent check already
/// passed, so both map to `AssistantError::ToolFailed`, not `Internal`.
fn execute_terminal_run(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    command: &str,
    ticket: Ticket,
) -> Result<ToolOutcome, AssistantError> {
    // Defence in depth. `parse_tool_call` already rejects an embedded newline,
    // but `AgentTool` is a public enum with public fields, so any module in the
    // crate can construct a `TerminalRun` without going through the parser. One
    // approval must never become several executed commands, so the invariant is
    // re-checked at the only place that actually writes to a PTY.
    if command.contains('\n') || command.contains('\r') {
        return Err(AssistantError::Internal(
            "terminal_run command contains a newline".into(),
        ));
    }
    if command.chars().any(is_forbidden_control) {
        return Err(AssistantError::Internal(
            "terminal_run command contains a control character".into(),
        ));
    }

    let assistant_state = app.state::<AssistantState>();
    let gate = app.state::<DispatchGate>();
    let consent = app.state::<PrivateToolsConsent>();

    let id = match session_id {
        Some(id) => {
            if !assistant_state.owns_agent_session(id) {
                return Err(AssistantError::SessionNotOwned);
            }
            id.to_string()
        }
        None => gate.commit(
            ticket,
            || consent.is_granted(),
            || {
                let opened = open_shell_session(
                    app,
                    &consent,
                    DEFAULT_TERMINAL_SHELL,
                    None,
                    DEFAULT_TERMINAL_COLS,
                    DEFAULT_TERMINAL_ROWS,
                    SessionOrigin::Assistant,
                )
                .map_err(|_| AssistantError::ToolFailed)?
                .session_id;
                // Recorded before the write below, so a subsequent step in this
                // (or a later) turn that names this exact id back is recognized
                // as the agent's own session.
                assistant_state.note_agent_session(&opened);
                Ok(opened)
            },
        )?,
    };

    let sessions = app.state::<TerminalSessions>();
    gate.commit(
        ticket,
        || consent.is_granted(),
        || {
            sessions
                .write(&id, &format!("{command}\r\n"))
                .map_err(|_| AssistantError::ToolFailed)
        },
    )?;

    Ok(ToolOutcome {
        text: format!("Sent to terminal session {id}"),
        session_id: Some(id),
    })
}

/// Assemble a bounded, read-only text block for `read_context`.
///
/// Rust holds no `project`/`findings` domain records — those live in the
/// renderer's own state (`src/domain/findings.ts` et al.) and are packed
/// into the turn's system message on the TypeScript side
/// (`src/domain/assistantContext.ts`) before the request ever reaches this
/// process. What this process *does* hold, and can honestly report on, is
/// the tool registry (`ToolSupervisor::list_tools`), which is what
/// `"resources"` summarizes. The other two kinds return a short, honest
/// statement that no such record exists here rather than fabricating
/// content — bounded the same way, by the same `cap_text` call.
///
/// `list_tools` failing is this call's executor failing after consent
/// already passed in `execute`, so `AssistantError::ToolFailed`, not
/// `Internal` — the same rule `execute_launch_tool`/`execute_terminal_run`
/// apply.
fn execute_read_context(
    app: &tauri::AppHandle,
    kind: ContextKind,
) -> Result<String, AssistantError> {
    let body = match kind {
        ContextKind::Resources => {
            let supervisor = app.state::<ToolSupervisor>();
            let tools = supervisor
                .list_tools()
                .map_err(|_| AssistantError::ToolFailed)?;
            if tools.is_empty() {
                "No registered lab tools.".to_string()
            } else {
                let mut lines = vec!["Registered lab tools:".to_string()];
                for t in tools.iter().take(READ_CONTEXT_MAX_TOOLS_LISTED) {
                    let status = if t.enabled { "enabled" } else { "disabled" };
                    lines.push(format!("- {} ({}) [{status}]", t.display_name, t.id));
                }
                if tools.len() > READ_CONTEXT_MAX_TOOLS_LISTED {
                    lines.push(format!(
                        "... and {} more",
                        tools.len() - READ_CONTEXT_MAX_TOOLS_LISTED
                    ));
                }
                lines.join("\n")
            }
        }
        ContextKind::Project | ContextKind::Findings => format!(
            "No {} data is available to this process; that context is assembled by the app before the turn starts.",
            kind.label()
        ),
    };
    Ok(cap_text(&body, READ_CONTEXT_CHAR_LIMIT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch_receipts::LaunchTracking;

    fn call(name: &str, args: serde_json::Value) -> crate::assistant::engine_chat::ToolCall {
        crate::assistant::engine_chat::ToolCall {
            id: "c1".into(),
            function: crate::assistant::engine_chat::ToolFunction {
                name: name.into(),
                arguments: args,
            },
        }
    }

    // -- elevation_required survives the agent launch path --------

    // The spawn error itself is classified once, in `launch_receipts::
    // spawn_reason` (tested there); these check the receipt's reason reaches
    // the model as the same error the old direct mapping produced.
    fn receipt(outcome: LaunchOutcome, reason: Option<&str>) -> LaunchReceipt {
        LaunchReceipt {
            launch_id: "launch-5d2a9c4e-7b1f-4e8a-a3c6-0f9d2b7e1c58".into(),
            operation_id: "e4b7c1a9-3f2d-4c6e-8a5b-9d0f1e2c3b47".into(),
            installation_id: "tool-3b9f2e71-0c4d-4a8e-9f6b-7d2c1e5a8b30".into(),
            display_name: "Burp Suite Community".into(),
            origin: LaunchOrigin::Assistant,
            requested_at: 1_727_800_000_000,
            spawned_at: None,
            pid: None,
            outcome,
            tracking: LaunchTracking::Unmanaged,
            reason_code: reason.map(str::to_string),
            recorded: true,
        }
    }

    #[test]
    fn a_launched_receipt_replies_with_the_tool_id_only() {
        let launched = LaunchReceipt {
            pid: Some(4242),
            spawned_at: Some(1_727_800_000_050),
            ..receipt(LaunchOutcome::Launched, None)
        };
        let text = launch_reply(&launched, "tool-3b9f2e71-0c4d-4a8e-9f6b-7d2c1e5a8b30").unwrap();
        assert_eq!(
            text,
            "Launched tool tool-3b9f2e71-0c4d-4a8e-9f6b-7d2c1e5a8b30"
        );
        assert!(
            !text.contains("4242"),
            "the pid is a native fact, not context"
        );
    }

    #[test]
    fn a_receipt_failed_for_elevation_maps_to_elevation_required() {
        assert_eq!(
            launch_reply(
                &receipt(LaunchOutcome::Failed, Some("elevation_required")),
                "t"
            ),
            Err(AssistantError::ElevationRequired)
        );
    }

    #[test]
    fn any_other_failed_or_uncertain_receipt_maps_to_tool_failed() {
        for (outcome, reason) in [
            (LaunchOutcome::Failed, Some("spawn_failed")),
            (LaunchOutcome::Failed, Some("tool_identity_changed")),
            (LaunchOutcome::Failed, Some("tool_disabled")),
            (LaunchOutcome::Unknown, Some("outcome_not_recorded")),
        ] {
            assert_eq!(
                launch_reply(&receipt(outcome, reason), "t"),
                Err(AssistantError::ToolFailed),
                "{outcome:?} {reason:?} must not be reported as elevation_required or success"
            );
        }
    }

    #[test]
    fn agent_tool_schema_lists_exactly_the_three_allowlisted_tools() {
        let schema = agent_tool_schema();
        let names: Vec<&str> = schema
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["terminal_run", "launch_tool", "read_context"]);
        for entry in schema.as_array().unwrap() {
            assert_eq!(entry["type"], "function");
            assert!(entry["function"]["parameters"]["additionalProperties"] == false);
        }
    }

    #[test]
    fn agent_tool_name_matches_the_allowlisted_literal_it_was_parsed_from() {
        assert_eq!(
            parse_tool_call(&call(
                "terminal_run",
                serde_json::json!({ "command": "whoami" })
            ))
            .unwrap()
            .name(),
            "terminal_run"
        );
        assert_eq!(
            parse_tool_call(&call(
                "launch_tool",
                serde_json::json!({ "toolId": "tool-nmap" })
            ))
            .unwrap()
            .name(),
            "launch_tool"
        );
        assert_eq!(
            parse_tool_call(&call(
                "read_context",
                serde_json::json!({ "kind": "project" })
            ))
            .unwrap()
            .name(),
            "read_context"
        );
    }

    #[test]
    fn refuses_a_tool_outside_the_allowlist() {
        let err = parse_tool_call(&call("run_shell", serde_json::json!({}))).unwrap_err();
        assert_eq!(err.code(), "unknown_tool");
    }

    #[test]
    fn refuses_a_close_but_wrong_name_without_fuzzy_matching() {
        for name in ["terminal_run ", "TERMINAL_RUN", "terminal_run2", "launch"] {
            assert_eq!(
                parse_tool_call(&call(name, serde_json::json!({})))
                    .unwrap_err()
                    .code(),
                "unknown_tool",
                "{name}",
            );
        }
    }

    #[test]
    fn launch_tool_takes_an_id_and_splits_args_into_an_argv() {
        let tool = parse_tool_call(&call(
            "launch_tool",
            serde_json::json!({ "toolId": "tool-nmap", "args": "-sV example.com" }),
        ))
        .unwrap();
        match tool {
            AgentTool::LaunchTool { tool_id, args } => {
                assert_eq!(tool_id, "tool-nmap");
                assert_eq!(args, vec!["-sV", "example.com"]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn read_context_is_the_only_tool_that_is_not_side_effecting() {
        assert!(!parse_tool_call(&call(
            "read_context",
            serde_json::json!({ "kind": "project" })
        ))
        .unwrap()
        .is_side_effecting());
        assert!(parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "whoami" })
        ))
        .unwrap()
        .is_side_effecting());
    }

    #[test]
    fn a_summary_shows_the_exact_action_and_never_invents_a_shell_string() {
        let tool = parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "whoami" }),
        ))
        .unwrap();
        assert!(tool.summary().contains("whoami"));
    }

    // -- Control and invisible characters ----------------------------

    #[test]
    fn terminal_run_refuses_c0_control_characters_but_keeps_tab() {
        for command in ["echo \u{1b}[2J", "echo \u{7}done", "a\u{0}b"] {
            let err = parse_tool_call(&call(
                "terminal_run",
                serde_json::json!({ "command": command }),
            ))
            .unwrap_err();
            assert_eq!(err.code(), "internal", "{command:?}");
        }
        assert!(parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "echo\ta" })
        ))
        .is_ok());
    }

    #[test]
    fn launch_tool_refuses_a_c0_control_character_in_an_arg() {
        let err = parse_tool_call(&call(
            "launch_tool",
            serde_json::json!({
                "toolId": "11111111-1111-1111-1111-111111111111",
                "args": "-v \u{1b}]0;title\u{7}"
            }),
        ))
        .unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    #[test]
    fn summaries_show_invisible_and_direction_changing_characters_as_escapes() {
        let tool = AgentTool::TerminalRun {
            session_id: None,
            // Built directly, past the parser, so ESC and BEL reach the
            // summary too: the card must never carry them raw.
            command: "echo \u{202E}exe.txt \u{200B}\u{1b}\u{7}\u{85}\u{FEFF}".into(),
        };
        let summary = tool.summary();
        for escaped in [
            "\\u{202E}",
            "\\u{200B}",
            "\\u{001B}",
            "\\u{0007}",
            "\\u{0085}",
            "\\u{FEFF}",
        ] {
            assert!(
                summary.contains(escaped),
                "{escaped} missing in {summary:?}"
            );
        }
        for raw in [
            '\u{202E}', '\u{200B}', '\u{1b}', '\u{7}', '\u{85}', '\u{FEFF}',
        ] {
            assert!(!summary.contains(raw), "raw {raw:?} in {summary:?}");
        }

        let launch = AgentTool::LaunchTool {
            tool_id: "id".into(),
            args: vec!["\u{2066}x\u{2069}".into()],
        };
        assert!(launch.summary().contains("\\u{2066}x\\u{2069}"));
    }

    // -- TM-006: tool arguments are bounded ------------------------------

    #[test]
    fn a_terminal_command_past_its_cap_is_response_too_large() {
        let at_cap = "a".repeat(MAX_COMMAND_CHARS);
        assert!(parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": at_cap })
        ))
        .is_ok());
        let over = "a".repeat(MAX_COMMAND_CHARS + 1);
        let err = parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": over }),
        ))
        .unwrap_err();
        assert_eq!(err.code(), "response_too_large");
    }

    #[test]
    fn launch_tool_args_past_their_caps_are_response_too_large() {
        let tool_id = "11111111-1111-1111-1111-111111111111";
        let launch = |args: String| {
            parse_tool_call(&call(
                "launch_tool",
                serde_json::json!({ "toolId": tool_id, "args": args }),
            ))
        };
        let many = vec!["-v"; MAX_LAUNCH_ARGS + 1].join(" ");
        assert_eq!(launch(many).unwrap_err().code(), "response_too_large");
        let long = "x".repeat(MAX_LAUNCH_ARG_CHARS + 1);
        assert_eq!(launch(long).unwrap_err().code(), "response_too_large");
        assert!(launch(vec!["-v"; MAX_LAUNCH_ARGS].join(" ")).is_ok());
    }

    // -- One approval can't carry several commands -------------------

    #[test]
    fn terminal_run_rejects_a_command_with_an_embedded_lf() {
        let err = parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "whoami\nrm -rf /" }),
        ))
        .unwrap_err();
        match err {
            AssistantError::Internal(msg) => assert!(msg.contains("newline"), "{msg}"),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    #[test]
    fn terminal_run_rejects_a_command_with_an_embedded_crlf() {
        let err = parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "whoami\r\nrm -rf /" }),
        ))
        .unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    #[test]
    fn terminal_run_accepts_a_plain_single_line_command() {
        assert!(parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "whoami" }),
        ))
        .is_ok());
    }

    // -- Reject a field neither side's schema declares ----------------

    #[test]
    fn terminal_run_rejects_an_unknown_field_like_the_ts_schema_does() {
        let err = parse_tool_call(&call(
            "terminal_run",
            serde_json::json!({ "command": "whoami", "shell": "bash" }),
        ))
        .unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    #[test]
    fn read_context_rejects_an_unknown_field_like_the_ts_schema_does() {
        let err = parse_tool_call(&call(
            "read_context",
            serde_json::json!({ "kind": "project", "extra": true }),
        ))
        .unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    // Tokenizer cases. These began as a port of a TypeScript twin's tests;
    // that twin has since been deleted (ADR 0012, Decision 1 amended) and
    // these are now the only coverage the quoting rules have.

    #[test]
    fn tokenizer_splits_a_quoted_argument_containing_a_space_into_one_token() {
        assert_eq!(
            tokenize_tool_args(r#"--script "safe scan""#),
            vec!["--script", "safe scan"],
        );
    }

    #[test]
    fn tokenizer_collapses_multiple_spaces_between_tokens() {
        assert_eq!(
            tokenize_tool_args("-sV    example.com"),
            vec!["-sV", "example.com"],
        );
    }

    #[test]
    fn tokenizer_on_an_empty_string_produces_no_tokens() {
        assert!(tokenize_tool_args("").is_empty());
    }

    #[test]
    fn tokenizer_treats_an_unterminated_quote_as_closed_at_end_of_string() {
        // Two tokens: the flag, and everything from the stray quote to EOF —
        // the quote character itself is preserved (not discarded), and the
        // whitespace inside it is NOT used to split further (no third
        // "scan" token). Mirrors the TS test of the same name exactly.
        assert_eq!(
            tokenize_tool_args(r#"--script "safe scan"#),
            vec!["--script", "\"safe scan"],
        );
    }

    #[test]
    fn an_absent_launch_tool_args_string_behaves_like_an_empty_one() {
        let tool = parse_tool_call(&call(
            "launch_tool",
            serde_json::json!({ "toolId": "tool-nmap" }),
        ))
        .unwrap();
        match tool {
            AgentTool::LaunchTool { args, .. } => assert!(args.is_empty()),
            _ => panic!("wrong variant"),
        }
        assert_eq!(
            tool_summary_for(&call(
                "launch_tool",
                serde_json::json!({ "toolId": "tool-nmap" }),
            )),
            "Launch tool: tool-nmap"
        );
    }

    #[test]
    fn an_unterminated_quote_survives_end_to_end_into_the_summary() {
        // End-to-end version of the tokenizer case above, through
        // parse_tool_call + summary(), matching the TS
        // `describeToolCall` test byte for byte.
        let summary = tool_summary_for(&call(
            "launch_tool",
            serde_json::json!({ "toolId": "tool-nmap", "args": r#"--script "safe scan"# }),
        ));
        assert_eq!(summary, "Launch tool: tool-nmap --script \"\\\"safe scan\"");
    }

    fn tool_summary_for(tc: &crate::assistant::engine_chat::ToolCall) -> String {
        parse_tool_call(tc).unwrap().summary()
    }

    // -- The approval card must name the tool, not a uuid -------

    /// Copies this test binary to `dir/{name}.exe` so `register_tool` has a
    /// real, hashable `.exe` to point at — mirrors `tool_supervisor.rs`'s own
    /// test helper of the same name exactly, duplicated here rather than
    /// exposed from that module purely for a handful of tests.
    fn copy_test_exe(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let destination = dir.join(format!("{name}.exe"));
        std::fs::copy(std::env::current_exe().unwrap(), &destination).unwrap();
        destination
    }

    fn register_named_fixture(
        supervisor: &ToolSupervisor,
        executable: &std::path::Path,
        display_name: &str,
    ) -> String {
        supervisor
            .register_tool(crate::tool_registry::RegisterToolRequest {
                candidate_path: executable.to_string_lossy().to_string(),
                display_name: display_name.into(),
                category: "network".into(),
                risk_tier: "medium".into(),
                doc_url: String::new(),
                tags: vec![],
                working_dir: executable.parent().unwrap().to_string_lossy().to_string(),
                confirmed: true,
            })
            .unwrap()
            .id
    }

    #[test]
    fn summary_for_approval_names_a_launch_tool_by_display_name_not_a_bare_uuid() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "launcher");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_named_fixture(&supervisor, &executable, "Nmap Scanner");

        // Realistic shape -- `tool-<uuid4>`, exactly what `register_tool`
        // actually produces (`format!("tool-{}", Uuid::new_v4())`) -- not
        // the hand-written `"tool-nmap"` every other fixture in this module
        // uses. That look-alike-a-name shape is what let the bare-uuid
        // summary go unnoticed.
        assert!(id.starts_with("tool-"));
        assert_eq!(id.len(), "tool-".len() + 36, "expected a uuid4 body: {id}");

        let tool = AgentTool::LaunchTool {
            tool_id: id.clone(),
            args: vec!["-sV".into(), "example.com".into()],
        };
        let summary = summary_for_approval(&supervisor, &tool);

        assert_eq!(
            summary,
            format!("Launch tool: Nmap Scanner ({id}) -sV example.com")
        );
        // Never the path, even though `register_tool` above did point at a
        // real file on disk (ADR 0012 Decision 3 extended to the summary).
        assert!(!summary.contains(&executable.to_string_lossy().to_string()));
    }

    #[test]
    fn summary_for_approval_states_plainly_when_a_launch_tool_id_cannot_be_resolved() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let tool = AgentTool::LaunchTool {
            tool_id: "tool-does-not-exist".into(),
            args: vec![],
        };

        assert_eq!(
            summary_for_approval(&supervisor, &tool),
            "Launch tool: tool-does-not-exist (no installation with this id is registered)"
        );
    }

    #[test]
    fn summary_for_approval_reflects_a_disabled_installation_rather_than_its_healthy_name() {
        // A friendlier-looking summary than the truth is exactly the failure
        // mode the tool name on the card must not reintroduce: a disabled tool must
        // not present as launchable just because it has a nice display name.
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "disabled-tool");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_named_fixture(&supervisor, &executable, "Nmap Scanner");
        supervisor.set_tool_enabled(&id, false).unwrap();

        let tool = AgentTool::LaunchTool {
            tool_id: id.clone(),
            args: vec![],
        };

        assert_eq!(
            summary_for_approval(&supervisor, &tool),
            format!("Launch tool: {id} (this installation is disabled)")
        );
    }

    #[test]
    fn approval_facts_show_the_command_and_a_launch_identity_without_a_path() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "facts");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_named_fixture(&supervisor, &executable, "Nmap Scanner");

        let (_, run) = approval_for(
            &supervisor,
            &AgentTool::TerminalRun {
                session_id: None,
                command: "nmap -sV 10.0.0.5\u{202E}".into(),
            },
        );
        assert_eq!(
            run,
            ApprovalAction::TerminalRun {
                session_id: None,
                command: "nmap -sV 10.0.0.5\\u{202E}".into(),
            }
        );

        let (summary, launch) = approval_for(
            &supervisor,
            &AgentTool::LaunchTool {
                tool_id: id.clone(),
                args: vec!["-sV".into(), "example.com".into()],
            },
        );
        assert_eq!(
            summary,
            format!("Launch tool: Nmap Scanner ({id}) -sV example.com")
        );
        let ApprovalAction::LaunchTool {
            display_name,
            args_text,
            identity: LaunchIdentity::Verified { sha256, risk_tier },
            ..
        } = &launch
        else {
            panic!("expected a verified launch, got {launch:?}");
        };
        assert_eq!(display_name.as_deref(), Some("Nmap Scanner"));
        assert_eq!(args_text, "-sV example.com");
        assert_eq!(sha256.len(), 64);
        assert_eq!(risk_tier, "medium");
        let json = serde_json::to_string(&launch).unwrap();
        assert!(json.contains("\"kind\":\"launch_tool\""), "{json}");
        assert!(json.contains("\"state\":\"verified\""), "{json}");
        assert!(json.contains("\"riskTier\":\"medium\""), "{json}");
        assert!(!json.contains(&executable.to_string_lossy().to_string()));
    }

    #[test]
    fn approval_facts_say_when_a_launch_cannot_run() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let (_, launch) = approval_for(
            &supervisor,
            &AgentTool::LaunchTool {
                tool_id: "tool-does-not-exist".into(),
                args: vec![],
            },
        );
        assert_eq!(
            launch,
            ApprovalAction::LaunchTool {
                installation_id: "tool-does-not-exist".into(),
                display_name: None,
                args_text: String::new(),
                identity: LaunchIdentity::Blocked {
                    reason: "tool_not_found".into()
                },
            }
        );
    }

    #[test]
    fn summary_for_approval_leaves_every_other_tool_exactly_as_summary_does() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();

        let run = AgentTool::TerminalRun {
            session_id: None,
            command: "whoami".into(),
        };
        assert_eq!(summary_for_approval(&supervisor, &run), run.summary());

        let read = AgentTool::ReadContext {
            kind: ContextKind::Resources,
        };
        assert_eq!(summary_for_approval(&supervisor, &read), read.summary());
    }

    // -- A known tool name, malformed argument shape -------------------

    #[test]
    fn a_known_tool_with_a_missing_required_field_is_internal_not_a_panic() {
        // `terminal_run` requires `command`; omitting it is a shape mismatch
        // serde rejects, which parse_tool_call maps to Internal — the same
        // bucket a completely malformed JSON blob would hit, never a panic.
        let err = parse_tool_call(&call("terminal_run", serde_json::json!({}))).unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    #[test]
    fn a_known_tool_with_a_wrong_typed_field_is_internal_not_a_panic() {
        let err =
            parse_tool_call(&call("launch_tool", serde_json::json!({ "toolId": 42 }))).unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    // -- TM-002: unsolicited calls never reach an executor ---------------

    #[derive(Clone, Copy)]
    struct AuthCase {
        offered: bool,
        agent: bool,
        consent: bool,
        auto_approve_reads: bool,
    }

    fn every_consent_combination() -> Vec<AuthCase> {
        let mut cases = Vec::new();
        for offered in [false, true] {
            for agent in [false, true] {
                for consent in [false, true] {
                    for auto_approve_reads in [false, true] {
                        cases.push(AuthCase {
                            offered,
                            agent,
                            consent,
                            auto_approve_reads,
                        });
                    }
                }
            }
        }
        cases
    }

    #[test]
    fn unsolicited_calls_never_reach_the_executor_for_any_consent_combination() {
        for case in every_consent_combination() {
            // auto_approve_reads is not an authorization input; it must not
            // change whether the executor runs. Mentioned so a future edit
            // that threads it into the gate fails this loop.
            let _ = case.auto_approve_reads;
            let mut reached = false;
            let result = execute_if_authorized(case.offered, case.agent, case.consent, || {
                reached = true;
                Ok(())
            });
            let solicited = case.offered && case.agent && case.consent;
            if solicited {
                assert!(
                    result.is_ok(),
                    "offered={} agent={} consent={} auto_approve={}",
                    case.offered,
                    case.agent,
                    case.consent,
                    case.auto_approve_reads
                );
                assert!(reached, "solicited call must reach the executor");
            } else {
                assert!(
                    result.is_err(),
                    "offered={} agent={} consent={} auto_approve={}",
                    case.offered,
                    case.agent,
                    case.consent,
                    case.auto_approve_reads
                );
                assert!(
                    !reached,
                    "executor ran without agent+consent+offer (offered={} agent={} consent={} auto_approve={})",
                    case.offered,
                    case.agent,
                    case.consent,
                    case.auto_approve_reads
                );
            }
        }
    }

    #[test]
    fn private_lab_on_agent_off_is_unsolicited_even_for_auto_approved_read_context() {
        // The TM-002 escape: Private Lab granted, agent proposals off,
        // listener returns read_context, auto_approve_reads would skip the
        // card. The gate must still refuse and never dispatch.
        let parsed = parse_tool_call(&call(
            "read_context",
            serde_json::json!({ "kind": "resources" }),
        ))
        .expect("allowlisted read");
        assert!(matches!(parsed, AgentTool::ReadContext { .. }));

        let mut reached = false;
        let err = execute_if_authorized(false, false, true, || {
            reached = true;
            Ok(())
        })
        .expect_err("unsolicited read must not dispatch");
        assert_eq!(err.code(), "unsolicited_tool");
        assert!(!reached);
        assert_eq!(
            authorize_tool_dispatch(false, false, true)
                .unwrap_err()
                .code(),
            "unsolicited_tool"
        );
    }

    #[test]
    fn a_solicited_call_still_needs_live_private_lab_consent() {
        let mut reached = false;
        let err = execute_if_authorized(true, true, false, || {
            reached = true;
            Ok(())
        })
        .expect_err("revoked consent must stop dispatch");
        assert_eq!(err.code(), "private_tools_consent_required");
        assert!(!reached);
    }
}
