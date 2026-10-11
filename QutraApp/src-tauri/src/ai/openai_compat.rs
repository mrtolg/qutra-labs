//! OpenAI-compatible chat completions, streamed (spec 2026-10-07 §7.3):
//! OpenAI, Gemini, OpenRouter, Groq and local servers.
//! `POST {base}/chat/completions` with `stream: true`; the answer comes as
//! `data:` chunks ending with `[DONE]`. A local server may take no key.

use std::time::Instant;

use futures_util::StreamExt;
use serde_json::{json, Value};

use super::anthropic::JARVIS_SYSTEM;
use super::errors::{error_for_status, error_for_transport, AiError};
use super::keys::Credential;
use super::providers::{Preset, Target};
use super::sse::SseBuffer;
use super::turn::{CancelToken, ChatMessage, Progress, Stop, Timing, TurnResult, Usage};

const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// The fixed prompt, then the conversation's user and assistant text.
/// Anything else the page sends stays home.
pub fn request_body(model: &str, history: &[ChatMessage]) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": JARVIS_SYSTEM })];
    for message in history {
        let kept = matches!(message.role.as_str(), "user" | "assistant");
        if kept && !message.content.trim().is_empty() {
            messages.push(json!({ "role": message.role, "content": message.content }));
        }
    }
    json!({ "model": model, "stream": true, "messages": messages })
}

