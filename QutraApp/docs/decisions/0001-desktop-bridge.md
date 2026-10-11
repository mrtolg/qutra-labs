# ADR 0001 — DesktopBridge as the only OS boundary

**Status:** accepted · 2026-07-23

## Context

Qutra Labs must run identically as a Tauri desktop app and as a browser demo (development, tests, screenshots, CI). Native capabilities (window enumeration, launching apps, clipboard watching) don't exist in the browser, and pretending they do would violate the product's honesty requirement.

## Decision

All OS integration goes through one interface, `DesktopBridge` (`src/lib/bridge/types.ts`), with:

- `capabilities()` returning `{ available, simulated, reason }` per capability;
- a deterministic `BrowserBridge` (seeded per-item timing/outcomes so Playwright runs are reproducible);
- Tauri commands implementing the same surface behind validated IPC.

The UI must check capabilities and label simulated behavior (e.g. the restore dialog's "Browser demo mode: restore is simulated" banner, `RestoreRun.simulated`).

Runtime selection is centralized in `src/lib/runtime.ts` (one `__TAURI_INTERNALS__` check) so the storage backend and the bridge can never disagree. `getBridge()` returns `TauriBridge` under Tauri and `BrowserBridge` in the browser; `preloadTauriBridge()` registers the native module during desktop boot so sync UI code can construct it.

## Status of implementation (0.1.0)

`TauriBridge` is real: `list_running_apps`, `list_monitors`, `restore_item`, `open_url_checked`, `open_path_checked` call validated Rust commands and scoped official plugins (opener, notification, clipboard-manager, global-shortcut). Capabilities report `simulated: false`; `gitInspection` and `secureStore` report `not_implemented` honestly. Verified by launching the release `.exe`, which opens a real window and creates a real SQLite database.

## Consequences

+ UI, tests and screenshots run without native APIs; the restore state machine is testable with fake timers.
+ Native capabilities land command-by-command without UI changes.
− Two implementations to keep in sync; mitigated by shared types, the capability contract, and the `selection.test.ts` contract test that proves the two cannot be confused.
