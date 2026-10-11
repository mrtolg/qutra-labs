//! Qutra's own local engine (spec 2026-10-07 D10, §7.7; ADR 0016).
//!
//! Jarvis's local answers come from a pinned llama.cpp `llama-server` that
//! this module starts when a local answer is needed and stops when it has
//! been idle. Ollama no longer has to run: its model store is read in place.
//!
//! - `binary`: the pinned build, its download and its hashes.
//! - `models`: the models it can run, from the app's folder and Ollama's.
//! - `gguf`: model headers, and the text-only copy some Ollama models need.
//! - `process`: the one engine process and its lifetime.
//! - `commands`: what the page may ask.

pub mod binary;
pub mod commands;
pub mod compat;
pub mod error;
pub mod gguf;
#[cfg(test)]
mod live_tests;
pub mod models;
pub mod process;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

pub use error::LocalEngineError;
use models::{LocalModel, ModelRoots, ModelState, PreparedRecord, SummaryCache};
use process::{Engine, LlamaServer, ModelTarget};

pub const STATUS_EVENT: &str = "local-engine://status";
pub const TASK_EVENT: &str = "local-engine://task";

/// The Gemma 4 chat template, from google/gemma-4-26B-A4B-it
/// (`chat_template.jinja`, Apache-2.0). Ollama keeps a model's template
/// outside its GGUF; a prepared Gemma 4 copy carries this one.
pub const GEMMA4_TEMPLATE: &str = include_str!("../../resources/chat-templates/gemma4.jinja");

/// Free space a prepared copy must leave: 2 GiB, or 5 % of the copy.
pub fn disk_margin(bytes: u64) -> u64 {
    (2u64 << 30).max(bytes / 20)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Install,
    Prepare,
}

/// A download or a preparation, as the page follows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub kind: TaskKind,
    /// `running` | `done` | `failed` | `cancelled`
    pub phase: &'static str,
    pub model: Option<String>,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<LocalEngineError>,
}

struct Task {
    event: TaskEvent,
    cancel: Arc<AtomicBool>,
}

pub struct LocalEngine {
    pub engine_root: PathBuf,
    pub models_dir: PathBuf,
    pub ollama_root: Option<PathBuf>,
    pub engine: Engine,
    summaries: SummaryCache,
    task: Mutex<Option<Task>>,
}

impl LocalEngine {
    /// Everything lives under the app's local data folder: `engine\` for
    /// the build and its log, `models\` for the user's models.
    pub fn new(app_local_data: &Path) -> Self {
        let engine_root = app_local_data.join("engine");
        let launcher = Arc::new(LlamaServer {
            engine_root: engine_root.clone(),
        });
        Self {
            engine: Engine::new(launcher, engine_root.join("logs").join("llama-server.log")),
            models_dir: app_local_data.join("models"),
            ollama_root: models::default_ollama_root(),
            engine_root,
            summaries: SummaryCache::default(),
            task: Mutex::new(None),
        }
    }

    pub fn installed(&self) -> bool {
        binary::is_installed(&self.engine_root)
    }

    fn roots(&self) -> ModelRoots {
        ModelRoots {
            app_models: self.models_dir.clone(),
            ollama: self.ollama_root.clone(),
        }
    }

    /// Reads headers: call it off the async threads.
    pub fn models(&self) -> Vec<LocalModel> {
        models::discover(&self.roots(), &self.summaries)
    }

    pub fn find(&self, id: &str) -> Result<LocalModel, LocalEngineError> {
        self.models()
            .into_iter()
            .find(|m| m.id == id)
            .ok_or(LocalEngineError::ModelNotFound)
    }