#[allow(clippy::too_many_arguments)]
pub async fn stream_turn(
    client: &reqwest::Client,
    target: Target,
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
        let mut request = client
            .post(format!("{}/chat/completions", cred.base_url))
            .json(&body)
            .timeout(timing.whole_turn);
        if !cred.key.is_empty() {
            request = request.bearer_auth(&cred.key);
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
        let error = match (target, status) {
            (
                Target::OpenaiCompat {
                    preset: Preset::Custom,
                },
                404 | 405,
            ) => AiError::AddressNotFound,
            _ => error_for_status(status, retry_after.as_deref()),
        };
        let Some(wait) = timing.retry_wait(&error, retries) else {
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
    let mut text = String::new();
    let mut stop = Stop::EndTurn;
    let mut served: Option<String> = None;
    let mut usage: Option<Usage> = None;
    let mut seen_any = false;
    let mut finished = false;
    loop {
        let remaining = timing
            .whole_turn
            .checked_sub(started.elapsed())
            .ok_or(AiError::Timeout)?;
        let wait = remaining.min(if seen_any {
            timing.between_events
        } else {
            timing.first_byte
        });
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AiError::Cancelled),
            next = tokio::time::timeout(wait, stream.next()) => next.map_err(|_| AiError::Timeout)?,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|err| error_for_transport(&err))?;
        for event in sse.push(&chunk)? {
            seen_any = true;
            if event.data.trim() == "[DONE]" {
                return Ok(finish(text, stop, served, usage, requested));
            }
            let data: Value = serde_json::from_str(&event.data).map_err(|_| AiError::Unexpected)?;
            if data.get("error").is_some() {
                return Err(AiError::Unexpected);
            }
            if let Some(model) = data["model"].as_str() {
                served.get_or_insert_with(|| model.to_string());
            }
            let choice = &data["choices"][0];
            if let Some(piece) = choice["delta"]["content"].as_str() {
                if !piece.is_empty() {
                    if text.len() + piece.len() > MAX_TEXT_BYTES {
                        return Err(AiError::Unexpected);
                    }
                    text.push_str(piece);
                    progress(Progress::Token(piece.to_string()));
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                finished = true;
                stop = match reason {
                    "stop" => Stop::EndTurn,
                    "length" => Stop::MaxTokens,
                    "content_filter" => Stop::Refusal,
                    _ => Stop::Other,
                };
            }
            if data["usage"].is_object() {
                usage = Some(Usage {
                    input_tokens: data["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
                    output_tokens: data["usage"]["completion_tokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: data["usage"]["prompt_tokens_details"]["cached_tokens"]
                        .as_u64()
                        .unwrap_or(0),
                    cache_write_tokens: 0,
                    cost_usd: None,
                });
            }
        }
    }
    // The stream ended without [DONE]. After a finish reason the answer is
    // whole; without one it stopped partway, and what streamed stays on the
    // page only.
    if finished {
        Ok(finish(text, stop, served, usage, requested))
    } else {
        Err(AiError::Timeout)
    }
}

fn finish(
    text: String,
    stop: Stop,
    served: Option<String>,
    usage: Option<Usage>,
    requested: &str,
) -> TurnResult {
    TurnResult {
        text,
        blocks: None,
        stop,
        refusal_category: None,
        served_by: Some(served.unwrap_or_else(|| requested.to_string())),
        fallback_from: None,
        usage,
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::client;
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Mutex;

    const KEY: &str = "sk-test-key-0000-abcd";
    const OPENAI: Target = Target::OpenaiCompat {
        preset: Preset::Openai,
    };
    const CUSTOM: Target = Target::OpenaiCompat {
        preset: Preset::Custom,
    };

    fn serve(response: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
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
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|n| n.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8_lossy(&bytes).into_owned()
        });
        (origin, handle)
    }

    fn sse(chunks: &[&str]) -> String {
        let body: String = chunks
            .iter()
            .map(|chunk| format!("data: {chunk}\n\n"))
            .collect();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: text.into(),
            blocks: None,
            sent: false,
        }
    }

    async fn run(
        target: Target,
        origin: &str,
        key: &str,
    ) -> (Result<TurnResult, AiError>, Vec<Progress>) {
        let seen = Mutex::new(Vec::new());
        let cred = Credential {
            key: key.into(),
            base_url: origin.into(),
        };
        let result = stream_turn(
            &client().unwrap(),
            target,
            &cred,
            "gpt-a",
            &[user("Merhaba")],
            &Timing::default(),
            &CancelToken::default(),
            &|event| seen.lock().unwrap().push(event),
        )
        .await;
        (result, seen.into_inner().unwrap())
    }

    #[test]
    fn the_request_holds_the_fixed_prompt_and_the_conversation_only() {
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
                blocks: None,
                sent: false,
            },
        ];
        let body = request_body("gpt-a", &history);
        assert_eq!(body["stream"], true);
        assert_eq!(
            body["messages"],
            json!([
                { "role": "system", "content": JARVIS_SYSTEM },
                { "role": "user", "content": "Soru" },
                { "role": "assistant", "content": "Yanıt" },
            ])
        );
        assert!(!body.to_string().contains("secret"));
    }

    #[tokio::test]
    async fn chunks_stream_as_tokens_until_done() {
        let (origin, request) = serve(sse(&[
            r#"{"model":"gpt-a-2026","choices":[{"delta":{"role":"assistant","content":""}}]}"#,
            r#"{"model":"gpt-a-2026","choices":[{"delta":{"content":"Mer"}}]}"#,
            r#"{"model":"gpt-a-2026","choices":[{"delta":{"content":"haba"},"finish_reason":"stop"}]}"#,
            r#"{"model":"gpt-a-2026","choices":[],"usage":{"prompt_tokens":30,"completion_tokens":5}}"#,
            "[DONE]",
        ]));

        let (result, progress) = run(OPENAI, &origin, KEY).await;

        let turn = result.unwrap();
        assert_eq!(turn.text, "Merhaba");
        assert_eq!(turn.stop, Stop::EndTurn);
        assert_eq!(turn.served_by.as_deref(), Some("gpt-a-2026"));
        assert_eq!(turn.blocks, None);
        let usage = turn.usage.unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (30, 5));
        assert_eq!(usage.cost_usd, None);
        assert_eq!(
            progress,
            vec![
                Progress::Token("Mer".into()),
                Progress::Token("haba".into())
            ]
        );
        let request = request.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /chat/completions "), "{request}");
        assert!(request.contains(&format!(
            "authorization: bearer {}",
            KEY.to_ascii_lowercase()
        )));
    }

    #[tokio::test]
    async fn a_cut_answer_says_so() {
        let (origin, _request) = serve(sse(&[
            r#"{"choices":[{"delta":{"content":"Uzun"},"finish_reason":"length"}]}"#,
            "[DONE]",
        ]));
        let turn = run(OPENAI, &origin, KEY).await.0.unwrap();
        assert_eq!(turn.stop, Stop::MaxTokens);
        assert_eq!(turn.served_by.as_deref(), Some("gpt-a"));
    }

    #[tokio::test]
    async fn a_stream_that_stops_partway_says_so_and_one_without_done_is_whole() {
        let (origin, _request) = serve(sse(&[r#"{"choices":[{"delta":{"content":"Yarım"}}]}"#]));
        let (result, progress) = run(OPENAI, &origin, KEY).await;
        assert!(matches!(result, Err(AiError::Timeout)));
        assert_eq!(progress, vec![Progress::Token("Yarım".into())]);

        let (origin, _request) = serve(sse(&[
            r#"{"choices":[{"delta":{"content":"Tamam"},"finish_reason":"stop"}]}"#,
        ]));
        let turn = run(OPENAI, &origin, KEY).await.0.unwrap();
        assert_eq!((turn.text.as_str(), turn.stop), ("Tamam", Stop::EndTurn));
    }

    #[tokio::test]
    async fn a_keyless_local_server_gets_no_authorization_and_a_wrong_address_says_so() {
        let (origin, request) = serve(sse(&[
            r#"{"choices":[{"delta":{"content":"ok"}}]}"#,
            "[DONE]",
        ]));
        assert_eq!(run(CUSTOM, &origin, "").await.0.unwrap().text, "ok");
        assert!(!request
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));

        let (origin, _request) = serve(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
        );
        assert_eq!(
            run(CUSTOM, &origin, "").await.0,
            Err(AiError::AddressNotFound)
        );
    }

    #[tokio::test]
    async fn a_refused_key_is_a_bad_key() {
        let (origin, _request) = serve(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
        );
        assert_eq!(run(OPENAI, &origin, KEY).await.0, Err(AiError::KeyInvalid));
    }
}
