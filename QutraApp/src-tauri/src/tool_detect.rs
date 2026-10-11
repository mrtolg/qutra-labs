//! Finding the toolbox's programs on this computer. One data file,
//! `src/domain/tools/toolDetect.json`, lists for each toolbox item the file
//! names its executable goes by and the folder names and sub-paths it is
//! usually installed under. The scan only looks: it checks that a regular,
//! non-empty `.exe` exists at a candidate path and never opens, runs or
//! hashes anything itself.
//!
//! Where it looks, best source first:
//! - Program Files, Program Files (x86) and `%LOCALAPPDATA%\Programs`, in the
//!   program's own folder;
//! - the winget links folders and the winget package folders;
//! - Scoop's shims and its installed apps;
//! - `C:\Tools` and `%LOCALAPPDATA%\ContextOS\Tools`, flat or in a folder
//!   that starts with the program's name (`trufflehog-3.95.9`), searched up
//!   to three levels down by file name;
//! - the user bin folder uv installs command line tools into;
//! - the folders on PATH, last, because anyone who can write to one can plant
//!   a file there.
//!
//! What it finds is held for review exactly like a file the user picked
//! (`ToolRegistry::locate_detected`): inspected, hashed and signature checked
//! when it is held, and hashed again when it is registered.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};

use crate::tool_registry::{canonical_text, LocatedCandidate, ToolRegistry};

const DETECT_JSON: &str = include_str!("../../src/domain/tools/toolDetect.json");
const MAX_SKIPPED_IDS: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetectFile {
    version: u32,
    tools: Vec<DetectTool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectTool {
    pub catalog_id: String,
    /// Folder names the program installs into, in any case.
    pub folders: Vec<String>,
    /// The program's file names.
    pub executables: Vec<String>,
    /// Paths below the program's folder, `/` separated.
    #[serde(default)]
    pub sub_paths: Vec<String>,
}

fn table() -> &'static [DetectTool] {
    static TABLE: OnceLock<Vec<DetectTool>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let file: DetectFile =
            serde_json::from_str(DETECT_JSON).expect("toolDetect.json is valid");
        assert_eq!(file.version, 1, "toolDetect.json version");
        file.tools
    })
}

/// The places to look. Built from the environment in the app and from temp
/// folders in tests, so a test never touches a real system path.
#[derive(Debug, Default, Clone)]
pub struct DetectRoots {
    /// `<root>/<program folder>/...`: Program Files and `Programs`.
    pub install_roots: Vec<PathBuf>,
    /// Folders of command links or shims: `<dir>/<exe>`.
    pub link_dirs: Vec<PathBuf>,
    /// Folders whose children are one package each (winget packages).
    pub package_roots: Vec<PathBuf>,
    /// Scoop roots: `shims/<exe>` and `apps/<name>/current/...`.
    pub scoop_roots: Vec<PathBuf>,
    /// Folders the user keeps tools in: flat, or in a named child folder.
    pub tool_roots: Vec<PathBuf>,
    /// Folders of loose command line programs (uv tools).
    pub bin_dirs: Vec<PathBuf>,
    /// The folders on PATH.
    pub path_dirs: Vec<PathBuf>,
}

impl DetectRoots {
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        let mut roots = DetectRoots::default();
        let mut program_dirs: Vec<PathBuf> = Vec::new();
        for name in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(dir) = var(name).map(PathBuf::from) {
                if !program_dirs.contains(&dir) {
                    program_dirs.push(dir);
                }
            }
        }
        for dir in &program_dirs {
            roots.install_roots.push(dir.clone());
            roots.link_dirs.push(dir.join("WinGet").join("Links"));
        }
        if let Some(local) = var("LOCALAPPDATA").map(PathBuf::from) {
            roots.install_roots.push(local.join("Programs"));
            roots
                .link_dirs
                .push(local.join("Microsoft").join("WinGet").join("Links"));
            roots
                .package_roots
                .push(local.join("Microsoft").join("WinGet").join("Packages"));
            roots.tool_roots.push(local.join("ContextOS").join("Tools"));
        }
        let drive = var("SystemDrive")
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| "C:".to_string());
        roots.tool_roots.push(PathBuf::from(format!("{drive}\\Tools")));
        if let Some(profile) = var("USERPROFILE").map(PathBuf::from) {
            roots
                .scoop_roots
                .push(var("SCOOP").map(PathBuf::from).unwrap_or_else(|| profile.join("scoop")));
            roots.bin_dirs.push(profile.join(".local").join("bin"));
        }
        if let Some(path) = var("PATH") {
            roots.path_dirs = std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .collect();
        }
        roots
    }
}

