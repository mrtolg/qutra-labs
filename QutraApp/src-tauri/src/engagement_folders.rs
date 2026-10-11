//! A folder on disk for each security engagement: the
//! app keeps the engagement's files there by itself, its reports and an
//! up-to-date copy of its records, so the work is somewhere the user can see.
//!
//! The renderer never names a path to write to (as for Locate). A
//! folder is made here, either under `Documents\Qutra Labs` or inside a parent
//! the user picked in a native dialog this module opened, and is remembered
//! against its engagement. Writes go only into a folder made that way, by a
//! plain file name with a document extension, so a compromised page cannot
//! drop a file anywhere else on the machine.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

const STORE_DIR: &str = "lab";
const STORE_FILE: &str = "engagement-folders.json";
const STORE_VERSION: u32 = 1;
/// The folder under Documents that holds engagement folders by default.
pub const DEFAULT_ROOT_NAME: &str = "Qutra Labs";
const MAX_FOLDER_NAME: usize = 80;
const MAX_FILE_NAME: usize = 120;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const ALLOWED_EXTENSIONS: [&str; 4] = ["md", "json", "txt", "csv"];
/// A picked parent is redeemed by the create that follows it; a dialog left
/// open and abandoned should not hold a path forever.
const MAX_PENDING_PICKS: usize = 8;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    version: u32,
    folders: HashMap<String, PathBuf>,
}

/// A folder the user chose in the native dialog, shown for review and
/// redeemed by `create` through its single-use token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedParent {
    pub token: String,
    pub path: String,
}

/// An engagement's folder as the user should read it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
}

pub struct EngagementFolders {
    store_path: PathBuf,
    default_root: Option<PathBuf>,
    data: Mutex<Store>,
    picks: Mutex<Vec<(String, PathBuf)>>,
    /// False when the file on disk must not be written over: it could not be
    /// read, could not be kept aside, or is from a newer version. The map
    /// still serves this run; nothing is saved.
    writable: bool,
}

