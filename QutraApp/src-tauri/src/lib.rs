//! Qutra Labs native core.
//!
//! Trust boundary rules (see docs/decisions/0003-security-boundaries.md):
//! - every command validates its input before touching the OS;
//! - no command builds shell strings — argument vectors only;
//! - window enumeration returns titles/positions, never contents;
//! - elevated windows are reported, never manipulated (UIPI);
//! - the app never auto-elevates.

mod ai;
mod analysis;
mod assistant;
mod brand;
mod builtin_tools;
mod consent;
mod consent_grant;
mod durable_file;
mod engagement_folders;
mod external_tools;
mod github;
mod investigation_files;
mod known_apps;
mod launch_receipts;
mod local_engine;
mod net_guard;
mod sample_data;
mod secure;
mod storage_writes;
mod terminal;
mod tool_forms;
mod tool_logos;
mod tool_output;
mod tool_detect;
mod tool_registry;
mod tool_supervisor;
mod validation;
#[cfg(windows)]
mod winapi;

use analysis::store::AnalysisStore;
use assistant::dispatch::DispatchGate;
use assistant::AssistantState;
use consent::PrivateToolsConsent;
use engagement_folders::{EngagementFolders, FolderInfo, PickedParent};
use investigation_files::{AddOutcome, FileView, InvestigationFiles};
use launch_receipts::{LaunchOrigin, LaunchReceipt, LaunchReceipts, LaunchRequest};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_sql::{Migration, MigrationKind};
use tool_registry::{
    ListedToolInstallation, LocatedCandidate, RegisterLocatedToolRequest, ToolInstallationRecord,
};
use tool_supervisor::{
    EventSink, NativeToolRun, StartToolRunRequest, ToolRunEvent, ToolSupervisor,
};
use validation::{validate_http_url, validate_openable_path};

#[derive(Serialize, Clone, Debug, Default)]
pub struct RunningApp {
    pub name: String,
    pub executable: String,
    pub window_title: String,
    pub monitor: i32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub elevated: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct MonitorInfoDto {
    pub index: i32,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct WindowBoundsDto {
    pub monitor: i32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RestoreItemDto {
    pub kind: String,
    pub title: String,
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub window_bounds: Option<WindowBoundsDto>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RestoreOutcome {
    /// queued|launching|waiting|repositioning|restored|skipped|permission_required|failed
    pub state: String,
    pub reason: Option<String>,
}

impl RestoreOutcome {
    fn ok() -> Self {
        Self {
            state: "restored".into(),
            reason: None,
        }
    }
    fn ok_with(reason: &str) -> Self {
        Self {
            state: "restored".into(),
            reason: Some(reason.into()),
        }
    }
    fn skipped(reason: &str) -> Self {
        Self {
            state: "skipped".into(),
            reason: Some(reason.into()),
        }
    }
    fn failed(reason: &str) -> Self {
        Self {
            state: "failed".into(),
            reason: Some(reason.into()),
        }
    }
    fn permission(reason: &str) -> Self {
        Self {
            state: "permission_required".into(),
            reason: Some(reason.into()),
        }
    }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/// Test/example accessor for the native window enumeration (see
/// `examples/enumerate.rs`). Exposes the same data the command returns
/// without requiring a Tauri runtime.
#[cfg(windows)]
pub fn enumerate_windows_for_example() -> Vec<RunningApp> {
    winapi::enumerate_windows()
}

/// Enumerate visible top-level application windows (metadata only). What it
/// reports is remembered as the programs a snapshot restore may start.
#[tauri::command]
fn list_running_apps(
    known: tauri::State<'_, known_apps::KnownApps>,
) -> Result<Vec<RunningApp>, String> {
    #[cfg(windows)]
    {
        let apps = winapi::enumerate_windows();
        known.remember(apps.iter().map(|app| app.executable.as_str()));
        Ok(apps)
    }
    #[cfg(not(windows))]
    {
        Err("unsupported_platform".into())
    }
}

/// Monitors, positions and scale factors via Tauri's monitor API.
#[tauri::command]
fn list_monitors(app: tauri::AppHandle) -> Result<Vec<MonitorInfoDto>, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfoDto {
            index: i as i32,
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            scale: m.scale_factor(),
        })
        .collect())
}

/// Open a validated HTTP/HTTPS URL with the OS default handler.
#[tauri::command]
fn open_url_checked(url: String) -> Result<(), String> {
    let checked = validate_http_url(&url)?;
    tauri_plugin_opener::open_url(checked, None::<String>).map_err(|e| e.to_string())
}

/// Open an existing folder, or a file of a kind Windows does not run. The path
/// is canonicalized and must exist; network and device paths, programs,
/// scripts and shortcuts are refused (`validate_openable_path`). No shell
/// strings are ever constructed.
#[tauri::command]
fn open_path_checked(path: String) -> Result<(), String> {
    let canonical = validate_openable_path(&path)?;
    tauri_plugin_opener::open_path(canonical, None::<String>).map_err(|e| e.to_string())
}

/// Whether `text` holds a token that starts with one of the usual prefixes.
/// The prefix must begin a word: `sk-` inside "task-12" or "risk-high" is not
/// a key.
fn has_token_prefix(text: &str) -> bool {
    const PREFIXES: [&str; 6] = ["ghp_", "gho_", "sk-", "AKIA", "xoxb-", "xoxp-"];
    PREFIXES.iter().any(|prefix| {
        text.match_indices(prefix).any(|(at, _)| {
            text[..at]
                .chars()
                .next_back()
                .is_none_or(|before| !before.is_alphanumeric())
        })
    })
}

fn archive_payload_is_safe(value: &serde_json::Value, key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    if [
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "credential",
        "apikey",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
    {
        return value.as_str() == Some("[REDACTED]");
    }
    match value {
        serde_json::Value::String(text) => !has_token_prefix(text),
        serde_json::Value::Array(items) => {
            items.iter().all(|item| archive_payload_is_safe(item, key))
        }
        serde_json::Value::Object(entries) => entries
            .iter()
            .all(|(child_key, child)| archive_payload_is_safe(child, child_key)),
        _ => true,
    }
}

fn write_retired_archive(app_data: &Path, archive_json: &str) -> Result<String, String> {
    if archive_json.len() > 64 * 1024 * 1024 {
        return Err("archive_too_large".into());
    }
    let payload: serde_json::Value =
        serde_json::from_str(archive_json).map_err(|_| "archive_invalid_json")?;
    if payload.get("format").and_then(|value| value.as_str()) != Some("contextos-retired-modules")
        || payload.get("version").and_then(|value| value.as_u64()) != Some(12)
    {
        return Err("archive_invalid_format".into());
    }
    if !archive_payload_is_safe(&payload, "") {
        return Err("archive_contains_secret".into());
    }

    let archive_dir = app_data.join("archives");
    fs::create_dir_all(&archive_dir).map_err(|_| "archive_create_dir_failed")?;
    let destination = archive_dir.join("scope-simplification-v12.json");
    if destination.exists() {
        return Ok(destination.to_string_lossy().into_owned());
    }
    let temporary = archive_dir.join("scope-simplification-v12.tmp");
    fs::write(&temporary, archive_json).map_err(|_| "archive_write_failed")?;
    match fs::rename(&temporary, &destination) {
        Ok(()) => Ok(destination.to_string_lossy().into_owned()),
        Err(_) if destination.exists() => {
            let _ = fs::remove_file(&temporary);
            Ok(destination.to_string_lossy().into_owned())
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            Err("archive_finalize_failed".into())
        }
    }
}

fn remove_retired_archive(app_data: &Path) -> Result<(), String> {
    let archive_dir = app_data.join("archives");
    for name in [
        "scope-simplification-v12.json",
        "scope-simplification-v12.tmp",
    ] {
        let path = archive_dir.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|_| "archive_delete_failed")?;
        }
    }
    if archive_dir.exists()
        && fs::read_dir(&archive_dir)
            .map_err(|_| "archive_read_dir_failed")?
            .next()
            .is_none()
    {
        fs::remove_dir(&archive_dir).map_err(|_| "archive_delete_dir_failed")?;
    }
    Ok(())
}

#[tauri::command]
fn archive_retired_data(app: tauri::AppHandle, archive_json: String) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "app_data_unavailable")?;
    write_retired_archive(&app_data, &archive_json)
}

