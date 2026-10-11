# Canvas data contracts — options analysis (2026-09-28)

Against commit `4f2b5d2`. The verification notes come first; the analysis
follows below them.

## Verification notes

**Verified against `4f2b5d2`:** the broker holds one pending call
(`broker.rs:324-326`); `summary_for_approval` resolves the launch display
name through the same gate as `resolve_launchable` (`tools.rs:243`,
`tool_supervisor.rs:386`), so "Verified · SHA-256" is honest for
`launch_tool` only; batch runs validate a caller-supplied scope
(`tool_supervisor.rs:1161`), and nothing assesses a shell command's scope;
`process_is_elevated` answers "elevated" when it cannot query
(`winapi.rs:79-84`); `cyberchef` names a built-in transform workbench in
`domain/tools/registry.ts` and the CyberChef tool in
`features/lab/toolCatalog.ts:266`; scrollback is capped at 256 KiB
(`terminal/mod.rs:34`); `resetConversation` is the erase path
(`LocalAssistantChat.tsx:366`); an agent may only write to sessions it
opened (`tools.rs:586`).

**Accepted.** The recommendations fit `DESIGN.md`'s "rich and real" rule and
the honest-runtime invariant. One refinement: where the analysis says "an
indeterminate indicator" for running tools, the motion rule in `DESIGN.md`
applies — it is a static indicator; a running tool does not block the user, so
it does not loop.

---

## Recommended direction

Use Rust-owned live facts, shared renderer projections, and document-store history. Keep the existing retained Terminal and Assistant owners. Home reads their state and invokes explicit actions; displaying a session or approval must not create another owner.

All contracts below are proposals, not existing APIs. Source references are to 4f2b5d2. The design boards in `docs/design/canvas` were read as HTML.

For scheduling, this document refers to migration steps 1–8 in `docs/design/shell-spec.md` §8.

## Common rules for the feeds

- Native snapshots carry a runtime ID and revision. Subscribe, obtain a snapshot, then apply newer events. Reconnection reconciles with Rust rather than reconstructing “live” state from saved documents.
- Renderer timers calculate elapsed time from a native elapsed-time snapshot and a monotonic browser clock. They do not poll or persist every second.
- Saved session references never automatically spawn processes. After renderer-load invalidation, Resume can offer “Session ended — open a new session.”
- Native facts may reach the renderer for display. They do not automatically become model context.
- Rust emits structured facts and stable reason codes. The renderer supplies six-locale wording, accessible labels, and plain-text rendering.
- Retained owners keep ADR 0013’s cancellation behavior. Home, context panels, and conversation selection must not accidentally unmount them.

## 1. Terminal metadata and exit events

Recommend A: native session metadata and lifecycle events, with explicitly limited shell telemetry.

The current bridge returns an ID; the reader stops on EOF without reporting process termination. Terminal bridge (src/lib/bridge/terminal.ts:26), PTY reader (src-tauri/src/terminal/mod.rs:270)

### Ownership and contract

Rust owns process identity, startup facts, process termination, and elapsed time. A shared renderer store holds the current snapshot. The document store holds tab presentation and historical references.

```ts
type TerminalSessionInfo = {
  runtimeId: string;
  sessionId: string;
  revision: number;
  origin: "user" | "assistant" | "registered_tool";
  installationId: string | null;
  state: "running" | "stopping" | "exited" | "unknown";
  ioState: "open" | "closed" | "error";
  pid: number | null;
  programName: string;
  programVersion: string | null;
  startedAt: number;
  elapsedMs: number;
  initialCwd: string | null;
  reportedCwd: string | null;
  cwdSource: "spawn" | "shell_reported" | "unknown";
  exit: null | {
    code: number | null;
    reason: "natural" | "stopped" | "owner_teardown" | "unknown";
    endedAt: number;
  };
};
```

Commands/events:
- terminal_open / terminal_open_tool → TerminalSessionInfo.
- terminal_list_sessions() → {runtimeId, revision, sessions}.
- terminal://session → {runtimeId, revision, session: TerminalSessionInfo}.
- Stop continues to address session IDs, never renderer-supplied PIDs.
A child-process monitor establishes exit. EOF alone establishes only that the output stream closed. Conversely, the shell may exit while descendants still hold the stream open.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Native metadata and process lifecycle | Medium. Terminal Rust module/commands, terminal bridge, session hook/tab store; native lifecycle and snapshot/event tests. | Initial cwd may be mistaken for current cwd; process exit may be mistaken for the last command’s result unless fields and wording distinguish them. |
| B. Add shell integration | Larger. A plus supported-shell startup integration and telemetry parsing; fixtures for pwsh, PowerShell and bash, including malformed/spoofed reports. | Shell output can forge cwd or command-status reports. Startup hooks can alter shell behavior or fail under user profiles. |