/// A program found by the scan: where, and which source found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundExecutable {
    pub catalog_id: String,
    pub path: PathBuf,
    pub source: &'static str,
}

/// A regular, non-empty `.exe` at this path. A link is followed; a missing
/// file, a folder, an empty file (a Windows app alias stub) and any other
/// extension are not a program.
fn regular_exe(path: &Path) -> Option<PathBuf> {
    let is_exe = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
    if !is_exe {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    (metadata.is_file() && metadata.len() > 0).then(|| path.to_path_buf())
}

fn join_sub(base: &Path, sub: &str) -> PathBuf {
    sub.split('/')
        .filter(|part| !part.is_empty() && *part != "..")
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// The program's files directly in a folder.
fn probe_flat(dir: &Path, tool: &DetectTool) -> Option<PathBuf> {
    tool.executables
        .iter()
        .find_map(|name| regular_exe(&dir.join(name)))
}

/// The program's files in its own folder, then its known sub-paths.
fn probe_folder(dir: &Path, tool: &DetectTool) -> Option<PathBuf> {
    probe_flat(dir, tool).or_else(|| {
        tool.sub_paths
            .iter()
            .find_map(|sub| regular_exe(&join_sub(dir, sub)))
    })
}

/// Folders searched below a program's own folder in a winget package, and
/// below a program's folder in a tools folder. Release archives extract into
/// a versioned subfolder (`hashcat/hashcat-7.1.2/hashcat.exe`) and John the
/// Ripper's program sits three levels down (`john/john-1.9.0-jumbo-1-win64/run`).
const PACKAGE_DEPTH: usize = 2;
const TOOLS_DEPTH: usize = 3;
const MAX_CHILDREN_PER_LEVEL: usize = 200;

/// The program's file names in a folder and in the folders below it, to
/// `depth` levels. Links are not followed into, so a loop cannot trap it.
fn probe_deep(dir: &Path, tool: &DetectTool, depth: usize) -> Option<PathBuf> {
    if let Some(found) = probe_folder(dir, tool) {
        return Some(found);
    }
    if depth == 0 {
        return None;
    }
    let mut children: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    children.sort();
    children
        .into_iter()
        .take(MAX_CHILDREN_PER_LEVEL)
        .find_map(|child| probe_deep(&child, tool, depth - 1))
}

fn child_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().to_lowercase(),
                entry.path(),
            )
        })
        .collect();
    dirs.sort();
    dirs
}

fn lower(names: &[String]) -> Vec<String> {
    names.iter().map(|name| name.to_lowercase()).collect()
}

/// Look for each program that is not in `skip`. The first source that has it
/// wins; a program found nowhere is simply absent from the result.
pub fn detect(roots: &DetectRoots, skip: &HashSet<String>) -> Vec<FoundExecutable> {
    detect_with(table(), roots, skip)
}

fn detect_with(
    tools: &[DetectTool],
    roots: &DetectRoots,
    skip: &HashSet<String>,
) -> Vec<FoundExecutable> {
    // Listed once, not once per program.
    let packages: Vec<(String, PathBuf)> =
        roots.package_roots.iter().flat_map(|r| child_dirs(r)).collect();
    let scoop_apps: Vec<(String, PathBuf)> = roots
        .scoop_roots
        .iter()
        .flat_map(|r| child_dirs(&r.join("apps")))
        .collect();
    let tool_children: Vec<(String, PathBuf)> =
        roots.tool_roots.iter().flat_map(|r| child_dirs(r)).collect();

    let mut found = Vec::new();
    let mut seen_catalog: HashSet<&str> = HashSet::new();
    for tool in tools {
        if skip.contains(&tool.catalog_id) || !seen_catalog.insert(tool.catalog_id.as_str()) {
            continue;
        }
        let needles = lower(&tool.folders);
        let hit = locate_one(tool, &needles, roots, &packages, &scoop_apps, &tool_children);
        if let Some((path, source)) = hit {
            found.push(FoundExecutable {
                catalog_id: tool.catalog_id.clone(),
                path,
                source,
            });
        }
    }
    found
}