#[tauri::command]
fn delete_retired_archive(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "app_data_unavailable")?;
    remove_retired_archive(&app_data)
}

/// Restore a single snapshot item. The frontend owns the queue/cancel
/// state machine; this command performs one item and reports an honest
/// per-item outcome.
#[tauri::command]
fn restore_item(
    known: tauri::State<'_, known_apps::KnownApps>,
    item: RestoreItemDto,
) -> Result<RestoreOutcome, String> {
    Ok(perform_restore(&item, &known))
}

fn perform_restore(item: &RestoreItemDto, known: &known_apps::KnownApps) -> RestoreOutcome {
    match item.kind.as_str() {
        "browser_tab" | "resource" => match validate_http_url(&item.target) {
            Ok(url) => match tauri_plugin_opener::open_url(url, None::<String>) {
                Ok(()) => RestoreOutcome::ok(),
                Err(e) => RestoreOutcome::failed(&format!("open_url: {e}")),
            },
            Err(e) => RestoreOutcome::failed(&e),
        },
        "file" | "folder" => match validate_openable_path(&item.target) {
            Ok(p) => match tauri_plugin_opener::open_path(p, None::<String>) {
                Ok(()) => RestoreOutcome::ok(),
                Err(e) => RestoreOutcome::failed(&format!("open_path: {e}")),
            },
            Err(e) => RestoreOutcome::failed(&e),
        },
        "app" => restore_app(item, known),
        "terminal" => restore_terminal(item),
        // Informational items (git state and linked tasks) are context,
        // not launchable resources.
        "git" | "task" | "note" => RestoreOutcome::skipped("info_only"),
        other => RestoreOutcome::failed(&format!("unknown_kind:{other}")),
    }
}

/// Starts a program a snapshot names. Only one Rust saw running
/// (`known_apps`) starts, or one of the fixed launchers `validate_executable_path`
/// allows by name: the page's word that a path is a program the user had open
/// is not enough to run it.
fn restore_app(item: &RestoreItemDto, known: &known_apps::KnownApps) -> RestoreOutcome {
    // A capture records no arguments and the client sends none.
    if !item.args.is_empty() {
        return RestoreOutcome::failed("unexpected_args");
    }
    let exe = match validation::validate_executable_path(&item.target) {
        Ok(p) => p,
        Err(e) => return RestoreOutcome::failed(&e),
    };
    let by_name = !item.target.contains(['\\', '/']);
    if !by_name && !known.contains(&item.target) && !known.contains(&exe) {
        return RestoreOutcome::failed("app_not_captured");
    }
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&item.args);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return if e.kind() == std::io::ErrorKind::PermissionDenied {
                RestoreOutcome::permission("elevation_required")
            } else {
                RestoreOutcome::failed(&format!("spawn: {e}"))
            };
        }
    };

    #[cfg(windows)]
    {
        if let Some(bounds) = &item.window_bounds {
            // Give the process a bounded window to create its main window.
            let pid = child.id();
            match winapi::reposition_process_window(pid, bounds, 4000) {
                winapi::RepositionResult::Done => RestoreOutcome::ok(),
                winapi::RepositionResult::AccessDenied => {
                    RestoreOutcome::permission("elevation_required")
                }
                winapi::RepositionResult::WindowNotFound => {
                    RestoreOutcome::ok_with("launched_no_reposition")
                }
                winapi::RepositionResult::Failed(e) => {
                    RestoreOutcome::ok_with(&format!("reposition_failed:{e}"))
                }
            }
        } else {
            RestoreOutcome::ok()
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        RestoreOutcome::ok_with("launched_no_reposition")
    }
}

/// The only terminal a snapshot restores: Windows Terminal by its bare name
/// (`wt.exe` is an app execution alias), with at most a validated
/// `-d <dir>`. The renderer chooses nothing else; before, it named
/// the program and every argument but `-d`.
fn terminal_command(item: &RestoreItemDto) -> Result<Vec<String>, &'static str> {
    if !item.target.eq_ignore_ascii_case("wt.exe") {
        return Err("unsupported_terminal");
    }
    let mut args = Vec::new();
    let mut iter = item.args.iter();
    while let Some(arg) = iter.next() {
        if arg != "-d" {
            return Err("unexpected_args");
        }
        let dir = iter.next().ok_or("unexpected_args")?;
        let path = validation::validate_existing_folder(dir).map_err(|_| "missing_path")?;
        args.push("-d".to_string());
        args.push(path);
    }
    Ok(args)
}

fn restore_terminal(item: &RestoreItemDto) -> RestoreOutcome {
    let args = match terminal_command(item) {
        Ok(args) => args,
        Err(reason) => return RestoreOutcome::failed(reason),
    };
    match std::process::Command::new("wt.exe").args(&args).spawn() {
        Ok(_) => RestoreOutcome::ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            RestoreOutcome::failed("missing_executable")
        }
        Err(e) => RestoreOutcome::failed(&format!("spawn: {e}")),
    }
}

/* ------------------------------------------------------------------ */
/* Security Laboratory tool registry + native process supervisor       */
/* ------------------------------------------------------------------ */

/* Every command below is part of the Private Lab surface and therefore opens
with `consent.require()?`. The gate covers enumeration and registration as
well as execution: which tools are installed on this machine is itself
information the user opts into exposing, and a registration performed while
denied would leave a primed surface for the moment consent is granted.
Emergency stop is the single deliberate exception — see its note. */

#[tauri::command]
async fn request_private_tools_grant(
    app: tauri::AppHandle,
    locale: String,
) -> Result<bool, String> {
    let consent = app.state::<PrivateToolsConsent>();
    if consent.is_granted() {
        return Ok(true);
    }
    // Read before the dialog: a revoke while it is showing makes the answer stale.
    let generation = consent.generation();
    let session = app.state::<consent_grant::GrantSession>();
    session.try_begin().map_err(|code| code.to_string())?;
    let copy = consent_grant::dialog_copy(&locale);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let Some(window) = app.get_webview_window("main") else {
        session.cancel_open();
        return Err("consent_dialog_no_window".to_string());
    };
    app.dialog()
        .message(copy.body)
        .title(copy.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            copy.grant.to_string(),
            copy.cancel.to_string(),
        ))
        .parent(&window)
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    let confirmed = rx.await.unwrap_or_default();
    session.finish(confirmed);
    consent_grant::apply_confirmed(&consent, generation, confirmed)
}

