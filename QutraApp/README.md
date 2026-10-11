# Qutra Labs

Qutra Labs is a Windows-first, local operations workbench for developers and
authorized security practitioners. It combines project continuity, local files,
verified tools, terminal diagnostics, GitHub context and a scope-gated Security
Lab in one native desktop application.

**UI languages:** English, Türkçe, Deutsch, Español, Français and Italiano.

## Product Modules

Qutra Labs intentionally exposes exactly nine top-level modules:

1. Overview
2. Projects
3. Files
4. Tools
5. Security Lab
6. Terminal
7. GitHub
8. Assistant
9. System

Project tasks, sessions, snapshots, resources and activity stay inside Projects.
Lab scope, methodology, guides, runs, findings and evidence stay inside Security
Lab.

## Highlights

- **Native Windows workbench:** Tauri 2 window with real SQLite persistence and
  persistent working tabs.
- **Verified local tools:** canonical executable identity, SHA-256, Authenticode
  state, change detection and explicit trust renewal.
- **Native supervisor:** argument-array execution, bounded output, cancellation,
  timeout, process-tree cleanup, artifact persistence and emergency stop.
- **Authorization-first Security Lab:** explicit engagements, scope decisions,
  targets, run provenance, SARIF/Nmap parsing, findings and evidence.
- **Safe tool guides:** local catalog, installation status, starter workflows,
  expected output, safety boundaries and acquisition tasks.
- **Optional GitHub:** read-only profile/repository context with credentials kept
  outside frontend storage.
- **Honest runtime boundary:** browser mode is deterministic and reports native
  actions as unavailable; it never simulates a successful native run.

## Prerequisites

- Node.js 20+ and npm 10+
- Rust stable with the MSVC toolchain
- Visual Studio Build Tools, "Desktop development with C++"
- Microsoft Edge WebView2 Runtime

## Development

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run tauri dev
npm run tauri build
```

The Vite server at `http://localhost:5174` is for development and automated
tests. End users run the packaged Windows application.

## Architecture

React 19, TypeScript and Vite provide the UI. Domain logic lives under
`src/domain`, product features under `src/features`, and local persistence under
`src/lib/db`. Desktop capabilities cross a typed `DesktopBridge`; Rust validates
native IPC and supervises approved executables. Tauri SQL migrations mirror the
application schema versions.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/decisions](docs/decisions).

## Privacy and Safety

- Local-first; no account or telemetry is required.
- Secrets never belong in frontend storage, logs or exports.
- Tool execution requires a registered executable and validated arguments.
- Public targets require an acknowledged authorization scope.
- Output and artifacts remain attributable to their run, target, engagement and
  finding.
- Scope-simplification migration v12 archives retired local collections before
  removing them from the active store.
- Complete local deletion requires typed confirmation.

## Verification

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

On Windows, native builds should use an ASCII-only junction when the repository
path contains non-ASCII characters or quotes.

## License

MIT. Copyright (c) 2026 Mert Olgun.

Designed and developed by **Mert Olgun**.
