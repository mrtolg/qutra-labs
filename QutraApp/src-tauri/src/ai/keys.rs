//! API keys for the cloud connections (spec 2026-10-07 §7.4; D8).
//!
//! A key lives in Windows Credential Manager under `ai.anthropic.key` or
//! `ai.openai_compat.<preset>.key`, stored together with the address it may
//! be sent to. Nothing returns a key to the page: it learns only whether one
//! is saved and its last four characters. For the fixed presets Rust uses
//! its own address whatever the page sends; a custom address is checked and
//! kept with the key, so a page cannot later point a saved key elsewhere.

use serde::{Deserialize, Serialize};

use super::providers::Target;

const MIN_KEY_CHARS: usize = 8;
const MAX_KEY_CHARS: usize = 512;
const MAX_BASE_URL_CHARS: usize = 200;

/// Where keys are kept; memory in tests, Credential Manager in the app.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// Windows Credential Manager, under the app's service name.
pub struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        crate::secure::read_secret(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        crate::secure::write_secret(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        crate::secure::remove_secret(account)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    key: String,
    base_url: String,
}

/// What the page may know about a saved key.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub present: bool,
    /// The key's last four characters; none for a local server without one.
    pub last4: Option<String>,
    pub base_url: Option<String>,
}

/// What Rust sends with: the key, and the address it was saved for.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    pub key: String,
    pub base_url: String,
}

/// Never prints the key, so a stray `{:?}` cannot put it in a log.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("key", &"<redacted>")
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// Save (or replace) a connection's key. `base_url` is read only for the
/// custom preset.
pub fn set_key(
    store: &dyn SecretStore,
    target: Target,
    key: &str,
    base_url: Option<&str>,
) -> Result<(), String> {
    let base_url = match target.fixed_base_url() {
        Some(fixed) => fixed.to_string(),
        None => validate_custom_base_url(base_url.unwrap_or_default())?,
    };
    let key = key.trim();
    validate_key(key, &base_url)?;
    let value = serde_json::to_string(&Stored {
        key: key.to_string(),
        base_url,
    })
    .map_err(|_| "key_not_saved".to_string())?;
    store.set(&target.account(), &value)
}

pub fn key_status(store: &dyn SecretStore, target: Target) -> Result<KeyStatus, String> {
    let Some(raw) = store.get(&target.account())? else {
        return Ok(KeyStatus {
            present: false,
            last4: None,
            base_url: None,
        });
    };
    Ok(match serde_json::from_str::<Stored>(&raw) {
        Ok(stored) => KeyStatus {
            present: true,
            last4: last_four(&stored.key),
            base_url: Some(stored.base_url),
        },
        // Saved by something else: present, but nothing to show from it.
        Err(_) => KeyStatus {
            present: true,
            last4: None,
            base_url: None,
        },
    })
}

pub fn delete_key(store: &dyn SecretStore, target: Target) -> Result<(), String> {
    store.delete(&target.account())
}

/// The key and its address, for a request. A fixed preset always gets its
/// own address; a custom one is checked again before it is used.
pub(crate) fn credential(
    store: &dyn SecretStore,
    target: Target,
) -> Result<Option<Credential>, String> {
    let Some(raw) = store.get(&target.account())? else {
        return Ok(None);
    };
    let stored: Stored =
        serde_json::from_str(&raw).map_err(|_| "stored_key_unreadable".to_string())?;
    let base_url = match target.fixed_base_url() {
        Some(fixed) => fixed.to_string(),
        None => validate_custom_base_url(&stored.base_url)?,
    };
    Ok(Some(Credential {
        key: stored.key,
        base_url,
    }))
}

/// A key is printable ASCII without spaces. Only a local server may go
/// without one (spec §7.3).
fn validate_key(key: &str, base_url: &str) -> Result<(), String> {
    if key.is_empty() && is_loopback_url(base_url) {
        return Ok(());
    }
    let chars = key.chars().count();
    let ok = (MIN_KEY_CHARS..=MAX_KEY_CHARS).contains(&chars)
        && key.chars().all(|c| c.is_ascii_graphic());
    if ok {
        Ok(())
    } else {
        Err("invalid_key".into())
    }
}

/// `https://` to any host, or `http://` to this computer only; no user
/// name, password, query or fragment. Returned without a trailing slash.
pub fn validate_custom_base_url(url: &str) -> Result<String, String> {
    let invalid = || "invalid_base_url".to_string();
    let url = url.trim();
    if url.is_empty() || url.chars().count() > MAX_BASE_URL_CHARS {
        return Err(invalid());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| invalid())?;
    let host = parsed.host_str().ok_or_else(invalid)?;
    let scheme_ok = match parsed.scheme() {
        "https" => true,
        "http" => is_loopback_host(host),
        _ => false,
    };
    let extras = !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some();
    if !scheme_ok || extras {
        return Err(invalid());
    }
    Ok(url.trim_end_matches('/').to_string())
}

