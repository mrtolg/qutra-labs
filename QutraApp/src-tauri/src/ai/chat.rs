//! One cloud turn at a time. The page starts a turn with
//! `ai_chat_start`, stops it with `ai_chat_cancel`, and hears it on
//! `ai://stream`: `bound` (where it goes and how much), `token`, `thinking`,
//! `retrying`, `fallback`, then exactly one `done` or `error`. No event
//! carries the key.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::anthropic;
use super::errors::AiError;
use super::keys::{credential, SecretStore};
use super::mask;
use super::openai_compat;
use super::providers::Target;
use super::turn::{CancelToken, ChatMessage, Progress, Timing, TurnResult};

pub const STREAM_EVENT: &str = "ai://stream";
const MAX_MESSAGES: usize = 200;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatRequest {
    pub request_id: String,
    pub target: Target,
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStart {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CloudStart {
    pub fn accepted() -> Self {
        Self {
            accepted: true,
            reason: None,
        }
    }
    pub fn refused(reason: &str) -> Self {
        Self {
            accepted: false,
            reason: Some(reason.into()),
        }
    }
}

/// What the page hears about a turn.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudEvent {
    pub request_id: String,
    /// `bound` | `token` | `thinking` | `retrying` | `fallback` | `done` | `error`
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// On `bound`: the host the conversation goes to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// On `bound`: the model asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// On `bound`: how many bytes of conversation go out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_bytes: Option<usize>,
    /// On `bound`: how many secrets were masked in what goes out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked: Option<usize>,
    /// On `bound`: the question as it went out, masked; the page keeps it
    /// and sends it exactly so on later turns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_text: Option<String>,
    /// On `retrying`: the wait before the next try.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<u64>,
    /// On `fallback`: the model that declined and the one that took over.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<TurnResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AiError>,
}

impl CloudEvent {
    fn new(request_id: &str, kind: &'static str) -> Self {
        Self {
            request_id: request_id.into(),
            kind,
            text: None,
            endpoint: None,
            model: None,
            sent_bytes: None,
            masked: None,
            sent_text: None,
            seconds: None,
            from: None,
            to: None,
            result: None,
            error: None,
        }
    }

    fn progress(request_id: &str, progress: Progress) -> Self {
        match progress {
            Progress::Token(text) => Self {
                text: Some(text),
                ..Self::new(request_id, "token")
            },
            Progress::Thinking => Self::new(request_id, "thinking"),
            Progress::Retrying { seconds } => Self {
                seconds: Some(seconds),
                ..Self::new(request_id, "retrying")
            },
            Progress::Fallback { from, to } => Self {
                from: Some(from),
                to: Some(to),
                ..Self::new(request_id, "fallback")
            },
        }
    }
}

struct ActiveTurn {
    request_id: String,
    cancel: Arc<CancelToken>,
}

/// The one cloud turn that may run.
#[derive(Default)]
pub struct CloudTurns {
    active: Mutex<Option<ActiveTurn>>,
}

impl CloudTurns {
    pub fn reserve(&self, request_id: &str, cancel: Arc<CancelToken>) -> bool {
        let Ok(mut active) = self.active.lock() else {
            return false;
        };
        if active.is_some() {
            return false;
        }
        *active = Some(ActiveTurn {
            request_id: request_id.into(),
            cancel,
        });
        true
    }

    pub fn release(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .is_some_and(|turn| turn.request_id == request_id)
            {
                *active = None;
            }
        }
    }

    /// Stop whatever turn runs, for a page that is gone (a reload) and so
    /// cannot name it; false when none runs.
    pub fn cancel_active(&self) -> bool {
        let Ok(active) = self.active.lock() else {
            return false;
        };
        match active.as_ref() {
            Some(turn) => {
                turn.cancel.cancel();
                true
            }
            None => false,
        }
    }

    /// Stop the turn with this id; false when no such turn runs.
    pub fn cancel(&self, request_id: &str) -> bool {
        let Ok(active) = self.active.lock() else {
            return false;
        };
        match active.as_ref() {
            Some(turn) if turn.request_id == request_id => {
                turn.cancel.cancel();
                true
            }
            _ => false,
        }
    }
}

/// Checked before anything is sent.
pub fn validate(request: &CloudChatRequest) -> Result<(), &'static str> {
    let id_ok = !request.request_id.is_empty()
        && request.request_id.len() <= 64
        && request
            .request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !id_ok {
        return Err("invalid_request_id");
    }
    let model_ok = !request.model.is_empty()
        && request.model.chars().count() <= 200
        && !request
            .model
            .chars()
            .any(|c| c.is_whitespace() || c.is_control());
    if !model_ok {
        return Err("invalid_model");
    }
    if request.messages.is_empty() || request.messages.len() > MAX_MESSAGES {
        return Err("request_too_large");
    }
    let bytes: usize = request
        .messages
        .iter()
        .map(|message| {
            message.content.len()
                + message
                    .blocks
                    .as_ref()
                    .map_or(0, |blocks| blocks.to_string().len())
        })
        .sum();
    if bytes > MAX_REQUEST_BYTES {
        return Err("request_too_large");
    }
    Ok(())
}