/// Withdraw Private Lab. Memory is denied first (even when persisting fails),
/// so nothing new starts. Then the withdrawal reaches what already passed the
/// earlier consent read: assistant dispatch, an approval card already
/// showing, the supervised runs consent allowed, and the terminals that were
/// open (a session id is not checked for consent again, so a terminal left
/// open would stay usable). The persist error, if any, goes back last.
pub(crate) fn withdraw_private_tools(
    consent: &PrivateToolsConsent,
    gate: &DispatchGate,
    assistant: &AssistantState,
    supervisor: &ToolSupervisor,
    terminals: &terminal::TerminalSessions,
) -> Result<(), String> {
    let persisted = consent.revoke();
    gate.invalidate();
    assistant.drop_pending_approval();
    if let Err(error) = supervisor.stop_for_revoked_consent() {
        eprintln!("[Qutra Labs] stopping runs on revoke failed: {error}");
    }
    let closed = terminals.close_all();
    assistant.forget_all_agent_sessions();
    if !closed.failed.is_empty() {
        eprintln!(
            "[Qutra Labs] {} terminal(s) did not stop on revoke",
            closed.failed.len()
        );
    }
    persisted
}

/// Closing the terminals waits for each to end (up to a few seconds), so the
/// work runs off the main thread.
#[tauri::command]
async fn revoke_private_tools_consent(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        withdraw_private_tools(
            &app.state::<PrivateToolsConsent>(),
            &app.state::<DispatchGate>(),
            &app.state::<AssistantState>(),
            &app.state::<ToolSupervisor>(),
            &app.state::<terminal::TerminalSessions>(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn private_tools_consent(consent: tauri::State<'_, PrivateToolsConsent>) -> bool {
    consent.is_granted()
}

/// Private Lab consent as the settings page shows it: whether it holds and,
/// when it does, since when (milliseconds since the Unix epoch; `null` when
/// the time cannot be read).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsentStatus {
    granted: bool,
    granted_at: Option<u64>,
}

#[tauri::command]
fn private_tools_consent_status(consent: tauri::State<'_, PrivateToolsConsent>) -> ConsentStatus {
    ConsentStatus {
        granted: consent.is_granted(),
        granted_at: consent.granted_since_ms(),
    }
}

/* Locate: the executable is chosen in a native dialog opened here, so
the path never comes from the renderer. The renderer receives the inspected
facts for review and an opaque single-use token; registration redeems the
token. There is no command that inspects or registers a renderer-named path.
The renderer supplies only the dialog's translated wording. */
#[tauri::command]
async fn locate_tool_candidate(
    window: tauri::WebviewWindow,
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    title: String,
    filter_name: String,
) -> Result<Option<LocatedCandidate>, String> {
    consent.require()?;
    let title = dialog_label(&title)?;
    let filter_name = dialog_label(&filter_name)?;
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .add_filter(filter_name, &["exe"]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|_| "locate_dialog_failed".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "invalid_tool_path".to_string())?;
    supervisor
        .locate_candidate(&path.to_string_lossy())
        .map(Some)
}

/* Engagement folders: the parent for a new engagement's
folder is chosen in a native dialog opened here, so the path never comes from
the renderer (as for Locate). The renderer gets the path to show and a
single-use token the create redeems; writes name only a file inside a folder
made this way. */
#[tauri::command]
fn engagement_folder_root(folders: tauri::State<'_, EngagementFolders>) -> Option<String> {
    folders.default_root()
}

#[tauri::command]
async fn engagement_folder_pick_parent(
    window: tauri::WebviewWindow,
    folders: tauri::State<'_, EngagementFolders>,
    title: String,
) -> Result<Option<PickedParent>, String> {
    let title = dialog_label(&title)?;
    let dialog = window.dialog().file().set_parent(&window).set_title(title);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|_| "folder_dialog_failed".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "invalid_folder_path".to_string())?;
    folders.remember_pick(&path).map(Some)
}

#[tauri::command]
fn engagement_folder_create(
    folders: tauri::State<'_, EngagementFolders>,
    engagement_id: String,
    name: String,
    parent_token: Option<String>,
) -> Result<FolderInfo, String> {
    folders.create(&engagement_id, &name, parent_token.as_deref())
}

#[tauri::command]
fn engagement_folder_get(
    folders: tauri::State<'_, EngagementFolders>,
    engagement_id: String,
) -> Result<Option<FolderInfo>, String> {
    folders.folder(&engagement_id)
}

#[tauri::command]
fn engagement_folder_write(
    folders: tauri::State<'_, EngagementFolders>,
    engagement_id: String,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    folders.write(&engagement_id, &file_name, &contents)
}

/* Files in an investigation (spec 2026-10-07 §4.2): the picker opens
here and a drop on the window arrives as a window event, so the page never
names a path (as for Locate and the engagement folders). A drop's paths
wait under a single-use token that the page redeems for the investigation it
shows. Copying and hashing run off the async runtime. */
#[tauri::command]
fn investigation_files_list(
    folders: tauri::State<'_, EngagementFolders>,
    files: tauri::State<'_, InvestigationFiles>,
    engagement_id: String,
) -> Result<Vec<FileView>, String> {
    let folder = folders.folder_path(&engagement_id)?;
    files.list(&engagement_id, folder.as_deref())
}

#[tauri::command]
async fn investigation_files_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    folders: tauri::State<'_, EngagementFolders>,
    engagement_id: String,
    title: String,
) -> Result<Vec<AddOutcome>, String> {
    let folder = folders
        .folder_path(&engagement_id)?
        .ok_or_else(|| "no_engagement_folder".to_string())?;
    let title = dialog_label(&title)?;
    let dialog = window.dialog().file().set_parent(&window).set_title(title);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
        .await
        .map_err(|_| "file_dialog_failed".to_string())?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    add_investigation_files(
        app,
        folder,
        engagement_id,
        paths,
        investigation_files::Source::Picked,
    )
    .await
}

#[tauri::command]
async fn investigation_files_add_dropped(
    app: tauri::AppHandle,
    folders: tauri::State<'_, EngagementFolders>,
    files: tauri::State<'_, InvestigationFiles>,
    token: String,
    engagement_id: String,
) -> Result<Vec<AddOutcome>, String> {
    // The folder first: a drop on an investigation without one keeps its
    // token, so it can be added once "Create folder" has made the folder.
    let folder = folders
        .folder_path(&engagement_id)?
        .ok_or_else(|| "no_engagement_folder".to_string())?;
    let paths = files.redeem_drop(&token)?;
    add_investigation_files(
        app,
        folder,
        engagement_id,
        paths,
        investigation_files::Source::Dropped,
    )
    .await
}

/* Built-in analysis (spec 2026-10-07 §6.2). It only reads the
investigation's copy, in process, when the user asks, so it needs no Private
Lab consent and no approval (§6.3). The copy's SHA-256 is checked again
before an analyzer reads it (§4.2); hashing and analysis run off the async
runtime. */
#[tauri::command]
fn analysis_analyzers() -> Vec<analysis::Descriptor> {
    analysis::descriptors()
}

#[tauri::command]
fn analysis_list(
    store: tauri::State<'_, AnalysisStore>,
    engagement_id: String,
) -> Result<Vec<analysis::store::AnalysisRun>, String> {
    store.list(&engagement_id)
}

#[tauri::command]
async fn analysis_run(
    app: tauri::AppHandle,
    folders: tauri::State<'_, EngagementFolders>,
    engagement_id: String,
    file_id: String,
    analyzer: String,
) -> Result<analysis::store::AnalysisRun, String> {
    let analyzer = analysis::analyzer(&analyzer).ok_or_else(|| "unknown_analyzer".to_string())?;
    let folder = folders
        .folder_path(&engagement_id)?
        .ok_or_else(|| "no_engagement_folder".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<AnalysisStore>();
        let _claim = store.claim(&file_id)?;
        let (file, path) =
            app.state::<InvestigationFiles>()
                .verified_copy(&folder, &engagement_id, &file_id)?;
        if !analyzer.accepts(&file.kind) {
            return Err("analyzer_not_for_kind".to_string());
        }
        analysis::run(&store, &file, &path, analyzer)
    })
    .await
    .map_err(|_| "analysis_failed".to_string())?
}

