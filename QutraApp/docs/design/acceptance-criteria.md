# Definition of Usable

This is the acceptance contract for the stabilization work. A phase is not done because its commits landed. It is done when these are demonstrated, with the evidence recorded in a log kept next to the release checklist.

The standard is *"we cannot manage it."* Every test below is a direct answer to that.

## The sixty-second test

From a **cold launch on a clean profile**, a person who has never seen the app:

1. reaches a live shell **or** a screen naming the exact missing piece and the one button that fixes it — **under 60 seconds**;
2. never opens Settings to get there;
3. is never shown an error whose remedy is a noun rather than an action.

Record the actual time. If it is 90 seconds, write 90.

## The five-second test

On every surface, a first-time viewer names the primary action within five seconds. Run this on Home, Work, Assistant and Lab. If a surface fails, its hierarchy is wrong — not its colours.

## Measurable gates

| # | Gate | How it is measured |
|---|---|---|
| 1 | Chrome regions reduced 5 → 3 | Count them in the rendered DOM |
| 2 | Tab strip never truncates at 1280px | E2E assertion, not a screenshot glance |
| 3 | Palette reaches 100% of routes, Lab views, Settings sections and registered tools | A test enumerating routes and asserting each is palette-reachable |
| 4 | Zero mouse-only paths | Keyboard traversal of every primary action |
| 5 | Home renders live state, never a greeting | E2E: seed a running session and a pending approval, assert both appear |
| 6 | Every empty state offers an action | Audit list in the evidence log, one row per empty state |
| 7 | One consent decision, not four | E2E: from a clean profile, one decision yields a working assistant turn |
| 8 | Twelve dead routes gone | `router.tsx` diff |

## The gate that never moves

Every one of these stays green. Stabilization that breaks the engine is not stabilization.

```
npm run typecheck
npm test
npm run test:e2e
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Baseline before the stabilization work (tag `pre-rescue-baseline`): typecheck clean, **471** unit across 66 files, **159** cargo plus 5 ignored live-endpoint tests, **66** e2e, warning-free build.

Test counts may rise. **They may not fall without a written reason** in the commit body naming which test was deleted and why it no longer describes real behaviour. "The shell changed" is not a reason to delete a test that asserts a capability — it is a reason to update its selector.

Additionally, because this is going to be a product:

- The axe suite stays green on every route. **Note:** axe passing is not proof of a working keyboard path — the skip-link destroys the hash route (`AppShell.tsx:33`) and axe never noticed.
- Every new string exists in all six locales.

**Corrected 2026-09-15.** This section previously asserted that `cargo fmt`, `clippy -D warnings` and `npm run lint --max-warnings 0` "stay clean." Measured on that date, **they are red today** — see the baseline measurements:

- `cargo fmt --all --check` — 6 files dirty (style only)
- `clippy` — `manual_contains` at `assistant/commands.rs:107`; `assertions_on_constants` at `:874` and `:1074`
- `npm run lint` — 2 unused `eslint-disable` directives

These are a **release exit criterion**, not a standing property. They must be green before the project is called shippable, and they must not be silently formatted away into the baseline — the red state is the honest starting point.

## What cannot be traded away

No amount of usability improvement justifies breaking these. They are listed in `shell-spec.md` §7 with the reasoning:

1. The honest runtime boundary — browser mode never fakes native success.
2. The approval gate — the model proposes, the human approves, Rust enforces.
3. Tool identity — the renderer passes an installation id, never a path.
4. Secrets stay behind the Rust broker.
5. Six locales.
6. WCAG 2.2 AA.

## Manual verification that cannot be automated

The native GUI cannot be automated. These stay manual checks, and the work is not finished until they are run and reported:

1. `npm run tauri dev` — the terminal opens a live shell, echoes input, resizes, multiple tabs work, Stop-all kills them all.
2. Register `notepad.exe` as `gui` — Launch opens it detached. Register `cmd.exe` as `interactive` **via the file picker, not by typing a bare name** — Launch opens a Work tab. A batch tool still runs supervised.
3. Overwrite a registered binary without pressing "Check identity" — Launch refuses, in translated copy.
4. With the assistant enabled: ask for a `terminal_run`, confirm **one** tab appears, then ask for a second command in the same session and confirm you still have **one** tab.
5. Read an approval card without looking at the registry. Can you tell what it will launch?
6. The four theme presets, in both light and dark, with Mica and Acrylic on and off.

## The question that decides everything

Once the stabilization work and the new shell land, one question decides:

> **Would you open this tomorrow morning to do real work?**

If the answer is no, the work has not succeeded, regardless of what the gates say. Ask it explicitly and record the answer.
