//! GitHub HTTP broker — the only place the desktop app may reach
//! `api.github.com`. The renderer never `fetch()`es GitHub hosts; CSP stays
//! closed (`connect-src` without github). See ADR 0006.

pub mod broker;
pub(crate) mod commands;
