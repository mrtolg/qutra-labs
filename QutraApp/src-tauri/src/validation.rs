//! Input validation at the IPC trust boundary.
//! Pure functions — fully unit-tested without a live desktop.

/// Accept only well-formed http(s) URLs; returns the trimmed URL.
pub fn validate_http_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("invalid_scheme".into());
    }
    // Reject embedded whitespace/control characters that could smuggle
    // extra arguments into a handler.
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid_url".into());
    }
    let after_scheme = &trimmed[lower.find("://").unwrap() + 3..];
    if after_scheme.is_empty() || after_scheme.starts_with('/') {
        return Err("invalid_url".into());
    }
    Ok(trimmed.to_string())
}

/// Extensions the shell's default "open" must never be handed, on top of
/// those `investigation_files::is_risky` already names: shortcuts to
/// programs, script hosts, installers and settings handlers that run
/// something when opened, and the `.sample` suffix the app gives a copy of
/// one of them.
const OPEN_REFUSED_EXTENSIONS: &[&str] = &[
    "sample",
    "application",
    "appref-ms",
    "gadget",
    "inf",
    "ws",
    "wsc",
    "vb",
    "msh",
    "msh1",
    "msh2",
    "mshxml",
    "msh1xml",
    "msh2xml",
    "ps1xml",
    "ps2",
    "ps2xml",
    "psc1",
    "psc2",
    "settingcontent-ms",
    "library-ms",
    "search-ms",
    "diagcab",
    "shb",
    "shs",
    "theme",
    "themepack",
    // Remote desktop connections, web queries that fetch from a host,
    // app installers that pull a package, and browser-hosted apps.
    "rdp",
    "iqy",
    "dqy",
    "oqy",
    "rqy",
    "slk",
    "appinstaller",
    "appxbundle",
    "msixbundle",
    "xbap",
    "jnlp",
    "website",
];

/// True for a path that leaves this machine or names a device rather than a
/// drive: `\\host\share`, `\\?\UNC\...`, `\\.\...` and any `\\?\` form that
/// is not a plain drive letter. Reaching a share makes Windows send the
/// user's credentials to its host, so such a path must not even be
/// canonicalized.
fn is_network_or_device_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\");
    if let Some(rest) = normalized.strip_prefix("\\\\?\\") {
        let mut chars = rest.chars();
        let drive_letter = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
        return !(drive_letter && chars.next() == Some(':'));
    }
    normalized.starts_with("\\\\")
}

/// True when a colon follows the drive prefix: an NTFS alternate data stream
/// (`file.txt:name`), which names something other than the file it hangs on.
fn has_stream_marker(path: &str) -> bool {
    let rest = path.strip_prefix("\\\\?\\").unwrap_or(path);
    let mut chars = rest.chars();
    let after_drive = match (chars.next(), chars.next()) {
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => &rest[2..],
        _ => rest,
    };
    after_drive.contains(':')
}

/// Canonicalize a path and require that it exists. Rejects empty input,
/// NUL/control characters, network and device paths, and alternate data
/// streams, before the path is canonicalized and after.
pub fn validate_existing_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty_path".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("invalid_path".into());
    }
    if is_network_or_device_path(trimmed) {
        return Err("network_path".into());
    }
    if has_stream_marker(trimmed) {
        return Err("invalid_path".into());
    }
    let canonical = std::fs::canonicalize(trimmed).map_err(|_| "missing_path".to_string())?;
    let canonical = canonical.to_string_lossy().into_owned();
    // A mapped drive or a junction can land on a share only once resolved.
    if is_network_or_device_path(&canonical) {
        return Err("network_path".into());
    }
    Ok(canonical)
}

/// A path the app may hand to the shell's default "open": an existing
/// folder, or an existing file whose type Windows does not run, install or
/// mount. Opening is `ShellExecute` with the default verb, so an `.exe`, a
/// script or a shortcut would start.
pub fn validate_openable_path(path: &str) -> Result<String, String> {
    let canonical = validate_existing_path(path)?;
    let target = std::path::Path::new(&canonical);
    if target.is_dir() {
        return Ok(canonical);
    }
    let extension = target
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    let refused = crate::investigation_files::is_risky("", extension.as_deref())
        || extension
            .as_deref()
            .is_some_and(|ext| OPEN_REFUSED_EXTENSIONS.contains(&ext));
    if refused {
        return Err("not_openable".into());
    }
    Ok(canonical)
}

