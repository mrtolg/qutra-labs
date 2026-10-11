use crate::analysis::{
    store::{RunOutput, Trigger},
    Fact, Observation,
};
use crate::durable_file::write_new_file;
use crate::engagement_folders::validate_engagement_id;
use crate::launch_receipts::{Refusal, Resolution};
use crate::tool_output::OutputDecoder;
#[cfg(test)]
use crate::tool_registry::RegisterToolRequest;
use crate::tool_detect::{DetectRoots, DetectedTool};
use crate::tool_registry::{
    now_ms, ListedToolInstallation, LocatedCandidate, RegisterLocatedToolRequest,
    ToolInstallationRecord, ToolRegistry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt, fs,
    io::{self, Read, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use uuid::Uuid;

const LEDGER_VERSION: u32 = 2;
const V1_BACKUP_FILE: &str = "tool-runs.v1.json";
const MAX_ACTIVE_RUNS: usize = 3;
const MAX_TIMEOUT_SEC: u64 = 60 * 60;
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TAIL_BYTES: usize = 64 * 1024;
const MAX_EVENT_BYTES: u64 = 256 * 1024;
const MAX_ARG_COUNT: usize = 256;
const MAX_ARG_BYTES: usize = 64 * 1024;
const MAX_ENV_COUNT: usize = 32;
/// Far inside std's 64 KiB Windows stdin pipe (Rust 1.98): the write under `active` never waits.
const MAX_STDIN_BYTES: usize = 2048;
const SCOPE_DECISION_MAX_AGE_MS: u64 = 5 * 60 * 1000;
/// `CREATE_NO_WINDOW` from the Windows process creation flags.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInput {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub sensitive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeAttestation {
    pub scope_id: String,
    pub scope_revision: u32,
    pub target: String,
    pub allowed: bool,
    pub reason: String,
    pub decided_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartToolRunRequest {
    pub installation_id: String,
    pub profile_id: String,
    pub request_id: String,
    #[serde(default)]
    pub engagement_id: Option<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub environment: Vec<EnvironmentInput>,
    #[serde(default)]
    pub redactions: Vec<String>,
    #[serde(default)]
    pub scope: Option<ScopeAttestation>,
    #[serde(default)]
    pub requires_scope: bool,
    pub timeout_sec: u64,
    pub output_limit_bytes: u64,
    #[serde(default = "default_concurrency_class")]
    pub concurrency_class: String,
    /// Set by Rust only. Skipped when read and refused when named
    /// (`deny_unknown_fields`), so a page cannot say who started a run or
    /// what it read.
    #[serde(skip)]
    pub origin: RunOrigin,
}

fn default_concurrency_class() -> String {
    "default".into()
}

fn external_kind() -> String {
    "external".into()
}

/// What a run read (ledger v2, spec §4.3): the investigation file a tool was
/// given and, for a tool that takes them, the file it read as its rules, each
/// with the SHA-256 Rust checked just before the run.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunSubject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules_file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules_sha256: Option<String>,
}

/// A finished run's logs, for the parser of the descriptor it was built from.
#[derive(Clone, Debug)]
pub struct RunLogs {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

type ParseFn = dyn Fn(&RunLogs) -> Result<Vec<Fact>, String> + Send + Sync;

/// Reads a finished run's logs into facts. On an `Err` (a short code, never
/// the logs' text) or a panic, the run keeps no observations, the code or
/// the fact of the panic is logged with the run id, and a run that had
/// succeeded is recorded as failed with `output_unreadable`.
#[derive(Clone)]
pub struct ParseHook(pub Arc<ParseFn>);

impl fmt::Debug for ParseHook {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ParseHook")
    }
}

/// What a run records beyond what a page may ask for (ledger v2).
#[derive(Clone, Debug)]
pub struct RunOrigin {
    pub trigger: Trigger,
    pub subject: Option<RunSubject>,
    /// The `external_tools` descriptor the request was built from.
    pub descriptor_id: Option<String>,
    pub parse: Option<ParseHook>,
    /// Text for the tool's standard input, at most `MAX_STDIN_BYTES`; the pipe
    /// is closed after it.
    pub stdin: Option<Vec<u8>>,
    /// The run reads one file and touches no target, so no authorization
    /// scope applies, whatever category its program was registered under.
    pub local_input_only: bool,
}

impl Default for RunOrigin {
    fn default() -> Self {
        Self {
            trigger: Trigger::user(),
            subject: None,
            descriptor_id: None,
            parse: None,
            stdin: None,
            local_input_only: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifactRecord {
    pub kind: String,
    pub path: String,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolRun {
    pub id: String,
    pub request_id: String,
    pub profile_id: String,
    pub installation_id: String,
    pub engagement_id: Option<String>,
    pub scope_id: Option<String>,
    pub scope_revision: Option<u32>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    pub state: String,
    pub argv: Vec<String>,
    pub command_preview: String,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub termination_reason: String,
    #[serde(default)]
    pub working_dir: String,
    pub artifact_dir: String,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub bytes_out: u64,
    pub bytes_err: u64,
    pub truncated: bool,
    pub blocked_reason: String,
    pub artifacts: Vec<RunArtifactRecord>,
    /// "external": a program the user registered. Built-in analyses are kept
    /// apart (`analysis-runs.json`).
    #[serde(default = "external_kind")]
    pub kind: String,
    #[serde(default)]
    pub trigger: Trigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<RunSubject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptor_id: Option<String>,
    /// The logs, hashed when the run ended (spec §4.3).
    #[serde(default)]
    pub outputs: Vec<RunOutput>,
    #[serde(default)]
    pub observations: Vec<Observation>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRunEvent {
    pub run_id: String,
    pub kind: String,
    pub at: u64,
    pub stream: Option<String>,
    pub chunk: Option<String>,
    pub state: Option<String>,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
    pub artifact: Option<RunArtifactRecord>,
}

pub type EventSink = Arc<dyn Fn(ToolRunEvent) + Send + Sync + 'static>;

/// The identity-verified executable path and registered working directory
/// for an unsupervised launch (detached GUI process or interactive terminal
/// tab), produced only by `ToolSupervisor::resolve_launchable`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchTarget {
    pub program: PathBuf,
    pub working_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RunLedger {
    version: u32,
    runs: Vec<NativeToolRun>,
}

impl Default for RunLedger {
    fn default() -> Self {
        Self {
            version: LEDGER_VERSION,
            runs: Vec::new(),
        }
    }
}

/// What an approval card may say about a registered launch (data contracts §2):
/// the name, the SHA-256 the file was just checked against, and the risk
/// rating given when it was registered. Never a path (ADR 0012 Decision 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchApprovalFacts {
    pub display_name: String,
    pub sha256: String,
    pub risk_tier: String,
}

#[derive(Clone)]
pub struct ToolSupervisor {
    inner: Arc<SupervisorInner>,
}

struct SupervisorInner {
    base_dir: PathBuf,
    registry: ToolRegistry,
    ledger_path: PathBuf,
    ledger: Mutex<RunLedger>,
    persistence: Mutex<()>,
    active: Mutex<HashMap<String, ActiveRun>>,
    /// False when saving would replace runs this version cannot read, or when
    /// start-up could not save. Decided in `load`; while false, nothing is
    /// started, recorded or deleted.
    writable: bool,
    /// A version-1 ledger's bytes, kept until the first save writes them to
    /// `tool-runs.v1.json`.
    v1_backup: Mutex<Option<Vec<u8>>>,
}

struct ActiveRun {
    control: Arc<ProcessControl>,
    stop_reason: Option<String>,
    concurrency_class: String,
    redactions: Vec<String>,
    stdout_event_bytes: u64,
    stderr_event_bytes: u64,
    stdout_artifact_bytes: u64,
    stderr_artifact_bytes: u64,
    output_limit_bytes: u64,
    truncation_emitted: bool,
    parse: Option<ParseHook>,
}

struct StreamRedactor {
    pending: Vec<u8>,
    redactions: Vec<String>,
}

impl StreamRedactor {
    fn new(redactions: Vec<String>) -> Self {
        Self {
            pending: Vec::new(),
            redactions,
        }
    }

    fn push(&mut self, bytes: &[u8], finished: bool) -> Option<String> {
        self.pending.extend_from_slice(bytes);
        if self.pending.is_empty() {
            return None;
        }

        let mut split_at = self.pending.len();
        if !finished {
            if let Err(error) = std::str::from_utf8(&self.pending) {
                if error.error_len().is_none() {
                    split_at = error.valid_up_to();
                }
            }
            for secret in &self.redactions {
                let needle = secret.as_bytes();
                for prefix_len in 1..needle.len() {
                    if self.pending.ends_with(&needle[..prefix_len]) {
                        split_at = split_at.min(self.pending.len() - prefix_len);
                    }
                }
            }
        }

        if split_at == 0 {
            return None;
        }
        let drained: Vec<u8> = self.pending.drain(..split_at).collect();
        Some(redact_text(
            &String::from_utf8_lossy(&drained),
            &self.redactions,
        ))
    }
}

impl ToolSupervisor {
    pub fn load(base_dir: &Path) -> Result<Self, String> {
        let lab_dir = base_dir.join("lab");
        fs::create_dir_all(lab_dir.join("runs")).map_err(io_error)?;
        let ledger_path = lab_dir.join("tool-runs.json");
        let Loaded {
            mut ledger,
            writable,
            v1_bytes,
        } = load_ledger(&ledger_path);
        let mut reconciled = false;
        for run in &mut ledger.runs {
            if matches!(
                run.state.as_str(),
                "queued" | "starting" | "running" | "cancelling"
            ) {
                run.state = "orphaned".into();
                run.termination_reason = "app_restarted".into();
                run.ended_at = Some(now_ms());
                run.updated_at = now_ms();
                reconciled = true;
            }
        }
        let mut inner = SupervisorInner {
            base_dir: base_dir.to_path_buf(),
            registry: ToolRegistry::load(base_dir),
            ledger_path,
            ledger: Mutex::new(ledger),
            persistence: Mutex::new(()),
            active: Mutex::new(HashMap::new()),
            writable,
            v1_backup: Mutex::new(v1_bytes),
        };
        if reconciled && inner.writable {
            if let Err(reason) = inner.persist_ledger() {
                // Start-up goes on with the runs reconciled in memory; the
                // ledger file stays as it was and this session writes nothing.
                eprintln!(
                    "[Qutra Labs] run ledger not saved at start-up ({reason}); read only until the next start"
                );
                inner.writable = false;
            }
        }
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Hold a natively picked executable for review; see `ToolRegistry::locate`.
    pub fn locate_candidate(&self, picked_path: &str) -> Result<LocatedCandidate, String> {
        self.inner.registry.locate(picked_path)
    }

    pub fn register_located(
        &self,
        request: RegisterLocatedToolRequest,
    ) -> Result<ToolInstallationRecord, String> {
        self.inner.registry.register_located(request)
    }

    #[cfg(test)]
    pub fn register_tool(
        &self,
        request: RegisterToolRequest,
    ) -> Result<ToolInstallationRecord, String> {
        self.inner.registry.register(request)
    }

    pub fn list_tools(&self) -> Result<Vec<ToolInstallationRecord>, String> {
        self.inner.registry.list()
    }

    pub fn list_tools_with_presence(&self) -> Result<Vec<ListedToolInstallation>, String> {
        self.inner.registry.list_with_presence()
    }

    /// Scan this computer for the toolbox's programs; see `tool_detect`.
    pub fn detect_tools(&self, skip: &HashSet<String>) -> Vec<DetectedTool> {
        crate::tool_detect::scan(&self.inner.registry, &DetectRoots::from_env(), skip)
    }

    pub fn get_tool(&self, id: &str) -> Result<ToolInstallationRecord, String> {
        self.inner.registry.get(id)
    }

    pub fn reverify_tool(
        &self,
        id: &str,
        accept_changed_identity: bool,
    ) -> Result<ToolInstallationRecord, String> {
        self.inner.registry.reverify(id, accept_changed_identity)
    }

    pub fn set_tool_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<ToolInstallationRecord, String> {
        self.inner.registry.set_enabled(id, enabled)
    }

    pub fn remove_tool(&self, id: &str) -> Result<(), String> {
        self.inner.registry.remove(id)
    }

    /// Resolve an `installation_id` to its identity-verified canonical path
    /// and registered working directory, for an unsupervised launch (a
    /// detached GUI process or an interactive terminal tab). The renderer
    /// never names a path itself; this is the only thing that turns an id
    /// into one.
    ///
    /// This is the exact same gate the batch Run button uses
    /// (`ToolRegistry::resolve_for_run`): enabled check, stored
    /// `changed_since_verify` check, and a live re-hash of the binary on
    /// disk against the stored `sha256`. Drift is therefore caught even if
    /// the executable was swapped since the last `reverify` call — it is
    /// not just read off the stored flag.
    ///
    /// Refuses a missing installation (`tool_not_found`), a disabled one
    /// (`tool_disabled`), one whose executable has changed since it was
    /// last verified — whether previously recorded or freshly detected
    /// (`tool_identity_changed`), one whose executable is missing from disk
    /// (`tool_path_missing`), or one whose registered working directory is
    /// missing or not a folder (`working_directory_missing` /
    /// `working_directory_not_folder`).
    pub fn resolve_launchable(&self, id: &str) -> Result<LaunchTarget, String> {
        self.resolve_launch_for_receipt(id)
            .map(|(target, _)| target)
            .map_err(|refusal| refusal.reason_code)
    }

    /// `resolve_launchable`, plus the display name a launch receipt shows
    /// (`launch_receipts.rs`), from the one identity check. A refusal still
    /// carries the registry's display name when the record exists, so a
    /// failed receipt says which tool failed instead of a bare uuid; the
    /// name is display data only and never authorizes anything.
    pub fn resolve_launch_for_receipt(&self, id: &str) -> Resolution<LaunchTarget> {
        let record = match self.resolve_for_run_mapped(id) {
            Ok(record) => record,
            Err(reason_code) => {
                return Err(Refusal {
                    reason_code,
                    display_name: self
                        .get_tool(id)
                        .map(|record| record.display_name)
                        .unwrap_or_default(),
                })
            }
        };
        // Empty `requested` picks the registered working dir itself (see
        // `resolve_run_working_dir`) — an unsupervised launch has no
        // per-run override to validate against it.
        match resolve_run_working_dir(&record, "") {
            Ok(working_dir) => Ok((
                LaunchTarget {
                    program: PathBuf::from(record.canonical_path),
                    working_dir,
                },
                record.display_name,
            )),
            Err(reason_code) => Err(Refusal {
                reason_code,
                display_name: record.display_name,
            }),
        }
    }

    /// Resolve `id` through the identical identity gate `resolve_launchable`
    /// uses (`ToolRegistry::resolve_for_run`, via the same
    /// `resolve_for_run_mapped` wrapper) and hand back only the
    /// human-readable display name — never the executable path or working
    /// directory `resolve_launchable` also resolves. A launch route's
    /// approval card must never name a path (ADR 0012 Decision 3), but
    /// naming the tool by a random installation uuid alone is not "the
    /// exact action" the model proposed either — this is the one field an
    /// approval summary needs and the identity check already produces for
    /// free.
    ///
    /// Deliberately the *same* gate as `resolve_launchable`, not a second,
    /// weaker lookup (such as reading the record straight off `get_tool`
    /// without re-checking `enabled` / drift): a disabled or
    /// identity-changed installation must fail here exactly as it would at
    /// execution time, so the approval card can say so plainly instead of
    /// showing a friendly name for a launch that would actually be refused.
    ///
    /// Called once per proposed call, before approval, to build the
    /// summary; `execute_launch_tool`'s own resolution after approval is
    /// entirely separate and can observe a different outcome if the
    /// installation's state changes in the meantime (disabled, edited,
    /// binary swapped) — that gap is ADR 0012 Decision 2's per-call
    /// approval working as intended, not something this call papers over.
    ///
    /// The card now resolves through `resolve_launch_facts`; this stays for
    /// the test that pins the name and the refusal codes.
    #[cfg(test)]
    pub fn resolve_launch_display_name(&self, id: &str) -> Result<String, String> {
        self.resolve_for_run_mapped(id)
            .map(|record| record.display_name)
    }

    /// The same gate as `resolve_launch_display_name`, with the identity
    /// evidence and the registered rating an approval card shows as facts
    /// (data contracts §2). One resolution serves both the card's sentence and its
    /// facts, so they cannot describe two different checks.
    pub fn resolve_launch_facts(&self, id: &str) -> Result<LaunchApprovalFacts, String> {
        self.resolve_for_run_mapped(id)
            .map(|record| LaunchApprovalFacts {
                display_name: record.display_name,
                sha256: record.sha256,
                risk_tier: record.risk_tier,
            })
    }

    /// Shared body of `resolve_launchable`, `resolve_launch_display_name` and
    /// `resolve_launch_facts`:
    /// run the identity gate and translate the registry's internal
    /// `tool_not_registered` into the stable `tool_not_found` code the rest
    /// of this module (and the renderer's error mapping) expects. The only
    /// place that calls `ToolRegistry::resolve_for_run` — every other
    /// resolution in this file goes through one of the public methods
    /// above, never this call directly.
    fn resolve_for_run_mapped(&self, id: &str) -> Result<ToolInstallationRecord, String> {
        self.inner.registry.resolve_for_run(id).map_err(|err| {
            if err == "tool_not_registered" {
                "tool_not_found".to_string()
            } else {
                err
            }
        })
    }

    pub fn list_runs(&self) -> Result<Vec<NativeToolRun>, String> {
        let ledger = self
            .inner
            .ledger
            .lock()
            .map_err(|_| "run_ledger_lock_failed")?;
        let mut runs = ledger.runs.clone();
        runs.sort_by_key(|run| std::cmp::Reverse(run.created_at));
        Ok(runs)
    }

    pub fn list_active_runs(&self) -> Result<Vec<NativeToolRun>, String> {
        let ids: HashSet<String> = self
            .inner
            .active
            .lock()
            .map_err(|_| "active_run_lock_failed")?
            .keys()
            .cloned()
            .collect();
        Ok(self
            .list_runs()?
            .into_iter()
            .filter(|run| ids.contains(&run.id))
            .collect())
    }

    /// One run, found under the ledger's lock: only its row is copied.
    pub fn get_run(&self, run_id: &str) -> Result<NativeToolRun, String> {
        self.inner
            .ledger
            .lock()
            .map_err(|_| "run_ledger_lock_failed")?
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .cloned()
            .ok_or_else(|| "run_not_found".to_string())
    }

    /// The investigation's runs that were built from a descriptor, newest
    /// first.
    pub fn described_runs(&self, engagement_id: &str) -> Result<Vec<NativeToolRun>, String> {
        validate_engagement_id(engagement_id)?;
        Ok(self
            .list_runs()?
            .into_iter()
            .filter(|run| {
                run.descriptor_id.is_some() && run.engagement_id.as_deref() == Some(engagement_id)
            })
            .collect())
    }

    /// One of a run's two logs, whole, when the ledger hashed it and only
    /// while it still has that hash: the bytes read are hashed again, and a log
    /// that was changed on disk since is not handed out (`output_changed`). So
    /// the text is exactly what the ledger recorded.
    pub fn read_run_log(&self, run_id: &str, name: &str) -> Result<String, String> {
        validate_run_id(run_id)?;
        if !matches!(name, "stdout.log" | "stderr.log") {
            return Err("invalid_output_name".into());
        }
        let recorded = self
            .inner
            .ledger
            .lock()
            .map_err(|_| "run_ledger_lock_failed")?
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .and_then(|run| run.outputs.iter().find(|output| output.name == name))
            .map(|output| output.sha256.clone())
            .ok_or_else(|| "unknown_run".to_string())?;
        let bytes = fs::read(self.safe_run_dir(run_id)?.join(name))
            .map_err(|_| "output_missing".to_string())?;
        if hex::encode(Sha256::digest(&bytes)) != recorded {
            return Err("output_changed".into());
        }
        String::from_utf8(bytes).map_err(|_| "output_unreadable".to_string())
    }

    pub fn delete_run_artifacts(&self, run_id: &str) -> Result<NativeToolRun, String> {
        // Logs are deleted only by a ledger that can record that they were.
        self.inner.require_writable()?;
        validate_run_id(run_id)?;
        if self
            .inner
            .active
            .lock()
            .map_err(|_| "active_run_lock_failed")?
            .contains_key(run_id)
        {
            return Err("run_still_active".into());
        }
        self.get_run(run_id)?;

        let run_dir = self.safe_run_dir(run_id)?;
        for name in ["stdout.log", "stderr.log"] {
            let path = run_dir.join(name);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(error)),
            }
        }
        match fs::remove_dir(&run_dir) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => return Err(io_error(error)),
        }
        self.patch_run(run_id, |run| {
            run.artifact_dir.clear();
            run.artifacts.clear();
            run.updated_at = now_ms();
        })?;
        self.get_run(run_id)
    }

    /// Tests start runs with nothing to withdraw; the app always goes through
    /// `start_run_while` with the consent check.
    #[cfg(test)]
    pub fn start_run(
        &self,
        request: StartToolRunRequest,
        events: EventSink,
    ) -> Result<NativeToolRun, String> {
        self.start_run_while(request, events, || true)
    }

    /// Start a run while `allowed` still holds. It is asked again under the
    /// active-run lock, which the revoke sweep takes too: a start
    /// that passed its consent check just before a revoke either registers
    /// before the sweep, which then stops it, or sees the revoke here and is
    /// refused.
    pub fn start_run_while(
        &self,
        request: StartToolRunRequest,
        events: EventSink,
        allowed: impl Fn() -> bool,
    ) -> Result<NativeToolRun, String> {
        // A ledger that cannot record a run starts none, before anything is
        // made for it.
        self.inner.require_writable()?;
        validate_run_request(&request)?;
        let installation = match self
            .inner
            .registry
            .resolve_for_run(&request.installation_id)
        {
            Ok(installation) => installation,
            Err(reason) => {
                let known_installation = self.inner.registry.get(&request.installation_id).ok();
                return self.record_blocked_attempt(
                    &request,
                    known_installation.as_ref(),
                    &reason,
                    events,
                );
            }
        };
        // A run built from a descriptor reads one investigation file and
        // touches no target, so no authorization scope applies to it,
        // whatever category its program was registered under.
        let scope_required = !request.origin.local_input_only
            && (request.requires_scope
                || matches!(installation.category.as_str(), "network" | "web"));
        if let Err(reason) = validate_scope(&request, scope_required) {
            return self.record_blocked_attempt(&request, Some(&installation), &reason, events);
        }
        let working_dir = match resolve_run_working_dir(&installation, &request.working_dir) {
            Ok(path) => path,
            Err(reason) => {
                return self.record_blocked_attempt(&request, Some(&installation), &reason, events);
            }
        };
        let environment = match validate_environment(&request.environment) {
            Ok(environment) => environment,
            Err(reason) => {
                return self.record_blocked_attempt(&request, Some(&installation), &reason, events);
            }
        };
        let redactions = match validate_redactions(&request.redactions, &request.environment) {
            Ok(redactions) => redactions,
            Err(reason) => {
                return self.record_blocked_attempt(&request, Some(&installation), &reason, events);
            }
        };
        let timeout_sec = request.timeout_sec.clamp(1, MAX_TIMEOUT_SEC);
        let output_limit = request.output_limit_bytes.clamp(1024, MAX_OUTPUT_BYTES);

        // Keep the active-run lock through spawn and registration so parallel
        // IPC calls cannot race past the native concurrency ceiling.
        let mut active = self
            .inner
            .active
            .lock()
            .map_err(|_| "active_run_lock_failed")?;
        if !allowed() {
            drop(active);
            return self.record_blocked_attempt(
                &request,
                Some(&installation),
                "consent_revoked",
                events,
            );
        }
        if active.len() >= MAX_ACTIVE_RUNS {
            drop(active);
            return self.record_blocked_attempt(
                &request,
                Some(&installation),
                "concurrency_limit_reached",
                events,
            );
        }
        if request.concurrency_class == "exclusive" && !active.is_empty() {
            drop(active);
            return self.record_blocked_attempt(
                &request,
                Some(&installation),
                "exclusive_run_requires_empty_queue",
                events,
            );
        }
        if active
            .values()
            .any(|run| run.concurrency_class == "exclusive")
        {
            drop(active);
            return self.record_blocked_attempt(
                &request,
                Some(&installation),
                "exclusive_run_active",
                events,
            );
        }

        let run_id = format!("run-{}", Uuid::new_v4());
        let artifact_dir = self.safe_run_dir(&run_id)?;
        fs::create_dir_all(&artifact_dir).map_err(io_error)?;
        let created_at = now_ms();
        let command_preview =
            command_preview(&installation.display_name, &request.argv, &redactions);
        let mut run = NativeToolRun {
            id: run_id.clone(),
            request_id: request.request_id.clone(),
            profile_id: request.profile_id.clone(),
            installation_id: installation.id.clone(),
            engagement_id: request.engagement_id.clone(),
            scope_id: request.scope.as_ref().map(|scope| scope.scope_id.clone()),
            scope_revision: request.scope.as_ref().map(|scope| scope.scope_revision),
            target_id: request.target_id.clone(),
            target: request.scope.as_ref().map(|scope| scope.target.clone()),
            state: "queued".into(),
            argv: redact_tokens(&request.argv, &redactions),
            command_preview,
            pid: None,
            started_at: None,
            ended_at: None,
            exit_code: None,
            termination_reason: String::new(),
            working_dir: working_dir.to_string_lossy().to_string(),
            artifact_dir: artifact_dir.to_string_lossy().to_string(),
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            bytes_out: 0,
            bytes_err: 0,
            truncated: false,
            blocked_reason: String::new(),
            artifacts: Vec::new(),
            kind: "external".into(),
            trigger: request.origin.trigger.clone(),
            subject: request.origin.subject.clone(),
            descriptor_id: request.origin.descriptor_id.clone(),
            outputs: Vec::new(),
            observations: Vec::new(),
            created_at,
            updated_at: created_at,
        };
        if let Err(error) = self.insert_run(run.clone()) {
            // The row was not kept, so neither is the folder just made for
            // it; `remove_dir` leaves a folder that holds anything.
            let _ = fs::remove_dir(&artifact_dir);
            return Err(error);
        }
        emit_state(&events, &run_id, "queued", None, None, None);

        let mut command = Command::new(&installation.canonical_path);
        command
            .args(&request.argv)
            .current_dir(&working_dir)
            .stdin(if request.origin.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        // Started from the windowed app, a console tool would open a console
        // window of its own for every run; it gets a hidden one instead.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        add_baseline_environment(&mut command);
        for (key, value) in environment {
            command.env(key, value);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let reason = if error.kind() == io::ErrorKind::PermissionDenied {
                    "elevation_required"
                } else {
                    "spawn_failed"
                };
                self.finish_without_process(&run_id, "failed", None, reason)?;
                emit_state(&events, &run_id, "failed", None, None, Some(reason));
                return Err(reason.into());
            }
        };
        let pid = child.id();
        let control = match ProcessControl::for_child(&child) {
            Ok(control) => Arc::new(control),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                self.finish_without_process(&run_id, "failed", None, &error)?;
                emit_state(&events, &run_id, "failed", None, None, Some(&error));
                return Err(error);
            }
        };
        // The text for the tool's standard input (a path ExifTool cannot take
        // on its command line) is at most `MAX_STDIN_BYTES`, so it fits the
        // pipe's buffer and goes in before the readers start; closing the
        // pipe ends the tool's input. A tool that did not get it does not run.
        if let Some(input) = request.origin.stdin.as_deref() {
            if let Err(error) = deliver_input(child.stdin.take(), input) {
                eprintln!(
                    "[Qutra Labs] run {run_id}: input not delivered: {}",
                    error.kind()
                );
                let _ = child.kill();
                let _ = child.wait();
                let reason = "input_not_delivered";
                self.finish_without_process(&run_id, "failed", None, reason)?;
                emit_state(&events, &run_id, "failed", None, None, Some(reason));
                return Err(reason.into());
            }
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "stdout_capture_failed".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "stderr_capture_failed".to_string())?;

        active.insert(
            run_id.clone(),
            ActiveRun {
                control: Arc::clone(&control),
                stop_reason: None,
                concurrency_class: request.concurrency_class.clone(),
                redactions: redactions.clone(),
                stdout_event_bytes: 0,
                stderr_event_bytes: 0,
                stdout_artifact_bytes: 0,
                stderr_artifact_bytes: 0,
                output_limit_bytes: output_limit,
                truncation_emitted: false,
                parse: request.origin.parse.clone(),
            },
        );
        drop(active);

        run.state = "running".into();
        run.pid = Some(pid);
        run.started_at = Some(now_ms());
        run.updated_at = now_ms();
        // The process is running and holds an active slot: a failed save must
        // not return before the threads that finish the run start, or the row
        // would stay "running" for the whole session. When only the write
        // failed, the ledger in memory has the row and the finish saves it
        // again. The error is a code, never a path.
        if let Err(error) = self.replace_run(run.clone()) {
            eprintln!("[Qutra Labs] run {run_id}: its start was not saved: {error}");
        }
        emit_state(&events, &run_id, "started", Some(pid), None, None);

        let stdout_supervisor = self.clone();
        let stdout_events = Arc::clone(&events);
        let stdout_run_id = run_id.clone();
        let stdout_reader = thread::spawn(move || {
            stdout_supervisor.capture_stream(&stdout_run_id, "stdout", stdout, stdout_events)
        });

        let stderr_supervisor = self.clone();
        let stderr_events = Arc::clone(&events);
        let stderr_run_id = run_id.clone();
        let stderr_reader = thread::spawn(move || {
            stderr_supervisor.capture_stream(&stderr_run_id, "stderr", stderr, stderr_events)
        });

        let wait_supervisor = self.clone();
        let wait_events = Arc::clone(&events);
        let wait_run_id = run_id.clone();
        thread::spawn(move || {
            let status = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            wait_supervisor.finish_process(&wait_run_id, status, wait_events);
        });

        let timeout_supervisor = self.clone();
        let timeout_run_id = run_id.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(timeout_sec));
            let _ = timeout_supervisor.stop_run(&timeout_run_id, "timed_out");
        });

        Ok(run)
    }

    fn record_blocked_attempt(
        &self,
        request: &StartToolRunRequest,
        installation: Option<&ToolInstallationRecord>,
        reason: &str,
        events: EventSink,
    ) -> Result<NativeToolRun, String> {
        self.inner.require_writable()?;
        let timestamp = now_ms();
        let run = NativeToolRun {
            id: format!("run-{}", Uuid::new_v4()),
            request_id: request.request_id.clone(),
            profile_id: request.profile_id.clone(),
            installation_id: request.installation_id.clone(),
            engagement_id: request.engagement_id.clone(),
            scope_id: request.scope.as_ref().map(|scope| scope.scope_id.clone()),
            scope_revision: request.scope.as_ref().map(|scope| scope.scope_revision),
            target_id: request.target_id.clone(),
            target: request.scope.as_ref().map(|scope| scope.target.clone()),
            state: "blocked".into(),
            argv: Vec::new(),
            command_preview: format!(
                "{} [blocked before argument acceptance]",
                installation
                    .map(|item| item.display_name.as_str())
                    .unwrap_or("unregistered tool")
            ),
            pid: None,
            started_at: None,
            ended_at: Some(timestamp),
            exit_code: None,
            termination_reason: reason.into(),
            working_dir: request.working_dir.clone(),
            artifact_dir: String::new(),
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            bytes_out: 0,
            bytes_err: 0,
            truncated: false,
            blocked_reason: reason.into(),
            artifacts: Vec::new(),
            kind: "external".into(),
            trigger: request.origin.trigger.clone(),
            subject: request.origin.subject.clone(),
            descriptor_id: request.origin.descriptor_id.clone(),
            outputs: Vec::new(),
            observations: Vec::new(),
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.insert_run(run.clone())?;
        emit_state(&events, &run.id, "blocked", None, None, Some(reason));
        Ok(run)
    }

    pub fn cancel_run(&self, run_id: &str) -> Result<(), String> {
        self.stop_run(run_id, "cancelled")
    }

    pub fn emergency_stop(&self) -> Result<usize, String> {
        self.stop_every_active_run("emergency_stop")
    }

    /// Withdrawing Private Lab stops the supervised runs it allowed.
    pub fn stop_for_revoked_consent(&self) -> Result<usize, String> {
        self.stop_every_active_run("consent_revoked")
    }

    fn stop_every_active_run(&self, reason: &str) -> Result<usize, String> {
        let ids: Vec<String> = self
            .inner
            .active
            .lock()
            .map_err(|_| "active_run_lock_failed")?
            .keys()
            .cloned()
            .collect();
        let mut stopped = 0;
        for id in ids {
            if self.stop_run(&id, reason).is_ok() {
                stopped += 1;
            }
        }
        Ok(stopped)
    }

    fn stop_run(&self, run_id: &str, reason: &str) -> Result<(), String> {
        validate_run_id(run_id)?;
        let control = {
            let mut active = self
                .inner
                .active
                .lock()
                .map_err(|_| "active_run_lock_failed")?;
            let run = active
                .get_mut(run_id)
                .ok_or_else(|| "run_not_active".to_string())?;
            if run.stop_reason.is_some() {
                return Ok(());
            }
            run.stop_reason = Some(reason.to_string());
            Arc::clone(&run.control)
        };
        self.patch_run(run_id, |run| {
            run.state = "cancelling".into();
            run.termination_reason = reason.into();
            run.updated_at = now_ms();
        })?;
        control.terminate()
    }

    fn capture_stream<R: Read>(
        &self,
        run_id: &str,
        stream: &str,
        mut reader: R,
        events: EventSink,
    ) {
        let artifact_path = match self.safe_run_dir(run_id) {
            Ok(dir) => dir.join(format!("{stream}.log")),
            Err(_) => return,
        };
        let mut artifact = fs::File::create(&artifact_path).ok();
        let redactions = self
            .inner
            .active
            .lock()
            .ok()
            .and_then(|active| active.get(run_id).map(|run| run.redactions.clone()))
            .unwrap_or_default();
        let mut redactor = StreamRedactor::new(redactions);
        // UTF-16 (Sigcheck) and single-byte output (ExifTool's ANSI code page,
        // YARA's C runtime locale) becomes UTF-8 before it is redacted, logged
        // or parsed.
        let mut decoder = OutputDecoder::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    let rest = decoder.push(&[], true);
                    if let Some(redacted) = redactor.push(&rest, true) {
                        self.process_stream_text(run_id, stream, redacted, &mut artifact, &events);
                    }
                    break;
                }
                Ok(count) => count,
            };
            let decoded = decoder.push(&buffer[..count], false);
            if let Some(redacted) = redactor.push(&decoded, false) {
                self.process_stream_text(run_id, stream, redacted, &mut artifact, &events);
            }
        }
    }

    fn process_stream_text(
        &self,
        run_id: &str,
        stream: &str,
        redacted: String,
        artifact: &mut Option<fs::File>,
        events: &EventSink,
    ) {
        let (artifact_slice, emit_chunk, emit_truncated) = {
            let mut active = match self.inner.active.lock() {
                Ok(active) => active,
                Err(_) => return,
            };
            let Some(run) = active.get_mut(run_id) else {
                return;
            };
            let artifact_count = if stream == "stdout" {
                &mut run.stdout_artifact_bytes
            } else {
                &mut run.stderr_artifact_bytes
            };
            let event_count = if stream == "stdout" {
                &mut run.stdout_event_bytes
            } else {
                &mut run.stderr_event_bytes
            };
            let artifact_remaining = run.output_limit_bytes.saturating_sub(*artifact_count);
            let event_remaining = MAX_EVENT_BYTES.saturating_sub(*event_count);
            let artifact_len = safe_prefix_len(&redacted, artifact_remaining as usize);
            let event_len = safe_prefix_len(&redacted, event_remaining as usize);
            *artifact_count += artifact_len as u64;
            *event_count += event_len as u64;
            let should_truncate = artifact_len < redacted.len();
            let emit_truncated = should_truncate && !run.truncation_emitted;
            if emit_truncated {
                run.truncation_emitted = true;
            }
            (
                redacted.as_bytes()[..artifact_len].to_vec(),
                redacted.as_bytes()[..event_len].to_vec(),
                emit_truncated,
            )
        };

        if let Some(file) = artifact.as_mut() {
            if !artifact_slice.is_empty() {
                let _ = file.write_all(&artifact_slice);
            }
        }
        let _ = self.patch_run(run_id, |run| {
            if stream == "stdout" {
                run.bytes_out = run.bytes_out.saturating_add(redacted.len() as u64);
                append_tail(&mut run.stdout_tail, &redacted);
            } else {
                run.bytes_err = run.bytes_err.saturating_add(redacted.len() as u64);
                append_tail(&mut run.stderr_tail, &redacted);
            }
            if emit_truncated {
                run.truncated = true;
            }
            run.updated_at = now_ms();
        });
        if !emit_chunk.is_empty() {
            (events)(ToolRunEvent {
                run_id: run_id.into(),
                kind: stream.into(),
                at: now_ms(),
                stream: Some(stream.into()),
                chunk: Some(String::from_utf8_lossy(&emit_chunk).to_string()),
                state: None,
                pid: None,
                exit_code: None,
                reason: None,
                artifact: None,
            });
        }
        if emit_truncated {
            emit_state(
                events,
                run_id,
                "output_truncated",
                None,
                None,
                Some("output_limit_reached"),
            );
        }
    }

    fn finish_process(
        &self,
        run_id: &str,
        status: io::Result<std::process::ExitStatus>,
        events: EventSink,
    ) {
        let finished = self
            .inner
            .active
            .lock()
            .ok()
            .and_then(|mut active| active.remove(run_id));
        let (stopped_reason, parse) = match finished {
            Some(active) => (active.stop_reason, active.parse),
            None => (None, None),
        };

        let (mut state, exit_code, mut reason) = match (stopped_reason.as_deref(), status) {
            (Some("timed_out"), result) => (
                "timed_out",
                result.ok().and_then(|value| value.code()),
                "timeout",
            ),
            (Some("emergency_stop"), result) => (
                "cancelled",
                result.ok().and_then(|value| value.code()),
                "emergency_stop",
            ),
            (Some("consent_revoked"), result) => (
                "cancelled",
                result.ok().and_then(|value| value.code()),
                "consent_revoked",
            ),
            (Some(_), result) => (
                "cancelled",
                result.ok().and_then(|value| value.code()),
                "user_cancelled",
            ),
            (None, Ok(result)) if result.success() => ("succeeded", result.code(), "completed"),
            (None, Ok(result)) => ("failed", result.code(), "non_zero_exit"),
            (None, Err(_)) => ("failed", None, "wait_failed"),
        };

        let artifact_dir = self.safe_run_dir(run_id).ok();
        let mut artifacts = Vec::new();
        if let Some(dir) = artifact_dir {
            for kind in ["stdout", "stderr"] {
                let path = dir.join(format!("{kind}.log"));
                if let Ok(metadata) = fs::metadata(&path) {
                    if metadata.len() > 0 {
                        artifacts.push(RunArtifactRecord {
                            kind: kind.into(),
                            path: path.to_string_lossy().to_string(),
                            size_bytes: metadata.len(),
                            truncated: self
                                .list_runs()
                                .ok()
                                .and_then(|runs| runs.into_iter().find(|run| run.id == run_id))
                                .map(|run| run.truncated)
                                .unwrap_or(false),
                        });
                    }
                }
            }
        }
        // Both readers have ended, so the logs are whole: hash them (spec
        // §4.3) and let the descriptor's parser read them.
        let outputs = self.hash_outputs(run_id);
        let (observations, unreadable) = self.parse_logs(run_id, parse.as_ref(), exit_code);
        if unreadable && state == "succeeded" {
            state = "failed";
            reason = "output_unreadable";
        }
        let artifacts_for_event = artifacts.clone();
        let _ = self.patch_run(run_id, |run| {
            run.state = state.into();
            run.exit_code = exit_code;
            run.ended_at = Some(now_ms());
            run.termination_reason = reason.into();
            run.artifacts = artifacts;
            run.outputs = outputs;
            run.observations = observations;
            run.updated_at = now_ms();
        });
        for artifact in artifacts_for_event {
            (events)(ToolRunEvent {
                run_id: run_id.into(),
                kind: "artifact".into(),
                at: now_ms(),
                stream: None,
                chunk: None,
                state: None,
                pid: None,
                exit_code: None,
                reason: None,
                artifact: Some(artifact),
            });
        }
        let event_kind = if state == "succeeded" {
            "finished"
        } else {
            state
        };
        (events)(ToolRunEvent {
            run_id: run_id.into(),
            kind: event_kind.into(),
            at: now_ms(),
            stream: None,
            chunk: None,
            state: Some(state.into()),
            pid: None,
            exit_code,
            reason: Some(reason.into()),
            artifact: None,
        });
    }

    fn finish_without_process(
        &self,
        run_id: &str,
        state: &str,
        exit_code: Option<i32>,
        reason: &str,
    ) -> Result<(), String> {
        self.patch_run(run_id, |run| {
            run.state = state.into();
            run.exit_code = exit_code;
            run.ended_at = Some(now_ms());
            run.termination_reason = reason.into();
            run.updated_at = now_ms();
        })
    }

    fn insert_run(&self, run: NativeToolRun) -> Result<(), String> {
        let id = run.id.clone();
        {
            let mut ledger = self
                .inner
                .ledger
                .lock()
                .map_err(|_| "run_ledger_lock_failed")?;
            if ledger.runs.iter().any(|item| item.id == run.id) {
                return Err("duplicate_run_id".into());
            }
            ledger.runs.push(run);
        }
        // A row whose save failed is taken back out, so this session does not
        // list a run the ledger never recorded.
        self.inner.persist_ledger().inspect_err(|_| {
            if let Ok(mut ledger) = self.inner.ledger.lock() {
                ledger.runs.retain(|item| item.id != id);
            }
        })
    }

    fn replace_run(&self, run: NativeToolRun) -> Result<(), String> {
        {
            let mut ledger = self
                .inner
                .ledger
                .lock()
                .map_err(|_| "run_ledger_lock_failed")?;
            let target = ledger
                .runs
                .iter_mut()
                .find(|item| item.id == run.id)
                .ok_or_else(|| "run_not_found".to_string())?;
            *target = run;
        }
        self.inner.persist_ledger()
    }

    fn patch_run<F>(&self, run_id: &str, patch: F) -> Result<(), String>
    where
        F: FnOnce(&mut NativeToolRun),
    {
        {
            let mut ledger = self
                .inner
                .ledger
                .lock()
                .map_err(|_| "run_ledger_lock_failed")?;
            let run = ledger
                .runs
                .iter_mut()
                .find(|item| item.id == run_id)
                .ok_or_else(|| "run_not_found".to_string())?;
            patch(run);
        }
        self.inner.persist_ledger()
    }

    /// Both logs, hashed as they are on disk. A log that is not there is left
    /// out; one that is there but cannot be hashed is left out and logged.
    fn hash_outputs(&self, run_id: &str) -> Vec<RunOutput> {
        let Ok(dir) = self.safe_run_dir(run_id) else {
            return Vec::new();
        };
        ["stdout", "stderr"]
            .into_iter()
            .filter_map(|stream| {
                let name = format!("{stream}.log");
                match hash_file(&dir.join(&name)) {
                    Ok((sha256, bytes)) => Some(RunOutput {
                        rel_path: format!("runs/{run_id}/{name}"),
                        name,
                        sha256,
                        bytes,
                    }),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    Err(error) => {
                        eprintln!(
                            "[Qutra Labs] run {run_id}: {name} not hashed: {}",
                            error.kind()
                        );
                        None
                    }
                }
            })
            .collect()
    }

    /// The descriptor's parser reads the finished logs. The bool is true when
    /// the output was not read: a log could not be read (a missing one too,
    /// since both exist whenever capture worked), or the parser returned an
    /// `Err` or panicked. A log that cannot be read is never handed to the
    /// parser as empty text, which it could take for "nothing found".
    fn parse_logs(
        &self,
        run_id: &str,
        parse: Option<&ParseHook>,
        exit_code: Option<i32>,
    ) -> (Vec<Observation>, bool) {
        let Some(parse) = parse else {
            return (Vec::new(), false);
        };
        let Ok(dir) = self.safe_run_dir(run_id) else {
            return (Vec::new(), true);
        };
        let read = |name: &str| {
            fs::read(dir.join(name))
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .map_err(|error| {
                    eprintln!(
                        "[Qutra Labs] run {run_id}: {name} not read for its parser: {}",
                        error.kind()
                    );
                })
        };
        let (Ok(stdout), Ok(stderr)) = (read("stdout.log"), read("stderr.log")) else {
            return (Vec::new(), true);
        };
        let logs = RunLogs {
            stdout,
            stderr,
            exit_code,
        };
        match catch_unwind(AssertUnwindSafe(|| (parse.0)(&logs))) {
            Ok(Ok(facts)) => (
                facts
                    .into_iter()
                    .enumerate()
                    .map(|(n, fact)| Observation {
                        id: format!("{run_id}:{n}"),
                        key: fact.key.to_string(),
                        value: fact.value,
                        group: fact.group,
                        hint: fact.hint.map(str::to_string),
                        items: fact.items,
                    })
                    .collect(),
                false,
            ),
            Ok(Err(code)) => {
                eprintln!(
                    "[Qutra Labs] run {run_id}: its parser could not read the output: {code}"
                );
                (Vec::new(), true)
            }
            Err(_) => {
                eprintln!("[Qutra Labs] run {run_id}: its parser panicked");
                (Vec::new(), true)
            }
        }
    }

    fn safe_run_dir(&self, run_id: &str) -> Result<PathBuf, String> {
        validate_run_id(run_id)?;
        let root = self.inner.base_dir.join("lab").join("runs");
        let candidate = root.join(run_id);
        if !candidate.starts_with(&root) {
            return Err("artifact_path_escape".into());
        }
        Ok(candidate)
    }
}

