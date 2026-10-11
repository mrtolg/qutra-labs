# Changelog

All notable changes to Qutra Labs (internal id: Qutra Labs) are documented here.

## Unreleased

### Changed

- User-facing product name is **Qutra Labs**; app icon installed from the
  supplied Q mark `.ico` (installer / favicon / Tauri icons).
- Reduced the product shell to nine top-level modules: Overview, Projects,
  Files, Tools, Security Lab, Terminal, GitHub, Assistant and System.
- Moved sessions, tasks, snapshots, resources and activity into project context.
- Moved scope, methodology, safe tool guides, runs, findings and evidence into
  Security Lab context.
- Replaced stale product routes with deterministic redirects to supported
  destinations.
- Added a version-12 migration that archives retired local collections, redacts
  secret-like values and normalizes persisted workbench state.
- Added an i18n usage gate and completed key parity across all six locales.
- Removed the unused editor-engine dependency family.
- Added packaged native smoke (`scripts/packaged-native-smoke.mjs`) and cleared
  clippy `-D warnings` blockers ahead of release gates.
- Added native Files path browsing, report/evidence SHA-256 digests, bounded
  report body persistence, and removed the unused Lab profile JSON parser option.

### Security

- Added native archive writing with payload limits, secret rejection and
  idempotent output.
- Preserved executable identity checks, argument-array execution, authorization
  scope enforcement, bounded output and process-tree cancellation.

## 0.1.0 - 2026-07-23

Initial Windows desktop foundation:

- Tauri 2, React 19, TypeScript and SQLite.
- Project sessions, snapshots and honest partial restore.
- Native window/monitor inspection and validated launching.
- Local tool registry and supervised process execution.
- Six locales, semantic themes and strict native capability boundaries.

[Unreleased]: https://example.invalid/Qutra Labs/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/Qutra Labs/releases/tag/v0.1.0
