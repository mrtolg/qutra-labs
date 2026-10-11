# ADR 0003 — Security boundaries

**Status:** accepted · 2026-07-23

## Decisions

1. **CSP:** `default-src 'self'; script-src 'self'; …` in both `index.html` and `tauri.conf.json`. No inline scripts (the theme pre-paint script is an external classic script); `connect-src` limited to self + Tauri IPC, making outbound network calls structurally impossible in the web layer.
2. **Tauri capabilities:** the main window gets `core:default`, `notification`, `clipboard-manager`, `dialog` (open) and `global-shortcut` only. No `fs`, no `shell`, no `opener` and no `sql`: the opener plugin opens any URL and the SQL plugin runs any statement and loads any database file, so addresses and paths go through `open_url_checked` and `open_path_checked`, and the document store through `storage_load` and `storage_apply_writes`. A Rust test (`the_window_holds_no_opener_or_sql_permission`) keeps it so. Anything touching files or processes must be a custom command that validates input and uses argument vectors, never concatenated shell strings.
3. **Rendering:** Markdown is parsed into React elements (`src/components/ui/Markdown.tsx`) — no `dangerouslySetInnerHTML` anywhere in the codebase; external links get `rel="noopener noreferrer"`; remote HTML is never rendered in privileged contexts.
4. **Secrets:** never in SQLite/localStorage. `AiProviderConfig` stores only `hasCredential`. Clipboard capture runs conservative local secret detection (opt-out-able, documented as imperfect). Diagnostics export redacts secrets and user paths (`redactForDiagnostics`).
5. **Automations:** arbitrary shell execution is off by default; `run_command` is recorded as requiring the desktop app + per-workspace allowlist + confirmation, and is never constructed from untrusted text.
6. **Elevation:** elevated windows are reported as `permission_required` during restore; the app never auto-elevates (UIPI lesson captured in the demo Error Atlas entry).
