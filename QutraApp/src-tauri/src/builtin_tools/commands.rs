//! The built-in tools' commands. Each one needs Private Lab, like every tool
//! command; the page names a request id, a target it typed and that
//! target's scope decision, never a path or a flag. Files are picked in a
//! dialog Rust opens.

use std::{path::PathBuf, time::Duration};

use tauri_plugin_dialog::DialogExt;

use super::{
    access_for, check_scope, client, conns, deps, guarded, httpsec, metadata, now_ms, rdap, tls,
    BuiltinTools,
};
use crate::{consent::PrivateToolsConsent, net_guard::Access, tool_supervisor::ScopeAttestation};

const RDAP_LIMIT: Duration = Duration::from_secs(20);
const TLS_LIMIT: Duration = Duration::from_secs(30);
const TLS_STEP_LIMIT: Duration = Duration::from_secs(10);
const HTTP_LIMIT: Duration = Duration::from_secs(25);
const OSV_LIMIT: Duration = Duration::from_secs(90);

fn dialog_title(title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
        return Err("invalid_title".into());
    }
    Ok(title.to_string())
}

/// Metadata inspector: pick one file and read what it says about itself.
/// `None` when the dialog is closed without a file.
#[tauri::command]
pub async fn builtin_metadata_pick(
    window: tauri::WebviewWindow,
    consent: tauri::State<'_, PrivateToolsConsent>,
    title: String,
) -> Result<Option<metadata::MetadataReport>, String> {
    consent.require()?;
    let title = dialog_title(&title)?;
    let dialog = window.dialog().file().set_parent(&window).set_title(title);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|_| "file_dialog_failed".to_string())?;
    let Some(path) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || metadata::inspect(&path))
        .await
        .map_err(|_| "read_failed".to_string())?
        .map(Some)
        .map_err(|_| "read_failed".to_string())
}

/// Connection and PID monitor: the TCP and UDP tables, now.
#[tauri::command]
pub async fn builtin_connections(
    consent: tauri::State<'_, PrivateToolsConsent>,
) -> Result<conns::Snapshot, String> {
    consent.require()?;
    tauri::async_runtime::spawn_blocking(|| conns::snapshot(now_ms()))
        .await
        .map_err(|_| "read_failed".to_string())
}

/// IP / RDAP / ASN lookup through rdap.org.
#[tauri::command]
pub async fn builtin_rdap(
    consent: tauri::State<'_, PrivateToolsConsent>,
    tools: tauri::State<'_, BuiltinTools>,
    request_id: String,
    target: String,
    scope: ScopeAttestation,
) -> Result<rdap::RdapReport, String> {
    consent.require()?;
    let query = rdap::parse_query(&target)?;
    check_scope(&target, &query.host(), &scope, now_ms())?;
    let http = client(RDAP_LIMIT, Access::Public)?;
    guarded(&tools, &request_id, RDAP_LIMIT, rdap::lookup(&http, &query)).await
}

/// TLS certificate inspector: handshakes with `host:port`.
#[tauri::command]
pub async fn builtin_tls(
    consent: tauri::State<'_, PrivateToolsConsent>,
    tools: tauri::State<'_, BuiltinTools>,
    request_id: String,
    target: String,
    scope: ScopeAttestation,
) -> Result<tls::TlsReport, String> {
    consent.require()?;
    let parsed = tls::parse_target(&target)?;
    check_scope(&target, &parsed.host, &scope, now_ms())?;
    guarded(
        &tools,
        &request_id,
        TLS_LIMIT,
        tls::inspect(&parsed, TLS_STEP_LIMIT),
    )
    .await
}

/// HTTP security analyzer: one GET and its same-host redirects.
#[tauri::command]
pub async fn builtin_http(
    consent: tauri::State<'_, PrivateToolsConsent>,
    tools: tauri::State<'_, BuiltinTools>,
    request_id: String,
    target: String,
    scope: ScopeAttestation,
) -> Result<httpsec::HttpReport, String> {
    consent.require()?;
    let url = httpsec::parse_url(&target)?;
    let host = httpsec::scope_host(&url);
    check_scope(&target, &host, &scope, now_ms())?;
    let http = client(HTTP_LIMIT, access_for(&host))?;
    guarded(
        &tools,
        &request_id,
        HTTP_LIMIT,
        httpsec::analyze(&http, url, now_ms()),
    )
    .await
}

/// Dependency and CVE center, step one: pick manifests and read their
/// packages. Nothing is sent. `None` when the dialog is closed.
#[tauri::command]
pub async fn builtin_deps_pick(
    window: tauri::WebviewWindow,
    consent: tauri::State<'_, PrivateToolsConsent>,
    tools: tauri::State<'_, BuiltinTools>,
    title: String,
) -> Result<Option<deps::PickedView>, String> {
    consent.require()?;
    let title = dialog_title(&title)?;
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .add_filter("Manifest", &["json", "lock", "txt", "mod"]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
        .await
        .map_err(|_| "file_dialog_failed".to_string())?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    if paths.is_empty() {
        return Ok(None);
    }
    let read = tauri::async_runtime::spawn_blocking(move || deps::read_picked(&paths))
        .await
        .map_err(|_| "read_failed".to_string())?;
    let view = read.view();
    tools.set_manifests(read);
    Ok(Some(view))
}

/// Step two, on the user's click: send the picked packages' names and
/// versions to OSV.dev.
#[tauri::command]
pub async fn builtin_deps_check(
    consent: tauri::State<'_, PrivateToolsConsent>,
    tools: tauri::State<'_, BuiltinTools>,
    request_id: String,
    token: String,
) -> Result<deps::OsvReport, String> {
    consent.require()?;
    let picked = tools
        .manifests(&token)
        .ok_or_else(|| "manifests_gone".to_string())?;
    if picked.packages.is_empty() {
        return Err("no_packages".into());
    }
    let http = client(OSV_LIMIT, Access::Public)?;
    guarded(
        &tools,
        &request_id,
        OSV_LIMIT,
        deps::check(&http, &picked.packages, now_ms()),
    )
    .await
}

/// Stop a built-in tool's request. `false` when none was running.
#[tauri::command]
pub fn builtin_cancel(tools: tauri::State<'_, BuiltinTools>, request_id: String) -> bool {
    tools.cancel(&request_id)
}
