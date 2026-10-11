//! External analysis tools on an investigation's files (spec 2026-10-07 §6.1).
//! Rust owns the table of tools: what each reads, which program it
//! is, the exact argument list it gets and how its output is read. The page
//! names a tool by id and a file by id; it never sends a path, a flag or an
//! installation. The registered program is picked here by its executable's
//! file name, and the argument list is built from the table and from paths
//! Rust itself checked (`prepare`).

pub mod capinfos;
pub mod exiftool;
pub mod yara;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::Duration,
};

use regex::Regex;
use serde::Serialize;
use uuid::Uuid;

use crate::{
    analysis::{clean_text, store::Trigger, Fact, Group},
    consent::PrivateToolsConsent,
    engagement_folders::{display_path, EngagementFolders},
    investigation_files::{InvestigationFile, InvestigationFiles},
    tool_registry::ToolInstallationRecord,
    tool_supervisor::{
        EventSink, NativeToolRun, ParseHook, RunLogs, RunOrigin, RunSubject, StartToolRunRequest,
        ToolRunEvent, ToolSupervisor,
    },
};

const MIB: u64 = 1024 * 1024;
/// A rules file may be large, but it is text.
const MAX_RULES_BYTES: u64 = 16 * MIB;
/// How long past its own timeout a run is waited for (reading the logs).
const WAIT_GRACE_SEC: u64 = 20;

/// What a parser knows about the run it reads.
pub struct ParseContext {
    /// The copy's path as the tool was given it.
    pub input_path: String,
    pub input_name: String,
    pub rules_path: Option<String>,
    pub rules_name: Option<String>,
}

pub type Parse = fn(&RunLogs, &ParseContext) -> Result<Vec<Fact>, String>;

/// One external tool (§6.1). `execution` is always "external".
pub struct ExternalTool {
    pub id: &'static str,
    pub name: &'static str,
    /// The launcher item the Locate form preselects. Never used to authorize.
    pub catalog_id: &'static str,
    /// The category a located program is registered under by default.
    pub category: &'static str,
    /// The file kinds it reads (`detect_kind` codes); empty for every kind.
    pub accepts: &'static [&'static str],
    /// "read_only" now; 7b adds "network" and "intrusive".
    pub risk: &'static str,
    /// File names of the program, in lower case.
    pub executables: &'static [&'static str],
    pub install_url: &'static str,
    /// The argument list. A placeholder is a whole argument: `{input}` is the
    /// copy's path, `{rules}` the rules file's.
    pub argv: &'static [&'static str],
    /// The argument list when the path has characters a Windows command line
    /// cannot carry to this program; the path then goes to standard input.
    pub argv_stdin: Option<&'static [&'static str]>,
    pub needs_rules: bool,
    pub timeout_sec: u64,
    pub max_input_bytes: u64,
    pub output_limit: u64,
    pub parse: Parse,
}

pub const TOOLS: &[ExternalTool] = &[
    ExternalTool {
        id: "exiftool",
        name: "ExifTool",
        catalog_id: "exiftool",
        category: "dfir",
        accepts: &[
            "jpeg", "png", "gif", "pdf", "office", "zip", "gzip", "7z", "rar", "pe", "elf",
            "macho", "lnk",
        ],
        risk: "read_only",
        executables: &["exiftool.exe"],
        install_url: "https://exiftool.org/",
        argv: &["-charset", "filename=utf8", "-json", "-G1", "-n", "{input}"],
        argv_stdin: Some(&["-charset", "filename=utf8", "-json", "-G1", "-n", "-@", "-"]),
        needs_rules: false,
        timeout_sec: 60,
        max_input_bytes: u64::MAX,
        output_limit: 2 * MIB,
        parse: exiftool::parse,
    },
    ExternalTool {
        id: "yara",
        name: "YARA",
        catalog_id: "yara",
        category: "dfir",
        accepts: &[],
        risk: "read_only",
        executables: &["yara64.exe", "yara.exe", "yara32.exe"],
        install_url: "https://github.com/VirusTotal/yara/releases",
        // `--disable-console-logs`: a rule that uses YARA's console module
        // prints to standard output, and a line it makes up could pass for a
        // match.
        argv: &[
            "--no-warnings",
            "--disable-console-logs",
            "--print-strings",
            "--print-meta",
            "--print-tags",
            "--timeout=50",
            "{rules}",
            "{input}",
        ],
        argv_stdin: None,
        needs_rules: true,
        timeout_sec: 60,
        max_input_bytes: 256 * MIB,
        output_limit: MIB,
        parse: yara::parse,
    },
    ExternalTool {
        id: "capinfos",
        name: "capinfos",
        catalog_id: "tshark",
        category: "local",
        accepts: &["pcap", "pcapng"],
        risk: "read_only",
        executables: &["capinfos.exe"],
        install_url: "https://www.wireshark.org/download.html",
        argv: &["-M", "{input}"],
        argv_stdin: None,
        needs_rules: false,
        timeout_sec: 60,
        max_input_bytes: u64::MAX,
        output_limit: 256 * 1024,
        parse: capinfos::parse,
    },
];

/// A tool of the table by its id, for the tests. A command searches the table
/// it is given (`command_run`), so a test can give it a fake one.
#[cfg(test)]
pub fn tool(id: &str) -> Option<&'static ExternalTool> {
    TOOLS.iter().find(|tool| tool.id == id)
}

/// How a tool is started on a file: its arguments, and text for its standard
/// input.
#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub argv: Vec<String>,
    pub stdin: Option<Vec<u8>>,
}

pub fn build_invocation(
    tool: &ExternalTool,
    input: &str,
    rules: Option<&str>,
) -> Result<Invocation, String> {
    let (template, stdin) = match tool.argv_stdin {
        Some(template) if !input.is_ascii() => (template, Some(format!("{input}\n").into_bytes())),
        _ => (tool.argv, None),
    };
    let mut argv = Vec::with_capacity(template.len());
    for token in template {
        match *token {
            "{input}" => argv.push(input.to_string()),
            "{rules}" => argv.push(rules.ok_or("rules_required")?.to_string()),
            other => argv.push(other.to_string()),
        }
    }
    Ok(Invocation { argv, stdin })
}

fn named_like(tool: &ExternalTool, record: &ToolInstallationRecord) -> bool {
    let file = record
        .canonical_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default();
    tool.executables
        .iter()
        .any(|name| name.eq_ignore_ascii_case(file))
}

/// The registered installation to run `tool`: one whose executable's file
/// name the tool lists, enabled and not changed since it was last verified,
/// newest first. The hash check itself happens when the run starts.
pub fn pick_installation(
    tool: &ExternalTool,
    installations: &[ToolInstallationRecord],
) -> Result<String, &'static str> {
    let mut named: Vec<&ToolInstallationRecord> = installations
        .iter()
        .filter(|record| named_like(tool, record))
        .collect();
    if named.is_empty() {
        return Err("tool_not_installed");
    }
    named.sort_by_key(|record| std::cmp::Reverse(record.created_at));
    if let Some(ready) = named
        .iter()
        .find(|record| record.enabled && !record.changed_since_verify)
    {
        return Ok(ready.id.clone());
    }
    Err(if named.iter().any(|record| record.enabled) {
        "tool_identity_changed"
    } else {
        "tool_disabled"
    })
}

pub fn status_of(tool: &ExternalTool, installations: &[ToolInstallationRecord]) -> &'static str {
    match pick_installation(tool, installations) {
        Ok(_) => "ready",
        Err("tool_not_installed") => "not_installed",
        Err("tool_identity_changed") => "changed",
        Err(_) => "disabled",
    }
}

/// A tool as the page sees it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolView {
    pub id: &'static str,
    pub name: &'static str,
    pub catalog_id: &'static str,
    pub category: &'static str,
    pub accepts: &'static [&'static str],
    pub risk: &'static str,
    pub execution: &'static str,
    pub executables: &'static [&'static str],
    pub install_url: &'static str,
    pub needs_rules: bool,
    /// ready | not_installed | disabled | changed | needs_consent
    pub status: &'static str,
}

/// The table for the page. `None`: Private Lab is off, so the registry is not
/// read and every tool says so.
pub fn views(installations: Option<&[ToolInstallationRecord]>) -> Vec<ExternalToolView> {
    TOOLS
        .iter()
        .map(|tool| ExternalToolView {
            id: tool.id,
            name: tool.name,
            catalog_id: tool.catalog_id,
            category: tool.category,
            accepts: tool.accepts,
            risk: tool.risk,
            execution: "external",
            executables: tool.executables,
            install_url: tool.install_url,
            needs_rules: tool.needs_rules,
            status: installations.map_or("needs_consent", |list| status_of(tool, list)),
        })
        .collect()
}

/// What takes the place of a path that no file name stands for.
const PATH: &str = "[path]";

/// What ends a path: the characters a Windows file name cannot hold, and the
/// end of a line. (`?` and U+FFFD are not among them, see `redact_paths`.)
const PATH_ENDS: [char; 8] = [':', '"', '<', '>', '|', '*', '\r', '\n'];

/// Text from a tool with no path left in it (the folders are named by the
/// user, a person's name among them), cleaned and cut. Two passes:
///
/// 1. The copy's and the rules' paths become their file names (the tool may
///    print either slash). An empty path is skipped: `str::replace` would
///    put the name between every two letters.
/// 2. Any absolute path still there becomes `[path]`. This is what a tool's
///    text gets when the exact path is not in it: YARA writes its errors in
///    the C runtime's default locale, so a letter from U+0080 to U+00FF is
///    one byte that is not UTF-8 and any letter above it is already `?`, and
///    nothing can match the folder by its letters.
///
/// Both passes run before the text is cut, so a cut never leaves half a path.
pub(crate) fn scrubbed(text: &str, ctx: &ParseContext) -> String {
    let mut out = text.to_string();
    let pairs = [
        (Some(&ctx.input_path), Some(&ctx.input_name)),
        (ctx.rules_path.as_ref(), ctx.rules_name.as_ref()),
    ];
    for (path, name) in pairs {
        let (Some(path), Some(name)) = (path, name) else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        out = out
            .replace(path.as_str(), name)
            .replace(&path.replace('\\', "/"), name);
    }
    clean_text(&redact_paths(&name_blanked_paths(&out, ctx)))
}

/// What the supervisor puts where it blanked a path out of a program's output.
const BLANKED: &str = "[REDACTED]";

/// The paths are blanked out of a program's output before it is written, so
/// the logs a parser reads hold the marker where the exact pass used to find
/// them. The marker takes the name of the file it stood for: the rules file
/// when a line number follows (`rules.yar(12): ...`, as YARA writes it), the
/// copy otherwise. A file with no name gets `[path]`.
fn name_blanked_paths(text: &str, ctx: &ParseContext) -> String {
    if !text.contains(BLANKED) {
        return text.to_string();
    }
    let named = |name: Option<&String>| -> String {
        name.filter(|name| !name.is_empty())
            .map_or_else(|| PATH.to_string(), Clone::clone)
    };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(BLANKED) {
        out.push_str(&rest[..at]);
        rest = &rest[at + BLANKED.len()..];
        let numbered = rest.strip_prefix('(').is_some_and(|inner| {
            let digits = inner.bytes().take_while(u8::is_ascii_digit).count();
            digits > 0 && inner[digits..].starts_with(')')
        });
        out.push_str(&if numbered {
            named(ctx.rules_name.as_ref())
        } else {
            named(Some(&ctx.input_name))
        });
    }
    out.push_str(rest);
    out
}

