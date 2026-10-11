# Security review, 364f381..fc10c2b (2026-09-30)

Review of the HUD re-skin and the readiness work against `fc10c2b`. Every cited path:line was resolved with
`git show fc10c2b:./<path>`. All nine findings hold. The summary below comes
first; the full report follows.

## Summary

| # | Finding | Holds? | Note | Where it goes |
|---|---|---|---|---|
| 1 | Cloud refusal trusts the listener; "no data leaves this computer" is unsupported | Yes | `ollama.rs:273-276` `#[serde(default)]` → empty strings → accepted at `:244`; `en.ts:1190` text confirmed | Readiness fixes (copy + ADR 0010) before it is committed |
| — | health → next-turn endpoint Medium; the planned endpoint disclosure is not enough | Yes | health `commands.rs:120`, turn `:620` select independently | Readiness fixes: disclose the endpoint the turn actually used |
| 2 | Enabled Assistant view loses the readiness panel | Yes | `LocalAssistantChat.tsx:396-414`: readiness only inside `AssistantSetup`; chat branch has none | Readiness fixes (same files are already in the diff) |
| 3 | Readiness merges two endpoint reports; `selectedTools: null` can be all-green | Yes | `AssistantReadiness.tsx:182`: `selectedTools !== false` lets `null` pass when `anyTools` | Readiness fixes |
| 4 | White on `--danger` fails AA in hud dark / HC dark | Yes | `lab.css:159` `color: #fff` on `var(--danger)`; hud dark `--danger` L≈0.70 | HUD re-skin follow-up |
| 5 | Reduced motion leaves movement | Yes, with one precision | OS `prefers-reduced-motion` does set `scroll-behavior: auto` (`base.css:182`); the **app setting** (`:197-201`) does not. The width transition (`components.css:706`) survives both | HUD re-skin follow-up |
| 6 | Shell chain outside tool identity | Yes (Minor) | `terminal/mod.rs:116-118` PATH walk, `:159-160` COMSPEC verbatim | ADR note (ADR 0014) |
| 7 | Hex in `GitHubPage.tsx:626` | Yes | GitHub language colours — decision pending: approved exception or tokens | HUD re-skin follow-up or exception note in DESIGN.md |
| 8 | Removed test not named in `414c8a8` body | Yes | Pushed commit, cannot be amended; record it | evidence-log correction |
| 9 | The evidence log (line 345) says "The exe is the 16b8987 tree" contradicted by `218cdef`; shortcut target unchecked (`install-local.ps1:124-127`) | Yes | | evidence-log correction + install script check |

Readiness exit: **not done** — the native clean-profile onboarding turn and the
60-second measurement are missing; they can only be run on the real
machine. HUD re-skin: **not done** — #4, #5, #7.

---

## Report

Reviewed committed 364f381 (e2ba3a2^) through HEAD fc10c2b. Runtime results below are recorded evidence, not newly executed checks.

### Critical
Nothing Critical found. I did not demonstrate model output directly executing an unapproved native action.