fn is_loopback_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(is_loopback_host))
        .unwrap_or(false)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn last_four(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    (chars.len() >= MIN_KEY_CHARS).then(|| chars[chars.len() - 4..].iter().collect())
}

#[cfg(test)]
mod tests {
    use super::super::providers::Preset;
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    const KEY: &str = "sk-ant-api03-example-key-WXYZ";
    const CUSTOM: Target = Target::OpenaiCompat {
        preset: Preset::Custom,
    };

    #[test]
    fn a_saved_key_shows_only_its_last_four_characters() {
        let store = MemoryStore::default();
        assert_eq!(
            key_status(&store, Target::Anthropic).unwrap(),
            KeyStatus {
                present: false,
                last4: None,
                base_url: None
            }
        );

        set_key(&store, Target::Anthropic, &format!("  {KEY}  "), None).unwrap();

        let status = key_status(&store, Target::Anthropic).unwrap();
        assert!(status.present);
        assert_eq!(status.last4.as_deref(), Some("WXYZ"));
        assert_eq!(
            status.base_url.as_deref(),
            Some("https://api.anthropic.com")
        );
        // The status never carries the key.
        let wire = serde_json::to_string(&status).unwrap();
        assert!(!wire.contains("example"), "{wire}");

        delete_key(&store, Target::Anthropic).unwrap();
        assert!(!key_status(&store, Target::Anthropic).unwrap().present);
        delete_key(&store, Target::Anthropic).unwrap();
    }

    #[test]
    fn a_bad_key_is_refused_without_repeating_it() {
        let store = MemoryStore::default();
        for bad in ["short", "has a space inside it", "tab\tinside-key", ""] {
            let err = set_key(&store, Target::Anthropic, bad, None).unwrap_err();
            assert_eq!(err, "invalid_key", "{bad:?}");
        }
        assert!(!key_status(&store, Target::Anthropic).unwrap().present);
    }

    #[test]
    fn a_fixed_preset_keeps_its_own_address() {
        let store = MemoryStore::default();
        let openai = Target::OpenaiCompat {
            preset: Preset::Openai,
        };
        set_key(&store, openai, KEY, Some("https://attacker.example/v1")).unwrap();

        let cred = credential(&store, openai).unwrap().unwrap();
        assert_eq!(cred.base_url, "https://api.openai.com/v1");
        assert_eq!(cred.key, KEY);
    }

    #[test]
    fn a_custom_address_is_checked_and_kept_with_its_key() {
        for good in [
            "https://llm.example.com/v1/",
            "http://127.0.0.1:1234/v1",
            "http://localhost:8080/v1",
            "http://[::1]:9000/v1",
        ] {
            assert!(validate_custom_base_url(good).is_ok(), "{good}");
        }
        assert_eq!(
            validate_custom_base_url("https://llm.example.com/v1/").unwrap(),
            "https://llm.example.com/v1"
        );
        let too_long = format!("https://example.com/{}", "a".repeat(190));
        for bad in [
            "http://example.com/v1",
            "https://user:pw@example.com/v1",
            "https://example.com/v1?a=1",
            "https://example.com/v1#x",
            "file:///c:/keys",
            "javascript:alert(1)",
            "",
            too_long.as_str(),
        ] {
            assert_eq!(
                validate_custom_base_url(bad),
                Err("invalid_base_url".into()),
                "{bad}"
            );
        }

        let store = MemoryStore::default();
        assert_eq!(
            set_key(&store, CUSTOM, KEY, None),
            Err("invalid_base_url".into())
        );
        set_key(&store, CUSTOM, KEY, Some("https://llm.example.com/v1")).unwrap();
        assert_eq!(
            credential(&store, CUSTOM).unwrap().unwrap().base_url,
            "https://llm.example.com/v1"
        );
    }

    #[test]
    fn only_a_local_server_goes_without_a_key() {
        let store = MemoryStore::default();
        set_key(&store, CUSTOM, "", Some("http://127.0.0.1:1234/v1")).unwrap();
        let status = key_status(&store, CUSTOM).unwrap();
        assert!(status.present);
        assert_eq!(status.last4, None);
        assert_eq!(
            set_key(&store, CUSTOM, "", Some("https://llm.example.com/v1")),
            Err("invalid_key".into())
        );
    }

    #[test]
    fn a_credential_never_prints_its_key() {
        let cred = Credential {
            key: KEY.into(),
            base_url: "https://api.anthropic.com".into(),
        };
        let printed = format!("{cred:?}");
        assert!(!printed.contains("example"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }

    #[test]
    fn a_value_saved_by_something_else_is_present_but_not_used() {
        let store = MemoryStore::default();
        store.set(&Target::Anthropic.account(), "not json").unwrap();
        let status = key_status(&store, Target::Anthropic).unwrap();
        assert!(status.present);
        assert_eq!(status.last4, None);
        assert_eq!(
            credential(&store, Target::Anthropic),
            Err("stored_key_unreadable".into())
        );
    }
}
