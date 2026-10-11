//! Files in an investigation (spec 2026-10-07 §4.2).
//!
//! A file the user adds is copied into the investigation's folder, under
//! `files\`, and never used in place. The copy is hashed while it is written
//! (SHA-256, SHA-1 and MD5 in one pass), typed by its first bytes, made
//! read-only, and given a `.sample` suffix when a double click could run it.
//! It keeps the original's modified time and mark of the web. The records
//! live in `<appData>\lab\investigation-files.json`.
//!
//! The renderer never names a path (as for Locate and the engagement
//! folders): Rust opens the picker, and a drop arrives as a Rust window event
//! that is remembered against a single-use token the renderer redeems.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use md5::Md5;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::engagement_folders::{is_reserved_name, validate_engagement_id};

const STORE_DIR: &str = "lab";
const STORE_FILE: &str = "investigation-files.json";
const STORE_VERSION: u32 = 1;
/// The folder inside an investigation's folder that holds its files.
pub const FILES_DIR: &str = "files";
/// Captures and disk images are expected; anything larger is refused.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;
const MAX_EXTENSION_CHARS: usize = 16;
const HEAD_BYTES: usize = 4096;
const COPY_BUFFER: usize = 64 * 1024;
/// A drop is redeemed by the add that follows it; one nobody redeems should
/// not hold paths forever.
const MAX_PENDING_DROPS: usize = 8;
const SAMPLE_SUFFIX: &str = ".sample";
/// A copy in progress writes to its `.part` file all the time; one untouched
/// this long was left by an app that stopped during the copy.
const STALE_PART_AGE: Duration = Duration::from_secs(10 * 60);

/// Kinds that run when opened: programs and Windows shortcuts.
const RISKY_KINDS: &[&str] = &["pe", "elf", "macho", "lnk"];
/// Extensions Windows runs, installs, merges or mounts on a double click.
const RISKY_EXTENSIONS: &[&str] = &[
    // Programs, installers, shortcuts and control panel items.
    "exe", "dll", "sys", "scr", "com", "pif", "msi", "msp", "msc", "cpl", "lnk", "url", "scf",
    "appx", "msix", "xll", // Scripts.
    "ps1", "psm1", "psd1", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "jar",
    "sh", "py", "pyw", "reg",
    // Documents that run macros, compiled help, and disk images that mount.
    "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "sldm", "chm", "iso", "img",
    "vhd", "vhdx",
];
/// Zip containers that are documents.
const OFFICE_EXTENSIONS: &[&str] = &["docx", "xlsx", "pptx", "odt", "ods", "odp"];

/// One file in an investigation, as it is recorded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationFile {
    pub id: String,
    pub engagement_id: String,
    /// The copy's path inside the investigation folder: `files/<name>`.
    pub rel_path: String,
    /// The copy's file name (with `.sample` when risky).
    pub name: String,
    /// The name the user's file had.
    pub original_name: String,
    pub bytes: u64,
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
    /// A type code from `detect_kind` ("jpeg", "pe", "pcap", "text", ...).
    pub kind: String,
    pub sample: bool,
    /// "picked" | "dropped" | "sample"
    pub source: String,
    pub added_at: u64,
}

/// A file as the renderer shows it: the record, and the state of its copy.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    #[serde(flatten)]
    pub file: InvestigationFile,
    /// The copy is not in the investigation's folder (or not whole) any more.
    pub missing: bool,
    /// The copy is marked read-only.
    pub read_only: bool,
}

impl FileView {
    fn of(file: InvestigationFile, folder: Option<&Path>) -> Self {
        let meta = folder.and_then(|folder| fs::metadata(copy_path(folder, &file.name)).ok());
        let present = meta
            .as_ref()
            .is_some_and(|meta| meta.is_file() && meta.len() == file.bytes);
        let read_only = present && meta.is_some_and(|meta| meta.permissions().readonly());
        Self {
            file,
            missing: !present,
            read_only,
        }
    }
}

/// What happened to one file the user added.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum AddOutcome {
    /// Copied, or copied back when the record's copy had gone missing.
    Added { file: FileView },
    /// The same content is already in this investigation; nothing was copied.
    Duplicate { file: FileView },
    #[serde(rename_all = "camelCase")]
    Failed {
        original_name: String,
        reason: String,
    },
}

/// How a file came in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Picked,
    Dropped,
    /// Made by the app's sample data (`sample_data.rs`).
    Sample,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Picked => "picked",
            Source::Dropped => "dropped",
            Source::Sample => "sample",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Store {
    version: u32,
    files: Vec<InvestigationFile>,
}

impl Store {
    fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            files: Vec::new(),
        }
    }
}

pub struct InvestigationFiles {
    store_path: PathBuf,
    /// False when writing would replace records this version cannot see: the
    /// store could not be read or set aside, or a newer version wrote it.
    writable: bool,
    data: Mutex<Store>,
    drops: Mutex<Vec<(String, Vec<PathBuf>)>>,
}

impl InvestigationFiles {
    pub fn load(app_data: &Path) -> Self {
        let store_path = app_data.join(STORE_DIR).join(STORE_FILE);
        let (data, writable) = match fs::read(&store_path) {
            Ok(bytes) => match serde_json::from_slice::<Store>(&bytes) {
                Ok(store) if store.version <= STORE_VERSION => (store, true),
                // Read what this version knows, but never write it back
                // without the fields it does not.
                Ok(store) => {
                    eprintln!(
                        "[Qutra Labs] investigation files are from a newer version ({})",
                        store.version
                    );
                    (store, false)
                }
                Err(_) => {
                    // Kept beside the store first; the empty store written
                    // next stops the next start from setting it aside again.
                    let kept = set_aside(&store_path, &bytes);
                    if kept {
                        if let Err(error) = write_store(&store_path, &Store::empty()) {
                            eprintln!("[Qutra Labs] investigation files not reset: {error}");
                        }
                    }
                    (Store::empty(), kept)
                }
            },
            Err(err) if err.kind() == io::ErrorKind::NotFound => (Store::empty(), true),
            Err(err) => {
                eprintln!("[Qutra Labs] investigation files unreadable: {err}");
                (Store::empty(), false)
            }
        };
        Self {
            store_path,
            writable,
            data: Mutex::new(data),
            drops: Mutex::new(Vec::new()),
        }
    }

