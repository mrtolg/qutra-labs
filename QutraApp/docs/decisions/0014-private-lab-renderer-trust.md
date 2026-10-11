# ADR 0014 — What Private Lab still trusts the renderer with

**Status:** accepted · 2026-09-30

## Context

The decision: a native confirmation when Private Lab is granted. Assistant
approvals stay on the in-app card. A native dialog on every assistant action was
rejected because it would not close the terminal path and would break that card.

`request_private_tools_grant` is the only IPC path that turns consent on. The
renderer passes a locale code. The words are a table in Rust
(`consent_grant::dialog_copy`). `revoke_private_tools_consent` needs no dialog.

## Decision

**A compromised renderer cannot turn Private Lab on in a profile that never
enabled it.** Revoking needs no confirmation, because it is the safe direction.

**With Private Lab on, a compromised renderer has the user's shell.**
`terminal_write` (`src-tauri/src/terminal/commands.rs`) has no consent check by
design: the user's own keystrokes travel through it. The renderer can also
answer the assistant's inline approval card (`assistant_approve_tool`) and
launch registered tools (`launch_tool_detached`). All of it runs at the user's
account privilege, as in any app with an embedded terminal. A native dialog per
assistant action would not close the terminal path.

**The dialog has no default-button control** in tauri-plugin-dialog 2.7.2, and
a user can be talked into clicking it. This ADR does not invent a workaround.

**The terminal's shell sits outside the registered-tool identity guarantee**
(security review 2026-09-30, finding 6). `resolve_shell` (`src-tauri/src/terminal/mod.rs`) walks the
inherited PATH for `pwsh.exe` and `powershell.exe` and returns those bare
names. The last fallback takes the inherited `%COMSPEC%` when it is non-empty,
with no existence check beyond that, and no canonical-path or hash check.
Registered tools resolve an installation id and re-hash. The shell does not.
Whoever controls the user's PATH or COMSPEC chooses the program the embedded
terminal runs. This change does not add shell hashing.

## Consequences

- `set_private_tools_consent` is gone from `generate_handler!`.
- The main window capability still grants the renderer only `dialog:allow-open`.
  The renderer cannot open or answer the message dialog itself.
- One dialog at a time. A decline refuses further grant requests for 10 seconds.
- See ADR 0007 and ADR 0012, which point here and are otherwise unchanged.
