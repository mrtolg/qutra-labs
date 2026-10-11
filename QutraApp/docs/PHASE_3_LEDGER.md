# Qutra Labs Phase 3 Ledger

**Branch:** `phase-3-personal-lab`

This ledger records the current simplified product, not superseded expansion
plans.

## Verified Foundations

- Nine-module workbench navigation and persistent tabs.
- Six-locale parity, terminology checks and source-usage gate.
- Versioned document migrations with a native SQLite mirror.
- Windows executable registration, identity verification and native supervisor.
- Engagement scope enforcement and target normalization.
- Run state, bounded output, cancellation, timeout and artifact retention.
- SARIF and Nmap parsers with normalized finding provenance.
- Safe tool catalog and contextual usage guides.

## Release Gates

Verified 2026-07-25 from ASCII build tree `C:\cxbuild-j` (unsigned artifacts;
the tree was archived on 2026-09-30 to `D:\QutraLabs-archive\2026-09-30\cxbuild-j`):

1. Cache-free TypeScript check.
2. Vitest unit/component suite.
3. Playwright end-to-end and visual suite.
4. Production web build.
5. Rust tests from an ASCII-only path.
6. Tauri installer build.
7. Packaged-app launch and navigation smoke test.
8. Clean `git diff --check` and executable hash report.

Packaged native fixture run also succeeded (`scripts/packaged-native-smoke.mjs`).
Artifact hashes and the unsigned note live under
`D:\QutraLabs-archive\2026-09-30\cxbuild-j\release-artifacts\j-packaged-2026-07-25\`
(outside the repo; all 579 archived files matched the source by path, length
and SHA-256 on 2026-09-30).

## Deferred

- Code signing requires a trusted signing certificate.
- Real GitHub provider use requires operator configuration.
- Additional parsers require fixtures and provenance tests before shipping.
- Full page/a11y/l10n polish and private tool inventory.
- Cloud AI providers and Jarvis Instagram remain separate decisions/projects.
