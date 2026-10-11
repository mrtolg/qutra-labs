# ADR 0006 — GitHub integration (read-only)

**Status:** accepted · 2026-07-23 (Phase 2) · **amended 2026-07-29 (R0-02)**

## Context

GitHub is an optional, read-only integration. Qutra Labs must stay fully usable
offline and without an account. Tokens are secrets (ADR 0003/0005).

## Decision

1. **Network path (desktop).** All GitHub HTTPS runs through a **narrow Rust
   broker** (`github_api_get`, `github_graphql`). The renderer never
   `fetch()`es `github.com` / `api.github.com`. CSP `connect-src` stays without
   GitHub hosts. Allowlisted GET paths and a fixed GraphQL contributions query
   only — no free-form URL from the UI.
2. **Auth.** Device Flow is enabled when the public
   `VITE_GITHUB_CLIENT_ID` is configured. Code issuance and polling use fixed
   GitHub endpoints in Rust. A fine-grained PAT remains an explicitly labeled
   fallback. Device Flow is shown as unavailable when the client ID is absent
   or the app is not running under Tauri.
3. **Token storage.** Only in the OS secure store via `SecureStore`
   (ADR 0005), keyed `github.token`. Never in SQLite, localStorage, logs,
   diagnostics, exports or process args. Device Flow stores the token in Rust
   before returning an `authorized` state; the renderer sees no token value.
   The broker attaches the token to API requests in Rust.
4. **Provider boundary.** `GitHubProvider` is the only caller of GitHub data
   APIs — React never talks to GitHub directly. Under Tauri it uses
   `brokerTransport`; unit tests inject `fetchImpl`.
5. **Normalization.** Raw API shapes are normalized (`domain/github.ts`).
6. **Honest states.** Disconnected, offline, rate-limited, and labeled demo
   preview are explicit.

## Remaining (later)

Workspace-to-repository linkage; issue-to-task.