#[tauri::command]
fn analysis_output(
    store: tauri::State<'_, AnalysisStore>,
    run_id: String,
) -> Result<String, String> {
    store.read_output(&run_id)
}

/* External tools on an investigation's files (spec 2026-10-07 §6.1).
The page names a tool by id and a file by id. Rust owns the table of
tools, picks the registered program by its file name, checks the file's
SHA-256 again and builds the argument list itself: nothing here takes a path,
a flag or an installation. Running one needs Private Lab, like every tool
command. The commands only hand the app's states to `external_tools::command_*`,
where the work is, so that a test can call it; the blocking run stays here. */
#[tauri::command]
fn external_tools_list(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
) -> Vec<external_tools::ExternalToolView> {
    external_tools::command_list(&consent, &supervisor)
}

#[tauri::command]
fn external_tool_runs(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    engagement_id: String,
) -> Result<Vec<NativeToolRun>, String> {
    external_tools::command_runs(&consent, &supervisor, &engagement_id)
}

/// A preset of a tool's run form (tool_forms.rs): the page names the form,
/// the preset and the typed values; Rust builds the arguments and starts the
/// run. Blocking: a file field hashes its investigation copy first.
#[tauri::command]
async fn tool_form_run(
    app: tauri::AppHandle,
    request: tool_forms::FormRunRequest,
) -> Result<tool_forms::FormRunStarted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let event_app = app.clone();
        let events: EventSink = Arc::new(move |event: ToolRunEvent| {
            let _ = event_app.emit("contextos://tool-run", event);
        });
        tool_forms::command_run(
            &external_tools::States {
                consent: &app.state::<PrivateToolsConsent>(),
                folders: &app.state::<EngagementFolders>(),
                files: &app.state::<InvestigationFiles>(),
                supervisor: &app.state::<ToolSupervisor>(),
            },
            request,
            events,
        )
    })
    .await
    .map_err(|_| "tool_form_failed".to_string())?
}

#[tauri::command]
fn tool_run_output(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    run_id: String,
    name: String,
) -> Result<String, String> {
    external_tools::command_output(&consent, &supervisor, &run_id, &name)
}

#[tauri::command]
async fn external_tool_run(
    app: tauri::AppHandle,
    engagement_id: String,
    file_id: String,
    tool: String,
    rules_file_id: Option<String>,
) -> Result<NativeToolRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let event_app = app.clone();
        let forward: EventSink = Arc::new(move |event: ToolRunEvent| {
            let _ = event_app.emit("contextos://tool-run", event);
        });
        external_tools::command_run(
            external_tools::TOOLS,
            &external_tools::States {
                consent: &app.state::<PrivateToolsConsent>(),
                folders: &app.state::<EngagementFolders>(),
                files: &app.state::<InvestigationFiles>(),
                supervisor: &app.state::<ToolSupervisor>(),
            },
            &external_tools::RunRequest {
                engagement_id: &engagement_id,
                file_id: &file_id,
                tool: &tool,
                rules_file_id: rules_file_id.as_deref(),
            },
            forward,
        )
    })
    .await
    .map_err(|_| "external_tool_failed".to_string())?
}

async fn add_investigation_files(
    app: tauri::AppHandle,
    folder: PathBuf,
    engagement_id: String,
    paths: Vec<PathBuf>,
    how: investigation_files::Source,
) -> Result<Vec<AddOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = app.state::<InvestigationFiles>();
        paths
            .iter()
            .map(|path| files.add(&folder, &engagement_id, path, how))
            .collect()
    })
    .await
    .map_err(|_| "files_add_failed".to_string())
}

/* Cloud AI keys (spec 2026-10-07 §7.4): write-only. The page saves,
tests for and deletes a connection's key; nothing returns it. */
#[tauri::command]
fn ai_key_set(target: ai::Target, key: String, base_url: Option<String>) -> Result<(), String> {
    ai::keys::set_key(&ai::keys::KeyringStore, target, &key, base_url.as_deref())
}

#[tauri::command]
fn ai_key_has(target: ai::Target) -> Result<ai::keys::KeyStatus, String> {
    ai::keys::key_status(&ai::keys::KeyringStore, target)
}

#[tauri::command]
fn ai_key_delete(target: ai::Target) -> Result<(), String> {
    ai::keys::delete_key(&ai::keys::KeyringStore, target)
}

/* The list of keys (up to ten): add one and Rust recognises the service from
its prefix. Like the commands above, none of these returns a key. */
#[tauri::command]
fn ai_keys_list() -> Result<Vec<ai::key_list::KeyEntry>, String> {
    ai::key_list::list_keys(&ai::keys::KeyringStore)
}

#[tauri::command]
fn ai_keys_add(key: String) -> Result<ai::key_list::KeyEntry, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    ai::key_list::add_key(&ai::keys::KeyringStore, &key, now)
}

#[tauri::command]
fn ai_keys_remove(id: u8) -> Result<(), String> {
    ai::key_list::remove_key(&ai::keys::KeyringStore, id)
}

/// The connection test: list the connection's models with its saved key.
#[tauri::command]
async fn ai_list_models(
    target: ai::Target,
) -> Result<Vec<ai::models::ModelInfo>, ai::errors::AiError> {
    // Credential Manager is a blocking call; keep it off the async workers.
    let cred = tauri::async_runtime::spawn_blocking(move || {
        ai::keys::credential(&ai::keys::KeyringStore, target)
    })
    .await
    .map_err(|_| ai::errors::AiError::Unexpected)?
    .map_err(|_| ai::errors::AiError::KeyUnreadable)?
    .ok_or(ai::errors::AiError::NoKey)?;
    let client = ai::http::client()?;
    ai::models::list_models(&client, target, &cred).await
}

/* Cloud turns: Jarvis talks through Claude or an OpenAI-compatible
service. One turn at a time; the key is read here and goes only to the address
it was saved for. Events go out on `ai://stream`, ending in one `done` or
`error`. The user's exclusions are read here too, from the core's own store:
when they cannot be read the turn is refused, since nothing may leave
unmasked. (Async, so the state comes from `app`: an async command borrowing
`State` would have to return a `Result`.) */
#[tauri::command]
async fn ai_chat_start(
    app: tauri::AppHandle,
    request: ai::chat::CloudChatRequest,
) -> ai::chat::CloudStart {
    if let Err(reason) = ai::chat::validate(&request) {
        return ai::chat::CloudStart::refused(reason);
    }
    let Ok(terms) = ai::exclusions::for_cloud(&app).await else {
        return ai::chat::CloudStart::refused("unexpected");
    };
    let cancel = Arc::new(ai::turn::CancelToken::default());
    if !app
        .state::<ai::chat::CloudTurns>()
        .reserve(&request.request_id, cancel.clone())
    {
        return ai::chat::CloudStart::refused("busy");
    }
    tauri::async_runtime::spawn(async move {
        let request_id = request.request_id.clone();
        let outcome = match ai::http::client() {
            Ok(client) => {
                let emit = |event: ai::chat::CloudEvent| {
                    let _ = app.emit(ai::chat::STREAM_EVENT, event);
                };
                ai::chat::run_turn(
                    &ai::keys::KeyringStore,
                    &client,
                    &request,
                    &terms,
                    &ai::turn::Timing::default(),
                    &cancel,
                    &emit,
                )
                .await
            }
            Err(error) => Err(error),
        };
        // The slot is free before the page hears the end: a turn started the
        // moment this one ends is not told another one is still running.
        app.state::<ai::chat::CloudTurns>().release(&request_id);
        let _ = app.emit(
            ai::chat::STREAM_EVENT,
            ai::chat::final_event(&request_id, outcome),
        );
    });
    ai::chat::CloudStart::accepted()
}