### Important
1. **Cloud refusal trusts the party whose honesty the threat model explicitly excludes (TM-004).** At fc10c2b, `ollama.rs:244` accepts the listener when its /api/show response omits remote_host and remote_model; both default to empty strings at `ollama.rs:273`. A process occupying 11434 can advertise the requested model, omit those fields, receive prompts/history/context, and forward them elsewhere. The closed destination set and redirect refusal constrain Qutra's requests, not the listener's subsequent traffic. The app also trusts its reported catalog, capabilities, answers and proposals; native tool execution remains separately gated. Consequently, `en.ts:1190`'s unconditional privacy promise and ADR 0010:258's justification are unsupported. The planned replacement wording misses this: it retains the same promise (copy audit:696). *Harmless only if:* the listener is independently trusted to perform local inference and report honestly. The threat model (TM-004) explicitly permits an arbitrary local impostor.
2. **The Assistant loses its repair instructions immediately after consent.** At fc10c2b, `LocalAssistantChat.tsx:396` renders setup while disabled or awaiting Private Lab consent. Once those decisions finish, it renders chat without AssistantReadiness. Answer-only enablement therefore removes setup before its enabled health check can provide a result; accepting or declining the second consent also removes the panel. The remaining model picker reports unreachability without the readiness panel's start/pull instructions or retry control. This defeats the ordinary clean-profile recovery path without opening Settings. *Harmless only if:* Ollama and the requested model are already ready before consent finishes, or readiness remains accessible in the enabled Assistant view.
3. **Readiness combines separate endpoint reports and can hide an unknown selected capability.** At fc10c2b, `AssistantReadiness.tsx:156` independently fetches models. Rust independently selects their endpoint at `commands.rs:234`. The panel ignores that report's endpoint and does not refresh the catalog when the health endpoint changes. Thus capabilities from 11434 can appear beneath health information naming 11435. Another missed case at `AssistantReadiness.tsx:182`: selected model tools: null, another model tools: true, and ready health makes allGreen true. The selected model's uncertainty disappears. *Harmless only if:* both reports concern the same current endpoint/catalog and the selected model's capability is affirmatively known.
4. **The theme passes its narrow contrast tests while rendered Lab text fails AA.** At fc10c2b, `lab.css:159` puts small white text on --danger. Static calculation: HUD dark 2.95:1 (fails) · HUD light 6.59:1 · High contrast dark 2.56:1 (fails) · High contrast light 8.55:1. Small text requires 4.5:1. The badge is rendered by `labViews.tsx:410`. `theme.contrast.test.ts:49` checks only selected token pairs. `accessibility.spec.ts:27` scans only Home, using tags through WCAG 2.1. It establishes neither every-route AA nor keyboard focus visibility across the requested modes.
5. **Reduced motion still permits movement.** `base.css:197` disables animations for the app preference but leaves smooth scrolling enabled in `workbench.css:217`. Changing the active working tab invokes scrollIntoView at `WorkspaceTabs.tsx:302`, so overflowing tabs still scroll smoothly. Both reduced-motion mechanisms also leave the 200 ms width transition at `components.css:706`, used by Restore progress.

The already-known health → next-turn Medium: The planned endpoint disclosure is not enough. Health selects at `commands.rs:120`; each turn selects again through `commands.rs:620`. Returning selected.origin fixes concurrent slot readback, but the next turn can still choose a newly available 11434 after health named 11435. The actual turn binding needs disclosure and explicit treatment of recipient changes.

### Minor
6. **Shell resolution sits outside the registered-tool identity guarantee.** `terminal/mod.rs:116` searches inherited PATH, then returns a bare executable name; the fallback accepts inherited COMSPEC verbatim at `terminal/mod.rs:159`, without verifying existence, canonical identity or hash. Registered launch_tool still resolves an installation ID at `tools.rs:599`. Not a demonstrated privilege escalation.
7. **The global tokens-only constraint remains unmet.** `GitHubPage.tsx:626` retains nine component-level hex colors (they predate the HUD re-skin).
8. **A removed standalone test lacks the requested named reason.** `the_capabilities_probe_stays_on_the_pinned_origin` (ollama.rs:355 at 364f381) removed by 414c8a8, folded into broader coverage at ollama.rs:499; the commit body does not name it.
9. **Install evidence overstates what was proved.** The evidence log (line 345) still states the installed executable was the 16b8987 tree; 218cdef records that this installation used the previous day's build. The script now follows CARGO_TARGET_DIR, rejects old timestamps and compares normalized hashes, but proves matching artifacts, not source provenance; `install-local.ps1:125` checks shortcut existence, not its destination.

Entry-chunk budget passes: 169,128 (HUD re-skin) and 171,241 (readiness work) against 204,800 (evidence log, line 395).

| Inventory | 364f381 | fc10c2b |
|---|---|---|
| Rust #[test] | 140 | 150 |
| Rust #[tokio::test] | 26 | 29 |
| Ignored Rust tests | 5 | 5 |
| Active Rust tests | 161 | 174 |
| Unit lexical it(/test( | 513 | 531 |
| E2E lexical tests | 45 | 45 |
| Recorded unit / E2E totals | 541 / 66 | 568 / 68 |

| Acceptance criterion | Status |
|---|---|
| Cold clean-profile launch < 60 s without Settings | Unmeasured (evidence log, line 412) |
| Primary action identifiable in 5 s on four surfaces | No recorded demonstration |
| Chrome 5→3; Home running session + pending approval | Deferred |
| No tab truncation at 1280; palette reaches every destination; keyboard-operable | Partial |
| Every empty state offers an action | No complete evidence table |
| Consent yields a working assistant turn | Native onboarding turn missing |
| Twelve dead routes removed | Demonstrated |
| Six locales and regression gates | Supported, except #8 |
| Every-route WCAG 2.2 AA, native manual checks | Incomplete; contrast failure demonstrated |

**Is the readiness work done?** No — native and timing evidence missing; onboarding loses readiness recovery.
**Is the HUD re-skin done?** No — contrast, reduced motion, tokens-only unmet.
