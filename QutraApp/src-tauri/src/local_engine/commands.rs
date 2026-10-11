//! What the page may ask of the local engine. No command takes a path, a
//! port, a flag or an address: models are named by id, and Rust resolves
//! everything else.

use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::models::{LocalModel, ModelState};
use super::process::EngineStatus;
use super::{binary, LocalEngine, LocalEngineError, TaskEvent, TaskKind, STATUS_EVENT, TASK_EVENT};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineReport {
    pub status: EngineStatus,
    pub installed: bool,
    pub build: &'static str,
    pub commit: &'static str,
    /// What the one-time download is, so the page can say it before the
    /// click: where from, how big.
    pub download_source: &'static str,
    pub download_bytes: u64,
    pub task: Option<TaskEvent>,
}

fn report(local: &LocalEngine) -> EngineReport {
    EngineReport {
        status: local.engine.status(),
        installed: local.installed(),
        build: binary::BUILD,
        commit: binary::COMMIT,
        download_source: "github.com/ggml-org/llama.cpp",
        download_bytes: binary::ASSET_SIZE,
        task: local.task(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsReport {
    pub models: Vec<LocalModel>,
    /// Ollama's model store was found (read only; Ollama need not run).
    pub ollama_store: bool,
    /// Free space where prepared copies go, when Windows says.
    pub free_bytes: Option<u64>,
}

async fn blocking<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&LocalEngine) -> T + Send + 'static,
) -> Result<T, LocalEngineError> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || work(&app.state::<LocalEngine>()))
        .await
        .map_err(|_| LocalEngineError::Io)
}

#[tauri::command]
pub fn local_engine_status(app: tauri::AppHandle) -> EngineReport {
    report(&app.state::<LocalEngine>())
}

#[tauri::command]
pub async fn local_models_list(app: tauri::AppHandle) -> Result<ModelsReport, LocalEngineError> {
    blocking(&app, |local| {
        let _ = std::fs::create_dir_all(&local.models_dir);
        ModelsReport {
            models: local.models(),
            ollama_store: local.ollama_root.as_ref().is_some_and(|p| p.is_dir()),
            free_bytes: super::free_space(&local.models_dir),
        }
    })
    .await
}

/// Start the engine with a model now, instead of on the first question.
#[tauri::command]
pub async fn local_engine_start(
    app: tauri::AppHandle,
    model: String,
) -> Result<EngineStatus, LocalEngineError> {
    let id = model.clone();
    let target = blocking(&app, move |local| local.resolve(&id)).await??;
    let local = app.state::<LocalEngine>();
    let lease = local.engine.ensure(&target, 0).await?;
    drop(lease);
    Ok(local.engine.status())
}

#[tauri::command]
pub async fn local_engine_stop(app: tauri::AppHandle) -> EngineStatus {
    let local = app.state::<LocalEngine>();
    local.engine.stop().await;
    local.engine.status()
}

/// Minutes of idleness before the engine stops: 1 to 120.
#[tauri::command]
pub fn local_engine_set_idle(app: tauri::AppHandle, minutes: u64) -> EngineStatus {
    let local = app.state::<LocalEngine>();
    local
        .engine
        .set_idle(Duration::from_secs(minutes.clamp(1, 120) * 60));
    local.engine.status()
}

fn emit_task(app: &tauri::AppHandle, event: Option<TaskEvent>) {
    if let Some(event) = event {
        let _ = app.emit(TASK_EVENT, event);
    }
}

/// Throttle progress events to one per percent.
fn progress_sink(app: tauri::AppHandle, total: u64) -> impl Fn(u64) + Send + Sync {
    let step = (total / 100).max(1);
    let last = std::sync::atomic::AtomicU64::new(0);
    move |done| {
        let previous = last.load(std::sync::atomic::Ordering::Relaxed);
        if done == total || done >= previous + step {
            last.store(done, std::sync::atomic::Ordering::Relaxed);
            emit_task(&app, app.state::<LocalEngine>().update(done));
        }
    }
}

