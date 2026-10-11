//! The engine process: started when Jarvis needs a local answer, stopped
//! when it has been idle and when the app exits (ADR 0016).
//!
//! - **One at a time.** The running process lives behind one async lock;
//!   a second start waits for the first and reuses it.
//! - **Loopback only.** It listens on 127.0.0.1, on a free port Rust picks,
//!   and answers only requests that carry a random key made for this start.
//!   The key reaches the process through its environment, never its
//!   command line.
//! - **Tied to the app.** It runs inside a Windows Job Object that kills it
//!   when the app's handle closes, so a crash cannot leave it behind. A
//!   normal exit stops it first (`Engine::shutdown`), and the job is the
//!   backstop for an exit that never finishes.
//! - **Settings from Rust.** Inherited `LLAMA_*` and `GGML_*` variables are
//!   removed; the renderer never chooses a path or a flag.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::binary;
use super::error::LocalEngineError;

pub const DEFAULT_IDLE: Duration = Duration::from_secs(5 * 60);
/// A 26B model was measured loading in 66 s from a warm disk cache and in
/// over five minutes from a cold one on a laptop.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL: Duration = Duration::from_millis(250);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// The smallest context the engine starts with, so a later 8k turn does
/// not restart a 4k engine.
const MIN_CONTEXT: u32 = 8192;
const LOG_TAIL_BYTES: u64 = 16 * 1024;
/// How long a shutdown waits for the engine's lock once it has told a start
/// in progress to stop (that start gives the lock up within one poll).
const SHUTDOWN_LOCK_WAIT: Duration = Duration::from_secs(2);

pub struct LaunchSpec {
    pub model_path: PathBuf,
    /// The id the server reports for the model, instead of the file's path.
    pub alias: String,
    pub port: u16,
    pub api_key: String,
    pub context: u32,
}

/// Builds the command for one start. The real one runs the pinned
/// llama-server; tests run a fake.
pub trait Launcher: Send + Sync {
    fn command(&self, spec: &LaunchSpec) -> Result<Command, LocalEngineError>;
}

/// The pinned llama-server, checked file by file before each start.
pub struct LlamaServer {
    pub engine_root: PathBuf,
}

impl Launcher for LlamaServer {
    fn command(&self, spec: &LaunchSpec) -> Result<Command, LocalEngineError> {
        let dir = binary::install_dir(&self.engine_root);
        binary::verify_install(&dir)?;
        Ok(server_command(&dir, spec))
    }
}

/// The command for the server in `dir`. Every setting comes from Rust.
fn server_command(dir: &Path, spec: &LaunchSpec) -> Command {
    let mut command = Command::new(dir.join(binary::SERVER_EXE));
    command
        .current_dir(dir)
        .arg("--model")
        .arg(&spec.model_path)
        // The server names the model it serves in every answer; give it
        // the id, not the path, which holds the user's account name.
        .args(["--alias", &spec.alias])
        // Allow one origin nothing runs on and no credentials, so the
        // server never echoes a page's origin back as permitted.
        .args(["--cors-origins", "http://127.0.0.1:1"])
        .arg("--no-cors-credentials")
        .args(["--host", "127.0.0.1", "--port"])
        .arg(spec.port.to_string())
        .arg("--ctx-size")
        .arg(spec.context.to_string())
        // One conversation at a time, like the broker.
        .args(["--parallel", "1"])
        .args(["--no-webui", "--jinja"])
        // Jarvis answers; it does not stream a hidden reasoning pass.
        .args(["--reasoning", "off"])
        // A model larger than the GPU keeps some weights in RAM. Copying
        // them to the GPU for every prompt was measured at 2.7 tokens/s
        // of prompt on a 26B model; computing them where they
        // are, 64 tokens/s (2026-10-10).
        .args(["--no-op-offload"])
        .args(["--no-mmproj"]);
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("LLAMA_") || upper.starts_with("GGML_") {
            command.env_remove(name);
        }
    }
    command.env("LLAMA_API_KEY", &spec.api_key);
    command
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Stopped,
    Starting,
    Loading,
    Ready,
    Failed,
}

