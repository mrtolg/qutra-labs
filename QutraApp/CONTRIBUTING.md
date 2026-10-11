# Contributing to Qutra Labs

Thanks for your interest in improving Qutra Labs. This guide covers local
development, testing and the pull-request process.

## Prerequisites

- **Node.js** 20+ and npm 10+
- **Rust** stable (MSVC toolchain on Windows) via [rustup](https://rustup.rs)
- **Windows only:** Visual Studio Build Tools with the "Desktop development with
  C++" workload, and WebView2 runtime (preinstalled on Windows 11)

## Setup

```bash
npm ci
```

## Development

```bash
# Browser/demo mode — fast, no native toolchain required
npm run dev            # http://localhost:5174

# Desktop app (Tauri) — requires the Rust toolchain above
npm run tauri dev
```

The browser runtime uses a deterministic simulation of native capabilities and
`localStorage`; the desktop runtime uses real Rust commands and SQLite. Code
must never present a simulated capability as a real native success.

> **Note (non-ASCII build paths):** the Windows resource compiler (`rc.exe`)
> cannot handle a project path containing non-ASCII characters or quotes. If
> your checkout lives under such a path, build from an ASCII path (e.g. a
> directory junction) or set the icon override described in
> `docs/decisions/0002-storage.md`. See also `scripts/msvc-env.ps1`.

## Testing

```bash
npm run typecheck      # TypeScript project check
npm test               # Vitest unit + component tests
npm run test:e2e       # Playwright end-to-end + visual sweep
npm run gate           # typecheck, lint, unit, cargo, build, e2e
```

`QUTRA_E2E_PORT` (default `5174`) is the port Vite, Playwright, and `scripts/gate.ps1` share. `strictPort` stays on. When Vite listens it records its PID, port and start time in the git-ignored `.qutra-dev-server.json`. The gate stops a process on that port only when it matches that record, start time included, so a recycled PID is not ours; any other holder, whatever its command line says, is left running and the gate exits with an error that names the PID. A second checkout on the same machine sets a different value (for example `5184`). `src-tauri/tauri.conf.json` `devUrl` stays `http://localhost:5174`.

```bash
# Rust (from src-tauri/)
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

All of the above must pass before a PR is merged. New user-facing strings must
be added to **every** locale in `src/lib/i18n/*` — the key-parity test fails CI
otherwise.

## Coding conventions

- Organize by feature/domain (`src/features/*`, `src/domain/*`); keep domain
  logic free of UI imports.
- Validate at boundaries with zod; never store secrets in SQLite or frontend
  storage.
- Follow the existing design tokens and component vocabulary
  (`src/styles/*`, `DESIGN.md`). Keep letter-spacing at `0`.
- Rust: validate every IPC payload; use argument arrays, never shell strings.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; update `CHANGELOG.md` under `[Unreleased]`.
3. Ensure all tests, typecheck, lint, `cargo fmt`/`clippy`/`test` pass.
4. Describe what changed and how you verified it. Screenshots for UI changes.
5. Fill in the pull-request template.

By contributing you agree that your contributions are licensed under the
project's MIT License.