B wins if current cwd and the last completed command’s status are required, rather than initial cwd and shell-process status.

### Security and canvas decisions

PID, resolved program name, timestamps, privilege state, and validated initial cwd may reach the renderer. Rust derives them. Shell-reported telemetry is display information, never authority for scope checks, filesystem access, or executable identity.

The Work board simultaneously shows a live session and exit 0. Under A, use:
- “Started in C:\…”, not an unqualified current directory.
- “Shell running” while the process lives.
- “Shell exited · code 0” after termination.
- Show a version only when actually known.
Under B, label a live-session result “Last command: 0.” That is a different field.

For Home, Stop all should explicitly cover managed PTYs and supervised runs, and cancel an active agent turn that could otherwise create more work. Return individual failures; do not claim detached GUI applications or entire descendant process trees were stopped.

Scheduling: design before the shell rework; build before §8.5 Work tabs, then consume in §8.6 rail and §8.7 Home. It need not block §8.1 routing.

## 2. Structured approvals and a shared pending approval

Recommend A: one native pending approval, structured action facts, and honest “unknown/not assessed” chips.

Keep single-flight. The two Home cards cannot both represent actionable pending assistant approvals today. Broker pending slot (src-tauri/src/assistant/broker.rs:324)

### Ownership and contract

Rust owns the pending action and its immutable execution arguments. A shared renderer projection supplies both Home and Assistant. The retained Assistant owner continues to own the turn.

```ts
type ApprovalAction =
  | { kind: "terminal_run"; sessionId: string | null; command: string }
  | {
      kind: "launch_tool";
      installationId: string;
      displayName: string;
      argv: string[];
    }
  | { kind: "read_context"; contextKind: string };

type PendingApproval = {
  requestId: string;
  callId: string;
  conversationId: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  action: ApprovalAction;
  intent: { key: string; params: Record<string, string> };
  facts: {
    scope: "not_assessed" | "not_applicable" | "allowed" | "blocked";
    scopeId: string | null;
    scopeRevision: number | null;
    networkClass: "unknown" | "local" | "loopback" | "private" | "public";
    risk: { source: "unassessed" | "registration" | "profile"; tier: string | null };
    identity: {
      state: "not_applicable" | "verified" | "blocked" | "unknown";
      checkedAt: number | null;
      sha256: string | null;
    };
  };
};
```

- assistant_get_state() → {runtimeId, revision, activeRequestId, pending: PendingApproval | null}.
- Extend assistant://stream with structured approval and resolution events.
- Approval sends {requestId, callId, revision, approved}. It never sends executable arguments back for execution.
- Register the pending action before publishing it. Both surfaces submit to the same native slot; duplicate/stale decisions return an explicit unresolved result.
- expiresAt reflects the earlier of the approval deadline and remaining turn deadline. Navigation never restarts the 300-second allowance.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Structured descriptors, existing three tools | Medium. Broker/events, command loop, approval descriptor builder, client, shared state, both cards. Tests change from summary-string assertions to action/fact assertions and duplicate-decision races. | “Unknown” can become reassuring decoration if the renderer substitutes green defaults. |
| B. Typed execution profiles with native scope/risk assessment | High. A plus native target normalization, scope evaluation, versioned action profiles, and policy fixtures. | An incomplete argument parser can certify only one target while overlooking additional effects. Policy labels can drift from the executed profile. |
| C. Multiple concurrent pending approvals | Very high. Broker scheduling, cancellation, deadlines, conversation ownership, and conflict tests change. | Approval confusion, overlapping actions against the same session, and one conversation approving another’s work. |

B wins if the exact green scope chip and action-specific risk rating are mandatory for identified workflows. C needs a separate concurrency requirement; the mockup alone is insufficient justification.

### Which chips are supportable now?

