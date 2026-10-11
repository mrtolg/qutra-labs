# ADR 0012 — Agentic assistant: an approval-gated action boundary

**Status:** accepted · 2026-08-13 — supersedes, **for the local assistant only**, the
"may read and answer, and may do nothing else" position of ADR 0010 (Karar 4) and the
header of `src/domain/assistantPermissions.ts`.

## Context

ADR 0010 drew an absolute line for the local assistant lab: no shell, no files, no tool
calling. To keep that line from eroding quietly, the phase left a tripwire rather than a
comment — `src/domain/assistantPermissions.ts`, a types-only skeleton with
`ASSISTANT_ACTIONS_ENABLED = false`, imported by nothing, whose header says that wiring
those types into a live path "is the moment the boundary is being crossed, and it must be
an explicit, reviewed decision (new ADR) rather than a quiet extension of something that
'was already there'." This is that ADR. It is written before the code, so the rest of the
plan implements a decision instead of discovering one.

**What changed.** Spec §7.3 asks for an agentic assistant: a tool-calling broker that can
drive the terminal, the tool launcher and the lab. That is a product decision, and on its
own it would not be enough — a want is not a justification. Two things underneath changed
as well, and they are what make an approval flow buildable now without inventing a new
attack surface for it:

1. **The transport is no longer in the renderer.** ADR 0010's 2026-07-29 addendum moved
   Ollama access into `src-tauri/src/assistant/`: a pinned endpoint, single-flight, real
   cancellation, deadlines in Rust, and a shape-only audit log. An approval pause needs
   exactly those primitives. Building one on top of a renderer-side `fetch` would have
   meant a gate that lived in the same place as the thing it gates.
2. **The launcher already resolves ids, not paths.** Plan B's `ToolSupervisor::resolve_launchable`
   takes a registered installation id and returns a `LaunchTarget { program, working_dir }`
   only after checking `enabled`, the stored `changed_since_verify` flag, and a **live
   SHA-256 re-hash** of the binary. The property that the *caller* cannot name an
   executable or a working directory already exists and is tested. Extending it from "the
   renderer cannot" to "the model cannot" is a reuse, not a new mechanism.

**The four preconditions.** The skeleton named the price of an executor: "a visible summary
of the exact action, explicit per-action approval, a working cancel, and a local action
log." The implementation builds all four, and each is delivered by an identifiable
component rather than assumed:

| Precondition | Delivered by |
|---|---|
| A visible summary of the exact action | Tool layer: `AgentTool::summary()` is built server-side from the *parsed* call, not from model prose; UI: the approval card renders it verbatim as plain text, and a test asserts markup in a summary is not rendered as HTML. |
| Explicit per-action approval | Broker: the pending-approval slot and decision routing that matches on **both** `requestId` and `callId`; Turn loop: the loop awaits a decision before `execute`; UI: the Approve/Reject control. |
| A working cancel | Broker: `cancel` drops the pending sender so a turn waiting on approval wakes instead of hanging; Turn loop: the receive error ends the turn as `cancelled` and frees the single-flight slot. |
| A local action log | Turn loop: an audit entry per tool call carrying `tool` and `decision`, on `audit.rs`'s existing shape-not-content terms (see Decision 5 for what that log deliberately does not answer). |

The first implementation step flips `ASSISTANT_ACTIONS_ENABLED` to `true` and rewrites the skeleton's header so it
describes the live contract instead of a boundary that no longer holds. The standing rule
in that header survives the flip: a *new* action kind still requires another ADR.

## Decision 1 — a closed allowlist, not a runner

The model may propose exactly three calls, and the names are literals matched exactly — no
trimming, no case folding, no prefix or fuzzy resolution:

- **`terminal_run(sessionId?, command)`** — sends a line to a PTY session the user can see,
  in the terminal surface they already own. Existing sessions are addressed by id; if none
  is given, one is opened through the same path `terminal_open` uses.
- **`launch_tool(toolId, args?)`** — launches a registered, enabled, hash-verified lab tool
  by id, through `ToolSupervisor::resolve_launchable`. The model supplies `args` as a
  string; it is tokenized server-side into an argv array and spawned with `.args(..)`.
  No shell string is ever assembled, and the same tokenizer builds the summary the user
  approves, so the card and the argv cannot disagree.