/// What the page is told about the engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub phase: Phase,
    pub model: Option<String>,
    pub endpoint: Option<String>,
    pub error: Option<LocalEngineError>,
    pub idle_minutes: u64,
    pub build: &'static str,
}

/// Which model to run, resolved by Rust from its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelTarget {
    pub id: String,
    pub path: PathBuf,
}

#[cfg(windows)]
struct JobGuard(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobGuard {}
#[cfg(windows)]
unsafe impl Sync for JobGuard {}

#[cfg(windows)]
impl JobGuard {
    fn for_child(child: &Child) -> Result<Self, LocalEngineError> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|_| LocalEngineError::StartFailed)?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured.is_err()
                || AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_err()
            {
                let _ = CloseHandle(job);
                return Err(LocalEngineError::StartFailed);
            }
            Ok(Self(job))
        }
    }
}

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        // Closing the last handle kills every process in the job.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
struct JobGuard;

#[cfg(not(windows))]
impl JobGuard {
    fn for_child(_child: &Child) -> Result<Self, LocalEngineError> {
        Ok(Self)
    }
}

struct Running {
    child: Child,
    _job: JobGuard,
    port: u16,
    key: String,
    target: ModelTarget,
    context: u32,
}

impl Running {
    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // `_job` drops last and takes any child processes with it.
    }
}

struct Shared {
    active: AtomicUsize,
    last_used: Mutex<Instant>,
}

/// A turn's hold on the running engine. While one is held the engine is
/// not idle; dropping it starts the idle clock.
pub struct Lease {
    shared: Arc<Shared>,
    pub origin: String,
    pub api_key: String,
    pub model: String,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.shared.active.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut last) = self.shared.last_used.lock() {
            *last = Instant::now();
        }
    }
}

type StatusSink = Box<dyn Fn(&EngineStatus) + Send + Sync>;

pub struct Engine {
    launcher: Arc<dyn Launcher>,
    log_path: PathBuf,
    run: tokio::sync::Mutex<Option<Running>>,
    status: Mutex<EngineStatus>,
    shared: Arc<Shared>,
    idle: Mutex<Duration>,
    load_timeout: Duration,
    stop_requested: AtomicBool,
    /// Set by `shutdown`: the app is leaving, so nothing starts again.
    closed: AtomicBool,
    sink: Mutex<Option<StatusSink>>,
}

fn random_key() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn free_port() -> Result<u16, LocalEngineError> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| LocalEngineError::StartFailed)?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|_| LocalEngineError::StartFailed)
}

fn probe_client() -> Result<reqwest::Client, LocalEngineError> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| LocalEngineError::StartFailed)
}

/// The end of the engine's log, to say why a start failed.
fn log_tail(path: &PathBuf) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES)));
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Why the engine exited while loading, read from its own log. Only a code
/// leaves Rust; the log can name paths.
pub fn classify_exit(log: &str) -> LocalEngineError {
    let lower = log.to_ascii_lowercase();
    let reason = if lower.contains("wrong number of tensors") {
        "tensor_count"
    } else if lower.contains("unknown model architecture") {
        "unknown_architecture"
    } else if lower.contains("error loading model hyperparameters")
        || lower.contains("wrong array length")
        || lower.contains("key not found in model")
    {
        // The file's own settings are missing or not what this build reads.
        "model_metadata"
    } else if lower.contains("out of memory")
        || lower.contains("outofdevicememory")
        || lower.contains("failed to allocate")
        || lower.contains("unable to allocate")
    {
        "out_of_memory"
    } else if lower.contains("couldn't bind") || lower.contains("address already in use") {
        "port_in_use"
    } else if lower.contains("failed to load model") || lower.contains("error loading model") {
        "model_rejected"
    } else {
        "exited"
    };
    LocalEngineError::LoadFailed {
        reason: reason.into(),
    }
}

struct Unfinished<'a> {
    engine: &'a Engine,
    model: String,
    armed: bool,
}

impl Drop for Unfinished<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.engine.set_status(
                Phase::Stopped,
                Some(&self.model),
                None,
                Some(LocalEngineError::Cancelled),
            );
        }
    }
}

impl Engine {
    pub fn new(launcher: Arc<dyn Launcher>, log_path: PathBuf) -> Self {
        Self::with_timeouts(launcher, log_path, DEFAULT_IDLE, LOAD_TIMEOUT)
    }

