# ADR 0002 — Zod-validated document store; SQLite on desktop, localStorage in demo

**Status:** accepted · 2026-07-23

## Context

The spec requires SQLite with versioned migrations on desktop, plus a browser mode where CRUD persists through reload. Duplicating a full SQL engine in the browser (sql.js/WASM) adds ~1 MB and async complexity without helping the demo goal.

## Decision

- One document model per collection, typed and validated by zod at every read/write (`src/lib/db/database.ts`). Invalid rows are dropped on load, never crash the store.
- Browser/demo: one localStorage document per collection under `contextos.v1.*`, with a sequential migration runner (`migrations.ts`) and `schemaVersion` metadata.
- Desktop: SQLite via the official Tauri SQL plugin. `SqliteAdapter` (`src/lib/db/sqliteAdapter.ts`) opens the DB during boot, runs the plugin's native migrations, mirrors all rows into memory (keeping the synchronous `useSyncExternalStore` UI contract), and write-throughs asynchronously via a serialized queue. Records live one-per-row in `records(collection, id, data)` (real indexes + notes FTS5 via triggers); `preferences`/`meta` live in `kv`. `main.tsx` awaits `initDb()` behind a boot/recovery screen so React never races the database.
- `src-tauri/migrations/*.sql` and the JS migration list share version numbers and move together — enforced by convention and the migration test.
- Export/import is schema-versioned JSON; demo records carry `demo: true` for clean removal. Complete deletion clears collections and wipes storage keys.
- **Secrets** (AI provider credentials) never touch SQLite or localStorage — only `hasCredential` metadata is stored; the credential itself belongs in Stronghold/OS secure storage.

## Status of implementation (0.1.0)

Verified: launching the release `.exe` creates `%APPDATA%\app.contextos.desktop\contextos.db` containing `_sqlx_migrations`, `records`, `kv` (with `meta` schemaVersion 2 and `preferences`) and the `notes_fts` tables — proving the desktop runtime persists through real SQLite, not localStorage.

## Consequences

+ Synchronous reads keep the UI simple and fast; reload-persistence is guaranteed by construction.
− Browser mode has no real FTS; in-memory ranking covers the demo dataset, SQLite FTS5 covers scale.
− Two migration lists; the version numbers are shared and tested.

## Note on dropped dependencies

`recharts` and `react-hook-form` were removed: the two shipped charts are single-series accessible bars with table alternatives (a chart library added weight without benefit), and forms are plain labeled controls with explicit validation. Revisit if chart complexity grows.
