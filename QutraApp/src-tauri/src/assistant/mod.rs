//! Qutra — local assistant broker.
//!
//! The renderer no longer performs HTTP to Ollama. It sends intent over a
//! narrow IPC surface and receives streamed events; every decision about
//! whether, where and for how long a request happens is made here.
//!
//! See docs/decisions/0010-local-assistant-lab.md.

pub mod audit;
pub mod broker;
pub mod commands;
pub mod dispatch;
pub mod engine_chat;
pub mod error;
pub mod tools;

pub use broker::AssistantState;