impl EngagementFolders {
    /// `documents` is the user's Documents folder, when the OS reports one.
    pub fn load(app_data: &Path, documents: Option<PathBuf>) -> Self {
        let store_path = app_data.join(STORE_DIR).join(STORE_FILE);
        let empty = || Store {
            version: STORE_VERSION,
            folders: HashMap::new(),
        };
        let (data, writable) = match fs::read(&store_path) {
            Ok(bytes) => match serde_json::from_slice::<Store>(&bytes) {
                Ok(store) if store.version == STORE_VERSION => (store, true),
                // Read what this version knows, but never write it back
                // without the fields it does not.
                Ok(store) if store.version > STORE_VERSION => {
                    eprintln!(
                        "[Qutra Labs] engagement folders are from a newer version ({})",
                        store.version
                    );
                    (store, false)
                }
                _ => match crate::durable_file::keep_unreadable(&store_path, &bytes) {
                    Ok(kept) => {
                        eprintln!(
                            "[Qutra Labs] engagement folders unreadable; kept as {}",
                            kept.display()
                        );
                        // The empty store written now stops the next start
                        // from keeping the same bytes again.
                        let fresh = empty();
                        let written = serde_json::to_vec_pretty(&fresh).ok().is_some_and(|bytes| {
                            crate::durable_file::replace_file(&store_path, &bytes).is_ok()
                        });
                        (fresh, written)
                    }
                    Err(error) => {
                        eprintln!(
                            "[Qutra Labs] engagement folders unreadable and not kept: {error}"
                        );
                        (empty(), false)
                    }
                },
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (empty(), true),
            Err(error) => {
                eprintln!("[Qutra Labs] engagement folders unreadable: {error}");
                (empty(), false)
            }
        };
        Self {
            store_path,
            default_root: documents.map(|dir| dir.join(DEFAULT_ROOT_NAME)),
            data: Mutex::new(data),
            picks: Mutex::new(Vec::new()),
            writable,
        }
    }

    /// Where a new engagement's folder goes unless the user picks a parent.
    pub fn default_root(&self) -> Option<String> {
        self.default_root.as_deref().map(display_path)
    }

    /// Remember a parent the native dialog returned. Only an existing folder
    /// is accepted.
    pub fn remember_pick(&self, picked: &Path) -> Result<PickedParent, String> {
        let canonical = fs::canonicalize(picked).map_err(|_| "folder_missing".to_string())?;
        if !canonical.is_dir() {
            return Err("folder_not_directory".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let mut picks = self.picks.lock().map_err(|_| "folders_lock_failed")?;
        picks.push((token.clone(), canonical.clone()));
        let excess = picks.len().saturating_sub(MAX_PENDING_PICKS);
        picks.drain(..excess);
        Ok(PickedParent {
            token,
            path: display_path(&canonical),
        })
    }

    /// Make the engagement's folder: `<parent>\<name>`, with " (2)", " (3)"…
    /// when that name is taken. An engagement that already has a folder that
    /// still exists keeps it.
    pub fn create(
        &self,
        engagement_id: &str,
        name: &str,
        parent_token: Option<&str>,
    ) -> Result<FolderInfo, String> {
        validate_engagement_id(engagement_id)?;
        if let Some(existing) = self.folder(engagement_id)? {
            if existing.exists {
                return Ok(existing);
            }
        }
        // Before anything is made: a folder that could not be remembered
        // would be one nothing knows about.
        if !self.writable {
            return Err("folders_read_only".into());
        }
        let parent = match parent_token {
            Some(token) => self.redeem_pick(token)?,
            None => {
                let root = self
                    .default_root
                    .clone()
                    .ok_or_else(|| "documents_folder_unknown".to_string())?;
                fs::create_dir_all(&root).map_err(io_error)?;
                root
            }
        };
        let base = folder_name(name);
        let folder = unused_child(&parent, &base)?;
        fs::create_dir(&folder).map_err(io_error)?;
        let canonical = fs::canonicalize(&folder).map_err(io_error)?;
        let mut data = self.data.lock().map_err(|_| "folders_lock_failed")?;
        data.folders
            .insert(engagement_id.to_string(), canonical.clone());
        self.persist(&data)?;
        Ok(FolderInfo {
            path: display_path(&canonical),
            exists: true,
        })
    }

    /// The engagement's folder, if one was made for it.
    pub fn folder(&self, engagement_id: &str) -> Result<Option<FolderInfo>, String> {
        validate_engagement_id(engagement_id)?;
        let data = self.data.lock().map_err(|_| "folders_lock_failed")?;
        Ok(data.folders.get(engagement_id).map(|path| FolderInfo {
            path: display_path(path),
            exists: path.is_dir(),
        }))
    }

    /// The engagement's folder on disk, for the modules that keep its files.
    /// A folder the user deleted since is made again by whoever writes to it.
    pub(crate) fn folder_path(&self, engagement_id: &str) -> Result<Option<PathBuf>, String> {
        validate_engagement_id(engagement_id)?;
        let data = self.data.lock().map_err(|_| "folders_lock_failed")?;
        Ok(data.folders.get(engagement_id).cloned())
    }

    /// Write one document into the engagement's folder, replacing a file of
    /// the same name. Returns the written file's path.
    pub fn write(
        &self,
        engagement_id: &str,
        file_name: &str,
        contents: &str,
    ) -> Result<String, String> {
        validate_engagement_id(engagement_id)?;
        validate_file_name(file_name)?;
        if contents.len() > MAX_FILE_BYTES {
            return Err("file_too_large".into());
        }
        let folder = {
            let data = self.data.lock().map_err(|_| "folders_lock_failed")?;
            data.folders
                .get(engagement_id)
                .cloned()
                .ok_or_else(|| "no_engagement_folder".to_string())?
        };
        // The folder was approved when it was made; one the user deleted
        // since is made again rather than failing every later save.
        fs::create_dir_all(&folder).map_err(io_error)?;
        let target = folder.join(file_name);
        crate::durable_file::replace_file(&target, contents.as_bytes()).map_err(io_error)?;
        Ok(display_path(&target))
    }

    fn redeem_pick(&self, token: &str) -> Result<PathBuf, String> {
        let mut picks = self.picks.lock().map_err(|_| "folders_lock_failed")?;
        let index = picks
            .iter()
            .position(|(known, _)| known == token)
            .ok_or_else(|| "unknown_folder_token".to_string())?;
        let (_, path) = picks.remove(index);
        if !path.is_dir() {
            return Err("folder_missing".into());
        }
        Ok(path)
    }

    fn persist(&self, data: &Store) -> Result<(), String> {
        if !self.writable {
            return Err("folders_read_only".into());
        }
        let bytes = serde_json::to_vec_pretty(data).map_err(|_| "folders_serialize_failed")?;
        crate::durable_file::replace_file(&self.store_path, &bytes).map_err(io_error)
    }
}

fn io_error(err: std::io::Error) -> String {
    format!("io:{err}")
}

/// Engagement ids are app-made (`eng_<time><random>`).
pub(crate) fn validate_engagement_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err("invalid_engagement_id".into())
    }
}

/// A Windows-safe folder name from the engagement's name: reserved
/// characters become spaces, runs of spaces collapse, and trailing dots and
/// spaces go. Never empty.
pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(MAX_FOLDER_NAME).collect();
    let trimmed = capped.trim_end_matches(['.', ' ']).trim_start().to_string();
    let base = if trimmed.is_empty() {
        "Engagement".to_string()
    } else {
        trimmed
    };
    if is_reserved_name(&base) {
        format!("{base}_")
    } else {
        base
    }
}