/// Run one turn against the key saved for its connection; `emit` hears
/// every event but the final one, which the caller sends. `terms` are the
/// user's exclusions, which the caller reads from the core's own store;
/// they are never taken from the page's request.
pub async fn run_turn(
    store: &(dyn SecretStore + Send + Sync),
    client: &reqwest::Client,
    request: &CloudChatRequest,
    terms: &[String],
    timing: &Timing,
    cancel: &CancelToken,
    emit: &(dyn Fn(CloudEvent) + Send + Sync),
) -> Result<TurnResult, AiError> {
    let cred = credential(store, request.target)
        .map_err(|_| AiError::KeyUnreadable)?
        .ok_or(AiError::NoKey)?;
    // Secrets and excluded values go before anything is measured or sent:
    // the turn that leaves is the masked one. Masking a long
    // conversation is CPU work, so it runs off the async threads.
    let history = request.messages.clone();
    let terms = terms.to_vec();
    let turn = tokio::task::spawn_blocking(move || mask::mask_messages_with(&history, &terms))
        .await
        .map_err(|_| AiError::Unexpected)?;
    let messages = turn.messages;
    let sent_bytes = match request.target {
        Target::Anthropic => anthropic::request_body(&request.model, &messages),
        Target::OpenaiCompat { .. } => openai_compat::request_body(&request.model, &messages),
    }
    .to_string()
    .len();
    let endpoint = reqwest::Url::parse(&cred.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default();
    emit(CloudEvent {
        endpoint: Some(endpoint),
        model: Some(request.model.clone()),
        sent_bytes: Some(sent_bytes),
        masked: Some(turn.masked),
        sent_text: turn.last_user,
        ..CloudEvent::new(&request.request_id, "bound")
    });
    let progress = |progress: Progress| emit(CloudEvent::progress(&request.request_id, progress));
    match request.target {
        Target::Anthropic => {
            anthropic::stream_turn(
                client,
                &cred,
                &request.model,
                &messages,
                timing,
                cancel,
                &progress,
            )
            .await
        }
        Target::OpenaiCompat { .. } => {
            openai_compat::stream_turn(
                client,
                request.target,
                &cred,
                &request.model,
                &messages,
                timing,
                cancel,
                &progress,
            )
            .await
        }
    }
}

/// The event that ends a turn.
pub fn final_event(request_id: &str, outcome: Result<TurnResult, AiError>) -> CloudEvent {
    match outcome {
        Ok(result) => CloudEvent {
            result: Some(result),
            ..CloudEvent::new(request_id, "done")
        },
        Err(error) => CloudEvent {
            error: Some(error),
            ..CloudEvent::new(request_id, "error")
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::client;
    use super::super::keys::set_key;
    use super::super::providers::Preset;
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};

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

    const KEY: &str = "sk-local-secret-0000-abcd";
    const CUSTOM: Target = Target::OpenaiCompat {
        preset: Preset::Custom,
    };

    fn request(target: Target) -> CloudChatRequest {
        CloudChatRequest {
            request_id: "req-1".into(),
            target,
            model: "local-model".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "Merhaba".into(),
                blocks: None,
                sent: false,
            }],
        }
    }

    fn serve_sse(body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            let _ = stream.read(&mut buf);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        origin
    }

    /// Like `serve_sse`, and hands back the request as it arrived.
    fn serve_sse_capturing(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            // Read the headers, then as many body bytes as they announce.
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).into_owned();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if rest.len() >= length {
                        break;
                    }
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&got).into_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        (origin, rx)
    }

    #[test]
    fn only_one_cloud_turn_runs_and_only_its_own_id_stops_it() {
        let turns = CloudTurns::default();
        let first = Arc::new(CancelToken::default());
        assert!(turns.reserve("a", first.clone()));
        assert!(!turns.reserve("b", Arc::new(CancelToken::default())));
        assert!(!turns.cancel("b"));
        assert!(!first.is_cancelled());
        assert!(turns.cancel("a"));
        assert!(first.is_cancelled());
        turns.release("b");
        assert!(!turns.reserve("c", Arc::new(CancelToken::default())));
        turns.release("a");
        assert!(turns.reserve("c", Arc::new(CancelToken::default())));
    }

    #[test]
    fn a_reloaded_page_stops_the_turn_it_cannot_name() {
        let turns = CloudTurns::default();
        assert!(!turns.cancel_active());
        let running = Arc::new(CancelToken::default());
        assert!(turns.reserve("a", running.clone()));
        assert!(turns.cancel_active());
        assert!(running.is_cancelled());
    }

    #[test]
    fn a_request_is_checked_before_anything_is_sent() {
        assert_eq!(validate(&request(CUSTOM)), Ok(()));
        let mut bad = request(CUSTOM);
        bad.request_id = "../x".into();
        assert_eq!(validate(&bad), Err("invalid_request_id"));
        let mut bad = request(CUSTOM);
        bad.model = "two words".into();
        assert_eq!(validate(&bad), Err("invalid_model"));
        let mut bad = request(CUSTOM);
        bad.messages.clear();
        assert_eq!(validate(&bad), Err("request_too_large"));
        let mut bad = request(CUSTOM);
        bad.messages[0].content = "x".repeat(MAX_REQUEST_BYTES + 1);
        assert_eq!(validate(&bad), Err("request_too_large"));
    }

    #[tokio::test]
    async fn a_turn_without_a_key_sends_nothing() {
        let store = MemoryStore::default();
        let events = Mutex::new(Vec::new());
        let outcome = run_turn(
            &store,
            &client().unwrap(),
            &request(Target::Anthropic),
            &[],
            &Timing::default(),
            &CancelToken::default(),
            &|event| events.lock().unwrap().push(event),
        )
        .await;
        assert_eq!(outcome, Err(AiError::NoKey));
        assert!(events.into_inner().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_turn_says_where_it_goes_then_streams_and_never_carries_the_key() {
        let origin = serve_sse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Selam\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        );
        let store = MemoryStore::default();
        set_key(&store, CUSTOM, KEY, Some(&origin)).unwrap();
        let events = Mutex::new(Vec::new());

        let outcome = run_turn(
            &store,
            &client().unwrap(),
            &request(CUSTOM),
            &[],
            &Timing::default(),
            &CancelToken::default(),
            &|event| events.lock().unwrap().push(event),
        )
        .await;

        let finished = final_event("req-1", outcome);
        assert_eq!(finished.kind, "done");
        assert_eq!(finished.result.as_ref().unwrap().text, "Selam");
        let mut events = events.into_inner().unwrap();
        events.push(finished);
        assert_eq!(
            events.iter().map(|event| event.kind).collect::<Vec<_>>(),
            vec!["bound", "token", "done"]
        );
        assert_eq!(events[0].endpoint.as_deref(), Some("127.0.0.1"));
        assert!(events[0].sent_bytes.unwrap() > 0);
        let wire = serde_json::to_string(&events).unwrap();
        assert!(!wire.contains("secret"), "{wire}");
    }

    #[tokio::test]
    async fn what_leaves_is_masked_and_the_bound_event_says_how_much() {
        let (origin, arrived) = serve_sse_capturing(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Tamam\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        );
        let store = MemoryStore::default();
        set_key(&store, CUSTOM, KEY, Some(&origin)).unwrap();
        let events = Mutex::new(Vec::new());
        let mut turn = request(CUSTOM);
        turn.messages[0].content =
            "my password=hunter22 and ghp_abcdefghijklmnopqrstuvwxyz0123456789".into();

        let outcome = run_turn(
            &store,
            &client().unwrap(),
            &turn,
            &[],
            &Timing::default(),
            &CancelToken::default(),
            &|event| events.lock().unwrap().push(event),
        )
        .await;

        assert!(outcome.is_ok(), "{outcome:?}");
        let request = arrived
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(!request.contains("hunter22"), "{request}");
        assert!(!request.contains("ghp_abcdef"), "{request}");
        assert!(request.contains("[masked password]"), "{request}");
        let events = events.into_inner().unwrap();
        assert_eq!(events[0].kind, "bound");
        assert_eq!(events[0].masked, Some(2));
        assert_eq!(
            events[0].sent_text.as_deref(),
            Some("my password=[masked password] and [masked token]")
        );
        let body = request.split_once("\r\n\r\n").unwrap().1;
        assert_eq!(events[0].sent_bytes, Some(body.len()));
    }

    #[tokio::test]
    async fn an_excluded_value_never_reaches_the_service() {
        let (origin, arrived) = serve_sse_capturing(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Tamam\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        );
        let store = MemoryStore::default();
        set_key(&store, CUSTOM, KEY, Some(&origin)).unwrap();
        let events = Mutex::new(Vec::new());
        let mut turn = request(CUSTOM);
        turn.messages[0].content =
            r"Acme Corp'un sunucusu ACME CORP, dosyalar c:/clients/acme-corp altında".into();
        let terms = vec!["Acme Corp".to_string(), r"C:\Clients\Acme-Corp".to_string()];

        let outcome = run_turn(
            &store,
            &client().unwrap(),
            &turn,
            &terms,
            &Timing::default(),
            &CancelToken::default(),
            &|event| events.lock().unwrap().push(event),
        )
        .await;

        assert!(outcome.is_ok(), "{outcome:?}");
        let request = arrived
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let body = request.split_once("\r\n\r\n").unwrap().1;
        assert!(!body.to_lowercase().contains("acme"), "{body}");
        assert!(body.contains("[masked exclusion]'un sunucusu"), "{body}");
        let events = events.into_inner().unwrap();
        assert_eq!(events[0].kind, "bound");
        assert_eq!(events[0].masked, Some(3));
        assert_eq!(
            events[0].sent_text.as_deref(),
            Some("[masked exclusion]'un sunucusu [masked exclusion], dosyalar [masked exclusion] altında")
        );
    }
}
