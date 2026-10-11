//! Claude through the Messages API, streamed (spec 2026-10-07 §7.2; D11).
//!
//! Raw HTTPS with the documented shapes (Anthropic API reference, including
//! the `fallbacks: "default"` option). The history is append-only: an earlier answer's content blocks, thinking
//! blocks included, are echoed unchanged, the system prompt is a constant
//! and no tools are sent, so nothing the service bound a thinking block to
//! ever changes (Anthropic API reference, preserved thinking).

use std::collections::BTreeMap;
use std::time::Instant;

use futures_util::StreamExt;
use reqwest::header::HeaderValue;
use serde_json::{json, Value};

use super::errors::{error_for_status, error_for_transport, AiError};
use super::keys::Credential;
use super::models::ANTHROPIC_VERSION;
use super::pricing::cost_usd;
use super::sse::{SseBuffer, SseEvent};
use super::turn::{CancelToken, ChatMessage, Progress, Stop, Timing, TurnResult, Usage};

/// The beta that turns on the server-side refusal fallback in its
/// `"default"` form (Anthropic picks the fallback by refusal category).
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
pub const MAX_TOKENS: u32 = 16_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_BLOCKS_BYTES: usize = 4 * 1024 * 1024;

/// Jarvis's standing instructions for a cloud conversation. A constant: a
/// system prompt that changed between turns would break the thinking
/// blocks the service bound to it, and the prompt cache with them.
pub const JARVIS_SYSTEM: &str = "You are Jarvis, the assistant inside Qutra Labs, a local-first workspace for security investigations on the user's Windows computer. Answer in the language the user writes in. Be concise and practical. In this conversation you have no tools and cannot see the user's files, investigations, terminal or screen; you know only what the user writes here. Never claim to have run, opened or checked anything.";

/// Thinking, effort and the fallback are sent only to the models that take
/// them; any other model gets the plain request.
pub fn takes_new_features(model: &str) -> bool {
    ["claude-opus-5", "claude-fable-5", "claude-sonnet-5"]
        .iter()
        .any(|prefix| model.starts_with(prefix))
}

pub fn request_body(model: &str, history: &[ChatMessage]) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "system": [{ "type": "text", "text": JARVIS_SYSTEM }],
        "messages": messages(history),
        "cache_control": { "type": "ephemeral" },
    });
    if takes_new_features(model) {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
        body["output_config"] = json!({ "effort": "medium" });
        body["fallbacks"] = json!("default");
    }
    body
}

fn messages(history: &[ChatMessage]) -> Vec<Value> {
    history
        .iter()
        .filter_map(|message| match message.role.as_str() {
            "user" if !message.content.trim().is_empty() => {
                Some(json!({ "role": "user", "content": message.content }))
            }
            "assistant" => match &message.blocks {
                Some(Value::Array(blocks)) if !blocks.is_empty() => {
                    Some(json!({ "role": "assistant", "content": echo_blocks(blocks) }))
                }
                _ if !message.content.trim().is_empty() => {
                    Some(json!({ "role": "assistant", "content": message.content }))
                }
                _ => None,
            },
            // A system message, or anything else the page sends, stays home.
            _ => None,
        })
        .collect()
}

/// An answer's blocks as they go back: unchanged, except that after a
/// fallback the thinking, redacted thinking and tool use before the last
/// fallback block are left out, as the service asks.
fn echo_blocks(blocks: &[Value]) -> Vec<Value> {
    let boundary = blocks.iter().rposition(|block| block["type"] == "fallback");
    blocks
        .iter()
        .enumerate()
        .filter(|(index, block)| match boundary {
            Some(boundary) if *index < boundary => !matches!(
                block["type"].as_str(),
                Some("thinking" | "redacted_thinking" | "tool_use")
            ),
            _ => true,
        })
        .map(|(_, block)| block.clone())
        .collect()
}

