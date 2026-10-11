//! Purpose-built run forms for known tools. One data file,
//! `src/domain/tools/toolForms.json`, describes
//! each tool: the program's file names, its fields (a target, a port list, an
//! investigation file, a rules file, a number) and its presets, each a fixed
//! argument list with `{field}` placeholders. The page draws its form from
//! the same file; Rust builds the argument list.
//!
//! The page names a form, a preset and the values typed into the fields. It
//! never sends a flag or a path: a flag comes from the preset, a file is named
//! by its investigation id and handed over as its verified copy, the folder
//! of the investigation's files and the place an output file is written are
//! chosen here. A value is checked against its field before it reaches the
//! argument list, and no value may start with `-`, so none can pass for a
//! flag. A form runs only the program it was written for (its executable's
//! file name), and a preset with a target still needs the investigation's
//! scope decision, which the supervisor checks as for any run.

use std::{collections::BTreeMap, fs, path::PathBuf, sync::OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    analysis::store::Trigger,
    engagement_folders::display_path,
    external_tools::{refuse_includes, States},
    investigation_files::FILES_DIR,
    tool_registry::{now_ms, ToolInstallationRecord},
    tool_supervisor::{
        EnvironmentInput, EventSink, NativeToolRun, RunOrigin, RunSubject, ScopeAttestation,
        StartToolRunRequest,
    },
};

const FORMS_JSON: &str = include_str!("../../src/domain/tools/toolForms.json");
/// Where a preset that writes a file (editcap, mergecap, text2pcap) writes
/// it, inside the investigation's folder.
pub const OUTPUT_DIR: &str = "tool-output";
const DEFAULT_TEXT_MAX: usize = 256;
const OUTPUT_LIMIT_BYTES: u64 = 4 * 1024 * 1024;
/// The text a tool reads its paths from (ExifTool's `-@ -`) stays far inside
/// the supervisor's standard input cap.
const MAX_STDIN_PATHS_BYTES: usize = 2000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormsFile {
    pub version: u32,
    pub forms: Vec<Form>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Form {
    pub id: String,
    /// The program's file names, in any case.
    pub executables: Vec<String>,
    pub timeout_sec: u64,
    /// The test program that checks the run path, not an investigation tool.
    /// The page labels it; Rust only accepts the field.
    #[serde(default)]
    #[allow(dead_code)]
    pub fixture: bool,
    /// Variables that keep the tool offline or its output in UTF-8.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub fields: Vec<Field>,
    pub presets: Vec<Preset>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    /// A host, address or network, checked against the scope.
    Target,
    /// Ports and ranges: `22,80,8000-8100`.
    Ports,
    Int,
    Text,
    /// One of the investigation's files, by id.
    File,
    /// The folder of the investigation's files; nothing to type.
    Folder,
    /// A new file in the investigation's `tool-output` folder; nothing to type.
    Output,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: FieldType,
    /// Every field a preset names must have a value (typed or its default);
    /// the page marks the required ones.
    #[serde(default)]
    #[allow(dead_code)]
    pub required: bool,
    #[serde(default)]
    pub default: String,
    /// File kinds (`detect_kind` codes) a file field takes; empty for any.
    #[serde(default)]
    pub accepts: Vec<String>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    /// A text value must match it whole.
    pub pattern: Option<String>,
    pub max_len: Option<usize>,
    /// An output file's extension.
    pub ext: Option<String>,
    /// A YARA rules file: refused when it uses `include`.
    #[serde(default)]
    pub no_includes: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    pub id: String,
    /// How the page reads the output: nmap-xml, json, jsonl, csv, keyvalue,
    /// lines or text.
    #[allow(dead_code)]
    pub output: String,
    pub argv: Vec<String>,
    /// "gui": the program opens its own window; the page launches it the way
    /// it launches any windowed tool, with no arguments.
    pub launch: Option<String>,
    /// The hosts a preset reaches (a database download). The page says them
    /// on the form before the click; Rust only accepts the field.
    #[allow(dead_code)]
    pub network: Option<String>,
    /// File paths outside ASCII go to the tool's standard input (`-@ -`).
    #[serde(default)]
    pub stdin_paths: bool,
}

/// The forms, read once from the data file. A broken file is a build-time
/// mistake the tests catch, so reading it panics with the reason.
pub fn forms() -> &'static [Form] {
    static FORMS: OnceLock<Vec<Form>> = OnceLock::new();
    FORMS.get_or_init(|| {
        let file: FormsFile = serde_json::from_str(FORMS_JSON).expect("toolForms.json is valid");
        assert_eq!(file.version, 1, "toolForms.json is version 1");
        file.forms
    })
}

fn placeholder() -> &'static Regex {
    static PLACEHOLDER: OnceLock<Regex> = OnceLock::new();
    PLACEHOLDER.get_or_init(|| Regex::new(r"\{([A-Za-z0-9]+)\}").expect("a valid pattern"))
}

