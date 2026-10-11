//! Native launch receipts (data contracts §4).
//!
//! A detached GUI launch used to discard everything it knew the moment the
//! child spawned: the manual route (`lib.rs::launch_tool_detached`) and the
//! assistant route (`assistant::tools::execute_launch_tool`) each dropped the
//! child handle and returned `()` or a sentence. Recent runs and Work's
//! launch-record tabs need to say what was launched, when, and how it went,
//! and that record must come from Rust: the renderer can write the
//! SQL document store (`sql:allow-execute`), so a receipt kept there could be
//! forged, replayed or edited, and nothing derived from it could be trusted.
//!
//! This module is the receipt authority. Both launch routes go through
//! [`launch_recorded`], which writes a receipt to a Rust-owned file
//! (`<app data>/lab/tool-launches.json`) around the actual spawn:
//!
//! 1. Before spawning, a receipt with outcome `unknown` is written. If that
//!    write fails, nothing is spawned (`launch_record_failed`): a launch
//!    Rust cannot record does not happen.
//! 2. After spawning, the receipt becomes `launched` (with pid and spawn
//!    time) or `failed` (with a stable reason code) and is written again. If
//!    that second write fails the process is already running, so the
//!    caller still gets the true outcome, marked `recorded: false`; the file
//!    keeps saying `unknown`, which is what it honestly knows.
//!
//! A crash between the spawn and the second write therefore leaves an
//! `unknown` receipt, never a fabricated success. A refusal before any spawn
//! (missing, disabled or identity-changed installation) is recorded as
//! `failed` without a spawn time, so a failed launch never has a success
//! receipt.
//!
//! Launches are unmanaged (`tracking: "unmanaged"`): a GUI application owns
//! its own lifetime, and some hand off to an existing instance and exit at
//! once, so a launch receipt is "launched externally", never "succeeded",
//! never "running", and Stop all does not apply to it.
//!
//! An operation id names one launch attempt. Repeating it returns the
//! receipt already recorded and spawns nothing, so a renderer retry after a
//! lost reply cannot launch twice; an uncertain outcome is never retried
//! automatically.
//!
//! Receipts hold no arguments. A command line can carry a secret, and this
//! file must not become a second, unredacted argument log; the receipt says
//! which installation was launched, not with what.

use std::{
    collections::VecDeque,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};

use crate::durable_file::{keep_unreadable, replace_file};
use crate::tool_registry::now_ms;

/// Event name the receipts are published on, new and updated alike.
pub const LAUNCH_EVENT: &str = "tool://launch";

const LEDGER_VERSION: u32 = 1;
const LEDGER_FILE: &str = "tool-launches.json";
/// Oldest receipts are dropped past this many. History for Recent runs, not
/// an audit archive. A launch still waiting on its spawn is never dropped.
pub const MAX_RECEIPTS: usize = 200;
/// How many operation ids are remembered, far past the displayed history, so
/// a retried operation is refused even after its receipt has aged out.
/// This is the replay window: an operation id older than the
/// last `MAX_OPERATIONS` attempts counts as new.
pub const MAX_OPERATIONS: usize = 10_000;
const MAX_OPERATION_ID_LEN: usize = 96;
const MAX_INSTALLATION_ID_LEN: usize = 128;
const MAX_DISPLAY_NAME_CHARS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchOrigin {
    Manual,
    Assistant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchOutcome {
    Launched,
    Failed,
    Unknown,
}

/// The only tracking a GUI launch has. A type of its own so the wire value
/// cannot drift into a claim of supervision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchTracking {
    Unmanaged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReceipt {
    pub launch_id: String,
    pub operation_id: String,
    pub installation_id: String,
    pub display_name: String,
    pub origin: LaunchOrigin,
    pub requested_at: u64,
    pub spawned_at: Option<u64>,
    pub pid: Option<u32>,
    pub outcome: LaunchOutcome,
    pub tracking: LaunchTracking,
    pub reason_code: Option<String>,
    /// True once this receipt, as returned, is on disk. Not stored: every
    /// receipt read back from the file is recorded by definition.
    #[serde(skip_deserializing, default = "recorded_on_disk")]
    pub recorded: bool,
}

fn recorded_on_disk() -> bool {
    true
}

/// What the caller asks to launch. The installation id is the renderer's or
/// the model's; the path never is (see `ToolSupervisor::resolve_launchable`).
#[derive(Clone, Copy, Debug)]
pub struct LaunchRequest<'a> {
    pub operation_id: &'a str,
    pub installation_id: &'a str,
    pub origin: LaunchOrigin,
}

