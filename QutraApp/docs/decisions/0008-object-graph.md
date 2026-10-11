# ADR 0008 — Context Object Graph

**Status:** accepted · 2026-07-23 (Phase 3)

## Context

Phase 3 requires Qutra Labs to stop behaving as a set of isolated mini-apps and
become one system in which notes, tasks, files, mail, GitHub records, security
tools, tool runs, targets, findings, evidence and reports share stable IDs and
**typed relationships** (§2.1, §3). Backlinks, provenance, deep links and
cross-type search all depend on a single relationship layer. Phase 2 stored each
collection independently with no first-class edge between objects.

## Decision

1. **Objects are referenced, not embedded.** A relationship is a directed edge
   `(kind, fromType, fromId) → (toType, toId)`. The graph never copies object
   bodies, so a new object family (e.g. `finding`, `mailMessage`) joins the graph
   with **no data migration** — only a new value in the `ObjectType` enum.
2. **One `links` collection.** The edge lives in the existing generic document
   store (`collectionSchemas.links`, validated by `ObjectLinkSchema`). On SQLite
   it reuses the generic `records(collection, id, data)` table, so migration v3 is
   a version marker, not DDL (`0003_object_graph.sql`, mirrored in the TS
   migration set and registered in `src-tauri/src/lib.rs`).
3. **Typed edge vocabulary with display inverses.** Eleven kinds
   (`belongs_to`, `references`, `generated_by`, `affects`, `evidenced_by`,
   `remediates`, `derived_from`, `related_to`, `blocks`, `duplicates`,
   `supersedes`) each carry a label inverse (`blocks` ⇄ `blocked_by`, …). Backlinks
   are rendered from the target's perspective using that inverse. `related_to` is
   symmetric: its endpoints are normalized so the edge is stored once and shows on
   both objects.
4. **Deterministic dedupe.** `canonicalLinkKey` gives each edge a stable identity
   from its kind and endpoints; `upsertLink` collapses re-asserted edges (from a
   user action or an importer) and preserves the original edge id.
5. **Integrity by construction.** `makeLink` rejects self-loops; deleting an object
   calls `removeObjectLinks` to drop every dangling edge on either endpoint.
6. **Inline mentions feed the graph.** `parseMentions` extracts `[[wiki]]`
   (with optional `|alias`) and `@handle` tokens from note/block bodies without
   executing content, so the forthcoming block editor (§6.1) can materialize
   `references` edges from prose.

## Consequences

- Backlinks, local-graph neighbors and cross-type relationships are available to
  every current and future object family through one tested module
  (`src/domain/graph.ts`, `graph.test.ts` — 19 tests).
- Adding the remaining Phase 3 object families is additive (enum + schema),
  keeping the migration surface small.
- The edge store is provenance-aware (`user | import | automation | system`) so
  imported and automated relationships remain distinguishable from user intent.

## Not yet done (tracked in the Phase 3 ledger)

- UI surfaces (backlink panel, local/global graph view) that read this layer.
- Auto-materialization of `references` edges from editor mentions on save.
- Cross-type search ranking that folds relationship counts into results.