#[tauri::command]
fn ai_chat_cancel(turns: tauri::State<'_, ai::chat::CloudTurns>, request_id: String) -> bool {
    turns.cancel(&request_id)
}

/// A text as a cloud turn would send it, secrets and the user's exclusions
/// masked, for the page to show before it goes (the consent card).
/// Nothing leaves the machine. Exclusions that cannot be read fail it, so
/// the card never shows as safe a text that a turn would refuse.
#[tauri::command]
async fn ai_mask_preview(
    app: tauri::AppHandle,
    text: String,
) -> Result<ai::mask::MaskPreview, String> {
    let terms = ai::exclusions::for_cloud(&app)
        .await
        .map_err(|_| "unexpected".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        ai::mask::preview_with(&text, &terms).map_err(str::to_string)
    })
    .await
    .map_err(|_| "unexpected".to_string())?
}
/// Files dragged over the window: `{ over }` while they hover.
const FILES_DRAG_EVENT: &str = "qutra://files-drag";
/// Files dropped on the window: `{ token, names }`.
const FILES_DROPPED_EVENT: &str = "qutra://files-dropped";
/// A drop's toast names at most this many files.
const DROPPED_NAMES_SHOWN: usize = 20;

#[derive(Clone, Serialize)]
struct FilesDrag {
    over: bool,
}

#[derive(Clone, Serialize)]
struct FilesDropped {
    token: String,
    names: Vec<String>,
}

fn on_files_drag_drop(window: &tauri::Window, event: &tauri::DragDropEvent) {
    match event {
        // A drag of text or a link carries no paths: nothing to outline or add.
        tauri::DragDropEvent::Enter { paths, .. } if !paths.is_empty() => {
            let _ = window.emit(FILES_DRAG_EVENT, FilesDrag { over: true });
        }
        tauri::DragDropEvent::Leave => {
            let _ = window.emit(FILES_DRAG_EVENT, FilesDrag { over: false });
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let _ = window.emit(FILES_DRAG_EVENT, FilesDrag { over: false });
            if paths.is_empty() {
                return;
            }
            let files = window.state::<InvestigationFiles>();
            match files.remember_drop(paths.clone()) {
                Ok(token) => {
                    let names = dropped_names(paths);
                    let _ = window.emit(FILES_DROPPED_EVENT, FilesDropped { token, names });
                }
                Err(error) => eprintln!("[Qutra Labs] a drop could not be kept: {error}"),
            }
        }
        _ => {}
    }
}

/// The names a drop's toast shows: file names only, never the folders they
/// came from.
fn dropped_names(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| path.file_name())
        .take(DROPPED_NAMES_SHOWN)
        .map(|name| name.to_string_lossy().into_owned())
        .collect()
}