/// Where an absolute Windows path starts: a drive (`C:\`, `d:/`), perhaps
/// behind the `\\?\` or `\\.\` prefix, or a share (`\\server`). A letter that
/// ends a word is no drive (`Cache:\`, `https://`), and `//` starts nothing:
/// URLs have it. The word boundary is the ASCII one, as in `ai/mask.rs`.
fn path_start() -> &'static Regex {
    static START: OnceLock<Regex> = OnceLock::new();
    START.get_or_init(|| {
        Regex::new(r"(?:\\\\[?.]\\)?(?-u:\b)[A-Za-z]:[\\/]|\\\\").expect("a valid path pattern")
    })
}

/// `text` with every absolute path in it replaced by `[path]`.
///
/// A path runs from its start to the first character a Windows file name
/// cannot hold (`:` `"` `<` `>` `|` `*`) or to the end of the line. `?` and
/// U+FFFD stay inside it, and so do spaces. It also ends where another drive
/// begins (`C:\a D:\b`), or the colon of the second would end the first one
/// short and leave the tail of the second behind. A trailing `(12)`, the line
/// number YARA puts after a rules file, stays outside the token.
fn redact_paths(text: &str) -> String {
    // (start, where the rest begins, is it a drive and not a share)
    let starts: Vec<(usize, usize, bool)> = path_start()
        .find_iter(text)
        .map(|found| (found.start(), found.end(), found.as_str() != r"\\"))
        .collect();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (index, &(start, rest, _)) in starts.iter().enumerate() {
        if start < copied {
            continue; // inside the path before it
        }
        let mut end = text[rest..]
            .find(PATH_ENDS)
            .map_or(text.len(), |at| rest + at);
        let next_drive = starts[index + 1..]
            .iter()
            .take_while(|&&(next, _, _)| next < end)
            .find(|&&(_, _, drive)| drive)
            .map(|&(next, _, _)| next);
        if let Some(next) = next_drive {
            end = next;
        }
        let path = text[start..end].trim_end();
        out.push_str(&text[copied..start]);
        out.push_str(PATH);
        out.push_str(line_number(path));
        copied = start + path.len();
    }
    out.push_str(&text[copied..]);
    out
}

/// The `(12)` a path ends with, or nothing.
fn line_number(path: &str) -> &str {
    let Some(head) = path.strip_suffix(')') else {
        return "";
    };
    let Some(open) = head.rfind('(') else {
        return "";
    };
    let digits = &head[open + 1..];
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        &path[open..]
    } else {
        ""
    }
}

/// A tool's complaint as a fact: the first line of its standard error with
/// something in it, scrubbed, under `key` (`<tool>.error`). A line that
/// `lead_in` calls only the lead-in to the reason is passed over for the next
/// one, but kept when it is all there is. No line at all is
/// `output_unreadable`: the tool said nothing about what went wrong.
pub(crate) fn stderr_error(
    key: &'static str,
    stderr: &str,
    ctx: &ParseContext,
    lead_in: impl Fn(&str) -> bool,
) -> Result<Fact, String> {
    let mut lines = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let first = lines.next();
    let reason = match first {
        Some(line) if lead_in(line) => lines.find(|line| !lead_in(line)).or(first),
        other => other,
    };
    reason
        .map(|line| Fact::new(Group::Summary, key, scrubbed(line, ctx)))
        .ok_or_else(|| "output_unreadable".to_string())
}

/// A tool's inputs after Rust checked them: the files' records and the paths
/// of their verified copies. Only `prepare` makes one, so a path that was not
/// verified cannot reach `run_on_file`.
pub struct Prepared {
    file: InvestigationFile,
    path: PathBuf,
    rules: Option<(InvestigationFile, PathBuf)>,
}

/// Check what is cheap to check first (kind, size, the rules' records), so a
/// large file is not hashed for a tool that would refuse it; then hand out the
/// copies, each only once its SHA-256 matches the record again (§4.2). The
/// rules come before the input: they are at most 16 MiB and a rules file that
/// includes another file is refused once its copy is verified, so a refusal of
/// the rules costs no hash of an input that can be 4 GiB.
pub fn prepare(
    files: &InvestigationFiles,
    folder: &Path,
    engagement_id: &str,
    file_id: &str,
    rules_file_id: Option<&str>,
    tool: &ExternalTool,
) -> Result<Prepared, String> {
    let views = files.list(engagement_id, Some(folder))?;
    let record = views
        .iter()
        .find(|view| view.file.id == file_id)
        .ok_or("unknown_file")?;
    if !tool.accepts.is_empty() && !tool.accepts.contains(&record.file.kind.as_str()) {
        return Err("tool_not_for_kind".into());
    }
    if record.file.bytes > tool.max_input_bytes {
        return Err("file_too_large".into());
    }
    let rules_id = match (tool.needs_rules, rules_file_id) {
        (true, Some(id)) => Some(id),
        (true, None) => return Err("rules_required".into()),
        (false, _) => None,
    };
    if let Some(id) = rules_id {
        let rules = views
            .iter()
            .find(|view| view.file.id == id)
            .ok_or("unknown_rules_file")?;
        if let Some(problem) = rules_record_problem(&rules.file) {
            return Err(problem.into());
        }
    }
    let rules = match rules_id {
        Some(id) => {
            let copy = files.verified_copy(folder, engagement_id, id)?;
            refuse_includes(&copy.1)?;
            Some(copy)
        }
        None => None,
    };
    let (file, path) = files.verified_copy(folder, engagement_id, file_id)?;
    Ok(Prepared { file, path, rules })
}

/// What is wrong with a rules file by its record alone, before any byte of it
/// is read: it is not text (checked first), or it is over the cap.
fn rules_record_problem(rules: &InvestigationFile) -> Option<&'static str> {
    if rules.kind != "text" {
        Some("rules_not_text")
    } else if rules.bytes > MAX_RULES_BYTES {
        Some("rules_too_large")
    } else {
        None
    }
}

/// `include` and a quote with nothing but white space between them, anywhere
/// in the text. There is no boundary before `include`: when a number touches
/// it (`1include "x"`, `0x1include "x"`), YARA's lexer reads the number and
/// then the directive, because a number never takes in the letters after it.
/// The pattern is wider than the directive in three ways: it needs no blank
/// before the quote (YARA wants one), it takes any white space, and it refuses
/// a word that merely ends in `include` when a quote follows. It is not
/// case-folded, as YARA's keywords are not.
fn include_directive() -> &'static regex::bytes::Regex {
    static INCLUDE: OnceLock<regex::bytes::Regex> = OnceLock::new();
    INCLUDE.get_or_init(|| {
        regex::bytes::Regex::new(r#"include\s*""#).expect("a valid include pattern")
    })
}

/// YARA follows `include "..."` in a rules file, and its command line has no
/// switch that turns that off: rules from the investigation could make it read
/// local files that never went through `verified_copy` (§4.2). A rules file
/// that has the directive is refused. The check is wide on purpose: it does
/// not try to understand the file, so a match in a comment or a string is
/// refused too, and the file is read as bytes whatever its encoding.
pub(crate) fn refuse_includes(rules: &Path) -> Result<(), String> {
    let bytes = fs::read(rules).map_err(|_| "file_missing".to_string())?;
    if include_directive().is_match(&bytes) {
        return Err("rules_include_not_allowed".into());
    }
    Ok(())
}

/// The paths of the copy and of the rules, and the folder each is in, for the
/// supervisor to blank out of a program's output. A program may print any of
/// them (ExifTool's JSON has the copy as `SourceFile` and its folder as
/// `System:Directory`), in each form it writes one: as given, with forward
/// slashes, and as a JSON string, with the backslashes doubled. Longest first,
/// so a path goes whole before the folder inside it. A program that changes
/// the letters of a path (YARA writes its errors in the C runtime's default
/// locale) is not matched here; the parsers' second pass covers its facts.
fn path_redactions(input: &str, rules: Option<&str>) -> Vec<String> {
    let files = std::iter::once(input).chain(rules);
    let folders = files.clone().filter_map(|file| {
        Path::new(file)
            .parent()
            .map(|folder| folder.to_string_lossy().into_owned())
    });
    let mut forms: Vec<String> = Vec::new();
    for path in files
        .map(str::to_string)
        .chain(folders)
        .filter(|path| !path.is_empty())
    {
        for form in [
            path.clone(),
            path.replace('\\', "/"),
            path.replace('\\', "\\\\"),
        ] {
            if !forms.contains(&form) {
                forms.push(form);
            }
        }
    }
    forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
    forms
}

/// Run `tool` on the prepared copy and wait for the run to end. Rust picks
/// the program, builds the argument list and stamps the trigger; the supervisor
/// still checks the program's hash, applies the limits and records the run.
/// Events go to `forward` as for any run. A refused start comes back as a
/// `blocked` run at once.
pub fn run_on_file(
    supervisor: &ToolSupervisor,
    tool: &ExternalTool,
    prepared: &Prepared,
    forward: EventSink,
    allowed: impl Fn() -> bool,
) -> Result<NativeToolRun, String> {
    let installation_id = installation_for(supervisor, tool)?;
    // Without the `\\?\` prefix a canonical path carries: programs written in
    // other languages do not all take it.
    let input = display_path(&prepared.path);
    let rules = prepared.rules.as_ref().map(|(_, path)| display_path(path));
    let invocation = build_invocation(tool, &input, rules.as_deref())?;
    // The supervisor blanks these out of everything the program prints, before
    // it is written, hashed, shown or kept as evidence.
    let redactions = path_redactions(&input, rules.as_deref());
    let ctx = ParseContext {
        input_path: input,
        input_name: prepared.file.name.clone(),
        rules_path: rules,
        rules_name: prepared.rules.as_ref().map(|(file, _)| file.name.clone()),
    };
    let parse = tool.parse;
    let request = StartToolRunRequest {
        installation_id,
        profile_id: format!("external-{}", tool.id),
        request_id: format!("external-{}", Uuid::new_v4()),
        engagement_id: Some(prepared.file.engagement_id.clone()),
        target_id: None,
        argv: invocation.argv,
        working_dir: String::new(),
        environment: Vec::new(),
        redactions,
        scope: None,
        requires_scope: false,
        timeout_sec: tool.timeout_sec,
        output_limit_bytes: tool.output_limit,
        concurrency_class: "default".into(),
        origin: RunOrigin {
            trigger: Trigger::user(),
            subject: Some(RunSubject {
                file_id: Some(prepared.file.id.clone()),
                file_sha256: Some(prepared.file.sha256.clone()),
                rules_file_id: prepared.rules.as_ref().map(|(file, _)| file.id.clone()),
                rules_sha256: prepared.rules.as_ref().map(|(file, _)| file.sha256.clone()),
            }),
            descriptor_id: Some(tool.id.to_string()),
            parse: Some(ParseHook(Arc::new(move |logs| parse(logs, &ctx)))),
            stdin: invocation.stdin,
            // Every run made here is a descriptor run on a verified local copy
            // and touches no target, so no authorization scope applies to it.
            local_input_only: true,
        },
    };

    let (ended, done) = mpsc::channel::<()>();
    let ended = Mutex::new(ended);
    let events: EventSink = Arc::new(move |event: ToolRunEvent| {
        let terminal = matches!(
            event.kind.as_str(),
            "finished" | "failed" | "cancelled" | "timed_out" | "blocked"
        );
        forward(event);
        if terminal {
            if let Ok(sender) = ended.lock() {
                let _ = sender.send(());
            }
        }
    });
    let started = supervisor.start_run_while(request, events, allowed)?;
    if started.state == "blocked" {
        return Ok(started);
    }
    done.recv_timeout(Duration::from_secs(tool.timeout_sec + WAIT_GRACE_SEC))
        .map_err(|_| "run_wait_timeout".to_string())?;
    supervisor.get_run(&started.id)
}

