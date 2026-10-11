//! Terminal command surface. The renderer may open/write/resize/close a
//! session and stop all sessions. Sessions come from one of two paths:
//! `terminal_open`, which names one of the three vetted shells; or
//! `terminal_open_tool`, which runs a *registered installation* named only
//! by its `installation_id` — both the executable path and its working
//! directory are resolved server-side through the tool supervisor's
//! identity gate (`ToolSupervisor::resolve_launchable`), the same gate the
//! detached GUI launch and the batch Run button use. The renderer can never
//! spawn an arbitrary, unvalidated, or merely self-reported program, and it
//! can never hand this route a working directory the registry has not
//! already validated.
//!
//! `terminal_open` and `terminal_open_tool` are gated on Private Lab consent
//! (see `crate::consent`): a session cannot come into existence without it.
//! `terminal_write` / `terminal_resize` / `terminal_close` /
//! `terminal_close_all` / `terminal_scrollback` / `terminal_resolved_shell`
//! are not separately gated — the first five only ever act on a session id
//! that already required consent to create; `terminal_resolved_shell` is
//! a PATH lookup that opens no PTY.
//!
//! `terminal_scrollback` answers "what has this session already
//! produced", for a surface that starts listening to `terminal://data`
//! after some of it was already emitted — most notably the agent's
//! `terminal_run`, which can open and write to a session before any
//! `TerminalTab` exists to render it. See `TerminalSessions::scrollback`
//! (`terminal/mod.rs`) for the buffer itself and its bound, and
//! `TerminalData::seq`/`TerminalScrollback::cursor` for how a caller
//! reconciles the snapshot against events still arriving live.
//!
//! `terminal_list_sessions` and the `terminal://session` event carry
//! each session's Rust-derived facts -- origin, PID, program name, start
//! directory, elapsed time, how it ended -- under one registry revision; see
//! `lifecycle` for what each fact does and does not mean. Like
//! `terminal_scrollback`, listing is read-only and not separately gated: it
//! reports only sessions that already required consent to open.

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::lifecycle::{SessionOrigin, SessionSink, TerminalSessionInfo, TerminalSessionList};
use super::{
    executable_on_path, resolve_shell, ShellKind, SpawnConfig, SpawnTarget, TerminalSessions,
};
use crate::tool_supervisor::ToolSupervisor;

pub const TERMINAL_DATA_EVENT: &str = "terminal://data";
pub const TERMINAL_SESSION_EVENT: &str = "terminal://session";

