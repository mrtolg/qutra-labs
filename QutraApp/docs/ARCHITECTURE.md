# Qutra Labs Architecture

## Layers

```
UI (src/features/*, src/app, src/components)
        │  React 19, feature-per-folder, lazy routes
Service (src/services/appService.ts)
        │  multi-collection workflows, activity events, automation firing
Domain (src/domain/*)
        │  pure logic: privacy, search ranking, insights, automations,
        │  error fingerprinting, seed. Fully unit-tested, no UI imports.
Data   (src/lib/db)
        │  zod-validated document store, versioned migrations,
        │  schema-versioned export/import, demo flagging
Bridge (src/lib/bridge)  ←  trust boundary
        │  DesktopBridge interface + capability detection
        ├─ BrowserBridge: deterministic simulation, always `simulated: true`
        └─ Tauri commands (src-tauri): validated IPC, narrow capabilities
```

## Key decisions (full ADRs in docs/decisions)

1. **Desktop bridge boundary** — product logic never touches OS APIs directly; capabilities are typed and honest (`available`, `simulated`, `reason`), so the UI can label simulated behavior instead of faking success.
2. **Storage** — one document model validated by zod on every read/write. Browser mode: localStorage per collection with a migration runner. Desktop: SQLite through the official Tauri SQL plugin with mirrored SQL migrations (FKs, indexes, FTS5 for notes).
3. **Security boundaries** — strict CSP (`script-src 'self'`), no shell strings, allowlisted commands only, narrow Tauri capabilities (no fs/shell permissions), markdown rendered by building React elements (no innerHTML anywhere).
4. **AI privacy** — provider off by default; local deterministic fallback assembles summaries from explicit evidence only; credentials are Stronghold-only metadata in the DB (`hasCredential: boolean`).

## State

- Persistent: `Database` singleton + `useSyncExternalStore` bindings (`useCollection`, `usePreferences`). Every mutation re-validates and persists synchronously; CRUD therefore survives reload by construction.
- Transient UI: one small zustand store (palette/quick-capture/inspector/toasts/live-region).

## Events & automations

Meaningful actions call `recordEvent()`, which appends an `ActivityEvent` (timeline, insights) and fires matching automations through the engine (condition matching, per-hour rate limit, run log). Automation actions execute via explicit executors — `run_command`/`webhook` are recorded but require the desktop app + per-workspace allowlist.

## Performance

Lazy-loaded routes (every screen is its own chunk; initial JS ≈ 143 kB gz), debounced note autosave, deterministic restore steps batched by timers, memoized aggregations. Search is in-memory over ranked docs and feels instant on the demo dataset; the SQLite path adds FTS5 + indexes for large datasets.

## Error recovery

Route-level ErrorBoundary (plain language + expandable copyable diagnostics), zod boundary drops corrupt rows instead of failing the whole store, migration runner is idempotent, full export exists precisely so recovery guidance ("export a backup, then recover") is real.