/// The registered program for `tool`, or why there is none
/// (`tool_not_installed`, `tool_disabled`, `tool_identity_changed`). The
/// supervisor's own check, which hashes the program, comes when the run starts.
fn installation_for(supervisor: &ToolSupervisor, tool: &ExternalTool) -> Result<String, String> {
    pick_installation(tool, &supervisor.list_tools()?).map_err(str::to_string)
}

/// What the commands read: the Private Lab consent, the folders the
/// investigations keep their files in, the records of those files and the
/// supervisor (which owns the registry of programs). Lent by reference: a
/// command takes them from the app's state, a test builds its own.
pub struct States<'a> {
    pub consent: &'a PrivateToolsConsent,
    pub folders: &'a EngagementFolders,
    pub files: &'a InvestigationFiles,
    pub supervisor: &'a ToolSupervisor,
}

/// What the page asks `external_tool_run` for: ids, never a path.
pub struct RunRequest<'a> {
    pub engagement_id: &'a str,
    pub file_id: &'a str,
    pub tool: &'a str,
    pub rules_file_id: Option<&'a str>,
}

/// The registry's records, or none when it cannot be read (a poisoned lock):
/// every tool then shows as not installed, and the code goes to the log, never
/// a path.
fn installations_or_log(
    read: Result<Vec<ToolInstallationRecord>, String>,
) -> Vec<ToolInstallationRecord> {
    read.unwrap_or_else(|code| {
        eprintln!(
            "[Qutra Labs] external tools: the registry could not be read ({code}); \
             every tool shows as not installed"
        );
        Vec::new()
    })
}

/// `external_tools_list`: the table with each tool's status. It needs no
/// consent; without it the registry is not read and every tool says so.
pub fn command_list(
    consent: &PrivateToolsConsent,
    supervisor: &ToolSupervisor,
) -> Vec<ExternalToolView> {
    let installations = consent
        .is_granted()
        .then(|| installations_or_log(supervisor.list_tools()));
    views(installations.as_deref())
}

/// `external_tool_runs`: the investigation's runs that were built from a
/// descriptor, newest first.
pub fn command_runs(
    consent: &PrivateToolsConsent,
    supervisor: &ToolSupervisor,
    engagement_id: &str,
) -> Result<Vec<NativeToolRun>, String> {
    consent.require()?;
    supervisor.described_runs(engagement_id)
}

/// `tool_run_output`: one log of a run, as the ledger hashed it.
pub fn command_output(
    consent: &PrivateToolsConsent,
    supervisor: &ToolSupervisor,
    run_id: &str,
    name: &str,
) -> Result<String, String> {
    consent.require()?;
    supervisor.read_run_log(run_id, name)
}

/// `external_tool_run`: run one of `tools` on one of the investigation's
/// files. It refuses in a fixed order: Private Lab, the tool, the
/// investigation's folder, the registered program, then `prepare` (the file's
/// kind and size, the rules' records, the rules' copy, and last the input's
/// copy, which can be 4 GiB). No file is hashed before the program is found.
/// It returns the run when it ended, or a `blocked` one when the supervisor
/// refused to start it.
pub fn command_run(
    tools: &[ExternalTool],
    states: &States,
    request: &RunRequest,
    forward: EventSink,
) -> Result<NativeToolRun, String> {
    states.consent.require()?;
    let tool = tools
        .iter()
        .find(|tool| tool.id == request.tool)
        .ok_or("unknown_tool")?;
    let folder = states
        .folders
        .folder_path(request.engagement_id)?
        .ok_or("no_engagement_folder")?;
    // The program is looked for before any file is hashed: an input can be
    // 4 GiB, and it is not read for a tool that cannot start.
    installation_for(states.supervisor, tool)?;
    let prepared = prepare(
        states.files,
        &folder,
        request.engagement_id,
        request.file_id,
        request.rules_file_id,
        tool,
    )?;
    run_on_file(states.supervisor, tool, &prepared, forward, || {
        states.consent.is_granted()
    })
}

#[cfg(test)]
pub(crate) mod testing {
    use super::ParseContext;
    use crate::{analysis::Fact, tool_supervisor::RunLogs};

    pub fn ctx() -> ParseContext {
        ParseContext {
            input_path: r"C:\Users\test\Documents\Qutra Labs\case\files\photo.jpg".into(),
            input_name: "photo.jpg".into(),
            rules_path: None,
            rules_name: None,
        }
    }

    pub fn logs(stdout: &str, stderr: &str, exit_code: i32) -> RunLogs {
        RunLogs {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code: Some(exit_code),
        }
    }

    /// A run stopped before it could exit: it has no exit code.
    pub fn killed(stdout: &str, stderr: &str) -> RunLogs {
        RunLogs {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code: None,
        }
    }

