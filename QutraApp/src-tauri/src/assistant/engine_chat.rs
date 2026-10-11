//! The only place in the app that speaks HTTP to the local engine.
//!
//! The engine is Qutra's own llama-server (`crate::local_engine`, ADR 0016),
//! reached through its OpenAI-compatible `/v1/chat/completions` with
//! `tools`. Where a turn goes is not configuration: the origin and key come
//! from the engine lease Rust holds for the turn, a loopback address on a
//! port Rust picked. Nothing here accepts a host, port or URL from a
//! preference, an IPC payload or model output.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::error::AssistantError;
use crate::ai::sse::SseBuffer;

/// A cold engine processes a long prompt before the first token; this
/// catches a wedged engine, not a slow prompt (measured 64 prompt tokens/s
/// on a 26B model with its weights split over RAM and GPU).
pub const FIRST_TOKEN_TIMEOUT: Duration = Duration::from_secs(300);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Largest non-success body read. Only a few words of it are matched.
pub const ERROR_BODY_LIMIT: usize = 64 * 1024;
/// Most bytes of arguments one proposed call may stream.
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
/// Most tool calls collected from one step. Only the first is acted on.
pub const MAX_TOOL_CALLS_PER_STEP: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// The `tool` role's name when feeding a result back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// The call a `tool` message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    /// The engine streams a JSON string; it is decoded into a value once
    /// whole, so a malformed argument set is refused by the typed parse in
    /// `tools.rs` rather than by a guess here.
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    #[serde(default)]
    pub id: String,
    pub function: ToolFunction,
}

/// Build the client for engine requests. No proxy: a machine-wide
/// `HTTP_PROXY` would otherwise carry loopback traffic out. No redirects:
/// a 307/308 would forward the prompt to wherever it points (TM-003).
pub fn client() -> Result<reqwest::Client, AssistantError> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| AssistantError::Internal(e.to_string()))
}

/// True only for `http://127.0.0.1:<port>`: the shape of every origin the
/// engine is ever started on.
pub fn origin_is_loopback_engine(origin: &str) -> bool {
    origin
        .strip_prefix("http://127.0.0.1:")
        .and_then(|port| port.parse::<u16>().ok())
        .is_some_and(|port| port != 0)
}

pub fn url_on(origin: &str, path: &str) -> Result<String, AssistantError> {
    if !origin_is_loopback_engine(origin) {
        return Err(AssistantError::Internal(
            "assistant endpoint is not the local engine".into(),
        ));
    }
    Ok(format!("{origin}{path}"))
}

/// One message as the OpenAI-compatible endpoint reads it.
fn wire_message(message: &ChatMessage) -> Value {
    match (message.role.as_str(), &message.tool_calls) {
        ("tool", _) => json!({
            "role": "tool",
            "tool_call_id": message.tool_call_id.clone().unwrap_or_default(),
            "content": message.content,
        }),
        ("assistant", Some(calls)) if !calls.is_empty() => json!({
            "role": "assistant",
            "content": message.content,
            "tool_calls": calls.iter().map(|call| json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.function.name,
                    "arguments": call.function.arguments.to_string(),
                },
            })).collect::<Vec<_>>(),
        }),
        (role, _) => json!({ "role": role, "content": message.content }),
    }
}

/// The body of one streamed step. Thinking stays off, as it was with the
/// previous engine (`think: false`).
pub fn chat_request(model: &str, messages: &[ChatMessage], tools: Option<Value>) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(wire_message).collect::<Vec<_>>(),
        "stream": true,
        "chat_template_kwargs": { "enable_thinking": false },
    });
    if let Some(tools) = tools {
        body["tools"] = tools;
    }
    body
}