    /// The investigation's files in the order they were added, each with the
    /// state of its copy in `folder` (every copy is missing without one).
    pub fn list(
        &self,
        engagement_id: &str,
        folder: Option<&Path>,
    ) -> Result<Vec<FileView>, String> {
        validate_engagement_id(engagement_id)?;
        let files: Vec<InvestigationFile> = {
            let data = self.data.lock().map_err(|_| "files_lock_failed")?;
            data.files
                .iter()
                .filter(|file| file.engagement_id == engagement_id)
                .cloned()
                .collect()
        };
        Ok(files
            .into_iter()
            .map(|file| FileView::of(file, folder))
            .collect())
    }

    /// Copy `source` into `<folder>\files\` and record it. The user's own
    /// file is only read.
    pub fn add(
        &self,
        folder: &Path,
        engagement_id: &str,
        source: &Path,
        how: Source,
    ) -> AddOutcome {
        let original_name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        match self.try_add(folder, engagement_id, source, &original_name, how) {
            Ok(outcome) => outcome,
            Err(reason) => AddOutcome::Failed {
                original_name,
                reason,
            },
        }
    }

    fn try_add(
        &self,
        folder: &Path,
        engagement_id: &str,
        source: &Path,
        original_name: &str,
        how: Source,
    ) -> Result<AddOutcome, String> {
        validate_engagement_id(engagement_id)?;
        let meta = fs::metadata(source).map_err(read_error)?;
        if !meta.is_file() {
            return Err("not_a_file".into());
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err("too_large".into());
        }
        let files_dir = folder.join(FILES_DIR);
        fs::create_dir_all(&files_dir).map_err(io_error)?;
        sweep_stale_parts(&files_dir);
        let part = files_dir.join(format!(".{}.part", uuid::Uuid::new_v4().simple()));
        let copied = copy_hashed(source, &part).inspect_err(|_| discard(&part))?;
        carry_zone_identifier(source, &part);
        // Last: writing the mark above counts as a change to the file.
        if let Err(err) = keep_modified_time(&meta, &part) {
            eprintln!("[Qutra Labs] the copy keeps today's modified time: {err}");
        }
        let extension = Path::new(original_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        let kind = detect_kind(&copied.head, extension.as_deref());
        let sample = is_risky(kind, extension.as_deref());

        let mut data = match self.data.lock() {
            Ok(data) => data,
            Err(_) => {
                discard(&part);
                return Err("files_lock_failed".into());
            }
        };
        let same = data
            .files
            .iter()
            .position(|file| file.engagement_id == engagement_id && file.sha256 == copied.sha256);
        if let Some(index) = same {
            let view = FileView::of(data.files[index].clone(), Some(folder));
            if !view.missing {
                discard(&part);
                return Ok(AddOutcome::Duplicate { file: view });
            }
            // Its copy is gone (deleted, or the folder was made again): this
            // add brings it back under the same record.
        }
        if !self.writable {
            discard(&part);
            return Err("store_unreadable".into());
        }
        // A name another record holds stays its own, even while its copy is
        // missing, so two records never share one copy.
        let taken: HashSet<String> = data
            .files
            .iter()
            .enumerate()
            .filter(|(index, file)| file.engagement_id == engagement_id && Some(*index) != same)
            .map(|(_, file)| file.name.to_lowercase())
            .collect();
        let wanted = match same {
            Some(index) => {
                let file = &data.files[index];
                stored_name(&file.original_name, file.sample)
            }
            None => stored_name(original_name, sample),
        };
        let target = reserve_name(&files_dir, &wanted, &taken).inspect_err(|_| discard(&part))?;
        // Replaces only the empty placeholder `reserve_name` just made.
        if let Err(err) = fs::rename(&part, &target) {
            discard(&part);
            discard(&target);
            return Err(io_error(err));
        }
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let rel_path = format!("{FILES_DIR}/{name}");
        let previous = same.map(|index| data.files[index].clone());
        let file = match same {
            Some(index) => {
                let restored = InvestigationFile {
                    rel_path,
                    name,
                    ..data.files[index].clone()
                };
                data.files[index] = restored.clone();
                restored
            }
            None => {
                let file = InvestigationFile {
                    id: format!("file_{}", uuid::Uuid::new_v4().simple()),
                    engagement_id: engagement_id.to_string(),
                    rel_path,
                    name,
                    original_name: original_name.to_string(),
                    bytes: copied.bytes,
                    sha256: copied.sha256,
                    sha1: copied.sha1,
                    md5: copied.md5,
                    kind: kind.to_string(),
                    sample,
                    source: how.as_str().to_string(),
                    added_at: now_ms(),
                };
                data.files.push(file.clone());
                file
            }
        };
        if let Err(reason) = self.persist(&data) {
            // Not recorded, so not kept: the copy would be a file nobody lists.
            match (same, previous) {
                (Some(index), Some(previous)) => data.files[index] = previous,
                _ => {
                    data.files.pop();
                }
            }
            discard(&target);
            return Err(reason);
        }
        drop(data);
        if let Err(err) = set_read_only(&target) {
            eprintln!(
                "[Qutra Labs] could not make {} read-only: {err}",
                target.display()
            );
        }
        Ok(AddOutcome::Added {
            file: FileView::of(file, Some(folder)),
        })
    }

    /// The copy of `file_id` in `folder`, once its SHA-256 matches the
    /// record again (§4.2): the only way an analyzer or a tool gets a file's
    /// path. `file_missing` when the copy is gone or not whole,
    /// `file_changed` when its content is no longer what was added.
    pub fn verified_copy(
        &self,
        folder: &Path,
        engagement_id: &str,
        file_id: &str,
    ) -> Result<(InvestigationFile, PathBuf), String> {
        validate_engagement_id(engagement_id)?;
        let file = {
            let data = self.data.lock().map_err(|_| "files_lock_failed")?;
            data.files
                .iter()
                .find(|file| file.id == file_id && file.engagement_id == engagement_id)
                .cloned()
        }
        .ok_or_else(|| "unknown_file".to_string())?;
        let path = copy_path(folder, &file.name);
        let whole =
            fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes);
        if !whole {
            return Err("file_missing".into());
        }
        if sha256_of(&path)? != file.sha256 {
            return Err("file_changed".into());
        }
        Ok((file, path))
    }

