//! The built-in runs: `<appData>\lab\analysis-runs.json`, and each
//! run's raw output under `<appData>\lab\analysis\<run id>\`. An unreadable
//! store is kept beside it and never written over; one from a newer version
//! is read but not written.

use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Observation;
use crate::engagement_folders::validate_engagement_id;

const LAB_DIR: &str = "lab";
const STORE_FILE: &str = "analysis-runs.json";
const STORE_VERSION: u32 = 1;
const OUTPUT_DIR: &str = "analysis";
const OUTPUT_FILE: &str = "output.txt";

/// Who started a run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    /// "user" | "assistant" | "legacy": a run kept before triggers
    /// were recorded, so nobody can say who started it.
    pub by: String,
    /// The approval card that allowed an assistant's run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// The conversation an assistant's run came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

impl Trigger {
    /// Started by the user's own click.
    pub fn user() -> Self {
        Self {
            by: "user".into(),
            approval_id: None,
            conversation_id: None,
        }
    }

    pub fn legacy() -> Self {
        Self {
            by: "legacy".into(),
            ..Self::user()
        }
    }
}

/// What a record without a trigger reads as: it predates them.
impl Default for Trigger {
    fn default() -> Self {
        Self::legacy()
    }
}

/// A file a run wrote, hashed when written.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub name: String,
    /// Under `<appData>\lab`: `analysis/<run id>/output.txt`.
    pub rel_path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// One built-in analysis of one file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRun {
    pub id: String,
    /// "builtin"; external runs stay in the tool supervisor's ledger.
    pub kind: String,
    pub engagement_id: String,
    pub file_id: String,
    pub analyzer: String,
    /// "finished" | "failed"
    pub state: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub trigger: Trigger,
    /// The copy's SHA-256, checked again before this run read it.
    pub file_sha256: String,
    /// A size cap or the time budget stopped the analyzer before the end.
    pub limited: bool,
    /// Why a failed run failed: "read_failed" | "analyzer_failed".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub observations: Vec<Observation>,
    pub outputs: Vec<RunOutput>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Store {
    version: u32,
    runs: Vec<AnalysisRun>,
}

impl Store {
    fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            runs: Vec::new(),
        }
    }
}

pub struct AnalysisStore {
    lab_dir: PathBuf,
    /// False when writing would replace runs this version cannot see.
    writable: bool,
    data: Mutex<Store>,
    /// Files with an analysis in progress.
    busy: Mutex<HashSet<String>>,
}

/// One file's analysis in progress; dropping it frees the file.
pub struct Claim<'a> {
    store: &'a AnalysisStore,
    file_id: String,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.store.busy.lock() {
            busy.remove(&self.file_id);
        }
    }
}