fn dialog_label(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.chars().any(char::is_control)
    {
        return Err("invalid_dialog_label".into());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
fn register_tool_installation(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    request: RegisterLocatedToolRequest,
) -> Result<ToolInstallationRecord, String> {
    consent.require()?;
    supervisor.register_located(request)
}

#[tauri::command]
fn list_tool_installations(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
) -> Result<Vec<ListedToolInstallation>, String> {
    consent.require()?;
    supervisor.list_tools_with_presence()
}

/* Look for the toolbox's programs on this computer (read only). The renderer
names no path; it may only say which toolbox items it already has, so those
are not looked for again. Each program found that the registry does not hold
comes back with an opaque token to register by, like a picked file. */
#[tauri::command]
async fn detect_tool_installations(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    skip_catalog_ids: Vec<String>,
) -> Result<Vec<tool_detect::DetectedTool>, String> {
    consent.require()?;
    let skip = tool_detect::check_skipped_ids(&skip_catalog_ids)?;
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.detect_tools(&skip))
        .await
        .map_err(|_| "detect_failed".to_string())
}

#[tauri::command]
fn get_tool_installation(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    id: String,
) -> Result<ToolInstallationRecord, String> {
    consent.require()?;
    supervisor.get_tool(&id)
}

#[tauri::command]
fn reverify_tool_installation(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    id: String,
    accept_changed_identity: bool,
) -> Result<ToolInstallationRecord, String> {
    consent.require()?;
    supervisor.reverify_tool(&id, accept_changed_identity)
}

#[tauri::command]
fn set_tool_installation_enabled(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    id: String,
    enabled: bool,
) -> Result<ToolInstallationRecord, String> {
    consent.require()?;
    supervisor.set_tool_enabled(&id, enabled)
}

#[tauri::command]
fn remove_tool_installation(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    id: String,
) -> Result<(), String> {
    consent.require()?;
    supervisor.remove_tool(&id)
}

/* Official logos for registered tools with no bundled logo (tool_logos.rs).
The page names installations only; Rust reads each one's documentation
address from the registry and decides where its logo may come from. The page
asks to fetch only on the user's own step (registering a tool, or "Find
logos"), and only while the setting allows it. */
#[tauri::command]
fn tool_logos_list(
    consent: tauri::State<'_, PrivateToolsConsent>,
    logos: tauri::State<'_, tool_logos::ToolLogos>,
    ids: Vec<String>,
) -> Result<Vec<tool_logos::ToolLogoView>, String> {
    consent.require()?;
    logos.views(&ids)
}

#[tauri::command]
async fn tool_logo_fetch(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    logos: tauri::State<'_, tool_logos::ToolLogos>,
    id: String,
) -> Result<tool_logos::ToolLogoView, String> {
    consent.require()?;
    let record = supervisor.get_tool(&id)?;
    if let Some(recorded) = logos.begin(&id)? {
        return Ok(recorded);
    }
    let fetch = match tool_logos::HttpFetch::new() {
        Ok(fetch) => tool_logos::Tracked::new(fetch),
        Err(reason) => {
            logos.abandon(&id);
            return Err(reason);
        }
    };
    let plan = tool_logos::plan_for(&record.doc_url);
    let found = tool_logos::resolve(&plan, &fetch).await;
    if found.is_none() && plan != tool_logos::LogoPlan::Nothing && !fetch.reached() {
        // Offline: nothing was learned, so nothing is recorded.
        logos.abandon(&id);
        return Err("logo_source_unreachable".into());
    }
    logos.finish(&id, found)
}

#[tauri::command]
fn start_tool_run(
    app: tauri::AppHandle,
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    request: StartToolRunRequest,
) -> Result<NativeToolRun, String> {
    consent.require()?;
    let event_app = app.clone();
    let events = Arc::new(move |event: ToolRunEvent| {
        let _ = event_app.emit("contextos://tool-run", event);
    });
    // Asked again under the supervisor's lock, so a revoke that lands while
    // this start is under way cannot leave its run going.
    supervisor.start_run_while(request, events, || consent.is_granted())
}

#[tauri::command]
fn cancel_tool_run(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    run_id: String,
) -> Result<(), String> {
    consent.require()?;
    supervisor.cancel_run(&run_id)
}

/// Deliberately **not** consent-gated.
///
/// This only ever stops processes; it can never start one. If consent is
/// revoked while runs are live, the user must still be able to halt them —
/// gating the kill switch behind the permission being withdrawn would strand
/// running executables with no way to stop them from the UI.
#[tauri::command]
fn emergency_stop_tool_runs(supervisor: tauri::State<'_, ToolSupervisor>) -> Result<usize, String> {
    supervisor.emergency_stop()
}

#[tauri::command]
fn list_tool_runs(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
) -> Result<Vec<NativeToolRun>, String> {
    consent.require()?;
    supervisor.list_runs()
}

#[tauri::command]
fn list_active_tool_runs(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
) -> Result<Vec<NativeToolRun>, String> {
    consent.require()?;
    supervisor.list_active_runs()
}

#[tauri::command]
fn delete_tool_run_artifacts(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    run_id: String,
) -> Result<NativeToolRun, String> {
    consent.require()?;
    supervisor.delete_run_artifacts(&run_id)
}

/// Launch a registered installation as a detached, unsupervised GUI process.
///
/// The renderer never names a path: it passes an `installation_id`, and
/// `resolve_launchable` resolves that id server-side to the registry's
/// `canonical_path` and registered working directory through the same gate
/// the batch Run button uses (`ToolRegistry::resolve_for_run`) — enabled
/// check, stored changed-identity check, and a live re-hash of the binary
/// on disk, so drift since the last `reverify` is caught at launch time,
/// not just read off a stale flag. Refuses a missing, disabled,
/// identity-changed, or path-missing installation.
///
/// The spawned process is not tracked by the tool supervisor (a GUI app
/// owns its own lifetime) — this only starts it, but it starts it isolated
/// the same way the supervised batch path does (`build_detached_command`):
/// pinned to the registry's working dir, a cleared environment plus the
/// curated baseline, and null stdio, since nothing here reads the child's
/// streams. argv only — never a shell string.
///
/// Every attempt is recorded by Rust (`launch_receipts.rs`) and the
/// receipt is the reply: `outcome` says launched, failed (with a stable
/// `reasonCode`) or unknown. `Err` means no attempt was made — consent
/// missing, a malformed request, a reused `operation_id`, or a receipt that
/// could not be written before the spawn. Repeating `operation_id` returns
/// the recorded attempt and launches nothing.
#[tauri::command]
fn launch_tool_detached(
    consent: tauri::State<'_, PrivateToolsConsent>,
    supervisor: tauri::State<'_, ToolSupervisor>,
    receipts: tauri::State<'_, LaunchReceipts>,
    operation_id: String,
    installation_id: String,
    args: Vec<String>,
) -> Result<LaunchReceipt, String> {
    consent.require()?;
    tool_supervisor::validate_arguments(&args)?;
    launch_receipts::launch_recorded(
        &receipts,
        LaunchRequest {
            operation_id: &operation_id,
            installation_id: &installation_id,
            origin: LaunchOrigin::Manual,
        },
        supervisor.resolve_launch_for_receipt(&installation_id),
        |target| {
            tool_supervisor::build_detached_command(target, &args)
                .spawn()
                .map(|child| child.id())
        },
    )
}

/// Recent launch receipts, newest first (data contracts §4). Read from Rust's
/// ledger, never from the renderer's document store.
#[tauri::command]
fn tool_launches_list(
    consent: tauri::State<'_, PrivateToolsConsent>,
    receipts: tauri::State<'_, LaunchReceipts>,
    limit: Option<usize>,
) -> Result<Vec<LaunchReceipt>, String> {
    consent.require()?;
    Ok(receipts.list(limit.unwrap_or(launch_receipts::MAX_RECEIPTS)))
}

/* ------------------------------------------------------------------ */
/* SQL migrations (document store — see ADR 0002)                      */
/* ------------------------------------------------------------------ */

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "document store: records + kv + notes FTS",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "kept in lockstep with app migration v2 (carriedOverCount default is applied by the zod boundary)",
            sql: include_str!("../migrations/0002_task_carried_over.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "lockstep with app migration v3 (Context Object Graph links collection uses the generic records table)",
            sql: include_str!("../migrations/0003_object_graph.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "lockstep with app migration v4 (Knowledge pages collection uses the generic records table)",
            sql: include_str!("../migrations/0004_knowledge_pages.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "lockstep with app migration v5 (Security Laboratory collections use the generic records table)",
            sql: include_str!("../migrations/0005_security_lab.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "lockstep with app migration v6 (findings/evidence/report collections use the generic records table)",
            sql: include_str!("../migrations/0006_findings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "lockstep with app migration v7 (workbench shell layout preferences are additive Preferences fields)",
            sql: include_str!("../migrations/0007_workbench_layout.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "lockstep with app migration v8 (evidence links and provenance are normalized application data)",
            sql: include_str!("../migrations/0008_evidence_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "lockstep with app migration v9 (persistent workbench tabs are additive Preferences data)",
            sql: include_str!("../migrations/0009_workbench_tabs.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "lockstep with app migration v10 (Security Academy learning state is additive Preferences data)",
            sql: include_str!("../migrations/0010_lab_academy.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "lockstep with app migration v11 (competition sprint and rubric state are additive Preferences data)",
            sql: include_str!("../migrations/0011_lab_competition.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "lockstep with app migration v12 (retired module archive and core navigation normalization)",
            sql: include_str!("../migrations/0012_scope_simplification.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "lockstep with app migration v13 (default appearance pack contextos to hud)",
            sql: include_str!("../migrations/0013_hud_default_pack.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "lockstep with app migration v14 (the assistant transcript becomes a conversation document)",
            sql: include_str!("../migrations/0014_conversations.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "lockstep with app migration v15 (evidence can point at an analysis observation)",
            sql: include_str!("../migrations/0015_evidence_observations.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProfile {
    identifier: String,
    app_config_dir: String,
    app_local_data_dir: String,
}

#[tauri::command]
fn runtime_profile(app: tauri::AppHandle) -> Result<RuntimeProfile, String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("runtime_profile_path_failed:{error}"))?;
    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("runtime_profile_local_path_failed:{error}"))?;
    Ok(RuntimeProfile {
        identifier: app.config().identifier.clone(),
        app_config_dir: app_config_dir.to_string_lossy().into_owned(),
        app_local_data_dir: app_local_data_dir.to_string_lossy().into_owned(),
    })
}

/// The lock that keeps a second copy of the app from starting (winapi.rs).
#[cfg(windows)]
const INSTANCE_LOCK: &str = "Local\\app.contextos.desktop";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if !winapi::acquire_instance_lock(INSTANCE_LOCK) {
        winapi::focus_window_titled("Qutra Labs");
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let supervisor = ToolSupervisor::load(&app_data).map_err(io::Error::other)?;
            app.manage(supervisor);
            let receipt_app = app.handle().clone();
            let receipts = LaunchReceipts::load(
                &app_data,
                Arc::new(move |receipt: &LaunchReceipt| {
                    let _ = receipt_app.emit(launch_receipts::LAUNCH_EVENT, receipt);
                }),
            );
            app.manage(receipts);
            // Fail-closed: a profile with no recorded grant comes up denied.
            app.manage(PrivateToolsConsent::load(&app_data));
            app.manage(known_apps::KnownApps::load(&app_data));
            app.manage(EngagementFolders::load(
                &app_data,
                app.path().document_dir().ok(),
            ));
            app.manage(InvestigationFiles::load(&app_data));
            app.manage(tool_logos::ToolLogos::load(&app_data));
            app.manage(AnalysisStore::load(&app_data));
            // Jarvis's local engine: started on demand, stopped when idle
            // (ADR 0016). Its build and the user's models live under the
            // app's local data folder.
            app.manage(local_engine::LocalEngine::new(
                &app.path().app_local_data_dir()?,
            ));
            local_engine::commands::attach(app.handle());
            app.manage(builtin_tools::BuiltinTools::default());
            app.manage(ai::chat::CloudTurns::default());
            // Qutra broker state: one in-flight turn plus a bounded audit log.
            app.manage(AssistantState::default());
            app.manage(DispatchGate::default());
            app.manage(consent_grant::GrantSession::default());
            app.manage(terminal::TerminalSessions::with_sink(
                terminal::commands::session_event_sink(app.handle().clone()),
            ));
            Ok(())
        })
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:contextos.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drop) = event {
                on_files_drag_drop(window, drop);
            }
        })
        .invoke_handler(tauri::generate_handler![
            brand::set_brand_window_icon,
            list_running_apps,
            list_monitors,
            open_url_checked,
            open_path_checked,
            archive_retired_data,
            delete_retired_archive,
            restore_item,
            assistant::commands::assistant_health,
            assistant::commands::assistant_models,
            assistant::commands::assistant_start,
            assistant::commands::assistant_cancel,
            assistant::commands::assistant_approve_tool,
            assistant::commands::abandon_previous_renderer,
            local_engine::commands::local_engine_status,
            local_engine::commands::local_engine_start,
            local_engine::commands::local_engine_stop,
            local_engine::commands::local_engine_set_idle,
            local_engine::commands::local_engine_install,
            local_engine::commands::local_models_list,
            local_engine::commands::local_model_prepare,
            local_engine::commands::local_model_delete_copy,
            local_engine::commands::local_models_open_folder,
            local_engine::commands::local_task_cancel,
            github::commands::github_api_get,
            github::commands::github_device_start,
            github::commands::github_device_poll,
            github::commands::github_graphql,
            terminal::commands::terminal_open,
            terminal::commands::terminal_open_tool,
            terminal::commands::terminal_resolved_shell,
            terminal::commands::terminal_write,
            terminal::commands::terminal_resize,
            terminal::commands::terminal_close,
            terminal::commands::terminal_close_all,
            terminal::commands::terminal_scrollback,
            terminal::commands::terminal_list_sessions,
            request_private_tools_grant,
            revoke_private_tools_consent,
            private_tools_consent,
            private_tools_consent_status,
            locate_tool_candidate,
            detect_tool_installations,
            engagement_folder_root,
            engagement_folder_pick_parent,
            engagement_folder_create,
            engagement_folder_get,
            engagement_folder_write,
            investigation_files_list,
            investigation_files_pick,
            investigation_files_add_dropped,
            sample_data::sample_data_generate,
            analysis_analyzers,
            analysis_list,
            analysis_run,
            analysis_output,
            builtin_tools::commands::builtin_metadata_pick,
            builtin_tools::commands::builtin_connections,
            builtin_tools::commands::builtin_rdap,
            builtin_tools::commands::builtin_tls,
            builtin_tools::commands::builtin_http,
            builtin_tools::commands::builtin_deps_pick,
            builtin_tools::commands::builtin_deps_check,
            builtin_tools::commands::builtin_cancel,
            external_tools_list,
            external_tool_runs,
            external_tool_run,
            tool_run_output,
            tool_form_run,
            ai_key_set,
            ai_key_has,
            ai_key_delete,
            ai_keys_list,
            ai_keys_add,
            ai_keys_remove,
            ai_list_models,
            ai_chat_start,
            ai_chat_cancel,
            ai_mask_preview,
            register_tool_installation,
            list_tool_installations,
            get_tool_installation,
            reverify_tool_installation,
            set_tool_installation_enabled,
            remove_tool_installation,
            start_tool_run,
            cancel_tool_run,
            emergency_stop_tool_runs,
            list_tool_runs,
            list_active_tool_runs,
            delete_tool_run_artifacts,
            launch_tool_detached,
            tool_logos_list,
            tool_logo_fetch,
            tool_launches_list,
            runtime_profile,
            storage_writes::storage_apply_writes,
            storage_writes::storage_load,
            secure::secure_set,
            secure::secure_has,
            secure::secure_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Qutra Labs");
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A terminal that was open when Private Lab is withdrawn must not stay
    /// open: its id is not checked for consent again.
    #[test]
    fn withdrawing_private_lab_closes_the_open_terminals() {
        let dir = tempdir().expect("tempdir");
        let supervisor = ToolSupervisor::load(dir.path()).expect("supervisor");
        let consent = PrivateToolsConsent::load(dir.path());
        consent.grant(consent.generation()).expect("grant");
        let terminals = terminal::TerminalSessions::default();
        let shell = terminal::SpawnConfig {
            target: terminal::SpawnTarget::Shell(terminal::ShellKind::PowerShell),
            cwd: None,
            cols: 80,
            rows: 24,
            origin: terminal::lifecycle::SessionOrigin::User,
        };
        terminals.open(shell, |_, _| {}).expect("open a terminal");
        assert_eq!(terminals.list().sessions.len(), 1);

        withdraw_private_tools(
            &consent,
            &DispatchGate::default(),
            &AssistantState::default(),
            &supervisor,
            &terminals,
        )
        .expect("withdraw");

        assert!(!consent.is_granted());
        assert!(terminals.list().sessions.is_empty());
    }

    #[test]
    fn a_drop_toast_names_files_never_their_folders() {
        let paths = vec![
            PathBuf::from(r"C:\Users\me\Desktop\photo.jpg"),
            PathBuf::from(r"D:\cases\capture.pcap"),
        ];
        assert_eq!(dropped_names(&paths), vec!["photo.jpg", "capture.pcap"]);
        let many: Vec<PathBuf> = (0..25)
            .map(|n| PathBuf::from(format!(r"C:\drop\{n}.txt")))
            .collect();
        assert_eq!(dropped_names(&many).len(), DROPPED_NAMES_SHOWN);
    }

    fn item(kind: &str, target: &str) -> RestoreItemDto {
        RestoreItemDto {
            kind: kind.into(),
            title: "t".into(),
            target: target.into(),
            args: vec![],
            window_bounds: None,
        }
    }

    #[test]
    fn retired_archive_is_idempotent_and_rejects_secrets() {
        let dir = tempdir().expect("tempdir");
        let safe = r#"{"format":"contextos-retired-modules","version":12,"collections":{"notes":[{"body":"[REDACTED]"}]}}"#;
        let first = write_retired_archive(dir.path(), safe).expect("first archive");
        let second = write_retired_archive(dir.path(), safe).expect("second archive");
        assert_eq!(first, second);
        assert!(Path::new(&first).exists());
        remove_retired_archive(dir.path()).expect("delete archive");
        assert!(!Path::new(&first).exists());
        remove_retired_archive(dir.path()).expect("idempotent delete");

        let unsafe_payload = r#"{"format":"contextos-retired-modules","version":12,"collections":{"notes":[{"body":"ghp_abcdefghijklmnopqrstuvwxyz"}]}}"#;
        let unsafe_dir = tempdir().expect("unsafe tempdir");
        assert_eq!(
            write_retired_archive(unsafe_dir.path(), unsafe_payload),
            Err("archive_contains_secret".into())
        );
    }

    #[test]
    fn words_that_only_contain_a_token_prefix_are_not_secrets() {
        for text in ["task-12 is done", "high-risk-item", "desk-lamp", "the-ask-"] {
            assert!(!has_token_prefix(text), "{text}");
        }
        for text in ["sk-abcdef", "key sk-abcdef", "\"ghp_abc\"", "(AKIAABCDEF)"] {
            assert!(has_token_prefix(text), "{text}");
        }
    }

    #[test]
    fn info_kinds_are_skipped_not_faked() {
        for kind in ["git", "task", "note"] {
            let out = restore(&item(kind, "anything"));
            assert_eq!(out.state, "skipped");
            assert_eq!(out.reason.as_deref(), Some("info_only"));
        }
    }

    /// A restore as it runs when no program has been seen running.
    fn restore(item: &RestoreItemDto) -> RestoreOutcome {
        perform_restore(item, &known_apps::KnownApps::empty())
    }

    /// A program the page names is started only when Rust saw it running
    /// (`list_running_apps`), however real the file is.
    #[test]
    fn an_app_nobody_saw_running_is_never_started() {
        let dir = tempdir().expect("tempdir");
        let exe = dir.path().join("payload.exe");
        fs::write(&exe, b"MZ").expect("write test file");
        let target = exe.to_string_lossy().into_owned();

        let out = restore(&item("app", &target));
        assert_eq!(out.state, "failed");
        assert_eq!(out.reason.as_deref(), Some("app_not_captured"));

        // Seen once: it is past this check (and then fails to start, because
        // the file is not a program), never "app_not_captured".
        let known = known_apps::KnownApps::load(dir.path());
        known.remember([target.as_str()]);
        let out = perform_restore(&item("app", &target), &known);
        assert_ne!(out.reason.as_deref(), Some("app_not_captured"));
    }

    #[test]
    fn unknown_kind_fails_explicitly() {
        let out = restore(&item("hologram", "x"));
        assert_eq!(out.state, "failed");
        assert!(out.reason.unwrap().starts_with("unknown_kind"));
    }

    #[test]
    fn url_kinds_reject_non_http_schemes() {
        for bad in ["javascript:alert(1)", "file:///C:/x", "ftp://x", "notaurl"] {
            let out = restore(&item("browser_tab", bad));
            assert_eq!(out.state, "failed", "{bad} must not open");
        }
    }

    #[test]
    fn missing_paths_and_executables_fail_honestly() {
        let out = restore(&item("file", "C:\\definitely\\missing\\f.txt"));
        assert_eq!(out.state, "failed");
        let out = restore(&item("app", "C:\\missing\\app.exe"));
        assert_eq!(out.state, "failed");
        assert_eq!(out.reason.as_deref(), Some("missing_executable"));
    }

    /// Files the shell would run when opened, plus a network path: none may
    /// reach the opener, from the command or from a restore.
    fn unopenable_targets(dir: &Path) -> Vec<String> {
        let mut targets: Vec<String> = [
            "tool.exe",
            "run.bat",
            "link.lnk",
            "page.hta",
            "x.exe.sample",
        ]
        .iter()
        .map(|name| {
            let file = dir.join(name);
            fs::write(&file, b"x").expect("write test file");
            file.to_string_lossy().into_owned()
        })
        .collect();
        targets.push(r"\\localhost\c$\Windows\notepad.exe".into());
        targets
    }

    /// Permission identifiers a capability file grants, whether written as a
    /// string or as an object with an `identifier`.
    fn granted_permissions(file: &Path) -> Vec<String> {
        let text = fs::read_to_string(file).expect("read capability file");
        let capability: serde_json::Value = serde_json::from_str(&text).expect("capability json");
        capability["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .filter_map(|entry| {
                entry
                    .as_str()
                    .or_else(|| entry["identifier"].as_str())
                    .map(str::to_string)
            })
            .collect()
    }

    /// The window opens addresses and paths only through `open_url_checked` and
    /// `open_path_checked`, and reaches the database only through
    /// `storage_load` and `storage_apply_writes`. A plugin permission for
    /// either would let the page skip those checks: the opener plugin opens
    /// any URL, the SQL plugin runs any statement and loads any file.
    #[test]
    fn the_window_holds_no_opener_or_sql_permission() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut seen = 0;
        for entry in fs::read_dir(&dir).expect("capabilities folder") {
            let file = entry.expect("capability entry").path();
            if file.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            seen += 1;
            for permission in granted_permissions(&file) {
                for forbidden in ["opener:", "sql:", "fs:", "shell:", "http:"] {
                    assert!(
                        !permission.starts_with(forbidden),
                        "{} grants {permission}",
                        file.display()
                    );
                }
            }
        }
        assert!(seen >= 3, "the capability files were not found");
    }

    #[test]
    fn open_path_refuses_programs_scripts_shortcuts_and_shares() {
        let dir = tempdir().expect("tempdir");
        for target in unopenable_targets(dir.path()) {
            assert!(open_path_checked(target.clone()).is_err(), "{target}");
        }
    }

    #[test]
    fn restore_never_opens_programs_scripts_shortcuts_or_shares() {
        let dir = tempdir().expect("tempdir");
        for kind in ["file", "folder"] {
            for target in unopenable_targets(dir.path()) {
                let out = restore(&item(kind, &target));
                assert_eq!(out.state, "failed", "{kind} {target}");
            }
        }
    }

    #[test]
    fn app_restore_never_starts_a_program_from_a_share() {
        let out = restore(&item("app", r"\\localhost\c$\Windows\notepad.exe"));
        assert_eq!(out.state, "failed");
        assert_eq!(out.reason.as_deref(), Some("network_path"));
    }

    #[test]
    fn terminal_with_missing_cwd_fails() {
        let mut it = item("terminal", "wt.exe");
        it.args = vec!["-d".into(), "C:\\definitely\\missing\\dir".into()];
        let out = restore(&it);
        assert_eq!(out.state, "failed");
        assert_eq!(out.reason.as_deref(), Some("missing_path"));
    }

    // A restore runs only what a capture records. These never spawn.
    #[test]
    fn terminal_restore_names_windows_terminal_only() {
        for target in [
            "cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "powershell.exe",
            "C:\\tools\\wt.exe",
            "wt.exe.bat",
        ] {
            assert_eq!(
                terminal_command(&item("terminal", target)),
                Err("unsupported_terminal"),
                "{target}"
            );
        }
        assert_eq!(terminal_command(&item("terminal", "WT.EXE")), Ok(vec![]));
    }

    #[test]
    fn terminal_restore_takes_only_a_folder() {
        let mut it = item("terminal", "wt.exe");
        it.args = vec!["new-tab".into(), "cmd".into()];
        assert_eq!(terminal_command(&it), Err("unexpected_args"));
        it.args = vec!["-d".into()];
        assert_eq!(terminal_command(&it), Err("unexpected_args"));
        let dir = tempdir().expect("tempdir");
        it.args = vec!["-d".into(), dir.path().to_string_lossy().into_owned()];
        assert_eq!(terminal_command(&it).map(|args| args.len()), Ok(2));
        // A file or a share is not a folder to start in.
        let file = dir.path().join("a.txt");
        fs::write(&file, b"x").expect("write test file");
        for bad in [
            file.to_string_lossy().into_owned(),
            r"\\localhost\c$".to_string(),
        ] {
            it.args = vec!["-d".into(), bad.clone()];
            assert_eq!(terminal_command(&it), Err("missing_path"), "{bad}");
        }
    }

    #[test]
    fn app_restore_refuses_arguments() {
        let mut it = item("app", "C:\\missing\\app.exe");
        it.args = vec!["/c".into(), "calc".into()];
        assert_eq!(restore(&it).reason.as_deref(), Some("unexpected_args"));
    }
}
