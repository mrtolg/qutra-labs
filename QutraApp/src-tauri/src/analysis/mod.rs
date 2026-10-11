//! Built-in analysis of an investigation's files (spec 2026-10-07 §6.2).
//! An analyzer only reads the copy in the investigation's folder,
//! after its SHA-256 is checked again (§4.2), on a worker thread within a
//! size cap and a time budget; a panic ends that analysis only.
//! Nothing is ever run. Each analysis is a `builtin` run kept with its
//! observations in `<appData>\lab\analysis-runs.json` (store.rs), its raw
//! text output in `<appData>\lab\analysis\<run id>\output.txt`.

pub mod entropy;
pub mod identify;
pub mod image;
pub mod pe;
pub mod scan;
pub mod signatures;
pub mod store;
pub mod strings;

use std::{
    io,
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::investigation_files::InvestigationFile;
use scan::Budget;
use store::{AnalysisRun, AnalysisStore, Trigger};

/// The examples one observation keeps.
pub const MAX_ITEMS: usize = 20;
/// How long one analyzer may read.
const TIME_BUDGET: Duration = Duration::from_secs(60);
/// The raw output kept for one run.
const MAX_RAW_BYTES: usize = 2 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

type Analyze = fn(&Subject, &Budget) -> io::Result<Report>;

/// A built-in analyzer (§6.1): Rust is the source of truth.
pub struct Analyzer {
    pub id: &'static str,
    pub category: &'static str,
    /// The file kinds it reads; empty for every kind.
    pub accepts: &'static [&'static str],
    /// How much of a file it may read.
    pub cap: u64,
    analyze: Analyze,
}

impl Analyzer {
    pub fn accepts(&self, kind: &str) -> bool {
        self.accepts.is_empty() || self.accepts.contains(&kind)
    }
}

pub const ANALYZERS: &[Analyzer] = &[
    Analyzer {
        id: "identify",
        category: "identify",
        accepts: &[],
        cap: 4096,
        analyze: identify::analyze,
    },
    Analyzer {
        id: "pe",
        category: "structure",
        accepts: &["pe"],
        cap: 64 * MIB,
        analyze: pe::analyze,
    },
    Analyzer {
        id: "image",
        category: "structure",
        accepts: &["jpeg", "png"],
        cap: 64 * MIB,
        analyze: image::analyze,
    },
    Analyzer {
        id: "strings",
        category: "content",
        accepts: &[],
        cap: 64 * MIB,
        analyze: strings::analyze,
    },
    Analyzer {
        id: "entropy",
        category: "content",
        accepts: &[],
        cap: u64::MAX,
        analyze: entropy::analyze,
    },
    Analyzer {
        id: "signatures",
        category: "content",
        accepts: &[],
        cap: 256 * MIB,
        analyze: signatures::analyze,
    },
];

pub fn analyzer(id: &str) -> Option<&'static Analyzer> {
    ANALYZERS.iter().find(|analyzer| analyzer.id == id)
}

/// An analyzer as the page sees it.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub id: &'static str,
    pub category: &'static str,
    pub accepts: &'static [&'static str],
    pub risk: &'static str,
    pub execution: &'static str,
}

pub fn descriptors() -> Vec<Descriptor> {
    ANALYZERS
        .iter()
        .map(|analyzer| Descriptor {
            id: analyzer.id,
            category: analyzer.category,
            accepts: analyzer.accepts,
            risk: "read_only",
            execution: "builtin",
        })
        .collect()
}