- **`read_context(kind)`** — returns a bounded, read-only text block assembled from records
  the app already holds. No file contents; the metadata-not-content decision from ADR
  0010's Faz 2 note stands unchanged.
  **As implemented, only `kind: "resources"` returns real data** — the tool registry
  summary. `project` and `findings` live in the renderer's document store, which the Rust
  broker does not read, so those kinds return an explicit "not available here" string
  rather than an empty block. Widening this is follow-on work; until then the tool is
  narrower than its name suggests, and this note is the honest statement of that.

There is **no** arbitrary shell command surface reachable outside a visible PTY, **no** file
writes, **no** file-content reads, **no** network requests the model can originate, **no**
clipboard access, and **no** credential access.

**Rejected: a general runner** — one `run_command(argv)` tool behind the same approval
prompt. It is less code and strictly more capable, which is exactly the problem: it makes
the approval dialog the *only* boundary. A closed allowlist means a mistaken approval has a
bounded blast radius; a general runner means a single mis-read prompt is unbounded. It is
also the difference between a security property you can test and one you can only assert —
there is no test for "this runner refuses to do something catastrophic", but
`refuses_a_tool_outside_the_allowlist` is three lines.

**Rejected: a per-workspace command allowlist**, in the style of ADR 0003 §5's `run_command`.
That mechanism was designed for automations the *user* authored. Here the command string
originates with the model, so an allowlist of command *shapes* would be matching untrusted
text against patterns — the classic place where an escape is eventually found.

**Rejected: dynamic/MCP-style tool registration.** If the tool set is data, then the tool
set is something the model's context can influence. Three names compiled into
`src-tauri/src/assistant/tools.rs` cannot be grown at runtime.

*Amended after implementation.* This originally read "three names compiled into two files",
naming a TypeScript mirror alongside the Rust one. That mirror was deleted: nothing called it
— the approval card renders the summary the broker sends — so it was a hand-synced second copy
of a security allowlist, including its own tokenizer that had to stay byte-identical to the
Rust one. A copy that can drift silently while inviting a reader to believe the renderer
enforces something is a liability, not a second line of defence. The allowlist is enforced in
exactly one place, and that is the stronger claim.

**The honest cost.** `terminal_run` is, in effect, arbitrary shell. Pretending otherwise
would make this ADR worthless. The difference is not capability — it is *locus and
visibility*: the text goes into a terminal the user can see, in a session they own, after
they have read the exact line, and it produces scrollback they can inspect afterwards. It
is not a hidden `Command::new` with output the user never sees. That is a real reduction in
risk and not a containment claim; `terminal_run` is the widest surface in this design and is
named as such in the risks below.

*The visibility claim, made good.* When first implemented this was aspirational: a
`TerminalTab` only mounts under the lazy `/terminal` route, so an agent command run while the
user sat on the chat page emitted its bytes to nobody and nothing buffered them — the
justification above was, for the agent's normal case, false. It is now true. Each session's
output is buffered server-side, oldest-first, capped at `SCROLLBACK_CAP_BYTES` (256 KiB,
`terminal/mod.rs`), and a terminal surface attaching at any later point replays that buffer
before live output, in order, with neither a gap nor a duplicate — the buffer is written
before the corresponding event is emitted, and a monotone per-session byte counter
(`TerminalData::seq` / `TerminalScrollback::cursor`) marks the exact boundary.

Three limits, stated so the guarantee is not read as stronger than it is. **Bounded, not
durable:** output past the cap is discarded oldest-first, exactly like scrollback that has
aged out of a real terminal. **Session-scoped:** the buffer lives and dies with the PTY —
closing the tab closes the session and destroys the buffer; nothing is written to disk and
nothing survives a restart. **Not an audit record:** `assistant/audit.rs` remains the record
of what was *proposed and approved*; scrollback is the record of what the shell *printed*,
and only the former is retained deliberately.

## Decision 1b — the agent is opt-in, and off by default

*Added after implementation.* The first cut advertised the tool schema on **every** turn.
That was wrong twice over.

It changed what an existing user had without asking them. Someone who enabled the local
assistant under ADR 0010's "answer only" promise would have had an agent, announced by
nothing louder than a reworded sentence in the panel footer. A developer-facing ADR is not a
user-facing consent step, and Private Lab consent does not cover this either: that grant was
given so *the user* could drive native tools, not so a language model could propose them.