    pub fn with_timeouts(
        launcher: Arc<dyn Launcher>,
        log_path: PathBuf,
        idle: Duration,
        load_timeout: Duration,
    ) -> Self {
        Self {
            launcher,
            log_path,
            run: tokio::sync::Mutex::new(None),
            status: Mutex::new(EngineStatus {
                phase: Phase::Stopped,
                model: None,
                endpoint: None,
                error: None,
                idle_minutes: idle.as_secs() / 60,
                build: binary::BUILD,
            }),
            shared: Arc::new(Shared {
                active: AtomicUsize::new(0),
                last_used: Mutex::new(Instant::now()),
            }),
            idle: Mutex::new(idle),
            load_timeout,
            stop_requested: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            sink: Mutex::new(None),
        }
    }

    /// Who hears every status change (the app emits it to the page).
    pub fn set_sink(&self, sink: StatusSink) {
        if let Ok(mut slot) = self.sink.lock() {
            *slot = Some(sink);
        }
    }

    pub fn status(&self) -> EngineStatus {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    fn set_status(
        &self,
        phase: Phase,
        model: Option<&str>,
        endpoint: Option<String>,
        error: Option<LocalEngineError>,
    ) {
        let idle_minutes = self.idle().as_secs() / 60;
        let next = EngineStatus {
            phase,
            model: model.map(str::to_string),
            endpoint,
            error,
            idle_minutes,
            build: binary::BUILD,
        };
        let changed = match self.status.lock() {
            Ok(mut current) if *current != next => {
                *current = next.clone();
                true
            }
            _ => false,
        };
        if changed {
            if let Ok(sink) = self.sink.lock() {
                if let Some(sink) = sink.as_ref() {
                    sink(&next);
                }
            }
        }
    }

    pub fn idle(&self) -> Duration {
        self.idle.lock().map(|d| *d).unwrap_or(DEFAULT_IDLE)
    }

    pub fn set_idle(&self, idle: Duration) {
        if let Ok(mut slot) = self.idle.lock() {
            *slot = idle;
        }
        let current = self.status();
        self.set_status(
            current.phase,
            current.model.as_deref(),
            current.endpoint,
            current.error,
        );
    }

    fn lease(&self, running: &Running) -> Lease {
        self.shared.active.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut last) = self.shared.last_used.lock() {
            *last = Instant::now();
        }
        Lease {
            shared: self.shared.clone(),
            origin: running.origin(),
            api_key: running.key.clone(),
            model: running.target.id.clone(),
        }
    }

    /// The engine running `target`, started if it is not. A running engine
    /// for another model is stopped first: one at a time.
    pub async fn ensure(
        &self,
        target: &ModelTarget,
        context: u32,
    ) -> Result<Lease, LocalEngineError> {
        let context = context.max(MIN_CONTEXT);
        if self.closed.load(Ordering::SeqCst) {
            return Err(LocalEngineError::Cancelled);
        }
        let mut run = self.run.lock().await;
        // A start that waited for the lock while the app was closing.
        if self.closed.load(Ordering::SeqCst) {
            return Err(LocalEngineError::Cancelled);
        }
        self.stop_requested.store(false, Ordering::SeqCst);
        if let Some(running) = run.as_mut() {
            if running.alive() && running.target == *target && running.context >= context {
                return Ok(self.lease(running));
            }
            if let Some(old) = run.take() {
                old.stop();
            }
        }
        // A turn stopped while the model loads drops this future; the guard
        // then says so instead of leaving "loading" on screen.
        let mut unfinished = Unfinished {
            engine: self,
            model: target.id.clone(),
            armed: true,
        };
        let started = self.start(target, context).await;
        unfinished.armed = false;
        match started {
            Ok(running) => {
                let lease = self.lease(&running);
                self.set_status(Phase::Ready, Some(&target.id), Some(running.origin()), None);
                *run = Some(running);
                Ok(lease)
            }
            Err(err) => {
                let phase = if err == LocalEngineError::Cancelled {
                    Phase::Stopped
                } else {
                    Phase::Failed
                };
                self.set_status(phase, Some(&target.id), None, Some(err.clone()));
                Err(err)
            }
        }
    }