| Chip | Honest capability at this commit |
|---|---|
| Exact terminal command | Yes: the parsed terminal_run.command, displayed literally. |
| Registered launch action | Yes: native-resolved display name, installation ID and exact argv. Preserve the current restriction against exposing executable paths in approval summaries. |
| Intent sentence | A factual template such as “Run this command in a terminal.” “Perform a safe, non-intrusive scan” requires a typed profile, not model prose. |
| Verified · SHA-256 | For launch_tool, the existing display-name resolution already passes through live identity verification. Extend its result with evidence and re-check at execute. It proves correspondence with the registered binary, not vendor authenticity or safe behavior. |
| Verified on terminal_run("nmap …") | No. Verifying the shell does not verify whichever executable its command resolution selects. |
| Target in scope | Not for the current agent calls. They have no structured engagement/target assessment. The supervised batch path validates a supplied attestation; it is not a general native shell-command scope evaluator. |
| Network · medium risk | Registration category/risk can be displayed as “Registered rating: Medium.” Those fields are supplied during registration. They are not a computed verdict on these arguments. |
| Loopback | Only after identifying a structured target. Finding localhost in arbitrary shell text proves nothing about all effects. |

Evidence: approval construction (src-tauri/src/assistant/tools.rs:243), registration metadata (src-tauri/src/tool_registry.rs:122), batch scope validation (src-tauri/src/tool_supervisor.rs:1161).

Decisions: render zero or one pending card; use “Scope not assessed” and “Command effects not classified” where appropriate. Preserve the approved card layout.

Scheduling: contract before the shell rework; implementation before the new Assistant card and §8.7 Home. No need to delay routing or palette coverage.

## 3. Conversations, engagement binding, and deletion

Recommend A: bounded conversation documents, with transient streaming state kept separately.

### Ownership and contract

The document store owns saved conversations. Rust associates an active request with a conversation ID for correlation, not authorization. The renderer’s retained owner keeps streaming state indexed by that ID.

```ts
type Conversation = {
  id: string;
  title: string;
  workspaceId: string | null;
  engagementId: string | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  eraseRevision: number;
  messages: SavedMessage[];
};

type SavedMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number | null;
  requestId: string | null;
};
```

Document operations:
- createConversation({workspaceId, engagementId}).
- appendTurn({conversationId, expectedEraseRevision, requestId, messages}).
- clearConversation({conversationId}).
- clearAllConversations().
Add conversationId to assistant start/events. Freeze the turn’s context references when sending; changing the active project elsewhere must not retarget a conversation silently.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. One bounded document per conversation | Medium. Domain schema, database migration, conversation state, chat, Settings, rail/Resume selectors. No new Rust execution behavior; add correlation fields. | Whole-document persistence becomes expensive if histories grow without bounds; an unguarded late callback can recreate deleted text. |
| B. Separate conversation/message tables with incremental writes | Larger. A plus SQL schema, query/pagination layer, transactional deletion and export/import changes. | Partial deletion, orphan messages/attachments, and more complicated restore behavior. |

B wins if searchable long histories, extensive attachments, or measured write volume make bounded documents inadequate. A can retain the existing 50-message limit initially, with an explicit retention policy.

### Migration and lifecycle

- Atomically move a nonempty legacy history into one “Previous conversation.”
- Leave workspace and engagement unassigned: there is no reliable historical association.
- Do not invent message timestamps.
- Commit the migration marker and retirement of the legacy field together. Empty or previously erased history creates no conversation.
- An erase increments its revision before canceling work and deleting content. Every delayed persistence operation checks that revision when committing.
- Settings’ current “clear history” semantics become clear all conversations, including titles, previews, attachment caches, and retained excerpts.
- Switching conversations does not end a turn. A new send while another conversation owns the single-flight slot reports where work is active and offers an explicit Stop action.
This preserves the property fixed in fc4a322; merely moving arrays into a new collection would not preserve it. Current erase handling (src/features/jarvis/LocalAssistantChat.tsx:366)

A conversation’s engagement link is explicit. If an engagement also needs a project relationship, add an optional workspace reference rather than inferring it from names or whichever project is currently selected.

Security: titles, bindings, and transcripts are local user data. They confer no scope grant. Imported history never restores a live turn or actionable approval.

Scheduling: design before the shell rework; build before §8.6 conversation rail, then §8.7 Resume. It need not block the switcher.

## 4. GUI launch records