/// A resolved launch target with the display name the receipt shows, or a
/// refusal code with whatever display name the registry still has (empty if
/// it has none).
pub type Resolution<T> = Result<(T, String), Refusal>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason_code: String,
    pub display_name: String,
}

pub type ReceiptSink = Arc<dyn Fn(&LaunchReceipt) + Send + Sync + 'static>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    receipts: VecDeque<LaunchReceipt>,
    /// Every operation id attempted, oldest first, up to `MAX_OPERATIONS`.
    /// Absent from ledgers written before it existed.
    #[serde(default)]
    operations: VecDeque<OperationRecord>,
}

/// What an operation id was used for, kept after its receipt is gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationRecord {
    operation_id: String,
    installation_id: String,
    origin: LaunchOrigin,
}

/// A receipt written before its spawn whose outcome has not come back yet.
/// One reloaded from disk in that state carries `outcome_not_recorded`.
fn in_flight(receipt: &LaunchReceipt) -> bool {
    receipt.outcome == LaunchOutcome::Unknown && receipt.reason_code.is_none()
}

/// Drop the oldest receipts past `MAX_RECEIPTS`, never one still in flight:
/// its outcome must have a slot to land in.
fn trim_history(ledger: &mut Ledger) {
    while ledger.receipts.len() > MAX_RECEIPTS {
        match ledger.receipts.iter().position(|r| !in_flight(r)) {
            Some(oldest) => {
                ledger.receipts.remove(oldest);
            }
            None => break,
        }
    }
    while ledger.operations.len() > MAX_OPERATIONS {
        ledger.operations.pop_front();
    }
}

pub struct LaunchReceipts {
    path: PathBuf,
    ledger: Mutex<Ledger>,
    sink: ReceiptSink,
    /// False when the file on disk is one this version must not write: it
    /// could not be read, could not be kept aside, or is from a newer
    /// version. Nothing is written then, so a launch is refused before it
    /// spawns (`launch_record_failed`) and the file is left as it is.
    writable: bool,
}

/// Just the version, read first so a newer file is recognised even when its
/// receipts cannot be read.
#[derive(Deserialize)]
struct LedgerHeader {
    version: u64,
}

impl LaunchReceipts {
    /// Load the ledger under `<base_dir>/lab`. Never fails the start of the
    /// app: launch history is not worth refusing to start over.
    /// - A file that does not parse, or has an older version this version
    ///   does not know, is kept beside the ledger
    ///   (`tool-launches.unreadable-<ms>.json`) and the ledger starts empty.
    /// - A file from a newer version is read as far as it can be and never
    ///   written.
    /// - A file that cannot be read, or kept aside, is not written either.
    pub fn load(base_dir: &Path, sink: ReceiptSink) -> Self {
        let lab_dir = base_dir.join("lab");
        let path = lab_dir.join(LEDGER_FILE);
        let (mut ledger, writable) = match fs::create_dir_all(&lab_dir) {
            Ok(()) => Self::read_state(&path),
            Err(error) => {
                eprintln!("[Qutra Labs] launch ledger folder unavailable: {error}");
                (Ledger::default(), false)
            }
        };
        ledger.version = LEDGER_VERSION;
        for receipt in ledger.receipts.iter_mut() {
            // Written before a spawn whose outcome never reached the file:
            // the app stopped in between. Say so; do not guess.
            if receipt.outcome == LaunchOutcome::Unknown && receipt.reason_code.is_none() {
                receipt.reason_code = Some("outcome_not_recorded".into());
            }
        }
        Self {
            path,
            ledger: Mutex::new(ledger),
            sink,
            writable,
        }
    }