/// The field ids a preset's arguments name, in order, each once.
pub fn used_fields(preset: &Preset) -> Vec<String> {
    let mut used: Vec<String> = Vec::new();
    for token in &preset.argv {
        for found in placeholder().captures_iter(token) {
            let id = found[1].to_string();
            if !used.contains(&id) {
                used.push(id);
            }
        }
    }
    used
}

/// True when `record` is a program `form` was written for.
pub fn form_fits(form: &Form, record: &ToolInstallationRecord) -> bool {
    let file = record
        .canonical_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default();
    form.executables
        .iter()
        .any(|name| name.eq_ignore_ascii_case(file))
}

/// An investigation file as a form gets it: its record's facts and the path
/// of its verified copy.
pub struct ResolvedFile {
    pub id: String,
    pub sha256: String,
    pub path: String,
}

/// Where a form's files come from. The command reads the investigation; a
/// test gives its own.
pub trait Inputs {
    /// The verified copy of file `id`, if its kind is one `field` accepts.
    fn file(&self, field: &Field, id: &str) -> Result<ResolvedFile, String>;
    /// The folder of the investigation's files.
    fn folder(&self) -> Result<String, String>;
    /// A new output file's path and its name to show.
    fn output(&self, name: &str) -> Result<(String, String), String>;
}

/// A preset's argument list, ready for the supervisor.
#[derive(Debug, Default)]
pub struct Built {
    pub argv: Vec<String>,
    pub stdin: Option<Vec<u8>>,
    pub subject: Option<RunSubject>,
    /// The target value, when the preset has one: the scope applies.
    pub target: Option<String>,
    /// The output file's name, when the preset writes one.
    pub output_name: Option<String>,
}

fn invalid(field: &str) -> String {
    format!("field_invalid:{field}")
}

fn required(field: &str) -> String {
    format!("field_required:{field}")
}

fn valid_target(value: &str) -> bool {
    static TARGET: OnceLock<Regex> = OnceLock::new();
    TARGET
        .get_or_init(|| {
            Regex::new(r"^[A-Za-z0-9:\[][A-Za-z0-9.:_/\[\]%-]{0,252}$").expect("a valid pattern")
        })
        .is_match(value)
}

fn valid_ports(value: &str) -> bool {
    let parts: Vec<&str> = value.split(',').collect();
    if parts.is_empty() || parts.len() > 100 {
        return false;
    }
    parts.iter().all(|part| {
        let mut ends = part.splitn(2, '-');
        let low = ends.next().unwrap_or_default();
        let high = ends.next();
        let port = |text: &str| {
            (!text.is_empty() && text.len() <= 5 && text.bytes().all(|b| b.is_ascii_digit()))
                .then(|| text.parse::<u32>().ok())
                .flatten()
                .filter(|n| (1..=65535).contains(n))
        };
        match (port(low), high.map(port)) {
            (Some(_), None) => true,
            (Some(low), Some(Some(high))) => low <= high,
            _ => false,
        }
    })
}

/// A typed value checked against its field: the same rules the page shows.
pub fn check_value(field: &Field, value: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) || value.starts_with('-') {
        return Err(invalid(&field.id));
    }
    let ok = match field.kind {
        FieldType::Target => valid_target(value),
        FieldType::Ports => valid_ports(value),
        FieldType::Int => value.parse::<i64>().is_ok_and(|n| {
            field.min.is_none_or(|min| n >= min) && field.max.is_none_or(|max| n <= max)
        }),
        FieldType::Text => {
            value.chars().count() <= field.max_len.unwrap_or(DEFAULT_TEXT_MAX)
                && field.pattern.as_deref().is_none_or(|pattern| {
                    Regex::new(pattern).is_ok_and(|regex| regex.is_match(value))
                })
        }
        // An investigation file's id.
        FieldType::File => {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        }
        FieldType::Folder | FieldType::Output => true,
    };
    if ok {
        Ok(())
    } else {
        Err(invalid(&field.id))
    }
}

