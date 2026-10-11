/* ============================================================
Live-engine tests: a real local model, the pinned engine, no Ollama.

Everything else in this module runs on fixtures and a fake server. These
put the production code in front of the real llama-server and a real
model, the way a Jarvis turn does: resolve the model, prepare its copy
when it needs one, start the engine, stream a turn with the agent tools.

`#[ignore]` because they need an engine and a model on disk. Point
QUTRA_LIVE_APP_DIR at a scratch folder (never the app's own data) holding
`engine\llama-b11541\` (the pinned runtime files), then:

    $env:QUTRA_LIVE_APP_DIR='C:\scratch\qutra-live'
    $env:QUTRA_LIVE_MODEL='gemma4:26b'
    cargo test --lib live_engine -- --ignored --nocapture --test-threads=1

The model comes from Ollama's store, read in place; Ollama need not run.
A model that needs a text-only copy gets it in `<dir>\models\` first.
============================================================ */

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use futures_util::StreamExt;

use super::models::ModelState;
use super::LocalEngine;
use crate::assistant::engine_chat::{self, ChatMessage, Piece, StreamDecoder};

fn live() -> (LocalEngine, String) {
    let dir = PathBuf::from(std::env::var("QUTRA_LIVE_APP_DIR").expect("QUTRA_LIVE_APP_DIR"));
    let model = std::env::var("QUTRA_LIVE_MODEL").unwrap_or_else(|_| "gemma4:26b".into());
    (LocalEngine::new(&dir), model)
}

fn user(text: &str) -> ChatMessage {
    ChatMessage {
        role: "user".into(),
        content: text.into(),
        tool_calls: None,
        tool_name: None,
        tool_call_id: None,
    }
}

async fn turn(
    origin: &str,
    key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<serde_json::Value>,
) -> (String, Vec<engine_chat::ToolCall>) {
    let body = engine_chat::chat_request(model, messages, tools);
    let response =
        engine_chat::open_chat_stream(&engine_chat::client().unwrap(), origin, key, &body)
            .await
            .unwrap_or_else(|e| panic!("open: {}", e.code()));
    let mut decoder = StreamDecoder::default();
    let mut text = String::new();
    let mut stream = response.bytes_stream();
    'read: while let Some(bytes) = stream.next().await {
        for piece in decoder.push(&bytes.unwrap()).unwrap() {
            match piece {
                Piece::Text(t) => text.push_str(&t),
                Piece::Done => break 'read,
            }
        }
    }
    (text, decoder.tool_calls())
}

#[tokio::test]
#[ignore = "needs the pinned engine and a model on disk"]
async fn a_local_model_answers_without_ollama() {
    let (local, id) = live();
    let found = local
        .find(&id)
        .expect("model in the app folder or Ollama's store");
    println!(
        "{id}: {:?}, {} bytes, tools {:?}",
        found.state, found.size_bytes, found.tools
    );
    if let ModelState::NeedsPrepare { write_bytes } = found.state {
        let started = Instant::now();
        let path = local
            .prepare_copy(&found, &|_| {}, &AtomicBool::new(false))
            .expect("prepared copy");
        println!(
            "prepared {} ({write_bytes} bytes) in {:?}",
            path.display(),
            started.elapsed()
        );
    }

    let target = local.resolve(&id).expect("a model the engine runs");
    let started = Instant::now();
    let lease = local
        .engine
        .ensure(&target, 8192)
        .await
        .unwrap_or_else(|e| panic!("engine: {}", e.code()));
    println!(
        "engine ready at {} in {:?}",
        lease.origin,
        started.elapsed()
    );

    let started = Instant::now();
    let (answer, calls) = turn(
        &lease.origin,
        &lease.api_key,
        &lease.model,
        &[user("Merhaba! Kendini tek cümleyle tanıt.")],
        None,
    )
    .await;
    println!("answer in {:?}: {answer}", started.elapsed());
    assert!(!answer.trim().is_empty());
    assert!(calls.is_empty());

    let started = Instant::now();
    let (_, calls) = turn(
        &lease.origin,
        &lease.api_key,
        &lease.model,
        &[user(
            "Which project am I working on? Use your tools to find out.",
        )],
        Some(crate::assistant::tools::agent_tool_schema()),
    )
    .await;
    println!("tool call in {:?}: {calls:?}", started.elapsed());
    assert!(
        !calls.is_empty(),
        "the model answered in prose instead of calling a tool"
    );
    assert!(
        crate::assistant::tools::parse_tool_call(&calls[0]).is_ok(),
        "{calls:?}"
    );

    drop(lease);
    local.engine.stop().await;
}