    /// Remember the paths of a drop on the window; the renderer redeems them
    /// with the returned token.
    pub fn remember_drop(&self, paths: Vec<PathBuf>) -> Result<String, String> {
        let token = uuid::Uuid::new_v4().to_string();
        let mut drops = self.drops.lock().map_err(|_| "files_lock_failed")?;
        drops.push((token.clone(), paths));
        let excess = drops.len().saturating_sub(MAX_PENDING_DROPS);
        drops.drain(..excess);
        Ok(token)
    }

    pub fn redeem_drop(&self, token: &str) -> Result<Vec<PathBuf>, String> {
        let mut drops = self.drops.lock().map_err(|_| "files_lock_failed")?;
        let index = drops
            .iter()
            .position(|(known, _)| known == token)
            .ok_or_else(|| "unknown_drop_token".to_string())?;
        Ok(drops.remove(index).1)
    }

    fn persist(&self, data: &Store) -> Result<(), String> {
        write_store(&self.store_path, data)
    }
}

fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store).map_err(|_| "files_serialize_failed")?;
    crate::durable_file::replace_file(path, &bytes).map_err(io_error)
}

fn copy_path(folder: &Path, name: &str) -> PathBuf {
    folder.join(FILES_DIR).join(name)
}

struct Copied {
    bytes: u64,
    sha256: String,
    sha1: String,
    md5: String,
    head: Vec<u8>,
}

/// Copy `source` to the new file `part`, hashing on the way.
fn copy_hashed(source: &Path, part: &Path) -> Result<Copied, String> {
    let mut input = File::open(source).map_err(read_error)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .map_err(io_error)?;
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5 = Md5::new();
    let mut head = Vec::with_capacity(HEAD_BYTES);
    let mut buffer = vec![0u8; COPY_BUFFER];
    let mut total: u64 = 0;
    loop {
        let read = match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(io_error(err)),
        };
        total += read as u64;
        // The file may have grown since its size was checked.
        if total > MAX_FILE_BYTES {
            return Err("too_large".into());
        }
        let chunk = &buffer[..read];
        if head.len() < HEAD_BYTES {
            let take = (HEAD_BYTES - head.len()).min(read);
            head.extend_from_slice(&chunk[..take]);
        }
        sha256.update(chunk);
        sha1.update(chunk);
        md5.update(chunk);
        output.write_all(chunk).map_err(io_error)?;
    }
    output.sync_all().map_err(io_error)?;
    Ok(Copied {
        bytes: total,
        sha256: hex::encode(sha256.finalize()),
        sha1: hex::encode(sha1.finalize()),
        md5: hex::encode(md5.finalize()),
        head,
    })
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(|_| "file_missing".to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; COPY_BUFFER];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hash.update(&buffer[..read]),
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(io_error(err)),
        }
    }
    Ok(hex::encode(hash.finalize()))
}

/// Give the copy the original's modified time.
fn keep_modified_time(original: &fs::Metadata, copy: &Path) -> io::Result<()> {
    let modified = original.modified()?;
    File::options()
        .write(true)
        .open(copy)?
        .set_modified(modified)
}

/// Keep the original's mark of the web (its `Zone.Identifier` stream), so a
/// downloaded document still opens in Protected View from the copy. A file
/// without one, or a drive without streams, is copied as it is.
#[cfg(windows)]
fn carry_zone_identifier(source: &Path, copy: &Path) {
    let stream = |path: &Path| {
        let mut name = path.as_os_str().to_os_string();
        name.push(":Zone.Identifier");
        PathBuf::from(name)
    };
    if let Ok(mark) = fs::read(stream(source)) {
        if let Err(err) = fs::write(stream(copy), mark) {
            eprintln!("[Qutra Labs] the copy lost its mark of the web: {err}");
        }
    }
}

#[cfg(not(windows))]
fn carry_zone_identifier(_source: &Path, _copy: &Path) {}

/// Create an empty placeholder under the first free name: `name`, then
/// `stem (2).ext`… Creating it, not checking for it, means two adds can
/// never pick the same name or replace a file already there. Names in
/// `taken` (lower case) belong to other records and are skipped too.
fn reserve_name(dir: &Path, name: &str, taken: &HashSet<String>) -> Result<PathBuf, String> {
    let (stem, rest) = split_name(name);
    for n in 1..1000 {
        let candidate = if n == 1 {
            name.to_string()
        } else {
            format!("{stem} ({n}){rest}")
        };
        if taken.contains(&candidate.to_lowercase()) {
            continue;
        }
        let path = dir.join(candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(io_error(err)),
        }
    }
    Err("file_name_taken".into())
}