/// An existing folder (a terminal's starting directory).
pub fn validate_existing_folder(path: &str) -> Result<String, String> {
    let canonical = validate_existing_path(path)?;
    if std::path::Path::new(&canonical).is_dir() {
        Ok(canonical)
    } else {
        Err("not_a_folder".into())
    }
}

/// An executable to launch: must exist, be a file, and end in .exe on
/// Windows. Bare program names (resolved via PATH) are allowed only for
/// an explicit allowlist of well-known launchers. A program on a network
/// share is never launched.
pub fn validate_executable_path(path: &str) -> Result<String, String> {
    const PATH_ALLOWLIST: [&str; 3] = ["wt.exe", "notepad.exe", "explorer.exe"];
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty_path".into());
    }
    if PATH_ALLOWLIST.contains(&trimmed.to_ascii_lowercase().as_str()) {
        return Ok(trimmed.to_string());
    }
    if is_network_or_device_path(trimmed) {
        return Err("network_path".into());
    }
    if has_stream_marker(trimmed) {
        return Err("invalid_path".into());
    }
    let canonical = std::fs::canonicalize(trimmed).map_err(|_| "missing_executable".to_string())?;
    if is_network_or_device_path(&canonical.to_string_lossy()) {
        return Err("network_path".into());
    }
    if !canonical.is_file() {
        return Err("missing_executable".into());
    }
    if cfg!(windows) {
        let ok = canonical
            .extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !ok {
            return Err("not_an_executable".into());
        }
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// Clamp window bounds into a monitor work area so a restored window is
/// always reachable (monitor-topology fallback).
pub fn clamp_bounds(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    area: (i32, i32, i32, i32), // left, top, right, bottom
) -> (i32, i32, i32, i32) {
    let (left, top, right, bottom) = area;
    let area_w = (right - left).max(200);
    let area_h = (bottom - top).max(150);
    let w = w.clamp(200, area_w);
    let h = h.clamp(150, area_h);
    let x = x.clamp(left, right - w);
    let y = y.clamp(top, bottom - h);
    (x, y, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_accept_only_http_https() {
        assert!(validate_http_url("https://tauri.app/docs").is_ok());
        assert!(validate_http_url("  http://example.com  ").is_ok());
        assert_eq!(
            validate_http_url("javascript:alert(1)"),
            Err("invalid_scheme".into())
        );
        assert_eq!(
            validate_http_url("file:///C:/x"),
            Err("invalid_scheme".into())
        );
        assert_eq!(
            validate_http_url("https://a b.com"),
            Err("invalid_url".into())
        );
        assert_eq!(
            validate_http_url("https:///nohost"),
            Err("invalid_url".into())
        );
        assert_eq!(
            validate_http_url("HTTPS://UPPER.example"),
            Ok("HTTPS://UPPER.example".into())
        );
    }

    #[test]
    fn paths_must_exist_and_be_clean() {
        assert_eq!(validate_existing_path(""), Err("empty_path".into()));
        assert_eq!(
            validate_existing_path("bad\0path"),
            Err("invalid_path".into())
        );
        assert_eq!(
            validate_existing_path("C:\\definitely\\missing\\dir"),
            Err("missing_path".into())
        );
        let cwd = std::env::current_dir().unwrap();
        assert!(validate_existing_path(cwd.to_str().unwrap()).is_ok());
    }

    fn touch(dir: &std::path::Path, name: &str) -> String {
        let file = dir.join(name);
        std::fs::write(&file, b"x").expect("write test file");
        file.to_string_lossy().into_owned()
    }

    #[test]
    fn open_refuses_files_windows_would_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in [
            "tool.exe",
            "run.BAT",
            "x.cmd",
            "s.vbs",
            "h.hta",
            "a.lnk",
            "i.msi",
            "s.scr",
            "c.cpl",
            "j.js",
            "p.ps1",
            "m.docm",
            "u.url",
            "tool.exe.sample",
            "h.SettingContent-ms",
            "c.RDP",
            "q.iqy",
            "a.appinstaller",
        ] {
            let file = touch(dir.path(), name);
            assert_eq!(
                validate_openable_path(&file),
                Err("not_openable".into()),
                "{name} must not be opened"
            );
        }
    }

    #[test]
    fn open_allows_folders_and_ordinary_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let folder = dir.path().to_string_lossy().into_owned();
        assert!(validate_openable_path(&folder).is_ok());
        for name in [
            "notes.txt",
            "stdout.log",
            "photo.jpg",
            "capture.pcap",
            "plain",
        ] {
            let file = touch(dir.path(), name);
            assert!(validate_openable_path(&file).is_ok(), "{name}");
        }
        // A folder is opened even when its name looks like a program.
        let odd = dir.path().join("tool.exe");
        std::fs::create_dir(&odd).expect("create folder");
        assert!(validate_openable_path(&odd.to_string_lossy()).is_ok());
    }

    #[test]
    fn network_and_device_paths_are_refused_before_they_are_resolved() {
        for path in [
            r"\\localhost\c$\Windows\notepad.exe",
            r"\\server\share\report.txt",
            r"//server/share/report.txt",
            r"\\?\UNC\server\share\report.txt",
            r"\\?\unc\server\share\report.txt",
            r"\\.\C:\Windows",
            r"\\.\pipe\x",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\x",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\x",
        ] {
            let expected = Err("network_path".to_string());
            assert_eq!(validate_existing_path(path), expected, "{path}");
            assert_eq!(validate_openable_path(path), expected, "{path}");
            assert_eq!(validate_existing_folder(path), expected, "{path}");
            assert_eq!(validate_executable_path(path), expected, "{path}");
        }
    }

    #[test]
    fn drive_paths_in_verbatim_form_still_resolve() {
        let dir = tempfile::tempdir().expect("tempdir");
        let canonical = std::fs::canonicalize(dir.path()).expect("canonicalize");
        // `canonicalize` itself returns the `\\?\C:\...` form on Windows.
        assert!(validate_openable_path(&canonical.to_string_lossy()).is_ok());
        assert!(validate_existing_folder(&canonical.to_string_lossy()).is_ok());
    }

    #[test]
    fn alternate_data_streams_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stream = dir.path().join("a.txt:payload.exe");
        let stream = stream.to_string_lossy();
        assert_eq!(validate_existing_path(&stream), Err("invalid_path".into()));
        assert_eq!(validate_openable_path(&stream), Err("invalid_path".into()));
        assert_eq!(
            validate_executable_path(&stream),
            Err("invalid_path".into())
        );
    }

    #[test]
    fn a_folder_is_required_where_a_folder_is_meant() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = touch(dir.path(), "a.txt");
        assert_eq!(validate_existing_folder(&file), Err("not_a_folder".into()));
        assert!(validate_existing_folder(&dir.path().to_string_lossy()).is_ok());
    }

    #[test]
    fn executables_are_allowlisted_or_real_exe_files() {
        assert_eq!(validate_executable_path("wt.exe"), Ok("wt.exe".into()));
        assert_eq!(validate_executable_path("WT.EXE"), Ok("WT.EXE".into()));
        assert_eq!(
            validate_executable_path("powershell.exe"),
            Err("missing_executable".into()),
            "bare names outside the allowlist must not resolve via PATH"
        );
        assert_eq!(
            validate_executable_path("C:\\missing\\x.exe"),
            Err("missing_executable".into())
        );
    }

    #[test]
    fn bounds_clamp_into_work_area() {
        // window fully off-screen to the right comes back inside
        let (x, y, w, h) = clamp_bounds(5000, 100, 800, 600, (0, 0, 1920, 1080));
        assert_eq!((x, y, w, h), (1120, 100, 800, 600));
        // oversized window is shrunk to the area
        let (_, _, w, h) = clamp_bounds(0, 0, 4000, 3000, (0, 0, 1920, 1080));
        assert_eq!((w, h), (1920, 1080));
        // negative coordinates clamp to the top-left
        let (x, y, _, _) = clamp_bounds(-500, -500, 800, 600, (0, 0, 1920, 1080));
        assert_eq!((x, y), (0, 0));
    }
}
