//! The list of cloud API keys: up to ten, whichever service each belongs to.
//!
//! Each key sits in its own Credential Manager slot (`ai.keys.slot<N>`) next
//! to the service it was recognised as and when it was saved. Chat keeps
//! reading the per-service account from `keys.rs`; after every change the
//! newest key of each service is copied there, so nothing else needs to know
//! about the list. Keys saved before the list existed are adopted into it the
//! first time it is read. Like the rest of the key code, nothing here returns
//! a key: the page gets the service, the last four characters and a slot id.

use serde::{Deserialize, Serialize};

use super::keys::{self, SecretStore};
use super::providers::{Preset, Target};

pub const MAX_KEYS: usize = 10;

/// The services a pasted key can be recognised as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyProvider {
    Anthropic,
    Openai,
}

impl KeyProvider {
    fn target(self) -> Target {
        match self {
            KeyProvider::Anthropic => Target::Anthropic,
            KeyProvider::Openai => Target::OpenaiCompat {
                preset: Preset::Openai,
            },
        }
    }

    /// Anthropic keys start `sk-ant-`; OpenAI's are `sk-` (`sk-proj-` too).
    pub fn detect(key: &str) -> Option<KeyProvider> {
        let key = key.trim();
        if key.starts_with("sk-ant-") {
            Some(KeyProvider::Anthropic)
        } else if key.starts_with("sk-") {
            Some(KeyProvider::Openai)
        } else {
            None
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Slot {
    key: String,
    provider: KeyProvider,
    saved_at: u64,
}

/// What the page may know about a listed key.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: u8,
    pub provider: KeyProvider,
    pub last4: Option<String>,
}

fn account(id: usize) -> String {
    format!("ai.keys.slot{id}")
}

/// Every readable slot with its id, newest first. A slot another program
/// wrote, or one that does not parse, is skipped and never overwritten
/// unless it is the only free place left.
fn read_slots(store: &dyn SecretStore) -> Result<Vec<(usize, Slot)>, String> {
    let mut slots = Vec::new();
    for id in 0..MAX_KEYS {
        if let Some(raw) = store.get(&account(id))? {
            if let Ok(slot) = serde_json::from_str::<Slot>(&raw) {
                slots.push((id, slot));
            }
        }
    }
    slots.sort_by(|a, b| b.1.saved_at.cmp(&a.1.saved_at).then(a.0.cmp(&b.0)));
    Ok(slots)
}

fn write_slot(store: &dyn SecretStore, id: usize, slot: &Slot) -> Result<(), String> {
    let value = serde_json::to_string(slot).map_err(|_| "key_not_saved".to_string())?;
    store.set(&account(id), &value)
}

fn free_id(store: &dyn SecretStore, used: &[(usize, Slot)]) -> Result<usize, String> {
    for id in 0..MAX_KEYS {
        if used.iter().any(|(taken, _)| *taken == id) {
            continue;
        }
        // An unreadable value in the slot is not ours to overwrite.
        if store.get(&account(id))?.is_none() {
            return Ok(id);
        }
    }
    Err("too_many_keys".into())
}

/// Bring keys saved one per service (before the list) into the list.
fn adopt_legacy(store: &dyn SecretStore) -> Result<(), String> {
    let mut slots = read_slots(store)?;
    for provider in [KeyProvider::Anthropic, KeyProvider::Openai] {
        // Unreadable or absent: nothing to adopt.
        let Ok(Some(credential)) = keys::credential(store, provider.target()) else {
            continue;
        };
        if credential.key.is_empty()
            || slots
                .iter()
                .any(|(_, slot)| slot.provider == provider && slot.key == credential.key)
        {
            continue;
        }
        let Ok(id) = free_id(store, &slots) else {
            continue;
        };
        let slot = Slot {
            key: credential.key,
            provider,
            saved_at: 0,
        };
        write_slot(store, id, &slot)?;
        slots.push((id, slot));
    }
    Ok(())
}

/// Copy each service's newest key to the account chat reads, or clear the
/// account when the service has no key left in the list.
fn mirror(store: &dyn SecretStore) -> Result<(), String> {
    let slots = read_slots(store)?;
    for provider in [KeyProvider::Anthropic, KeyProvider::Openai] {
        match slots.iter().find(|(_, slot)| slot.provider == provider) {
            Some((_, slot)) => keys::set_key(store, provider.target(), &slot.key, None)?,
            None => keys::delete_key(store, provider.target())?,
        }
    }
    Ok(())
}

fn entries(store: &dyn SecretStore) -> Result<Vec<KeyEntry>, String> {
    Ok(read_slots(store)?
        .into_iter()
        .map(|(id, slot)| KeyEntry {
            id: id as u8,
            provider: slot.provider,
            last4: keys::last_four(&slot.key),
        })
        .collect())
}

/// The listed keys, newest first.
pub fn list_keys(store: &dyn SecretStore) -> Result<Vec<KeyEntry>, String> {
    adopt_legacy(store)?;
    entries(store)
}

/// Add a key. The service comes from its prefix; a key already in the list
/// moves to the top instead of being saved twice. `now` is milliseconds.
pub fn add_key(store: &dyn SecretStore, key: &str, now: u64) -> Result<KeyEntry, String> {
    let key = key.trim();
    let provider = KeyProvider::detect(key).ok_or_else(|| "unknown_key_prefix".to_string())?;
    // The same rules as any other key, and a refusal never repeats it.
    let base_url = provider
        .target()
        .fixed_base_url()
        .unwrap_or_default()
        .to_string();
    keys::validate_key(key, &base_url)?;

    adopt_legacy(store)?;
    let slots = read_slots(store)?;
    let newest = slots.first().map_or(0, |(_, slot)| slot.saved_at);
    let saved_at = now.max(newest + 1);
    let id = match slots
        .iter()
        .find(|(_, slot)| slot.provider == provider && slot.key == key)
    {
        Some((id, _)) => *id,
        None => free_id(store, &slots)?,
    };
    write_slot(
        store,
        id,
        &Slot {
            key: key.to_string(),
            provider,
            saved_at,
        },
    )?;
    mirror(store)?;
    Ok(KeyEntry {
        id: id as u8,
        provider,
        last4: keys::last_four(key),
    })
}

/// Remove one listed key. Removing one that is not there is a no-op.
pub fn remove_key(store: &dyn SecretStore, id: u8) -> Result<(), String> {
    if usize::from(id) >= MAX_KEYS {
        return Err("invalid_key".into());
    }
    adopt_legacy(store)?;
    store.delete(&account(usize::from(id)))?;
    mirror(store)
}

#[cfg(test)]
mod tests {
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

    const ANTHROPIC: &str = "sk-ant-api03-example-key-AAAA";
    const ANTHROPIC_2: &str = "sk-ant-api03-another-key-BBBB";
    const OPENAI: &str = "sk-proj-example-openai-key-CCCC";

    fn chat_key(store: &MemoryStore, target: Target) -> Option<String> {
        keys::credential(store, target).unwrap().map(|c| c.key)
    }

    #[test]
    fn the_service_comes_from_the_prefix() {
        assert_eq!(KeyProvider::detect(ANTHROPIC), Some(KeyProvider::Anthropic));
        assert_eq!(KeyProvider::detect(OPENAI), Some(KeyProvider::Openai));
        assert_eq!(
            KeyProvider::detect("  sk-abcdefghijkl "),
            Some(KeyProvider::Openai)
        );
        for other in ["AIzaSyExample", "gsk_example", "key-12345678", ""] {
            assert_eq!(KeyProvider::detect(other), None, "{other}");
        }
    }

    #[test]
    fn an_unknown_prefix_is_refused_without_saving() {
        let store = MemoryStore::default();
        assert_eq!(
            add_key(&store, "AIzaSyExample-1234567", 1),
            Err("unknown_key_prefix".into())
        );
        assert!(list_keys(&store).unwrap().is_empty());
    }

    #[test]
    fn a_bad_key_with_a_known_prefix_is_refused() {
        let store = MemoryStore::default();
        for bad in ["sk-ant-", "sk-ant-has a space", "sk-ant-tab\tinside"] {
            assert_eq!(add_key(&store, bad, 1), Err("invalid_key".into()), "{bad:?}");
        }
        assert!(list_keys(&store).unwrap().is_empty());
    }

    #[test]
    fn the_newest_key_is_on_top_and_is_the_one_chat_uses() {
        let store = MemoryStore::default();
        add_key(&store, ANTHROPIC, 10).unwrap();
        add_key(&store, OPENAI, 20).unwrap();
        add_key(&store, ANTHROPIC_2, 30).unwrap();

        let listed = list_keys(&store).unwrap();
        let shown: Vec<(KeyProvider, Option<&str>)> = listed
            .iter()
            .map(|entry| (entry.provider, entry.last4.as_deref()))
            .collect();
        assert_eq!(
            shown,
            vec![
                (KeyProvider::Anthropic, Some("BBBB")),
                (KeyProvider::Openai, Some("CCCC")),
                (KeyProvider::Anthropic, Some("AAAA")),
            ]
        );
        assert_eq!(chat_key(&store, Target::Anthropic).as_deref(), Some(ANTHROPIC_2));
        assert_eq!(
            chat_key(
                &store,
                Target::OpenaiCompat {
                    preset: Preset::Openai
                }
            )
            .as_deref(),
            Some(OPENAI)
        );
    }

    #[test]
    fn saving_a_key_again_moves_it_to_the_top_once() {
        let store = MemoryStore::default();
        let first = add_key(&store, ANTHROPIC, 10).unwrap();
        add_key(&store, ANTHROPIC_2, 20).unwrap();
        let again = add_key(&store, ANTHROPIC, 30).unwrap();

        assert_eq!(first.id, again.id);
        let listed = list_keys(&store).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, first.id);
        assert_eq!(chat_key(&store, Target::Anthropic).as_deref(), Some(ANTHROPIC));
    }

    #[test]
    fn a_clock_that_stands_still_still_orders_keys() {
        let store = MemoryStore::default();
        add_key(&store, ANTHROPIC, 5).unwrap();
        add_key(&store, ANTHROPIC_2, 5).unwrap();
        assert_eq!(chat_key(&store, Target::Anthropic).as_deref(), Some(ANTHROPIC_2));
    }

    #[test]
    fn removing_the_top_key_hands_chat_the_next_one_and_the_last_clears_it() {
        let store = MemoryStore::default();
        let older = add_key(&store, ANTHROPIC, 10).unwrap();
        let newer = add_key(&store, ANTHROPIC_2, 20).unwrap();

        remove_key(&store, newer.id).unwrap();
        assert_eq!(chat_key(&store, Target::Anthropic).as_deref(), Some(ANTHROPIC));

        remove_key(&store, older.id).unwrap();
        assert_eq!(chat_key(&store, Target::Anthropic), None);
        assert!(list_keys(&store).unwrap().is_empty());
        // Gone twice is fine.
        remove_key(&store, older.id).unwrap();
    }

    #[test]
    fn at_most_ten_keys() {
        let store = MemoryStore::default();
        for n in 0..MAX_KEYS {
            add_key(&store, &format!("sk-ant-api03-key-number-{n:04}"), 100 + n as u64).unwrap();
        }
        assert_eq!(list_keys(&store).unwrap().len(), MAX_KEYS);
        assert_eq!(
            add_key(&store, "sk-ant-api03-one-too-many-0000", 500),
            Err("too_many_keys".into())
        );
        // A key already listed still moves up when the list is full.
        add_key(&store, "sk-ant-api03-key-number-0000", 600).unwrap();
        assert_eq!(list_keys(&store).unwrap().len(), MAX_KEYS);
    }

    #[test]
    fn a_key_saved_before_the_list_joins_it() {
        let store = MemoryStore::default();
        keys::set_key(&store, Target::Anthropic, ANTHROPIC, None).unwrap();

        let listed = list_keys(&store).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].provider, KeyProvider::Anthropic);
        assert_eq!(listed[0].last4.as_deref(), Some("AAAA"));
        // Listed twice, still one entry.
        assert_eq!(list_keys(&store).unwrap().len(), 1);