/// Turn a non-success status and body into the error it represents.
pub fn classify_chat_error(status: u16, requested_tools: bool, body: &str) -> AssistantError {
    let lower = body.to_ascii_lowercase();
    if status == 400 && lower.contains("exceed") && lower.contains("context") {
        return AssistantError::LocalEngine("context_exceeded".into());
    }
    if status == 400 && requested_tools && lower.contains("tool") && lower.contains("not support") {
        return AssistantError::ModelToolsUnsupported;
    }
    if status == 401 {
        // The engine no longer knows this turn's key: it was restarted.
        return AssistantError::LocalEngine("engine_restarted".into());
    }
    AssistantError::Http(status)
}

/// Read at most `limit` bytes of a body, chunk by chunk, so a larger body
/// is never buffered first and measured after.
pub async fn read_at_most(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<(Vec<u8>, bool), reqwest::Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let room = limit - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

/// Open the streaming response for one step.
pub async fn open_chat_stream(
    client: &reqwest::Client,
    origin: &str,
    key: &str,
    body: &Value,
) -> Result<reqwest::Response, AssistantError> {
    let url = url_on(origin, "/v1/chat/completions")?;
    let mut response = client
        .post(url)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|_| AssistantError::Offline)?;
    let status = response.status();
    if !status.is_success() {
        let (bytes, _) = read_at_most(&mut response, ERROR_BODY_LIMIT)
            .await
            .unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        return Err(classify_chat_error(
            status.as_u16(),
            body.get("tools").is_some(),
            &text,
        ));
    }
    Ok(response)
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

/// What one stream yields as it arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    Done,
}

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<DeltaCall>>,
}

#[derive(Deserialize)]
struct DeltaCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<DeltaFunction>,
}

#[derive(Deserialize)]
struct DeltaFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// Decodes the engine's server-sent events into text and tool calls. An
/// event is decoded only once it is whole, so a letter split across two
/// reads stays whole; a malformed event is skipped, not fatal.
#[derive(Default)]
pub struct StreamDecoder {
    sse: SseBuffer,
    calls: Vec<PartialCall>,
}

