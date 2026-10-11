use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const REGISTRY_VERSION: u32 = 1;

/* How long a located candidate stays redeemable. The user reads the facts and
fills a short form in between; anything older is a stale review. */
pub const CANDIDATE_TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
/* Locate runs one native picker at a time, so a handful covers a user who
picks again without registering. The oldest is dropped first. */
pub const MAX_PENDING_CANDIDATES: usize = 4;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignatureState {
    Valid,
    Invalid,
    Unsigned,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCandidate {
    pub canonical_path: String,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub modified_at: Option<u64>,
    pub version: String,
    pub publisher: String,
    pub signature_state: SignatureState,
}

/// What the renderer may send to register a located executable. It
/// names the candidate by the opaque token Locate returned, never by path, and
/// carries no working directory: both are decided natively. Unknown fields are
/// refused so a renderer that still sends a path fails loudly.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterLocatedToolRequest {
    pub candidate_token: String,
    pub display_name: String,
    pub category: String,
    pub risk_tier: String,
    pub doc_url: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub confirmed: bool,
}

/// A candidate the native picker chose and inspected, returned for review.
/// The path is shown to the user; only the token can register it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedCandidate {
    pub token: String,
    pub candidate: ToolCandidate,
    pub working_dir: String,
}

struct PendingCandidate {
    token: String,
    candidate: ToolCandidate,
    working_dir: String,
    issued_at: Instant,
}

/// Path-based registration for test fixtures. Compiled into tests only, so no
/// IPC command can accept a renderer-named path.
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct RegisterToolRequest {
    pub candidate_path: String,
    pub display_name: String,
    pub category: String,
    pub risk_tier: String,
    pub doc_url: String,
    pub tags: Vec<String>,
    pub working_dir: String,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInstallationRecord {
    pub id: String,
    pub display_name: String,
    pub runner: String,
    pub canonical_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub modified_at: Option<u64>,
    pub version: String,
    pub publisher: String,
    pub signature_state: SignatureState,
    pub category: String,
    pub risk_tier: String,
    pub doc_url: String,
    pub tags: Vec<String>,
    pub working_dir: String,
    pub enabled: bool,
    pub changed_since_verify: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_verified_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RegistryFile {
    version: u32,
    installations: Vec<ToolInstallationRecord>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            installations: Vec::new(),
        }
    }
}

pub struct ToolRegistry {
    path: PathBuf,
    data: Mutex<RegistryFile>,
    pending: Mutex<Vec<PendingCandidate>>,
    /// False when the file on disk is one this version must not write: it
    /// could not be read, could not be kept aside, or is from a newer
    /// version. Every change is then refused and the file is left as it is.
    writable: bool,
}

/// Just the version, read first so a newer file is recognised even when its
/// installations cannot be read.
#[derive(Deserialize)]
struct RegistryHeader {
    version: u64,
}

impl ToolRegistry {
    /// Never fails the start of the app. A registry that cannot be used is
    /// treated as empty: an unreadable one is kept beside the file and a
    /// fresh one written; a newer or unreadable-and-unkeepable one is left
    /// untouched and the registry is read only.
    pub fn load(base_dir: &Path) -> Self {
        let dir = base_dir.join("lab");
        let path = dir.join("tool-registry.json");
        let (data, writable) = match fs::create_dir_all(&dir) {
            Ok(()) => Self::read_state(&path),
            Err(error) => {
                eprintln!("[Qutra Labs] tool registry folder unavailable: {error}");
                (RegistryFile::default(), false)
            }
        };
        Self {
            path,
            data: Mutex::new(data),
            pending: Mutex::new(Vec::new()),
            writable,
        }
    }