impl AnalysisStore {
    pub fn load(app_data: &Path) -> Self {
        let lab_dir = app_data.join(LAB_DIR);
        let path = lab_dir.join(STORE_FILE);
        let (data, writable) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Store>(&bytes) {
                Ok(store) if store.version <= STORE_VERSION => (store, true),
                Ok(store) => {
                    eprintln!(
                        "[Qutra Labs] analysis runs are from a newer version ({})",
                        store.version
                    );
                    (store, false)
                }
                Err(_) => {
                    // Kept beside the store first; the empty store written
                    // next stops the next start from setting it aside again.
                    let kept = set_aside(&path, &bytes);
                    if kept {
                        if let Err(error) = write_store(&path, &Store::empty()) {
                            eprintln!("[Qutra Labs] analysis runs not reset: {error}");
                        }
                    }
                    (Store::empty(), kept)
                }
            },
            Err(err) if err.kind() == io::ErrorKind::NotFound => (Store::empty(), true),
            Err(err) => {
                eprintln!("[Qutra Labs] analysis runs unreadable: {err}");
                (Store::empty(), false)
            }
        };
        Self {
            lab_dir,
            writable,
            data: Mutex::new(data),
            busy: Mutex::new(HashSet::new()),
        }
    }

    /// The investigation's runs, newest first.
    pub fn list(&self, engagement_id: &str) -> Result<Vec<AnalysisRun>, String> {
        validate_engagement_id(engagement_id)?;
        let data = self.data.lock().map_err(|_| "analysis_lock_failed")?;
        let mut runs: Vec<AnalysisRun> = data
            .runs
            .iter()
            .filter(|run| run.engagement_id == engagement_id)
            .cloned()
            .collect();
        runs.sort_by_key(|run| std::cmp::Reverse(run.started_at));
        Ok(runs)
    }

    /// Hold `file_id` while it is analysed; `busy` when it already is.
    pub fn claim(&self, file_id: &str) -> Result<Claim<'_>, String> {
        let mut busy = self.busy.lock().map_err(|_| "analysis_lock_failed")?;
        if !busy.insert(file_id.to_string()) {
            return Err("busy".into());
        }
        Ok(Claim {
            store: self,
            file_id: file_id.to_string(),
        })
    }

    pub fn record(&self, run: AnalysisRun) -> Result<(), String> {
        if !self.writable {
            return Err("analysis_store_read_only".into());
        }
        let mut data = self.data.lock().map_err(|_| "analysis_lock_failed")?;
        data.runs.push(run);
        if let Err(error) = write_store(&self.lab_dir.join(STORE_FILE), &data) {
            data.runs.pop();
            return Err(error);
        }
        Ok(())
    }

    /// Write a run's raw output and hash it.
    pub fn write_output(&self, run_id: &str, text: &str) -> Result<RunOutput, String> {
        let dir = self.lab_dir.join(OUTPUT_DIR).join(valid_run_id(run_id)?);
        fs::create_dir_all(&dir).map_err(io_error)?;
        crate::durable_file::replace_file(&dir.join(OUTPUT_FILE), text.as_bytes())
            .map_err(io_error)?;
        Ok(RunOutput {
            name: OUTPUT_FILE.into(),
            rel_path: format!("{OUTPUT_DIR}/{run_id}/{OUTPUT_FILE}"),
            sha256: hex::encode(Sha256::digest(text.as_bytes())),
            bytes: text.len() as u64,
        })
    }

    /// Remove an output no run points at (its record could not be saved).
    pub fn discard_output(&self, run_id: &str) {
        if let Ok(id) = valid_run_id(run_id) {
            let _ = fs::remove_dir_all(self.lab_dir.join(OUTPUT_DIR).join(id));
        }
    }

    /// The raw output of a run this store keeps.
    pub fn read_output(&self, run_id: &str) -> Result<String, String> {
        let known = {
            let data = self.data.lock().map_err(|_| "analysis_lock_failed")?;
            data.runs
                .iter()
                .any(|run| run.id == run_id && !run.outputs.is_empty())
        };
        if !known {
            return Err("unknown_run".into());
        }
        let path = self
            .lab_dir
            .join(OUTPUT_DIR)
            .join(valid_run_id(run_id)?)
            .join(OUTPUT_FILE);
        // Bytes that are no longer UTF-8 still come back, with replacement
        // characters, so a check of the evidence's hash says "changed".
        fs::read(path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|_| "output_missing".to_string())
    }
}

/// `ana-` and a UUID: the only names an output folder may have.
fn valid_run_id(run_id: &str) -> Result<&str, String> {
    let ok = run_id.strip_prefix("ana-").is_some_and(|rest| {
        rest.len() == 36 && rest.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    });
    if ok {
        Ok(run_id)
    } else {
        Err("invalid_run_id".into())
    }
}

fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(io_error)?;
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|_| "analysis_serialize_failed")?;
    crate::durable_file::replace_file(path, &bytes).map_err(io_error)
}

/// Keep an unreadable store beside it; true when it is safe to replace it.
fn set_aside(path: &Path, bytes: &[u8]) -> bool {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let aside = path.with_file_name(format!("analysis-runs.unreadable-{millis}.json"));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&aside)
        .and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()))
    {
        Ok(()) => {
            eprintln!(
                "[Qutra Labs] analysis runs unreadable; kept as {}",
                aside.display()
            );
            true
        }
        Err(err) => {
            eprintln!("[Qutra Labs] analysis runs unreadable and not set aside: {err}");
            false
        }
    }
}