/// The arguments a program is started with: bounded, and free of control
/// characters. Every route that takes arguments from the page checks them
/// here: batch runs, detached launches and terminal launches.
pub(crate) fn validate_arguments(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_ARG_COUNT {
        return Err("too_many_arguments".into());
    }
    let mut total = 0;
    for arg in args {
        if arg.len() > 8192 || arg.chars().any(char::is_control) {
            return Err("invalid_argument".into());
        }
        total += arg.len();
    }
    if total > MAX_ARG_BYTES {
        return Err("arguments_too_large".into());
    }
    Ok(())
}

fn validate_run_request(request: &StartToolRunRequest) -> Result<(), String> {
    validate_identifier(&request.profile_id, "invalid_profile_id")?;
    validate_identifier(&request.request_id, "invalid_request_id")?;
    validate_arguments(&request.argv)?;
    if let Some(engagement_id) = &request.engagement_id {
        validate_engagement_id(engagement_id)?;
    }
    if !matches!(request.concurrency_class.as_str(), "default" | "exclusive") {
        return Err("invalid_concurrency_class".into());
    }
    if request
        .origin
        .stdin
        .as_ref()
        .is_some_and(|input| input.len() > MAX_STDIN_BYTES)
    {
        return Err("input_too_large".into());
    }
    Ok(())
}

