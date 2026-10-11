# ADR 0007 — Private Cyber Lab (Tools Host)

**Status:** accepted · 2026-07-23 (Phase 2) · amended 2026-07-27 (consent boundary)

## Context

The roadmap defines a 30-tool defensive, local-only "Private Cyber Lab." A hidden
menu or `.gitignore` rule is **not** a security boundary. The public repo must
contain only a generic, safe host — never private tool implementations, reports,
captures or samples.

## Decision

1. **Disabled by default, and enforced natively.** The lab is gated behind an
   explicit local opt-in (`privateToolsEnabled`, default false). The enable
   screen states the local-only, defensive, authorization-bound scope.

   The gate is applied **in-page on every surface that reaches the tool host** —
   Tools, Terminal, the workbench Bottom Panel, **and the Security Lab `tools`
   view (`ToolLabPanel`)** — and, decisively, **at the native command boundary**
   in Rust (`src-tauri/src/consent.rs`).

   Two corrections to earlier wording are deliberate:

   - The nav items are **always listed**; they are not hidden until opt-in.
     Hiding a link was never the boundary, and describing it as one overstated
     the guarantee. The gate lives on the destination, not the menu.
   - The renderer-side preference **authorizes nothing on its own**. It lives in
     the document store, which is reachable from the webview, so anything that
     reaches the webview — a `/lab?view=tools` deep link, a restored tab, a
     refresh, a bug in a route guard — could otherwise drive real executables
     for a user who never opted in. Consent is therefore owned by the native
     core: persisted by Rust, fail-closed on a fresh or unreadable profile, and
     re-checked by **every** tool command (inspect, register, list, get,
     reverify, enable, remove, start, cancel, list runs, delete artifacts).

   Enumeration and registration are gated alongside execution: which tools are
   installed is itself information the user opts into exposing, and a
   registration performed while denied would leave a primed surface for the
   moment consent is granted. `emergency_stop_tool_runs` is the one deliberate
   exception — it can only ever stop processes, never start one, so gating it
   behind a permission the user just withdrew would strand live runs with no way
   to halt them.

   Revoking consent takes effect immediately: the native subscription is torn
   down and native-derived records are dropped from memory, rather than lingering
   until the next restart.
2. **Only the generic host is public.** This repo ships: the catalog/registry
   (`domain/tools/registry.ts`), the built-in **offline** utilities (encoding,
   hash, JWT, regex, entropy/file-signature — legitimate local app features), the
   subprocess-supervision **policy**, and honest adapter states. Real external-tool
   implementations, outputs, reports, histories and samples live **outside** the
   repo (a sibling private dir / per-user app-data) and are never committed.
3. **Subprocess supervision policy** (`domain/tools/supervisor.ts`, fully tested):
   reviewed **executable allowlist**, **fixed subcommands**, **validated argument
   arrays** (shell metacharacters and path traversal rejected — never a shell
   string), **target-scope checks** (loopback/private allowed; public requires
   explicit consent), timeouts + output limits in the manifest, and **redaction**
   of tokens/emails/home-paths/hashes in audit + results. A global **emergency
   stop** blocks runs.
4. **Honest tool status.** Each of the 30 entries is `builtin-working`,
   `builtin-planned`, or `external-adapter`. Adapters **detect** an installed
   official tool and link to its official install page — the app never bundles or
   silently downloads third-party security tools. A "Run" button never fakes
   execution.
5. **Native tool supervisor (implemented).** External tools run through the
   Tauri `ToolSupervisor` (register / identity / argv arrays / scope /
   timeout / cancellation). Browser and demo modes never fake a native success.
   Third-party binaries and private outputs still stay outside the public repo.

## Consequences

- Built-in offline tools are functional and unit-tested today.
- The security boundary (injection, traversal, scope, redaction, delete-all) is
  proven in tests independent of any installed tool.
- No prohibited stealth/theft/evasion/destructive/arbitrary-shell capability
  exists anywhere in the host.
- Consent is covered by regression tests at both layers: `consent::tests` in
  `src-tauri/src/consent.rs` (fail-closed default, persistence across restart,
  idempotent revoke, malformed marker reads as denied) and the deep-link tests
  in `e2e/lab.spec.ts`, which assert both that the gate closes without consent
  and that it opens once granted — a gate that never opened would satisfy the
  first assertion for the wrong reason.
- The consent decision is a native artifact (`private-tools-consent` under the
  app data directory), so clearing browser/document state does not silently
  grant it, and copying a profile does not carry it implicitly.

**Amendment 2026-09-30.** See ADR 0014. A grant requires the native confirmation. The preference does not grant.