    fn read_state(path: &Path) -> (Ledger, bool) {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return (Ledger::default(), true),
            Err(e) => {
                eprintln!("[Qutra Labs] launch ledger unreadable: {e}");
                return (Ledger::default(), false);
            }
        };
        if let Ok(LedgerHeader { version }) = serde_json::from_slice(&bytes) {
            if version > u64::from(LEDGER_VERSION) {
                eprintln!(
                    "[Qutra Labs] launch ledger is from a newer version ({version}); read only"
                );
                let newer = serde_json::from_slice::<Ledger>(&bytes).unwrap_or_default();
                return (newer, false);
            }
        }
        match serde_json::from_slice::<Ledger>(&bytes) {
            Ok(parsed) if parsed.version == LEDGER_VERSION => (parsed, true),
            _ => match keep_unreadable(path, &bytes) {
                Ok(kept) => {
                    eprintln!(
                        "[Qutra Labs] launch ledger unreadable; kept as {}",
                        kept.display()
                    );
                    // The empty ledger written now stops the next start from
                    // keeping the same bytes again.
                    let fresh = Ledger {
                        version: LEDGER_VERSION,
                        ..Ledger::default()
                    };
                    let written = serde_json::to_vec_pretty(&fresh)
                        .ok()
                        .is_some_and(|bytes| replace_file(path, &bytes).is_ok());
                    (fresh, written)
                }
                Err(e) => {
                    eprintln!("[Qutra Labs] launch ledger unreadable and not kept: {e}");
                    (Ledger::default(), false)
                }
            },
        }
    }

    /// Newest first, at most `limit` (capped at [`MAX_RECEIPTS`]).
    pub fn list(&self, limit: usize) -> Vec<LaunchReceipt> {
        self.lock()
            .receipts
            .iter()
            .rev()
            .take(limit.min(MAX_RECEIPTS))
            .cloned()
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, Ledger> {
        match self.ledger.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Write the whole ledger. On success every receipt in memory is on
    /// disk; on failure the ones that were not stay marked unrecorded.
    fn persist(&self, ledger: &mut Ledger) -> bool {
        if !self.writable {
            for receipt in ledger.receipts.iter_mut() {
                receipt.recorded = false;
            }
            return false;
        }
        let unrecorded: Vec<usize> = (0..ledger.receipts.len())
            .filter(|&i| !ledger.receipts[i].recorded)
            .collect();
        for receipt in ledger.receipts.iter_mut() {
            receipt.recorded = true;
        }
        let written = serde_json::to_vec_pretty(&*ledger)
            .ok()
            .is_some_and(|bytes| replace_file(&self.path, &bytes).is_ok());
        if !written {
            for i in unrecorded {
                ledger.receipts[i].recorded = false;
            }
        }
        written
    }

    fn publish(&self, receipt: &LaunchReceipt) {
        (self.sink)(receipt);
    }
}

/// Record one launch attempt around `spawn`, which returns the child's pid.
///
/// Returns `Err` only when no attempt was made: an invalid request, an
/// operation id already used for another installation or origin, or a
/// pre-spawn receipt that could not be written. Every attempt, including
/// one refused before spawning, returns `Ok` with its receipt; the caller
/// reads `outcome`.
pub fn launch_recorded<T>(
    receipts: &LaunchReceipts,
    request: LaunchRequest<'_>,
    resolution: Resolution<T>,
    spawn: impl FnOnce(&T) -> io::Result<u32>,
) -> Result<LaunchReceipt, String> {
    validate_request(&request)?;

    let (pending, target) = {
        let mut ledger = receipts.lock();
        if let Some(existing) = ledger
            .receipts
            .iter()
            .find(|r| r.operation_id == request.operation_id)
        {
            if existing.installation_id != request.installation_id
                || existing.origin != request.origin
            {
                return Err("operation_id_conflict".into());
            }
            return Ok(existing.clone());
        }
        // Its receipt aged out of the history, but the id was used: a retry
        // of an old operation never launches again.
        if let Some(seen) = ledger
            .operations
            .iter()
            .find(|o| o.operation_id == request.operation_id)
        {
            if seen.installation_id != request.installation_id || seen.origin != request.origin {
                return Err("operation_id_conflict".into());
            }
            return Err("operation_already_used".into());
        }

        let (target, display_name, outcome, reason_code) = match resolution {
            Ok((target, name)) => (Some(target), name, LaunchOutcome::Unknown, None),
            Err(refusal) => (
                None,
                refusal.display_name,
                LaunchOutcome::Failed,
                Some(refusal.reason_code),
            ),
        };
        let receipt = LaunchReceipt {
            launch_id: format!("launch-{}", uuid::Uuid::new_v4()),
            operation_id: request.operation_id.into(),
            installation_id: request.installation_id.into(),
            display_name: bounded_display_name(&display_name),
            origin: request.origin,
            requested_at: now_ms(),
            spawned_at: None,
            pid: None,
            outcome,
            tracking: LaunchTracking::Unmanaged,
            reason_code,
            recorded: false,
        };
        let before = ledger.clone();
        ledger.receipts.push_back(receipt.clone());
        ledger.operations.push_back(OperationRecord {
            operation_id: request.operation_id.into(),
            installation_id: request.installation_id.into(),
            origin: request.origin,
        });
        trim_history(&mut ledger);
        if !receipts.persist(&mut ledger) {
            // Nothing happened, so memory goes back to what the file holds.
            *ledger = before;
            return Err("launch_record_failed".into());
        }
        let recorded = ledger.receipts.back().cloned().unwrap_or(receipt);
        (recorded, target)
    };
    receipts.publish(&pending);

    // Refused before spawning: the failed receipt is already final.
    let Some(target) = target else {
        return Ok(pending);
    };

    // No lock held across the spawn.
    let spawned = spawn(&target);
    let finished = {
        let mut ledger = receipts.lock();
        let mut finished = pending.clone();
        match spawned {
            Ok(pid) => {
                finished.outcome = LaunchOutcome::Launched;
                finished.spawned_at = Some(now_ms());
                finished.pid = Some(pid);
            }
            Err(e) => {
                finished.outcome = LaunchOutcome::Failed;
                finished.reason_code = Some(spawn_reason(&e).into());
            }
        }
        finished.recorded = false;
        match ledger
            .receipts
            .iter_mut()
            .find(|r| r.launch_id == finished.launch_id)
        {
            Some(slot) => *slot = finished.clone(),
            // trim_history keeps in-flight receipts, so this is not expected;
            // if it happens, the outcome is stored rather than claimed.
            None => ledger.receipts.push_back(finished.clone()),
        }
        trim_history(&mut ledger);
        let written = receipts.persist(&mut ledger);
        finished.recorded = written;
        finished
    };
    receipts.publish(&finished);
    Ok(finished)
}

/// Stable reason code for a spawn error. Never the OS message: the reason
/// is stored and shown through translated copy, and an OS message can carry
/// a path.
pub fn spawn_reason(e: &io::Error) -> &'static str {
    if e.kind() == io::ErrorKind::PermissionDenied {
        "elevation_required"
    } else {
        "spawn_failed"
    }
}