Recommend B: a native launch-receipt ledger, without claiming process supervision.

Both manual and assistant GUI launches currently discard the child handle. They must share the new recording path. Manual launch (src-tauri/src/lib.rs:564), assistant launch (src-tauri/src/assistant/tools.rs:551)

### Ownership and contract

Rust records the launch attempt and observed spawn outcome. The renderer projects it into Recent runs and Work’s launch-record tabs.

```ts
type LaunchReceipt = {
  launchId: string;
  operationId: string;
  installationId: string;
  displayName: string;
  requestedAt: number;
  spawnedAt: number | null;
  pid: number | null;
  outcome: "launched" | "failed" | "unknown";
  tracking: "unmanaged";
  reasonCode: string | null;
  recorded: boolean;
};
```

- Extend launch_tool_detached({operationId, installationId, args}) to return the receipt.
- tool_launches_list({limit}) returns recent receipts.
- tool://launch publishes new/updated receipts.
- Repeated operation IDs retrieve the same attempt; uncertain outcomes do not automatically retry spawning.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Renderer records successful acknowledgements | Small. Bridge result and document/Resume code; little Rust beyond returning metadata. | Misses launches when the renderer disappears, and can diverge between manual and assistant routes. |
| B. Native receipt ledger | Medium. Shared native launch helper/ledger, both callers, bridge, history projection. Tests cover failure, duplicate request, and persistence failure around spawn. | A crash between spawning and recording leaves an uncertain outcome; a launch receipt may be misrepresented as a successful completed job. |
| C. Managed GUI processes | Large. Retain handles, observe termination, define shutdown/Stop semantics, and handle applications that hand off to an existing instance. | Killing the wrong application instance or claiming an application ended because its launcher exited. |

C wins if stopping and tracking external GUI applications is an actual product requirement.

Security: installation identity and spawn facts come from Rust. Persist only bounded, redacted display metadata; avoid creating a second raw argument/secret log. Display names and historical records never authorize relaunch.

Decisions:
- Outcome: “Launched externally,” not “Succeeded.”
- Running: exclude unmanaged receipts.
- Resume: “View launch” or “Launch again,” never automatic relaunch.
- Stop all explicitly excludes these applications.
Scheduling: before §8.5 GUI launch-record tabs and §8.7 Recent/Resume. No build requirement before the shell rework.

## 5. Tool-run progress

Recommend A: state plus elapsed time; add percentages only where a specific adapter reports them.

```ts
type RunProgress =
  | { kind: "unknown" }
  | {
      kind: "reported";
      percent: number;
      phase: string;
      source: string;
      observedAt: number;
    };
```

For A, existing run state and timestamps are sufficient. B extends NativeToolRun and tool://run events with progress.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Indeterminate progress | Small. Home/Work selectors and UI; no new Rust. Tests ensure missing progress never becomes a number. | Users cannot estimate completion; an old “running” record can look live unless runtime freshness is checked. |
| B. Adapter-reported progress | Medium per adapter. Native parser/adapter, run/event types, bridge and display. Tests cover malformed values, phase resets, stale reports and failed completion. | Stage progress may be mistaken for total progress; tool output can report misleading percentages. |
| C. Time-based estimates | Larger than it looks: history, comparable workloads, calibration and uncertainty. | Progress stalls at 99%, moves backward, or predicts completion from unrelated runs. |

B wins for a tool when it has a sufficiently stable progress protocol and the UI can name the measured phase. A remains the fallback for every other tool.

Security: progress is Rust-parsed tool telemetry, never model-generated. It is not a safety verdict. A reported 100% does not replace the actual process outcome.

Decision: replace unsupported “Running 62%” with “Running · 00:01:12” and an indeterminate indicator. If only a phase is measured, say “Service detection · 62% reported.”

Scheduling: display decision before the shell rework; A at §8.5/§8.7. Adapter percentages can follow independently.

## 6. Catalog identity and installation status

Recommend A: a composed catalog with an explicit crosswalk and explicit installation bindings.

The two catalogs are not interchangeable lists. For example, cyberchef means the built-in Transform workbench in one and a CyberChef reference in the other. Wireshark and TShark also need distinct launch modes. 30-entry catalog (src/domain/tools/registry.ts:26), 48-entry catalog (src/features/lab/toolCatalog.ts:121)

