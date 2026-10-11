//! The cloud connections Jarvis can use (spec 2026-10-07 §7.1, §7.3; D8):
//! Anthropic (Claude), and OpenAI-compatible services by preset. A preset's
//! address is fixed here; only "custom" takes an address, and that one is
//! bound to its key when the key is saved (see `keys.rs`).

use serde::{Deserialize, Serialize};

pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";

/// An OpenAI-compatible service.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    Openai,
    Gemini,
    Openrouter,
    Groq,
    /// An address the user enters: another hosted service or a local server.
    Custom,
}

impl Preset {
    fn slug(self) -> &'static str {
        match self {
            Preset::Openai => "openai",
            Preset::Gemini => "gemini",
            Preset::Openrouter => "openrouter",
            Preset::Groq => "groq",
            Preset::Custom => "custom",
        }
    }

    pub fn fixed_base_url(self) -> Option<&'static str> {
        match self {
            Preset::Openai => Some("https://api.openai.com/v1"),
            Preset::Gemini => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
            Preset::Openrouter => Some("https://openrouter.ai/api/v1"),
            Preset::Groq => Some("https://api.groq.com/openai/v1"),
            Preset::Custom => None,
        }
    }
}

/// One connection, as the page names it: `{ "provider": "anthropic" }` or
/// `{ "provider": "openai_compat", "preset": "groq" }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum Target {
    Anthropic,
    OpenaiCompat { preset: Preset },
}

impl Target {
    /// The Credential Manager account that holds this connection's key.
    pub fn account(self) -> String {
        match self {
            Target::Anthropic => "ai.anthropic.key".into(),
            Target::OpenaiCompat { preset } => format!("ai.openai_compat.{}.key", preset.slug()),
        }
    }

    /// The address Rust always uses for this connection, unless it is custom.
    pub fn fixed_base_url(self) -> Option<&'static str> {
        match self {
            Target::Anthropic => Some(ANTHROPIC_BASE_URL),
            Target::OpenaiCompat { preset } => preset.fixed_base_url(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_read_as_the_page_writes_them() {
        let anthropic: Target = serde_json::from_str(r#"{"provider":"anthropic"}"#).unwrap();
        assert_eq!(anthropic, Target::Anthropic);
        let groq: Target =
            serde_json::from_str(r#"{"provider":"openai_compat","preset":"groq"}"#).unwrap();
        assert_eq!(
            groq,
            Target::OpenaiCompat {
                preset: Preset::Groq
            }
        );
        assert!(serde_json::from_str::<Target>(r#"{"provider":"other"}"#).is_err());
    }

    #[test]
    fn each_connection_has_its_own_account_and_fixed_address() {
        assert_eq!(Target::Anthropic.account(), "ai.anthropic.key");
        assert_eq!(
            Target::OpenaiCompat {
                preset: Preset::Custom
            }
            .account(),
            "ai.openai_compat.custom.key"
        );
        assert_eq!(
            Target::Anthropic.fixed_base_url(),
            Some("https://api.anthropic.com")
        );
        assert_eq!(
            Target::OpenaiCompat {
                preset: Preset::Openai
            }
            .fixed_base_url(),
            Some("https://api.openai.com/v1")
        );
        assert_eq!(
            Target::OpenaiCompat {
                preset: Preset::Custom
            }
            .fixed_base_url(),
            None
        );
    }
}