/// Build `preset` of `form` from the typed `values`. Every field the preset
/// names must have a value (typed or its default) that passes its check.
pub fn build(
    form: &Form,
    preset: &Preset,
    values: &BTreeMap<String, String>,
    inputs: &dyn Inputs,
) -> Result<Built, String> {
    let mut built = Built::default();
    let mut substitutions: BTreeMap<String, String> = BTreeMap::new();
    let mut file_paths: Vec<String> = Vec::new();
    let mut subject = RunSubject {
        file_id: None,
        file_sha256: None,
        rules_file_id: None,
        rules_sha256: None,
    };
    for id in used_fields(preset) {
        let field = form
            .fields
            .iter()
            .find(|field| field.id == id)
            .ok_or_else(|| "form_broken".to_string())?;
        let value = match field.kind {
            FieldType::Folder => inputs.folder()?,
            FieldType::Output => {
                let ext = field.ext.as_deref().unwrap_or("out");
                let name = format!("{}-{}-{}.{ext}", form.id, preset.id, stamp(now_ms()));
                let (path, shown) = inputs.output(&name)?;
                built.output_name = Some(shown);
                path
            }
            _ => {
                let typed = values.get(&id).map(|value| value.trim()).unwrap_or("");
                let value = if typed.is_empty() {
                    field.default.trim()
                } else {
                    typed
                };
                if value.is_empty() {
                    return Err(required(&id));
                }
                check_value(field, value)?;
                if field.kind == FieldType::File {
                    let file = inputs.file(field, value)?;
                    if field.no_includes {
                        subject.rules_file_id = Some(file.id.clone());
                        subject.rules_sha256 = Some(file.sha256.clone());
                    } else if subject.file_id.is_none() {
                        subject.file_id = Some(file.id.clone());
                        subject.file_sha256 = Some(file.sha256.clone());
                    }
                    file_paths.push(file.path.clone());
                    file.path
                } else {
                    if field.kind == FieldType::Target {
                        built.target = Some(value.to_string());
                    }
                    value.to_string()
                }
            }
        };
        substitutions.insert(id, value);
    }

    // A tool that cannot take a path outside ASCII on its command line reads
    // it from standard input instead.
    let via_stdin = preset.stdin_paths && file_paths.iter().any(|path| !path.is_ascii());
    let mut argv = Vec::with_capacity(preset.argv.len() + 2);
    for token in &preset.argv {
        let whole_file = placeholder()
            .captures(token)
            .filter(|found| found.get(0).is_some_and(|m| m.as_str() == token))
            .and_then(|found| form.fields.iter().find(|field| field.id == found[1]))
            .is_some_and(|field| field.kind == FieldType::File);
        if via_stdin && whole_file {
            continue;
        }
        let filled = placeholder().replace_all(token, |found: &regex::Captures| {
            substitutions.get(&found[1]).cloned().unwrap_or_default()
        });
        argv.push(filled.into_owned());
    }
    if via_stdin {
        let text: String = file_paths.iter().map(|path| format!("{path}\n")).collect();
        if text.len() > MAX_STDIN_PATHS_BYTES {
            return Err("input_too_large".into());
        }
        argv.push("-@".into());
        argv.push("-".into());
        built.stdin = Some(text.into_bytes());
    }
    built.argv = argv;
    if subject.file_id.is_some() || subject.rules_file_id.is_some() {
        built.subject = Some(subject);
    }
    Ok(built)
}

/// `20261010-142233` (UTC) for an output file's name.
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (hh, mm, ss) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{hh:02}{mm:02}{ss:02}")
}

/// The investigation's files and folder, read for one run.
struct InvestigationInputs<'a> {
    states: &'a States<'a>,
    engagement_id: Option<&'a str>,
}

impl InvestigationInputs<'_> {
    fn folder_path(&self) -> Result<(String, PathBuf), String> {
        let engagement_id = self.engagement_id.ok_or("no_engagement")?;
        let folder = self
            .states
            .folders
            .folder_path(engagement_id)?
            .ok_or("no_engagement_folder")?;
        Ok((engagement_id.to_string(), folder))
    }
}

impl Inputs for InvestigationInputs<'_> {
    fn file(&self, field: &Field, id: &str) -> Result<ResolvedFile, String> {
        let (engagement_id, folder) = self.folder_path()?;
        // The kind is checked from the record before the copy is hashed.
        let views = self.states.files.list(&engagement_id, Some(&folder))?;
        let view = views
            .iter()
            .find(|view| view.file.id == id)
            .ok_or("unknown_file")?;
        if !field.accepts.is_empty() && !field.accepts.contains(&view.file.kind) {
            return Err(format!("file_kind_not_accepted:{}", field.id));
        }
        let (file, path) = self
            .states
            .files
            .verified_copy(&folder, &engagement_id, id)?;
        if field.no_includes {
            refuse_includes(&path)?;
        }
        Ok(ResolvedFile {
            id: file.id,
            sha256: file.sha256,
            path: display_path(&path),
        })
    }

    fn folder(&self) -> Result<String, String> {
        let (_, folder) = self.folder_path()?;
        let files = folder.join(FILES_DIR);
        if !files.is_dir() {
            return Err("investigation_has_no_files".into());
        }
        Ok(display_path(&files))
    }

    fn output(&self, name: &str) -> Result<(String, String), String> {
        let (_, folder) = self.folder_path()?;
        let dir = folder.join(OUTPUT_DIR);
        fs::create_dir_all(&dir).map_err(|_| "output_folder_unwritable".to_string())?;
        let path = dir.join(name);
        Ok((display_path(&path), format!("{OUTPUT_DIR}\\{name}")))
    }
}