/// Writes a tool's input and closes the pipe, so the tool reads to its end.
/// The pipe closes when it drops at the end; std reports no error for that.
fn deliver_input(pipe: Option<ChildStdin>, input: &[u8]) -> io::Result<()> {
    let mut pipe = pipe.ok_or_else(|| io::Error::other("stdin_not_piped"))?;
    pipe.write_all(input)?;
    pipe.flush()
}

fn validate_identifier(value: &str, error: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        Err(error.into())
    } else {
        Ok(())
    }
}

fn validate_scope(request: &StartToolRunRequest, scope_required: bool) -> Result<(), String> {
    if !scope_required {
        return Ok(());
    }
    let scope = request
        .scope
        .as_ref()
        .ok_or_else(|| "authorization_scope_required".to_string())?;
    if !scope.allowed {
        return Err("authorization_scope_blocked".into());
    }
    validate_identifier(&scope.scope_id, "invalid_scope_id")?;
    if scope.scope_revision == 0
        || scope.target.trim().is_empty()
        || scope.target.chars().any(char::is_control)
        || !matches!(scope.reason.as_str(), "allowed_local" | "allowed_in_scope")
    {
        return Err("invalid_scope_decision".into());
    }
    if !request
        .argv
        .iter()
        .any(|argument| argument == &scope.target)
    {
        return Err("scope_target_argument_mismatch".into());
    }
    let current_time = now_ms();
    if scope.decided_at > current_time.saturating_add(30_000)
        || current_time.saturating_sub(scope.decided_at) > SCOPE_DECISION_MAX_AGE_MS
    {
        return Err("scope_decision_stale".into());
    }
    if scope
        .expires_at
        .is_some_and(|expires_at| expires_at < current_time)
    {
        return Err("authorization_scope_expired".into());
    }
    Ok(())
}

