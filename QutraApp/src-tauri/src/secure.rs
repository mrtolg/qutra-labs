//! OS-backed secure storage bridge for secrets (e.g. GitHub tokens).
//!
//! Trust boundary rules (see docs/decisions/0003-security-boundaries.md and
//! 0005-secure-storage.md):
//! - secrets live only in the OS credential store (Windows Credential Manager
//!   via the `keyring` crate), never in SQLite, logs, exports or process args;
//! - every key is validated to a strict namespace before it touches the store;
//! - error paths are redacted — a secret value never appears in a Result::Err;
//! - the store is addressed by a fixed service name so entries are scoped to
//!   Qutra Labs and removed cleanly on delete-all.

/// Service namespace under which every Qutra Labs secret is filed in the OS
/// credential store. Stable so `delete_all` can enumerate deterministically.
pub const SERVICE: &str = "app.contextos.desktop";

/// Validate a secret key (the credential "account"). Keys are internal,
/// lower-kebab/namespaced identifiers such as `github.token` — never
/// user free-text. Rejects anything that could smuggle control characters
/// or unbounded length into the OS store.
pub fn validate_secret_key(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("empty_key".into());
    }
    if trimmed.len() > 128 {
        return Err("key_too_long".into());
    }
    let ok = trimmed.chars().all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | ':')
    });
    if !ok {
        return Err("invalid_key".into());
    }
    Ok(trimmed.to_string())
}

/// Reject empty secrets and secrets large enough to indicate a bug/abuse.
/// Note: the value is NEVER echoed back in an error.
fn validate_secret_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("empty_value".into());
    }
    // 16 KiB is far above any real token; guards against accidental blobs.
    if value.len() > 16 * 1024 {
        return Err("value_too_large".into());
    }
    Ok(())
}

/// Map a keyring error to a stable, redacted code. The `keyring` error Display
/// can include the service/account but never the secret value; we still map to
/// fixed codes so nothing implementation-specific leaks to the UI or logs.
fn map_err(err: keyring::Error) -> String {
    use keyring::Error as E;
    match err {
        E::NoEntry => "no_entry".into(),
        E::Ambiguous(_) => "ambiguous".into(),
        E::TooLong(_, _) => "value_too_large".into(),
        E::Invalid(_, _) => "invalid_key".into(),
        E::NoStorageAccess(_) => "no_storage_access".into(),
        E::PlatformFailure(_) => "platform_failure".into(),
        _ => "secure_store_error".into(),
    }
}

/* ------------------------------------------------------------------ */
/* Rust-side access                                                    */
/* ------------------------------------------------------------------ */

fn entry(key: &str) -> Result<keyring::Entry, String> {
    let key = validate_secret_key(key)?;
    keyring::Entry::new(SERVICE, &key).map_err(map_err)
}

/// Read a secret, for Rust code only (the GitHub broker, the AI providers).
/// No command returns a stored secret to the page (ADR 0005).
/// `Ok(None)` means "not present" — distinct from an error.
pub(crate) fn read_secret(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Store (or overwrite) a secret.
pub(crate) fn write_secret(key: &str, value: &str) -> Result<(), String> {
    validate_secret_value(value)?;
    entry(key)?.set_password(value).map_err(map_err)
}

/// Delete a secret. Deleting a missing key is a no-op success (idempotent),
/// so callers can safely use this for revoke/disconnect/delete-all.
pub(crate) fn remove_secret(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(map_err(e)),
    }
}

/* ------------------------------------------------------------------ */
/* Tauri commands                                                      */
/* ------------------------------------------------------------------ */

/// The secrets the page may store, test for and delete by name. Every other
/// secret is managed by its own Rust commands (the AI keys: `ai_key_*`).
const RENDERER_KEYS: &[&str] = &["github.token"];

fn renderer_key(key: &str) -> Result<String, String> {
    let key = validate_secret_key(key)?;
    if RENDERER_KEYS.contains(&key.as_str()) {
        Ok(key)
    } else {
        Err("key_not_allowed".into())
    }
}

/// Store (or overwrite) a secret. Returns nothing — the value is write-only
/// from the frontend's perspective and never round-trips through a log.
#[tauri::command]
pub fn secure_set(key: String, value: String) -> Result<(), String> {
    write_secret(&renderer_key(&key)?, &value)
}

/// True if a secret exists, without returning it.
#[tauri::command]
pub fn secure_has(key: String) -> Result<bool, String> {
    Ok(read_secret(&renderer_key(&key)?)?.is_some())
}

/// Delete a secret the page may name.
#[tauri::command]
pub fn secure_delete(key: String) -> Result<(), String> {
    remove_secret(&renderer_key(&key)?)
}

/* ------------------------------------------------------------------ */
/* Tests (pure — no OS credential store required)                      */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_namespaced_keys() {
        for k in ["github.token", "github.refresh-token", "a", "x:y_z-1.2"] {
            assert!(validate_secret_key(k).is_ok(), "{k} should be valid");
        }
    }

    #[test]
    fn rejects_dangerous_or_empty_keys() {
        assert_eq!(validate_secret_key(""), Err("empty_key".into()));
        assert_eq!(validate_secret_key("   "), Err("empty_key".into()));
        // uppercase, spaces, slashes and control chars are all rejected so a
        // key can never smuggle structure into the OS store.
        for bad in ["GitHub.Token", "a b", "a/b", "a\nb", "tok\0en", "a\\b"] {
            assert_eq!(
                validate_secret_key(bad),
                Err("invalid_key".into()),
                "{bad:?} must be rejected"
            );
        }
        let long = "a".repeat(129);
        assert_eq!(validate_secret_key(&long), Err("key_too_long".into()));
    }

    #[test]
    fn the_page_may_name_only_the_github_token() {
        assert_eq!(renderer_key("github.token"), Ok("github.token".into()));
        // AI keys go through ai_key_* only, which never return them.
        for other in [
            "ai.anthropic.key",
            "ai.openai_compat.openai.key",
            "anything.else",
        ] {
            assert_eq!(
                renderer_key(other),
                Err("key_not_allowed".into()),
                "{other} must be refused"
            );
        }
        // Shape is still checked first.
        assert_eq!(renderer_key("GitHub.Token"), Err("invalid_key".into()));
    }

    #[test]
    fn secret_values_are_bounded_and_never_echoed() {
        assert_eq!(validate_secret_value(""), Err("empty_value".into()));
        let big = "x".repeat(16 * 1024 + 1);
        let err = validate_secret_value(&big).unwrap_err();
        assert_eq!(err, "value_too_large");
        // The error must not contain the secret material.
        assert!(!err.contains('x'));
        assert!(validate_secret_value("ghp_realistic_token_value").is_ok());
    }
}
