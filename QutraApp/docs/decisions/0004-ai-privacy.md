# ADR 0004 — AI assistant privacy

**Status:** accepted · 2026-07-23

> **Superseded in part by [ADR 0015](0015-cloud-ai-providers-and-data-egress.md)
> (2026-10-09):** Jarvis may answer through a cloud connection the user sets up. What a
> cloud turn sends, how secrets are masked and what each answer discloses are recorded
> there.

> **Superseded in part by [ADR 0012](0012-agentic-assistant.md) (2026-08-13), for the
> local assistant only.** That assistant may now *act* — call one of three allowlisted
> tools (`terminal_run`, `launch_tool`, `read_context`) under explicit, per-call user
> approval — where it could previously only read and answer. What leaves the device is
> unchanged: no cloud provider for the local assistant, the endpoint still pinned to the
> isolated loopback lab (`127.0.0.1:11435`), no implicit upload or training. The provider
> rules below stand as written and govern every configured cloud provider.

## Context

The Context Assistant must be useful without ever surprising the user about what leaves the device. Local-first is a technical requirement, not copy.

## Decisions

- **No provider by default.** The assistant panel runs a local deterministic fallback: summaries are assembled only from explicit evidence (last session review, resume snapshot handoff, open tasks) and labeled "Draft — generated locally, verify before using". The app never claims a cloud request succeeded when no provider is configured.
- **Explicit configuration + visible outbound contract.** Settings → AI providers states exactly what would leave the device (session titles, task names, handoff text — never clipboard, secrets or file contents unless explicitly included) before any first request.
- **Credentials in the OS secure store** (Tauri Stronghold on desktop). The database keeps metadata only (`hasCredential: boolean`). Browser mode reports the secure store as unavailable rather than storing keys insecurely.
- **Per-workspace disablement and redaction flags** (`disabledWorkspaceIds`, `redactPaths`, `redactSecrets`) live in the provider config schema so enforcement happens at request-assembly time, not in UI copy.
- **No implicit training/upload/sync.** There is no code path that transmits data without a configured provider and an explicit user action.