fn resolve_run_working_dir(
    installation: &ToolInstallationRecord,
    requested: &str,
) -> Result<PathBuf, String> {
    let registered =
        fs::canonicalize(&installation.working_dir).map_err(|_| "working_directory_missing")?;
    let selected = if requested.trim().is_empty() {
        registered.clone()
    } else {
        fs::canonicalize(requested).map_err(|_| "working_directory_missing")?
    };
    if !selected.is_dir() {
        return Err("working_directory_not_folder".into());
    }
    if selected != registered {
        return Err("working_directory_not_registered".into());
    }
    Ok(selected)
}

fn validate_environment(input: &[EnvironmentInput]) -> Result<Vec<(String, String)>, String> {
    if input.len() > MAX_ENV_COUNT {
        return Err("too_many_environment_values".into());
    }
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for item in input {
        let key = item.key.trim().to_ascii_uppercase();
        if !is_allowed_environment_key(&key)
            || item.value.len() > 8192
            || item.value.chars().any(char::is_control)
            || !seen.insert(key.clone())
        {
            return Err("environment_value_rejected".into());
        }
        output.push((key, item.value.clone()));
    }
    Ok(output)
}

/// What a request may add to a tool's environment. The system locations
/// (`PATH`, `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`,
/// `LOCALAPPDATA`, `HOME`) are Rust's alone: `add_baseline_environment` sets
/// them, and a request that could set them too could point a tool at a
/// program or a folder of its own choosing.
fn is_allowed_environment_key(key: &str) -> bool {
    matches!(
        key,
        // Set by a tool form (tool_forms.rs) to keep a tool offline or
        // its output in UTF-8; none of them points a tool anywhere.
        |"PYTHONIOENCODING"| "PYTHONUTF8"
            | "NO_COLOR"
            | "GRYPE_DB_AUTO_UPDATE"
            | "GRYPE_CHECK_FOR_APP_UPDATE"
            | "SYFT_CHECK_FOR_APP_UPDATE"
    ) || key.starts_with("CONTEXTOS_")
}

fn validate_redactions(
    requested: &[String],
    environment: &[EnvironmentInput],
) -> Result<Vec<String>, String> {
    if requested.len() > 64 {
        return Err("too_many_redactions".into());
    }
    let mut output = Vec::new();
    for value in requested.iter().chain(
        environment
            .iter()
            .filter(|item| item.sensitive)
            .map(|item| &item.value),
    ) {
        if value.len() < 3 || value.len() > 8192 || value.chars().any(char::is_control) {
            return Err("invalid_redaction".into());
        }
        if !output.contains(value) {
            output.push(value.clone());
        }
    }
    Ok(output)
}

/// Build the (unspawned) `Command` for a detached, unsupervised GUI launch:
/// the same working-directory and baseline-environment isolation the
/// supervised batch path applies in `start_run` — `current_dir` pinned to
/// the registry's working dir, `env_clear` plus the curated baseline, argv
/// only — plus null stdio on all three handles, since nothing reads a
/// detached process's streams. Returns an unspawned `Command` so callers
/// (and tests) can spawn it, or inspect its configuration, without this
/// function owning the process's lifetime.
pub fn build_detached_command(target: &LaunchTarget, args: &[String]) -> Command {
    let mut command = Command::new(&target.program);
    command
        .args(args)
        .current_dir(&target.working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear();
    add_baseline_environment(&mut command);
    command
}

fn add_baseline_environment(command: &mut Command) {
    for key in [
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "PATH",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn redact_tokens(values: &[String], redactions: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| redact_text(value, redactions))
        .collect()
}

fn redact_text(value: &str, redactions: &[String]) -> String {
    let mut output = value.to_string();
    for secret in redactions {
        output = output.replace(secret, "[REDACTED]");
    }
    output
}

fn quote_preview(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_-./:@+=,%".contains(c))
    {
        return value.into();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn command_preview(label: &str, argv: &[String], redactions: &[String]) -> String {
    std::iter::once(label.to_string())
        .chain(redact_tokens(argv, redactions))
        .map(|value| quote_preview(&value))
        .collect::<Vec<_>>()
        .join(" ")
}

fn safe_prefix_len(value: &str, limit: usize) -> usize {
    let mut end = limit.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn append_tail(target: &mut String, addition: &str) {
    target.push_str(addition);
    if target.len() > MAX_TAIL_BYTES {
        let split_at = target.len() - MAX_TAIL_BYTES;
        let safe_split = target
            .char_indices()
            .find(|(index, _)| *index >= split_at)
            .map(|(index, _)| index)
            .unwrap_or(split_at);
        target.drain(..safe_split);
    }
}

fn emit_state(
    events: &EventSink,
    run_id: &str,
    kind: &str,
    pid: Option<u32>,
    exit_code: Option<i32>,
    reason: Option<&str>,
) {
    (events)(ToolRunEvent {
        run_id: run_id.into(),
        kind: kind.into(),
        at: now_ms(),
        stream: None,
        chunk: None,
        state: Some(kind.into()),
        pid,
        exit_code,
        reason: reason.map(str::to_string),
        artifact: None,
    });
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.starts_with("run-")
        && run_id.len() <= 64
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        Ok(())
    } else {
        Err("invalid_run_id".into())
    }
}

fn io_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "file_not_found".into(),
        io::ErrorKind::PermissionDenied => "permission_denied".into(),
        _ => format!("io_error:{}", error.kind()),
    }
}

impl SupervisorInner {
    fn require_writable(&self) -> Result<(), String> {
        if self.writable {
            Ok(())
        } else {
            Err("run_ledger_read_only".into())
        }
    }

    fn persist_ledger(&self) -> Result<(), String> {
        self.require_writable()?;
        let _write_guard = self
            .persistence
            .lock()
            .map_err(|_| "run_ledger_persistence_lock_failed")?;
        self.keep_v1_backup()?;
        // A copy, so the file is written without holding the ledger's lock.
        let ledger = self
            .ledger
            .lock()
            .map_err(|_| "run_ledger_lock_failed")?
            .clone();
        write_ledger(&self.ledger_path, &ledger)
    }

    /// Before the first write over a version-1 ledger, keep its bytes as they
    /// were. No backup is ever written over or removed: an existing
    /// `tool-runs.v1.json` counts only when it holds exactly these bytes, and
    /// otherwise (a partial write, a backup from an earlier upgrade) it stays
    /// as it is and the bytes go to a new `tool-runs.v1-<ms>.json`. A backup
    /// that cannot be written stops the save: the upgrade is lossless or it
    /// does not happen. A partial file it leaves is compared, not trusted, by
    /// the next try.
    fn keep_v1_backup(&self) -> Result<(), String> {
        let mut pending = self
            .v1_backup
            .lock()
            .map_err(|_| "run_ledger_lock_failed")?;
        let Some(bytes) = pending.as_deref() else {
            return Ok(());
        };
        let backup = self.ledger_path.with_file_name(V1_BACKUP_FILE);
        let kept = match write_new_file(&backup, bytes) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if fs::read(&backup).is_ok_and(|existing| existing == bytes) {
                    Ok(())
                } else {
                    let fresh = self
                        .ledger_path
                        .with_file_name(format!("tool-runs.v1-{}.json", now_ms()));
                    write_new_file(&fresh, bytes)
                }
            }
            written => written,
        };
        if let Err(error) = kept {
            eprintln!(
                "[Qutra Labs] run ledger version 1 backup not written: {}",
                error.kind()
            );
            return Err("run_ledger_backup_failed".into());
        }
        *pending = None;
        Ok(())
    }
}

/// Only a ledger's version. A number too big for a `u32` still counts as
/// newer, so such a file is left alone rather than set aside.
#[derive(Deserialize)]
struct LedgerHeader {
    version: u64,
}

/// A ledger as it was found on disk.
struct Loaded {
    ledger: RunLedger,
    writable: bool,
    v1_bytes: Option<Vec<u8>>,
}

fn load_ledger(path: &Path) -> Loaded {
    let fresh = || Loaded {
        ledger: RunLedger::default(),
        writable: true,
        v1_bytes: None,
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return fresh(),
        Err(error) => {
            eprintln!("[Qutra Labs] run ledger unreadable: {error}");
            return Loaded {
                writable: false,
                ..fresh()
            };
        }
    };
    // The version is read on its own first: a newer ledger is never set aside
    // or written, even when this version cannot read its runs.
    if let Ok(LedgerHeader { version }) = serde_json::from_slice(&bytes) {
        if version > u64::from(LEDGER_VERSION) {
            eprintln!("[Qutra Labs] run ledger is from a newer version ({version}); read only");
            let ledger = serde_json::from_slice::<RunLedger>(&bytes).unwrap_or_else(|_| {
                eprintln!("[Qutra Labs] this version cannot read the newer run ledger's runs");
                RunLedger::default()
            });
            return Loaded {
                ledger,
                writable: false,
                v1_bytes: None,
            };
        }
    }
    match serde_json::from_slice::<RunLedger>(&bytes) {
        Ok(ledger) if ledger.version == LEDGER_VERSION => Loaded {
            ledger,
            writable: true,
            v1_bytes: None,
        },
        // Version 1 reads through the serde defaults of the new fields; its
        // bytes are kept until the first save (spec §4.3).
        Ok(mut ledger) if ledger.version == 1 => {
            ledger.version = LEDGER_VERSION;
            Loaded {
                ledger,
                writable: true,
                v1_bytes: Some(bytes),
            }
        }
        Ok(ledger) => {
            eprintln!(
                "[Qutra Labs] run ledger is from another version ({})",
                ledger.version
            );
            Loaded {
                ledger,
                writable: false,
                v1_bytes: None,
            }
        }
        Err(_) => {
            // Kept beside the ledger first; the empty ledger written next
            // stops the next start from setting it aside again.
            let kept = set_aside(path, &bytes);
            if kept {
                if let Err(error) = write_ledger(path, &RunLedger::default()) {
                    eprintln!("[Qutra Labs] run ledger not reset: {error}");
                }
            }
            Loaded {
                writable: kept,
                ..fresh()
            }
        }
    }
}