    fn read_state(path: &Path) -> (RegistryFile, bool) {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return (RegistryFile::default(), true);
            }
            Err(error) => {
                eprintln!("[Qutra Labs] tool registry unreadable: {error}");
                return (RegistryFile::default(), false);
            }
        };
        if let Ok(RegistryHeader { version }) = serde_json::from_slice(&bytes) {
            if version > u64::from(REGISTRY_VERSION) {
                eprintln!(
                    "[Qutra Labs] tool registry is from a newer version ({version}); read only"
                );
                let newer = serde_json::from_slice::<RegistryFile>(&bytes).unwrap_or_else(|_| {
                    eprintln!("[Qutra Labs] this version cannot read the newer registry's tools");
                    RegistryFile::default()
                });
                return (newer, false);
            }
        }
        match serde_json::from_slice::<RegistryFile>(&bytes) {
            Ok(parsed) if parsed.version == REGISTRY_VERSION => (parsed, true),
            _ => {
                // Kept beside the registry first; the empty one written next
                // stops the next start from setting it aside again.
                match crate::durable_file::keep_unreadable(path, &bytes) {
                    Ok(kept) => {
                        eprintln!(
                            "[Qutra Labs] tool registry unreadable; kept as {}",
                            kept.display()
                        );
                        let fresh = RegistryFile::default();
                        let written = serde_json::to_vec_pretty(&fresh)
                            .ok()
                            .and_then(|bytes| crate::durable_file::replace_file(path, &bytes).ok())
                            .is_some();
                        (fresh, written)
                    }
                    Err(error) => {
                        eprintln!("[Qutra Labs] tool registry unreadable and not kept: {error}");
                        (RegistryFile::default(), false)
                    }
                }
            }
        }
    }

    fn require_writable(&self) -> Result<(), String> {
        if self.writable {
            Ok(())
        } else {
            Err("registry_read_only".into())
        }
    }

    #[cfg(test)]
    pub fn inspect_candidate(&self, raw_path: &str) -> Result<ToolCandidate, String> {
        inspect_candidate_path(raw_path)
    }

    /// Inspect a path the native picker returned and hold it for review under
    /// a fresh opaque token. Callers must pass only a path the user chose in a
    /// native dialog; the renderer never reaches this with a path of its own.
    pub fn locate(&self, picked_path: &str) -> Result<LocatedCandidate, String> {
        let candidate = inspect_candidate_path(picked_path)?;
        let working_dir = resolve_working_dir("", &candidate.canonical_path)?;
        let token = format!("cand-{}", Uuid::new_v4());
        let mut pending = self.pending.lock().map_err(|_| "registry_lock_failed")?;
        let now = Instant::now();
        pending.retain(|item| now.duration_since(item.issued_at) <= CANDIDATE_TOKEN_TTL);
        while pending.len() >= MAX_PENDING_CANDIDATES {
            pending.remove(0);
        }
        pending.push(PendingCandidate {
            token: token.clone(),
            candidate: candidate.clone(),
            working_dir: working_dir.clone(),
            issued_at: now,
        });
        Ok(LocatedCandidate {
            token,
            candidate,
            working_dir,
        })
    }

    pub fn register_located(
        &self,
        request: RegisterLocatedToolRequest,
    ) -> Result<ToolInstallationRecord, String> {
        self.register_located_at(request, Instant::now())
    }

    /// Redeem a Locate token. The form is checked before the token is spent,
    /// so a typo does not force a second pick; once spent, the token is gone
    /// whether registration then succeeds or not. The file is hashed again
    /// and must still be the one the user reviewed.
    pub(crate) fn register_located_at(
        &self,
        request: RegisterLocatedToolRequest,
        now: Instant,
    ) -> Result<ToolInstallationRecord, String> {
        if !request.confirmed {
            return Err("explicit_confirmation_required".into());
        }
        self.require_writable()?;
        let tags = validate_form(
            &request.display_name,
            &request.category,
            &request.risk_tier,
            &request.doc_url,
            request.tags,
        )?;
        let reviewed = {
            let mut pending = self.pending.lock().map_err(|_| "registry_lock_failed")?;
            let index = pending
                .iter()
                .position(|item| item.token == request.candidate_token)
                .ok_or_else(|| "candidate_token_invalid".to_string())?;
            pending.remove(index)
        };
        if now.duration_since(reviewed.issued_at) > CANDIDATE_TOKEN_TTL {
            return Err("candidate_token_expired".into());
        }
        let current = inspect_candidate_path(&reviewed.candidate.canonical_path)
            .map_err(|_| "candidate_changed".to_string())?;
        if current.sha256 != reviewed.candidate.sha256
            || !current
                .canonical_path
                .eq_ignore_ascii_case(&reviewed.candidate.canonical_path)
        {
            return Err("candidate_changed".into());
        }
        self.insert(
            current,
            reviewed.working_dir,
            RecordForm {
                display_name: request.display_name,
                category: request.category,
                risk_tier: request.risk_tier,
                doc_url: request.doc_url,
                tags,
            },
        )
    }

    #[cfg(test)]
    pub fn register(&self, request: RegisterToolRequest) -> Result<ToolInstallationRecord, String> {
        if !request.confirmed {
            return Err("explicit_confirmation_required".into());
        }
        let tags = validate_form(
            &request.display_name,
            &request.category,
            &request.risk_tier,
            &request.doc_url,
            request.tags,
        )?;
        let candidate = inspect_candidate_path(&request.candidate_path)?;
        let working_dir = resolve_working_dir(&request.working_dir, &candidate.canonical_path)?;
        self.insert(
            candidate,
            working_dir,
            RecordForm {
                display_name: request.display_name,
                category: request.category,
                risk_tier: request.risk_tier,
                doc_url: request.doc_url,
                tags,
            },
        )
    }

    fn insert(
        &self,
        candidate: ToolCandidate,
        working_dir: String,
        form: RecordForm,
    ) -> Result<ToolInstallationRecord, String> {
        self.require_writable()?;
        let current_time = now_ms();
        let record = ToolInstallationRecord {
            id: format!("tool-{}", Uuid::new_v4()),
            display_name: form.display_name.trim().to_string(),
            runner: "executable".into(),
            canonical_path: candidate.canonical_path,
            sha256: candidate.sha256,
            size_bytes: candidate.size_bytes,
            modified_at: candidate.modified_at,
            version: candidate.version,
            publisher: candidate.publisher,
            signature_state: candidate.signature_state,
            category: form.category,
            risk_tier: form.risk_tier,
            doc_url: form.doc_url.trim().to_string(),
            tags: form.tags,
            working_dir,
            enabled: true,
            changed_since_verify: false,
            created_at: current_time,
            updated_at: current_time,
            last_verified_at: current_time,
        };
        let mut data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        if data.installations.iter().any(|item| {
            item.canonical_path
                .eq_ignore_ascii_case(&record.canonical_path)
        }) {
            return Err("tool_already_registered".into());
        }
        data.installations.push(record.clone());
        self.persist(&data)?;
        Ok(record)
    }

    pub fn list(&self) -> Result<Vec<ToolInstallationRecord>, String> {
        let data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        Ok(data.installations.clone())
    }

    pub fn get(&self, id: &str) -> Result<ToolInstallationRecord, String> {
        validate_id(id)?;
        let data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        data.installations
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| "tool_not_registered".into())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ToolInstallationRecord, String> {
        validate_id(id)?;
        self.require_writable()?;
        let mut data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        let record = data
            .installations
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "tool_not_registered".to_string())?;
        record.enabled = enabled;
        record.updated_at = now_ms();
        let output = record.clone();
        self.persist(&data)?;
        Ok(output)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        self.require_writable()?;
        let mut data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        let before = data.installations.len();
        data.installations.retain(|item| item.id != id);
        if before == data.installations.len() {
            return Err("tool_not_registered".into());
        }
        self.persist(&data)
    }

    pub fn reverify(
        &self,
        id: &str,
        accept_changed_identity: bool,
    ) -> Result<ToolInstallationRecord, String> {
        validate_id(id)?;
        self.require_writable()?;
        let mut data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        let record = data
            .installations
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "tool_not_registered".to_string())?;
        let candidate = inspect_candidate_path(&record.canonical_path)?;
        let changed = candidate.sha256 != record.sha256;
        record.changed_since_verify = changed;
        record.updated_at = now_ms();
        if !changed || accept_changed_identity {
            record.sha256 = candidate.sha256;
            record.size_bytes = candidate.size_bytes;
            record.modified_at = candidate.modified_at;
            record.version = candidate.version;
            record.publisher = candidate.publisher;
            record.signature_state = candidate.signature_state;
            record.changed_since_verify = false;
            record.last_verified_at = now_ms();
        }
        let output = record.clone();
        self.persist(&data)?;
        Ok(output)
    }

    pub fn resolve_for_run(&self, id: &str) -> Result<ToolInstallationRecord, String> {
        validate_id(id)?;
        let mut data = self.data.lock().map_err(|_| "registry_lock_failed")?;
        let record = data
            .installations
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "tool_not_registered".to_string())?;
        if !record.enabled {
            return Err("tool_disabled".into());
        }
        if record.changed_since_verify {
            return Err("tool_identity_changed".into());
        }
        let candidate = inspect_candidate_path(&record.canonical_path)?;
        if candidate.sha256 != record.sha256 {
            record.changed_since_verify = true;
            record.updated_at = now_ms();
            // A read-only registry still refuses the run; it only cannot
            // remember why.
            if self.writable {
                self.persist(&data)?;
            }
            return Err("tool_identity_changed".into());
        }
        Ok(record.clone())
    }

    fn persist(&self, data: &RegistryFile) -> Result<(), String> {
        self.require_writable()?;
        let bytes = serde_json::to_vec_pretty(data).map_err(|_| "registry_serialize_failed")?;
        crate::durable_file::replace_file(&self.path, &bytes).map_err(io_error)
    }
}