    /// The file to run for `id`, refused unless it loads as it is.
    pub fn resolve(&self, id: &str) -> Result<ModelTarget, LocalEngineError> {
        if !self.installed() {
            return Err(LocalEngineError::EngineMissing);
        }
        let model = self.find(id)?;
        match model.state {
            ModelState::Ready => Ok(ModelTarget {
                id: model.id,
                path: model.path,
            }),
            ModelState::NeedsPrepare { .. } => Err(LocalEngineError::ModelNeedsPrepare),
            ModelState::Unsupported { architecture } => {
                Err(LocalEngineError::ModelUnsupported { architecture })
            }
            ModelState::Unreadable { .. } => Err(LocalEngineError::ModelUnreadable),
        }
    }

    pub fn task(&self) -> Option<TaskEvent> {
        self.task
            .lock()
            .ok()
            .and_then(|t| t.as_ref().map(|t| t.event.clone()))
    }

    /// Claim the one task slot; refused while another task runs.
    fn begin(
        &self,
        kind: TaskKind,
        model: Option<String>,
        total: u64,
    ) -> Result<Arc<AtomicBool>, LocalEngineError> {
        let mut slot = self.task.lock().map_err(|_| LocalEngineError::Busy)?;
        if slot.as_ref().is_some_and(|t| t.event.phase == "running") {
            return Err(LocalEngineError::Busy);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *slot = Some(Task {
            event: TaskEvent {
                kind,
                phase: "running",
                model,
                done_bytes: 0,
                total_bytes: total,
                error: None,
            },
            cancel: cancel.clone(),
        });
        Ok(cancel)
    }

    fn update(&self, done: u64) -> Option<TaskEvent> {
        let mut slot = self.task.lock().ok()?;
        let task = slot.as_mut()?;
        task.event.done_bytes = done;
        Some(task.event.clone())
    }

    fn finish(&self, outcome: &Result<(), LocalEngineError>) -> Option<TaskEvent> {
        let mut slot = self.task.lock().ok()?;
        let task = slot.as_mut()?;
        task.event.phase = match outcome {
            Ok(()) => "done",
            Err(LocalEngineError::Cancelled) => "cancelled",
            Err(_) => "failed",
        };
        task.event.error = outcome.clone().err();
        Some(task.event.clone())
    }

    pub fn cancel_task(&self) -> bool {
        match self.task.lock() {
            Ok(slot) => match slot.as_ref() {
                Some(task) if task.event.phase == "running" => {
                    task.cancel.store(true, Ordering::SeqCst);
                    true
                }
                _ => false,
            },
            Err(_) => false,
        }
    }

    /// Write a copy of an Ollama model into the app's models folder, without
    /// its vision layers and with the `compat` rules applied: to a
    /// `.partial` name first, renamed only once complete, with a sidecar that
    /// names the Ollama model and digest it came from. Ollama's store is
    /// only read.
    pub fn prepare_copy(
        &self,
        model: &LocalModel,
        progress: &dyn Fn(u64),
        cancel: &AtomicBool,
    ) -> Result<PathBuf, LocalEngineError> {
        let source = model
            .source_blob
            .clone()
            .ok_or(LocalEngineError::ModelNotFound)?;
        let header = gguf::read_header(&source).map_err(|_| LocalEngineError::ModelUnreadable)?;
        let plan = gguf::plan_text_only(&header, Some(GEMMA4_TEMPLATE))
            .map_err(|_| LocalEngineError::ModelUnreadable)?;
        std::fs::create_dir_all(&self.models_dir).map_err(|_| LocalEngineError::Io)?;
        remove_stale_partials(&self.models_dir);
        let free = free_space(&self.models_dir).unwrap_or(u64::MAX);
        let needed = plan.total_bytes + disk_margin(plan.total_bytes);
        if free < needed {
            return Err(LocalEngineError::NotEnoughDisk { needed, free });
        }
        // A copy this app wrote earlier, out of date, is replaced in place:
        // the new one is renamed over it only once it is complete.
        let target = match &model.prepared_path {
            Some(old) if old.parent() == Some(self.models_dir.as_path()) => old.clone(),
            _ => unique_name(&self.models_dir, &models::prepared_file_name(&model.id)),
        };
        let partial = PathBuf::from(format!("{}{}", target.display(), models::PARTIAL_SUFFIX));
        let written = gguf::write_plan(&source, &partial, &plan, progress, cancel);
        if let Err(err) = written {
            let _ = std::fs::remove_file(&partial);
            return Err(match err {
                gguf::GgufError::Cancelled => LocalEngineError::Cancelled,
                gguf::GgufError::Io => LocalEngineError::Io,
                _ => LocalEngineError::ModelUnreadable,
            });
        }
        let record = PreparedRecord {
            ollama_name: model.id.clone(),
            source_digest: digest_of(&source),
            prepared_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        };
        let sidecar = PathBuf::from(format!("{}{}", target.display(), models::PREPARED_SUFFIX));
        let record = serde_json::to_vec_pretty(&record).map_err(|_| LocalEngineError::Io)?;
        let replacing = target.exists();
        if std::fs::write(&sidecar, record).is_err() || std::fs::rename(&partial, &target).is_err()
        {
            let _ = std::fs::remove_file(&partial);
            if !replacing {
                let _ = std::fs::remove_file(&sidecar);
            }
            return Err(LocalEngineError::Io);
        }
        Ok(target)
    }

    /// Delete a prepared copy (the page asks the user first). Only a copy
    /// this app made, inside its own folder, can be deleted this way.
    pub fn delete_copy(&self, model: &LocalModel) -> Result<(), LocalEngineError> {
        let path = model
            .prepared_path
            .clone()
            .ok_or(LocalEngineError::ModelNotFound)?;
        let inside = path
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .zip(self.models_dir.canonicalize().ok())
            .is_some_and(|(parent, dir)| parent == dir);
        if !inside {
            return Err(LocalEngineError::ModelNotFound);
        }
        std::fs::remove_file(&path).map_err(|_| LocalEngineError::Io)?;
        let _ = std::fs::remove_file(format!("{}{}", path.display(), models::PREPARED_SUFFIX));
        Ok(())
    }
}

/// `sha256:<hex>` from a blob named `sha256-<hex>`.
fn digest_of(blob: &Path) -> String {
    blob.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("sha256-"))
        .map(|hex| format!("sha256:{hex}"))
        .unwrap_or_default()
}