/// Run one turn: send, retry a busy or rate-limited service at most twice
/// before any output, then read the stream to its end.
pub async fn stream_turn(
    client: &reqwest::Client,
    cred: &Credential,
    model: &str,
    history: &[ChatMessage],
    timing: &Timing,
    cancel: &CancelToken,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<TurnResult, AiError> {
    let body = request_body(model, history);
    let mut retries = 0;
    loop {
        let mut key = HeaderValue::from_str(&cred.key).map_err(|_| AiError::KeyUnreadable)?;
        key.set_sensitive(true);
        let mut request = client
            .post(format!("{}/v1/messages", cred.base_url))
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .timeout(timing.whole_turn);
        if takes_new_features(model) {
            request = request.header("anthropic-beta", FALLBACK_BETA);
        }
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            sent = tokio::time::timeout(timing.first_byte, request.send()) => match sent {
                Err(_) => return Err(AiError::Timeout),
                Ok(sent) => sent.map_err(|err| error_for_transport(&err))?,
            },
        };
        let status = response.status().as_u16();
        if status == 200 {
            return read_stream(response, model, timing, cancel, progress).await;
        }
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let error = error_for_status(status, retry_after.as_deref());
        let wait = timing.retry_wait(&error, retries);
        let Some(wait) = wait else {
            return Err(error);
        };
        progress(Progress::Retrying {
            seconds: wait.as_secs().max(1),
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            _ = tokio::time::sleep(wait) => {}
        }
        retries += 1;
    }
}

async fn read_stream(
    response: reqwest::Response,
    requested: &str,
    timing: &Timing,
    cancel: &CancelToken,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<TurnResult, AiError> {
    let started = Instant::now();
    let mut stream = response.bytes_stream();
    let mut sse = SseBuffer::default();
    let mut turn = TurnState::new(requested);
    loop {
        let remaining = timing
            .whole_turn
            .checked_sub(started.elapsed())
            .ok_or(AiError::Timeout)?;
        let wait = remaining.min(if turn.seen_any {
            timing.between_events
        } else {
            timing.first_byte
        });
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            next = tokio::time::timeout(wait, stream.next()) => next.map_err(|_| AiError::Timeout)?,
        };
        let Some(chunk) = next else {
            // The stream ended without message_stop. After a stop reason the
            // answer is whole; without one it stopped partway, and what
            // streamed stays on the page only, never echoed as blocks.
            return if turn.stop.is_some() {
                turn.finish()
            } else {
                Err(AiError::Timeout)
            };
        };
        let chunk = chunk.map_err(|err| error_for_transport(&err))?;
        for event in sse.push(&chunk)? {
            if turn.apply(&event, progress)? {
                return turn.finish();
            }
        }
    }
}

enum Block {
    Text(String),
    Thinking {
        thinking: String,
        signature: String,
    },
    /// Redacted thinking, a fallback marker, or anything else: kept as sent.
    Kept(Value),
}

struct TurnState {
    requested: String,
    blocks: BTreeMap<u64, Block>,
    text_bytes: usize,
    usage: Usage,
    served: Option<String>,
    fallback_from: Option<String>,
    stop: Option<String>,
    refusal_category: Option<String>,
    thinking_said: bool,
    seen_any: bool,
}

impl TurnState {
    fn new(requested: &str) -> Self {
        Self {
            requested: requested.to_string(),
            blocks: BTreeMap::new(),
            text_bytes: 0,
            usage: Usage::default(),
            served: None,
            fallback_from: None,
            stop: None,
            refusal_category: None,
            thinking_said: false,
            seen_any: false,
        }
    }

    /// Apply one event; true once the message is complete.
    fn apply(
        &mut self,
        event: &SseEvent,
        progress: &(dyn Fn(Progress) + Send + Sync),
    ) -> Result<bool, AiError> {
        self.seen_any = true;
        let data: Value = serde_json::from_str(&event.data).map_err(|_| AiError::Unexpected)?;
        match data["type"].as_str().unwrap_or_default() {
            "message_start" => {
                let message = &data["message"];
                self.served = message["model"].as_str().map(str::to_string);
                let usage = &message["usage"];
                self.usage.input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
                self.usage.output_tokens = usage["output_tokens"].as_u64().unwrap_or(0);
                self.usage.cache_read_tokens =
                    usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
                self.usage.cache_write_tokens =
                    usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let index = data["index"].as_u64().unwrap_or(0);
                let block = &data["content_block"];
                let started = match block["type"].as_str().unwrap_or_default() {
                    "text" => Block::Text(block["text"].as_str().unwrap_or_default().to_string()),
                    "thinking" => Block::Thinking {
                        thinking: block["thinking"].as_str().unwrap_or_default().to_string(),
                        signature: block["signature"].as_str().unwrap_or_default().to_string(),
                    },
                    "fallback" => {
                        let from = block["from"]["model"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string();
                        let to = block["to"]["model"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string();
                        if self.fallback_from.is_none() {
                            self.fallback_from = Some(from.clone());
                        }
                        self.served = Some(to.clone());
                        progress(Progress::Fallback { from, to });
                        Block::Kept(block.clone())
                    }
                    _ => Block::Kept(block.clone()),
                };
                self.blocks.insert(index, started);
            }
            "content_block_delta" => {
                let index = data["index"].as_u64().unwrap_or(0);
                let delta = &data["delta"];
                match (self.blocks.get_mut(&index), delta["type"].as_str()) {
                    (Some(Block::Text(text)), Some("text_delta")) => {
                        let piece = delta["text"].as_str().unwrap_or_default();
                        self.text_bytes += piece.len();
                        if self.text_bytes > MAX_TEXT_BYTES {
                            return Err(AiError::Unexpected);
                        }
                        text.push_str(piece);
                        if !piece.is_empty() {
                            progress(Progress::Token(piece.to_string()));
                        }
                    }
                    (Some(Block::Thinking { thinking, .. }), Some("thinking_delta")) => {
                        thinking.push_str(delta["thinking"].as_str().unwrap_or_default());
                        if !self.thinking_said {
                            self.thinking_said = true;
                            progress(Progress::Thinking);
                        }
                    }
                    (Some(Block::Thinking { signature, .. }), Some("signature_delta")) => {
                        *signature = delta["signature"].as_str().unwrap_or_default().to_string();
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(stop) = data["delta"]["stop_reason"].as_str() {
                    self.stop = Some(stop.to_string());
                }
                if let Some(category) = data["delta"]["stop_details"]["category"].as_str() {
                    self.refusal_category = Some(category.to_string());
                }
                if let Some(output) = data["usage"]["output_tokens"].as_u64() {
                    self.usage.output_tokens = output;
                }
            }
            "message_stop" => return Ok(true),
            "error" => return Err(stream_error(data["error"]["type"].as_str())),
            _ => {}
        }
        Ok(false)
    }

    fn finish(self) -> Result<TurnResult, AiError> {
        let mut text = String::new();
        let blocks: Vec<Value> = self
            .blocks
            .into_values()
            .filter_map(|block| match block {
                Block::Text(piece) => {
                    text.push_str(&piece);
                    // Nor can an empty text block go back: the service
                    // refuses a conversation that holds one.
                    (!piece.trim().is_empty()).then(|| json!({ "type": "text", "text": piece }))
                }
                // Cut off before its signature (the length limit, a dropped
                // stream), thinking cannot be sent back: the service would
                // refuse every later turn of the conversation.
                Block::Thinking { signature, .. } if signature.is_empty() => None,
                Block::Thinking {
                    thinking,
                    signature,
                } => Some(
                    json!({ "type": "thinking", "thinking": thinking, "signature": signature }),
                ),
                Block::Kept(value) => Some(value),
            })
            .collect();
        let blocks = Value::Array(blocks);
        match serde_json::to_vec(&blocks) {
            Ok(bytes) if bytes.len() <= MAX_BLOCKS_BYTES => {}
            _ => return Err(AiError::Unexpected),
        }
        let served = self.served.unwrap_or_else(|| self.requested.clone());
        // A turn served straight by the fallback model (it stays on it for a
        // while once a conversation fell back) carries no fallback block.
        let fallback_from = self
            .fallback_from
            .or_else(|| (served != self.requested).then(|| self.requested.clone()));
        let mut usage = self.usage;
        usage.cost_usd = cost_usd(&served, &usage);
        Ok(TurnResult {
            text,
            blocks: Some(blocks),
            stop: match self.stop.as_deref() {
                Some("end_turn") | Some("stop_sequence") | None => Stop::EndTurn,
                Some("max_tokens") => Stop::MaxTokens,
                Some("refusal") => Stop::Refusal,
                Some(_) => Stop::Other,
            },
            refusal_category: self.refusal_category,
            served_by: Some(served),
            fallback_from,
            usage: Some(usage),
        })
    }
}

/// An `error` event inside the stream, by its type.
fn stream_error(kind: Option<&str>) -> AiError {
    match kind {
        Some("overloaded_error" | "api_error") => AiError::Busy,
        Some("rate_limit_error") => AiError::RateLimited {
            retry_after_seconds: None,
        },
        Some("authentication_error") => AiError::KeyInvalid,
        Some("billing_error") => AiError::Billing,
        Some("permission_error" | "not_found_error") => AiError::NoAccess,
        Some("request_too_large") => AiError::TooLarge,
        Some("invalid_request_error") => AiError::BadRequest { status: 400 },
        _ => AiError::Unexpected,
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::client;
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Mutex;
    use std::time::Duration;

    const KEY: &str = "sk-ant-test-0000-WXYZ";
    const OPUS: &str = "claude-opus-5-5";

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: text.into(),
            blocks: None,
            sent: false,
        }
    }

    fn quick() -> Timing {
        Timing {
            busy_waits: [Duration::from_millis(10), Duration::from_millis(10)],
            ..Timing::default()
        }
    }

    /// Answer each response in turn, one connection each; hand back the
    /// requests (headers and body) as they arrived.
    fn serve(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            responses
                .into_iter()
                .map(|response| {
                    let (mut stream, _) = listener.accept().unwrap();
                    let request = read_request(&mut stream);
                    let _ = stream.write_all(response.as_bytes());
                    request
                })
                .collect()
        });
        (origin, handle)
    }

    /// Read headers, then as many body bytes as Content-Length says.
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let read = stream.read(&mut buf).unwrap_or(0);
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..read]);
            let text = String::from_utf8_lossy(&bytes).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn sse_response(events: &[(&str, &str)]) -> String {
        let body: String = events
            .iter()
            .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
            .collect();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn status_response(status: &str, extra: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\n{extra}Connection: close\r\n\r\n{{}}")
    }

    fn start(model: &str) -> String {
        format!(
            r#"{{"type":"message_start","message":{{"id":"msg_1","type":"message","role":"assistant","model":"{model}","content":[],"stop_reason":null,"usage":{{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":100}}}}}}"#
        )
    }

    const TEXT_START: &str =
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#;

    fn text_delta(index: u64, text: &str) -> String {
        format!(
            r#"{{"type":"content_block_delta","index":{index},"delta":{{"type":"text_delta","text":"{text}"}}}}"#
        )
    }

    fn stop_block(index: u64) -> String {
        format!(r#"{{"type":"content_block_stop","index":{index}}}"#)
    }

    fn message_delta(stop: &str) -> String {
        format!(
            r#"{{"type":"message_delta","delta":{{"stop_reason":"{stop}","stop_sequence":null}},"usage":{{"output_tokens":12}}}}"#
        )
    }

    const MESSAGE_STOP: &str = r#"{"type":"message_stop"}"#;

    async fn run(
        origin: &str,
        model: &str,
        history: &[ChatMessage],
    ) -> (Result<TurnResult, AiError>, Vec<Progress>) {
        let seen = Mutex::new(Vec::new());
        let cred = Credential {
            key: KEY.into(),
            base_url: origin.into(),
        };
        let result = stream_turn(
            &client().unwrap(),
            &cred,
            model,
            history,
            &quick(),
            &CancelToken::default(),
            &|event| seen.lock().unwrap().push(event),
        )
        .await;
        (result, seen.into_inner().unwrap())
    }

    #[test]
    fn the_request_carries_the_fixed_prompt_effort_thinking_and_fallback() {
        let body = request_body(OPUS, &[user("Merhaba")]);
        assert_eq!(body["model"], OPUS);
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["system"][0]["text"], JARVIS_SYSTEM);
        assert_eq!(
            body["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(body["output_config"], json!({ "effort": "medium" }));
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["cache_control"], json!({ "type": "ephemeral" }));
        assert!(body.get("temperature").is_none());

        let older = request_body("claude-haiku-4-5", &[user("Merhaba")]);
        assert!(older.get("thinking").is_none());
        assert!(older.get("output_config").is_none());
        assert!(older.get("fallbacks").is_none());
    }

    #[test]
    fn the_history_is_echoed_unchanged_and_nothing_else_goes() {
        let thinking = json!({ "type": "thinking", "thinking": "plan", "signature": "sig" });
        let text = json!({ "type": "text", "text": "Yanıt" });
        let history = vec![
            ChatMessage {
                role: "system".into(),
                content: "Project: C:\\secret".into(),
                blocks: None,
                sent: false,
            },
            user("Soru"),
            ChatMessage {
                role: "assistant".into(),
                content: "Yanıt".into(),
                blocks: Some(json!([thinking, text])),
                sent: false,
            },
            ChatMessage {
                role: "assistant".into(),
                content: "".into(),
                blocks: None,
                sent: false,
            },
            user("Devam"),
        ];
        let body = request_body(OPUS, &history);
        assert_eq!(
            body["messages"],
            json!([
                { "role": "user", "content": "Soru" },
                { "role": "assistant", "content": [thinking, text] },
                { "role": "user", "content": "Devam" },
            ])
        );
        assert!(!body.to_string().contains("secret"));
    }

    #[test]
    fn after_a_fallback_the_earlier_thinking_is_left_out() {
        let blocks = vec![
            json!({ "type": "thinking", "thinking": "a", "signature": "s1" }),
            json!({ "type": "text", "text": "Kısmi " }),
            json!({ "type": "fallback", "from": { "model": OPUS }, "to": { "model": "claude-opus-4-8" } }),
            json!({ "type": "thinking", "thinking": "b", "signature": "s2" }),
            json!({ "type": "text", "text": "devamı" }),
        ];
        let echoed = echo_blocks(&blocks);
        assert_eq!(echoed, blocks[1..].to_vec());
    }

    #[tokio::test]
    async fn a_plain_answer_streams_its_tokens_and_counts_its_cost() {
        let (origin, requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            ("content_block_start", TEXT_START),
            ("ping", r#"{"type":"ping"}"#),
            ("content_block_delta", &text_delta(0, "Mer")),
            ("content_block_delta", &text_delta(0, "haba")),
            ("content_block_stop", &stop_block(0)),
            ("message_delta", &message_delta("end_turn")),
            ("message_stop", MESSAGE_STOP),
        ])]);

        let (result, progress) = run(&origin, OPUS, &[user("Selam")]).await;

        let turn = result.unwrap();
        assert_eq!(turn.text, "Merhaba");
        assert_eq!(turn.stop, Stop::EndTurn);
        assert_eq!(turn.served_by.as_deref(), Some(OPUS));
        assert_eq!(turn.fallback_from, None);
        let usage = turn.usage.unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_write_tokens
            ),
            (120, 12, 100)
        );
        // 120×4 + 12×20 + 100×5 per million.
        assert!((usage.cost_usd.unwrap() - 0.00122).abs() < 1e-12);
        assert_eq!(
            progress,
            vec![
                Progress::Token("Mer".into()),
                Progress::Token("haba".into())
            ]
        );
        let request = requests.join().unwrap().remove(0).to_ascii_lowercase();
        assert!(request.starts_with("post /v1/messages "), "{request}");
        assert!(request.contains(&format!("x-api-key: {}", KEY.to_ascii_lowercase())));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(request.contains("anthropic-beta: server-side-fallback-2026-07-01"));
    }

    #[tokio::test]
    async fn thinking_is_said_once_and_kept_with_its_signature() {
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Düşün"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"üyorum"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}"#,
            ),
            ("content_block_stop", &stop_block(0)),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            ),
            ("content_block_delta", &text_delta(1, "Tamam")),
            ("content_block_stop", &stop_block(1)),
            ("message_delta", &message_delta("end_turn")),
            ("message_stop", MESSAGE_STOP),
        ])]);

        let (result, progress) = run(&origin, OPUS, &[user("Soru")]).await;

        let turn = result.unwrap();
        assert_eq!(turn.text, "Tamam");
        assert_eq!(
            turn.blocks.unwrap(),
            json!([
                { "type": "thinking", "thinking": "Düşünüyorum", "signature": "sig123" },
                { "type": "text", "text": "Tamam" },
            ])
        );
        assert_eq!(
            progress,
            vec![Progress::Thinking, Progress::Token("Tamam".into())]
        );
    }

    #[tokio::test]
    async fn a_fallback_names_the_model_that_answered() {
        let fallback = r#"{"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"claude-opus-5-5"},"to":{"model":"claude-opus-4-8"}}}"#;
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start("claude-opus-4-8")),
            ("content_block_start", fallback),
            ("content_block_stop", &stop_block(0)),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            ),
            ("content_block_delta", &text_delta(1, "Yanıt")),
            ("content_block_stop", &stop_block(1)),
            ("message_delta", &message_delta("end_turn")),
            ("message_stop", MESSAGE_STOP),
        ])]);

        let (result, progress) = run(&origin, OPUS, &[user("Soru")]).await;

        let turn = result.unwrap();
        assert_eq!(turn.served_by.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(turn.fallback_from.as_deref(), Some(OPUS));
        assert_eq!(turn.blocks.unwrap()[0]["type"], "fallback");
        assert_eq!(
            progress[0],
            Progress::Fallback {
                from: OPUS.into(),
                to: "claude-opus-4-8".into()
            }
        );
    }

    #[tokio::test]
    async fn a_refusal_and_a_cut_answer_say_why_they_stopped() {
        let refusal = r#"{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}},"usage":{"output_tokens":0}}"#;
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            ("message_delta", refusal),
            ("message_stop", MESSAGE_STOP),
        ])]);
        let turn = run(&origin, OPUS, &[user("Soru")]).await.0.unwrap();
        assert_eq!(turn.stop, Stop::Refusal);
        assert_eq!(turn.refusal_category.as_deref(), Some("cyber"));
        assert_eq!(turn.text, "");

        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            ("content_block_start", TEXT_START),
            ("content_block_delta", &text_delta(0, "Uzun")),
            ("message_delta", &message_delta("max_tokens")),
            ("message_stop", MESSAGE_STOP),
        ])]);
        let turn = run(&origin, OPUS, &[user("Soru")]).await.0.unwrap();
        assert_eq!(turn.stop, Stop::MaxTokens);
        assert_eq!(turn.text, "Uzun");
    }

    #[tokio::test]
    async fn thinking_cut_off_before_its_signature_is_not_kept() {
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Yarım"}}"#,
            ),
            ("message_delta", &message_delta("max_tokens")),
            ("message_stop", MESSAGE_STOP),
        ])]);

        let turn = run(&origin, OPUS, &[user("Soru")]).await.0.unwrap();

        assert_eq!(turn.stop, Stop::MaxTokens);
        assert_eq!(turn.blocks.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn an_empty_text_block_is_not_kept() {
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            ("content_block_start", TEXT_START),
            ("content_block_stop", &stop_block(0)),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            ),
            ("content_block_delta", &text_delta(1, "Tamam")),
            ("content_block_stop", &stop_block(1)),
            ("message_delta", &message_delta("end_turn")),
            ("message_stop", MESSAGE_STOP),
        ])]);

        let turn = run(&origin, OPUS, &[user("Soru")]).await.0.unwrap();

        assert_eq!(turn.text, "Tamam");
        assert_eq!(
            turn.blocks.unwrap(),
            json!([{ "type": "text", "text": "Tamam" }])
        );
    }

    #[tokio::test]
    async fn a_stream_that_stops_partway_says_so() {
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            ("content_block_start", TEXT_START),
            ("content_block_delta", &text_delta(0, "Yarım")),
        ])]);

        let (result, progress) = run(&origin, OPUS, &[user("Soru")]).await;

        assert!(matches!(result, Err(AiError::Timeout)));
        assert_eq!(progress, vec![Progress::Token("Yarım".into())]);
    }

    #[tokio::test]
    async fn an_error_inside_the_stream_is_a_busy_service() {
        let (origin, _requests) = serve(vec![sse_response(&[
            ("message_start", &start(OPUS)),
            (
                "error",
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            ),
        ])]);
        assert_eq!(
            run(&origin, OPUS, &[user("Soru")]).await.0,
            Err(AiError::Busy)
        );
    }

    #[tokio::test]
    async fn refusals_by_status_and_retries_before_any_output() {
        let (origin, requests) = serve(vec![status_response("401 Unauthorized", "")]);
        assert_eq!(
            run(&origin, OPUS, &[user("Soru")]).await.0,
            Err(AiError::KeyInvalid)
        );
        assert_eq!(requests.join().unwrap().len(), 1);

        let (origin, requests) = serve(vec![
            status_response("429 Too Many Requests", "retry-after: 1\r\n"),
            sse_response(&[
                ("message_start", &start(OPUS)),
                ("content_block_start", TEXT_START),
                ("content_block_delta", &text_delta(0, "Oldu")),
                ("message_delta", &message_delta("end_turn")),
                ("message_stop", MESSAGE_STOP),
            ]),
        ]);
        let (result, progress) = run(&origin, OPUS, &[user("Soru")]).await;
        assert_eq!(result.unwrap().text, "Oldu");
        assert_eq!(progress[0], Progress::Retrying { seconds: 1 });
        assert_eq!(requests.join().unwrap().len(), 2);

        let busy = status_response("529 Overloaded", "");
        let (origin, requests) = serve(vec![busy.clone(), busy.clone(), busy]);
        assert_eq!(
            run(&origin, OPUS, &[user("Soru")]).await.0,
            Err(AiError::Busy)
        );
        assert_eq!(requests.join().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_cancelled_turn_stops() {
        let cancel = CancelToken::default();
        cancel.cancel();
        let cred = Credential {
            key: KEY.into(),
            base_url: "http://127.0.0.1:9".into(),
        };
        let result = stream_turn(
            &client().unwrap(),
            &cred,
            OPUS,
            &[user("Soru")],
            &quick(),
            &cancel,
            &|_| {},
        )
        .await;
        assert_eq!(result, Err(AiError::Cancelled));
    }
}