/// "report.pdf" → ("report", ".pdf"); "tool.exe.sample" → ("tool", ".exe.sample").
fn split_name(name: &str) -> (String, String) {
    let (body, sample) = match name.strip_suffix(SAMPLE_SUFFIX) {
        Some(body) if !body.is_empty() => (body, SAMPLE_SUFFIX),
        _ => (name, ""),
    };
    match body.rfind('.') {
        Some(dot) if dot > 0 => (body[..dot].to_string(), format!("{}{sample}", &body[dot..])),
        _ => (body.to_string(), sample.to_string()),
    }
}

/// Remove the `.part` files of copies that never finished. Only this
/// module's own temporary names are touched, and only once nothing has
/// written to them for `STALE_PART_AGE`.
fn sweep_stale_parts(files_dir: &Path) {
    let Ok(entries) = fs::read_dir(files_dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(is_part_name) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_PART_AGE);
        if stale {
            discard(&entry.path());
        }
    }
}

/// `.<32 lower-case hex>.part`, as `try_add` names them.
fn is_part_name(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".part"))
        .is_some_and(|id| {
            id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// Remove a file this module made. A failure is logged, not hidden: a
/// sample that Defender holds stays in the folder.
fn discard(path: &Path) {
    if let Err(err) = fs::remove_file(path) {
        if err.kind() != io::ErrorKind::NotFound {
            eprintln!("[Qutra Labs] could not remove {}: {err}", path.display());
        }
    }
}

/// A Windows-safe name for the copy: reserved characters and direction
/// marks become spaces, spaces collapse, no leading or trailing dots, no
/// device names, at most 120 characters with the extension kept, and
/// `.sample` when risky.
pub fn stored_name(original: &str, risky: bool) -> String {
    let base = original.rsplit(['/', '\\']).next().unwrap_or(original);
    let (stem, extension) = match base.rfind('.') {
        Some(dot) if dot > 0 => (&base[..dot], Some(&base[dot + 1..])),
        _ => (base, None),
    };
    let mut extension = extension.map(clean_part).filter(|ext| !ext.is_empty());
    let mut stem = clean_part(stem);
    if extension
        .as_ref()
        .is_some_and(|ext| ext.chars().count() > MAX_EXTENSION_CHARS)
    {
        stem = clean_part(base);
        extension = None;
    }
    let suffix = if risky { SAMPLE_SUFFIX } else { "" };
    let reserved = extension.as_ref().map_or(0, |ext| ext.chars().count() + 1) + suffix.len();
    stem = stem
        .chars()
        .take(MAX_NAME_CHARS.saturating_sub(reserved))
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_string();
    if stem.is_empty() {
        stem = "file".into();
    }
    if is_reserved_name(&stem) {
        stem.push('_');
    }
    match extension {
        Some(ext) => format!("{stem}.{ext}{suffix}"),
        None => format!("{stem}{suffix}"),
    }
}

/// Characters that change the direction text is shown in: in a name they
/// can make "invoice\u{202E}gnp.exe" read as a picture.
fn is_direction_mark(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

fn clean_part(text: &str) -> String {
    let replaced: String = text
        .chars()
        .map(|c| {
            let bad = c.is_control()
                || is_direction_mark(c)
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*');
            if bad {
                ' '
            } else {
                c
            }
        })
        .collect();
    replaced
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(['.', ' '])
        .to_string()
}

/// The file's kind from its first bytes; the extension only tells documents
/// from other zip files.
pub fn detect_kind(head: &[u8], extension: Option<&str>) -> &'static str {
    const MAGIC: &[(&[u8], &str)] = &[
        (b"\xFF\xD8\xFF", "jpeg"),
        (b"\x89PNG\r\n\x1A\n", "png"),
        (b"GIF87a", "gif"),
        (b"GIF89a", "gif"),
        (b"%PDF-", "pdf"),
        (b"PK\x03\x04", "zip"),
        (b"\x7FELF", "elf"),
        (b"\xFE\xED\xFA\xCE", "macho"),
        (b"\xFE\xED\xFA\xCF", "macho"),
        (b"\xCE\xFA\xED\xFE", "macho"),
        (b"\xCF\xFA\xED\xFE", "macho"),
        (b"\xD4\xC3\xB2\xA1", "pcap"),
        (b"\xA1\xB2\xC3\xD4", "pcap"),
        (b"\x4D\x3C\xB2\xA1", "pcap"),
        (b"\xA1\xB2\x3C\x4D", "pcap"),
        (b"\x0A\x0D\x0D\x0A", "pcapng"),
        (b"ElfFile\x00", "evtx"),
        (b"SQLite format 3\x00", "sqlite"),
        (b"\x1F\x8B", "gzip"),
        (b"7z\xBC\xAF\x27\x1C", "7z"),
        (b"Rar!\x1A\x07", "rar"),
        (b"\x4C\x00\x00\x00\x01\x14\x02\x00", "lnk"),
    ];
    if let Some(&(_, kind)) = MAGIC.iter().find(|(magic, _)| head.starts_with(magic)) {
        let office = extension.is_some_and(|ext| OFFICE_EXTENSIONS.contains(&ext));
        return if kind == "zip" && office {
            "office"
        } else {
            kind
        };
    }
    // "MZ" also starts plain text ("MZ-2024,..."); a program's header has
    // NUL bytes among its first 64.
    if head.starts_with(b"MZ") && head.iter().take(64).any(|&byte| byte == 0) {
        return "pe";
    }
    // CA FE BA BE starts a Mach-O fat binary and a Java class file alike; a
    // fat binary's next word is its small count of architectures.
    if head.starts_with(b"\xCA\xFE\xBA\xBE") {
        let count = head
            .get(4..8)
            .map(|word| u32::from_be_bytes([word[0], word[1], word[2], word[3]]));
        return if count.is_some_and(|n| n > 0 && n < 32) {
            "macho"
        } else {
            "binary"
        };
    }
    if head.starts_with(b"\xEF\xBB\xBF")
        || head.starts_with(b"\xFF\xFE")
        || head.starts_with(b"\xFE\xFF")
    {
        return "text";
    }
    if !head.contains(&0) && looks_like_utf8(head) {
        "text"
    } else {
        "binary"
    }
}

/// Valid UTF-8, allowing a character cut off where the head ends.
fn looks_like_utf8(head: &[u8]) -> bool {
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(err) => err.error_len().is_none() && head.len() - err.valid_up_to() < 4,
    }
}

/// Programs, shortcuts, scripts, macro documents and disk images: a double
/// click on the copy must not run or mount them, so they get `.sample`.
pub fn is_risky(kind: &str, extension: Option<&str>) -> bool {
    RISKY_KINDS.contains(&kind)
        || extension
            .is_some_and(|ext| RISKY_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Keep an unreadable store beside it; true when it is safe to write a new
/// store over it.
fn set_aside(store_path: &Path, bytes: &[u8]) -> bool {
    let aside =
        store_path.with_file_name(format!("investigation-files.unreadable-{}.json", now_ms()));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&aside)
        .and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()))
    {
        Ok(()) => {
            eprintln!(
                "[Qutra Labs] investigation files unreadable; kept as {}",
                aside.display()
            );
            true
        }
        Err(err) => {
            eprintln!("[Qutra Labs] investigation files unreadable and not set aside: {err}");
            false
        }
    }
}