    pub fn fact<'a>(facts: &'a [Fact], key: &str) -> Option<&'a Fact> {
        facts.iter().find(|fact| fact.key == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::SignatureState;
    use std::collections::HashSet;

    fn record(
        id: &str,
        path: &str,
        created_at: u64,
        enabled: bool,
        changed: bool,
    ) -> ToolInstallationRecord {
        ToolInstallationRecord {
            id: id.into(),
            display_name: id.into(),
            runner: "executable".into(),
            canonical_path: path.into(),
            sha256: String::new(),
            size_bytes: 0,
            modified_at: None,
            version: String::new(),
            publisher: String::new(),
            signature_state: SignatureState::Unsigned,
            category: "dfir".into(),
            risk_tier: "low".into(),
            doc_url: String::new(),
            tags: vec![],
            working_dir: String::new(),
            enabled,
            changed_since_verify: changed,
            created_at,
            updated_at: created_at,
            last_verified_at: created_at,
        }
    }

    #[test]
    fn the_table_is_well_formed() {
        let ids: HashSet<_> = TOOLS.iter().map(|tool| tool.id).collect();
        assert_eq!(ids.len(), TOOLS.len());
        for tool in TOOLS {
            assert_eq!(
                tool.argv.contains(&"{rules}"),
                tool.needs_rules,
                "{}",
                tool.id
            );
            // `build_invocation` takes `argv` for every ASCII path, so it always
            // holds the input; the stdin variant is only for the other paths.
            assert!(tool.argv.contains(&"{input}"), "{}", tool.id);
            assert_eq!(tool.risk, "read_only");
            assert!(tool
                .executables
                .iter()
                .all(|name| name.ends_with(".exe") && *name == name.to_lowercase()));
            // A placeholder is a whole argument, never part of a flag.
            for token in tool.argv.iter().chain(tool.argv_stdin.unwrap_or(&[])) {
                assert!(
                    !token.contains('{') || matches!(*token, "{input}" | "{rules}"),
                    "{token}"
                );
            }
            // The stdin variant carries the path on standard input only.
            assert!(!tool.argv_stdin.unwrap_or(&[]).contains(&"{input}"));
        }
    }

    #[test]
    fn the_argument_list_comes_from_the_table() {
        let exif = tool("exiftool").unwrap();
        let plain = build_invocation(exif, r"C:\case\files\photo.jpg", None).unwrap();
        assert_eq!(
            plain.argv,
            [
                "-charset",
                "filename=utf8",
                "-json",
                "-G1",
                "-n",
                r"C:\case\files\photo.jpg"
            ]
        );
        assert_eq!(plain.stdin, None);

        // ExifTool on Windows cannot take other characters on its command
        // line: the path goes to its standard input instead.
        let turkish = build_invocation(exif, "C:\\Belgeler\\Ekran görüntüsü.png", None).unwrap();
        assert_eq!(turkish.argv.last().map(String::as_str), Some("-"));
        assert!(!turkish.argv.iter().any(|arg| arg.contains("görüntüsü")));
        assert_eq!(
            turkish.stdin.as_deref(),
            Some("C:\\Belgeler\\Ekran görüntüsü.png\n".as_bytes())
        );

        let yara = tool("yara").unwrap();
        assert_eq!(
            build_invocation(yara, r"C:\f\s.exe.sample", None),
            Err("rules_required".to_string())
        );
        let with = build_invocation(yara, r"C:\f\s.exe.sample", Some(r"C:\f\r.yar")).unwrap();
        assert_eq!(
            with.argv,
            [
                "--no-warnings",
                "--disable-console-logs",
                "--print-strings",
                "--print-meta",
                "--print-tags",
                "--timeout=50",
                r"C:\f\r.yar",
                r"C:\f\s.exe.sample"
            ]
        );
        // YARA reads Unicode paths itself.
        assert_eq!(
            build_invocation(yara, "C:\\ş\\a", Some("C:\\ş\\r"))
                .unwrap()
                .stdin,
            None
        );
    }

    #[test]
    fn the_installation_is_picked_by_its_executable_name_newest_first() {
        let exif = tool("exiftool").unwrap();
        let list = vec![
            record("tool-a", r"C:\Old\exiftool.exe", 1, true, false),
            record("tool-b", r"C:\New\EXIFTOOL.EXE", 2, true, false),
            record("tool-c", r"C:\Tools\yara64.exe", 3, true, false),
            record("tool-d", r"C:\Tools\notexiftool.exe", 4, true, false),
        ];
        assert_eq!(pick_installation(exif, &list), Ok("tool-b".to_string()));
        assert_eq!(status_of(exif, &list), "ready");
        assert_eq!(
            pick_installation(tool("capinfos").unwrap(), &list),
            Err("tool_not_installed")
        );

        // A changed or turned-off newest one falls back to a good older one.
        let list = vec![
            record("tool-a", r"C:\Old\exiftool.exe", 1, true, false),
            record("tool-b", r"C:\New\exiftool.exe", 2, true, true),
        ];
        assert_eq!(pick_installation(exif, &list), Ok("tool-a".to_string()));
        let changed = vec![record("tool-b", r"C:\New\exiftool.exe", 2, true, true)];
        assert_eq!(status_of(exif, &changed), "changed");
        let off = vec![record("tool-b", r"C:\New\exiftool.exe", 2, false, false)];
        assert_eq!(status_of(exif, &off), "disabled");
    }

    #[test]
    fn the_page_sees_every_tool_and_no_registry_without_consent() {
        let without = views(None);
        assert_eq!(
            without.iter().map(|v| v.id).collect::<Vec<_>>(),
            ["exiftool", "yara", "capinfos"]
        );
        assert!(without
            .iter()
            .all(|v| v.status == "needs_consent" && v.execution == "external"));
        let empty = views(Some(&[]));
        assert!(empty.iter().all(|v| v.status == "not_installed"));
        let json = serde_json::to_value(&empty[1]).unwrap();
        assert_eq!(json["needsRules"], true);
        assert_eq!(
            json["installUrl"],
            "https://github.com/VirusTotal/yara/releases"
        );
    }

    #[test]
    fn scrubbed_text_loses_both_paths_in_either_slash_and_is_cleaned() {
        let both = ParseContext {
            input_path: r"C:\Users\ayse\Documents\Qutra Labs\vaka\files\ekran görüntüsü.png".into(),
            input_name: "ekran görüntüsü.png".into(),
            rules_path: Some(r"C:\Users\ayse\Documents\Qutra Labs\vaka\files\kurallar.yar".into()),
            rules_name: Some("kurallar.yar".into()),
        };
        // A tool may print either slash, and a name may carry direction marks
        // or control characters.
        let text = "C:/Users/ayse/Documents/Qutra Labs/vaka/files/kurallar.yar(7): bad, then \
                    C:\\Users\\ayse\\Documents\\Qutra Labs\\vaka\\files\\ekran görüntüsü.png\u{202e}\u{7} too";
        assert_eq!(
            scrubbed(text, &both),
            "kurallar.yar(7): bad, then ekran görüntüsü.png too"
        );
        // With no rules there is only the copy's path to hide; a long message
        // is cut.
        assert_eq!(
            scrubbed(&"x".repeat(500), &testing::ctx()).chars().count(),
            200
        );
    }

    #[test]
    fn scrubbed_redacts_every_absolute_path_that_is_left() {
        let ctx = testing::ctx();
        for (text, want) in [
            // A drive with either slash; spaces belong to the path.
            (
                r"error scanning C:\Users\kullanici\Qutra Labs\vaka\x.sample: could not open file",
                "error scanning [path]: could not open file",
            ),
            (
                "Error: File not found - D:/data/vaka/x.jpg",
                "Error: File not found - [path]",
            ),
            // A line number after a rules file stays outside the token.
            (
                r#"error: rule "x" in C:\Users\kullanici\kurallar.yar(12): syntax error"#,
                r#"error: rule "x" in [path](12): syntax error"#,
            ),
            // The characters a Windows file name cannot hold end a path.
            (
                r#"capinfos: The file "C:\Users\k\a b.pcap" doesn't exist."#,
                r#"capinfos: The file "[path]" doesn't exist."#,
            ),
            (r"<C:\Users\k\a>|C:\Users\k\b*", "<[path]>|[path]*"),
            // `?` and U+FFFD stay inside it: an error text in the C
            // runtime's default locale loses its letters that way.
            (
                "C:\\Users\\k\\Masa\u{fffd}st\u{fffd}\\?\u{fffd}pheli\\x: bad",
                "[path]: bad",
            ),
            // A share, and the prefixes Windows puts on long and device paths.
            (
                r"\\sunucu\paylasim\vaka\x.txt: access denied",
                "[path]: access denied",
            ),
            (r"\\?\C:\Users\k\x.txt", "[path]"),
            (r"\\?\UNC\sunucu\paylasim\x.txt", "[path]"),
            // Two paths in a line, even with nothing but a space between them.
            (r"copy C:\a\b.txt D:\c\d.txt", "copy [path] [path]"),
            (r"\\sunucu\paylasim C:\Users\k\x", "[path] [path]"),
            // A file URL.
            ("file:///C:/Users/k/x.txt", "file:///[path]"),
        ] {
            assert_eq!(scrubbed(text, &ctx), want, "{text}");
        }
    }

    // The supervisor blanks the copy's and the rules' paths out of a tool's
    // output before it is written, so the parsers see its marker where the
    // exact pass used to find a path.
    #[test]
    fn scrubbed_gives_the_blanked_paths_the_names_they_stood_for() {
        let both = ParseContext {
            input_path: r"C:\Users\ayse\vaka\files\ekran görüntüsü.png".into(),
            input_name: "ekran görüntüsü.png".into(),
            rules_path: Some(r"C:\Users\ayse\vaka\files\kurallar.yar".into()),
            rules_name: Some("kurallar.yar".into()),
        };
        for (text, want) in [
            // A line number after it is the rules file's, as YARA writes it.
            (
                "[REDACTED](12): error: syntax error",
                "kurallar.yar(12): error: syntax error",
            ),
            // Anything else is the copy.
            (
                "error scanning [REDACTED]: could not map file",
                "error scanning ekran görüntüsü.png: could not map file",
            ),
            (
                r#"capinfos: The file "[REDACTED]" appears to be cut short."#,
                r#"capinfos: The file "ekran görüntüsü.png" appears to be cut short."#,
            ),
            (
                "[REDACTED] then [REDACTED](3), [REDACTED]",
                "ekran görüntüsü.png then kurallar.yar(3), ekran görüntüsü.png",
            ),
            // A bracket that is not the marker, and a number not in brackets.
            (
                "[REDACTE] and [REDACTED] 12 (x)",
                "[REDACTE] and ekran görüntüsü.png 12 (x)",
            ),
        ] {
            assert_eq!(scrubbed(text, &both), want, "{text}");
        }

        // With no name to give, it is a path, as any other the tool leaves.
        let nameless = ParseContext {
            input_path: String::new(),
            input_name: String::new(),
            rules_path: None,
            rules_name: None,
        };
        assert_eq!(
            scrubbed("[REDACTED](3): bad in [REDACTED]", &nameless),
            "[path](3): bad in [path]"
        );
        // Text with no marker is as it was.
        assert_eq!(scrubbed("a plain message", &both), "a plain message");
    }

    #[test]
    fn scrubbed_leaves_text_that_is_not_a_path_alone() {
        let ctx = testing::ctx();
        for text in [
            "error: syntax error, unexpected identifier",
            "Warning: [minor] Bad IFD1 directory",
            "PDF:Creator and ExifTool:Warning",
            // Not drives: a colon after a letter that ends a word, a URL's
            // scheme, a time, a ratio.
            r"Cache:\x is no drive, nor is a1:/b",
            "https://exiftool.org/ and http://example.com/a:b",
            "time 10:30:00, ratio 3:1, key:value, C: alone, or C:",
            // `//` starts nothing.
            "see //server/share for details",
        ] {
            assert_eq!(scrubbed(text, &ctx), text, "{text}");
        }
    }

    #[test]
    fn the_first_line_standard_error_has_to_say_becomes_the_tool_s_error() {
        let ctx = testing::ctx();
        let file = r"C:\Users\test\Documents\Qutra Labs\case\files\photo.jpg";
        let text = format!(
            "\r\n  \r\ncapinfos: An error occurred after reading 1 packets from \"{file}\".\r\n\
             capinfos: The file \"{file}\" is cut short.\r\n"
        );
        let lead_in = |line: &str| line.contains("An error occurred");

        // The first line with something in it, the file by its name.
        let first = stderr_error("tool.error", &text, &ctx, |_| false).unwrap();
        assert_eq!((first.key, first.group), ("tool.error", Group::Summary));
        assert_eq!(
            first.value,
            "capinfos: An error occurred after reading 1 packets from \"photo.jpg\"."
        );

        // A lead-in is passed over for the line that gives the reason...
        let reason = stderr_error("tool.error", &text, &ctx, lead_in).unwrap();
        assert_eq!(
            reason.value,
            "capinfos: The file \"photo.jpg\" is cut short."
        );
        // ...but kept when it is all there is.
        let alone = "capinfos: An error occurred after reading 1 packets\n";
        assert_eq!(
            stderr_error("tool.error", alone, &ctx, lead_in)
                .unwrap()
                .value,
            "capinfos: An error occurred after reading 1 packets"
        );

        // Nothing to say is no reason.
        for blank in ["", "\n", " \r\n\t\r\n"] {
            assert_eq!(
                stderr_error("tool.error", blank, &ctx, lead_in).err(),
                Some("output_unreadable".into()),
                "{blank:?}"
            );
        }
    }

    #[test]
    fn scrubbed_skips_an_empty_path_and_survives_every_cut_of_a_line() {
        let empty = ParseContext {
            input_path: String::new(),
            input_name: "photo.jpg".into(),
            rules_path: Some(String::new()),
            rules_name: Some("rules.yar".into()),
        };
        // `str::replace` with an empty pattern would put the name between
        // every two letters.
        assert_eq!(scrubbed("a plain message", &empty), "a plain message");

        // Every cut of a line with all the shapes: letters of more than one
        // byte, a share, a prefix, a quoted path, a line number.
        let line = "x C:\\Users\\Şüpheli\\Masa\u{fffd}st\u{fffd}\\?ü\\a b.sample(12): \
                    \\\\sunucu\\ş\\ç \\\\?\\C:\\é D:/ö \"C:\\é\" <\\\\>";
        for end in (0..=line.len()).filter(|end| line.is_char_boundary(*end)) {
            let text = scrubbed(&line[..end], &testing::ctx());
            for folder in ["Users", "Şüpheli", "sunucu", "Masa"] {
                assert!(
                    !text.contains(folder),
                    "{folder} left at byte {end}: {text}"
                );
            }
        }
    }
}

#[cfg(test)]
mod run_tests {
    use super::*;
    use crate::{
        analysis::{Group, Observation},
        investigation_files::{AddOutcome, InvestigationFiles, Source},
        tool_registry::RegisterToolRequest,
    };
    use sha2::{Digest, Sha256};
    use std::{fs, io::Write, path::PathBuf};