fn set_aside(path: &Path, bytes: &[u8]) -> bool {
    let aside = path.with_file_name(format!("tool-runs.unreadable-{}.json", now_ms()));
    match write_new_file(&aside, bytes) {
        Ok(()) => {
            eprintln!(
                "[Qutra Labs] run ledger unreadable; kept as {}",
                aside.display()
            );
            true
        }
        Err(error) => {
            eprintln!("[Qutra Labs] run ledger unreadable and not set aside: {error}");
            false
        }
    }
}

fn write_ledger(path: &Path, ledger: &RunLedger) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(ledger).map_err(|_| "run_ledger_serialize_failed".to_string())?;
    crate::durable_file::replace_file(path, &bytes).map_err(io_error)
}

/// The two logs, hashed as they are on disk.
fn hash_file(path: &Path) -> io::Result<(String, u64)> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((hex::encode(digest.finalize()), total))
}

#[cfg(windows)]
struct ProcessControl {
    job: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for ProcessControl {}
#[cfg(windows)]
unsafe impl Sync for ProcessControl {}

#[cfg(windows)]
impl ProcessControl {
    fn for_child(child: &std::process::Child) -> Result<Self, String> {
        use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle};
        use windows::Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|_| "job_object_create_failed")?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_err()
            {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                return Err("job_object_config_failed".into());
            }
            let process = HANDLE(child.as_raw_handle());
            if AssignProcessToJobObject(job, process).is_err() {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                return Err("job_object_assign_failed".into());
            }
            Ok(Self { job })
        }
    }

    fn terminate(&self) -> Result<(), String> {
        unsafe {
            windows::Win32::System::JobObjects::TerminateJobObject(self.job, 1)
                .map_err(|_| "process_tree_termination_failed".to_string())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessControl {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(not(windows))]
struct ProcessControl;

#[cfg(not(windows))]
impl ProcessControl {
    fn for_child(_child: &std::process::Child) -> Result<Self, String> {
        Err("unsupported_platform".into())
    }

    fn terminate(&self) -> Result<(), String> {
        Err("unsupported_platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Group;
    use std::{
        fs::OpenOptions,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::Instant,
    };

    fn copy_test_exe(dir: &Path, name: &str) -> PathBuf {
        let destination = dir.join(format!("{name}.exe"));
        fs::copy(std::env::current_exe().unwrap(), &destination).unwrap();
        destination
    }

    fn register_fixture(supervisor: &ToolSupervisor, executable: &Path) -> String {
        supervisor
            .register_tool(RegisterToolRequest {
                candidate_path: executable.to_string_lossy().to_string(),
                display_name: "Supervisor fixture".into(),
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

    fn request(installation_id: String, mode: &str) -> StartToolRunRequest {
        StartToolRunRequest {
            installation_id,
            profile_id: "profile-fixture".into(),
            request_id: format!("request-{mode}"),
            engagement_id: None,
            target_id: None,
            argv: vec![
                "--exact".into(),
                "tool_supervisor::tests::fixture_worker".into(),
                "--nocapture".into(),
            ],
            working_dir: String::new(),
            environment: vec![EnvironmentInput {
                key: "CONTEXTOS_FIXTURE_MODE".into(),
                value: mode.into(),
                sensitive: false,
            }],
            redactions: vec![],
            scope: None,
            requires_scope: false,
            timeout_sec: 10,
            output_limit_bytes: 64 * 1024,
            concurrency_class: "default".into(),
            origin: RunOrigin::default(),
        }
    }

    fn wait_terminal(supervisor: &ToolSupervisor, id: &str) -> NativeToolRun {
        let started = Instant::now();
        loop {
            let run = supervisor
                .list_runs()
                .unwrap()
                .into_iter()
                .find(|run| run.id == id)
                .unwrap();
            if matches!(
                run.state.as_str(),
                "succeeded" | "failed" | "cancelled" | "timed_out"
            ) {
                return run;
            }
            assert!(started.elapsed() < Duration::from_secs(15));
            thread::sleep(Duration::from_millis(40));
        }
    }

    #[test]
    fn fixture_worker() {
        match std::env::var("CONTEXTOS_FIXTURE_MODE").as_deref() {
            Ok("success") => {
                println!("fixture stdout");
                eprintln!("fixture stderr");
            }
            Ok("secret") => {
                println!("token=super-secret-value");
            }
            Ok("large") => {
                println!("{}", "x".repeat(96 * 1024));
            }
            Ok("sleep") => {
                thread::sleep(Duration::from_secs(30));
            }
            Ok("nonzero") => {
                eprintln!("fixture exit 7");
                std::process::exit(7);
            }
            Ok("spawn_child") => {
                // Intentionally leave the child running so cancellation tests
                // can verify process-tree cleanup without waiting here.
                #[allow(clippy::zombie_processes)]
                let child = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "tool_supervisor::tests::fixture_worker",
                        "--nocapture",
                    ])
                    .env("CONTEXTOS_FIXTURE_MODE", "child_sleep")
                    .spawn()
                    .unwrap();
                println!("child_pid={}", child.id());
                println!("child_spawned");
                thread::sleep(Duration::from_secs(30));
            }
            Ok("child_sleep") => {
                println!("child_ready");
                thread::sleep(Duration::from_secs(30));
            }
            Ok("report_env") => {
                println!("cwd={}", std::env::current_dir().unwrap().display());
                for (key, value) in std::env::vars() {
                    println!("env:{key}={value}");
                }
            }
            Ok("json_line") => {
                println!("{{\"answer\":42}}");
            }
            Ok("echo_stdin") => {
                let mut text = String::new();
                io::stdin().read_to_string(&mut text).unwrap();
                println!("stdin={}", text.trim());
            }
            _ => {}
        }
    }

    #[test]
    fn runs_with_distinct_arguments_and_captures_both_streams() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "success");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run(request(id, "success"), Arc::new(|_| {}))
            .unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(done.state, "succeeded");
        assert!(done.stdout_tail.contains("fixture stdout"));
        assert!(done.stderr_tail.contains("fixture stderr"));
        assert_eq!(done.argv[0], "--exact");
        assert!(!done.artifacts.is_empty());
    }

    #[test]
    fn a_save_that_fails_right_after_the_start_still_lets_the_run_finish() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "start-save");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        // Once the queued row is saved, the ledger's file becomes a folder,
        // so the save right after the process starts fails (and so does
        // every later one).
        let ledger = supervisor.inner.ledger_path.clone();
        let events: EventSink = Arc::new(move |event: ToolRunEvent| {
            if event.state.as_deref() == Some("queued") {
                fs::remove_file(&ledger).unwrap();
                fs::create_dir(&ledger).unwrap();
            }
        });
        let run = supervisor
            .start_run(request(id, "success"), events)
            .unwrap();
        assert_eq!(run.state, "running");
        // The threads that finish the run still started: it ends and leaves
        // its active slot instead of staying "running" for the session.
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(done.state, "succeeded");
        assert!(done.stdout_tail.contains("fixture stdout"));
        assert!(supervisor.inner.active.lock().unwrap().is_empty());
    }

    #[test]
    fn cancels_a_managed_process() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "cancel");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run(request(id, "sleep"), Arc::new(|_| {}))
            .unwrap();
        thread::sleep(Duration::from_millis(150));
        supervisor.cancel_run(&run.id).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(done.state, "cancelled");
    }

    #[test]
    fn redacts_secrets_and_bounds_output() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "redact");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut secret_request = request(id, "secret");
        secret_request.redactions = vec!["super-secret-value".into()];
        let run = supervisor
            .start_run(secret_request, Arc::new(|_| {}))
            .unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert!(!done.stdout_tail.contains("super-secret-value"));
        assert!(done.stdout_tail.contains("[REDACTED]"));

        let executable = copy_test_exe(temp.path(), "large");
        let id = register_fixture(&supervisor, &executable);
        let mut large_request = request(id, "large");
        large_request.output_limit_bytes = 4096;
        let run = supervisor
            .start_run(large_request, Arc::new(|_| {}))
            .unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert!(done.truncated);
        let stdout = done
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "stdout")
            .unwrap();
        assert!(stdout.size_bytes <= 4096);
    }

    #[test]
    fn a_run_is_filed_under_a_well_formed_engagement_id_or_none() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "eng-id");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        for bad in ["", "../x", "a b", "eng\\1", &"e".repeat(65)] {
            let mut run = request(id.clone(), "success");
            run.engagement_id = Some(bad.to_string());
            let refused = supervisor.start_run(run, Arc::new(|_| {})).unwrap_err();
            assert_eq!(refused, "invalid_engagement_id", "{bad}");
        }
    }

    #[test]
    fn arguments_are_bounded_on_every_route() {
        assert!(validate_arguments(&["-sV".into(), "10.0.0.5".into()]).is_ok());
        assert_eq!(
            validate_arguments(&["a\nb".into()]),
            Err("invalid_argument".to_string())
        );
        assert_eq!(
            validate_arguments(&["x".repeat(8193)]),
            Err("invalid_argument".to_string())
        );
        let many: Vec<String> = (0..=MAX_ARG_COUNT).map(|n| n.to_string()).collect();
        assert_eq!(
            validate_arguments(&many),
            Err("too_many_arguments".to_string())
        );
    }

    #[test]
    fn rejects_disallowed_environment_and_stale_scope() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "reject");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        // Neither an unknown variable nor one of the system locations Rust
        // sets itself may come from a request.
        for key in [
            "LD_PRELOAD",
            "PATH",
            "path",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            let mut bad_env = request(id.clone(), "success");
            bad_env.environment = vec![EnvironmentInput {
                key: key.into(),
                value: "x".into(),
                sensitive: false,
            }];
            let blocked = supervisor.start_run(bad_env, Arc::new(|_| {})).unwrap();
            assert_eq!(blocked.state, "blocked", "{key}");
            assert_eq!(
                blocked.blocked_reason, "environment_value_rejected",
                "{key}"
            );
        }

        let mut stale = request(id, "success");
        stale.requires_scope = true;
        stale.argv.push("127.0.0.1".into());
        stale.scope = Some(ScopeAttestation {
            scope_id: "scope-1".into(),
            scope_revision: 1,
            target: "127.0.0.1".into(),
            allowed: true,
            reason: "allowed_local".into(),
            decided_at: now_ms().saturating_sub(SCOPE_DECISION_MAX_AGE_MS + 1),
            expires_at: None,
        });
        let blocked = supervisor.start_run(stale, Arc::new(|_| {})).unwrap();
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.blocked_reason, "scope_decision_stale");
    }

    #[test]
    fn scope_target_must_be_present_as_a_distinct_argument() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "scope-mismatch");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut run = request(id, "success");
        run.requires_scope = true;
        run.scope = Some(ScopeAttestation {
            scope_id: "scope-1".into(),
            scope_revision: 2,
            target: "127.0.0.1".into(),
            allowed: true,
            reason: "allowed_local".into(),
            decided_at: now_ms(),
            expires_at: None,
        });
        let blocked = supervisor.start_run(run, Arc::new(|_| {})).unwrap();
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.blocked_reason, "scope_target_argument_mismatch");
    }

    #[test]
    fn persists_scope_target_and_effective_working_directory() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "scope-persist");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut request = request(id, "success");
        request.requires_scope = true;
        request.target_id = Some("target-1".into());
        request.argv.push("127.0.0.1".into());
        request.scope = Some(ScopeAttestation {
            scope_id: "scope-1".into(),
            scope_revision: 3,
            target: "127.0.0.1".into(),
            allowed: true,
            reason: "allowed_local".into(),
            decided_at: now_ms(),
            expires_at: None,
        });

        let run = supervisor.start_run(request, Arc::new(|_| {})).unwrap();

        assert_eq!(run.target_id.as_deref(), Some("target-1"));
        assert_eq!(run.target.as_deref(), Some("127.0.0.1"));
        assert!(!run.working_dir.is_empty());
        let _ = wait_terminal(&supervisor, &run.id);
    }

    #[test]
    fn reconciles_interrupted_runs_as_orphaned() {
        let temp = tempfile::tempdir().unwrap();
        let ledger_path = temp.path().join("lab").join("tool-runs.json");
        fs::create_dir_all(ledger_path.parent().unwrap()).unwrap();
        let mut run = NativeToolRun {
            id: format!("run-{}", Uuid::new_v4()),
            request_id: "request-1".into(),
            profile_id: "profile-1".into(),
            installation_id: "tool-1".into(),
            engagement_id: None,
            scope_id: None,
            scope_revision: None,
            target_id: None,
            target: None,
            state: "running".into(),
            argv: vec![],
            command_preview: String::new(),
            pid: Some(123),
            started_at: Some(1),
            ended_at: None,
            exit_code: None,
            termination_reason: String::new(),
            working_dir: String::new(),
            artifact_dir: String::new(),
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            bytes_out: 0,
            bytes_err: 0,
            truncated: false,
            blocked_reason: String::new(),
            artifacts: vec![],
            kind: "external".into(),
            trigger: Trigger::legacy(),
            subject: None,
            descriptor_id: None,
            outputs: vec![],
            observations: vec![],
            created_at: 1,
            updated_at: 1,
        };
        let ledger = RunLedger {
            version: LEDGER_VERSION,
            runs: vec![run.clone()],
        };
        fs::write(&ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        run = supervisor.list_runs().unwrap().remove(0);
        assert_eq!(run.state, "orphaned");
        assert_eq!(run.termination_reason, "app_restarted");
    }

    #[test]
    fn changed_identity_is_blocked_before_spawn() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "changed");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        let blocked = supervisor
            .start_run(request(id, "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.blocked_reason, "tool_identity_changed");
    }

    #[test]
    fn resolve_launchable_gates_missing_disabled_and_changed_installations() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "launchable");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);

        // Enabled + unchanged: resolves to the identity-verified canonical
        // path and the registered working directory (used by both the
        // detached GUI route and the interactive terminal route — neither
        // ever takes a renderer-supplied path).
        let resolved = supervisor.resolve_launchable(&id).unwrap();
        assert_eq!(resolved.program, fs::canonicalize(&executable).unwrap());
        assert_eq!(
            resolved.working_dir,
            fs::canonicalize(executable.parent().unwrap()).unwrap()
        );

        // Unknown installation id.
        assert_eq!(
            supervisor
                .resolve_launchable("tool-does-not-exist")
                .unwrap_err(),
            "tool_not_found"
        );

        // Disabled installation.
        supervisor.set_tool_enabled(&id, false).unwrap();
        assert_eq!(
            supervisor.resolve_launchable(&id).unwrap_err(),
            "tool_disabled"
        );
        supervisor.set_tool_enabled(&id, true).unwrap();

        // Identity changed since verification.
        OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        supervisor.reverify_tool(&id, false).unwrap();
        assert_eq!(
            supervisor.resolve_launchable(&id).unwrap_err(),
            "tool_identity_changed"
        );
    }

    #[test]
    fn resolve_launch_display_name_returns_the_name_on_success_and_the_same_codes_on_failure() {
        // Same gate, same codes as `resolve_launchable` — this test mirrors
        // `resolve_launchable_gates_missing_disabled_and_changed_installations`
        // field-for-field, proving the two methods agree rather than
        // drifting apart into two lookup paths with different opinions.
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "display-name");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);

        assert_eq!(
            supervisor.resolve_launch_display_name(&id).unwrap(),
            "Supervisor fixture"
        );

        assert_eq!(
            supervisor
                .resolve_launch_display_name("tool-does-not-exist")
                .unwrap_err(),
            "tool_not_found"
        );

        supervisor.set_tool_enabled(&id, false).unwrap();
        assert_eq!(
            supervisor.resolve_launch_display_name(&id).unwrap_err(),
            "tool_disabled"
        );
        supervisor.set_tool_enabled(&id, true).unwrap();

        OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        supervisor.reverify_tool(&id, false).unwrap();
        assert_eq!(
            supervisor.resolve_launch_display_name(&id).unwrap_err(),
            "tool_identity_changed"
        );
    }

    #[test]
    fn resolve_launchable_detects_drift_without_reverify() {
        // Same gate the batch Run button uses (`resolve_for_run`) re-hashes
        // the binary on disk on every call, not just when `reverify` was
        // explicitly invoked. This covers a case that is easy to miss: an
        // executable overwritten after registration but before `reverify`
        // is ever called must still be blocked at launch.
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "drift");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);

        // Enabled + unchanged: resolves normally before any mutation.
        supervisor.resolve_launchable(&id).unwrap();

        // Mutate the binary on disk directly, without ever calling reverify.
        OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"drifted")
            .unwrap();

        assert_eq!(
            supervisor.resolve_launchable(&id).unwrap_err(),
            "tool_identity_changed"
        );

        // The live re-hash also persisted the drift to the stored record,
        // so a subsequent resolve keeps refusing without needing another
        // mutation (mirrors resolve_for_run's persist-on-drift behavior).
        assert_eq!(
            supervisor.resolve_launchable(&id).unwrap_err(),
            "tool_identity_changed"
        );
    }

    #[test]
    fn detached_command_pins_working_dir_to_the_registered_directory() {
        // The batch path's own working-dir gate (`resolve_run_working_dir`)
        // is reused, not duplicated: `build_detached_command` sets
        // `current_dir` to exactly what `resolve_launchable` resolved.
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "detached-cwd");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let target = supervisor.resolve_launchable(&id).unwrap();

        let command = build_detached_command(&target, &["--flag".into()]);

        assert_eq!(
            command.get_current_dir(),
            Some(target.working_dir.as_path())
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("--flag")]
        );
    }

    #[test]
    fn detached_command_isolates_environment_from_the_parent_process() {
        // A GUI tool spawned detached must not receive the whole parent
        // environment (a bare `Command::new(&exe).spawn()`
        // inherits everything). `build_detached_command` calls
        // `env_clear()` plus the same curated baseline `start_run` uses.
        // Production code leaves stdio null (nothing reads a detached
        // process's streams) — this test overrides stdout to piped only to
        // observe what the child actually received, proving the isolation
        // rather than just asserting it was configured.
        //
        // This used to introduce its canary via the process-global
        // `std::env::set_var`/`remove_var` -- shared, unsynchronized state
        // across a multi-threaded test runner (a latent flake) and `unsafe`
        // as of newer Rust editions. Instead, the canary is only ever set
        // via `Command::env(...)` on a plain, non-cleared "control" command
        // (scoped to that one child, never touching this process's real
        // environment), which also proves the detection mechanism actually
        // works. The isolated command is then checked against a strict
        // allow-list rather than a single canary's absence: a regression
        // that dropped `env_clear()` would reintroduce dozens of this test
        // process's real ambient variables (PATH, USERNAME, RUSTUP_HOME,
        // CARGO, ...), and the allow-list check catches any of them, not
        // just one purpose-built name.
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "detached-env");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let target = supervisor.resolve_launchable(&id).unwrap();
        let fixture_args = [
            "--exact".to_string(),
            "tool_supervisor::tests::fixture_worker".to_string(),
            "--nocapture".to_string(),
        ];

        // Control: a plain, non-cleared command for the same fixture binary,
        // explicitly given a marker via `.env(...)`. This proves the
        // fixture-plus-assertion technique below would actually catch a
        // leaked variable if isolation were broken.
        let mut control = Command::new(&executable);
        control
            .args(&fixture_args)
            .env("CONTEXTOS_FIXTURE_MODE", "report_env")
            .env("CONTEXTOS_TEST_CANARY", "should-not-leak")
            .stdout(Stdio::piped());
        let control_output = control.output().unwrap();
        let control_stdout = String::from_utf8_lossy(&control_output.stdout);
        assert!(
            control_stdout.contains("env:CONTEXTOS_TEST_CANARY=should-not-leak"),
            "control command (not isolated) should report the marker it was explicitly given: {control_stdout}"
        );

        let mut command = build_detached_command(&target, &fixture_args);
        command.env("CONTEXTOS_FIXTURE_MODE", "report_env");
        command.stdout(Stdio::piped());
        let output = command.output().unwrap();

        let stdout = String::from_utf8_lossy(&output.stdout);
        // `target.working_dir` came from `fs::canonicalize`, which on
        // Windows returns the `\\?\`-prefixed verbatim form; the child's own
        // `env::current_dir()` reports the same directory without that
        // prefix (a Windows string-form quirk, not a path mismatch), so
        // strip it before comparing.
        let expected_cwd = target.working_dir.to_string_lossy();
        let expected_cwd = expected_cwd.strip_prefix(r"\\?\").unwrap_or(&expected_cwd);
        assert!(
            stdout.contains(&format!("cwd={expected_cwd}")),
            "child did not report the expected cwd: {stdout}"
        );

        let allowed_keys: HashSet<&str> = [
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "PATH",
            "CONTEXTOS_FIXTURE_MODE",
        ]
        .into_iter()
        .collect();
        for line in stdout.lines() {
            if let Some(rest) = line.strip_prefix("env:") {
                let key = rest.split('=').next().unwrap_or(rest);
                assert!(
                    allowed_keys.contains(key),
                    "unexpected env var reached the isolated child: {key} (full output: {stdout})"
                );
            }
        }
        // A baseline key that is virtually always present on Windows CI/dev
        // machines confirms the allow-listed baseline still made it through
        // `env_clear()`, i.e. isolation didn't also strip what's needed.
        if std::env::var_os("SYSTEMROOT").is_some() {
            assert!(
                stdout.contains("env:SYSTEMROOT="),
                "baseline env var missing from detached child: {stdout}"
            );
        }
    }

    #[test]
    fn emits_typed_lifecycle_events() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "events");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let (tx, rx) = mpsc::channel();
        let run = supervisor
            .start_run(
                request(id, "success"),
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();
        let _ = wait_terminal(&supervisor, &run.id);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut kinds = Vec::new();
        while Instant::now() < deadline && !kinds.iter().any(|kind| kind == "finished") {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(100)) {
                kinds.push(event.kind);
            }
        }
        assert!(kinds.contains(&"queued".into()));
        assert!(kinds.contains(&"started".into()));
        assert!(kinds.contains(&"stdout".into()));
        assert!(kinds.contains(&"stderr".into()));
        assert!(kinds.contains(&"finished".into()));
    }

    #[test]
    fn times_out_and_reports_non_zero_exit() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "terminal-states");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);

        let mut timeout_request = request(id.clone(), "sleep");
        timeout_request.timeout_sec = 1;
        let run = supervisor
            .start_run(timeout_request, Arc::new(|_| {}))
            .unwrap();
        let timed_out = wait_terminal(&supervisor, &run.id);
        assert_eq!(timed_out.state, "timed_out");
        assert_eq!(timed_out.termination_reason, "timeout");

        let run = supervisor
            .start_run(request(id, "nonzero"), Arc::new(|_| {}))
            .unwrap();
        let failed = wait_terminal(&supervisor, &run.id);
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.exit_code, Some(7));
        assert_eq!(failed.termination_reason, "non_zero_exit");
    }

    #[test]
    fn enforces_concurrency_and_emergency_stops_every_active_run() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "concurrency");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut active_ids = Vec::new();

        for index in 0..MAX_ACTIVE_RUNS {
            let mut run_request = request(id.clone(), "sleep");
            run_request.request_id = format!("request-concurrency-{index}");
            // Every start re-hashes this large test binary. Under a loaded
            // gate the four starts took longer than the default 10 s, and the
            // first sleeper timed out before the fourth was judged. Emergency
            // stop ends them below, so a long timeout costs nothing.
            run_request.timeout_sec = 300;
            let run = supervisor.start_run(run_request, Arc::new(|_| {})).unwrap();
            active_ids.push(run.id);
        }
        let mut blocked_request = request(id, "sleep");
        blocked_request.request_id = "request-concurrency-blocked".into();
        let blocked = supervisor
            .start_run(blocked_request, Arc::new(|_| {}))
            .unwrap();
        // If a sleeper has left the active set, this start runs instead of
        // being blocked; name each sleeper's state so a failure says why.
        let sleepers: Vec<String> = supervisor
            .list_runs()
            .unwrap()
            .into_iter()
            .filter(|run| active_ids.contains(&run.id))
            .map(|run| {
                format!(
                    "{} exit={:?} reason={} stderr={:?}",
                    run.state,
                    run.exit_code,
                    run.termination_reason,
                    run.stderr_tail.chars().take(200).collect::<String>()
                )
            })
            .collect();
        assert_eq!(blocked.state, "blocked", "sleepers: {sleepers:?}");
        assert_eq!(blocked.blocked_reason, "concurrency_limit_reached");

        assert_eq!(supervisor.emergency_stop().unwrap(), MAX_ACTIVE_RUNS);
        for run_id in active_ids {
            let done = wait_terminal(&supervisor, &run_id);
            assert_eq!(done.state, "cancelled");
            assert_eq!(done.termination_reason, "emergency_stop");
        }
        assert!(supervisor.list_active_runs().unwrap().is_empty());
    }

    // Withdrawing Private Lab used to deny new work only; a run
    // that had already passed the consent check kept going.
    #[test]
    fn withdrawing_private_lab_stops_the_runs_it_allowed() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "withdraw");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut sleeper = request(id, "sleep");
        sleeper.timeout_sec = 300;
        let run = supervisor.start_run(sleeper, Arc::new(|_| {})).unwrap();

        let consent = crate::consent::PrivateToolsConsent::load(temp.path());
        consent.grant(consent.generation()).unwrap();
        crate::withdraw_private_tools(
            &consent,
            &crate::assistant::dispatch::DispatchGate::new(),
            &crate::assistant::AssistantState::default(),
            &supervisor,
            &crate::terminal::TerminalSessions::default(),
        )
        .unwrap();

        assert!(!consent.is_granted());
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(done.state, "cancelled");
        assert_eq!(done.termination_reason, "consent_revoked");
        assert!(supervisor.list_active_runs().unwrap().is_empty());
    }

    // A start that passed the command's consent check just before a revoke
    // asks again under the lock the revoke sweep takes, and is refused.
    #[test]
    fn a_start_that_meets_a_revoke_under_the_lock_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "late-start");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run_while(request(id, "sleep"), Arc::new(|_| {}), || false)
            .unwrap();
        assert_eq!(run.state, "blocked");
        assert_eq!(run.blocked_reason, "consent_revoked");
        assert!(supervisor.list_active_runs().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_terminates_the_fixture_process_tree() {
        fn process_is_running(pid: u32) -> bool {
            use windows::Win32::{
                Foundation::{CloseHandle, WAIT_TIMEOUT},
                System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
            };
            unsafe {
                let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
                    return false;
                };
                let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
                let _ = CloseHandle(handle);
                running
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "process-tree");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run(request(id, "spawn_child"), Arc::new(|_| {}))
            .unwrap();

        let started = Instant::now();
        let child_pid = loop {
            let current = supervisor
                .list_runs()
                .unwrap()
                .into_iter()
                .find(|item| item.id == run.id)
                .unwrap();
            if current.stdout_tail.contains("child_rea") {
                if let Some(pid) = current
                    .stdout_tail
                    .lines()
                    .find_map(|line| line.strip_prefix("child_pid="))
                    .and_then(|value| value.parse::<u32>().ok())
                {
                    break pid;
                }
            }
            assert!(started.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(40));
        };
        supervisor.cancel_run(&run.id).unwrap();
        let _ = wait_terminal(&supervisor, &run.id);
        thread::sleep(Duration::from_millis(100));
        assert!(!process_is_running(child_pid));
    }

    #[test]
    fn rejects_artifact_traversal_forged_ids_and_caller_paths() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        assert_eq!(
            supervisor.safe_run_dir("../escape").unwrap_err(),
            "invalid_run_id"
        );

        let forged = supervisor
            .start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(forged.state, "blocked");
        assert_eq!(forged.blocked_reason, "tool_not_registered");

        let mut value = serde_json::to_value(request("tool-forged".into(), "success")).unwrap();
        value.as_object_mut().unwrap().insert(
            "executablePath".into(),
            serde_json::Value::String(r"C:\unregistered.exe".into()),
        );
        assert!(serde_json::from_value::<StartToolRunRequest>(value).is_err());
    }

    #[test]
    fn redacts_secrets_across_chunks_and_slices_utf8_safely() {
        let mut redactor = StreamRedactor::new(vec!["super-secret".into()]);
        let mut output = String::new();
        if let Some(value) = redactor.push(b"before super-", false) {
            output.push_str(&value);
        }
        if let Some(value) = redactor.push(b"secret after", false) {
            output.push_str(&value);
        }
        if let Some(value) = redactor.push(&[], true) {
            output.push_str(&value);
        }
        assert_eq!(output, "before [REDACTED] after");
        assert!(!output.contains("super-secret"));

        let unicode = "abc\u{20ac}def";
        assert_eq!(&unicode[..safe_prefix_len(unicode, 5)], "abc");
        assert_eq!(safe_prefix_len(unicode, usize::MAX), unicode.len());
    }

    #[test]
    fn explicitly_deletes_artifacts_without_deleting_run_history() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "artifact-retention");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run(request(id, "success"), Arc::new(|_| {}))
            .unwrap();
        let completed = wait_terminal(&supervisor, &run.id);
        assert!(!completed.artifacts.is_empty());
        for artifact in &completed.artifacts {
            assert!(Path::new(&artifact.path).is_file());
        }

        let retained = supervisor.delete_run_artifacts(&run.id).unwrap();
        assert_eq!(retained.state, "succeeded");
        assert!(retained.artifacts.is_empty());
        assert!(retained.artifact_dir.is_empty());
        assert!(retained.stdout_tail.contains("fixture stdout"));
        assert_eq!(
            supervisor
                .list_runs()
                .unwrap()
                .into_iter()
                .filter(|item| item.id == run.id)
                .count(),
            1
        );
    }

    const V1_LEDGER: &str = r#"{
  "version": 1,
  "runs": [{
    "id": "run-11111111-1111-4111-8111-111111111111",
    "requestId": "request-1",
    "profileId": "profile-1",
    "installationId": "tool-1",
    "engagementId": "eng_1",
    "scopeId": null,
    "scopeRevision": null,
    "targetId": null,
    "target": null,
    "state": "succeeded",
    "argv": ["-sV", "10.0.0.1"],
    "commandPreview": "Nmap -sV 10.0.0.1",
    "pid": 4242,
    "startedAt": 100,
    "endedAt": 200,
    "exitCode": 0,
    "terminationReason": "completed",
    "workingDir": "C:\\Tools",
    "artifactDir": "C:\\Tools\\runs\\run-1",
    "stdoutTail": "done",
    "stderrTail": "",
    "bytesOut": 4,
    "bytesErr": 0,
    "truncated": false,
    "blockedReason": "",
    "artifacts": [{"kind": "stdout", "path": "C:\\Tools\\runs\\run-1\\stdout.log", "sizeBytes": 4, "truncated": false}],
    "createdAt": 90,
    "updatedAt": 200
  }]
}"#;
    const V1_RUN_ID: &str = "run-11111111-1111-4111-8111-111111111111";

    fn write_ledger_file(temp: &Path, text: &str) -> PathBuf {
        let lab = temp.join("lab");
        fs::create_dir_all(&lab).unwrap();
        fs::write(lab.join("tool-runs.json"), text).unwrap();
        lab
    }

    /// The entries of `lab` whose names start with `prefix`, sorted.
    fn files_named_like(lab: &Path, prefix: &str) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = fs::read_dir(lab)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
            .map(|entry| entry.path())
            .collect();
        found.sort();
        found
    }

    fn run_ids(supervisor: &ToolSupervisor) -> Vec<String> {
        supervisor
            .list_runs()
            .unwrap()
            .into_iter()
            .map(|run| run.id)
            .collect()
    }

    /// Windows answers `create_new` on a folder's name with "access denied",
    /// not "already exists", so a folder where the version-1 backup goes
    /// makes the backup fail while the ledger stays in place.
    #[cfg(windows)]
    fn block_the_v1_backup(lab: &Path) {
        fs::create_dir(lab.join(V1_BACKUP_FILE)).unwrap();
    }

    #[test]
    fn a_version_1_ledger_loads_unchanged_and_is_backed_up_when_first_saved() {
        let temp = tempfile::tempdir().unwrap();
        let lab = write_ledger_file(temp.path(), V1_LEDGER);

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let runs = supervisor.list_runs().unwrap();
        assert_eq!(runs.len(), 1);
        let old = &runs[0];
        assert_eq!(
            (old.kind.as_str(), old.trigger.by.as_str()),
            ("external", "legacy")
        );
        assert_eq!(old.argv, vec!["-sV".to_string(), "10.0.0.1".to_string()]);
        assert!(old.outputs.is_empty() && old.subject.is_none());
        // Reading changed nothing on disk.
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.json")).unwrap(),
            V1_LEDGER
        );

        // The first save keeps the old file as it was, then writes version 2.
        let blocked = supervisor
            .start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(blocked.state, "blocked");
        assert_eq!(blocked.trigger.by, "user");
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.v1.json")).unwrap(),
            V1_LEDGER
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(lab.join("tool-runs.json")).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        let kept = saved["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["id"] == V1_RUN_ID)
            .unwrap();
        assert_eq!(kept["argv"], serde_json::json!(["-sV", "10.0.0.1"]));
        assert_eq!(kept["artifacts"][0]["sizeBytes"], 4);
        assert_eq!(kept["trigger"]["by"], "legacy");
        // Every key of the version-1 row (all 28 fields a version-1 run has)
        // is in the saved row, with the same value.
        let original: serde_json::Value = serde_json::from_str(V1_LEDGER).unwrap();
        let v1_row = original["runs"][0].as_object().unwrap();
        assert_eq!(v1_row.len(), 28);
        for (key, value) in v1_row {
            assert_eq!(kept.get(key), Some(value), "`{key}` changed in the upgrade");
        }
    }

    #[test]
    fn an_unreadable_ledger_is_set_aside_and_start_up_goes_on() {
        let temp = tempfile::tempdir().unwrap();
        let lab = write_ledger_file(temp.path(), "{not json");

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        assert!(supervisor.list_runs().unwrap().is_empty());
        let aside: Vec<_> = fs::read_dir(&lab)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("tool-runs.unreadable-")
            })
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read(aside[0].path()).unwrap(), b"{not json");
        let fresh: serde_json::Value =
            serde_json::from_slice(&fs::read(lab.join("tool-runs.json")).unwrap()).unwrap();
        assert_eq!(fresh["version"], 2);
        // Runs are recorded again.
        let blocked = supervisor
            .start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(supervisor.list_runs().unwrap()[0].id, blocked.id);
    }

    #[test]
    fn a_newer_ledger_is_read_but_never_written() {
        let temp = tempfile::tempdir().unwrap();
        let text = V1_LEDGER.replace(r#""version": 1"#, r#""version": 3"#);
        assert_ne!(text, V1_LEDGER);
        let lab = write_ledger_file(temp.path(), &text);
        let executable = copy_test_exe(temp.path(), "newer");
        // A log of the run it holds, which a refused delete must leave alone.
        let kept_logs = lab.join("runs").join(V1_RUN_ID);
        fs::create_dir_all(&kept_logs).unwrap();
        fs::write(kept_logs.join("stdout.log"), "done").unwrap();

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        // Read: the run it holds is listed.
        let listed = supervisor.list_runs().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, V1_RUN_ID);
        assert_eq!(listed[0].command_preview, "Nmap -sV 10.0.0.1");
        let before = serde_json::to_value(&listed).unwrap();

        // Never written. A start is refused before it makes a row or a folder,
        let id = register_fixture(&supervisor, &executable);
        let refused = supervisor.start_run(request(id, "success"), Arc::new(|_| {}));
        assert_eq!(refused.unwrap_err(), "run_ledger_read_only");
        // a blocked attempt is not recorded,
        let blocked = supervisor.record_blocked_attempt(
            &request("tool-forged".into(), "success"),
            None,
            "tool_not_registered",
            Arc::new(|_| {}),
        );
        assert_eq!(blocked.unwrap_err(), "run_ledger_read_only");
        // and a delete is refused before it removes a log it cannot record as
        // removed.
        assert_eq!(
            supervisor.delete_run_artifacts(V1_RUN_ID).unwrap_err(),
            "run_ledger_read_only"
        );
        assert_eq!(
            serde_json::to_value(supervisor.list_runs().unwrap()).unwrap(),
            before
        );
        let folders: Vec<String> = fs::read_dir(lab.join("runs"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(folders, vec![V1_RUN_ID.to_string()]);
        assert!(kept_logs.join("stdout.log").is_file());
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.json")).unwrap(),
            text
        );
    }

    #[test]
    fn a_finished_run_keeps_both_logs_hashed() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "hashed");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run(request(id, "success"), Arc::new(|_| {}))
            .unwrap();
        let done = wait_terminal(&supervisor, &run.id);

        let names: Vec<&str> = done.outputs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["stdout.log", "stderr.log"]);
        let run_dir = temp.path().join("lab").join("runs").join(&done.id);
        for output in &done.outputs {
            let on_disk = fs::read(run_dir.join(&output.name)).unwrap();
            // The fixture writes to both streams, so neither hash is of nothing.
            assert!(!on_disk.is_empty(), "{}", output.name);
            assert_eq!(
                output.sha256,
                hex::encode(Sha256::digest(&on_disk)),
                "{}",
                output.name
            );
            assert_eq!(output.bytes, on_disk.len() as u64, "{}", output.name);
            assert_eq!(output.rel_path, format!("runs/{}/{}", done.id, output.name));
        }
        assert_eq!(
            (done.kind.as_str(), done.trigger.by.as_str()),
            ("external", "user")
        );
    }

    #[test]
    fn a_runs_log_is_read_back_only_for_that_run_and_survives_as_a_hash() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "readlog");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut asked = request(id, "json_line");
        asked.engagement_id = Some("eng_1".into());
        asked.origin.descriptor_id = Some("exiftool".into());
        let run = supervisor.start_run(asked, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);

        assert!(supervisor
            .read_run_log(&done.id, "stdout.log")
            .unwrap()
            .contains("{\"answer\":42}"));
        assert_eq!(supervisor.get_run(&done.id).unwrap().id, done.id);
        assert_eq!(supervisor.described_runs("eng_1").unwrap().len(), 1);
        assert!(supervisor.described_runs("eng_2").unwrap().is_empty());
        assert!(supervisor.described_runs("../x").is_err());
        assert_eq!(
            supervisor.read_run_log(&done.id, "..\\x").err(),
            Some("invalid_output_name".into())
        );
        assert_eq!(
            supervisor
                .read_run_log("run-00000000-0000-4000-8000-000000000000", "stdout.log")
                .err(),
            Some("unknown_run".into())
        );

        // Deleting the logs keeps the record of what was hashed.
        supervisor.delete_run_artifacts(&done.id).unwrap();
        assert_eq!(
            supervisor.read_run_log(&done.id, "stdout.log").err(),
            Some("output_missing".into())
        );
        assert_eq!(supervisor.get_run(&done.id).unwrap().outputs.len(), 2);
    }

    // Review fix: the text handed out is the text the ledger hashed, which the
    // comment on `read_run_log` promised and the code did not check.
    #[test]
    fn a_log_that_changed_on_disk_is_not_handed_out() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "changedlog");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let run = supervisor
            .start_run(request(id, "json_line"), Arc::new(|_| {}))
            .unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        let run_dir = temp.path().join("lab").join("runs").join(&done.id);
        let stdout = run_dir.join("stdout.log");

        // Untouched, it reads, and it is what the ledger hashed.
        let kept = supervisor.read_run_log(&done.id, "stdout.log").unwrap();
        assert_eq!(done.outputs[0].name, "stdout.log");
        assert_eq!(
            hex::encode(Sha256::digest(kept.as_bytes())),
            done.outputs[0].sha256
        );

        // The same size with one byte other: no longer what was hashed.
        let mut other = kept.clone().into_bytes();
        other[0] ^= 0x01;
        fs::write(&stdout, &other).unwrap();
        assert_eq!(
            supervisor.read_run_log(&done.id, "stdout.log").err(),
            Some("output_changed".into())
        );
        // Longer, and emptied.
        fs::write(&stdout, format!("{kept}more")).unwrap();
        assert_eq!(
            supervisor.read_run_log(&done.id, "stdout.log").err(),
            Some("output_changed".into())
        );
        fs::write(&stdout, b"").unwrap();
        assert_eq!(
            supervisor.read_run_log(&done.id, "stdout.log").err(),
            Some("output_changed".into())
        );
        // The other log was not touched and still reads (it is empty).
        assert_eq!(supervisor.read_run_log(&done.id, "stderr.log").unwrap(), "");

        // Put back as it was, it reads again; a log that is gone is gone.
        fs::write(&stdout, kept.as_bytes()).unwrap();
        assert_eq!(
            supervisor.read_run_log(&done.id, "stdout.log").unwrap(),
            kept
        );
        fs::remove_file(&stdout).unwrap();
        assert_eq!(
            supervisor.read_run_log(&done.id, "stdout.log").err(),
            Some("output_missing".into())
        );
    }

    // Review fix: one row is found under the ledger's lock, and
    // `delete_run_artifacts` finds its row the same way.
    #[test]
    fn a_run_is_found_by_its_id_alone() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "getrun");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let first = supervisor
            .start_run(request(id.clone(), "success"), Arc::new(|_| {}))
            .unwrap();
        let first = wait_terminal(&supervisor, &first.id);
        let second = supervisor
            .start_run(request(id, "json_line"), Arc::new(|_| {}))
            .unwrap();
        let second = wait_terminal(&supervisor, &second.id);

        // Each one by its id, the older as well as the newer.
        assert_eq!(
            supervisor.get_run(&first.id).unwrap().request_id,
            "request-success"
        );
        assert_eq!(
            supervisor.get_run(&second.id).unwrap().request_id,
            "request-json_line"
        );
        let unknown = "run-00000000-0000-4000-8000-000000000000";
        assert_eq!(
            supervisor.get_run(unknown).err(),
            Some("run_not_found".into())
        );
        assert_eq!(
            supervisor.delete_run_artifacts(unknown).err(),
            Some("run_not_found".into())
        );

        // The delete hands back the row as the ledger now holds it.
        let deleted = supervisor.delete_run_artifacts(&first.id).unwrap();
        assert_eq!(deleted.id, first.id);
        assert!(deleted.artifacts.is_empty() && deleted.artifact_dir.is_empty());
        assert_eq!(
            supervisor.get_run(&first.id).unwrap().artifact_dir,
            String::new()
        );
    }

    #[test]
    fn the_renderer_cannot_choose_who_started_a_run() {
        let named = r#"{"installationId":"tool-1","profileId":"p","requestId":"r","timeoutSec":1,"outputLimitBytes":1024,"origin":{"trigger":{"by":"assistant"}}}"#;
        assert!(serde_json::from_str::<StartToolRunRequest>(named).is_err());
        let plain = r#"{"installationId":"tool-1","profileId":"p","requestId":"r","timeoutSec":1,"outputLimitBytes":1024}"#;
        let parsed = serde_json::from_str::<StartToolRunRequest>(plain).unwrap();
        assert_eq!(parsed.origin.trigger.by, "user");
        assert!(!parsed.origin.local_input_only);
    }

    #[test]
    fn a_run_built_from_a_descriptor_keeps_its_origin_and_needs_no_scope() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "described");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = supervisor
            .register_tool(RegisterToolRequest {
                candidate_path: executable.to_string_lossy().to_string(),
                display_name: "Described fixture".into(),
                category: "network".into(),
                risk_tier: "low".into(),
                doc_url: String::new(),
                tags: vec![],
                working_dir: executable.parent().unwrap().to_string_lossy().to_string(),
                confirmed: true,
            })
            .unwrap()
            .id;

        // The page asking for a network program without a scope is refused...
        let refused = supervisor
            .start_run(request(id.clone(), "json_line"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(refused.blocked_reason, "authorization_scope_required");

        // ...a run Rust built from a descriptor of local input is not.
        let mut described = request(id, "json_line");
        described.origin = RunOrigin {
            trigger: Trigger::user(),
            subject: Some(RunSubject {
                file_id: Some("file_1".into()),
                file_sha256: Some("ab".repeat(32)),
                ..RunSubject::default()
            }),
            descriptor_id: Some("exiftool".into()),
            parse: Some(ParseHook(Arc::new(|logs: &RunLogs| {
                let size = logs
                    .stdout
                    .lines()
                    .find(|line| line.starts_with('{'))
                    .map_or(0, str::len);
                Ok(vec![Fact::new(Group::Summary, "test.size", size as u64)])
            }))),
            stdin: None,
            local_input_only: true,
        };
        let run = supervisor.start_run(described, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(done.state, "succeeded");
        assert_eq!(done.descriptor_id.as_deref(), Some("exiftool"));
        assert_eq!(done.subject.unwrap().file_id.as_deref(), Some("file_1"));
        assert_eq!(done.observations[0].id, format!("{}:0", done.id));
        assert_eq!(done.observations[0].value, serde_json::json!(13));
    }

    #[test]
    fn a_parser_that_cannot_read_the_output_fails_a_run_that_succeeded() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "unreadable");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut asked = request(id, "success");
        asked.origin.parse = Some(ParseHook(Arc::new(|_| Err("output_unreadable".into()))));
        let run = supervisor.start_run(asked, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(
            (done.state.as_str(), done.termination_reason.as_str()),
            ("failed", "output_unreadable")
        );
        // The raw output is still kept and hashed.
        assert_eq!(done.outputs.len(), 2);
    }

    #[test]
    fn text_for_a_tools_input_goes_in_before_the_readers_start() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "stdin");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut asked = request(id, "echo_stdin");
        asked.origin.stdin = Some("C:\\Belgeler\\Ekran görüntüsü.png\n".as_bytes().to_vec());
        let run = supervisor.start_run(asked, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert!(done
            .stdout_tail
            .contains("stdin=C:\\Belgeler\\Ekran görüntüsü.png"));
    }

    #[test]
    fn a_failed_run_keeps_its_own_reason_when_the_parser_cannot_read_it() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "failed-unreadable");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut asked = request(id, "nonzero");
        asked.origin.parse = Some(ParseHook(Arc::new(|_| Err("output_unreadable".into()))));
        let run = supervisor.start_run(asked, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        // Only a run that succeeded is failed for its output; this one had
        // already failed, and keeps saying why.
        assert_eq!(
            (
                done.state.as_str(),
                done.termination_reason.as_str(),
                done.exit_code
            ),
            ("failed", "non_zero_exit", Some(7))
        );
        assert_eq!(done.outputs.len(), 2);
    }

    #[test]
    fn a_parser_that_panics_fails_its_own_run_and_the_supervisor_goes_on() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "panicking");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let mut asked = request(id.clone(), "success");
        asked.origin.parse = Some(ParseHook(Arc::new(|_| panic!("parser bug"))));
        let run = supervisor.start_run(asked, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(
            (done.state.as_str(), done.termination_reason.as_str()),
            ("failed", "output_unreadable")
        );
        assert!(done.observations.is_empty());
        assert_eq!(done.outputs.len(), 2);

        // The ledger and the active set are intact: the next run goes through.
        let next = supervisor
            .start_run(request(id, "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(wait_terminal(&supervisor, &next.id).state, "succeeded");
    }

    #[test]
    fn a_version_1_ledger_is_backed_up_before_start_up_rewrites_an_interrupted_run() {
        let temp = tempfile::tempdir().unwrap();
        let interrupted = V1_LEDGER.replace(r#""state": "succeeded""#, r#""state": "running""#);
        assert_ne!(interrupted, V1_LEDGER);
        let lab = write_ledger_file(temp.path(), &interrupted);

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();

        // Finding the run unfinished is itself a save, so the old file is
        // kept as it was before that save.
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.v1.json")).unwrap(),
            interrupted
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(lab.join("tool-runs.json")).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        assert_eq!(saved["runs"][0]["state"], "orphaned");
        assert_eq!(saved["runs"][0]["trigger"]["by"], "legacy");
        let run = supervisor.list_runs().unwrap().remove(0);
        assert_eq!(run.termination_reason, "app_restarted");
    }

    #[test]
    fn a_version_1_ledger_is_not_written_over_when_its_backup_cannot_be_kept() {
        let temp = tempfile::tempdir().unwrap();
        let lab = write_ledger_file(temp.path(), V1_LEDGER);
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();

        // The folder is gone before the first save, so the backup cannot be
        // written; the save stops there instead of writing version 2 alone.
        fs::remove_dir_all(&lab).unwrap();
        let refused =
            supervisor.start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}));
        assert_eq!(refused.unwrap_err(), "run_ledger_backup_failed");
        // The attempt that was not saved is not listed in this session either.
        assert_eq!(run_ids(&supervisor), vec![V1_RUN_ID.to_string()]);

        // The version-1 bytes are still pending: once the folder is back, the
        // next save keeps them exactly before it writes version 2.
        fs::create_dir_all(&lab).unwrap();
        let blocked = supervisor
            .start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(
            fs::read_to_string(lab.join(V1_BACKUP_FILE)).unwrap(),
            V1_LEDGER
        );
        assert_eq!(
            run_ids(&supervisor),
            vec![blocked.id, V1_RUN_ID.to_string()]
        );
    }

    #[test]
    fn a_partial_v1_backup_is_kept_and_the_exact_bytes_go_to_a_new_name() {
        let temp = tempfile::tempdir().unwrap();
        let lab = write_ledger_file(temp.path(), V1_LEDGER);
        // An earlier save stopped partway through writing the backup.
        let partial = &V1_LEDGER.as_bytes()[..V1_LEDGER.len() / 2];
        fs::write(lab.join(V1_BACKUP_FILE), partial).unwrap();

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let saved = supervisor
            .start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(saved.state, "blocked");

        // The partial file is left as it was...
        assert_eq!(fs::read(lab.join(V1_BACKUP_FILE)).unwrap(), partial);
        // ...and the exact version-1 bytes are kept under a name of their own.
        let fresh = files_named_like(&lab, "tool-runs.v1-");
        assert_eq!(fresh.len(), 1);
        let name = fresh[0].file_name().unwrap().to_string_lossy().into_owned();
        let stamp = name
            .strip_prefix("tool-runs.v1-")
            .and_then(|rest| rest.strip_suffix(".json"))
            .unwrap();
        assert!(
            !stamp.is_empty() && stamp.chars().all(|c| c.is_ascii_digit()),
            "{name}"
        );
        assert_eq!(fs::read(&fresh[0]).unwrap(), V1_LEDGER.as_bytes());
        let ledger: serde_json::Value =
            serde_json::from_slice(&fs::read(lab.join("tool-runs.json")).unwrap()).unwrap();
        assert_eq!(ledger["version"], 2);
    }

    #[test]
    fn a_v1_backup_that_already_holds_the_same_bytes_is_not_written_again() {
        let temp = tempfile::tempdir().unwrap();
        let lab = write_ledger_file(temp.path(), V1_LEDGER);
        fs::write(lab.join(V1_BACKUP_FILE), V1_LEDGER).unwrap();

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        supervisor
            .start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}))
            .unwrap();

        assert_eq!(
            fs::read_to_string(lab.join(V1_BACKUP_FILE)).unwrap(),
            V1_LEDGER
        );
        assert!(files_named_like(&lab, "tool-runs.v1-").is_empty());
        let ledger: serde_json::Value =
            serde_json::from_slice(&fs::read(lab.join("tool-runs.json")).unwrap()).unwrap();
        assert_eq!(ledger["version"], 2);
    }

    #[test]
    fn a_log_the_parser_cannot_read_is_unreadable_never_empty_text() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let run_id = format!("run-{}", Uuid::new_v4());
        let run_dir = temp.path().join("lab").join("runs").join(&run_id);
        fs::create_dir_all(&run_dir).unwrap();
        // Only stderr.log is there: stdout.log was never written.
        fs::write(run_dir.join("stderr.log"), "warning\n").unwrap();
        // A parser that would read empty output as "nothing found".
        let called = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&called);
        let hook = ParseHook(Arc::new(move |_: &RunLogs| {
            seen.store(true, Ordering::SeqCst);
            Ok(vec![Fact::new(Group::Summary, "test.matches", 0_u64)])
        }));

        let (observations, unreadable) = supervisor.parse_logs(&run_id, Some(&hook), Some(0));
        assert!(unreadable);
        assert!(observations.is_empty());
        assert!(
            !called.load(Ordering::SeqCst),
            "the parser was given no log"
        );

        // Hashing leaves out only the log that is not there.
        let hashed: Vec<String> = supervisor
            .hash_outputs(&run_id)
            .into_iter()
            .map(|output| output.name)
            .collect();
        assert_eq!(hashed, vec!["stderr.log".to_string()]);
    }

    #[test]
    fn a_tools_input_over_the_cap_is_refused_before_a_row_or_a_folder_is_made() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "stdin-cap");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);

        let mut too_large = request(id.clone(), "echo_stdin");
        too_large.origin.stdin = Some(vec![b'a'; MAX_STDIN_BYTES + 1]);
        let refused = supervisor.start_run(too_large, Arc::new(|_| {}));
        assert_eq!(refused.unwrap_err(), "input_too_large");
        assert!(supervisor.list_runs().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(temp.path().join("lab").join("runs"))
                .unwrap()
                .count(),
            0
        );

        // An input at the cap still goes in whole.
        let mut at_cap = request(id, "echo_stdin");
        at_cap.origin.stdin = Some(vec![b'a'; MAX_STDIN_BYTES]);
        let run = supervisor.start_run(at_cap, Arc::new(|_| {})).unwrap();
        let done = wait_terminal(&supervisor, &run.id);
        assert_eq!(done.state, "succeeded");
        assert!(done
            .stdout_tail
            .contains(&format!("stdin={}", "a".repeat(MAX_STDIN_BYTES))));
    }

    #[test]
    fn a_newer_ledger_this_version_cannot_parse_is_left_as_it_is() {
        let temp = tempfile::tempdir().unwrap();
        // Version 3 changed the type of a field: `argv` is one string.
        let text = V1_LEDGER
            .replace(r#""version": 1"#, r#""version": 3"#)
            .replace(
                r#""argv": ["-sV", "10.0.0.1"]"#,
                r#""argv": "-sV 10.0.0.1""#,
            );
        assert!(serde_json::from_str::<RunLedger>(&text).is_err());
        let lab = write_ledger_file(temp.path(), &text);

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        assert!(supervisor.list_runs().unwrap().is_empty());
        let refused =
            supervisor.start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}));
        assert_eq!(refused.unwrap_err(), "run_ledger_read_only");
        assert_eq!(
            supervisor.inner.persist_ledger().unwrap_err(),
            "run_ledger_read_only"
        );
        // Not set aside, not replaced, not touched.
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.json")).unwrap(),
            text
        );
        assert_eq!(
            files_named_like(&lab, "tool-runs."),
            vec![lab.join("tool-runs.json")]
        );
    }

    #[test]
    fn a_newer_ledger_with_an_unfinished_run_loads_and_stays_as_it_was() {
        let temp = tempfile::tempdir().unwrap();
        let text = V1_LEDGER
            .replace(r#""version": 1"#, r#""version": 3"#)
            .replace(r#""state": "succeeded""#, r#""state": "running""#);
        let lab = write_ledger_file(temp.path(), &text);

        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        // Shown as ended in this session, never written back.
        let run = supervisor.list_runs().unwrap().remove(0);
        assert_eq!(
            (run.state.as_str(), run.termination_reason.as_str()),
            ("orphaned", "app_restarted")
        );
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.json")).unwrap(),
            text
        );
        assert_eq!(
            files_named_like(&lab, "tool-runs."),
            vec![lab.join("tool-runs.json")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_start_whose_row_cannot_be_saved_leaves_no_row_and_no_folder() {
        let temp = tempfile::tempdir().unwrap();
        let lab = write_ledger_file(temp.path(), V1_LEDGER);
        block_the_v1_backup(&lab);
        let executable = copy_test_exe(temp.path(), "unsaved");
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        let id = register_fixture(&supervisor, &executable);
        let before = serde_json::to_value(supervisor.list_runs().unwrap()).unwrap();

        let refused = supervisor.start_run(request(id, "success"), Arc::new(|_| {}));
        assert_eq!(refused.unwrap_err(), "run_ledger_backup_failed");
        assert_eq!(
            serde_json::to_value(supervisor.list_runs().unwrap()).unwrap(),
            before
        );
        assert_eq!(fs::read_dir(lab.join("runs")).unwrap().count(), 0);
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.json")).unwrap(),
            V1_LEDGER
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_save_that_fails_at_start_up_leaves_the_ledger_read_only_and_as_it_was() {
        let temp = tempfile::tempdir().unwrap();
        let interrupted = V1_LEDGER.replace(r#""state": "succeeded""#, r#""state": "running""#);
        let lab = write_ledger_file(temp.path(), &interrupted);
        block_the_v1_backup(&lab);

        // Start-up goes on...
        let supervisor = ToolSupervisor::load(temp.path()).unwrap();
        // ...with the run reconciled in memory...
        let run = supervisor.list_runs().unwrap().remove(0);
        assert_eq!(
            (run.state.as_str(), run.termination_reason.as_str()),
            ("orphaned", "app_restarted")
        );
        // ...and writes nothing more this session.
        assert!(!supervisor.inner.writable);
        let refused =
            supervisor.start_run(request("tool-forged".into(), "success"), Arc::new(|_| {}));
        assert_eq!(refused.unwrap_err(), "run_ledger_read_only");
        assert_eq!(
            fs::read_to_string(lab.join("tool-runs.json")).unwrap(),
            interrupted
        );
        assert_eq!(
            files_named_like(&lab, "tool-runs."),
            vec![lab.join("tool-runs.json"), lab.join(V1_BACKUP_FILE)]
        );
    }
}