        // A newer key wins over it, and removing that brings it back.
        let newer = add_key(&store, ANTHROPIC_2, 50).unwrap();
        assert_eq!(chat_key(&store, Target::Anthropic).as_deref(), Some(ANTHROPIC_2));
        remove_key(&store, newer.id).unwrap();
        assert_eq!(chat_key(&store, Target::Anthropic).as_deref(), Some(ANTHROPIC));
    }

    #[test]
    fn keys_of_other_presets_are_left_alone() {
        let store = MemoryStore::default();
        let groq = Target::OpenaiCompat {
            preset: Preset::Groq,
        };
        keys::set_key(&store, groq, "gsk_example_key_value", None).unwrap();
        let entry = add_key(&store, OPENAI, 10).unwrap();
        remove_key(&store, entry.id).unwrap();
        assert!(chat_key(&store, groq).is_some());
        assert!(list_keys(&store).unwrap().is_empty());
    }

    #[test]
    fn the_page_never_gets_a_key() {
        let store = MemoryStore::default();
        let entry = add_key(&store, ANTHROPIC, 10).unwrap();
        let wire = serde_json::to_string(&(entry, list_keys(&store).unwrap())).unwrap();
        assert!(!wire.contains("example"), "{wire}");
        assert!(wire.contains("AAAA"));
    }

    #[test]
    fn a_slot_written_by_something_else_is_not_overwritten() {
        let store = MemoryStore::default();
        store.set(&account(0), "not json").unwrap();
        let entry = add_key(&store, ANTHROPIC, 10).unwrap();
        assert_ne!(entry.id, 0);
        assert_eq!(store.get(&account(0)).unwrap().as_deref(), Some("not json"));
        assert_eq!(list_keys(&store).unwrap().len(), 1);
    }

    #[test]
    fn a_slot_id_out_of_range_is_refused() {
        let store = MemoryStore::default();
        assert_eq!(remove_key(&store, 10), Err("invalid_key".into()));
    }
}