/// `name`, or `name-2`, `name-3`… when a file already has it: a copy never
/// overwrites a file the user has.
fn unique_name(dir: &Path, file: &str) -> PathBuf {
    let first = dir.join(file);
    if !first.exists() {
        return first;
    }
    let stem = file.trim_end_matches(".gguf");
    (2..1000)
        .map(|n| dir.join(format!("{stem}-{n}.gguf")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// A preparation that was killed leaves its `.partial` file behind, up to the
/// size of a model. Only one preparation runs at a time, so when one starts
/// every such file in the folder is stale.
fn remove_stale_partials(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(models::PARTIAL_SUFFIX));
        if stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
pub fn free_space(dir: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut free = 0u64;
    unsafe {
        GetDiskFreeSpaceExW(&HSTRING::from(dir.as_os_str()), Some(&mut free), None, None).ok()?;
    }
    Some(free)
}

#[cfg(not(windows))]
pub fn free_space(_dir: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::models::tests::{ollama_store, GEMMA_DIGEST};
    use super::*;

    fn engine_with_store() -> (LocalEngine, tempfile::TempDir, tempfile::TempDir) {
        let app = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        ollama_store(store.path());
        let mut local = LocalEngine::new(app.path());
        local.ollama_root = Some(store.path().to_path_buf());
        (local, app, store)
    }

    #[test]
    fn a_prepared_copy_goes_to_the_app_folder_and_never_into_ollamas_store() {
        let (local, app, store) = engine_with_store();
        let before: Vec<_> = walk(store.path());
        let gemma = local.find("gemma4:26b").unwrap();
        assert!(matches!(gemma.state, ModelState::NeedsPrepare { .. }));

        let path = local
            .prepare_copy(&gemma, &|_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(path, app.path().join("models").join("gemma4-26b.gguf"));
        assert_eq!(walk(store.path()), before, "Ollama's store is only read");
        let record: PreparedRecord = serde_json::from_str(
            &std::fs::read_to_string(app.path().join("models/gemma4-26b.gguf.qutra.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(record.source_digest, GEMMA_DIGEST);

        let gemma = local.find("gemma4:26b").unwrap();
        assert_eq!(gemma.state, ModelState::Ready);
        assert!(gemma.prepared);
        assert_eq!(gemma.tools, Some(true), "the Gemma 4 template names tools");

        // A second copy never overwrites the first.
        assert_eq!(
            unique_name(&app.path().join("models"), "gemma4-26b.gguf"),
            app.path().join("models").join("gemma4-26b-2.gguf")
        );

        local.delete_copy(&gemma).unwrap();
        assert!(!path.exists());
        assert!(matches!(
            local.find("gemma4:26b").unwrap().state,
            ModelState::NeedsPrepare { .. }
        ));
    }

    #[test]
    fn a_new_preparation_removes_the_half_copies_a_killed_one_left() {
        let (local, app, _store) = engine_with_store();
        let models = app.path().join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("other-model.gguf.partial"), b"half a model").unwrap();
        // A file the user put there is not a half copy.
        std::fs::write(models.join("mine.gguf"), b"theirs").unwrap();

        let gemma = local.find("gemma4:26b").unwrap();
        local
            .prepare_copy(&gemma, &|_| {}, &AtomicBool::new(false))
            .unwrap();

        assert!(!models.join("other-model.gguf.partial").exists());
        assert_eq!(std::fs::read(models.join("mine.gguf")).unwrap(), b"theirs");
    }

    #[test]
    fn a_cancelled_preparation_leaves_no_file_behind() {
        let (local, app, _store) = engine_with_store();
        let gemma = local.find("gemma4:26b").unwrap();
        let err = local
            .prepare_copy(&gemma, &|_| {}, &AtomicBool::new(true))
            .unwrap_err();
        assert_eq!(err, LocalEngineError::Cancelled);
        let left: Vec<_> = walk(&app.path().join("models"));
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn only_a_ready_model_resolves_to_a_file_to_run() {
        let (local, _app, _store) = engine_with_store();
        // The engine is not installed in a fresh folder.
        assert_eq!(
            local.resolve("qwen2.5:7b").unwrap_err(),
            LocalEngineError::EngineMissing
        );
    }

    #[test]
    fn one_task_at_a_time_and_a_cancel_reaches_it() {
        let (local, _app, _store) = engine_with_store();
        let cancel = local.begin(TaskKind::Install, None, 10).unwrap();
        assert_eq!(
            local.begin(TaskKind::Prepare, None, 10).unwrap_err(),
            LocalEngineError::Busy
        );
        assert!(local.cancel_task());
        assert!(cancel.load(Ordering::SeqCst));
        let done = local.finish(&Err(LocalEngineError::Cancelled)).unwrap();
        assert_eq!(done.phase, "cancelled");
        assert!(local.begin(TaskKind::Prepare, None, 10).is_ok());
    }

    const HUIHUI: &str = "huihui_ai/Qwen3.6-abliterated:27b";
    const HUIHUI_DIGEST: &str =
        "sha256:9ea43be17d50a027501aa6adb51086291f1911eebca7e3761974440349b4c168";

    /// What Ollama's file for a Qwen 3.5 holds that this build reads
    /// differently: three rope sections and a multi-token-prediction layer.
    /// No vision layers share the file.
    fn qwen35_file(path: &Path) {
        use super::gguf::fixture::{write, Value};
        write(
            path,
            &[
                ("general.architecture", Value::Str("qwen35")),
                (
                    "qwen35.rope.dimension_sections",
                    Value::I32s(vec![11, 11, 10]),
                ),
            ],
            &[("token_embd.weight", 64), ("mtp.fc.weight", 32)],
        );
    }

    fn huihui_engine() -> (LocalEngine, tempfile::TempDir, tempfile::TempDir) {
        let app = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = store.path();
        let dir = root.join("manifests/registry.ollama.ai/huihui_ai/Qwen3.6-abliterated");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(root.join("blobs")).unwrap();
        std::fs::write(dir.join("27b"), models::tests::manifest(HUIHUI_DIGEST, 0)).unwrap();
        qwen35_file(&root.join(format!("blobs/sha256-{}", &HUIHUI_DIGEST[7..])));
        let mut local = LocalEngine::new(app.path());
        local.ollama_root = Some(root.to_path_buf());
        (local, app, store)
    }

    #[test]
    fn an_ollama_model_with_settings_the_engine_cannot_read_is_prepared_like_one_with_vision_layers(
    ) {
        let (local, app, store) = huihui_engine();
        let before = walk(store.path());
        let model = local.find(HUIHUI).unwrap();
        assert_eq!(model.state, ModelState::NeedsPrepare { write_bytes: 64 });

        let path = local
            .prepare_copy(&model, &|_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(walk(store.path()), before, "Ollama's store is only read");
        assert_eq!(
            path,
            app.path()
                .join("models")
                .join("huihui_ai-Qwen3.6-abliterated-27b.gguf")
        );
        let ready = local.find(HUIHUI).unwrap();
        assert_eq!(ready.state, ModelState::Ready);
        assert!(ready.prepared);
        let copy = gguf::read_header(&path).unwrap();
        assert!(copy.summary().unwrap().compat.is_empty());
        assert_eq!(copy.tensors.len(), 1);
    }

    #[test]
    fn a_copy_made_before_the_rules_existed_is_written_again_in_place() {
        let (local, app, store) = huihui_engine();
        let models_dir = app.path().join("models");
        std::fs::create_dir_all(&models_dir).unwrap();
        // What an older version wrote: the copy with Ollama's settings as they were.
        let old = models_dir.join("huihui_ai-Qwen3.6-abliterated-27b.gguf");
        qwen35_file(&old);
        let record = PreparedRecord {
            ollama_name: HUIHUI.into(),
            source_digest: HUIHUI_DIGEST.into(),
            prepared_at_ms: 1,
        };
        std::fs::write(
            format!("{}{}", old.display(), models::PREPARED_SUFFIX),
            serde_json::to_string(&record).unwrap(),
        )
        .unwrap();
        let before = walk(store.path());

        let stale = local.find(HUIHUI).unwrap();
        assert!(stale.prepared, "a copy exists");
        assert!(
            matches!(stale.state, ModelState::NeedsPrepare { .. }),
            "{:?}",
            stale.state
        );
        assert_eq!(
            local.models().iter().filter(|m| m.id == HUIHUI).count(),
            1,
            "listed once"
        );

        let path = local
            .prepare_copy(&stale, &|_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(path, old, "no second copy beside it");
        assert_eq!(walk(&models_dir).len(), 2, "the file and its record");
        assert_eq!(walk(store.path()), before);
        assert_eq!(local.find(HUIHUI).unwrap().state, ModelState::Ready);
    }

    #[test]
    fn a_file_the_user_put_in_the_models_folder_is_never_offered_for_rewriting() {
        let (local, app, _store) = huihui_engine();
        let models_dir = app.path().join("models");
        std::fs::create_dir_all(&models_dir).unwrap();
        qwen35_file(&models_dir.join("mine.gguf"));
        // There is no Ollama file to write it from; if it fails to load the
        // engine's own reason is shown.
        assert_eq!(local.find("mine").unwrap().state, ModelState::Ready);
    }

    #[test]
    fn the_disk_margin_is_two_gib_or_five_percent() {
        assert_eq!(disk_margin(1 << 30), 2 << 30);
        assert_eq!(disk_margin(100 << 30), 5 << 30);
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(read) = std::fs::read_dir(dir) else {
            return out;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out.sort();
        out
    }
}