It also broke the ordinary case. A user without Private Lab consent had every tool-proposing
turn die on `ConsentRequired` — including `read_context`, which only reads the tool registry
— losing the answer they asked for, repeatedly, with no way to stop the model proposing.

So the tool schema is sent only when **both** hold: the preference
`assistantAgentToolsEnabled` (**default `false`**, opt-in) is
on, **and** Private Lab consent is currently granted. It is a conjunction, and it is tested
as one — neither condition alone opens the gate. When either is false the schema is `None`
and the assistant answers exactly as it did before this feature existed, which is also the
honest fallback for a model whose template cannot do tool calling at all.

The opt-in is surfaced in two *places*, not as two grants: Settings → Advanced has three
independent controls (Local assistant, Private Lab, Assistant tool proposals), and the
Assistant surface offers a mode choice that edits those same three values. That mode choice
is not a fourth stored switch. Entering from Terminal or Lab still asks only the Private
Lab question and writes neither `localAssistantEnabled` nor `assistantAgentToolsEnabled`.

Stored `assistantAgentToolsEnabled = true` is not proof of consent: whole-profile import
can set the boolean with no question, and preferences record no provenance. A versioned
reconfirmation therefore migrates unproven G to false until the user answers the agent
question again. Import/restore must not skip that question by copying G=true or a
confirmation epoch. None of this changes what opens the gate: the schema still requires
G **and** native P as a conjunction, consent is still re-checked at execute, and per-call
approval still stands.

The cost is that the feature is invisible until someone turns it on. That is the correct
default for a boundary this ADR exists to document crossing: a capability that can spawn a
process should be reached by a deliberate act, not inherited by anyone who had already
enabled something narrower.

## Decision 2 — approval is per-call, and mandatory for anything with a side effect

`terminal_run` and `launch_tool` execute **only** after an explicit user approval carrying
the matching `requestId` **and** `callId`. There is no auto-approve setting for them, no
"remember this", no "allow for this conversation", and no default-approve path anywhere in
the loop. A stale approval card must not resolve the call that replaced it, which is why
both ids are matched and why a mismatch returns `false` rather than being tolerated.

