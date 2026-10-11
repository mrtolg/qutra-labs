//! What one cloud turn takes and gives back, shared by the adapters and the
//! command that runs a turn.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use super::web::WebSource;

/// One message of the conversation, as the page sends it. Only `user` and
/// `assistant` reach a service; anything else is dropped (no app context
/// goes to the cloud except through the consent card and masking).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// An earlier Claude answer's content blocks, echoed unchanged.
    #[serde(default)]
    pub blocks: Option<serde_json::Value>,
    /// This text went out before, masked; it goes out exactly as it did
    /// then, so a change to the masking never rewrites the past.
    #[serde(default)]
    pub sent: bool,
}

/// Something the page should hear while the turn runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    Token(String),
    /// The model began thinking; said once per turn.
    Thinking,
    /// The service began a web search or page fetch of its own; said each
    /// time one starts.
    Searching,
    /// A refused or busy request is tried again after this wait.
    Retrying {
        seconds: u64,
    },
    /// Claude declined and the service passed the request on.
    Fallback {
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stop {
    EndTurn,
    MaxTokens,
    Refusal,
    Other,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Estimated from the dated price table; none for a model not in it.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub text: String,
    /// Claude's content blocks, kept so the next turn echoes them unchanged.
    pub blocks: Option<serde_json::Value>,
    pub stop: Stop,
    /// For a refusal: the category the service gave, when it gave one.
    pub refusal_category: Option<String>,
    /// The model that produced the answer.
    pub served_by: Option<String>,
    /// The model that declined, when another one answered.
    pub fallback_from: Option<String>,
    pub usage: Option<Usage>,
    /// The pages a web-enabled answer drew on or was shown: cited ones
    /// first. Empty when the internet was off or nothing was found.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<WebSource>,
}

/// Stops a turn from another task.
#[derive(Default)]
pub struct CancelToken {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel` has been called.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How long the turn waits for the service, and how it retries (spec §7.2:
/// at most two retries, only before any output).
#[derive(Debug, Clone)]
pub struct Timing {
    pub first_byte: Duration,
    pub between_events: Duration,
    pub whole_turn: Duration,
    /// Waits before the first and second retry of a busy service.
    pub busy_waits: [Duration; 2],
    /// A `retry-after` longer than this is not waited out.
    pub max_retry_after: Duration,
    /// The wait for a 429 without `retry-after`.
    pub default_retry_after: Duration,
}

impl Timing {
    /// How long to wait before retrying a refused request, or `None` when it
    /// is not retried: only a rate limit (after its `retry-after`, when that
    /// is short enough) and a busy service, at most twice.
    pub fn retry_wait(&self, error: &super::errors::AiError, retries: usize) -> Option<Duration> {
        use super::errors::AiError;
        if retries >= self.busy_waits.len() {
            return None;
        }
        match error {
            AiError::RateLimited {
                retry_after_seconds,
            } => {
                let wait = retry_after_seconds
                    .map(Duration::from_secs)
                    .unwrap_or(self.default_retry_after);
                (wait <= self.max_retry_after).then_some(wait)
            }
            AiError::Busy => Some(self.busy_waits[retries]),
            _ => None,
        }
    }
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            first_byte: Duration::from_secs(60),
            between_events: Duration::from_secs(90),
            whole_turn: Duration::from_secs(300),
            busy_waits: [Duration::from_secs(2), Duration::from_secs(6)],
            max_retry_after: Duration::from_secs(60),
            default_retry_after: Duration::from_secs(5),
        }
    }
}