/// Download the pinned engine (the page has said what and from where).
/// Returns at once; progress arrives on `local-engine://task`.
#[tauri::command]
pub fn local_engine_install(app: tauri::AppHandle) -> Result<TaskEvent, LocalEngineError> {
    let local = app.state::<LocalEngine>();
    let cancel = local.begin(TaskKind::Install, None, binary::ASSET_SIZE)?;
    let started = local.task().ok_or(LocalEngineError::Busy)?;
    let worker = app.clone();
    tauri::async_runtime::spawn(async move {
        let local = worker.state::<LocalEngine>();
        let progress = progress_sink(worker.clone(), binary::ASSET_SIZE);
        let outcome = binary::install(&local.engine_root, &progress, &cancel).await;
        emit_task(&worker, local.finish(&outcome));
    });
    Ok(started)
}

/// Prepare the text-only copy of an Ollama model whose vision layers share
/// its file. Refused unless the model needs it and the disk has room.
#[tauri::command]
pub async fn local_model_prepare(
    app: tauri::AppHandle,
    model: String,
) -> Result<TaskEvent, LocalEngineError> {
    let id = model.clone();
    let found = blocking(&app, move |local| local.find(&id)).await??;
    let ModelState::NeedsPrepare { write_bytes } = found.state else {
        return Err(LocalEngineError::ModelNotFound);
    };
    let local = app.state::<LocalEngine>();
    let models_dir = local.models_dir.clone();
    let _ = std::fs::create_dir_all(&models_dir);
    if let Some(free) = super::free_space(&models_dir) {
        let needed = write_bytes + super::disk_margin(write_bytes);
        if free < needed {
            return Err(LocalEngineError::NotEnoughDisk { needed, free });
        }
    }
    let cancel = local.begin(TaskKind::Prepare, Some(model.clone()), write_bytes)?;
    // An out-of-date copy is replaced in place; Windows will not replace a
    // file the engine has open.
    if found.prepared && local.engine.running_model().as_deref() == Some(model.as_str()) {
        local.engine.stop().await;
    }
    let started = local.task().ok_or(LocalEngineError::Busy)?;
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let local = worker.state::<LocalEngine>();
        let progress = progress_sink(worker.clone(), write_bytes);
        let outcome = local.prepare_copy(&found, &progress, &cancel).map(|_| ());
        emit_task(&worker, local.finish(&outcome));
    });
    Ok(started)
}

#[tauri::command]
pub fn local_task_cancel(app: tauri::AppHandle) -> bool {
    app.state::<LocalEngine>().cancel_task()
}

/// Delete a prepared copy. `confirmed` is the user's answer to the page's
/// confirmation; without it nothing is deleted.
#[tauri::command]
pub async fn local_model_delete_copy(
    app: tauri::AppHandle,
    model: String,
    confirmed: bool,
) -> Result<(), LocalEngineError> {
    if !confirmed {
        return Err(LocalEngineError::Cancelled);
    }
    let local = app.state::<LocalEngine>();
    if local.engine.running_model().as_deref() == Some(model.as_str()) {
        local.engine.stop().await;
    }
    blocking(&app, move |local| {
        let found = local.find(&model)?;
        local.delete_copy(&found)
    })
    .await?
}

/// Open the app's models folder, where `.gguf` files can be added.
#[tauri::command]
pub fn local_models_open_folder(app: tauri::AppHandle) -> Result<(), LocalEngineError> {
    let dir = app.state::<LocalEngine>().models_dir.clone();
    std::fs::create_dir_all(&dir).map_err(|_| LocalEngineError::Io)?;
    tauri_plugin_opener::open_path(dir, None::<String>).map_err(|_| LocalEngineError::Io)
}

/// Wire the engine into the app: status events to the page, and the idle
/// check every 30 seconds.
pub fn attach(app: &tauri::AppHandle) {
    let sink_app = app.clone();
    app.state::<LocalEngine>()
        .engine
        .set_sink(Box::new(move |status| {
            let _ = sink_app.emit(STATUS_EVENT, status);
        }));
    let reaper = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            reaper.state::<LocalEngine>().engine.reap().await;
        }
    });
}