fn inspect_candidate_path(raw_path: &str) -> Result<ToolCandidate, String> {
    validate_raw_path(raw_path)?;
    let canonical = fs::canonicalize(raw_path).map_err(|_| "tool_path_missing".to_string())?;
    let metadata = fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err("tool_path_not_file".into());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("exe") {
        return Err("unsupported_tool_type".into());
    }
    let canonical_text = canonical.to_string_lossy().to_string();
    validate_raw_path(&canonical_text)?;
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "invalid_tool_filename".to_string())?
        .to_string();
    let (version, publisher) = inspect_version_metadata(&canonical);
    Ok(ToolCandidate {
        canonical_path: canonical_text,
        file_name,
        sha256: sha256_file(&canonical)?,
        size_bytes: metadata.len(),
        modified_at: metadata.modified().ok().and_then(system_time_ms),
        version,
        publisher,
        signature_state: inspect_signature(&canonical),
    })
}

fn validate_raw_path(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 32_000 {
        return Err("invalid_tool_path".into());
    }
    if value.chars().any(is_unsafe_control) {
        return Err("invalid_tool_path".into());
    }
    Ok(())
}

/// The user-entered part of a registration, already validated.
struct RecordForm {
    display_name: String,
    category: String,
    risk_tier: String,
    doc_url: String,
    tags: Vec<String>,
}

