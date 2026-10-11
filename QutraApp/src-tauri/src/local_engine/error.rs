//! The local engine's error codes. Like the assistant's, they are a
//! contract with the page's translated copy: a new case gets a new code.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum LocalEngineError {
    /// The pinned llama.cpp build is not installed.
    EngineMissing,
    /// An installed runtime file no longer matches its pinned hash.
    EngineCorrupt,
    DownloadFailed,
    DownloadHashMismatch,
    UnpackFailed,
    /// No model by that id in the app's folder or Ollama's store.
    ModelNotFound,
    /// The model's vision layers share its file; prepare a copy first.
    ModelNeedsPrepare,
    /// The pinned build does not load this architecture.
    ModelUnsupported {
        architecture: String,
    },
    ModelUnreadable,
    /// Not enough free space for a prepared copy, with its margin.
    NotEnoughDisk {
        needed: u64,
        free: u64,
    },
    /// The engine process could not be started at all.
    StartFailed,
    /// The engine started and could not load the model.
    LoadFailed {
        reason: String,
    },
    /// The model did not finish loading in time.
    LoadTimeout,
    /// Another start, download or preparation is running.
    Busy,
    Cancelled,
    Io,
}

impl LocalEngineError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EngineMissing => "engine_missing",
            Self::EngineCorrupt => "engine_corrupt",
            Self::DownloadFailed => "download_failed",
            Self::DownloadHashMismatch => "download_hash_mismatch",
            Self::UnpackFailed => "unpack_failed",
            Self::ModelNotFound => "model_not_found",
            Self::ModelNeedsPrepare => "model_needs_prepare",
            Self::ModelUnsupported { .. } => "model_unsupported",
            Self::ModelUnreadable => "model_unreadable",
            Self::NotEnoughDisk { .. } => "not_enough_disk",
            Self::StartFailed => "start_failed",
            Self::LoadFailed { .. } => "load_failed",
            Self::LoadTimeout => "load_timeout",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::Io => "io",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_reach_the_page_as_a_code_and_their_facts() {
        let wire = serde_json::to_value(LocalEngineError::NotEnoughDisk {
            needed: 10,
            free: 3,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"code":"not_enough_disk","needed":10,"free":3})
        );
        let wire = serde_json::to_value(LocalEngineError::EngineMissing).unwrap();
        assert_eq!(wire, serde_json::json!({"code":"engine_missing"}));
        assert_eq!(
            LocalEngineError::LoadFailed { reason: "x".into() }.code(),
            "load_failed"
        );
    }
}
