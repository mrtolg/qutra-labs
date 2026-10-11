//! Replacing a small JSON state file without a window in which it is gone.
//!
//! The tool registry and the run ledger used to write a temporary file, delete
//! the old file and then rename the temporary one into place. A crash or a
//! failed rename between the delete and the rename left no file at all, and the
//! next start read that as an empty registry or ledger. The
//! rename alone replaces an existing file: `std::fs::rename` uses
//! MoveFileExW(MOVEFILE_REPLACE_EXISTING) / rename(2), so the destination is
//! either the old bytes or the new ones.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Writes `bytes` to `path` through a synced temporary file next to it.
pub(crate) fn replace_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_file_with(path, bytes, |from, to| fs::rename(from, to))
}

/// Writes `bytes` to a file that does not exist yet, synced. Never over a file
/// that is there: backups and set-aside copies are only ever added.
pub(crate) fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Keeps the bytes of a state file this version cannot read beside it, as
/// `<name>.unreadable-<ms>.json`, and returns where. It is only ever added,
/// so a copy kept earlier is never replaced; the caller writes a fresh state
/// over the original only after this succeeds.
pub(crate) fn keep_unreadable(path: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing file name"))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let aside = path.with_file_name(format!("{stem}.unreadable-{millis}.json"));
    write_new_file(&aside, bytes)?;
    Ok(aside)
}

fn replace_file_with(
    path: &Path,
    bytes: &[u8],
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?;
    fs::create_dir_all(parent)?;
    // The whole name plus `.tmp`: files that differ only in their extension
    // must not share a temporary file.
    let mut temp_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing file name"))?
        .to_os_string();
    temp_name.push(".tmp");
    let temp = path.with_file_name(temp_name);
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("qutra-durable-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_an_existing_file() {
        let dir = temp_dir();
        let path = dir.join("state.json");
        fs::write(&path, b"old").unwrap();

        replace_file(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn files_that_differ_only_in_extension_do_not_share_a_temporary_file() {
        let dir = temp_dir();
        let notes = dir.join("a.md");
        let data = dir.join("a.json");
        // A user's own file with the name the old shared temporary file had.
        fs::write(dir.join("a.json.tmp"), b"theirs").unwrap();

        let failed = replace_file_with(&notes, b"report", |from, _| {
            assert_eq!(from, dir.join("a.md.tmp"));
            Err(io::Error::other("rename refused"))
        });

        assert!(failed.is_err());
        assert_eq!(fs::read(dir.join("a.json.tmp")).unwrap(), b"theirs");
        replace_file(&data, b"{}").unwrap();
        assert_eq!(fs::read(&data).unwrap(), b"{}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unreadable_state_is_kept_beside_the_file_and_never_replaced() {
        let dir = temp_dir();
        let path = dir.join("tool-registry.json");
        fs::write(&path, b"{not json").unwrap();

        let first = keep_unreadable(&path, b"{not json").unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"{not json");
        let name = first.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("tool-registry.unreadable-"), "{name}");
        assert!(name.ends_with(".json"), "{name}");
        // The file itself is left to the caller.
        assert_eq!(fs::read(&path).unwrap(), b"{not json");
        // Something already at the copy's name is never overwritten.
        assert!(write_new_file(&first, b"other").is_err());
        assert_eq!(fs::read(&first).unwrap(), b"{not json");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_a_missing_file_and_its_folder() {
        let dir = temp_dir();
        let path = dir.join("nested").join("state.json");

        replace_file(&path, b"first").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"first");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_replacement_leaves_the_previous_file_in_place() {
        let dir = temp_dir();
        let path = dir.join("state.json");
        fs::write(&path, b"old").unwrap();

        let failed = replace_file_with(&path, b"new", |_, _| {
            Err(io::Error::other("rename refused"))
        });

        assert!(failed.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old", "the old state survived");
        let _ = fs::remove_dir_all(dir);
    }
}