fn locate_one(
    tool: &DetectTool,
    needles: &[String],
    roots: &DetectRoots,
    packages: &[(String, PathBuf)],
    scoop_apps: &[(String, PathBuf)],
    tool_children: &[(String, PathBuf)],
) -> Option<(PathBuf, &'static str)> {
    for root in &roots.install_roots {
        for folder in &tool.folders {
            if let Some(path) = probe_folder(&root.join(folder), tool) {
                return Some((path, "program_files"));
            }
        }
    }
    for dir in &roots.link_dirs {
        if let Some(path) = probe_flat(dir, tool) {
            return Some((path, "winget_links"));
        }
    }
    for (name, dir) in packages {
        if needles.iter().any(|needle| name.contains(needle)) {
            if let Some(path) = probe_deep(dir, tool, PACKAGE_DEPTH) {
                return Some((path, "winget_package"));
            }
        }
    }
    for root in &roots.scoop_roots {
        if let Some(path) = probe_flat(&root.join("shims"), tool) {
            return Some((path, "scoop"));
        }
    }
    for (name, dir) in scoop_apps {
        if needles.iter().any(|needle| name.contains(needle)) {
            if let Some(path) = probe_folder(&dir.join("current"), tool) {
                return Some((path, "scoop"));
            }
        }
    }
    for root in &roots.tool_roots {
        if let Some(path) = probe_flat(root, tool) {
            return Some((path, "tools_folder"));
        }
    }
    for (name, dir) in tool_children {
        if needles.iter().any(|needle| name.starts_with(needle)) {
            if let Some(path) = probe_deep(dir, tool, TOOLS_DEPTH) {
                return Some((path, "tools_folder"));
            }
        }
    }
    for dir in &roots.bin_dirs {
        if let Some(path) = probe_flat(dir, tool) {
            return Some((path, "user_bin"));
        }
    }
    for dir in &roots.path_dirs {
        if let Some(path) = probe_flat(dir, tool) {
            return Some((path, "path"));
        }
    }
    None
}

/// What the page gets for one found program: whether the registry already
/// holds that very file, or else the held candidate to register by token. The
/// page names no path anywhere in the exchange.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTool {
    pub catalog_id: String,
    pub source: String,
    pub file_name: String,
    pub canonical_path: String,
    /// Set when the registry already holds this file.
    pub registered_id: Option<String>,
    /// Set when it is not registered yet and was held for review.
    pub located: Option<LocatedCandidate>,
}

pub fn check_skipped_ids(ids: &[String]) -> Result<HashSet<String>, String> {
    if ids.len() > MAX_SKIPPED_IDS || ids.iter().any(|id| id.is_empty() || id.len() > 64) {
        return Err("invalid_catalog_ids".into());
    }
    Ok(ids.iter().cloned().collect())
}