fn validate_form(
    display_name: &str,
    category: &str,
    risk_tier: &str,
    doc_url: &str,
    tags: Vec<String>,
) -> Result<Vec<String>, String> {
    validate_label(display_name, 120)?;
    validate_category(category)?;
    validate_risk(risk_tier)?;
    validate_optional_url(doc_url)?;
    sanitize_tags(tags)
}

fn validate_label(value: &str, max: usize) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max || trimmed.chars().any(is_unsafe_control) {
        return Err("invalid_tool_label".into());
    }
    Ok(())
}

fn validate_category(value: &str) -> Result<(), String> {
    if matches!(value, "local" | "network" | "web" | "code" | "dfir") {
        Ok(())
    } else {
        Err("invalid_tool_category".into())
    }
}

fn validate_risk(value: &str) -> Result<(), String> {
    if matches!(value, "info" | "low" | "medium" | "high") {
        Ok(())
    } else {
        Err("invalid_tool_risk".into())
    }
}

fn validate_optional_url(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    if value.len() > 2048
        || value.chars().any(is_unsafe_control)
        || !(value.starts_with("https://") || value.starts_with("http://"))
    {
        return Err("invalid_documentation_url".into());
    }
    // A name that resolves inside the network is caught when the page is
    // fetched (`net_guard`); a name or address that plainly is one is
    // refused here, where the person typing it can be told.
    let url = reqwest::Url::parse(value).map_err(|_| "invalid_documentation_url".to_string())?;
    let host = url.host_str().unwrap_or_default();
    if host.is_empty() || crate::net_guard::names_non_public(host) {
        return Err("invalid_documentation_url".into());
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.starts_with("tool-")
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err("invalid_tool_id".into())
    }
}

fn sanitize_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 24 {
        return Err("too_many_tags".into());
    }
    let mut output = Vec::new();
    for tag in tags {
        let value = tag.trim();
        if value.is_empty() {
            continue;
        }
        validate_label(value, 40)?;
        if !output
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(value))
        {
            output.push(value.to_string());
        }
    }
    Ok(output)
}