fn set_read_only(path: &Path) -> io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn read_error(err: io::Error) -> String {
    if err.kind() == io::ErrorKind::NotFound {
        "missing_file".into()
    } else {
        io_error(err)
    }
}

fn io_error(err: io::Error) -> String {
    format!("io:{err}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const ABC_SHA1: &str = "a9993e364706816aba3e25717850c26c9cd0d89d";
    const ABC_MD5: &str = "900150983cd24fb0d6963f7d28e17f72";

    struct Fixture {
        temp: tempfile::TempDir,
        store: InvestigationFiles,
        folder: PathBuf,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let store = InvestigationFiles::load(&temp.path().join("appdata"));
        let folder = temp.path().join("Investigation");
        fs::create_dir_all(&folder).unwrap();
        Fixture {
            temp,
            store,
            folder,
        }
    }

    impl Fixture {
        fn source(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let dir = self.temp.path().join("from");
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }

        fn add(&self, path: &Path) -> AddOutcome {
            self.store.add(&self.folder, "eng_1", path, Source::Picked)
        }

        fn list(&self) -> Vec<FileView> {
            self.store.list("eng_1", Some(&self.folder)).unwrap()
        }

        fn files_dir(&self) -> PathBuf {
            self.folder.join(FILES_DIR)
        }

        fn files_dir_entries(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(self.files_dir())
                .map(|dir| {
                    dir.flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        }

        /// Delete a copy the way a user would in Explorer.
        fn delete_copy(&self, name: &str) {
            let path = self.files_dir().join(name);
            make_writable(&path);
            fs::remove_file(path).unwrap();
        }
    }

    /// Clear a copy's read-only flag, as a user could in its properties.
    fn make_writable(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn a_copy_is_handed_out_only_while_its_content_is_what_was_added() {
        let fx = fixture();
        let file = added(fx.add(&fx.source("abc.txt", b"abc"))).file;
        let (record, path) = fx
            .store
            .verified_copy(&fx.folder, "eng_1", &file.id)
            .unwrap();
        assert_eq!(record.sha256, ABC_SHA256);
        assert_eq!(path, fx.files_dir().join("abc.txt"));
        let refused = |engagement: &str, id: &str| {
            fx.store
                .verified_copy(&fx.folder, engagement, id)
                .err()
                .unwrap_or_default()
        };
        assert_eq!(refused("eng_1", "file_none"), "unknown_file");
        assert_eq!(refused("eng_2", &file.id), "unknown_file");

        // Same size, other bytes: changed after it was added.
        make_writable(&path);
        fs::write(&path, b"abd").unwrap();
        assert_eq!(refused("eng_1", &file.id), "file_changed");

        fx.delete_copy("abc.txt");
        assert_eq!(refused("eng_1", &file.id), "file_missing");
    }

    fn added(outcome: AddOutcome) -> FileView {
        match outcome {
            AddOutcome::Added { file } => file,
            other => panic!("expected Added, got {other:?}"),
        }
    }

    fn failed(outcome: AddOutcome) -> String {
        match outcome {
            AddOutcome::Failed { reason, .. } => reason,
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn copies_hashes_and_records_a_file() {
        let fx = fixture();
        let source = fx.source("abc.txt", b"abc");

        let view = added(fx.add(&source));
        let file = &view.file;

        assert_eq!(file.name, "abc.txt");
        assert_eq!(file.original_name, "abc.txt");
        assert_eq!(file.rel_path, "files/abc.txt");
        assert_eq!(file.bytes, 3);
        assert_eq!(file.sha256, ABC_SHA256);
        assert_eq!(file.sha1, ABC_SHA1);
        assert_eq!(file.md5, ABC_MD5);
        assert_eq!(file.kind, "text");
        assert!(!file.sample);
        assert_eq!(file.source, "picked");
        assert!(!view.missing);
        assert!(view.read_only);
        let copy = fx.files_dir().join("abc.txt");
        assert_eq!(fs::read(&copy).unwrap(), b"abc");
        assert!(fs::metadata(&copy).unwrap().permissions().readonly());
        assert_eq!(
            fs::read(&source).unwrap(),
            b"abc",
            "the user's file is untouched"
        );
        assert!(!fs::metadata(&source).unwrap().permissions().readonly());
        assert_eq!(fx.list(), vec![view.clone()]);
        assert!(fx.store.list("eng_2", Some(&fx.folder)).unwrap().is_empty());
        // Remembered on disk, not only in memory.
        let again = InvestigationFiles::load(&fx.temp.path().join("appdata"));
        assert_eq!(again.list("eng_1", Some(&fx.folder)).unwrap(), vec![view]);
    }

    #[test]
    fn the_same_content_is_kept_once_and_a_taken_name_gets_a_number() {
        let fx = fixture();
        let first = added(fx.add(&fx.source("abc.txt", b"abc")));

        let again = fx.store.add(
            &fx.folder,
            "eng_1",
            &fx.source("copy of abc.txt", b"abc"),
            Source::Dropped,
        );
        assert_eq!(again, AddOutcome::Duplicate { file: first });

        let other = added(fx.add(&fx.source("abc.txt", b"other bytes")));
        assert_eq!(other.file.name, "abc (2).txt");
        assert_eq!(fx.files_dir_entries(), vec!["abc (2).txt", "abc.txt"]);
        assert_eq!(fx.list().len(), 2);

        // Another investigation keeps its own copy of the same content.
        let elsewhere = fx.temp.path().join("Elsewhere");
        let theirs = fx.store.add(
            &elsewhere,
            "eng_2",
            &fx.source("abc.txt", b"abc"),
            Source::Picked,
        );
        assert!(matches!(theirs, AddOutcome::Added { .. }), "{theirs:?}");
    }

    #[test]
    fn a_copy_deleted_in_explorer_comes_back_when_the_file_is_added_again() {
        let fx = fixture();
        let first = added(fx.add(&fx.source("report.pdf", b"%PDF-1.7 first")));
        fx.delete_copy("report.pdf");

        let listed = fx.list();
        assert!(listed[0].missing, "the card can say the copy is gone");
        assert!(!listed[0].read_only);

        let again = added(fx.add(&fx.source("report renamed.pdf", b"%PDF-1.7 first")));
        assert_eq!(again.file.id, first.file.id, "the same record");
        assert_eq!(again.file.name, "report.pdf");
        assert_eq!(again.file.original_name, "report.pdf");
        assert!(!again.missing);
        assert_eq!(fx.list(), vec![again]);
        assert_eq!(fx.files_dir_entries(), vec!["report.pdf"]);
    }

    #[test]
    fn a_name_a_record_holds_is_not_given_to_other_content() {
        let fx = fixture();
        added(fx.add(&fx.source("report.pdf", b"%PDF-1.7 first")));
        fx.delete_copy("report.pdf");

        let other = added(fx.add(&fx.source("report.pdf", b"%PDF-1.7 second")));

        assert_eq!(other.file.name, "report (2).pdf");
        assert_eq!(fx.files_dir_entries(), vec!["report (2).pdf"]);
    }

    #[test]
    fn programs_scripts_and_macro_documents_are_stored_as_samples() {
        let fx = fixture();
        let tool = added(fx.add(&fx.source("tool.exe", b"MZ\x90\x00program")));
        assert_eq!(tool.file.name, "tool.exe.sample");
        assert_eq!(tool.file.rel_path, "files/tool.exe.sample");
        assert_eq!(tool.file.kind, "pe");
        assert!(tool.file.sample);

        // A program renamed to look like a photo is caught by its bytes.
        let disguised = added(fx.add(&fx.source("photo.jpg", b"MZ\x90\x00another")));
        assert_eq!(disguised.file.name, "photo.jpg.sample");

        // A script or a macro document is risky by its extension alone.
        let script = added(fx.add(&fx.source("run.ps1", b"Write-Host hi")));
        assert_eq!(
            (script.file.kind.as_str(), script.file.name.as_str()),
            ("text", "run.ps1.sample")
        );
        let macro_doc = added(fx.add(&fx.source("invoice.docm", b"PK\x03\x04macros")));
        assert_eq!(macro_doc.file.name, "invoice.docm.sample");

        let again = added(fx.add(&fx.source("tool.exe", b"MZ\x90\x00changed")));
        assert_eq!(again.file.name, "tool (2).exe.sample");
    }

    #[test]
    fn refusals_copy_nothing() {
        let fx = fixture();
        let folder_drop = fx.temp.path().join("a folder");
        fs::create_dir_all(&folder_drop).unwrap();
        assert_eq!(failed(fx.add(&folder_drop)), "not_a_file");
        assert_eq!(
            failed(fx.add(&fx.temp.path().join("gone.txt"))),
            "missing_file"
        );
        let source = fx.source("abc.txt", b"abc");
        assert_eq!(
            failed(fx.store.add(&fx.folder, "../eng", &source, Source::Picked)),
            "invalid_engagement_id"
        );
        assert_eq!(
            fx.store.add(
                &fx.folder,
                "eng_1",
                &fx.temp.path().join("gone.txt"),
                Source::Picked
            ),
            AddOutcome::Failed {
                original_name: "gone.txt".into(),
                reason: "missing_file".into()
            }
        );
        assert!(fx.list().is_empty());
    }

    #[test]
    fn a_record_that_cannot_be_saved_leaves_no_copy_behind() {
        let fx = fixture();
        let store_path = fx
            .temp
            .path()
            .join("appdata")
            .join(STORE_DIR)
            .join(STORE_FILE);
        // A folder where the store file goes: the save after the copy fails.
        fs::create_dir_all(&store_path).unwrap();

        let reason = failed(fx.add(&fx.source("abc.txt", b"abc")));

        assert!(reason.starts_with("io:"), "{reason}");
        assert!(
            fx.files_dir_entries().is_empty(),
            "{:?}",
            fx.files_dir_entries()
        );
        assert!(fx.list().is_empty());
    }

    #[test]
    fn only_stale_parts_of_unfinished_copies_are_swept() {
        let fx = fixture();
        fs::create_dir_all(fx.files_dir()).unwrap();
        let stale = fx.files_dir().join(format!(".{}.part", "a".repeat(32)));
        let fresh = fx.files_dir().join(format!(".{}.part", "b".repeat(32)));
        let users = fx.files_dir().join("notes.part");
        for path in [&stale, &fresh, &users] {
            fs::write(path, b"half").unwrap();
        }
        let hour_ago = SystemTime::now() - Duration::from_secs(60 * 60);
        for path in [&stale, &users] {
            File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(hour_ago)
                .unwrap();
        }

        added(fx.add(&fx.source("abc.txt", b"abc")));

        assert!(!stale.exists(), "a stale part is swept");
        assert!(
            fresh.exists(),
            "a copy that may still be running is left alone"
        );
        assert!(
            users.exists(),
            "a name this module did not make is left alone"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_copy_keeps_the_originals_mark_of_the_web_and_modified_time() {
        let fx = fixture();
        let source = fx.source("invoice.pdf", b"%PDF-1.7 downloaded");
        let mark = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let mut stream = source.as_os_str().to_os_string();
        stream.push(":Zone.Identifier");
        fs::write(PathBuf::from(&stream), mark).unwrap();
        let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_modified(modified)
            .unwrap();

        let view = added(fx.add(&source));

        let copy = fx.files_dir().join(&view.file.name);
        let mut copy_stream = copy.as_os_str().to_os_string();
        copy_stream.push(":Zone.Identifier");
        assert_eq!(fs::read(PathBuf::from(copy_stream)).unwrap(), mark);
        assert_eq!(fs::metadata(&copy).unwrap().modified().unwrap(), modified);
    }

    #[test]
    fn drop_tokens_are_single_use_and_bounded() {
        let fx = fixture();
        let token = fx
            .store
            .remember_drop(vec![PathBuf::from("C:\\a.txt")])
            .unwrap();
        assert_eq!(
            fx.store.redeem_drop(&token).unwrap(),
            vec![PathBuf::from("C:\\a.txt")]
        );
        assert_eq!(
            fx.store.redeem_drop(&token),
            Err("unknown_drop_token".into())
        );

        let tokens: Vec<String> = (0..9)
            .map(|n| {
                fx.store
                    .remember_drop(vec![PathBuf::from(format!("{n}.txt"))])
                    .unwrap()
            })
            .collect();
        assert_eq!(
            fx.store.redeem_drop(&tokens[0]),
            Err("unknown_drop_token".into())
        );
        assert_eq!(
            fx.store.redeem_drop(&tokens[8]).unwrap(),
            vec![PathBuf::from("8.txt")]
        );
    }

    fn set_aside_copies(lab: &Path) -> Vec<PathBuf> {
        fs::read_dir(lab)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("investigation-files.unreadable-")
            })
            .collect()
    }

    #[test]
    fn an_unreadable_store_is_set_aside_once_before_anything_replaces_it() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("appdata");
        let lab = app_data.join(STORE_DIR);
        fs::create_dir_all(&lab).unwrap();
        fs::write(lab.join(STORE_FILE), b"{ not json").unwrap();

        let store = InvestigationFiles::load(&app_data);
        assert!(store.list("eng_1", None).unwrap().is_empty());
        let aside = set_aside_copies(&lab);
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read(&aside[0]).unwrap(), b"{ not json");

        // The next start reads the fresh store and sets nothing aside again.
        InvestigationFiles::load(&app_data);
        assert_eq!(set_aside_copies(&lab).len(), 1);

        // Adding works, and the set-aside copy is left as it was.
        let folder = temp.path().join("Investigation");
        let source = temp.path().join("abc.txt");
        fs::write(&source, b"abc").unwrap();
        assert!(matches!(
            store.add(&folder, "eng_1", &source, Source::Picked),
            AddOutcome::Added { .. }
        ));
        assert_eq!(fs::read(&aside[0]).unwrap(), b"{ not json");
    }

    #[test]
    fn a_store_that_cannot_be_read_is_never_written() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("appdata");
        // A folder where the store file should be: reading it fails, and it is
        // not "missing".
        fs::create_dir_all(app_data.join(STORE_DIR).join(STORE_FILE)).unwrap();

        let store = InvestigationFiles::load(&app_data);
        let folder = temp.path().join("Investigation");
        let source = temp.path().join("abc.txt");
        fs::write(&source, b"abc").unwrap();
        assert_eq!(
            store.add(&folder, "eng_1", &source, Source::Picked),
            AddOutcome::Failed {
                original_name: "abc.txt".into(),
                reason: "store_unreadable".into()
            }
        );
        let left: Vec<_> = fs::read_dir(folder.join(FILES_DIR))
            .unwrap()
            .flatten()
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_store_from_a_newer_version_is_read_but_never_written() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("appdata");
        let lab = app_data.join(STORE_DIR);
        fs::create_dir_all(&lab).unwrap();
        let newer = br#"{ "version": 2, "files": [], "labels": ["kept"] }"#;
        fs::write(lab.join(STORE_FILE), newer).unwrap();

        let store = InvestigationFiles::load(&app_data);
        let source = temp.path().join("abc.txt");
        fs::write(&source, b"abc").unwrap();
        let outcome = store.add(
            &temp.path().join("Investigation"),
            "eng_1",
            &source,
            Source::Picked,
        );

        assert_eq!(
            outcome,
            AddOutcome::Failed {
                original_name: "abc.txt".into(),
                reason: "store_unreadable".into()
            }
        );
        assert_eq!(fs::read(lab.join(STORE_FILE)).unwrap(), newer);
    }

    #[test]
    fn kinds_come_from_the_first_bytes() {
        let cases: &[(&[u8], &str)] = &[
            (b"\xFF\xD8\xFF\xE0", "jpeg"),
            (b"\x89PNG\r\n\x1A\n\0\0", "png"),
            (b"GIF89a", "gif"),
            (b"%PDF-1.7", "pdf"),
            (b"PK\x03\x04", "zip"),
            (b"MZ\x90\x00", "pe"),
            (b"\x7FELF\x02", "elf"),
            (b"\xCF\xFA\xED\xFE", "macho"),
            (b"\xCA\xFE\xBA\xBE\x00\x00\x00\x02", "macho"),
            (b"\xCA\xFE\xBA\xBE\x00\x00\x00\x34", "binary"),
            (b"\xD4\xC3\xB2\xA1", "pcap"),
            (b"\xA1\xB2\xC3\xD4", "pcap"),
            (b"\x0A\x0D\x0D\x0A", "pcapng"),
            (b"ElfFile\x00", "evtx"),
            (b"SQLite format 3\x00", "sqlite"),
            (b"\x1F\x8B\x08", "gzip"),
            (b"7z\xBC\xAF\x27\x1C", "7z"),
            (b"Rar!\x1A\x07\x00", "rar"),
            (b"\x4C\x00\x00\x00\x01\x14\x02\x00", "lnk"),
            (b"MZ-2024,north,12\n", "text"),
            (b"plain words\n", "text"),
            (b"\xFF\xFEh\0i\0", "text"),
            ("dosya notu: ğüşıöç".as_bytes(), "text"),
            (b"", "text"),
            (b"\x00\x01\x02\x03", "binary"),
            (b"\xC3\x28", "binary"),
        ];
        for (head, kind) in cases {
            assert_eq!(detect_kind(head, None), *kind, "{head:?}");
        }
        assert_eq!(detect_kind(b"PK\x03\x04", Some("docx")), "office");
        // A character cut where the 4 KiB head ends is still text.
        let mut head = "a".repeat(HEAD_BYTES - 1).into_bytes();
        head.push(0xC3);
        assert_eq!(detect_kind(&head, None), "text");
    }

    #[test]
    fn risky_files_are_programs_shortcuts_scripts_macros_and_images() {
        for kind in ["pe", "elf", "macho", "lnk"] {
            assert!(is_risky(kind, None), "{kind}");
        }
        for ext in [
            "exe", "DLL", "ps1", "bat", "cmd", "vbs", "js", "hta", "jar", "reg", "lnk", "docm",
            "xlsm", "chm", "iso", "vhdx",
        ] {
            assert!(is_risky("text", Some(ext)), "{ext}");
        }
        assert!(!is_risky("jpeg", Some("jpg")));
        assert!(!is_risky("pcap", Some("pcap")));
        assert!(!is_risky("office", Some("docx")));
        assert!(!is_risky("text", None));
    }

    #[test]
    fn stored_names_are_windows_safe() {
        assert_eq!(stored_name("re:port?.pdf", false), "re port.pdf");
        assert_eq!(stored_name("tool.exe", true), "tool.exe.sample");
        assert_eq!(stored_name("con.txt", false), "con_.txt");
        assert_eq!(stored_name("???", false), "file");
        assert_eq!(stored_name("...", false), "file");
        assert_eq!(stored_name(".bashrc", false), "bashrc");
        assert_eq!(stored_name("C:\\Users\\me\\x.log", false), "x.log");
        assert_eq!(
            stored_name("Fotoğraf 2026.jpeg", false),
            "Fotoğraf 2026.jpeg"
        );
        // A direction mark cannot make a program read as a picture.
        assert_eq!(
            stored_name("invoice\u{202E}gnp.exe", true),
            "invoice gnp.exe.sample"
        );
        let long = format!("{}.pdf", "a".repeat(300));
        let capped = stored_name(&long, false);
        assert_eq!(capped.chars().count(), MAX_NAME_CHARS);
        assert!(capped.ends_with("a.pdf"));
        let long_risky = stored_name(&format!("{}.exe", "b".repeat(300)), true);
        assert_eq!(long_risky.chars().count(), MAX_NAME_CHARS);
        assert!(long_risky.ends_with(".exe.sample"));
    }

    #[test]
    fn outcomes_serialize_for_the_renderer() {
        let failed = AddOutcome::Failed {
            original_name: "a.txt".into(),
            reason: "missing_file".into(),
        };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({ "outcome": "failed", "originalName": "a.txt", "reason": "missing_file" })
        );
        let fx = fixture();
        let file = added(fx.add(&fx.source("abc.txt", b"abc")));
        let value = serde_json::to_value(AddOutcome::Duplicate { file }).unwrap();
        assert_eq!(value["outcome"], "duplicate");
        assert_eq!(value["file"]["engagementId"], "eng_1");
        assert_eq!(value["file"]["relPath"], "files/abc.txt");
        assert_eq!(value["file"]["originalName"], "abc.txt");
        assert_eq!(value["file"]["missing"], false);
        assert_eq!(value["file"]["readOnly"], true);
        assert!(value["file"]["addedAt"].as_u64().is_some());
    }
}