impl StreamDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Piece>, AssistantError> {
        let events = self
            .sse
            .push(bytes)
            .map_err(|_| AssistantError::ResponseTooLarge)?;
        let mut pieces = Vec::new();
        for event in events {
            let data = event.data.trim();
            if data == "[DONE]" {
                pieces.push(Piece::Done);
                continue;
            }
            let Ok(chunk) = serde_json::from_str::<Chunk>(data) else {
                continue;
            };
            if chunk.error.is_some() {
                return Err(AssistantError::Http(500));
            }
            for choice in chunk.choices {
                if let Some(text) = choice.delta.content.filter(|t| !t.is_empty()) {
                    pieces.push(Piece::Text(text));
                }
                for call in choice.delta.tool_calls.unwrap_or_default() {
                    if call.index >= MAX_TOOL_CALLS_PER_STEP {
                        return Err(AssistantError::ResponseTooLarge);
                    }
                    while self.calls.len() <= call.index {
                        self.calls.push(PartialCall::default());
                    }
                    let slot = &mut self.calls[call.index];
                    if let Some(id) = call.id {
                        slot.id = id;
                    }
                    if let Some(function) = call.function {
                        if let Some(name) = function.name {
                            slot.name.push_str(&name);
                        }
                        if let Some(arguments) = function.arguments {
                            slot.arguments.push_str(&arguments);
                        }
                    }
                    if slot.arguments.len() > MAX_ARGUMENT_BYTES || slot.name.len() > 256 {
                        return Err(AssistantError::ResponseTooLarge);
                    }
                }
                if choice.finish_reason.is_some() {
                    pieces.push(Piece::Done);
                }
            }
        }
        Ok(pieces)
    }

    /// The calls proposed so far, arguments decoded. Arguments that are not
    /// JSON become `null`, which the typed parse refuses.
    pub fn tool_calls(&self) -> Vec<ToolCall> {
        self.calls
            .iter()
            .filter(|call| !call.name.is_empty())
            .map(|call| ToolCall {
                id: call.id.clone(),
                function: ToolFunction {
                    name: call.name.clone(),
                    arguments: if call.arguments.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&call.arguments).unwrap_or(Value::Null)
                    },
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(stream: &str) -> (Vec<Piece>, Vec<ToolCall>) {
        let mut decoder = StreamDecoder::default();
        let pieces = decoder.push(stream.as_bytes()).unwrap();
        (pieces, decoder.tool_calls())
    }

    #[test]
    fn only_a_loopback_engine_origin_is_accepted() {
        assert!(origin_is_loopback_engine("http://127.0.0.1:49152"));
        for rejected in [
            "http://127.0.0.1:0",
            "http://127.0.0.1:",
            "http://localhost:8080",
            "http://[::1]:8080",
            "https://127.0.0.1:8080",
            "http://127.0.0.1:8080/x",
            "http://127.0.0.1:8080@evil.example",
            "http://8.8.8.8:8080",
        ] {
            assert!(!origin_is_loopback_engine(rejected), "{rejected}");
            assert!(
                url_on(rejected, "/v1/chat/completions").is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn a_step_streams_and_carries_the_tool_schema_only_when_given() {
        let tools = json!([{ "type": "function", "function": { "name": "read_context" } }]);
        let body = chat_request("gemma4:26b", &[], Some(tools));
        assert_eq!(body["stream"], true);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert!(body.to_string().contains("read_context"));
        let body = chat_request("gemma4:26b", &[], None);
        assert!(body.get("tools").is_none(), "absent, not null");
    }

    #[test]
    fn a_tool_round_trip_is_written_the_way_the_endpoint_reads_it() {
        let call = ToolCall {
            id: "c1".into(),
            function: ToolFunction {
                name: "read_context".into(),
                arguments: json!({"kind": "project"}),
            },
        };
        let messages = [
            ChatMessage {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: Some(vec![call]),
                tool_name: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: "Project: demo".into(),
                tool_calls: None,
                tool_name: Some("read_context".into()),
                tool_call_id: Some("c1".into()),
            },
        ];
        let body = chat_request("m", &messages, None);
        let sent = &body["messages"];
        assert_eq!(sent[0]["tool_calls"][0]["id"], "c1");
        assert_eq!(sent[0]["tool_calls"][0]["type"], "function");
        // Arguments go as a JSON string, as the OpenAI shape says.
        assert_eq!(
            sent[0]["tool_calls"][0]["function"]["arguments"],
            r#"{"kind":"project"}"#
        );
        assert_eq!(sent[1]["role"], "tool");
        assert_eq!(sent[1]["tool_call_id"], "c1");
        assert!(sent[1].get("tool_name").is_none());
    }

    #[test]
    fn text_streams_token_by_token_and_the_end_is_heard() {
        let (pieces, calls) = decode(concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":null}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Mer\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"haba\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"timings\":{}}\n\n",
            "data: [DONE]\n\n",
        ));
        assert_eq!(
            pieces,
            vec![
                Piece::Text("Mer".into()),
                Piece::Text("haba".into()),
                Piece::Done,
                Piece::Done
            ]
        );
        assert!(calls.is_empty());
    }

    #[test]
    fn a_tool_call_streamed_in_pieces_is_put_back_together() {
        // The shape the pinned engine sent for Gemma 4 (2026-10-10), split
        // the way a stream splits it.
        let (pieces, calls) = decode(concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"dlTW6\",\"type\":\"function\",\"function\":{\"name\":\"read_context\",\"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"kind\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"project\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        ));
        assert_eq!(pieces, vec![Piece::Done]);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "dlTW6");
        assert_eq!(calls[0].function.name, "read_context");
        assert_eq!(calls[0].function.arguments, json!({"kind": "project"}));
        assert!(crate::assistant::tools::parse_tool_call(&calls[0]).is_ok());
    }

    #[test]
    fn arguments_that_are_not_json_are_refused_by_the_typed_parse() {
        let (_, calls) = decode(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read_context\",\"arguments\":\"{not json\"}}]}}]}\n\n",
        );
        assert_eq!(calls[0].function.arguments, Value::Null);
        assert!(crate::assistant::tools::parse_tool_call(&calls[0]).is_err());
    }

    #[test]
    fn a_letter_split_across_two_reads_stays_whole() {
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"ağaç\"}}]}\n\n";
        let cut = event.find('ğ').unwrap() + 1;
        let mut decoder = StreamDecoder::default();
        assert!(decoder.push(&event.as_bytes()[..cut]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&event.as_bytes()[cut..]).unwrap(),
            vec![Piece::Text("ağaç".into())]
        );
    }

    #[test]
    fn a_ninth_tool_call_or_endless_arguments_are_too_large() {
        let ninth = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":{MAX_TOOL_CALLS_PER_STEP},\"function\":{{\"name\":\"read_context\"}}}}]}}}}]}}\n\n"
        );
        let mut decoder = StreamDecoder::default();
        assert_eq!(
            decoder.push(ninth.as_bytes()).unwrap_err().code(),
            "response_too_large"
        );
        let big = "x".repeat(MAX_ARGUMENT_BYTES + 1);
        let endless = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":0,\"function\":{{\"name\":\"read_context\",\"arguments\":\"{big}\"}}}}]}}}}]}}\n\n"
        );
        let mut decoder = StreamDecoder::default();
        assert_eq!(
            decoder.push(endless.as_bytes()).unwrap_err().code(),
            "response_too_large"
        );
    }

    #[test]
    fn an_event_that_never_ends_is_too_large() {
        let mut decoder = StreamDecoder::default();
        let chunk = vec![b'x'; 64 * 1024];
        let mut outcome = Ok(vec![]);
        for _ in 0..32 {
            outcome = decoder.push(&chunk);
            if outcome.is_err() {
                break;
            }
        }
        assert_eq!(outcome.unwrap_err().code(), "response_too_large");
    }

    #[test]
    fn an_error_event_ends_the_step() {
        let mut decoder = StreamDecoder::default();
        let err = decoder
            .push(b"data: {\"error\":{\"code\":500,\"message\":\"boom\"}}\n\n")
            .unwrap_err();
        assert_eq!(err.code(), "http_500");
    }

    #[test]
    fn error_statuses_name_their_cause() {
        assert_eq!(
            classify_chat_error(
                400,
                false,
                r#"{"error":{"message":"the request exceeds the available context size, try increasing it"}}"#
            )
            .code(),
            "context_exceeded"
        );
        assert_eq!(
            classify_chat_error(401, false, "").code(),
            "engine_restarted"
        );
        assert_eq!(classify_chat_error(400, false, "nope").code(), "http_400");
        assert_eq!(classify_chat_error(500, true, "").code(), "http_500");
    }

    /// TM-003: a 307/308 must not carry the chat body to a second host.
    #[tokio::test]
    async fn a_307_does_not_forward_the_request_body_to_a_second_listener() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        fn serve_one(listener: TcpListener, response: Vec<u8>, hits: Option<Arc<AtomicUsize>>) {
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    if let Some(hits) = hits {
                        hits.fetch_add(1, Ordering::SeqCst);
                    }
                    let mut buf = [0u8; 8192];
                    let _ = stream.read(&mut buf);
                    let _ = stream.write_all(&response);
                }
            });
        }

        let second_hits = Arc::new(AtomicUsize::new(0));
        let second = TcpListener::bind("127.0.0.1:0").unwrap();
        let second_addr = second.local_addr().unwrap();
        serve_one(
            second,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec(),
            Some(second_hits.clone()),
        );
        let first = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", first.local_addr().unwrap());
        let location = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{second_addr}/stolen\r\nContent-Length: 0\r\n\r\n"
        );
        serve_one(first, location.into_bytes(), None);

        let err = open_chat_stream(
            &client().unwrap(),
            &origin,
            "k",
            &json!({"messages":[{"role":"user","content":"SECRET_PROMPT"}]}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "http_307", "the hop surfaces as a status");
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(second_hits.load(Ordering::SeqCst), 0);
    }
}