    /// The program started as the "tool": asked about a `photo.jpg`, it prints
    /// a line of ExifTool's JSON (libtest adds lines of its own around it).
    #[test]
    fn fake_tool() {
        if let Some(arg) = std::env::args().find(|arg| arg.ends_with("photo.jpg")) {
            println!(
                r#"[{{"SourceFile":"x","File:FileType":"JPEG","IFD0:Make":"Canon","IFD0:Model":"EOS R6"}}]"#
            );
            println!("plain={}", !arg.starts_with(r"\\?\"));
        }
    }

    /// The same program as a "tool" that fails: asked about a `broken.jpg`, it
    /// complains and exits with a code.
    #[test]
    fn fake_failing_tool() {
        if std::env::args().any(|arg| arg.ends_with("broken.jpg")) {
            eprintln!("Error: could not read the file");
            std::process::exit(3);
        }
    }

    /// The same program as a "tool" that says what it was given: for every
    /// argument that names a file, whether it is plain (no `\\?\`) and which
    /// file it is, by name. A path would be blanked out of this line.
    #[test]
    fn fake_args_tool() {
        for arg in std::env::args()
            .skip(1)
            .filter(|arg| Path::new(arg).is_file())
        {
            let name = Path::new(&arg)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            println!("file-arg {name} plain={}", !arg.starts_with(r"\\?\"));
        }
    }

    /// The same program as a "tool" that prints back the path it was asked
    /// about, and the folder it is in (ExifTool's `System:Directory`), in each
    /// form a program may print one: as given, with forward slashes (ExifTool),
    /// and as a JSON string (backslashes doubled), on both streams.
    #[test]
    fn fake_echo_tool() {
        for arg in std::env::args()
            .skip(1)
            .filter(|arg| Path::new(arg).is_file())
        {
            let folder = Path::new(&arg)
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            for path in [arg.clone(), folder] {
                for form in [
                    path.clone(),
                    path.replace('\\', "/"),
                    path.replace('\\', "\\\\"),
                ] {
                    println!("stdout says {form}");
                    eprintln!("stderr says {form}");
                }
            }
        }
    }

    fn json_line(logs: &RunLogs, ctx: &ParseContext) -> Result<Vec<Fact>, String> {
        let line = logs
            .stdout
            .lines()
            .find(|line| line.starts_with("[{"))
            .unwrap_or_default();
        exiftool::parse(
            &RunLogs {
                stdout: line.into(),
                stderr: String::new(),
                exit_code: logs.exit_code,
            },
            ctx,
        )
    }

    const FAKE: ExternalTool = ExternalTool {
        id: "exiftool",
        name: "ExifTool",
        catalog_id: "exiftool",
        category: "dfir",
        accepts: &["jpeg"],
        risk: "read_only",
        executables: &["exiftool.exe"],
        install_url: "https://exiftool.org/",
        argv: &[
            "--exact",
            "external_tools::run_tests::fake_tool",
            "--nocapture",
            "{input}",
        ],
        argv_stdin: None,
        needs_rules: false,
        timeout_sec: 20,
        max_input_bytes: u64::MAX,
        output_limit: 64 * 1024,
        parse: json_line,
    };

    struct Case {
        temp: tempfile::TempDir,
        files: InvestigationFiles,
        folder: PathBuf,
        supervisor: ToolSupervisor,
        consent: PrivateToolsConsent,
        folders: EngagementFolders,
    }

    fn case() -> Case {
        case_with(None)
    }

    /// A case whose run ledger, when there is one, was already on disk when
    /// the supervisor started.
    fn case_with(ledger: Option<&str>) -> Case {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("appdata");
        let folder = temp.path().join("case");
        fs::create_dir_all(&folder).unwrap();
        if let Some(text) = ledger {
            fs::create_dir_all(app_data.join("lab")).unwrap();
            fs::write(app_data.join("lab").join("tool-runs.json"), text).unwrap();
        }
        Case {
            files: InvestigationFiles::load(&app_data),
            supervisor: ToolSupervisor::load(&app_data).unwrap(),
            consent: PrivateToolsConsent::load(&app_data),
            folders: EngagementFolders::load(&app_data, Some(temp.path().join("Documents"))),
            folder,
            temp,
        }
    }

    impl Case {
        /// Private Lab granted, as the user's answer to its dialog would.
        fn grant(&self) {
            assert!(self.consent.grant(self.consent.generation()).unwrap());
        }

        /// What the commands read.
        fn states(&self) -> States<'_> {
            States {
                consent: &self.consent,
                folders: &self.folders,
                files: &self.files,
                supervisor: &self.supervisor,
            }
        }

        /// The investigation's folder, made the way the app makes it, so it is
        /// canonical (`\\?\...` on Windows).
        fn make_folder(&self) -> PathBuf {
            self.folders.create("eng_1", "Case", None).unwrap();
            self.folders.folder_path("eng_1").unwrap().unwrap()
        }

        fn add(&self, name: &str, bytes: &[u8]) -> String {
            self.add_to(&self.folder, name, bytes)
        }

        fn add_to(&self, folder: &Path, name: &str, bytes: &[u8]) -> String {
            let source = self.temp.path().join("incoming").join(name);
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::write(&source, bytes).unwrap();
            match self.files.add(folder, "eng_1", &source, Source::Picked) {
                AddOutcome::Added { file } => file.file.id,
                other => panic!("not added: {other:?}"),
            }
        }

        /// The folder the supervisor keeps a run's logs in.
        fn run_dir(&self, run: &NativeToolRun) -> PathBuf {
            self.temp
                .path()
                .join("appdata")
                .join("lab")
                .join("runs")
                .join(&run.id)
        }

        /// A log of a run, as it is on disk.
        fn log(&self, run: &NativeToolRun, name: &str) -> String {
            fs::read_to_string(self.run_dir(run).join(name)).unwrap()
        }

        /// How many folders for a run's logs the supervisor has made.
        fn run_folders(&self) -> usize {
            let runs = self.temp.path().join("appdata").join("lab").join("runs");
            fs::read_dir(runs).unwrap().count()
        }

        /// This test binary, registered under the tool's file name as a
        /// network program: a descriptor run must not ask for a scope.
        fn register(&self, file_name: &str) {
            let tools = self.temp.path().join("tools");
            fs::create_dir_all(&tools).unwrap();
            let exe = tools.join(file_name);
            fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
            self.supervisor
                .register_tool(RegisterToolRequest {
                    candidate_path: exe.to_string_lossy().to_string(),
                    display_name: "Fake".into(),
                    category: "network".into(),
                    risk_tier: "low".into(),
                    doc_url: String::new(),
                    tags: vec![],
                    working_dir: tools.to_string_lossy().to_string(),
                    confirmed: true,
                })
                .unwrap();
        }
    }

    const PHOTO: &[u8] = b"\xFF\xD8\xFF\xE0jpeg";

    /// A parser that says what it was told about the run: the paths and names
    /// the tool was given come back as facts, so a test can read them.
    fn record_context(_logs: &RunLogs, ctx: &ParseContext) -> Result<Vec<Fact>, String> {
        let mut facts = vec![
            Fact::new(Group::Detail, "test.inputPath", ctx.input_path.clone()),
            Fact::new(Group::Detail, "test.inputName", ctx.input_name.clone()),
        ];
        if let Some(path) = &ctx.rules_path {
            facts.push(Fact::new(Group::Detail, "test.rulesPath", path.clone()));
        }
        if let Some(name) = &ctx.rules_name {
            facts.push(Fact::new(Group::Detail, "test.rulesName", name.clone()));
        }
        Ok(facts)
    }

    /// The fake as a tool that takes rules: the rules' path comes before the
    /// input's in its argument list, as YARA's does.
    const FAKE_RULES: ExternalTool = ExternalTool {
        id: "yara",
        name: "YARA",
        catalog_id: "yara",
        accepts: &[],
        executables: &["yara64.exe"],
        argv: &[
            "--exact",
            "external_tools::run_tests::fake_args_tool",
            "--nocapture",
            "{rules}",
            "{input}",
        ],
        needs_rules: true,
        parse: record_context,
        ..FAKE
    };

    /// The fake as a tool that takes rules and prints the paths back.
    const ECHO_RULES: ExternalTool = ExternalTool {
        argv: &[
            "--exact",
            "external_tools::run_tests::fake_echo_tool",
            "--nocapture",
            "{rules}",
            "{input}",
        ],
        ..FAKE_RULES
    };

    /// Change a copy's bytes without changing its size: its SHA-256 no longer
    /// matches the record's.
    fn tamper(copy: &Path) {
        let mut permissions = fs::metadata(copy).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(copy, permissions).unwrap();
        let mut bytes = fs::read(copy).unwrap();
        bytes[0] ^= 0x01;
        fs::write(copy, bytes).unwrap();
    }

    #[test]
    fn a_run_on_a_verified_copy_ends_hashed_and_parsed() {
        let case = case();
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", b"\xFF\xD8\xFF\xE0jpeg");
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();

        let run = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        })
        .unwrap();
        assert_eq!(run.state, "succeeded");
        assert_eq!(run.descriptor_id.as_deref(), Some("exiftool"));
        assert_eq!(run.trigger.by, "user");
        let subject = run.subject.clone().unwrap();
        assert_eq!(subject.file_id.as_deref(), Some(id.as_str()));
        assert_eq!(
            subject.file_sha256.as_deref(),
            Some(prepared.file.sha256.as_str())
        );
        assert_eq!(run.outputs.len(), 2);
        let camera = run
            .observations
            .iter()
            .find(|o| o.key == "exiftool.camera")
            .unwrap();
        assert_eq!(
            (camera.group, camera.value.clone()),
            (Group::Summary, "Canon EOS R6".into())
        );
        // The tool got a plain path, not the `\\?\` form of a canonical one
        // (it says so itself: the run's record has the path blanked out).
        assert!(case.log(&run, "stdout.log").contains("plain=true"));
        assert_eq!(run.argv.last().map(String::as_str), Some("[REDACTED]"));
        assert_eq!(case.supervisor.described_runs("eng_1").unwrap().len(), 1);
    }

    #[test]
    fn a_tool_that_is_not_registered_is_refused_before_anything_runs() {
        let case = case();
        let id = case.add("photo.jpg", b"\xFF\xD8\xFF\xE0jpeg");
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();
        let refused = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        });
        assert_eq!(refused.err(), Some("tool_not_installed".to_string()));
        assert!(case.supervisor.list_runs().unwrap().is_empty());
    }

    #[test]
    fn a_blocked_run_comes_back_without_waiting() {
        let case = case();
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", b"\xFF\xD8\xFF\xE0jpeg");
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();
        // Consent withdrawn between the check and the start.
        let run = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            false
        })
        .unwrap();
        assert_eq!(
            (run.state.as_str(), run.blocked_reason.as_str()),
            ("blocked", "consent_revoked")
        );
    }

    #[test]
    fn a_file_is_checked_before_it_is_hashed_and_rules_must_be_text() {
        let case = case();
        let photo = case.add("photo.jpg", b"\xFF\xD8\xFF\xE0jpeg");
        let notes = case.add("notes.txt", b"hello");
        let blob = case.add("blob.dat", &[0u8, 1, 2, 3]);
        let exif = tool("exiftool").unwrap();
        let yara = tool("yara").unwrap();
        let go = |file: &str, rules: Option<&str>, tool: &ExternalTool| {
            prepare(&case.files, &case.folder, "eng_1", file, rules, tool).err()
        };

        assert_eq!(go(&notes, None, exif), Some("tool_not_for_kind".into()));
        assert_eq!(go("file_none", None, exif), Some("unknown_file".into()));
        assert_eq!(go(&photo, None, yara), Some("rules_required".into()));
        assert_eq!(go(&photo, Some(&blob), yara), Some("rules_not_text".into()));
        let small = ExternalTool {
            max_input_bytes: 4,
            ..FAKE
        };
        assert_eq!(go(&photo, None, &small), Some("file_too_large".into()));
        let ready = prepare(
            &case.files,
            &case.folder,
            "eng_1",
            &photo,
            Some(&notes),
            yara,
        )
        .unwrap();
        assert_eq!(ready.rules.as_ref().unwrap().0.id, notes);

        // The copy changed after it was added: no path is handed out.
        let copy = case.folder.join("files").join("photo.jpg");
        let mut permissions = fs::metadata(&copy).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&copy, permissions).unwrap();
        fs::write(&copy, b"\xFF\xD8\xFF\xE0JPEG").unwrap();
        assert_eq!(go(&photo, None, exif), Some("file_changed".into()));
    }

    // YARA follows `include "..."` in a rules
    // file and its command line cannot switch that off, so a rules file could
    // make it read local files that never went through `verified_copy`.
    #[test]
    fn a_rules_file_that_includes_another_file_is_refused() {
        let case = case();
        let photo = case.add("photo.jpg", PHOTO);
        let yara = tool("yara").unwrap();
        let go = |rules: &str| {
            let rules = case.add("rules.yar", rules.as_bytes());
            let outcome = prepare(
                &case.files,
                &case.folder,
                "eng_1",
                &photo,
                Some(&rules),
                yara,
            );
            outcome.err()
        };
        let refused = Some("rules_include_not_allowed".to_string());

        // On a line of its own, before the rules.
        assert_eq!(
            go("include \"other.yar\"\n\nrule a { condition: true }\n"),
            refused
        );
        // After a rule, on the same line.
        assert_eq!(
            go("rule b { condition: true } include \"other.yar\"\n"),
            refused
        );
        // The gap before the quote: a tab is one YARA takes. No gap at all is
        // not (YARA wants a blank), and the check refuses it too.
        assert_eq!(
            go("rule c { condition: true }\ninclude\t\"x.yar\"\n"),
            refused
        );
        assert_eq!(
            go("rule d { condition: true }\ninclude\"x.yar\"\n"),
            refused
        );
        // Nothing has to stand before `include`. When a number touches it,
        // YARA's lexer reads the number and then the directive, because a
        // number never takes in the letters after it; asking for a boundary
        // before `include` let all of these through. A whole number, a hex
        // one, one with a unit, a fraction; the first names a network share.
        for glued in [
            "rule j { condition: 1include \"\\\\host\\share\\x.yar\" }\n",
            "rule k { condition: 0x1include \"x.yar\" }\n",
            "rule l { condition: 10KBinclude \"x.yar\" }\n",
            "rule m { condition: 1.5include \"x.yar\" }\n",
        ] {
            assert_eq!(go(glued), refused, "{glued}");
        }
        // The price of asking for no boundary: a word that only ends in
        // `include` is refused too when a quote follows it.
        assert_eq!(go("rule n { condition: myinclude \"x.yar\" }\n"), refused);
        // A match inside a comment or a string is refused too: the check does
        // not try to understand the file.
        assert_eq!(
            go("// include \"other.yar\"\nrule e { condition: true }\n"),
            refused
        );
        assert_eq!(
            go("rule f { strings: $a = \"include\" condition: $a }\n"),
            refused
        );

        // Rules without the directive pass, whatever else they say about
        // inclusion: only `include` followed by a quote is a directive.
        // YARA's keywords have no case, and a quote with a backslash before it
        // is not the start of a file name.
        for fine in [
            "rule g { condition: true }\n",
            "rule included { meta: note = \"includes a header\" condition: true }\n",
            "rule h { meta: include_me = 1 condition: true }\n",
            "rule reinclude { meta: note = \"include\\n\" condition: 1 == 1 }\n",
            "rule i { meta: note = \"include \\\"x\\\"\" condition: true }\n",
            "rule INCLUDE_NOT { condition: true }\nINCLUDE \"x.yar\"\n",
        ] {
            assert_eq!(go(fine), None, "{fine}");
        }
    }

    #[test]
    fn rules_are_checked_for_includes_whatever_their_encoding() {
        let case = case();
        let photo = case.add("photo.jpg", PHOTO);
        let yara = tool("yara").unwrap();
        // Text for the first 4 KiB, so the file is typed as text; a byte that
        // is no UTF-8 after that (a comment in Latin-1) must not hide what
        // follows it, nor make the file unreadable.
        let mut padded = "// padding\n".repeat(500).into_bytes();
        padded.extend_from_slice(b"// caf\xE9\nrule a { condition: true }\n");
        let go = |tail: &[u8]| {
            let mut bytes = padded.clone();
            bytes.extend_from_slice(tail);
            let rules = case.add("rules.yar", &bytes);
            prepare(
                &case.files,
                &case.folder,
                "eng_1",
                &photo,
                Some(&rules),
                yara,
            )
            .err()
        };

        assert_eq!(
            go(b"include \"x.yar\"\n"),
            Some("rules_include_not_allowed".into())
        );
        assert_eq!(go(b"rule b { condition: true }\n"), None);
    }

    // Review fix: the rules (at most 16 MiB) are verified and read before the
    // input (a file can be 4 GiB) is hashed, so rules that are refused cost
    // no hash of the input.
    #[test]
    fn rules_are_verified_and_checked_before_the_input_is_hashed() {
        let case = case();
        let photo = case.add("photo.jpg", PHOTO);
        let clean = case.add("clean.yar", b"rule a { condition: true }\n");
        let bad = case.add(
            "bad.yar",
            b"include \"x.yar\"\nrule b { condition: true }\n",
        );
        let yara = tool("yara").unwrap();
        let go = |rules: &str| {
            prepare(
                &case.files,
                &case.folder,
                "eng_1",
                &photo,
                Some(rules),
                yara,
            )
            .err()
        };
        let copy = |name: &str| case.folder.join("files").join(name);

        // The input's copy is damaged: hashing it would give file_changed.
        tamper(&copy("photo.jpg"));
        assert_eq!(go(&clean), Some("file_changed".into()));
        // Rules with an include are refused before it is looked at.
        assert_eq!(go(&bad), Some("rules_include_not_allowed".into()));

        // Both copies are damaged, each in its own way: the rules' word comes
        // first. The input would say file_missing, the rules say file_changed.
        fs::remove_file(copy("photo.jpg")).unwrap();
        tamper(&copy("clean.yar"));
        assert_eq!(go(&clean), Some("file_changed".into()));
        // With rules that are whole, the input's word is the one that is heard.
        let fine = case.add("fine.yar", b"rule c { condition: true }\n");
        assert_eq!(go(&fine), Some("file_missing".into()));
    }

    // Review fix: each way a rules file can be wrong has a code of its own, and
    // `unknown_file` is only ever the input.
    #[test]
    fn a_rules_file_is_told_apart_by_what_is_wrong_with_it() {
        let case = case();
        let photo = case.add("photo.jpg", PHOTO);
        let blob = case.add("blob.dat", &[0u8, 1, 2, 3]);
        let yara = tool("yara").unwrap();
        let go = |file: &str, rules: &str| {
            prepare(&case.files, &case.folder, "eng_1", file, Some(rules), yara).err()
        };

        assert_eq!(go(&photo, "file_none"), Some("unknown_rules_file".into()));
        assert_eq!(go("file_none", &blob), Some("unknown_file".into()));
        assert_eq!(go(&photo, &blob), Some("rules_not_text".into()));

        // One byte over the cap is refused before a byte of it is read.
        let cap = usize::try_from(MAX_RULES_BYTES).unwrap();
        let over = case.add("over.yar", &vec![b'a'; cap + 1]);
        assert_eq!(go(&photo, &over), Some("rules_too_large".into()));
    }

    // The cap is 16 MiB: that many bytes pass and one more does not, and a
    // file that is not text is told so first. Checked on records, so no
    // 16 MiB file is made for it.
    #[test]
    fn the_rules_cap_is_exact_and_not_text_comes_first() {
        let record = |kind: &str, bytes: u64| InvestigationFile {
            id: "file_1".into(),
            engagement_id: "eng_1".into(),
            rel_path: "files/rules.yar".into(),
            name: "rules.yar".into(),
            original_name: "rules.yar".into(),
            bytes,
            sha256: String::new(),
            sha1: String::new(),
            md5: String::new(),
            kind: kind.into(),
            sample: false,
            source: "picked".into(),
            added_at: 0,
        };

        assert_eq!(rules_record_problem(&record("text", 0)), None);
        assert_eq!(rules_record_problem(&record("text", MAX_RULES_BYTES)), None);
        assert_eq!(
            rules_record_problem(&record("text", MAX_RULES_BYTES + 1)),
            Some("rules_too_large")
        );
        for bytes in [1, MAX_RULES_BYTES + 1] {
            assert_eq!(
                rules_record_problem(&record("binary", bytes)),
                Some("rules_not_text")
            );
        }
    }

    // Review fix: nothing pinned how the rules travel with a run.
    #[test]
    fn rules_reach_the_tool_the_parser_and_the_runs_subject() {
        let case = case();
        case.register("yara64.exe");
        // The folder as the engagement store keeps it, canonical, so the paths
        // are only plain once they are shown.
        let folder = fs::canonicalize(&case.folder).unwrap();
        let sample = case.add_to(&folder, "evidence.txt", b"some text\n");
        let rules = case.add_to(&folder, "rules.yar", b"rule a { condition: true }\n");
        let prepared = prepare(
            &case.files,
            &folder,
            "eng_1",
            &sample,
            Some(&rules),
            &FAKE_RULES,
        )
        .unwrap();
        let (rules_file, rules_copy) = prepared.rules.clone().unwrap();

        let run = run_on_file(
            &case.supervisor,
            &FAKE_RULES,
            &prepared,
            Arc::new(|_| {}),
            || true,
        )
        .unwrap();
        assert_eq!(run.state, "succeeded");

        // The tool got the rules' path and then the input's, both plain; the
        // run's record has them blanked out.
        let (rules_arg, input_arg) = (display_path(&rules_copy), display_path(&prepared.path));
        let said = case.log(&run, "stdout.log");
        let files: Vec<&str> = said
            .lines()
            .filter(|line| line.starts_with("file-arg"))
            .collect();
        assert_eq!(
            files,
            [
                "file-arg rules.yar plain=true",
                "file-arg evidence.txt plain=true"
            ]
        );
        assert_eq!(
            &run.argv[run.argv.len() - 2..],
            ["[REDACTED]", "[REDACTED]"]
        );
        let (rules_arg, input_arg) = (&rules_arg, &input_arg);
        // The parser was told those paths, and the names to show in their place.
        let seen = |key: &str| {
            run.observations
                .iter()
                .find(|o| o.key == key)
                .and_then(|o| o.value.as_str())
                .map(str::to_string)
        };
        assert_eq!(seen("test.rulesPath").as_deref(), Some(rules_arg.as_str()));
        assert_eq!(seen("test.inputPath").as_deref(), Some(input_arg.as_str()));
        assert_eq!(
            seen("test.rulesName").as_deref(),
            Some(rules_file.name.as_str())
        );
        assert_eq!(
            seen("test.inputName").as_deref(),
            Some(prepared.file.name.as_str())
        );
        // The run's subject names both files with the hashes just checked.
        assert_ne!(rules_file.sha256, prepared.file.sha256);
        let subject = run.subject.clone().unwrap();
        assert_eq!(subject.file_id.as_deref(), Some(sample.as_str()));
        assert_eq!(
            subject.file_sha256.as_deref(),
            Some(prepared.file.sha256.as_str())
        );
        assert_eq!(subject.rules_file_id.as_deref(), Some(rules.as_str()));
        assert_eq!(
            subject.rules_sha256.as_deref(),
            Some(rules_file.sha256.as_str())
        );
    }

    // `accepts` is enforced here, because the
    // tools themselves are not strict (capinfos reads a JPEG as a "mime"
    // capture and exits 0).
    #[test]
    fn capinfos_is_offered_captures_and_never_a_photo() {
        let case = case();
        let photo = case.add("photo.jpg", PHOTO);
        let classic = case.add("classic.pcap", b"\xD4\xC3\xB2\xA1\x02\x00\x04\x00");
        let next = case.add("next.pcapng", b"\x0A\x0D\x0D\x0A\x1C\x00\x00\x00");
        let capinfos = tool("capinfos").unwrap();
        let go = |file: &str| {
            prepare(&case.files, &case.folder, "eng_1", file, None, capinfos).map(|_| ())
        };

        assert_eq!(go(&photo), Err("tool_not_for_kind".to_string()));
        assert_eq!(go(&classic), Ok(()));
        assert_eq!(go(&next), Ok(()));
    }

    // Review fix: ExifTool's JSON carries `SourceFile` and `System:Directory`,
    // YARA and capinfos name the file they read, and the logs are written,
    // hashed, shown and kept as evidence. The supervisor blanks the copy's and
    // the rules' paths, and their folder, out of what a program prints before
    // any of that, in each form it may print one.
    #[test]
    fn a_runs_logs_hold_neither_the_copys_path_nor_the_rules_path() {
        let case = case();
        case.register("yara64.exe");
        // The folder as the engagement store keeps it, canonical.
        let folder = fs::canonicalize(&case.folder).unwrap();
        let sample = case.add_to(&folder, "evidence.txt", b"some text\n");
        let rules = case.add_to(&folder, "rules.yar", b"rule a { condition: true }\n");
        let prepared = prepare(
            &case.files,
            &folder,
            "eng_1",
            &sample,
            Some(&rules),
            &ECHO_RULES,
        )
        .unwrap();
        let (_, rules_copy) = prepared.rules.clone().unwrap();
        let (input, rules_path) = (display_path(&prepared.path), display_path(&rules_copy));

        let run = run_on_file(
            &case.supervisor,
            &ECHO_RULES,
            &prepared,
            Arc::new(|_| {}),
            || true,
        )
        .unwrap();
        assert_eq!(run.state, "succeeded");

        let forms = |path: &str| {
            [
                path.to_string(),
                path.replace('\\', "/"),
                path.replace('\\', "\\\\"),
            ]
        };
        let folder = Path::new(&input)
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        for name in ["stdout.log", "stderr.log"] {
            let text = case.log(&run, name);
            for path in [&input, &rules_path, &folder] {
                for form in forms(path) {
                    assert!(!text.contains(&form), "{name} holds {form}: {text}");
                }
            }
            // Nor the folders the user named, nor the files' names inside them.
            for left in ["Documents", "case", "evidence.txt", "rules.yar"] {
                assert!(!text.contains(left), "{name} holds {left}: {text}");
            }
            // What was printed is there, with the marker where a path was:
            // three forms of each of two paths and of their folder, on this
            // stream.
            let stream = name.trim_end_matches(".log");
            let said = text
                .lines()
                .filter(|line| line.starts_with(&format!("{stream} says ")))
                .count();
            assert_eq!(said, 12, "{name}: {text}");
            assert_eq!(text.matches("[REDACTED]").count(), 12, "{name}: {text}");
            // The hash kept with the run is of what is on disk.
            let kept = run.outputs.iter().find(|o| o.name == name).unwrap();
            assert_eq!(
                kept.sha256,
                format!("{:x}", Sha256::digest(text.as_bytes()))
            );
            assert_eq!(kept.bytes, text.len() as u64);
        }
        // The run's own record has none of it either.
        let record = [
            run.command_preview.as_str(),
            run.stdout_tail.as_str(),
            run.stderr_tail.as_str(),
        ]
        .into_iter()
        .map(str::to_string)
        .chain(run.argv.iter().cloned())
        .collect::<Vec<_>>()
        .join("\n");
        for path in [&input, &rules_path] {
            assert!(!record.contains(path.as_str()), "{record}");
        }
        assert!(!record.contains("evidence.txt") && !record.contains("rules.yar"));
        // The parser still got the real paths and the names to show.
        let seen = |key: &str| {
            run.observations
                .iter()
                .find(|o| o.key == key)
                .and_then(|o| o.value.as_str())
                .map(str::to_string)
        };
        assert_eq!(seen("test.inputPath").as_deref(), Some(input.as_str()));
        assert_eq!(seen("test.rulesPath").as_deref(), Some(rules_path.as_str()));
        assert_eq!(seen("test.inputName").as_deref(), Some("evidence.txt"));
        assert_eq!(seen("test.rulesName").as_deref(), Some("rules.yar"));
    }

    #[test]
    fn a_canonical_folder_does_not_leak_its_prefix_to_the_tool() {
        let case = case();
        // The folder as the engagement store keeps it: canonical, so on
        // Windows it starts with `\\?\`.
        let folder = fs::canonicalize(&case.folder).unwrap();
        let id = case.add_to(&folder, "photo.jpg", PHOTO);
        case.register("exiftool.exe");
        let prepared = prepare(&case.files, &folder, "eng_1", &id, None, &FAKE).unwrap();
        assert!(prepared.path.to_string_lossy().starts_with(r"\\?\") || !cfg!(windows));

        let run = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        })
        .unwrap();
        assert_eq!(run.state, "succeeded");
        assert!(case.log(&run, "stdout.log").contains("plain=true"));
        // What is blanked out of its output is exactly what the tool was
        // given: the logs hold none of it (see the echo test below).
        assert_eq!(run.argv.last().map(String::as_str), Some("[REDACTED]"));
    }

    #[test]
    fn events_reach_the_sink_and_the_run_is_over_when_the_last_one_has() {
        let case = case();
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", PHOTO);
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&seen);
        let forward: EventSink = Arc::new(move |event: ToolRunEvent| {
            sink.lock().unwrap().push(event.kind);
        });

        let run = run_on_file(&case.supervisor, &FAKE, &prepared, forward, || true).unwrap();

        assert_eq!(run.state, "succeeded");
        let kinds = seen.lock().unwrap().clone();
        assert_eq!(kinds.first().map(String::as_str), Some("queued"));
        assert!(kinds.iter().any(|kind| kind == "started"));
        assert_eq!(kinds.last().map(String::as_str), Some("finished"));
    }

    #[test]
    fn a_run_that_fails_is_a_run_not_an_error() {
        let case = case();
        case.register("exiftool.exe");
        let id = case.add("broken.jpg", PHOTO);
        let failing = ExternalTool {
            argv: &[
                "--exact",
                "external_tools::run_tests::fake_failing_tool",
                "--nocapture",
                "{input}",
            ],
            ..FAKE
        };
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &failing).unwrap();

        let run = run_on_file(
            &case.supervisor,
            &failing,
            &prepared,
            Arc::new(|_| {}),
            || true,
        )
        .unwrap();

        assert_eq!(
            (
                run.state.as_str(),
                run.termination_reason.as_str(),
                run.exit_code
            ),
            ("failed", "non_zero_exit", Some(3))
        );
        // Its logs are kept and hashed; the page reads the complaint there.
        assert_eq!(run.outputs.len(), 2);
        assert_eq!(
            case.supervisor.described_runs("eng_1").unwrap()[0].id,
            run.id
        );
    }

    // The supervisor still checks the program's hash for a descriptor run. A
    // program that changed since it was registered is not started and the
    // attempt is a `blocked` run; once the stored record says so, the next try
    // is refused up front, with no run made.
    #[test]
    fn a_program_that_changed_is_blocked_and_then_refused_up_front() {
        let case = case();
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", PHOTO);
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();
        let exe = case.temp.path().join("tools").join("exiftool.exe");
        fs::OpenOptions::new()
            .append(true)
            .open(&exe)
            .unwrap()
            .write_all(b"changed")
            .unwrap();

        let blocked = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        })
        .unwrap();
        assert_eq!(
            (blocked.state.as_str(), blocked.blocked_reason.as_str()),
            ("blocked", "tool_identity_changed")
        );
        assert!(blocked.pid.is_none() && blocked.outputs.is_empty());

        let again = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        });
        assert_eq!(again.err(), Some("tool_identity_changed".to_string()));
        assert_eq!(case.supervisor.described_runs("eng_1").unwrap().len(), 1);
    }

    #[test]
    fn a_program_that_is_turned_off_or_gone_stops_the_run_and_says_which() {
        let case = case();
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", PHOTO);
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();
        let installation = case.supervisor.list_tools().unwrap().remove(0).id;

        // Turned off: refused up front, no run is made.
        case.supervisor
            .set_tool_enabled(&installation, false)
            .unwrap();
        let off = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        });
        assert_eq!(off.err(), Some("tool_disabled".to_string()));
        assert!(case.supervisor.list_runs().unwrap().is_empty());
        case.supervisor
            .set_tool_enabled(&installation, true)
            .unwrap();

        // Deleted since it was registered: only the start finds out, and the
        // attempt is a `blocked` run that the investigation's list shows.
        fs::remove_file(case.temp.path().join("tools").join("exiftool.exe")).unwrap();
        let gone = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        })
        .unwrap();
        assert_eq!(
            (gone.state.as_str(), gone.blocked_reason.as_str()),
            ("blocked", "tool_path_missing")
        );
        assert_eq!(
            case.supervisor.described_runs("eng_1").unwrap()[0].id,
            gone.id
        );
    }

    // What the supervisor refuses outright (no run is recorded) comes back
    // to the page as the code it gave.
    #[test]
    fn a_ledger_that_cannot_be_written_stops_the_run_before_it_starts() {
        // A ledger from a newer version is read, never written.
        let case = case_with(Some(r#"{"version":3,"runs":[]}"#));
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", PHOTO);
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();

        let refused = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        });

        assert_eq!(refused.err(), Some("run_ledger_read_only".to_string()));
        assert!(case.supervisor.list_runs().unwrap().is_empty());
        assert_eq!(case.run_folders(), 0);
    }

    /// Windows answers `create_new` on a folder's name with "access denied",
    /// so a folder where the version-1 backup goes makes the backup fail.
    #[cfg(windows)]
    #[test]
    fn a_version_1_ledger_whose_backup_cannot_be_kept_stops_the_run() {
        let case = case_with(Some(r#"{"version":1,"runs":[]}"#));
        fs::create_dir(
            case.temp
                .path()
                .join("appdata")
                .join("lab")
                .join("tool-runs.v1.json"),
        )
        .unwrap();
        case.register("exiftool.exe");
        let id = case.add("photo.jpg", PHOTO);
        let prepared = prepare(&case.files, &case.folder, "eng_1", &id, None, &FAKE).unwrap();

        let refused = run_on_file(&case.supervisor, &FAKE, &prepared, Arc::new(|_| {}), || {
            true
        });

        assert_eq!(refused.err(), Some("run_ledger_backup_failed".to_string()));
        assert!(case.supervisor.list_runs().unwrap().is_empty());
        assert_eq!(case.run_folders(), 0);
    }

    #[test]
    fn a_path_too_long_for_the_tools_input_is_refused_before_anything_is_made() {
        let case = case();
        case.register("exiftool.exe");
        // A folder of letters that take two bytes each, nested deep enough for
        // the path alone to be over the 2 KiB a tool's input may hold.
        let mut folder = case.folder.clone();
        for _ in 0..9 {
            folder.push("ş".repeat(120));
        }
        fs::create_dir_all(&folder).unwrap();
        let id = case.add_to(&folder, "photo.jpg", PHOTO);
        let via_stdin = ExternalTool {
            argv_stdin: Some(&[
                "--exact",
                "external_tools::run_tests::fake_tool",
                "--nocapture",
                "-",
            ]),
            ..FAKE
        };
        let prepared = prepare(&case.files, &folder, "eng_1", &id, None, &via_stdin).unwrap();
        assert!(display_path(&prepared.path).len() > 2048);

        let refused = run_on_file(
            &case.supervisor,
            &via_stdin,
            &prepared,
            Arc::new(|_| {}),
            || true,
        );

        assert_eq!(refused.err(), Some("input_too_large".to_string()));
        assert!(case.supervisor.list_runs().unwrap().is_empty());
        assert_eq!(case.run_folders(), 0);
    }

    fn ask<'a>(tool: &'a str, file: &'a str) -> RunRequest<'a> {
        RunRequest {
            engagement_id: "eng_1",
            file_id: file,
            tool,
            rules_file_id: None,
        }
    }

    // Review fix: the body of `external_tool_run` is a plain function, so its
    // order of refusals can be tested. Each word is heard before the next
    // check is made, and the file is hashed last.
    #[test]
    fn external_tool_run_refuses_in_a_fixed_order_and_hashes_last() {
        let case = case();
        let tools = [FAKE];
        let go = |request: RunRequest| {
            command_run(&tools, &case.states(), &request, Arc::new(|_| {})).err()
        };

        // Private Lab first, before the tool is even looked up.
        assert_eq!(
            go(ask("nope", "file_none")),
            Some("private_tools_consent_required".into())
        );
        case.grant();
        // Then the tool, before the investigation's folder.
        assert_eq!(go(ask("nope", "file_none")), Some("unknown_tool".into()));
        // Then the folder.
        assert_eq!(
            go(ask("exiftool", "file_none")),
            Some("no_engagement_folder".into())
        );
        let folder = case.make_folder();
        let id = case.add_to(&folder, "photo.jpg", PHOTO);
        // The input's copy is damaged: hashing it would say file_changed.
        tamper(&folder.join("files").join("photo.jpg"));
        // Then the program, before the file is looked up or hashed.
        assert_eq!(
            go(ask("exiftool", "file_none")),
            Some("tool_not_installed".into())
        );
        assert_eq!(go(ask("exiftool", &id)), Some("tool_not_installed".into()));
        case.register("exiftool.exe");
        // Then the file by its id, and its copy last.
        assert_eq!(
            go(ask("exiftool", "file_none")),
            Some("unknown_file".into())
        );
        assert_eq!(go(ask("exiftool", &id)), Some("file_changed".into()));
        // Nothing was started on the way.
        assert!(case.supervisor.list_runs().unwrap().is_empty());
    }

    #[test]
    fn external_tool_run_runs_the_tool_and_the_run_and_its_logs_read_back() {
        let case = case();
        case.grant();
        case.register("exiftool.exe");
        let folder = case.make_folder();
        let id = case.add_to(&folder, "photo.jpg", PHOTO);
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&seen);
        let forward: EventSink = Arc::new(move |event: ToolRunEvent| {
            sink.lock().unwrap().push(event.kind);
        });

        let run = command_run(&[FAKE], &case.states(), &ask("exiftool", &id), forward).unwrap();

        assert_eq!(run.state, "succeeded");
        // The engagement store's folder is canonical, and the tool still got a
        // plain path.
        assert!(case.log(&run, "stdout.log").contains("plain=true"));
        assert_eq!(
            seen.lock().unwrap().last().map(String::as_str),
            Some("finished")
        );
        // The page reads the run and its logs back through the other commands.
        let listed = command_runs(&case.consent, &case.supervisor, "eng_1").unwrap();
        assert_eq!(
            listed.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
            [run.id.as_str()]
        );
        let output = command_output(&case.consent, &case.supervisor, &run.id, "stdout.log");
        let output = output.unwrap();
        assert!(output.contains("Canon"));
        assert_eq!(
            hex::encode(Sha256::digest(output.as_bytes())),
            run.outputs[0].sha256
        );
    }

    #[test]
    fn the_other_commands_need_private_lab_too_and_check_what_they_are_given() {
        let case = case();
        let unknown_run = "run-00000000-0000-4000-8000-000000000000";
        let runs = |engagement: &str| command_runs(&case.consent, &case.supervisor, engagement);
        let output =
            |run: &str, name: &str| command_output(&case.consent, &case.supervisor, run, name);
        let consent_required = Some("private_tools_consent_required".to_string());

        // Without Private Lab: the runs and the logs are closed, and the list
        // is open but says so for every tool without reading the registry.
        assert_eq!(runs("eng_1").err(), consent_required);
        assert_eq!(output(unknown_run, "stdout.log").err(), consent_required);
        let closed = command_list(&case.consent, &case.supervisor);
        assert!(closed.iter().all(|tool| tool.status == "needs_consent"));

        case.grant();
        case.register("exiftool.exe");
        let listed: Vec<_> = command_list(&case.consent, &case.supervisor)
            .iter()
            .map(|tool| (tool.id, tool.status))
            .collect();
        assert_eq!(
            listed,
            [
                ("exiftool", "ready"),
                ("yara", "not_installed"),
                ("capinfos", "not_installed")
            ]
        );
        assert!(runs("eng_1").unwrap().is_empty());

        // What they are given is checked.
        assert_eq!(runs("../x").err(), Some("invalid_engagement_id".into()));
        assert_eq!(
            output("../x", "stdout.log").err(),
            Some("invalid_run_id".into())
        );
        assert_eq!(
            output(unknown_run, "..\\x").err(),
            Some("invalid_output_name".into())
        );
        assert_eq!(
            output(unknown_run, "stdout.log").err(),
            Some("unknown_run".into())
        );

        // Withdrawing Private Lab closes them again.
        case.consent.revoke().unwrap();
        assert_eq!(runs("eng_1").err(), consent_required);
        assert_eq!(output(unknown_run, "stdout.log").err(), consent_required);
    }

    // Review fix: a registry that cannot be read is logged (by its code, never
    // a path) and every tool shows as not installed.
    #[test]
    fn a_registry_that_cannot_be_read_shows_every_tool_as_not_installed() {
        let read = installations_or_log(Err("registry_lock_failed".to_string()));
        assert!(read.is_empty());
        assert!(views(Some(&read))
            .iter()
            .all(|tool| tool.status == "not_installed"));
    }

    // Acceptance tests with the real programs. They are ignored: a program's
    // path comes from an environment variable, and a test without one says so
    // and does nothing. Each makes its own input, with the real supervisor and
    // a real file store in a temporary folder; no sample and no file of the
    // user's is read. Run them with, for example:
    //   QUTRA_REAL_EXIFTOOL=<path> cargo test --lib -- --ignored --nocapture external_tools::run_tests::the_real_

    /// The path of a real program, from the environment variable `var`.
    fn real_program(var: &str) -> Option<PathBuf> {
        let path = std::env::var_os(var).map(PathBuf::from);
        if path.is_none() {
            eprintln!("skipped: set {var} to the path of the program to run this test");
        }
        path
    }

    impl Case {
        /// A real program, registered as the table's tool is: under its
        /// category, and with its own folder as its working folder.
        fn register_real(&self, program: &Path, tool: &ExternalTool) {
            self.supervisor
                .register_tool(RegisterToolRequest {
                    candidate_path: program.to_string_lossy().to_string(),
                    display_name: tool.name.into(),
                    category: tool.category.into(),
                    risk_tier: "low".into(),
                    doc_url: String::new(),
                    tags: vec![],
                    working_dir: String::new(),
                    confirmed: true,
                })
                .unwrap();
        }
    }

    /// A tiny JPEG: only an EXIF block (a make and a model) between the start
    /// and the end of the image.
    fn exif_jpeg(make: &str, model: &str) -> Vec<u8> {
        let text = |text: &str| {
            let mut bytes = text.as_bytes().to_vec();
            bytes.push(0);
            bytes
        };
        let (make, model) = (text(make), text(model));
        // A TIFF header, one block of two text entries, and the texts after it.
        let first_text = 8 + 2 + 2 * 12 + 4;
        let mut tiff = b"II*\0".to_vec();
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        for (tag, offset, text) in [
            (0x010Fu16, first_text, &make),
            (0x0110, first_text + make.len(), &model),
        ] {
            tiff.extend_from_slice(&tag.to_le_bytes());
            tiff.extend_from_slice(&2u16.to_le_bytes());
            tiff.extend_from_slice(&u32::try_from(text.len()).unwrap().to_le_bytes());
            tiff.extend_from_slice(&u32::try_from(offset).unwrap().to_le_bytes());
        }
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(&make);
        tiff.extend_from_slice(&model);
        let mut block = b"Exif\0\0".to_vec();
        block.extend_from_slice(&tiff);
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpeg.extend_from_slice(&u16::try_from(block.len() + 2).unwrap().to_be_bytes());
        jpeg.extend_from_slice(&block);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        jpeg
    }

    /// A capture of one Ethernet frame of 60 bytes: the classic file header
    /// (little-endian, microseconds), one packet's header and its bytes.
    fn one_packet_pcap() -> Vec<u8> {
        let mut pcap = vec![0xD4, 0xC3, 0xB2, 0xA1, 0x02, 0x00, 0x04, 0x00];
        for field in [0u32, 0, 65_535, 1] {
            pcap.extend_from_slice(&field.to_le_bytes());
        }
        for field in [1_700_000_000u32, 0, 60, 60] {
            pcap.extend_from_slice(&field.to_le_bytes());
        }
        pcap.extend_from_slice(&[0u8; 60]);
        pcap
    }

    /// Run the table's `tool` on `file` the way a command does, and show what
    /// the page would be shown: the run's end and its facts.
    fn run_the_real_tool(
        case: &Case,
        folder: &Path,
        tool: &ExternalTool,
        file: &str,
        rules: Option<&str>,
    ) -> NativeToolRun {
        let prepared = prepare(&case.files, folder, "eng_1", file, rules, tool).unwrap();
        let run =
            run_on_file(&case.supervisor, tool, &prepared, Arc::new(|_| {}), || true).unwrap();
        println!(
            "{}: state={} reason={} exit={:?} outputs={}",
            tool.id,
            run.state,
            run.termination_reason,
            run.exit_code,
            run.outputs.len()
        );
        for fact in &run.observations {
            println!("  {} = {} {:?}", fact.key, fact.value, fact.items);
        }
        assert_eq!(
            run.state, "succeeded",
            "{}: {}",
            run.termination_reason, run.stderr_tail
        );
        // The logs on disk, which the page shows raw and evidence hashes, hold
        // no folder of this machine either: the program printed the path it
        // was given (ExifTool's \`SourceFile\`, capinfos' file name) and the
        // supervisor blanked it.
        for name in ["stdout.log", "stderr.log"] {
            let text = fs::read_to_string(case.run_dir(&run).join(name)).unwrap_or_default();
            assert!(
                !text.contains("Users") && !text.contains(&display_path(&prepared.path)),
                "{name} holds a path: {text}"
            );
        }
        run
    }

    fn fact<'a>(run: &'a NativeToolRun, key: &str) -> &'a Observation {
        run.observations
            .iter()
            .find(|fact| fact.key == key)
            .unwrap_or_else(|| panic!("the run has no fact {key}"))
    }

    /// No fact holds a folder of this machine: the copy lives under the
    /// user's profile, so `Users` or a backslash would give one away.
    fn assert_no_path_in_facts(run: &NativeToolRun) {
        for fact in &run.observations {
            let value = fact
                .value
                .as_str()
                .map_or_else(|| fact.value.to_string(), str::to_string);
            let text = format!("{value} {}", fact.items.join(" "));
            assert!(
                !text.contains("Users") && !text.contains('\\'),
                "{} holds a path: {text}",
                fact.key
            );
        }
    }

    #[test]
    #[ignore = "runs the real ExifTool: set QUTRA_REAL_EXIFTOOL to its path"]
    fn the_real_exiftool_reads_a_photo_with_turkish_letters_in_its_name() {
        let Some(program) = real_program("QUTRA_REAL_EXIFTOOL") else {
            return;
        };
        let case = case();
        let exiftool = tool("exiftool").unwrap();
        case.register_real(&program, exiftool);
        // The folder as the app keeps it, and a name that ExifTool cannot be
        // given on a Windows command line: its path goes to standard input.
        let folder = fs::canonicalize(&case.folder).unwrap();
        let photo = case.add_to(
            &folder,
            "şüpheli fotoğraf.jpg",
            &exif_jpeg("QutraTest", "Fixture 1"),
        );

        let run = run_the_real_tool(&case, &folder, exiftool, &photo, None);

        // The name is not on the command line; its last argument tells
        // ExifTool to read the path from standard input.
        assert!(!run
            .argv
            .iter()
            .any(|argument| argument.contains("fotoğraf")));
        assert_eq!(run.argv.last().map(String::as_str), Some("-"));
        assert_eq!(fact(&run, "exiftool.type").value, "JPEG · image/jpeg");
        assert_eq!(fact(&run, "exiftool.camera").value, "QutraTest Fixture 1");
        assert_no_path_in_facts(&run);
    }

    #[test]
    #[ignore = "runs the real capinfos: set QUTRA_REAL_CAPINFOS to its path"]
    fn the_real_capinfos_counts_the_packet_of_a_one_packet_capture() {
        let Some(program) = real_program("QUTRA_REAL_CAPINFOS") else {
            return;
        };
        let case = case();
        let capinfos = tool("capinfos").unwrap();
        case.register_real(&program, capinfos);
        let folder = fs::canonicalize(&case.folder).unwrap();
        let capture = case.add_to(&folder, "capture.pcap", &one_packet_pcap());

        let run = run_the_real_tool(&case, &folder, capinfos, &capture, None);

        assert_eq!(fact(&run, "capinfos.packets").value, 1);
        assert_no_path_in_facts(&run);
    }

    #[test]
    #[ignore = "runs the real YARA: set QUTRA_REAL_YARA to its path"]
    fn the_real_yara_finds_the_string_its_one_rule_looks_for() {
        let Some(program) = real_program("QUTRA_REAL_YARA") else {
            return;
        };
        let case = case();
        let yara = tool("yara").unwrap();
        case.register_real(&program, yara);
        let folder = fs::canonicalize(&case.folder).unwrap();
        let sample = case.add_to(
            &folder,
            "evidence.txt",
            b"a text that holds qutra-marker-7f3a once\n",
        );
        let rules = case.add_to(
            &folder,
            "rules.yar",
            b"rule qutra_fixture_rule\n{\n    strings:\n        $a = \"qutra-marker-7f3a\"\n    condition:\n        $a\n}\n",
        );

        let run = run_the_real_tool(&case, &folder, yara, &sample, Some(&rules));

        assert_eq!(fact(&run, "yara.count").value, 1);
        let matches = fact(&run, "yara.matches");
        assert_eq!(matches.items.len(), 1);
        assert!(matches.items[0].starts_with("qutra_fixture_rule"));
        assert_eq!(fact(&run, "yara.rulesFile").value, "rules.yar");
        assert_no_path_in_facts(&run);
    }
}