### Ownership and contract

Static catalog data owns descriptions and supported product behavior. The document store owns user-confirmed bindings. Native installations own registration, enablement and hash-check facts.

```ts
type LauncherItem = {
  catalogId: string;
  kind: "builtin" | "external" | "guide" | "planned";
  name: string;
  purposeKey: string;
  launchModes: Array<"builtin" | "terminal" | "external_gui">;
  installationIds: string[];
};

type InstallationBinding = {
  catalogId: string;
  installationId: string;
  confirmedAt: number;
};

type InstallationStatus = {
  installationId: string;
  enabled: boolean;
  verification: "last_verified" | "changed" | "unknown";
  lastVerifiedAt: number | null;
};
```

Use the existing native installation list and reverify command. Every actual launch still goes through resolve_launchable.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Composition and explicit bindings | Medium. Both catalog modules, a crosswalk/binding schema, launcher selectors and registration UI. Little or no new Rust. Tests cover duplicate names, aliases, multiple installations and missing bindings. | Two sources can continue drifting; a careless crosswalk can combine different products or a guide with an executable capability. |
| B. One canonical catalog schema | Larger migration. Consolidate descriptions, localization, statuses and legacy IDs; update every catalog consumer. | ID migration can orphan saved profiles or promote conceptual entries into launchable tools. |

B wins if catalog maintenance is becoming frequent enough that the crosswalk itself creates repeated divergence. It is not required to feed the launcher now.

The existing substring matcher can suggest a binding. It must not establish identity or choose a binary silently. Current matcher (src/features/lab/toolCatalog.ts:652)

### Security and canvas decisions

- Count registered installations from native records, not either static catalog.
- A stored successful check is “Last verified …”; launch performs a fresh check.
- SHA-256 matching proves continuity with the registered file, not official vendor provenance.
- An absent binding proves “Not registered,” not necessarily “Not installed.”
- Built-ins show “Built in.” Planned entries and conceptual guides retain their real status.
- GUI-only tools cannot honestly promise an embedded terminal launch.
Proposed header: “N registered · identity checked at launch.”

These are decisions about the board’s wording and action availability, not a new screen design.

Scheduling: establish IDs/bindings before §8.2 palette tool actions. Launcher implementation follows that step; all existing capabilities remain addressable.

## 7. “Admin CMD” and embedded elevation

Recommend A for the shell rework: embedded terminals at the app’s current privilege, plus explicitly manual external-admin instructions. Treat automated elevation as a separate feature decision.

### Ownership and contract

Rust reports capabilities and observed privilege:

```ts
native_launch_capabilities() -> {
  embeddedTerminal: boolean;
  privilege: "standard" | "elevated" | "unknown";
  externalElevation: "unavailable" | "explicit_uac";
}
```

Do not use a conservative “assume elevated if querying fails” safety flag as proof for an Admin badge. The existing elevation detector has that behavior. Elevation detection (src-tauri/src/winapi.rs:79)

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Current privilege + manual admin workflow | Small. Capability reporting, launcher labels/help, privilege-state tests. No elevation executor. | The external workflow is untracked and the user may launch a different binary outside Qutra. |
| B. Explicit external UAC launch | Substantial Windows feature. Native launch command, verified launch plan, external-console handling, receipt integration, cancellation/denial/quoting tests. | A privileged command surface, unsafe command-string construction, or execution of a changed binary after the UAC delay. |
| C. Elevated helper hosting embedded terminals | Highest. Privileged helper, authenticated communication, packaging and lifecycle management. | A persistent privileged bridge available to a lower-privilege renderer. |

B wins if one-click external admin launch is required for the shell rework and receives its own implementation and validation work.

A possible B contract is:

```ts
launch_tool_external_elevated({
  operationId, installationId, args
}) -> LaunchReceipt & {
  elevation: "granted" | "denied" | "failed";
}
```

It must remain unavailable to the model’s tool schema. The native side resolves identity, preserves argument boundaries, handles UAC refusal, and checks identity again at actual execution. A separate command window must not be implemented by concatenating model/user strings into cmd /k.

