//! The programs a snapshot restore may start.
//!
//! A snapshot names the programs that were open when it was taken, and a
//! restore starts them again. The page sends the program's path with the
//! restore request, so the path cannot be trusted to name only a program the
//! user had open: a page that was compromised could name any `.exe` on the
//! disk. This list is what Rust itself saw. A program joins it only when
//! `list_running_apps` reports it running, and a restore starts a program
//! only when it is on it.
//!
//! The list is kept in `<app data>/known-apps.json` so a snapshot taken
//! before the app was restarted still restores. It holds paths only, is
//! capped, and a file that cannot be read is treated as empty and never
//! blocks the start.

use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};

use crate::durable_file::replace_file;

const FILE: &str = "known-apps.json";
const VERSION: u32 = 1;
/// The oldest paths drop out past this many. Far more programs than a person
/// has open at once, so a snapshot of last month still restores.
const MAX_PATHS: usize = 500;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    /// Oldest first, as the system named them.
    paths: VecDeque<String>,
}

pub struct KnownApps {
    path: PathBuf,
    paths: Mutex<VecDeque<String>>,
    /// False when the file on disk must not be written over (a newer version,
    /// or unreadable): the list still works for this run.
    writable: bool,
}

/// One spelling for comparing: the verbatim prefix gone, `/` as `\`, lower
/// case (Windows paths do not differ by case).
fn normalized(path: &str) -> String {
    let trimmed = path.trim();
    let bare = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    bare.replace('/', "\\").to_lowercase()
}

impl KnownApps {
    pub fn load(base_dir: &Path) -> Self {
        let path = base_dir.join(FILE);
        let (paths, writable) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Stored>(&bytes) {
                Ok(stored) if stored.version == VERSION => (stored.paths, true),
                Ok(stored) if stored.version > VERSION => {
                    eprintln!("[Qutra Labs] known apps list is from a newer version; read only");
                    (stored.paths, false)
                }
                // Nothing here is worth keeping a copy of: the list fills
                // again from the next enumeration.
                _ => (VecDeque::new(), true),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (VecDeque::new(), true),
            Err(e) => {
                eprintln!("[Qutra Labs] known apps list unreadable: {e}");
                (VecDeque::new(), false)
            }
        };
        Self {
            path,
            paths: Mutex::new(paths),
            writable,
        }
    }

    /// A list that knows nothing and keeps nothing, for tests of what is
    /// refused.
    #[cfg(test)]
    pub fn empty() -> Self {
        Self {
            path: PathBuf::new(),
            paths: Mutex::new(VecDeque::new()),
            writable: false,
        }
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<String>> {
        match self.paths.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Adds the programs a window enumeration reported. Empty and over-long
    /// paths, and paths that are not a file path, are ignored.
    pub fn remember<'a>(&self, executables: impl IntoIterator<Item = &'a str>) {
        let mut paths = self.lock();
        let mut changed = false;
        for executable in executables {
            let candidate = executable.trim();
            if candidate.is_empty()
                || candidate.len() > MAX_PATH_BYTES
                || candidate.chars().any(char::is_control)
            {
                continue;
            }
            let key = normalized(candidate);
            if paths.iter().any(|known| normalized(known) == key) {
                continue;
            }
            paths.push_back(candidate.to_string());
            while paths.len() > MAX_PATHS {
                paths.pop_front();
            }
            changed = true;
        }
        if changed && self.writable {
            let stored = Stored {
                version: VERSION,
                paths: paths.clone(),
            };
            if let Ok(bytes) = serde_json::to_vec_pretty(&stored) {
                if let Err(e) = replace_file(&self.path, &bytes) {
                    eprintln!("[Qutra Labs] known apps list not saved: {e}");
                }
            }
        }
    }

    /// Whether `path` is a program Rust saw running.
    pub fn contains(&self, path: &str) -> bool {
        let key = normalized(path);
        self.lock().iter().any(|known| normalized(known) == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_is_known_once_it_was_seen_and_not_before() {
        let dir = tempfile::tempdir().unwrap();
        let known = KnownApps::load(dir.path());
        assert!(!known.contains(r"C:\Windows\System32\calc.exe"));

        known.remember([r"C:\Windows\System32\calc.exe"]);

        assert!(known.contains(r"C:\Windows\System32\calc.exe"));
        assert!(!known.contains(r"C:\Windows\System32\cmd.exe"));
    }

    #[test]
    fn spelling_does_not_decide_what_is_known() {
        let dir = tempfile::tempdir().unwrap();
        let known = KnownApps::load(dir.path());
        known.remember([r"C:\Program Files\Tool\tool.exe"]);
        for spelling in [
            r"c:\program files\tool\TOOL.EXE",
            r"\\?\C:\Program Files\Tool\tool.exe",
            "C:/Program Files/Tool/tool.exe",
        ] {
            assert!(known.contains(spelling), "{spelling}");
        }
        // A path that only ends the same way is another program.
        assert!(!known.contains(r"C:\Temp\Program Files\Tool\tool.exe"));
    }

    #[test]
    fn what_was_seen_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        KnownApps::load(dir.path()).remember([r"C:\Tools\a.exe"]);
        assert!(KnownApps::load(dir.path()).contains(r"C:\Tools\a.exe"));
    }

    #[test]
    fn empty_and_odd_paths_are_not_remembered_and_the_list_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let known = KnownApps::load(dir.path());
        known.remember(["", "   ", "C:\\bad\0name.exe"]);
        assert!(!known.contains(""));
        let many: Vec<String> = (0..MAX_PATHS + 10)
            .map(|i| format!(r"C:\Tools\app{i}.exe"))
            .collect();
        known.remember(many.iter().map(String::as_str));
        assert!(!known.contains(r"C:\Tools\app0.exe"), "the oldest dropped");
        assert!(known.contains(&format!(r"C:\Tools\app{}.exe", MAX_PATHS + 9)));
        assert_eq!(known.lock().len(), MAX_PATHS);
    }

    #[test]
    fn a_damaged_or_newer_file_does_not_stop_the_start() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), b"{ not json").unwrap();
        let known = KnownApps::load(dir.path());
        assert!(!known.contains(r"C:\Tools\a.exe"));
        known.remember([r"C:\Tools\a.exe"]);
        assert!(KnownApps::load(dir.path()).contains(r"C:\Tools\a.exe"));

        let newer = br#"{"version":2,"paths":["C:\\Tools\\b.exe"]}"#;
        fs::write(dir.path().join(FILE), newer).unwrap();
        let known = KnownApps::load(dir.path());
        assert!(known.contains(r"C:\Tools\b.exe"));
        known.remember([r"C:\Tools\c.exe"]);
        assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), newer);
    }
}