/// Scan and hold what is found. Files the registry already knows come back
/// with their installation id and are not hashed again.
pub fn scan(
    registry: &ToolRegistry,
    roots: &DetectRoots,
    skip: &HashSet<String>,
) -> Vec<DetectedTool> {
    let mut result = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    for found in detect(roots, skip) {
        let Some(canonical) = canonical_text(&found.path) else {
            continue;
        };
        if !seen_files.insert(canonical.to_lowercase()) {
            continue;
        }
        let file_name = found
            .path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let registered_id = registry.installation_for_path(&canonical);
        let located = if registered_id.is_some() {
            None
        } else {
            match registry.locate_detected(&canonical) {
                Ok(held) => Some(held),
                Err(reason) => {
                    eprintln!(
                        "[Qutra Labs] found {} but could not inspect it: {reason}",
                        found.catalog_id
                    );
                    continue;
                }
            }
        };
        result.push(DetectedTool {
            catalog_id: found.catalog_id,
            source: found.source.to_string(),
            file_name,
            canonical_path: canonical,
            registered_id,
            located,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::{RegisterLocatedToolRequest, ToolRegistry};

    /// A stand-in program: a few bytes named `.exe`. Nothing runs it.
    fn fake_exe(dir: &Path, relative: &str) -> PathBuf {
        let path = join_sub(dir, relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"MZ fake program").unwrap();
        path
    }

    fn only(found: &[FoundExecutable], id: &str) -> Option<FoundExecutable> {
        found.iter().find(|item| item.catalog_id == id).cloned()
    }

    fn no_skip() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn the_data_file_parses_and_names_each_program_once() {
        let mut ids = HashSet::new();
        for tool in table() {
            assert!(ids.insert(tool.catalog_id.clone()), "{}", tool.catalog_id);
            assert!(!tool.executables.is_empty(), "{}", tool.catalog_id);
            assert!(!tool.folders.is_empty(), "{}", tool.catalog_id);
            for name in &tool.executables {
                assert!(name.to_lowercase().ends_with(".exe"), "{name}");
                assert!(!name.contains('/') && !name.contains('\\'), "{name}");
            }
            for sub in &tool.sub_paths {
                assert!(sub.to_lowercase().ends_with(".exe"), "{sub}");
                assert!(!sub.contains('\\') && !sub.contains(".."), "{sub}");
            }
        }
    }

    #[test]
    fn finds_programs_in_their_install_folders() {
        let temp = tempfile::tempdir().unwrap();
        let files = temp.path().join("Program Files");
        let x86 = temp.path().join("Program Files (x86)");
        fake_exe(&files, "Wireshark/Wireshark.exe");
        fake_exe(&files, "Wireshark/tshark.exe");
        fake_exe(&x86, "Nmap/nmap.exe");
        fake_exe(&files, "ZAP/Zed Attack Proxy/ZAP.exe");
        let roots = DetectRoots {
            install_roots: vec![files.clone(), x86.clone()],
            ..Default::default()
        };

        let found = detect(&roots, &no_skip());

        assert_eq!(
            only(&found, "wireshark").unwrap().path,
            files.join("Wireshark").join("Wireshark.exe")
        );
        assert!(only(&found, "tshark").is_some());
        assert_eq!(
            only(&found, "nmap").unwrap().path,
            x86.join("Nmap").join("nmap.exe")
        );
        assert_eq!(only(&found, "nmap").unwrap().source, "program_files");
        assert!(only(&found, "zap").is_some(), "known sub-path");
        assert!(only(&found, "hashcat").is_none());
    }

    #[test]
    fn finds_winget_scoop_tools_folder_and_path_programs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let packages = root.join("Packages");
        fake_exe(
            &packages,
            "horsicq.DIE-engine_Microsoft.Winget.Source_8wekyb3d8bbwe/die/die.exe",
        );
        fake_exe(&packages, "jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe");
        let links = root.join("Links");
        fake_exe(&links, "gitleaks.exe");
        let scoop = root.join("scoop");
        fake_exe(&scoop, "shims/syft.exe");
        fake_exe(&scoop, "apps/grype/current/grype.exe");
        let tools = root.join("Tools");
        fake_exe(&tools, "nuclei.exe");
        fake_exe(&tools, "trufflehog-3.95.9/trufflehog.exe");
        fake_exe(&tools, "volatility3-venv/Scripts/vol.exe");
        let uv = root.join("bin");
        fake_exe(&uv, "semgrep.exe");
        let on_path = root.join("somewhere");
        fake_exe(&on_path, "trivy.exe");
        let roots = DetectRoots {
            link_dirs: vec![links],
            package_roots: vec![packages],
            scoop_roots: vec![scoop],
            tool_roots: vec![tools.clone()],
            bin_dirs: vec![uv],
            path_dirs: vec![on_path],
            ..Default::default()
        };

        let found = detect(&roots, &no_skip());

        let source = |id: &str| only(&found, id).map(|f| f.source);
        assert_eq!(source("detect-it-easy"), Some("winget_package"));
        assert_eq!(source("jq"), Some("winget_package"));
        assert_eq!(source("gitleaks"), Some("winget_links"));
        assert_eq!(source("syft"), Some("scoop"));
        assert_eq!(source("grype"), Some("scoop"));
        assert_eq!(source("nuclei"), Some("tools_folder"));
        assert_eq!(source("trufflehog"), Some("tools_folder"));
        assert_eq!(source("volatility"), Some("tools_folder"));
        assert_eq!(source("semgrep"), Some("user_bin"));
        assert_eq!(source("trivy"), Some("path"));
    }

    #[test]
    fn release_archives_are_found_in_nested_version_folders() {
        let temp = tempfile::tempdir().unwrap();
        let tools = temp.path().join("Tools");
        fake_exe(&tools, "hashcat/hashcat-7.1.2/hashcat.exe");
        fake_exe(&tools, "john/john-1.9.0-jumbo-1-win64/run/john.exe");
        // Four levels below the program's folder is too deep.
        fake_exe(&tools, "amass/a/b/c/d/amass.exe");
        // A folder that does not start with the program's name is not searched.
        fake_exe(&tools, "stuff/capa/capa.exe");
        let packages = temp.path().join("Packages");
        fake_exe(&packages, "ISC.Bind_Microsoft.Winget.Source_8wekyb3d8bbwe/BIND9.17.12.x64/dig.exe");
        fake_exe(&packages, "OWASP.Amass_Microsoft.Winget.Source_8wekyb3d8bbwe/amass_windows_amd64/amass.exe");
        fake_exe(&packages, "OISF.Suricata_Microsoft.Winget.Source_8wekyb3d8bbwe/suricata.exe");
        fake_exe(&packages, "PortSwigger.BurpSuite.Community_Microsoft.Winget.Source_8wekyb3d8bbwe/BurpSuiteCommunity.exe");
        let roots = DetectRoots {
            tool_roots: vec![tools.clone()],
            package_roots: vec![packages],
            ..Default::default()
        };

        let found = detect(&roots, &no_skip());

        assert_eq!(
            only(&found, "hashcat").unwrap().path,
            tools.join("hashcat").join("hashcat-7.1.2").join("hashcat.exe")
        );
        assert!(only(&found, "john").is_some());
        assert!(only(&found, "capa").is_none());
        for id in ["dns", "suricata", "burp"] {
            assert_eq!(only(&found, id).unwrap().source, "winget_package", "{id}");
        }
        // amass is in both: the winget package is the earlier source and the
        // too-deep copy in Tools is not found at all.
        assert_eq!(only(&found, "amass").unwrap().source, "winget_package");
        let tools_only = DetectRoots {
            tool_roots: vec![tools],
            ..Default::default()
        };
        assert!(only(&detect(&tools_only, &no_skip()), "amass").is_none());
    }

    #[test]
    fn an_install_folder_beats_path() {
        let temp = tempfile::tempdir().unwrap();
        let files = temp.path().join("Program Files");
        let installed = fake_exe(&files, "Nmap/nmap.exe");
        let on_path = temp.path().join("bin");
        fake_exe(&on_path, "nmap.exe");
        let roots = DetectRoots {
            install_roots: vec![files],
            path_dirs: vec![on_path],
            ..Default::default()
        };
        assert_eq!(only(&detect(&roots, &no_skip()), "nmap").unwrap().path, installed);
    }

    #[test]
    fn only_regular_non_empty_exe_files_count() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("bin");
        fs::create_dir_all(&dir).unwrap();
        // A folder named like the program, an empty file (an app alias stub),
        // a file with the wrong extension, and a script.
        fs::create_dir_all(dir.join("nmap.exe")).unwrap();
        fs::write(dir.join("jq.exe"), b"").unwrap();
        fs::write(dir.join("hashcat.bat"), b"@echo off").unwrap();
        fs::write(dir.join("sqlmap.py"), b"print(1)").unwrap();
        fs::write(dir.join("capa.exe.txt"), b"not a program").unwrap();
        let roots = DetectRoots {
            path_dirs: vec![dir],
            ..Default::default()
        };
        assert!(detect(&roots, &no_skip()).is_empty());
    }

    #[test]
    fn a_skipped_program_is_not_looked_for() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("bin");
        fake_exe(&dir, "nmap.exe");
        fake_exe(&dir, "jq.exe");
        let roots = DetectRoots {
            path_dirs: vec![dir],
            ..Default::default()
        };
        let skip: HashSet<String> = ["nmap".to_string()].into();
        let found = detect(&roots, &skip);
        assert!(only(&found, "nmap").is_none());
        assert!(only(&found, "jq").is_some());
    }

    #[test]
    fn scanning_does_not_touch_the_files() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("bin");
        let jq = fake_exe(&dir, "jq.exe");
        let before = (fs::read(&jq).unwrap(), fs::metadata(&jq).unwrap().modified().unwrap());
        let roots = DetectRoots {
            path_dirs: vec![dir.clone()],
            ..Default::default()
        };
        detect(&roots, &no_skip());
        assert_eq!(
            (fs::read(&jq).unwrap(), fs::metadata(&jq).unwrap().modified().unwrap()),
            before
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    fn request(token: &str) -> RegisterLocatedToolRequest {
        RegisterLocatedToolRequest {
            candidate_token: token.to_string(),
            display_name: "jq".into(),
            category: "local".into(),
            risk_tier: "low".into(),
            doc_url: String::new(),
            tags: vec![],
            confirmed: true,
        }
    }

    /// A scan holds an unregistered find for review by token; registering it
    /// goes through the same hash check as a picked file, and a file changed
    /// after the scan is refused.
    #[test]
    fn a_found_program_registers_by_token_and_is_hash_pinned() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let bin = temp.path().join("bin");
        let jq = bin.join("jq.exe");
        fs::create_dir_all(&bin).unwrap();
        fs::copy(std::env::current_exe().unwrap(), &jq).unwrap();
        let gitleaks = bin.join("gitleaks.exe");
        fs::copy(std::env::current_exe().unwrap(), &gitleaks).unwrap();
        let registry = ToolRegistry::load(&data);
        let roots = DetectRoots {
            path_dirs: vec![bin],
            ..Default::default()
        };

        let first = scan(&registry, &roots, &no_skip());
        let jq_found = first.iter().find(|d| d.catalog_id == "jq").unwrap();
        assert!(jq_found.registered_id.is_none());
        let held = jq_found.located.as_ref().unwrap();
        assert_eq!(held.candidate.sha256.len(), 64);
        assert!(held.token.starts_with("cand-"));

        let saved = registry.register_located(request(&held.token)).unwrap();
        assert_eq!(saved.sha256, held.candidate.sha256);

        // The other find is swapped after the scan: registration refuses it.
        let swapped = first.iter().find(|d| d.catalog_id == "gitleaks").unwrap();
        fs::write(&gitleaks, b"MZ replaced after the scan").unwrap();
        assert_eq!(
            registry
                .register_located(request(&swapped.located.as_ref().unwrap().token))
                .unwrap_err(),
            "candidate_changed"
        );

        // A second scan sees the registered file and holds nothing for it.
        let second = scan(&registry, &roots, &no_skip());
        let again = second.iter().find(|d| d.catalog_id == "jq").unwrap();
        assert_eq!(again.registered_id.as_deref(), Some(saved.id.as_str()));
        assert!(again.located.is_none());
    }

    #[test]
    fn a_scan_never_drops_a_candidate_the_user_is_reviewing() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let bin = temp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        for name in ["jq", "nmap", "trivy", "syft", "grype", "capa"] {
            fs::copy(std::env::current_exe().unwrap(), bin.join(format!("{name}.exe"))).unwrap();
        }
        let picked = temp.path().join("picked.exe");
        fs::copy(std::env::current_exe().unwrap(), &picked).unwrap();
        let registry = ToolRegistry::load(&data);
        let mine = registry.locate(picked.to_str().unwrap()).unwrap();

        let roots = DetectRoots {
            path_dirs: vec![bin],
            ..Default::default()
        };
        let found = scan(&registry, &roots, &no_skip());
        assert_eq!(found.len(), 6);
        assert!(found.iter().all(|d| d.located.is_some()));

        assert!(registry.register_located(request(&mine.token)).is_ok());
    }

    #[test]
    fn the_skip_list_is_checked() {
        assert!(check_skipped_ids(&["nmap".into()]).is_ok());
        assert!(check_skipped_ids(&["".into()]).is_err());
        assert!(check_skipped_ids(&vec!["x".to_string(); MAX_SKIPPED_IDS + 1]).is_err());
    }

    #[test]
    fn a_missing_file_is_listed_as_missing_and_a_present_one_is_not() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let present = temp.path().join("present.exe");
        let gone = temp.path().join("gone.exe");
        fs::copy(std::env::current_exe().unwrap(), &present).unwrap();
        fs::copy(std::env::current_exe().unwrap(), &gone).unwrap();
        let registry = ToolRegistry::load(&data);
        for path in [&present, &gone] {
            let held = registry.locate(path.to_str().unwrap()).unwrap();
            registry.register_located(request(&held.token)).unwrap();
        }
        fs::remove_file(&gone).unwrap();

        let listed = registry.list_with_presence().unwrap();
        let missing: Vec<bool> = listed
            .iter()
            .map(|item| item.file_missing)
            .collect();
        assert_eq!(missing.iter().filter(|m| **m).count(), 1);
        let gone_item = listed
            .iter()
            .find(|item| item.record.canonical_path.to_lowercase().ends_with("gone.exe"))
            .unwrap();
        assert!(gone_item.file_missing);
        // The flag is read at list time and never written to the registry.
        let stored = fs::read_to_string(data.join("lab").join("tool-registry.json")).unwrap();
        assert!(!stored.contains("fileMissing"));
        let json = serde_json::to_value(gone_item).unwrap();
        assert_eq!(json["fileMissing"], true);
        assert!(json["canonicalPath"].is_string());
    }
}