/// The scope decision a run carries. Without a target there is none, and
/// one the page sent is dropped. With a target it must be a decision about
/// that same target; without one the supervisor refuses the run
/// (`authorization_scope_required`), since the run asks for scope.
fn scope_for(
    target: Option<&str>,
    scope: Option<ScopeAttestation>,
) -> Result<Option<ScopeAttestation>, String> {
    match (target, scope) {
        (Some(target), Some(scope)) if scope.target != target => {
            Err("scope_target_argument_mismatch".into())
        }
        (Some(_), scope) => Ok(scope),
        (None, _) => Ok(None),
    }
}

/// What the page asks `tool_form_run` for: ids and typed values only.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormRunRequest {
    pub installation_id: String,
    pub form_id: String,
    pub preset_id: String,
    #[serde(default)]
    pub engagement_id: Option<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub scope: Option<ScopeAttestation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormRunStarted {
    pub run: NativeToolRun,
    /// `tool-output\<name>` when the preset writes a file.
    pub output_name: Option<String>,
}

/// `tool_form_run`: start a preset of a form on its registered program. It
/// refuses in order: Private Lab, the form and preset, the program (a form
/// runs only the program it was written for), the values, then the files.
/// The run starts and comes back at once, or comes back `blocked` when the
/// supervisor refuses it (a stale scope decision, a changed program).
pub fn command_run(
    states: &States,
    request: FormRunRequest,
    events: EventSink,
) -> Result<FormRunStarted, String> {
    states.consent.require()?;
    let form = forms()
        .iter()
        .find(|form| form.id == request.form_id)
        .ok_or("unknown_form")?;
    let preset = form
        .presets
        .iter()
        .find(|preset| preset.id == request.preset_id)
        .ok_or("unknown_preset")?;
    if preset.launch.as_deref() == Some("gui") {
        return Err("preset_opens_window".into());
    }
    let record = states.supervisor.get_tool(&request.installation_id)?;
    if !form_fits(form, &record) {
        return Err("form_not_for_tool".into());
    }
    let inputs = InvestigationInputs {
        states,
        engagement_id: request.engagement_id.as_deref(),
    };
    let built = build(form, preset, &request.values, &inputs)?;
    let scope = scope_for(built.target.as_deref(), request.scope)?;
    let start = StartToolRunRequest {
        installation_id: record.id.clone(),
        profile_id: format!("form-{}-{}", form.id, preset.id),
        request_id: format!("form-{}", Uuid::new_v4()),
        engagement_id: request.engagement_id.clone(),
        target_id: request.target_id.clone(),
        argv: built.argv,
        working_dir: String::new(),
        environment: form
            .env
            .iter()
            .map(|(key, value)| EnvironmentInput {
                key: key.clone(),
                value: value.clone(),
                sensitive: false,
            })
            .collect(),
        redactions: Vec::new(),
        requires_scope: built.target.is_some(),
        scope,
        timeout_sec: form.timeout_sec,
        output_limit_bytes: OUTPUT_LIMIT_BYTES,
        concurrency_class: "default".into(),
        origin: RunOrigin {
            trigger: Trigger::user(),
            subject: built.subject,
            descriptor_id: None,
            parse: None,
            stdin: built.stdin,
            // Without a target the run reads local files or the local system
            // only, whatever category its program was registered under.
            local_input_only: built.target.is_none(),
        },
    };
    let run = states
        .supervisor
        .start_run_while(start, events, || states.consent.is_granted())?;
    Ok(FormRunStarted {
        run,
        output_name: built.output_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, path::Path};

    struct FakeInputs {
        files: BTreeMap<&'static str, (&'static str, &'static str)>,
        asked: RefCell<Vec<String>>,
    }

    impl FakeInputs {
        fn new() -> Self {
            let mut files = BTreeMap::new();
            files.insert("f-pcap", ("pcap", r"C:\Inv\files\capture.pcap"));
            files.insert("f-pcap2", ("pcap", r"C:\Inv\files\second.pcap"));
            files.insert("f-rules", ("text", r"C:\Inv\files\rules.yar"));
            files.insert("f-png", ("png", r"C:\İnceleme\files\photo.png"));
            Self {
                files,
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl Inputs for FakeInputs {
        fn file(&self, field: &Field, id: &str) -> Result<ResolvedFile, String> {
            self.asked.borrow_mut().push(id.to_string());
            let (kind, path) = self.files.get(id).ok_or("unknown_file")?;
            if !field.accepts.is_empty() && !field.accepts.iter().any(|k| k == kind) {
                return Err(format!("file_kind_not_accepted:{}", field.id));
            }
            Ok(ResolvedFile {
                id: id.to_string(),
                sha256: format!("sha-{id}"),
                path: path.to_string(),
            })
        }
        fn folder(&self) -> Result<String, String> {
            Ok(r"C:\Inv\files".into())
        }
        fn output(&self, name: &str) -> Result<(String, String), String> {
            Ok((
                format!(r"C:\Inv\tool-output\{name}"),
                format!(r"tool-output\{name}"),
            ))
        }
    }

    fn form(id: &str) -> &'static Form {
        forms().iter().find(|form| form.id == id).unwrap()
    }

    fn preset<'a>(form: &'a Form, id: &str) -> &'a Preset {
        form.presets.iter().find(|preset| preset.id == id).unwrap()
    }

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn the_data_file_is_whole() {
        let all = forms();
        assert!(all.len() >= 21, "every known tool has a form");
        let mut ids = std::collections::HashSet::new();
        for form in all {
            assert!(ids.insert(&form.id), "{} twice", form.id);
            assert!(!form.executables.is_empty(), "{}", form.id);
            assert!(form
                .executables
                .iter()
                .all(|e| e.to_ascii_lowercase().ends_with(".exe")));
            assert!((1..=3600).contains(&form.timeout_sec), "{}", form.id);
            assert!(!form.presets.is_empty(), "{}", form.id);
            for key in form.env.keys() {
                assert!(
                    key.bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
                    "{key}"
                );
            }
            for field in &form.fields {
                if let Some(pattern) = &field.pattern {
                    assert!(
                        pattern.starts_with('^') && pattern.ends_with('$'),
                        "{}",
                        field.id
                    );
                    Regex::new(pattern).unwrap();
                }
                if field.kind == FieldType::Output {
                    assert!(field.ext.is_some(), "{}.{}", form.id, field.id);
                }
                if !field.default.is_empty() {
                    check_value(field, &field.default).unwrap();
                }
            }
            let mut preset_ids = std::collections::HashSet::new();
            for preset in &form.presets {
                assert!(preset_ids.insert(&preset.id));
                assert!(matches!(
                    preset.output.as_str(),
                    "nmap-xml" | "json" | "jsonl" | "csv" | "keyvalue" | "lines" | "text"
                ));
                for id in used_fields(preset) {
                    assert!(
                        form.fields.iter().any(|field| field.id == id),
                        "{}.{} names an unknown field {id}",
                        form.id,
                        preset.id
                    );
                }
                // A flag comes from the preset only; a placeholder never
                // stands where a flag would be expected to start.
                for token in &preset.argv {
                    assert!(!token.starts_with("-{"), "{}.{}", form.id, preset.id);
                }
                assert!(
                    preset.launch.is_none() || preset.launch.as_deref() == Some("gui"),
                    "{}.{}",
                    form.id,
                    preset.id
                );
            }
        }
    }

    #[test]
    fn every_form_variable_is_one_the_supervisor_accepts() {
        // The supervisor refuses any other key (validate_environment).
        for form in forms() {
            for key in form.env.keys() {
                assert!(
                    matches!(
                        key.as_str(),
                        "PYTHONIOENCODING"
                            | "PYTHONUTF8"
                            | "NO_COLOR"
                            | "GRYPE_DB_AUTO_UPDATE"
                            | "GRYPE_CHECK_FOR_APP_UPDATE"
                            | "SYFT_CHECK_FOR_APP_UPDATE"
                    ),
                    "{}: {key}",
                    form.id
                );
            }
        }
    }

    #[test]
    fn nmap_quick_scan_puts_the_target_last_and_says_it_needs_scope() {
        let nmap = form("nmap");
        let built = build(
            nmap,
            preset(nmap, "quick"),
            &values(&[("target", " 127.0.0.1 ")]),
            &FakeInputs::new(),
        )
        .unwrap();
        assert_eq!(
            built.argv,
            ["-n", "-sT", "-T4", "-F", "--open", "-oX", "-", "127.0.0.1"]
        );
        assert_eq!(built.target.as_deref(), Some("127.0.0.1"));
        assert!(built.subject.is_none());
    }

    #[test]
    fn a_value_cannot_pass_for_a_flag_or_break_out_of_its_field() {
        let nmap = form("nmap");
        let inputs = FakeInputs::new();
        for bad in [
            "-iL",
            "--script=x",
            "a b",
            "127.0.0.1;calc",
            "x\ny",
            "$(id)",
        ] {
            assert_eq!(
                build(
                    nmap,
                    preset(nmap, "quick"),
                    &values(&[("target", bad)]),
                    &inputs
                )
                .unwrap_err(),
                "field_invalid:target",
                "{bad:?}"
            );
        }
        for bad in ["0", "65536", "80-22", "1,,2", "http", "-1"] {
            assert_eq!(
                build(
                    nmap,
                    preset(nmap, "ports"),
                    &values(&[("target", "10.0.0.5"), ("ports", bad)]),
                    &inputs
                )
                .unwrap_err(),
                "field_invalid:ports",
                "{bad:?}"
            );
        }
        let ok = build(
            nmap,
            preset(nmap, "ports"),
            &values(&[("target", "10.0.0.0/24"), ("ports", "22,80,8000-8100")]),
            &inputs,
        )
        .unwrap();
        assert!(ok.argv.contains(&"22,80,8000-8100".to_string()));
    }

    #[test]
    fn an_empty_field_takes_its_default_and_a_missing_one_is_named() {
        let strings = form("strings");
        let inputs = FakeInputs::new();
        let built = build(
            strings,
            preset(strings, "all"),
            &values(&[("file", "f-png")]),
            &inputs,
        )
        .unwrap();
        assert_eq!(built.argv[3], "6");
        assert_eq!(
            build(strings, preset(strings, "all"), &values(&[]), &inputs).unwrap_err(),
            "field_required:file"
        );
        assert_eq!(
            build(
                strings,
                preset(strings, "all"),
                &values(&[("file", "f-png"), ("min", "2")]),
                &inputs
            )
            .unwrap_err(),
            "field_invalid:min"
        );
    }

    #[test]
    fn files_are_named_by_id_and_handed_over_as_their_verified_copies() {
        let mergecap = form("mergecap");
        let inputs = FakeInputs::new();
        let built = build(
            mergecap,
            preset(mergecap, "chrono"),
            &values(&[("file", "f-pcap"), ("file2", "f-pcap2")]),
            &inputs,
        )
        .unwrap();
        assert_eq!(built.argv[0..3], ["-F", "pcapng", "-w"]);
        assert!(built.argv[3].starts_with(r"C:\Inv\tool-output\mergecap-chrono-"));
        assert!(built.argv[3].ends_with(".pcapng"));
        assert_eq!(
            built.argv[4..],
            [r"C:\Inv\files\capture.pcap", r"C:\Inv\files\second.pcap"]
        );
        assert!(built
            .output_name
            .unwrap()
            .starts_with(r"tool-output\mergecap-chrono-"));
        let subject = built.subject.unwrap();
        assert_eq!(subject.file_id.as_deref(), Some("f-pcap"));
        // A path typed into a file field is not a file id.
        assert_eq!(
            build(
                mergecap,
                preset(mergecap, "chrono"),
                &values(&[("file", r"C:\Windows\win.ini"), ("file2", "f-pcap2")]),
                &inputs
            )
            .unwrap_err(),
            "field_invalid:file"
        );
    }

    #[test]
    fn a_file_of_the_wrong_kind_is_refused() {
        let tshark = form("tshark");
        assert_eq!(
            build(
                tshark,
                preset(tshark, "hierarchy"),
                &values(&[("file", "f-png")]),
                &FakeInputs::new()
            )
            .unwrap_err(),
            "file_kind_not_accepted:file"
        );
    }

    #[test]
    fn yara_rules_are_recorded_as_the_runs_rules() {
        let yara = form("yara");
        let built = build(
            yara,
            preset(yara, "folder"),
            &values(&[("rules", "f-rules")]),
            &FakeInputs::new(),
        )
        .unwrap();
        assert_eq!(built.argv.last().unwrap(), r"C:\Inv\files");
        let subject = built.subject.unwrap();
        assert_eq!(subject.rules_file_id.as_deref(), Some("f-rules"));
        assert!(subject.file_id.is_none());
    }

    #[test]
    fn exiftool_reads_a_path_outside_ascii_from_its_standard_input() {
        let exiftool = form("exiftool");
        let built = build(
            exiftool,
            preset(exiftool, "all"),
            &values(&[("file", "f-png")]),
            &FakeInputs::new(),
        )
        .unwrap();
        assert_eq!(
            built.argv,
            ["-charset", "filename=utf8", "-json", "-G1", "-@", "-"]
        );
        assert_eq!(
            String::from_utf8(built.stdin.unwrap()).unwrap(),
            "C:\\İnceleme\\files\\photo.png\n"
        );
        let ascii = build(
            exiftool,
            preset(exiftool, "all"),
            &values(&[("file", "f-pcap")]),
            &FakeInputs::new(),
        )
        .unwrap();
        assert_eq!(ascii.argv.last().unwrap(), r"C:\Inv\files\capture.pcap");
        assert!(ascii.stdin.is_none());
    }

    #[test]
    fn a_folder_placeholder_inside_a_token_is_filled_in_place() {
        let grype = form("grype");
        let built = build(
            grype,
            preset(grype, "folder"),
            &values(&[]),
            &FakeInputs::new(),
        )
        .unwrap();
        assert_eq!(built.argv[0], r"dir:C:\Inv\files");
    }

    #[test]
    fn text_fields_keep_to_their_pattern_and_length() {
        let editcap = form("editcap");
        let inputs = FakeInputs::new();
        for bad in ["1-2-3", "a", "1 - 2"] {
            assert_eq!(
                build(
                    editcap,
                    preset(editcap, "range"),
                    &values(&[("file", "f-pcap"), ("range", bad)]),
                    &inputs
                )
                .unwrap_err(),
                "field_invalid:range"
            );
        }
        let jq = form("jq");
        let long = ".a".repeat(300);
        assert_eq!(
            build(
                jq,
                preset(jq, "custom"),
                &values(&[("file", "f-rules"), ("expr", &long)]),
                &inputs
            )
            .unwrap_err(),
            "field_invalid:expr"
        );
    }

    /// Every batch preset of every form, run through the real supervisor on
    /// the programs installed on this machine. Ignored by
    /// default: it needs the programs and harmless inputs. Set
    /// `QUTRA_LIVE_TOOLS` to a JSON object of form id → program path,
    /// `QUTRA_LIVE_INPUTS` to a folder of inputs named as below, and
    /// `QUTRA_LIVE_REPORT` to the file the result table is written to.
    /// Network presets (a database download) and windowed ones are skipped;
    /// the only target is 127.0.0.1.
    #[test]
    #[ignore]
    fn live_tools_smoke() {
        use crate::{
            investigation_files::detect_kind, tool_registry::RegisterToolRequest,
            tool_supervisor::ToolSupervisor,
        };
        use std::{sync::Arc, time::Instant};

        let programs: BTreeMap<String, String> =
            serde_json::from_str(&std::env::var("QUTRA_LIVE_TOOLS").unwrap()).unwrap();
        let inputs_dir = PathBuf::from(std::env::var("QUTRA_LIVE_INPUTS").unwrap());
        let only: Vec<String> = std::env::var("QUTRA_LIVE_ONLY")
            .map(|list| list.split(',').map(str::to_string).collect())
            .unwrap_or_default();

        struct LiveInputs {
            dir: PathBuf,
            out: PathBuf,
        }
        impl Inputs for LiveInputs {
            fn file(&self, field: &Field, id: &str) -> Result<ResolvedFile, String> {
                // A file id has no dot: `capture_pcap` is `capture.pcap`.
                let name = match id.rsplit_once('_') {
                    Some((stem, ext)) => format!("{stem}.{ext}"),
                    None => id.to_string(),
                };
                let path = self.dir.join(name);
                let head: Vec<u8> = fs::read(&path)
                    .map_err(|_| "unknown_file".to_string())?
                    .into_iter()
                    .take(512)
                    .collect();
                let ext = path.extension().and_then(|e| e.to_str());
                let kind = detect_kind(&head, ext);
                if !field.accepts.is_empty() && !field.accepts.iter().any(|k| k == kind) {
                    return Err(format!("file_kind_not_accepted:{}", field.id));
                }
                Ok(ResolvedFile {
                    id: id.to_string(),
                    sha256: String::new(),
                    path: path.to_string_lossy().into_owned(),
                })
            }
            fn folder(&self) -> Result<String, String> {
                Ok(self.dir.to_string_lossy().into_owned())
            }
            fn output(&self, name: &str) -> Result<(String, String), String> {
                fs::create_dir_all(&self.out).unwrap();
                Ok((
                    self.out.join(name).to_string_lossy().into_owned(),
                    name.to_string(),
                ))
            }
        }
        // The file each field gets, by form.
        let files = |form: &str, field: &str| -> &'static str {
            match (form, field) {
                (_, "rules") => "rules.yar",
                (_, "file2") => "capture2.pcap",
                ("tshark" | "capinfos" | "editcap" | "mergecap", _) => "capture.pcap",
                ("text2pcap", _) => "dump.txt",
                ("yara" | "gitleaks", _) => "note.txt",
                ("exiftool", _) => "image.png",
                ("grype", _) => "requirements.txt",
                ("chainsaw", _) => "events.evtx",
                ("volatility", _) => "memory.raw",
                ("jq", _) => "data.json",
                _ => "where.exe",
            }
        };

        let base = tempfile::tempdir().unwrap();
        let supervisor = ToolSupervisor::load(base.path()).unwrap();
        let live = LiveInputs {
            dir: inputs_dir.clone(),
            out: base.path().join("tool-output"),
        };
        let mut lines = vec![
            "| Form | Preset | State | Exit | Seconds | Stdout | Stderr | First line |".to_string(),
            "|---|---|---|---|---|---|---|---|".to_string(),
        ];
        for form in forms() {
            if !only.is_empty() && !only.contains(&form.id) {
                continue;
            }
            let Some(program) = programs.get(&form.id) else {
                lines.push(format!(
                    "| {} | – | not installed here | | | | | |",
                    form.id
                ));
                continue;
            };
            let record = supervisor
                .register_tool(RegisterToolRequest {
                    candidate_path: program.clone(),
                    display_name: form.id.clone(),
                    category: "local".into(),
                    risk_tier: "low".into(),
                    doc_url: String::new(),
                    tags: vec![],
                    working_dir: Path::new(program)
                        .parent()
                        .unwrap()
                        .to_string_lossy()
                        .into(),
                    confirmed: true,
                })
                .unwrap();
            assert!(
                form_fits(form, &record),
                "{} does not fit {program}",
                form.id
            );
            for preset in &form.presets {
                if preset.launch.is_some() || preset.network.is_some() {
                    lines.push(format!(
                        "| {} | {} | skipped (window or network) | | | | | |",
                        form.id, preset.id
                    ));
                    continue;
                }
                let mut values = BTreeMap::new();
                for id in used_fields(preset) {
                    let field = form.fields.iter().find(|f| f.id == id).unwrap();
                    let value = match field.kind {
                        FieldType::File => files(&form.id, &id).replace('.', "_"),
                        FieldType::Target => "127.0.0.1".into(),
                        FieldType::Ports => "135,445".into(),
                        _ if id == "keyword" => "Microsoft".into(),
                        _ if id == "image" => "hello-world".into(),
                        _ if id == "expr" => ".hosts[0]".into(),
                        _ => String::new(),
                    };
                    values.insert(id, value);
                }
                let built = match build(form, preset, &values, &live) {
                    Ok(built) => built,
                    Err(reason) => {
                        lines.push(format!(
                            "| {} | {} | not built: {reason} | | | | | |",
                            form.id, preset.id
                        ));
                        continue;
                    }
                };
                let started = Instant::now();
                let request = StartToolRunRequest {
                    installation_id: record.id.clone(),
                    profile_id: format!("form-{}-{}", form.id, preset.id),
                    request_id: format!("live-{}", Uuid::new_v4()),
                    engagement_id: None,
                    target_id: None,
                    argv: built.argv,
                    working_dir: String::new(),
                    environment: form
                        .env
                        .iter()
                        .map(|(key, value)| EnvironmentInput {
                            key: key.clone(),
                            value: value.clone(),
                            sensitive: false,
                        })
                        .collect(),
                    redactions: vec![],
                    scope: None,
                    requires_scope: false,
                    timeout_sec: form.timeout_sec,
                    output_limit_bytes: OUTPUT_LIMIT_BYTES,
                    concurrency_class: "default".into(),
                    origin: RunOrigin {
                        stdin: built.stdin,
                        local_input_only: true,
                        ..RunOrigin::default()
                    },
                };
                let run = supervisor.start_run(request, Arc::new(|_| {})).unwrap();
                let done = loop {
                    let now = supervisor.get_run(&run.id).unwrap();
                    if !matches!(
                        now.state.as_str(),
                        "queued" | "starting" | "running" | "cancelling"
                    ) {
                        break now;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                };
                let stdout = supervisor
                    .read_run_log(&done.id, "stdout.log")
                    .unwrap_or_default();
                let stderr = supervisor
                    .read_run_log(&done.id, "stderr.log")
                    .unwrap_or_default();
                let first = stdout
                    .lines()
                    .chain(stderr.lines())
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or("")
                    .replace(inputs_dir.to_string_lossy().as_ref(), "[inputs]")
                    .replace('|', "/");
                let first: String = first.chars().take(90).collect();
                lines.push(format!(
                    "| {} | {} | {}{} | {} | {:.1} | {} B | {} B | {} |",
                    form.id,
                    preset.id,
                    done.state,
                    if done.blocked_reason.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", done.blocked_reason)
                    },
                    done.exit_code.map(|c| c.to_string()).unwrap_or_default(),
                    started.elapsed().as_secs_f64(),
                    done.bytes_out,
                    done.bytes_err,
                    first
                ));
                assert!(
                    !stdout.contains('\0'),
                    "{}.{}: NUL in output",
                    form.id,
                    preset.id
                );
            }
        }
        let table = lines.join("\n");
        println!("{table}");
        if let Ok(report) = std::env::var("QUTRA_LIVE_REPORT") {
            fs::write(report, format!("{table}\n")).unwrap();
        }
    }

    #[test]
    fn a_scope_decision_must_be_about_the_runs_own_target() {
        let decision = |target: &str| ScopeAttestation {
            scope_id: "scope-1".into(),
            scope_revision: 1,
            target: target.into(),
            allowed: true,
            reason: "allowed_in_scope".into(),
            decided_at: 1,
            expires_at: None,
        };
        // A decision about another target is refused outright.
        assert_eq!(
            scope_for(Some("10.0.0.5"), Some(decision("127.0.0.1"))).unwrap_err(),
            "scope_target_argument_mismatch"
        );
        assert_eq!(
            scope_for(Some("10.0.0.5"), Some(decision("10.0.0.5")))
                .unwrap()
                .unwrap()
                .target,
            "10.0.0.5"
        );
        // No decision: the run still asks for scope, and the supervisor refuses it.
        assert!(scope_for(Some("10.0.0.5"), None).unwrap().is_none());
        // A run with no target carries no decision, whatever the page sent.
        assert!(scope_for(None, Some(decision("10.0.0.5")))
            .unwrap()
            .is_none());
    }

    #[test]
    fn output_names_carry_a_readable_utc_stamp() {
        assert_eq!(stamp(0), "19700101-000000");
        // 2026-10-10 14:22:33 UTC
        assert_eq!(stamp(1_791_642_153_000), "20261010-142233");
    }
}
