# ADR 0005 — OS-backed secure storage for secrets

**Status:** accepted · 2026-07-23 (Phase 2)

## Context

Phase 2 introduces optional GitHub integration, which requires holding an access
token. ADR 0003 already forbids secrets in SQLite, localStorage, logs, diagnostics
and exports. We need a real place to keep the token that satisfies that rule.

## Decision

1. **Backend:** secrets live only in the **OS credential store** — Windows
   Credential Manager, reached through the `keyring` crate (`windows-native`
   feature). The roadmap says "Tauri Stronghold **or** the OS credential store";
   the OS store was chosen over bundling `iota-stronghold` because it is the
   platform-native mechanism, needs no user-managed vault password, and keeps the
   native binary lean. The trust boundary (a validated Rust command, secrets never
   in the document store) is identical either way.
2. **Bridge shape:** a `SecureStore` interface on `DesktopBridge` with
   `set/get/has/delete` and `available()`. The native bridge calls the
   `secure_set/get/has/delete` commands; the browser/demo bridge is honestly
   **unavailable** and never writes a secret to localStorage.
3. **Key namespace:** keys are internal identifiers validated to
   `^[a-z0-9_.:-]{1,128}$` (e.g. `github.token`) — never user free-text — so a key
   can never smuggle structure into the OS store. Service name:
   `app.contextos.desktop`.
4. **Redaction:** secret values are write-only from the UI's perspective and never
   appear in a `Result::Err`. `keyring` errors are mapped to fixed codes
   (`no_entry`, `platform_failure`, …). `delete` is idempotent so
   revoke/disconnect/delete-all are safe.

## Consequences

- GitHub token storage (Phase 3) has a real, testable home.
- Pure logic (key/value validation, redaction) is unit-tested in `src/secure.rs`
  and verified independently of the OS store.
- The `secureStore` capability flips from `not_implemented` to real in the native
  build; the browser build stays honestly unavailable.

## Update, 2026-10-09: write-only is enforced

Spec 2026-10-07 §6.4 S2 and §7.4. "Write-only from the UI's perspective" used to be a convention; the page could still call `secure_get`. Now it is enforced:

- **`secure_get` is no longer a command.**
  - Rust reads secrets through `secure::read_secret`.
  - The GitHub broker reads the token for each request itself, and the device flow stores the token without it ever reaching the page.
  - The `SecureStore` interface has no `get`.
- **The generic commands accept only the GitHub token.** `secure_set`, `secure_has` and `secure_delete` take only the keys in `RENDERER_KEYS` (`github.token`); any other key is refused with `key_not_allowed`.
- **AI keys have their own commands** (`src-tauri/src/ai/keys.rs`):
  - The keys are `ai.anthropic.key` and `ai.openai_compat.<preset>.key`.
  - The commands are `ai_key_set`, `ai_key_has` and `ai_key_delete`. `ai_key_has` returns `{ present, last4, baseUrl }`, and no command returns a key.
  - Each key is stored together with the address it may be sent to. A fixed preset always uses Rust's own address. A custom address is validated when the key is saved and again when it is used.
  - The AI client follows no redirects, so a key header cannot reach another host.