fn resolve_working_dir(requested: &str, executable: &str) -> Result<String, String> {
    let fallback = Path::new(executable)
        .parent()
        .ok_or_else(|| "invalid_working_directory".to_string())?;
    let raw = if requested.trim().is_empty() {
        fallback
    } else {
        Path::new(requested)
    };
    let canonical = fs::canonicalize(raw).map_err(|_| "working_directory_missing".to_string())?;
    if !canonical.is_dir() {
        return Err("working_directory_not_folder".into());
    }
    Ok(canonical.to_string_lossy().to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn system_time_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

pub fn now_ms() -> u64 {
    system_time_ms(SystemTime::now()).unwrap_or(0)
}

fn is_unsafe_control(value: char) -> bool {
    value == '\0' || (value.is_control() && !matches!(value, '\t'))
}

fn io_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "file_not_found".into(),
        io::ErrorKind::PermissionDenied => "permission_denied".into(),
        _ => format!("io_error:{}", error.kind()),
    }
}

#[cfg(windows)]
fn inspect_signature(path: &Path) -> SignatureState {
    use std::{ffi::c_void, iter, mem::size_of, os::windows::ffi::OsStrExt, ptr};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{
                HANDLE, HWND, TRUST_E_NOSIGNATURE, TRUST_E_PROVIDER_UNKNOWN,
                TRUST_E_SUBJECT_FORM_UNKNOWN,
            },
            Security::WinTrust::{
                WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
                WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
                WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
                WTD_STATEACTION_VERIFY, WTD_UI_NONE,
            },
        },
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide.as_ptr()),
        hFile: HANDLE::default(),
        pgKnownSubject: ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let result = unsafe {
        WinVerifyTrust(
            HWND::default(),
            &mut action,
            &mut data as *mut _ as *mut c_void,
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        let _ = WinVerifyTrust(
            HWND::default(),
            &mut action,
            &mut data as *mut _ as *mut c_void,
        );
    }
    if result == 0 {
        SignatureState::Valid
    } else if result == TRUST_E_NOSIGNATURE.0
        || result == TRUST_E_PROVIDER_UNKNOWN.0
        || result == TRUST_E_SUBJECT_FORM_UNKNOWN.0
    {
        SignatureState::Unsigned
    } else {
        SignatureState::Invalid
    }
}

#[cfg(not(windows))]
fn inspect_signature(_path: &Path) -> SignatureState {
    SignatureState::Unavailable
}

#[cfg(windows)]
fn inspect_version_metadata(path: &Path) -> (String, String) {
    use std::{ffi::c_void, iter, mem::size_of, os::windows::ffi::OsStrExt, ptr};
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
        },
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 {
        return (String::new(), String::new());
    }
    let mut data = vec![0_u8; size as usize];
    if unsafe {
        GetFileVersionInfoW(
            PCWSTR(wide.as_ptr()),
            0,
            size,
            data.as_mut_ptr() as *mut c_void,
        )
    }
    .is_err()
    {
        return (String::new(), String::new());
    }

    let root: Vec<u16> = "\\".encode_utf16().chain(iter::once(0)).collect();
    let mut fixed_ptr: *mut c_void = ptr::null_mut();
    let mut fixed_len = 0_u32;
    let version = if unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            PCWSTR(root.as_ptr()),
            &mut fixed_ptr,
            &mut fixed_len,
        )
    }
    .as_bool()
        && fixed_len as usize >= size_of::<VS_FIXEDFILEINFO>()
        && !fixed_ptr.is_null()
    {
        let fixed = unsafe { &*(fixed_ptr as *const VS_FIXEDFILEINFO) };
        format!(
            "{}.{}.{}.{}",
            fixed.dwFileVersionMS >> 16,
            fixed.dwFileVersionMS & 0xffff,
            fixed.dwFileVersionLS >> 16,
            fixed.dwFileVersionLS & 0xffff
        )
    } else {
        String::new()
    };

    let translation_query: Vec<u16> = "\\VarFileInfo\\Translation"
        .encode_utf16()
        .chain(iter::once(0))
        .collect();
    let mut translation_ptr: *mut c_void = ptr::null_mut();
    let mut translation_len = 0_u32;
    let translation_ok = unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            PCWSTR(translation_query.as_ptr()),
            &mut translation_ptr,
            &mut translation_len,
        )
    }
    .as_bool();
    let publisher = if translation_ok && translation_len >= 4 && !translation_ptr.is_null() {
        let words = unsafe { std::slice::from_raw_parts(translation_ptr as *const u16, 2) };
        query_version_string(
            &data,
            &format!(
                "\\StringFileInfo\\{:04x}{:04x}\\CompanyName",
                words[0], words[1]
            ),
        )
    } else {
        String::new()
    };
    (version, publisher)
}

