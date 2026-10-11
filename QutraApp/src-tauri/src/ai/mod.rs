//! Cloud AI connections for Jarvis (spec 2026-10-07 §7; D8, D11): the
//! connection targets, write-only keys, and listing a connection's models.
//! Every call goes from Rust; the page's content security policy stays shut.

pub mod anthropic;
pub mod chat;
pub mod errors;
pub mod exclusions;
pub mod http;
pub mod key_list;
pub mod keys;
pub mod mask;
pub mod models;
pub mod openai_compat;
pub mod pricing;
pub mod providers;
pub mod sse;
pub mod turn;
pub mod web;

pub use providers::Target;