Explicit UAC elevation is possible without silently elevating the main application; Windows’ runas mechanism is designed for an elevation prompt. That establishes a platform option, not an existing Qutra capability. (Microsoft's launch contract.)

Decisions:
- “Open in app — current privilege”, not “embedded admin terminal.”
- Under A: “Admin instructions”, with external execution explicitly untracked.
- Under B: “Open elevated window…”, making the prompt and external lifetime clear.
- Do not mark either admin promise implemented while this decision is unresolved.
Scheduling: decide before enabling launcher actions in §8.2. A is small; B/C should not silently enter the theme or navigation work.

## 8. Home and persistence volume

Recommend A: one shared live projection, with change detection and batched persistence of durable summaries.

Rust already owns a run ledger. Home does not need another polling-and-writing loop. The present renderer mirror repeatedly writes individual records, while SQLite replaces the collection. Run mirroring (src/state/labRuntime.ts:93), collection persistence (src/lib/db/sqliteAdapter.ts:133)

### Ownership and contract

Keep labRuntime as the single subscription owner. Separate live output/counters from durable historical summaries.

```ts
applyNativeSnapshot({
  generation, installations, runs
}): void

upsertManyDurable({
  collection, records, removedIds
}): Promise<void>
```

The second operation is a document-store API, not a new IPC layer. It merges through the existing collection write queue and commits once.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Diff, batch, and persist semantic changes | Medium. labRuntime, collection API and adapter tests. No new Rust required. | A bad equality rule misses changes; delayed checkpoints leave a stale mirror after interruption. |
| B. Incremental row persistence | Larger. Storage adapter gains row upserts/deletes and transaction-aware mirror updates; database tests change substantially. | SQL rows and the synchronous mirror diverge, or partial batches lose consistency. |

B wins if measured history size and mutation rate still make one full-collection write per meaningful batch too costly.

For A:
- Unchanged refresh → zero writes.
- One changed batch → at most one write per affected collection.
- Output chunks and uptime ticks update runtime state only.
- Persist lifecycle transitions, final summaries and artifact changes; use a bounded checkpoint interval only if recovery needs it.
- Preserve generation checks through queued work. Revoke discards pending mirror batches.
- A failed/unavailable refresh is not an empty authoritative snapshot and must not delete history.
Security: old/imported document records never establish “currently running,” installation verification, or permission. Browser mode may display clearly labeled saved history, not native live state.

Scheduling: design before the shell rework. Build before the first new live consumer increases refresh activity, and certainly before §8.7 Home. Pure §8.1 routing does not require waiting for it.

## 9. Attaching a terminal session

Recommend B: a reviewed, frozen, bounded excerpt prepared by Rust for one message. Attaching output grants no terminal control.

The existing terminal buffer is bounded but contains raw output. The current project-context packer’s small metadata limits are not a terminal-output policy. Scrollback bound (src-tauri/src/terminal/mod.rs:34), context packer (src/domain/assistantContext.ts)

### Ownership and contract

Rust owns capture, normalization, redaction and the frozen attachment. The user chooses the session and excerpt, sees the final preview, and decides whether to send it.

```ts
prepare_terminal_attachment({
  conversationId,
  sessionId,
  selection:
    | { kind: "tail"; maxLines: number }
    | { kind: "range"; fromCursor: number; toCursor: number }
}) -> {
  attachmentId: string;
  digest: string;
  previewText: string;
  capturedAt: number;
  sourceCursor: number;
  truncated: boolean;
  redactionCount: number;
  expiresAt: number;
  destination: "local";
}
```

Extend assistant start with:

```ts
terminalAttachments: Array<{ attachmentId: string; digest: string }>
```

Rust resolves the prepared excerpt; it does not re-read newer output at Send.

| Option | Cost and affected files | Failure it makes possible |
|---|---|---|
| A. Explicitly attach selected text from the terminal view | Smaller. Terminal selection, composer preview and message-budget handling; reuse normal text submission. | Selection may contain invisible controls or secrets; origin and capture boundaries are weaker. |
| B. Native prepared excerpt | Medium. Terminal snapshot/attachment commands, redaction module, broker request handling, composer and deletion integration. Tests cover bounds, control sequences, stale cursors, redaction and exact-preview delivery. | Redaction has false negatives; a preview can create false confidence. Prepared data can linger unless expiration and erase are explicit. |
| C. Follow the live terminal | Large. Ongoing disclosure consent, streaming budget, stop conditions and retained-context rules. | New output—including secrets printed later—is sent without the user seeing what they authorized. |

A wins if the product accepts “Attach selected text” and wants the smallest explicit-disclosure workflow. C should not be inferred from a paperclip-like button.

### Proposed disclosure policy

- Initially one excerpt per message, capped at 200 lines and 8 KiB UTF-8, further constrained by the actual remaining context budget.
- Normalize terminal control sequences before preview/redaction. Do not send OSC commands, hidden hyperlinks, or raw terminal escape behavior.
- Redact known protected values and recognizable secret patterns in Rust. The renderer receives the filtered preview, never a list of protected secret values.
- Say “Checked for common secrets — review before sending.” Never “secret-free.”
- Bind the preview to conversation, destination and digest. If budgeting changes the excerpt, show the changed preview before sending.
- A selection already evicted from scrollback returns “Excerpt unavailable”; do not silently substitute another range.
- P and L are checked at capture/use. G is not implicitly enabled: this is a user-directed context attachment.
- Do not add the session to the assistant’s owned-session set. The existing write restriction must remain. Agent session ownership (src-tauri/src/assistant/tools.rs:586)
- Default to ephemeral excerpt storage. Saved history records that an excerpt was used; it does not silently retain the terminal dump. Regeneration after expiry asks for reattachment.
- Conversation erase clears prepared excerpts and any explicitly retained copies. It does not terminate a manually owned terminal.
- Model replies may quote the excerpt; those replies remain subject to the conversation’s deletion policy.
Decisions: the button means “Attach terminal excerpt,” not access to the whole live session. Cloud escalation is not built, so the board should communicate “Local only — cloud unavailable” rather than imply an operable cloud toggle. A future cloud path needs a new disclosure decision for the actual excerpt and destination.

Scheduling: decide before the new Assistant composer is built; implement before its attach button is enabled. It does not block routing, Work tabs, or Home.

## What must land before the shell rework?

The contracts and decisions should be settled first. The nine implementations do not all need to precede the first routing commit.

| §8 step | Required data work |
|---|---|
| 1 — Surface switcher | Preserve retained owners and stable identity. No new telemetry required. |
| 2 — Complete palette | Catalog/binding rules and truthful launch/elevation capabilities. |
| 3 — Lab segmentation | Reuse existing engagement data; do not infer new scope authorization from presentation. |
| 4 — Context panel | Shared selectors/subscriptions; no duplicate terminal or run owner. |
| 5 — Work tabs | Terminal lifecycle metadata, stable subject IDs, GUI receipts, honest progress. Persist descriptors, not automatic spawn recipes. |
| 6 — Contextual rails | Conversation identity/migration and session-to-tab mapping. |
| 7 — Home | Shared approval projection, live snapshots, receipts, Resume references, bounded writes. |
| 8 — Cleanup | Remove superseded readers only after all consumers use the agreed feeds. |

Across these steps, keep actions keyboard-operable, restore focus after dialogs, announce approval/result transitions once, and avoid announcing uptime every second. Unknown progress omits aria-valuenow. Every new status/reason has six-locale coverage.

## Ordered work

1. Resolve the canvas’s factual promises: one pending approval, percentage availability, shell versus command exit, scope/risk evidence, registration versus installation, GUI tracking, and elevation. These decisions determine the contracts; quietly inserting placeholders would postpone the disagreement into implementation.

2. Fix identities and ownership contracts: native runtime/session IDs, conversation IDs, installation bindings, launch IDs, and one retained owner per live operation. Establish the exact meaning of Stop all and Resume.

3. Build the shared snapshot/event feeds: terminal lifecycle metadata and native pending-approval state. Home must be able to observe work without mounting another owner.

4. Bound persistence before adding live consumers: diff/batch native mirrors and keep output/timers out of document writes.

5. Add conversation documents and erase-safe migration: this must precede saved-conversation navigation and its Resume entry.

6. Add the common native GUI receipt path: cover both manual and assistant launches before displaying them in Work or Recent runs.

7. Complete catalog bindings and capability-driven actions: finish this before the palette becomes the sole access path for demoted tool destinations.

8. Build Work, rails and Home against those feeds: use indeterminate progress and explicitly unavailable facts wherever richer support has not landed.

9. Add reviewed terminal excerpts before enabling Attach. Stage shell integration, adapter percentages, typed scope/risk profiles and automated elevation as separately justified extensions. None should arrive accidentally inside the re-skin.