#[cfg(windows)]
fn query_version_string(data: &[u8], query: &str) -> String {
    use std::{ffi::c_void, iter, ptr};
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::VerQueryValueW};

    let wide: Vec<u16> = query.encode_utf16().chain(iter::once(0)).collect();
    let mut value_ptr: *mut c_void = ptr::null_mut();
    let mut value_len = 0_u32;
    if !unsafe {
        VerQueryValueW(
            data.as_ptr() as *const c_void,
            PCWSTR(wide.as_ptr()),
            &mut value_ptr,
            &mut value_len,
        )
    }
    .as_bool()
        || value_ptr.is_null()
        || value_len == 0
    {
        return String::new();
    }
    let words = unsafe {
        std::slice::from_raw_parts(
            value_ptr as *const u16,
            value_len.saturating_sub(1) as usize,
        )
    };
    String::from_utf16_lossy(words).trim().to_string()
}

#[cfg(not(windows))]
fn inspect_version_metadata(_path: &Path) -> (String, String) {
    (String::new(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, io::Write, time::Duration};

    fn copy_test_exe(dir: &Path, name: &str) -> PathBuf {
        let destination = dir.join(format!("{name}.exe"));
        fs::copy(std::env::current_exe().unwrap(), &destination).unwrap();
        destination
    }

    fn request(path: &Path) -> RegisterToolRequest {
        RegisterToolRequest {
            candidate_path: path.to_string_lossy().to_string(),
            display_name: "Fixture tool".into(),
            category: "local".into(),
            risk_tier: "low".into(),
            doc_url: String::new(),
            tags: vec!["fixture".into()],
            working_dir: path.parent().unwrap().to_string_lossy().to_string(),
            confirmed: true,
        }
    }

    #[test]
    fn inspects_and_persists_an_executable_registration() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "fixture");
        let registry = ToolRegistry::load(temp.path());
        let candidate = registry
            .inspect_candidate(executable.to_str().unwrap())
            .unwrap();
        assert_eq!(candidate.sha256.len(), 64);
        assert!(candidate.size_bytes > 0);

        let saved = registry.register(request(&executable)).unwrap();
        assert!(saved.enabled);
        drop(registry);

        let reloaded = ToolRegistry::load(temp.path());
        assert_eq!(reloaded.list().unwrap()[0].id, saved.id);
    }

    #[test]
    fn blocks_a_changed_binary_until_explicit_acceptance() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "mutable");
        let registry = ToolRegistry::load(temp.path());
        let saved = registry.register(request(&executable)).unwrap();

        OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        assert_eq!(
            registry.resolve_for_run(&saved.id).unwrap_err(),
            "tool_identity_changed"
        );
        assert!(registry.get(&saved.id).unwrap().changed_since_verify);

        let accepted = registry.reverify(&saved.id, true).unwrap();
        assert!(!accepted.changed_since_verify);
        assert!(registry.resolve_for_run(&saved.id).is_ok());
    }

    #[test]
    fn disable_and_remove_are_enforced() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "disable");
        let registry = ToolRegistry::load(temp.path());
        let saved = registry.register(request(&executable)).unwrap();
        registry.set_enabled(&saved.id, false).unwrap();
        assert_eq!(
            registry.resolve_for_run(&saved.id).unwrap_err(),
            "tool_disabled"
        );
        registry.remove(&saved.id).unwrap();
        assert_eq!(registry.get(&saved.id).unwrap_err(), "tool_not_registered");
    }

    fn located_request(token: &str) -> RegisterLocatedToolRequest {
        RegisterLocatedToolRequest {
            candidate_token: token.to_string(),
            display_name: "Fixture tool".into(),
            category: "local".into(),
            risk_tier: "low".into(),
            doc_url: String::new(),
            tags: vec!["fixture".into()],
            confirmed: true,
        }
    }

    #[test]
    fn a_located_candidate_registers_by_token_once() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "located");
        let registry = ToolRegistry::load(temp.path());
        let located = registry.locate(executable.to_str().unwrap()).unwrap();
        assert!(located.token.starts_with("cand-"));
        assert!(!located.token.contains("located"));
        assert_eq!(located.candidate.sha256.len(), 64);

        let saved = registry
            .register_located(located_request(&located.token))
            .unwrap();
        assert_eq!(saved.sha256, located.candidate.sha256);
        assert_eq!(saved.canonical_path, located.candidate.canonical_path);
        // The working directory is the executable's own folder, decided here.
        assert_eq!(saved.working_dir, located.working_dir);
        assert_eq!(
            fs::canonicalize(&saved.working_dir).unwrap(),
            fs::canonicalize(temp.path()).unwrap()
        );

        assert_eq!(
            registry
                .register_located(located_request(&located.token))
                .unwrap_err(),
            "candidate_token_invalid"
        );
        assert_eq!(registry.list().unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_or_malformed_token_registers_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let registry = ToolRegistry::load(temp.path());
        for token in [
            "cand-7f0c9a52-5f7e-4d1b-9a55-0c3f1e2b8d11",
            "C:\\Windows\\System32\\cmd.exe",
            "",
        ] {
            assert_eq!(
                registry
                    .register_located(located_request(token))
                    .unwrap_err(),
                "candidate_token_invalid"
            );
        }
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn an_expired_token_registers_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "stale");
        let registry = ToolRegistry::load(temp.path());
        let located = registry.locate(executable.to_str().unwrap()).unwrap();
        let later = Instant::now() + CANDIDATE_TOKEN_TTL + Duration::from_secs(1);
        assert_eq!(
            registry
                .register_located_at(located_request(&located.token), later)
                .unwrap_err(),
            "candidate_token_expired"
        );
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn a_file_changed_after_locate_registers_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "swapped");
        let registry = ToolRegistry::load(temp.path());
        let located = registry.locate(executable.to_str().unwrap()).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&executable)
            .unwrap()
            .write_all(b"swapped after review")
            .unwrap();
        assert_eq!(
            registry
                .register_located(located_request(&located.token))
                .unwrap_err(),
            "candidate_changed"
        );
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn a_rejected_form_keeps_the_token_and_an_unconfirmed_one_too() {
        let temp = tempfile::tempdir().unwrap();
        let executable = copy_test_exe(temp.path(), "retry");
        let registry = ToolRegistry::load(temp.path());
        let located = registry.locate(executable.to_str().unwrap()).unwrap();

        let mut unconfirmed = located_request(&located.token);
        unconfirmed.confirmed = false;
        assert_eq!(
            registry.register_located(unconfirmed).unwrap_err(),
            "explicit_confirmation_required"
        );
        let mut bad_label = located_request(&located.token);
        bad_label.display_name = "   ".into();
        assert_eq!(
            registry.register_located(bad_label).unwrap_err(),
            "invalid_tool_label"
        );
        assert!(registry
            .register_located(located_request(&located.token))
            .is_ok());
    }

    #[test]
    fn only_the_newest_located_candidates_stay_redeemable() {
        let temp = tempfile::tempdir().unwrap();
        let registry = ToolRegistry::load(temp.path());
        let tokens: Vec<String> = (0..=MAX_PENDING_CANDIDATES)
            .map(|index| {
                let executable = copy_test_exe(temp.path(), &format!("pending{index}"));
                registry.locate(executable.to_str().unwrap()).unwrap().token
            })
            .collect();
        assert_eq!(
            registry
                .register_located(located_request(&tokens[0]))
                .unwrap_err(),
            "candidate_token_invalid"
        );
        assert!(registry
            .register_located(located_request(tokens.last().unwrap()))
            .is_ok());
    }

    #[test]
    fn the_registration_request_refuses_a_path_or_working_directory() {
        let base = serde_json::json!({
            "candidateToken": "cand-7f0c9a52-5f7e-4d1b-9a55-0c3f1e2b8d11",
            "displayName": "Nmap",
            "category": "network",
            "riskTier": "medium",
            "docUrl": "",
            "tags": [],
            "confirmed": true
        });
        assert!(serde_json::from_value::<RegisterLocatedToolRequest>(base.clone()).is_ok());
        for (field, value) in [
            ("candidatePath", "C:\\Windows\\System32\\cmd.exe"),
            ("workingDir", "C:\\Users\\Public"),
        ] {
            let mut sent = base.clone();
            sent[field] = serde_json::json!(value);
            assert!(
                serde_json::from_value::<RegisterLocatedToolRequest>(sent).is_err(),
                "{field} must be refused"
            );
        }
    }

    fn registry_file(dir: &Path) -> PathBuf {
        dir.join("lab").join("tool-registry.json")
    }

    fn kept_copies(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir.join("lab"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("tool-registry.unreadable-"))
            })
            .collect()
    }

    /// A damaged registry must not stop the app from starting: the file is
    /// kept beside itself, the registry starts empty and registering works.
    #[test]
    fn a_damaged_registry_is_kept_and_the_app_starts_empty() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("lab")).unwrap();
        fs::write(registry_file(temp.path()), b"{ this is not json").unwrap();

        let registry = ToolRegistry::load(temp.path());

        assert!(registry.list().unwrap().is_empty());
        let kept = kept_copies(temp.path());
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(&kept[0]).unwrap(), b"{ this is not json");
        let executable = copy_test_exe(temp.path(), "after-damage");
        let saved = registry.register(request(&executable)).unwrap();
        drop(registry);
        // The next start reads the fresh registry and keeps no second copy.
        let reloaded = ToolRegistry::load(temp.path());
        assert_eq!(reloaded.list().unwrap()[0].id, saved.id);
        assert_eq!(kept_copies(temp.path()).len(), 1);
    }

    /// A registry from a newer version is read as far as it can be and never
    /// written: opening it and then changing it must leave the file alone.
    #[test]
    fn a_newer_registry_is_read_only_and_left_untouched() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("lab")).unwrap();
        let newer = br#"{"version":2,"installations":[],"somethingNew":true}"#;
        fs::write(registry_file(temp.path()), newer).unwrap();

        let registry = ToolRegistry::load(temp.path());

        let executable = copy_test_exe(temp.path(), "newer");
        assert_eq!(
            registry.register(request(&executable)).unwrap_err(),
            "registry_read_only"
        );
        assert_eq!(
            registry.set_enabled("tool-1", false).unwrap_err(),
            "registry_read_only"
        );
        assert_eq!(registry.remove("tool-1").unwrap_err(), "registry_read_only");
        assert_eq!(
            registry.reverify("tool-1", true).unwrap_err(),
            "registry_read_only"
        );
        assert_eq!(fs::read(registry_file(temp.path())).unwrap(), newer);
        assert!(kept_copies(temp.path()).is_empty());
    }

    /// The page chooses the documentation address; a program's page is
    /// fetched later for its logo. An address that is not public is refused
    /// when it is typed, so the form says why at once.
    #[test]
    fn a_documentation_address_must_not_name_this_machine_or_a_private_address() {
        for good in [
            "",
            "https://example.com/docs",
            "http://example.com",
            "https://8.8.8.8/x",
        ] {
            assert!(validate_optional_url(good).is_ok(), "{good}");
        }
        for bad in [
            "https://localhost/x",
            "http://LOCALHOST:8080/",
            "https://app.localhost/",
            "http://127.0.0.1/",
            "https://10.0.0.5/admin",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "ftp://example.com",
            "javascript:alert(1)",
        ] {
            assert!(validate_optional_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_non_executable_and_control_paths() {
        let temp = tempfile::tempdir().unwrap();
        let text = temp.path().join("x.txt");
        fs::write(&text, b"x").unwrap();
        assert_eq!(
            inspect_candidate_path(text.to_str().unwrap()).unwrap_err(),
            "unsupported_tool_type"
        );
        assert_eq!(
            inspect_candidate_path("C:\\bad\0name.exe").unwrap_err(),
            "invalid_tool_path"
        );
    }
}