fn io_error(err: io::Error) -> String {
    format!("io_error: {}", err.kind())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, engagement: &str, started_at: u64) -> AnalysisRun {
        AnalysisRun {
            id: id.into(),
            kind: "builtin".into(),
            engagement_id: engagement.into(),
            file_id: "file_1".into(),
            analyzer: "entropy".into(),
            state: "finished".into(),
            started_at,
            ended_at: started_at + 1,
            trigger: Trigger::user(),
            file_sha256: "ab".repeat(32),
            limited: false,
            error: None,
            observations: Vec::new(),
            outputs: Vec::new(),
        }
    }

    const A: &str = "ana-00000000-0000-4000-8000-000000000001";
    const B: &str = "ana-00000000-0000-4000-8000-000000000002";

    #[test]
    fn runs_are_listed_newest_first_for_their_investigation() {
        let temp = tempfile::tempdir().unwrap();
        let store = AnalysisStore::load(temp.path());
        store.record(run(A, "eng_1", 10)).unwrap();
        store.record(run(B, "eng_1", 20)).unwrap();
        store
            .record(run("ana-00000000-0000-4000-8000-000000000003", "eng_2", 30))
            .unwrap();

        let ids: Vec<String> = store
            .list("eng_1")
            .unwrap()
            .into_iter()
            .map(|run| run.id)
            .collect();
        assert_eq!(ids, vec![B.to_string(), A.to_string()]);
        // Kept across a restart.
        assert_eq!(
            AnalysisStore::load(temp.path())
                .list("eng_1")
                .unwrap()
                .len(),
            2
        );
        assert!(store.list("../x").is_err());
    }

    #[test]
    fn a_file_is_analysed_once_at_a_time() {
        let temp = tempfile::tempdir().unwrap();
        let store = AnalysisStore::load(temp.path());
        let claim = store.claim("file_1").unwrap();
        assert_eq!(store.claim("file_1").err(), Some("busy".to_string()));
        assert!(store.claim("file_2").is_ok());
        drop(claim);
        assert!(store.claim("file_1").is_ok());
    }

    #[test]
    fn an_output_is_hashed_and_read_back_only_for_a_known_run() {
        let temp = tempfile::tempdir().unwrap();
        let store = AnalysisStore::load(temp.path());
        let output = store.write_output(A, "abc").unwrap();
        assert_eq!(
            output.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            (output.bytes, output.rel_path.as_str()),
            (
                3,
                "analysis/ana-00000000-0000-4000-8000-000000000001/output.txt"
            )
        );
        // Not recorded yet: nothing is handed out.
        assert_eq!(store.read_output(A).err(), Some("unknown_run".to_string()));
        let mut recorded = run(A, "eng_1", 1);
        recorded.outputs.push(output);
        store.record(recorded).unwrap();
        assert_eq!(store.read_output(A).unwrap(), "abc");
        // Edited into bytes that are not UTF-8: still read, and different.
        fs::write(
            temp.path()
                .join(LAB_DIR)
                .join(OUTPUT_DIR)
                .join(A)
                .join(OUTPUT_FILE),
            b"ab\xffc",
        )
        .unwrap();
        assert_eq!(store.read_output(A).unwrap(), "ab\u{fffd}c");
        assert_eq!(
            store.write_output("..\\x", "y").err(),
            Some("invalid_run_id".to_string())
        );
    }

    #[test]
    fn an_unreadable_store_is_set_aside_and_not_written_over() {
        let temp = tempfile::tempdir().unwrap();
        let lab = temp.path().join(LAB_DIR);
        fs::create_dir_all(&lab).unwrap();
        fs::write(lab.join(STORE_FILE), b"{not json").unwrap();

        let store = AnalysisStore::load(temp.path());
        assert!(store.list("eng_1").unwrap().is_empty());
        let aside: Vec<_> = fs::read_dir(&lab)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("analysis-runs.unreadable-")
            })
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read(aside[0].path()).unwrap(), b"{not json");
        store.record(run(A, "eng_1", 1)).unwrap();
    }
}