/// The registry's lifecycle sink: every change becomes a `terminal://session`
/// event, in revision order.
pub fn session_event_sink(app: tauri::AppHandle) -> SessionSink {
    std::sync::Arc::new(move |event| {
        let _ = app.emit(TERMINAL_SESSION_EVENT, event);
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalData {
    pub id: String,
    pub data: String,
    /// Cumulative byte count of this session's output as of and including
    /// this chunk (`TerminalSessions::Scrollback::push`'s return value).
    /// A surface that attaches after some output was already
    /// produced fetches a `terminal_scrollback` snapshot and compares its
    /// `cursor` against this field to tell "already in the snapshot" apart
    /// from "arrived after it" -- see `wireFromId`
    /// (`src/features/terminal/useTerminalSession.ts`).
    pub seq: u64,
}

/// Response to `terminal_scrollback`: what a session has produced so far,
/// for a surface attaching after the fact. `cursor` is directly comparable
/// to `TerminalData::seq` -- a caller keeps a live event whose `seq` exceeds
/// `cursor` and drops one that doesn't (already covered by `text`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScrollback {
    pub text: String,
    pub cursor: u64,
}

pub fn parse_shell(kind: &str) -> Result<ShellKind, String> {
    match kind {
        "pwsh" => Ok(ShellKind::Pwsh),
        "powershell" => Ok(ShellKind::PowerShell),
        "bash" => Ok(ShellKind::Bash),
        other => Err(format!("unknown_shell:{other}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedShellReport {
    pub program: String,
    pub kind: String,
}

/// Read-only: which executable the Windows chain would spawn. Does not open
/// a PTY and is not gated on Private Lab — readiness asks this before a
/// terminal exists.
#[tauri::command]
pub fn terminal_resolved_shell() -> Result<ResolvedShellReport, String> {
    let resolved = resolve_shell(
        ShellKind::Pwsh,
        executable_on_path,
        std::env::var("COMSPEC").ok().as_deref(),
    )?;
    Ok(ResolvedShellReport {
        program: resolved.program,
        kind: resolved.kind.as_wire().to_string(),
    })
}

#[tauri::command]
pub fn terminal_open(
    app: tauri::AppHandle,
    consent: tauri::State<'_, crate::consent::PrivateToolsConsent>,
    shell: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSessionInfo, String> {
    open_shell_session(&app, &consent, &shell, cwd, cols, rows, SessionOrigin::User)
}

/// The shell route shared by the user's `terminal_open` and the assistant's
/// `terminal_run`; only the recorded origin differs.
pub fn open_shell_session(
    app: &tauri::AppHandle,
    consent: &crate::consent::PrivateToolsConsent,
    shell: &str,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    origin: SessionOrigin,
) -> Result<TerminalSessionInfo, String> {
    consent.require()?;
    let shell = parse_shell(shell)?;
    open_with_data_events(
        app,
        SpawnConfig {
            target: SpawnTarget::Shell(shell),
            cwd,
            cols,
            rows,
            origin,
        },
    )
}

/// Open a session whose output is emitted as `terminal://data`.
fn open_with_data_events(
    app: &tauri::AppHandle,
    config: SpawnConfig,
) -> Result<TerminalSessionInfo, String> {
    let sessions = app.state::<TerminalSessions>();
    let emitter = app.clone();
    // id is generated inside open(); the reader thread borrows it via the closure.
    let id_holder = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let id_for_cb = id_holder.clone();
    let info = sessions.open(config, move |chunk, seq| {
        let id = id_for_cb.lock().unwrap().clone();
        if !id.is_empty() {
            let _ = emitter.emit(
                TERMINAL_DATA_EVENT,
                TerminalData {
                    id,
                    data: chunk,
                    seq,
                },
            );
        }
    })?;
    *id_holder.lock().unwrap() = info.session_id.clone();
    Ok(info)
}

/// Resolve `installation_id` through the tool supervisor's identity gate and
/// build the `SpawnConfig` for an interactive PTY launch of it. Extracted
/// from `terminal_open_tool` so the resolve-then-build step is exercised by
/// a plain unit test against a real `ToolSupervisor` (see the tests module
/// below) without needing a live Tauri `AppHandle`/`State` — a regression
/// that, say, reintroduced a renderer-supplied `program` or `cwd` parameter
/// would be caught here, not just by manual review.
///
/// `cols`/`rows` are threaded through unchanged; they carry no trust
/// implications.
pub fn build_tool_spawn_config(
    supervisor: &ToolSupervisor,
    installation_id: &str,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<SpawnConfig, String> {
    crate::tool_supervisor::validate_arguments(&args)?;
    let target = supervisor.resolve_launchable(installation_id)?;
    Ok(SpawnConfig {
        target: SpawnTarget::Program {
            program: target.program.to_string_lossy().into_owned(),
            args,
        },
        cwd: Some(target.working_dir.to_string_lossy().into_owned()),
        cols,
        rows,
        origin: SessionOrigin::RegisteredTool {
            installation_id: installation_id.to_string(),
        },
    })
}

/// Open a PTY running a *registered installation*, named only by its
/// `installation_id` — this is the interactive-launch counterpart to
/// `launch_tool_detached`. The renderer never names a path or a working
/// directory: both are resolved server-side through
/// `ToolSupervisor::resolve_launchable` (via `build_tool_spawn_config`),
/// which applies the exact same identity gate as the batch Run button and
/// the detached GUI launch (enabled check, stored `changed_since_verify`
/// check, and a live re-hash of the binary on disk) and the same
/// working-directory gate the batch path uses
/// (`resolve_run_working_dir`). A disabled, identity-changed, unknown, or
/// path-missing installation is refused before any PTY is created, as is
/// one whose registered working directory is missing or not a folder. A
/// profile-level working-directory override, if the caller had one, does
/// not apply on this route — the registry's validated directory always
/// wins. Arguments are passed as an argv, never a shell string.
#[tauri::command]
pub fn terminal_open_tool(
    app: tauri::AppHandle,
    consent: tauri::State<'_, crate::consent::PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    installation_id: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSessionInfo, String> {
    consent.require()?;
    let config = build_tool_spawn_config(&supervisor, &installation_id, args, cols, rows)?;
    open_with_data_events(&app, config)
}

/// Every session still in the registry, with the revision the snapshot
/// covers. A caller subscribes to `terminal://session` first, then lists,
/// then applies only events whose revision exceeds the list's.
#[tauri::command]
pub fn terminal_list_sessions(app: tauri::AppHandle) -> TerminalSessionList {
    app.state::<TerminalSessions>().list()
}

/// Fetch what a session has produced so far, for a surface (a `TerminalTab`,
/// mounted late, or the same tab re-attaching) that starts listening after
/// some output was already emitted. Not consent-gated on its own: like
/// `terminal_write`/`terminal_resize`/`terminal_close`, it only ever acts on
/// a session id that already required consent to create, and it is
/// read-only besides.
#[tauri::command]
pub fn terminal_scrollback(
    app: tauri::AppHandle,
    id: String,
) -> Result<TerminalScrollback, String> {
    let (text, cursor) = app.state::<TerminalSessions>().scrollback(&id)?;
    Ok(TerminalScrollback { text, cursor })
}

#[tauri::command]
pub fn terminal_write(app: tauri::AppHandle, id: String, data: String) -> Result<(), String> {
    app.state::<TerminalSessions>().write(&id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    app: tauri::AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    app.state::<TerminalSessions>().resize(&id, cols, rows)
}

/// Closes the session and, if the agent had opened it, evicts it from
/// `AssistantState`'s ownership set — a closed session must not
/// keep looking like a live one this agent may still write to. Order
/// matters only in that eviction happens once the close itself has already
/// succeeded; `forget_agent_session` is a harmless no-op for a session the
/// agent never opened, so it is called unconditionally rather than adding a
/// second lookup just to decide whether to call it.
///
/// Closing waits for the exit to be seen (see `TerminalSessions::close`), so
/// it runs off the main thread.
#[tauri::command]
pub async fn terminal_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<TerminalSessions>().close(&id)?;
        app.state::<crate::assistant::AssistantState>()
            .forget_agent_session(&id);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Same eviction as `terminal_close`, for every session at once.
#[tauri::command]
pub async fn terminal_close_all(app: tauri::AppHandle) -> Result<super::CloseAllReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let report = app.state::<TerminalSessions>().close_all();
        app.state::<crate::assistant::AssistantState>()
            .forget_all_agent_sessions();
        report
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::RegisterToolRequest;
    use std::fs;

    #[test]
    fn data_payload_is_camel_case() {
        let json = serde_json::to_string(&TerminalData {
            id: "s1".into(),
            data: "hi".into(),
            seq: 2,
        })
        .unwrap();
        assert_eq!(json, r#"{"id":"s1","data":"hi","seq":2}"#);
    }
    #[test]
    fn scrollback_payload_is_camel_case() {
        let json = serde_json::to_string(&TerminalScrollback {
            text: "hi".into(),
            cursor: 5,
        })
        .unwrap();
        assert_eq!(json, r#"{"text":"hi","cursor":5}"#);
    }
    #[test]
    fn shell_kind_parses_known_values_and_rejects_others() {
        assert!(parse_shell("pwsh").is_ok());
        assert!(parse_shell("powershell").is_ok());
        assert!(parse_shell("bash").is_ok());
        assert!(parse_shell("cmd").is_err());
        assert!(parse_shell("rm-rf").is_err());
    }

    fn copy_test_exe(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let destination = dir.join(format!("{name}.exe"));
        fs::copy(std::env::current_exe().unwrap(), &destination).unwrap();
        destination
    }

    fn register_fixture(supervisor: &ToolSupervisor, executable: &std::path::Path) -> String {
        supervisor
            .register_tool(RegisterToolRequest {
                candidate_path: executable.to_string_lossy().to_string(),
                display_name: "Terminal command fixture".into(),
                category: "local".into(),
                risk_tier: "low".into(),
                doc_url: String::new(),
                tags: vec!["test".into()],
                working_dir: executable.parent().unwrap().to_string_lossy().to_string(),
                confirmed: true,
            })
            .unwrap()
            .id
    }

    // The exact regression this guards against: nothing mechanically checked
    // that `terminal_open_tool` actually calls `resolve_launchable` (a
    // nine-line prose comment stood in its place). If someone re-added a
    // renderer-supplied `program` parameter, the suite would still pass.
    // `build_tool_spawn_config` is the extracted resolve-then-build step;
    // this proves it refuses a drifted installation and never falls back to
    // whatever the caller happened to pass in.
    #[test]
    fn build_tool_spawn_config_resolves_through_the_supervisor_and_refuses_drift() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "terminal-cmd-fixture");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);

        // Healthy installation: resolves to the identity-verified path and
        // the registered working directory, never whatever the caller might
        // have passed (there is no `program`/`cwd` parameter to pass at
        // all -- only the id).
        let config =
            build_tool_spawn_config(&supervisor, &id, vec!["--flag".into()], 80, 24).unwrap();
        match &config.target {
            SpawnTarget::Program { program, args } => {
                assert_eq!(
                    program,
                    &fs::canonicalize(&executable).unwrap().to_string_lossy()
                );
                assert_eq!(args, &vec!["--flag".to_string()]);
            }
            SpawnTarget::Shell(_) => panic!("expected a Program target"),
        }
        assert_eq!(
            config.cwd.as_deref(),
            Some(
                fs::canonicalize(executable.parent().unwrap())
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(config.cols, 80);
        assert_eq!(config.rows, 24);
        // The session records which installation it runs, from the id the
        // gate resolved -- the renderer has no other way to name it.
        assert_eq!(
            config.origin,
            SessionOrigin::RegisteredTool {
                installation_id: id.clone()
            }
        );

        // Unknown installation id.
        assert_eq!(
            build_tool_spawn_config(&supervisor, "tool-does-not-exist", vec![], 80, 24)
                .unwrap_err(),
            "tool_not_found"
        );

        // Drifted binary, never explicitly reverified: the live re-hash
        // inside `resolve_launchable` still catches it, exactly like the
        // batch Run button and the detached GUI launch.
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"drifted")
            .unwrap();
        assert_eq!(
            build_tool_spawn_config(&supervisor, &id, vec![], 80, 24).unwrap_err(),
            "tool_identity_changed"
        );
    }
}