/// Run `analyzer` on the verified copy at `path` and keep the run: finished
/// with its observations and raw output, or failed with its reason.
pub fn run(
    store: &AnalysisStore,
    file: &InvestigationFile,
    path: &Path,
    analyzer: &Analyzer,
) -> Result<AnalysisRun, String> {
    let id = format!("ana-{}", uuid::Uuid::new_v4());
    let started_at = now_ms();
    let subject = Subject {
        path,
        kind: &file.kind,
        extension: extension_of(&file.original_name),
    };
    let budget = Budget::new(TIME_BUDGET, analyzer.cap);
    let outcome = catch_unwind(AssertUnwindSafe(|| (analyzer.analyze)(&subject, &budget)));
    let mut run = AnalysisRun {
        id: id.clone(),
        kind: "builtin".into(),
        engagement_id: file.engagement_id.clone(),
        file_id: file.id.clone(),
        analyzer: analyzer.id.into(),
        state: "failed".into(),
        started_at,
        ended_at: started_at,
        trigger: Trigger::user(),
        file_sha256: file.sha256.clone(),
        limited: false,
        error: None,
        observations: Vec::new(),
        outputs: Vec::new(),
    };
    match outcome {
        Ok(Ok(report)) => {
            let output = match store.write_output(&id, &raw_output(file, analyzer.id, &report)) {
                Ok(output) => output,
                Err(error) => {
                    store.discard_output(&id);
                    return Err(error);
                }
            };
            run.state = "finished".into();
            run.limited = report.limited;
            run.observations = report
                .facts
                .into_iter()
                .enumerate()
                .map(|(n, fact)| Observation {
                    id: format!("{id}:{n}"),
                    key: fact.key.into(),
                    value: fact.value,
                    group: fact.group,
                    hint: fact.hint.map(Into::into),
                    items: fact.items,
                })
                .collect();
            run.outputs = vec![output];
        }
        Ok(Err(_)) => run.error = Some("read_failed".into()),
        Err(_) => run.error = Some("analyzer_failed".into()),
    }
    run.ended_at = now_ms();
    if let Err(error) = store.record(run.clone()) {
        store.discard_output(&id);
        return Err(error);
    }
    Ok(run)
}

fn raw_output(file: &InvestigationFile, analyzer: &str, report: &Report) -> String {
    let mut raw = format!(
        "Qutra Labs built-in analysis: {analyzer}\nFile: {} ({} bytes)\nSHA-256: {}\n",
        file.name, file.bytes, file.sha256
    );
    if report.limited {
        raw.push_str("Stopped at a size or time limit: part of the file was not read.\n");
    }
    raw.push('\n');
    raw.push_str(&report.body);
    if raw.len() > MAX_RAW_BYTES {
        let mut cut = MAX_RAW_BYTES;
        while !raw.is_char_boundary(cut) {
            cut -= 1;
        }
        raw.truncate(cut);
        raw.push_str("\n… cut at 2 MiB\n");
    }
    raw
}

/// The extension of the user's file name, when it is plain ASCII letters
/// and digits: one holding direction marks or other characters is shown to
/// nobody and promises nothing.
fn extension_of(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let plain = !stem.is_empty()
        && !ext.is_empty()
        && ext.len() <= 16
        && ext.bytes().all(|b| b.is_ascii_alphanumeric());
    plain.then(|| ext.to_ascii_lowercase())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Where an observation shows (§5.3): the counts, what stands out, the rest.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Summary,
    Interesting,
    Detail,
}

/// One fact an analysis found.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// `<run id>:<n>`, for evidence to point at.
    pub id: String,
    /// What it is, for the page to label: "entropy.file", "strings.urls"…
    pub key: String,
    /// A number or a short text.
    pub value: Value,
    pub group: Group,
    /// Why it stands out, for the page to say: "packed", "embeddedExecutable"…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Examples (addresses, offsets), at most `MAX_ITEMS`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
}

/// Text read from a file, safe to show and store: no control characters,
/// direction marks or invisible characters (they could make a name read as
/// something else), at most 200 characters, trimmed.
pub(crate) fn clean_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '\u{00AD}'
                        | '\u{061C}'
                        | '\u{180E}'
                        | '\u{200B}'..='\u{200F}'
                        | '\u{2028}'..='\u{202E}'
                        | '\u{2060}'..='\u{2069}'
                        | '\u{FEFF}'
                        | '\u{E0000}'..='\u{E007F}'
                )
        })
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}

/// An observation before its run has an id.
#[derive(Debug, Clone, PartialEq)]
pub struct Fact {
    pub key: &'static str,
    pub value: Value,
    pub group: Group,
    pub hint: Option<&'static str>,
    pub items: Vec<String>,
}

impl Fact {
    pub fn new(group: Group, key: &'static str, value: impl Into<Value>) -> Self {
        Self {
            key,
            value: value.into(),
            group,
            hint: None,
            items: Vec::new(),
        }
    }

    pub fn hint(mut self, hint: &'static str) -> Self {
        self.hint = Some(hint);
        self
    }

    pub fn items(mut self, items: Vec<String>) -> Self {
        self.items = items.into_iter().take(MAX_ITEMS).collect();
        self
    }
}

/// What an analyzer found: its facts, a text body for the raw output, and
/// whether a limit stopped it before the end of the file.
#[derive(Debug, Default)]
pub struct Report {
    pub facts: Vec<Fact>,
    pub body: String,
    pub limited: bool,
}

/// The file an analyzer reads.
pub struct Subject<'a> {
    pub path: &'a Path,
    /// The kind `detect_kind` gave the file when it was added.
    pub kind: &'a str,
    /// The extension of the name the user's file had, in lower case.
    pub extension: Option<String>,
}