**Rejected: session-scoped approval.** It is the obvious ergonomic improvement and it is
wrong here, because a session grant is a grant made *before the dangerous call exists*. The
user approves a category; the model then chooses the instance. It also interacts badly with
the specific threat this design has and the previous one did not: content entering the
context (a project note, a resource title, a tool's output) can carry an instruction, and
that instruction would arrive mid-turn — after the grant, inside its scope. Per-call
approval means the injected instruction still has to be read and approved on its own terms.

**Rejected: a risk-tier auto-approve** ("auto-approve low-risk commands"). Classifying a
model-supplied command string as low-risk is precisely the untrusted-text-matching problem
we declined in Decision 1, moved one layer up.

**The exception, and why it is one.** `read_context` is read-only, bounded, and assembles
only records the app already has and already shows the user. It may be auto-approved by the
preference `assistantAutoApproveReads`, **default `false`**, opt-in, and passed per turn
from the renderer on `StartRequest` rather than read from a preference file in Rust — so it
is a value on the request that only ever *weakens* the read gate, never a global that a
side-effecting path could consult. That it cannot affect `terminal_run` or `launch_tool` is
asserted in code, not only in this document.

**The cost.** One interaction per side-effecting step. A multi-step task is a sequence of
prompts, and `MAX_TOOL_STEPS = 5` caps how long that sequence can get. Approval fatigue is a
real failure mode and this design does not solve it — it bounds it (Decision 1) and refuses
to trade it away (this decision).

## Decision 3 — a tool call names an id, never a path

Model output must never reach `Command::new`, `validate_executable_path`, or a working
directory. `launch_tool` carries a `toolId`; the program path and working directory come
from the registry via `resolve_launchable`, which re-checks `enabled` + `changed_since_verify`
+ a live SHA-256 re-hash at call time. `terminal_run` carries an optional existing
`sessionId`, never a program.

This is the Plan B property, extended one caller outward. The renderer was already
untrusted; the model is untrusted **and steerable by content that entered its context**. The
id indirection means the worst a poisoned context can name is a tool the user has already
registered, enabled and verified — and the user still has to approve the call. The blast
radius of a successful injection is therefore "one thing you already installed, that you
also clicked Approve on", not "any binary on the disk".

**Rejected: let the model pass a path and validate it.** A validator is a list of
exceptions that grows: `validate_executable_path`'s own allowlist was flagged in Plan B
review for returning a bare name without an `is_file` check. An id has no exceptions to
accumulate, because it is resolved against a record the user created.

**The endpoint stays pinned.** `ollama.rs` `BASE_URL = "http://127.0.0.1:11435"` remains a
constant. Nothing in this design accepts a host, port or URL from a preference, an IPC
payload, or model output; the `endpoint_is_pinned_to_the_isolated_lab` and
`every_url_this_module_builds_stays_on_the_pinned_origin` tests keep passing unchanged.
Giving the model tools does not give it a way to choose who it is talking to.

## Decision 4 — the approval pause holds the single-flight slot, with its own deadline

A turn awaiting approval keeps the single-flight slot. `APPROVAL_TIMEOUT = 300s` bounds one
pending call; on expiry the turn ends with `approval_timeout` and frees the slot.

**Why hold the slot.** Releasing it would let a second turn start while the first holds a
half-executed plan and a message list mid-flight. The approval would then land against an
ambiguous state — which turn does the `callId` belong to, and which message list does the
tool result get appended to. Holding is the simpler invariant: one turn, one pending call,
at most.

**Correction.** This decision originally claimed that `APPROVAL_TIMEOUT`
matching `TOTAL_TIMEOUT` meant "one number answers how long a single turn may live, whether
it is waiting on the model or on a human." That was never true once the turn became a loop
of up to `MAX_TOOL_STEPS` steps: `TOTAL_TIMEOUT` is restarted fresh inside `stream_one_response`
on every step, and `APPROVAL_TIMEOUT` is restarted fresh inside `await_approval` on every
step, so nothing shared a clock across steps. The turn was already bounded — `MAX_TOOL_STEPS`
caps the loop, and each step's two waits are individually capped — but only as the emergent
sum of independently-resetting per-step clocks, not as a real single deadline. The worst case
was, and had always been, `MAX_TOOL_STEPS × (TOTAL_TIMEOUT + APPROVAL_TIMEOUT)` = `5 × 600s` =
**3000s (50 minutes)** holding the single-flight slot, not the 300s the prose implied.

The code now makes that number real instead of implicit: `TURN_TIMEOUT` (`commands.rs`) is a
single deadline captured once at the start of `run_turn` and shared by every step — both the
model-streaming wait and the approval wait draw down the *same* remaining budget, so a slow
early step leaves correspondingly less for a later one, rather than every step re-earning a
full fresh allowance. `TURN_TIMEOUT = MAX_TOOL_STEPS * (TOTAL_TIMEOUT + APPROVAL_TIMEOUT)` =
3000s, chosen to equal the true existing worst case rather than a new, tighter, unjustified
number: reusing `TOTAL_TIMEOUT` (300s) alone for the whole turn, as the original prose
implied, would be wrong in the other direction — a legitimate multi-step turn needs both
model time *and* paced human review time for each of up to five approvals, and 300s total is
not enough runway for that. Expiry now ends the turn with the distinct code `timeout_turn`
(not `approval_timeout` or `timeout_total`), because it means the turn's shared budget ran
out, which is a different fact than any one response or any one approval overrunning its own
individual limit — and because the audit entry it produces should say which of the three
actually happened.

**Why not an indefinite pause.** A pause with no deadline is an assistant that is silently
"busy" with nothing to show for it. The realistic path is not a user staring at a card — it
is a user who closed the panel, switched workspace, or walked away, after which the only
recovery is restarting the app. `TURN_TIMEOUT` (50 minutes, worst case) bounds that exposure;
it is looser than the original 300s claim, but it is the honest number, and it is now a real,
enforced ceiling rather than something that happened to fall out of unrelated per-step
constants.

**Why cancel must reach a waiting turn.** `assistant_cancel` drops the pending sender so the
waiter wakes with a receive error rather than hanging until the deadline. A Stop button that
only works while tokens are streaming would be a lie at exactly the moment it matters most —
the instant before a side effect.

**Rejected: a renew/heartbeat ("still there?").** Cheap to build, and it converts the
deadline into something the UI can extend forever, which is the indefinite pause again
through a side door.

## Decision 5 — the action log records shape, not content

Tool audit entries carry the tool name, the decision and the outcome code. They do **not**
carry the command text, the model's stated rationale, or the tool's output. This follows
`audit.rs`'s existing rule and its reasoning rather than restating it: a transcript already
lives in preferences where the user can see and clear it, and a second copy in a store the
"clear chat" control does not reach would make that control a lie.

This is a genuine tension, so state it rather than glossing it. The skeleton demanded "a
local action log", and a log without the command answers a narrower question than one with
it. The judgement made here: the exact command *is* visible — in the approval card at the
moment it matters, and, for `terminal_run`, in the terminal scrollback the user owns
afterwards. The audit log's job is "what was proposed, and what did I decide", not "what
exactly was typed". If content is ever added, retention and clearing must be decided first,
and that is another ADR.

**Known weakness, accepted for now.** The log is the in-memory `AuditLog`, bounded at 200
entries, and it dies with the process. **It is also not readable by the user**: `entries()`
is `#[cfg(test)]` and no command exposes it, so today the log serves debugging and future
persistence, not the user's own review. The fourth precondition is therefore met in the
weakest form that is still honest — weaker than "a local action log" suggests on its face,
which is why it is spelled out here rather than left to be discovered. What the user can
actually see is the approval card at the moment of decision, and the terminal scrollback
afterwards. Exposing the log, and persisting it, are follow-on work blocked on a retention
decision, not on effort.

## What is still not possible

- No file writes. No reads of file *content* — ADR 0010's metadata-not-content decision is
  untouched, and `read_context` returns records, not files.
- No network request the model can originate, and no second endpoint: one pinned loopback
  origin, no cloud provider. ADR 0004's outbound contract stands.
- No clipboard access, no credential access, no elevation.
- No background activity. A tool runs only inside a turn the user started, and only after
  the user approved that specific call.
- The model cannot name an executable, a path, a working directory, a host, a port or a URL.
- A browser build reaches none of this: the client reports `unavailable` and no approval can
  be driven there.

## Risks accepted

1. **Prompt injection now has something to reach.** ADR 0010's Faz 2 note said the real
   boundary against injected instructions was that "the model has no tools — an injected
   instruction has nothing to reach." That guarantee has expired with this ADR and must not
   be quoted as current. What replaces it is weaker and should be described as what it is:
   a closed three-name allowlist, per-call human approval, and id-not-path resolution. What
   is explicitly **not** claimed is that showing a summary proves the user understood it. A
   user who approves everything is protected only by Decision 1.
2. **`terminal_run` is the widest surface here**, and its containment is visibility, not
   capability (Decision 1).
3. **Approval fatigue** degrades the guarantee over time in a way no test can catch. It is
   bounded by the allowlist and by `MAX_TOOL_STEPS`, not eliminated.
4. **The summary is the model's rendering of its own request.** It is shown as plain text so
   a proposal cannot disguise itself as UI, and it is built from the parsed call rather than
   free prose — but the argv is the ground truth and is what the user should read.
5. **Opting into auto-approved reads** removes the per-call pause for project metadata
   entering the model's context. Default off; the block is bounded; nothing side-effecting
   is reachable through it.

## What requires another ADR

- **Any fourth tool** — and equally, widening an existing tool's arguments into a new kind
  of action (a path argument, a URL argument, a write).
- **Any auto-approve, "remember this", or session-scoped grant for a side-effecting tool.**
- **Any endpoint that is not the pinned constant**, and any cloud provider for this
  assistant.
- **Persisting the action log, or putting content into it** — retention first (see
  Decision 5 and `audit.rs`).
- **Removing the approval deadline**, or raising `MAX_TOOL_STEPS` materially.
- **Turning the agent on by default**, or advertising the tool schema on any weaker
  condition than the conjunction in Decision 1b. Defaulting it on would hand the capability
  to every existing user of a narrower feature without a deliberate act on their part, which
  is the specific thing that decision exists to prevent.

**Amendment 2026-09-30.** See ADR 0014. Private Lab grant is a native dialog. The renderer still answers the inline approval card.