fn validate_request(request: &LaunchRequest<'_>) -> Result<(), String> {
    if !is_token(request.operation_id, MAX_OPERATION_ID_LEN) {
        return Err("invalid_operation_id".into());
    }
    // Registry ids are `tool-<uuid>`; the same charset keeps a model-named
    // id that resolves to nothing from writing a path or a sentence here.
    if !is_token(request.installation_id, MAX_INSTALLATION_ID_LEN) {
        return Err("invalid_installation_id".into());
    }
    Ok(())
}

fn is_token(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn bounded_display_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control())
        .take(MAX_DISPLAY_NAME_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn collecting() -> (ReceiptSink, Arc<Mutex<Vec<LaunchReceipt>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let sink: ReceiptSink = Arc::new(move |r: &LaunchReceipt| {
            sink_seen.lock().unwrap().push(r.clone());
        });
        (sink, seen)
    }

    fn quiet() -> ReceiptSink {
        Arc::new(|_: &LaunchReceipt| {})
    }

    // Ugly like production: a renderer operation id is a v4 uuid, an
    // installation id is a registry uuid, never a hand-written "tool-nmap".
    const OP: &str = "6f1d3c2a-9b7e-4f0a-8c3d-2e5b7a9c1d4f";
    const INSTALL: &str = "tool-3b9f2e71-0c4d-4a8e-9f6b-7d2c1e5a8b30";

    fn manual(op: &str) -> LaunchRequest<'_> {
        LaunchRequest {
            operation_id: op,
            installation_id: INSTALL,
            origin: LaunchOrigin::Manual,
        }
    }

    fn resolved() -> Resolution<&'static str> {
        Ok(("C:/Tools/Burp/burp.exe", "Burp Suite Community".into()))
    }

    fn on_disk(base: &Path) -> serde_json::Value {
        let bytes = fs::read(base.join("lab").join(LEDGER_FILE)).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn a_spawn_is_recorded_as_launched_with_pid_and_spawn_time() {
        let temp = tempfile::tempdir().unwrap();
        let (sink, seen) = collecting();
        let receipts = LaunchReceipts::load(temp.path(), sink);

        let receipt = launch_recorded(&receipts, manual(OP), resolved(), |_| Ok(4242)).unwrap();

        assert_eq!(receipt.outcome, LaunchOutcome::Launched);
        assert_eq!(receipt.pid, Some(4242));
        assert!(receipt
            .spawned_at
            .is_some_and(|t| t >= receipt.requested_at));
        assert_eq!(receipt.tracking, LaunchTracking::Unmanaged);
        assert_eq!(receipt.display_name, "Burp Suite Community");
        assert_eq!(receipt.reason_code, None);
        assert!(receipt.recorded);
        assert!(receipt.launch_id.starts_with("launch-"));

        let disk = on_disk(temp.path());
        assert_eq!(disk["receipts"][0]["outcome"], "launched");
        assert_eq!(disk["receipts"][0]["pid"], 4242);
        assert_eq!(disk["receipts"][0]["tracking"], "unmanaged");

        // Published twice: the pending attempt, then its outcome.
        let events = seen.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].outcome, LaunchOutcome::Unknown);
        assert_eq!(events[1].outcome, LaunchOutcome::Launched);
        assert_eq!(events[0].launch_id, events[1].launch_id);
    }

    #[test]
    fn the_receipt_is_on_disk_as_unknown_before_the_spawn_runs() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let base = temp.path().to_path_buf();

        launch_recorded(&receipts, manual(OP), resolved(), |_| {
            let disk = on_disk(&base);
            assert_eq!(disk["receipts"][0]["outcome"], "unknown");
            assert_eq!(disk["receipts"][0]["spawnedAt"], serde_json::Value::Null);
            Ok(1)
        })
        .unwrap();
    }

    #[test]
    fn a_crash_after_the_spawn_reloads_as_unknown_never_as_launched() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let ledger_path = temp.path().join("lab").join(LEDGER_FILE);
        let mut snapshot = Vec::new();
        launch_recorded(&receipts, manual(OP), resolved(), |_| {
            // What the file holds at the moment the app would die.
            snapshot = fs::read(&ledger_path).unwrap();
            Ok(77)
        })
        .unwrap();
        fs::write(&ledger_path, snapshot).unwrap();

        let reloaded = LaunchReceipts::load(temp.path(), quiet());
        let list = reloaded.list(10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].outcome, LaunchOutcome::Unknown);
        assert_eq!(list[0].pid, None);
        assert_eq!(list[0].reason_code.as_deref(), Some("outcome_not_recorded"));
        assert!(list[0].recorded);
    }

    #[test]
    fn a_failed_spawn_has_no_success_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());

        let denied = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap();
        assert_eq!(denied.outcome, LaunchOutcome::Failed);
        assert_eq!(denied.reason_code.as_deref(), Some("elevation_required"));
        assert_eq!(denied.spawned_at, None);
        assert_eq!(denied.pid, None);

        let other = launch_recorded(
            &receipts,
            manual("0c8e4b1f-2d7a-4e9c-b6f3-5a1d8e2c7b94"),
            resolved(),
            |_| Err(io::Error::other("C:\\Users\\someone\\secret path")),
        )
        .unwrap();
        // A stable code, not the OS message (which can carry a path).
        assert_eq!(other.reason_code.as_deref(), Some("spawn_failed"));
    }

    #[test]
    fn only_permission_denied_is_reported_as_elevation_required() {
        assert_eq!(
            spawn_reason(&io::Error::from(io::ErrorKind::PermissionDenied)),
            "elevation_required"
        );
        for kind in [
            io::ErrorKind::NotFound,
            io::ErrorKind::Other,
            io::ErrorKind::TimedOut,
        ] {
            assert_eq!(
                spawn_reason(&io::Error::from(kind)),
                "spawn_failed",
                "{kind:?} must not be misreported as elevation_required"
            );
        }
    }

    #[test]
    fn a_refusal_before_spawning_is_recorded_as_failed_and_spawns_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let refused: Resolution<&str> = Err(Refusal {
            reason_code: "tool_identity_changed".into(),
            display_name: "Burp Suite Community".into(),
        });

        let receipt = launch_recorded(&receipts, manual(OP), refused, |_| {
            panic!("a refused launch must not spawn")
        })
        .unwrap();
        assert_eq!(receipt.outcome, LaunchOutcome::Failed);
        assert_eq!(
            receipt.reason_code.as_deref(),
            Some("tool_identity_changed")
        );
        assert_eq!(receipt.spawned_at, None);
        assert!(receipt.recorded);
    }

    #[test]
    fn a_repeated_operation_id_returns_the_same_attempt_without_spawning_again() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let spawns = AtomicUsize::new(0);
        let spawn = |_: &&str| {
            spawns.fetch_add(1, Ordering::SeqCst);
            Ok(9)
        };

        let first = launch_recorded(&receipts, manual(OP), resolved(), spawn).unwrap();
        let again = launch_recorded(&receipts, manual(OP), resolved(), spawn).unwrap();
        assert_eq!(first, again);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(receipts.list(10).len(), 1);
    }

    #[test]
    fn a_repeated_failed_attempt_is_not_retried() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        launch_recorded(&receipts, manual(OP), resolved(), |_| {
            Err(io::Error::other("boom"))
        })
        .unwrap();
        let again = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            panic!("an operation id that already failed must not spawn")
        })
        .unwrap();
        assert_eq!(again.outcome, LaunchOutcome::Failed);
    }

    #[test]
    fn an_operation_id_reused_for_another_installation_or_origin_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        launch_recorded(&receipts, manual(OP), resolved(), |_| Ok(1)).unwrap();

        let other_install = LaunchRequest {
            operation_id: OP,
            installation_id: "tool-a7c4e2d9-5f1b-4c8a-9e3d-6b2f0a1c7e58",
            origin: LaunchOrigin::Manual,
        };
        assert_eq!(
            launch_recorded(&receipts, other_install, resolved(), |_| Ok(2)).unwrap_err(),
            "operation_id_conflict"
        );
        let other_origin = LaunchRequest {
            origin: LaunchOrigin::Assistant,
            ..manual(OP)
        };
        assert_eq!(
            launch_recorded(&receipts, other_origin, resolved(), |_| Ok(2)).unwrap_err(),
            "operation_id_conflict"
        );
    }

    #[test]
    fn a_receipt_that_cannot_be_written_first_means_no_spawn() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        // A directory where the temp file must go makes every write fail.
        fs::create_dir_all(temp.path().join("lab").join("tool-launches.json.tmp")).unwrap();

        let err = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            panic!("a launch Rust cannot record must not happen")
        })
        .unwrap_err();
        assert_eq!(err, "launch_record_failed");
        assert!(receipts.list(10).is_empty());
    }

    #[test]
    fn a_full_ledger_that_cannot_be_written_keeps_its_oldest_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        for i in 0..MAX_RECEIPTS {
            let op = format!("op-{i}");
            launch_recorded(&receipts, manual(&op), resolved(), |_| Ok(1)).unwrap();
        }
        fs::create_dir_all(temp.path().join("lab").join("tool-launches.json.tmp")).unwrap();

        launch_recorded(&receipts, manual(OP), resolved(), |_| Ok(1)).unwrap_err();
        let all = receipts.list(usize::MAX);
        assert_eq!(all.len(), MAX_RECEIPTS);
        assert_eq!(all.last().unwrap().operation_id, "op-0");
    }

    #[test]
    fn a_write_failure_after_the_spawn_still_reports_the_launch_unrecorded() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let blocker = temp.path().join("lab").join("tool-launches.json.tmp");

        let receipt = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            fs::create_dir_all(&blocker).unwrap();
            Ok(31)
        })
        .unwrap();
        assert_eq!(receipt.outcome, LaunchOutcome::Launched);
        assert!(!receipt.recorded);
        // The file keeps the honest pre-spawn state.
        assert_eq!(on_disk(temp.path())["receipts"][0]["outcome"], "unknown");
    }

    #[test]
    fn an_operation_is_not_launched_again_after_its_receipt_ages_out() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        launch_recorded(&receipts, manual(OP), resolved(), |_| Ok(7)).unwrap();
        for i in 0..MAX_RECEIPTS {
            let op = format!("op-{i}");
            launch_recorded(&receipts, manual(&op), resolved(), |_| Ok(1)).unwrap();
        }
        assert!(receipts
            .list(usize::MAX)
            .iter()
            .all(|r| r.operation_id != OP));

        let err = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            panic!("an operation id seen before must not launch again")
        })
        .unwrap_err();
        assert_eq!(err, "operation_already_used");

        // The memory of it is on disk, not only in this process.
        let reloaded = LaunchReceipts::load(temp.path(), quiet());
        let err = launch_recorded(&reloaded, manual(OP), resolved(), |_| {
            panic!("not after a restart either")
        })
        .unwrap_err();
        assert_eq!(err, "operation_already_used");
    }

    #[test]
    fn an_outstanding_launch_is_not_displaced_by_later_attempts() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());

        let receipt = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            // While this spawn runs, more attempts than the history keeps.
            for i in 0..MAX_RECEIPTS + 5 {
                let op = format!("op-{i}");
                launch_recorded(&receipts, manual(&op), resolved(), |_| Ok(1)).unwrap();
            }
            Ok(99)
        })
        .unwrap();

        assert_eq!(receipt.outcome, LaunchOutcome::Launched);
        assert!(receipt.recorded);
        let kept = receipts.list(usize::MAX);
        let ours = kept.iter().find(|r| r.operation_id == OP);
        assert_eq!(ours.map(|r| r.outcome), Some(LaunchOutcome::Launched));
        assert!(kept.len() <= MAX_RECEIPTS);
        let disk = on_disk(temp.path());
        let on_file = disk["receipts"].as_array().unwrap();
        assert!(on_file
            .iter()
            .any(|r| r["operationId"] == OP && r["pid"] == 99));
    }

    #[test]
    fn an_unwritten_outcome_reloads_as_unknown_and_a_retry_spawns_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let blocker = temp.path().join("lab").join("tool-launches.json.tmp");
        launch_recorded(&receipts, manual(OP), resolved(), |_| {
            fs::create_dir_all(&blocker).unwrap();
            Ok(31)
        })
        .unwrap();
        fs::remove_dir(&blocker).unwrap();

        let reloaded = LaunchReceipts::load(temp.path(), quiet());
        let again = launch_recorded(&reloaded, manual(OP), resolved(), |_| {
            panic!("an attempt whose outcome is unknown is never retried")
        })
        .unwrap();
        assert_eq!(again.outcome, LaunchOutcome::Unknown);
        assert_eq!(again.reason_code.as_deref(), Some("outcome_not_recorded"));
    }

    #[test]
    fn receipts_hold_no_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let args = ["--token".to_string(), "hunter2-secret".to_string()];
        launch_recorded(&receipts, manual(OP), resolved(), |_| {
            let _ = &args;
            Ok(5)
        })
        .unwrap();
        let raw = fs::read_to_string(temp.path().join("lab").join(LEDGER_FILE)).unwrap();
        assert!(!raw.contains("hunter2-secret"));
        assert!(!raw.contains("burp.exe"), "no executable path either");
    }

    #[test]
    fn malformed_requests_are_refused_before_anything_is_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let long = "a".repeat(MAX_OPERATION_ID_LEN + 1);
        for bad in ["", "has space", "../x", "op\n", long.as_str()] {
            assert_eq!(
                launch_recorded(&receipts, manual(bad), resolved(), |_| Ok(1)).unwrap_err(),
                "invalid_operation_id",
                "{bad:?}"
            );
        }
        // The model names the installation on the assistant route, so a path,
        // a sentence or an escape sequence must not reach the ledger as one.
        let long_install = format!("tool-{}", "a".repeat(MAX_INSTALLATION_ID_LEN));
        for bad in [
            "",
            "C:\\Tools\\Burp\\burp.exe",
            "Burp Suite",
            "tool-\u{1b}[31m",
            long_install.as_str(),
        ] {
            let request = LaunchRequest {
                installation_id: bad,
                ..manual(OP)
            };
            assert_eq!(
                launch_recorded(&receipts, request, resolved(), |_| Ok(1)).unwrap_err(),
                "invalid_installation_id",
                "{bad:?}"
            );
        }
        assert!(receipts.list(10).is_empty());
    }

    #[test]
    fn display_names_are_bounded_and_stripped_of_control_characters() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let name = format!("Burp\u{1b}[31m{}", "x".repeat(400));
        let receipt = launch_recorded(&receipts, manual(OP), Ok(("p", name)), |_| Ok(1)).unwrap();
        assert!(!receipt.display_name.contains('\u{1b}'));
        assert_eq!(receipt.display_name.chars().count(), MAX_DISPLAY_NAME_CHARS);
    }

    #[test]
    fn the_ledger_keeps_the_newest_receipts_newest_first() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        for i in 0..(MAX_RECEIPTS + 5) {
            let op = format!("op-{i}");
            launch_recorded(&receipts, manual(&op), resolved(), |_| Ok(i as u32)).unwrap();
        }
        let all = receipts.list(usize::MAX);
        assert_eq!(all.len(), MAX_RECEIPTS);
        assert_eq!(all[0].operation_id, format!("op-{}", MAX_RECEIPTS + 4));
        assert_eq!(all.last().unwrap().operation_id, "op-5");
        assert_eq!(receipts.list(3).len(), 3);

        let reloaded = LaunchReceipts::load(temp.path(), quiet());
        assert_eq!(reloaded.list(usize::MAX), all);
    }

    fn kept_copies(lab: &Path) -> Vec<PathBuf> {
        fs::read_dir(lab)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("tool-launches.unreadable-"))
            })
            .collect()
    }

    #[test]
    fn a_corrupt_ledger_is_kept_and_the_ledger_starts_empty() {
        let temp = tempfile::tempdir().unwrap();
        let lab = temp.path().join("lab");
        fs::create_dir_all(&lab).unwrap();
        fs::write(lab.join(LEDGER_FILE), b"{ not json").unwrap();

        let receipts = LaunchReceipts::load(temp.path(), quiet());
        assert!(receipts.list(10).is_empty());
        let kept = kept_copies(&lab);
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(&kept[0]).unwrap(), b"{ not json");
        // Launching works again, and the next start keeps no second copy.
        launch_recorded(&receipts, manual(OP), resolved(), |_| Ok(5)).unwrap();
        let reloaded = LaunchReceipts::load(temp.path(), quiet());
        assert_eq!(reloaded.list(10).len(), 1);
        assert_eq!(kept_copies(&lab).len(), 1);
    }

    /// The start must not fail when the ledger cannot be read, and nothing
    /// may be written over it either.
    #[test]
    fn a_ledger_that_cannot_be_read_is_read_only_and_never_written() {
        let temp = tempfile::tempdir().unwrap();
        let lab = temp.path().join("lab");
        // A folder where the file belongs: reading it fails, and it is not
        // the kind of failure that means "no ledger yet".
        fs::create_dir_all(lab.join(LEDGER_FILE)).unwrap();

        let receipts = LaunchReceipts::load(temp.path(), quiet());

        assert!(receipts.list(10).is_empty());
        let err = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            panic!("a launch Rust cannot record must not happen")
        })
        .unwrap_err();
        assert_eq!(err, "launch_record_failed");
        assert!(lab.join(LEDGER_FILE).is_dir());
    }

    /// A ledger from a newer version is opened without being rewritten, even
    /// though a launch against it is then refused.
    #[test]
    fn a_newer_ledger_is_read_only_and_left_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let lab = temp.path().join("lab");
        fs::create_dir_all(&lab).unwrap();
        let newer = br#"{"version":2,"receipts":[],"extra":"kept"}"#;
        fs::write(lab.join(LEDGER_FILE), newer).unwrap();

        let receipts = LaunchReceipts::load(temp.path(), quiet());

        let err = launch_recorded(&receipts, manual(OP), resolved(), |_| {
            panic!("a launch Rust cannot record must not happen")
        })
        .unwrap_err();
        assert_eq!(err, "launch_record_failed");
        assert_eq!(fs::read(lab.join(LEDGER_FILE)).unwrap(), newer);
        assert!(kept_copies(&lab).is_empty());
    }

    #[test]
    fn the_wire_shape_matches_the_data_contract() {
        let temp = tempfile::tempdir().unwrap();
        let receipts = LaunchReceipts::load(temp.path(), quiet());
        let receipt = launch_recorded(&receipts, manual(OP), resolved(), |_| Ok(3)).unwrap();
        let wire = serde_json::to_value(&receipt).unwrap();
        let mut keys: Vec<_> = wire.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "displayName",
                "installationId",
                "launchId",
                "operationId",
                "origin",
                "outcome",
                "pid",
                "reasonCode",
                "recorded",
                "requestedAt",
                "spawnedAt",
                "tracking",
            ]
        );
        assert_eq!(wire["origin"], "manual");
    }
}