    async fn start(&self, target: &ModelTarget, context: u32) -> Result<Running, LocalEngineError> {
        self.set_status(Phase::Starting, Some(&target.id), None, None);
        let mut last = LocalEngineError::StartFailed;
        for _ in 0..2 {
            match self.start_once(target, context).await {
                Err(LocalEngineError::LoadFailed { reason }) if reason == "port_in_use" => {
                    last = LocalEngineError::LoadFailed { reason };
                }
                other => return other,
            }
        }
        Err(last)
    }

    async fn start_once(
        &self,
        target: &ModelTarget,
        context: u32,
    ) -> Result<Running, LocalEngineError> {
        let port = free_port()?;
        let key = random_key();
        let spec = LaunchSpec {
            model_path: target.path.clone(),
            alias: target.id.clone(),
            port,
            api_key: key.clone(),
            context,
        };
        // Building the command re-hashes the engine's files: off the
        // async threads.
        let launcher = self.launcher.clone();
        let mut command = tokio::task::spawn_blocking(move || launcher.command(&spec))
            .await
            .map_err(|_| LocalEngineError::StartFailed)??;
        if let Some(parent) = self.log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let log = File::create(&self.log_path).map_err(|_| LocalEngineError::Io)?;
        let log_err = log.try_clone().map_err(|_| LocalEngineError::Io)?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|_| LocalEngineError::StartFailed)?;
        let job = match JobGuard::for_child(&child) {
            Ok(job) => job,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
        };
        let mut running = Running {
            child,
            _job: job,
            port,
            key,
            target: target.clone(),
            context,
        };
        match self.wait_ready(&mut running).await {
            Ok(()) => Ok(running),
            Err(err) => {
                running.stop();
                Err(err)
            }
        }
    }

    async fn wait_ready(&self, running: &mut Running) -> Result<(), LocalEngineError> {
        let client = probe_client()?;
        let origin = running.origin();
        let deadline = Instant::now() + self.load_timeout;
        let mut loading = false;
        loop {
            if self.stop_requested.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
                return Err(LocalEngineError::Cancelled);
            }
            if !running.alive() {
                return Err(classify_exit(&log_tail(&self.log_path)));
            }
            if Instant::now() >= deadline {
                return Err(LocalEngineError::LoadTimeout);
            }
            match client.get(format!("{origin}/health")).send().await {
                Ok(response) if response.status().is_success() => {
                    // Something answers on the port; make sure it is ours.
                    // The server lists the model under the alias Rust gave it
                    // and only for the key made for this start, so a listener
                    // that is not the server cannot pass. Every request
                    // carries the key: the server logs a warning for one that
                    // does not.
                    return if self.serves_our_model(&client, running).await && running.alive() {
                        Ok(())
                    } else {
                        Err(LocalEngineError::StartFailed)
                    };
                }
                Ok(response) if response.status().as_u16() == 503 && !loading => {
                    loading = true;
                    self.set_status(Phase::Loading, Some(&running.target.id), None, None);
                }
                _ => {}
            }
            tokio::time::sleep(POLL).await;
        }
    }

    /// The server on the port takes this start's key and lists the model
    /// under its alias.
    async fn serves_our_model(&self, client: &reqwest::Client, running: &Running) -> bool {
        let Ok(response) = client
            .get(format!("{}/v1/models", running.origin()))
            .bearer_auth(&running.key)
            .send()
            .await
        else {
            return false;
        };
        if response.status().as_u16() != 200 {
            return false;
        }
        let Ok(body) = response.json::<serde_json::Value>().await else {
            return false;
        };
        body.get("data")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|models| {
                models.iter().any(|m| {
                    m.get("id").and_then(serde_json::Value::as_str) == Some(&running.target.id)
                })
            })
    }

    /// Stop the engine, or a start in progress.
    pub async fn stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        let mut run = self.run.lock().await;
        if let Some(running) = run.take() {
            running.stop();
        }
        self.stop_requested.store(false, Ordering::SeqCst);
        self.set_status(Phase::Stopped, None, None, None);
    }

    /// The app is leaving: stop the engine for good. A start in progress is
    /// cancelled and none begins afterwards. An answer in flight gets up to
    /// `grace` to finish (it ends the moment its lease drops), then the
    /// process is killed, and killed processes are waited for, so the engine
    /// and the VRAM it holds are gone before the app is. If the engine's lock
    /// cannot be had, the job object ends the process with the app.
    pub async fn shutdown(&self, grace: Duration) {
        self.closed.store(true, Ordering::SeqCst);
        self.stop_requested.store(true, Ordering::SeqCst);
        let waited = Instant::now();
        while self.shared.active.load(Ordering::SeqCst) > 0 && waited.elapsed() < grace {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if let Ok(mut run) = tokio::time::timeout(SHUTDOWN_LOCK_WAIT, self.run.lock()).await {
            if let Some(running) = run.take() {
                running.stop();
            }
            self.set_status(Phase::Stopped, None, None, None);
        }
    }

    /// Stop the engine when no turn holds it and it has been idle long
    /// enough; also notice one that exited on its own. Never waits for a
    /// start in progress.
    pub async fn reap(&self) -> bool {
        let Ok(mut run) = self.run.try_lock() else {
            return false;
        };
        let Some(running) = run.as_mut() else {
            return false;
        };
        if !running.alive() {
            let model = running.target.id.clone();
            run.take();
            self.set_status(
                Phase::Failed,
                Some(&model),
                None,
                Some(LocalEngineError::LoadFailed {
                    reason: "exited".into(),
                }),
            );
            return true;
        }
        let idle_for = self
            .shared
            .last_used
            .lock()
            .map(|t| t.elapsed())
            .unwrap_or_default();
        if self.shared.active.load(Ordering::SeqCst) == 0 && idle_for >= self.idle() {
            if let Some(running) = run.take() {
                running.stop();
            }
            self.set_status(Phase::Stopped, None, None, None);
            return true;
        }
        false
    }

    /// The model running now, if any (for a status read without waiting).
    pub fn running_model(&self) -> Option<String> {
        let status = self.status();
        (status.phase == Phase::Ready)
            .then_some(status.model)
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const FAKE_PORT: &str = "QUTRA_FAKE_LLAMA_PORT";
    const FAKE_MODE: &str = "QUTRA_FAKE_LLAMA_MODE";
    const FAKE_ALIAS: &str = "QUTRA_FAKE_LLAMA_ALIAS";
    const FAKE_UNAUTH_LOG: &str = "QUTRA_FAKE_LLAMA_UNAUTH_LOG";
    const FAKE_TEST: &str = "local_engine::process::tests::fake_llama_server";

    /// Not a test: the fake llama-server the lifecycle tests start, by
    /// running this test binary again with only this test selected. In a
    /// normal run it has no port and returns at once.
    #[test]
    fn fake_llama_server() {
        let Ok(port) = std::env::var(FAKE_PORT) else {
            return;
        };
        let mode = std::env::var(FAKE_MODE).unwrap_or_default();
        let key = std::env::var("LLAMA_API_KEY").unwrap_or_default();
        let alias = std::env::var(FAKE_ALIAS).unwrap_or_default();
        let unauth_log = std::env::var(FAKE_UNAUTH_LOG).ok();
        if mode == "crash" {
            eprintln!("llama_model_load: error loading model: done_getting_tensors: wrong number of tensors; expected 1014, got 658");
            std::process::exit(1);
        }
        let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
        let mut health_calls = 0;
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let line = request.lines().next().unwrap_or_default().to_string();
            // "impostor" refuses every key; "anykey" accepts every request,
            // as a listener that is not the server might.
            let authorized = mode == "anykey"
                || (mode != "impostor"
                    && request
                        .lines()
                        .any(|l| l.eq_ignore_ascii_case(&format!("authorization: bearer {key}"))));
            let models_body;
            let (status, body) = if line.starts_with("GET /health") {
                health_calls += 1;
                if health_calls < 3 {
                    ("503 Service Unavailable", r#"{"error":"Loading model"}"#)
                } else {
                    ("200 OK", r#"{"status":"ok"}"#)
                }
            } else if line.starts_with("GET /v1/models") {
                if authorized {
                    // The real server lists the model under its alias; a
                    // listener that is not the server does not know it.
                    let listed = if mode == "anykey" {
                        "someone-else"
                    } else {
                        alias.as_str()
                    };
                    models_body = format!(r#"{{"data":[{{"id":"{listed}"}}]}}"#);
                    ("200 OK", models_body.as_str())
                } else {
                    // The real server logs a warning for this; the tests
                    // count it.
                    if let Some(path) = &unauth_log {
                        let mut log = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)
                            .unwrap();
                        let _ = writeln!(log, "{line}");
                    }
                    ("401 Unauthorized", r#"{"error":"Invalid API Key"}"#)
                }
            } else {
                ("404 Not Found", "{}")
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    }

    struct Fake {
        mode: &'static str,
        starts: AtomicUsize,
        unauthorized_log: PathBuf,
        ports: Mutex<Vec<u16>>,
    }

    impl Launcher for Fake {
        fn command(&self, spec: &LaunchSpec) -> Result<Command, LocalEngineError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.ports.lock().unwrap().push(spec.port);
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FAKE_TEST, "--nocapture", "--test-threads=1"])
                .env(FAKE_PORT, spec.port.to_string())
                .env(FAKE_MODE, self.mode)
                .env(FAKE_ALIAS, &spec.alias)
                .env(FAKE_UNAUTH_LOG, &self.unauthorized_log)
                .env("LLAMA_API_KEY", &spec.api_key);
            Ok(command)
        }
    }

    fn engine(mode: &'static str, idle: Duration) -> (Arc<Fake>, Engine, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(Fake {
            mode,
            starts: AtomicUsize::new(0),
            unauthorized_log: dir.path().join("unauthorized.log"),
            ports: Mutex::new(Vec::new()),
        });
        let engine = Engine::with_timeouts(
            fake.clone(),
            dir.path().join("logs").join("engine.log"),
            idle,
            Duration::from_secs(30),
        );
        (fake, engine, dir)
    }

    fn target(id: &str) -> ModelTarget {
        ModelTarget {
            id: id.into(),
            path: PathBuf::from(format!("C:/models/{id}.gguf")),
        }
    }

    #[tokio::test]
    async fn a_start_waits_for_health_and_a_second_ask_reuses_the_one_engine() {
        let (fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        let heard = Arc::new(Mutex::new(Vec::new()));
        let sink = heard.clone();
        engine.set_sink(Box::new(move |s| sink.lock().unwrap().push(s.phase)));

        let first = engine.ensure(&target("gemma4:26b"), 4096).await.unwrap();
        assert!(first.origin.starts_with("http://127.0.0.1:"));
        assert_eq!(first.api_key.len(), 64);
        assert_eq!(engine.status().phase, Phase::Ready);
        assert_eq!(engine.running_model().as_deref(), Some("gemma4:26b"));
        let second = engine.ensure(&target("gemma4:26b"), 8192).await.unwrap();
        assert_eq!(second.origin, first.origin);
        assert_eq!(fake.starts.load(Ordering::SeqCst), 1, "one engine, not two");
        assert_eq!(
            *heard.lock().unwrap(),
            vec![Phase::Starting, Phase::Loading, Phase::Ready]
        );

        drop((first, second));
        engine.stop().await;
        assert_eq!(engine.status().phase, Phase::Stopped);
        assert!(engine.run.lock().await.is_none());
    }

    /// The server logs a warning for every request that carries no key or a
    /// wrong one. A start must make none: the ownership check uses the key.
    #[tokio::test]
    async fn a_start_sends_every_request_with_the_key() {
        let (_fake, engine, dir) = engine("healthy", DEFAULT_IDLE);
        let lease = engine.ensure(&target("m"), 4096).await.unwrap();
        drop(lease);
        engine.stop().await;
        let refused =
            std::fs::read_to_string(dir.path().join("unauthorized.log")).unwrap_or_default();
        assert_eq!(refused, "", "the engine refused a request during the start");
    }

    #[tokio::test]
    async fn another_model_stops_the_running_engine_first() {
        let (fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        let a = engine.ensure(&target("a"), 4096).await.unwrap();
        drop(a);
        let b = engine.ensure(&target("b"), 4096).await.unwrap();
        assert_eq!(b.model, "b");
        assert_eq!(fake.starts.load(Ordering::SeqCst), 2);
        drop(b);
        engine.stop().await;
    }

    #[tokio::test]
    async fn an_engine_that_exits_while_loading_says_why() {
        let (_fake, engine, _dir) = engine("crash", DEFAULT_IDLE);
        let err = engine
            .ensure(&target("gemma4:26b"), 4096)
            .await
            .err()
            .unwrap();
        assert_eq!(
            err,
            LocalEngineError::LoadFailed {
                reason: "tensor_count".into()
            }
        );
        let status = engine.status();
        assert_eq!(status.phase, Phase::Failed);
        assert_eq!(status.error, Some(err));
    }

    #[tokio::test]
    async fn a_listener_that_does_not_know_the_key_is_not_used() {
        let (_fake, engine, _dir) = engine("impostor", DEFAULT_IDLE);
        let err = engine.ensure(&target("m"), 4096).await.err().unwrap();
        assert_eq!(err, LocalEngineError::StartFailed);
    }

    #[tokio::test]
    async fn a_listener_that_accepts_any_key_is_not_used() {
        let (_fake, engine, _dir) = engine("anykey", DEFAULT_IDLE);
        let err = engine.ensure(&target("m"), 4096).await.err().unwrap();
        assert_eq!(err, LocalEngineError::StartFailed);
    }

    #[tokio::test]
    async fn the_engine_stops_when_idle_and_never_under_a_turn() {
        let (_fake, engine, _dir) = engine("healthy", Duration::ZERO);
        let lease = engine.ensure(&target("m"), 4096).await.unwrap();
        assert!(!engine.reap().await, "a turn holds it");
        assert_eq!(engine.status().phase, Phase::Ready);
        drop(lease);
        assert!(engine.reap().await);
        assert_eq!(engine.status().phase, Phase::Stopped);
        assert!(!engine.reap().await, "nothing left to stop");
    }

    #[tokio::test]
    async fn a_start_dropped_mid_load_does_not_stay_loading() {
        let (_fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        let model = target("m");
        let start = engine.ensure(&model, 4096);
        // Let it spawn and reach "loading", then drop it as a stopped turn does.
        let _ = tokio::time::timeout(Duration::from_millis(150), start).await;
        let status = engine.status();
        assert_ne!(status.phase, Phase::Loading);
        assert_ne!(status.phase, Phase::Starting);
        assert!(engine.run.lock().await.is_none());
    }

    /// True once nothing accepts connections on the port any more.
    async fn port_closes(port: u16) -> bool {
        for _ in 0..40 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn shutdown_stops_the_engine_and_refuses_a_new_start() {
        let (fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        let lease = engine.ensure(&target("m"), 4096).await.unwrap();
        let port: u16 = lease.origin.rsplit(':').next().unwrap().parse().unwrap();
        drop(lease);

        engine.shutdown(Duration::from_millis(200)).await;

        assert!(port_closes(port).await, "the engine child is still serving");
        assert_eq!(engine.status().phase, Phase::Stopped);
        assert!(engine.run.lock().await.is_none());
        let again = engine.ensure(&target("m"), 4096).await.err();
        assert_eq!(again, Some(LocalEngineError::Cancelled));
        assert_eq!(
            fake.starts.load(Ordering::SeqCst),
            1,
            "no engine after exit"
        );
    }

    #[tokio::test]
    async fn shutdown_gives_a_turn_in_flight_the_grace_and_then_stops_anyway() {
        let (_fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        let lease = engine.ensure(&target("m"), 4096).await.unwrap();
        let port: u16 = lease.origin.rsplit(':').next().unwrap().parse().unwrap();

        let grace = Duration::from_millis(400);
        let began = Instant::now();
        engine.shutdown(grace).await;
        let took = began.elapsed();

        assert!(took >= grace, "stopped under a turn after {took:?}");
        assert!(took < Duration::from_secs(5), "took {took:?}");
        assert!(port_closes(port).await);
        drop(lease);
    }

    #[tokio::test]
    async fn shutdown_does_not_wait_the_grace_when_no_turn_holds_the_engine() {
        let (_fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        drop(engine.ensure(&target("m"), 4096).await.unwrap());
        let began = Instant::now();
        engine.shutdown(Duration::from_secs(30)).await;
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn shutdown_cancels_a_model_that_is_still_loading() {
        let (fake, engine, _dir) = engine("healthy", DEFAULT_IDLE);
        let engine = Arc::new(engine);
        let start = tokio::spawn({
            let engine = engine.clone();
            async move { engine.ensure(&target("m"), 4096).await.err() }
        });
        // Let the child spawn and report "loading".
        for _ in 0..40 {
            if engine.status().phase == Phase::Loading {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(engine.status().phase, Phase::Loading);

        engine.shutdown(Duration::from_millis(200)).await;

        assert_eq!(start.await.unwrap(), Some(LocalEngineError::Cancelled));
        assert_eq!(engine.status().phase, Phase::Stopped);
        let port = fake.ports.lock().unwrap()[0];
        assert!(port_closes(port).await, "the half-loaded engine survived");
    }

    /// The child dies when the job's last handle closes, which is what the
    /// system does for a process that crashes.
    #[cfg(windows)]
    #[test]
    fn a_child_in_the_job_dies_when_the_job_handle_closes() {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let job = JobGuard::for_child(&child).expect("assign to a job");
        assert!(matches!(child.try_wait(), Ok(None)), "alive while held");

        drop(job);

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut ended = false;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                ended = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        assert!(ended, "the child outlived its job handle");
    }

    #[test]
    fn exit_reasons_come_from_the_log_as_codes() {
        let code = |log: &str| match classify_exit(log) {
            LocalEngineError::LoadFailed { reason } => reason,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            code("done_getting_tensors: wrong number of tensors"),
            "tensor_count"
        );
        assert_eq!(
            code("error: unknown model architecture: 'x'"),
            "unknown_architecture"
        );
        assert_eq!(
            code(
                "llama_model_load: error loading model: error loading model hyperparameters:                  key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3
                 srv load_model: failed to load model, 'C:/x'"
            ),
            "model_metadata",
            "the settings error wins over the generic failed-to-load line after it"
        );
        assert_eq!(
            code("llama_model_loader: key not found in model: qwen35.block_count"),
            "model_metadata"
        );
        assert_eq!(code("ggml_vulkan: ErrorOutOfDeviceMemory"), "out_of_memory");
        assert_eq!(code("couldn't bind HTTP server socket"), "port_in_use");
        assert_eq!(
            code("srv load_model: failed to load model, 'C:/x'"),
            "model_rejected"
        );
        assert_eq!(code(""), "exited");
    }

    fn arguments(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let at = args.iter().position(|arg| arg == flag)?;
        args.get(at + 1).map(String::as_str)
    }

    #[test]
    fn the_command_names_the_model_by_id_and_allows_no_origin() {
        let spec = LaunchSpec {
            model_path: PathBuf::from("C:/Users/someone/models/m.gguf"),
            alias: "gemma4:26b".into(),
            port: 1234,
            api_key: "k".into(),
            context: 8192,
        };
        let command = server_command(Path::new("C:/engine"), &spec);
        let args = arguments(&command);
        assert_eq!(after(&args, "--alias"), Some("gemma4:26b"));
        assert_eq!(after(&args, "--host"), Some("127.0.0.1"));
        assert_eq!(after(&args, "--cors-origins"), Some("http://127.0.0.1:1"));
        assert!(args.iter().any(|arg| arg == "--no-cors-credentials"));
        // The key goes through the environment, never the command line.
        assert!(!args.iter().any(|arg| arg == "k" || arg == "--api-key"));
    }

    #[test]
    fn the_real_command_takes_its_settings_from_rust_only() {
        let dir = tempfile::tempdir().unwrap();
        let server = LlamaServer {
            engine_root: dir.path().to_path_buf(),
        };
        let spec = LaunchSpec {
            model_path: PathBuf::from("C:/m.gguf"),
            alias: "m".into(),
            port: 1234,
            api_key: "k".into(),
            context: 8192,
        };
        // Not installed: nothing to run.
        assert_eq!(
            server.command(&spec).err(),
            Some(LocalEngineError::EngineMissing)
        );
    }
}