#[cfg(test)]
pub(crate) mod testing {
    use super::{scan::Budget, Subject};
    use std::{path::PathBuf, time::Duration};

    pub struct Sample {
        _dir: tempfile::TempDir,
        pub path: PathBuf,
    }

    pub fn sample(bytes: &[u8]) -> Sample {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.bin");
        std::fs::write(&path, bytes).unwrap();
        Sample { _dir: dir, path }
    }

    pub fn subject<'a>(sample: &'a Sample, kind: &'a str, extension: Option<&str>) -> Subject<'a> {
        Subject {
            path: &sample.path,
            kind,
            extension: extension.map(str::to_string),
        }
    }

    pub fn budget() -> Budget {
        Budget::new(Duration::from_secs(30), u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    fn file(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, InvestigationFile) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sample.bin");
        std::fs::write(&path, bytes).unwrap();
        let record = InvestigationFile {
            id: "file_1".into(),
            engagement_id: "eng_1".into(),
            rel_path: "files/sample.bin".into(),
            name: "sample.bin".into(),
            original_name: "sample.bin".into(),
            bytes: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            sha1: String::new(),
            md5: String::new(),
            kind: "binary".into(),
            sample: false,
            source: "picked".into(),
            added_at: 1,
        };
        (temp, path, record)
    }

    #[test]
    fn a_run_keeps_its_observations_and_its_hashed_output() {
        let (temp, path, record) = file(&[0u8; 5000]);
        let store = AnalysisStore::load(&temp.path().join("appdata"));
        let run = run(&store, &record, &path, analyzer("entropy").unwrap()).unwrap();
        assert_eq!(
            (run.state.as_str(), run.kind.as_str(), run.analyzer.as_str()),
            ("finished", "builtin", "entropy")
        );
        assert_eq!(run.observations[0].id, format!("{}:0", run.id));
        assert_eq!(run.observations[0].key, "entropy.file");
        let raw = store.read_output(&run.id).unwrap();
        assert!(
            raw.starts_with("Qutra Labs built-in analysis: entropy\nFile: sample.bin (5000 bytes)")
        );
        assert_eq!(
            run.outputs[0].sha256,
            hex::encode(Sha256::digest(raw.as_bytes()))
        );
        assert_eq!(store.list("eng_1").unwrap(), vec![run]);
    }

    #[test]
    fn a_panicking_analyzer_fails_its_run_only() {
        let (temp, path, record) = file(b"abc");
        let store = AnalysisStore::load(&temp.path().join("appdata"));
        let broken = Analyzer {
            id: "broken",
            category: "test",
            accepts: &[],
            cap: 10,
            analyze: |_, _| panic!("boom"),
        };
        let run = run(&store, &record, &path, &broken).unwrap();
        assert_eq!(
            (run.state.as_str(), run.error.as_deref()),
            ("failed", Some("analyzer_failed"))
        );
        assert!(run.outputs.is_empty());
        assert_eq!(store.read_output(&run.id).err(), Some("unknown_run".into()));
    }

    #[test]
    fn descriptors_say_built_in_and_read_only() {
        let all = descriptors();
        let ids: Vec<&str> = all.iter().map(|descriptor| descriptor.id).collect();
        assert_eq!(
            ids,
            vec![
                "identify",
                "pe",
                "image",
                "strings",
                "entropy",
                "signatures"
            ]
        );
        assert!(analyzer("image").unwrap().accepts("png"));
        assert!(analyzer("pe").unwrap().accepts("pe"));
        assert!(!analyzer("pe").unwrap().accepts("elf"));
        assert!(all
            .iter()
            .all(|descriptor| descriptor.risk == "read_only" && descriptor.execution == "builtin"));
        assert_eq!(
            serde_json::to_value(&all[0]).unwrap()["accepts"],
            serde_json::json!([])
        );
        assert_eq!(extension_of("Report.PDF").as_deref(), Some("pdf"));
        assert_eq!(extension_of(".hidden"), None);
        assert_eq!(extension_of("photo.jp\u{202E}g"), None);
        assert_eq!(clean_text(" Canon\u{0}\u{202E} EOS\n"), "Canon EOS");
        assert_eq!(
            clean_text("ker\u{200B}nel32\u{FEFF}.dll\u{E0041}"),
            "kernel32.dll"
        );
        assert_eq!(
            extension_of("invoice\u{202E}fdp.exe").as_deref(),
            Some("exe")
        );
    }
}