pub(crate) fn is_reserved_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

fn unused_child(parent: &Path, base: &str) -> Result<PathBuf, String> {
    let first = parent.join(base);
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..100 {
        let candidate = parent.join(format!("{base} ({n})"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("folder_name_taken".into())
}

/// A plain document name: no folders, no alternate streams, no reserved
/// device name, and one of the document extensions.
pub fn validate_file_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.chars().count() > MAX_FILE_NAME
        || name.starts_with('.')
        || name.ends_with(['.', ' '])
        || name.contains("..")
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        || is_reserved_name(name);
    if bad {
        return Err("invalid_file_name".into());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match extension {
        Some(ext) if ALLOWED_EXTENSIONS.contains(&ext.as_str()) => Ok(()),
        _ => Err("invalid_file_type".into()),
    }
}

/// A path as Explorer shows it: without the `\\?\` prefix `canonicalize`
/// adds on Windows.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folders(temp: &Path) -> EngagementFolders {
        EngagementFolders::load(&temp.join("appdata"), Some(temp.join("Documents")))
    }

    fn store_file(temp: &Path) -> PathBuf {
        temp.join("appdata").join(STORE_DIR).join(STORE_FILE)
    }

    fn kept_copies(temp: &Path) -> Vec<PathBuf> {
        fs::read_dir(temp.join("appdata").join(STORE_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("engagement-folders.unreadable-"))
            })
            .collect()
    }

    /// The map from engagements to folders is the only record of where each
    /// one's files are. A damaged file is kept, not overwritten.
    #[test]
    fn a_damaged_store_is_kept_before_a_new_one_is_written() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(store_file(temp.path()).parent().unwrap()).unwrap();
        fs::write(store_file(temp.path()), b"{ torn write").unwrap();

        let store = folders(temp.path());

        assert_eq!(store.folder("eng_1").unwrap(), None);
        let kept = kept_copies(temp.path());
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(&kept[0]).unwrap(), b"{ torn write");
        store.create("eng_1", "After damage", None).unwrap();
        assert!(folders(temp.path()).folder("eng_1").unwrap().is_some());
        assert_eq!(kept_copies(temp.path()).len(), 1);
    }

    #[test]
    fn a_store_from_a_newer_version_is_read_but_never_written() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(store_file(temp.path()).parent().unwrap()).unwrap();
        let newer = br#"{"version":2,"folders":{},"label":"new"}"#;
        fs::write(store_file(temp.path()), newer).unwrap();

        let store = folders(temp.path());

        assert_eq!(
            store.create("eng_1", "Newer", None),
            Err("folders_read_only".to_string())
        );
        assert_eq!(fs::read(store_file(temp.path())).unwrap(), newer);
        assert!(kept_copies(temp.path()).is_empty());
    }

    #[test]
    fn makes_the_folder_under_documents_and_remembers_it() {
        let temp = tempfile::tempdir().unwrap();
        let store = folders(temp.path());

        let made = store
            .create("eng_1", "Home Lab: internal range", None)
            .unwrap();

        assert!(made.exists);
        assert!(
            made.path.ends_with(r"Qutra Labs\Home Lab internal range")
                || made.path.ends_with("Qutra Labs/Home Lab internal range")
        );
        assert_eq!(store.folder("eng_1").unwrap(), Some(made.clone()));
        // Remembered on disk, not only in memory.
        let again = folders(temp.path());
        assert_eq!(again.folder("eng_1").unwrap(), Some(made));
    }

    #[test]
    fn a_taken_name_gets_a_number_and_an_engagement_keeps_its_folder() {
        let temp = tempfile::tempdir().unwrap();
        let store = folders(temp.path());

        let first = store.create("eng_1", "Recon", None).unwrap();
        let second = store.create("eng_2", "Recon", None).unwrap();
        assert!(second.path.ends_with("Recon (2)"), "{}", second.path);
        assert_eq!(store.create("eng_1", "Other name", None).unwrap(), first);
    }

    #[test]
    fn a_picked_parent_is_used_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = folders(temp.path());
        let parent = temp.path().join("Clients");
        fs::create_dir_all(&parent).unwrap();

        let pick = store.remember_pick(&parent).unwrap();
        let made = store.create("eng_1", "Acme", Some(&pick.token)).unwrap();
        assert!(made.path.contains("Clients"), "{}", made.path);
        assert_eq!(
            store.create("eng_2", "Acme", Some(&pick.token)),
            Err("unknown_folder_token".into())
        );
    }

    #[test]
    fn writes_only_plain_document_names_into_the_engagement_folder() {
        let temp = tempfile::tempdir().unwrap();
        let store = folders(temp.path());
        store.create("eng_1", "Recon", None).unwrap();

        let written = store
            .write("eng_1", "Report 2026-10-06.md", "# Report")
            .unwrap();
        assert_eq!(fs::read_to_string(&written).unwrap(), "# Report");

        for bad in [
            "..\\escape.md",
            "../escape.md",
            "sub\\file.md",
            "C:\\Windows\\x.md",
            "file.md:stream",
            "run.exe",
            "script.ps1",
            "noextension",
            "CON.md",
            ".hidden.md",
            "",
        ] {
            assert!(store.write("eng_1", bad, "x").is_err(), "accepted {bad:?}");
        }
        assert_eq!(
            store.write("eng_2", "report.md", "x"),
            Err("no_engagement_folder".into())
        );
        assert_eq!(
            store.write("../eng", "report.md", "x"),
            Err("invalid_engagement_id".into())
        );
    }

    #[test]
    fn folder_names_are_windows_safe() {
        assert_eq!(folder_name("  a/b\\c:d*e?  "), "a b c d e");
        assert_eq!(folder_name("name..."), "name");
        assert_eq!(folder_name("???"), "Engagement");
        assert_eq!(folder_name("con"), "con_");
        assert_eq!(folder_name("Ağ taraması — iç"), "Ağ taraması — iç");
    }

    #[test]
    fn display_paths_drop_the_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\me")), r"C:\Users\me");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
    }
}
