# Qutra Labs — Redesign (Design / Spec)

**Date:** 2026-08-11
**Author:** Mert Olgun
**Status:** Approved

## 1. Motivation

Qutra Labs is a mature Tauri 2 + React 19 + SQLite workbench, but in daily use it
feels dysfunctional. Root-cause analysis found the pain is concentrated in a few
specific places, not in the codebase quality:

1. **Native build is blocked by the project path.** The working copy lives under
   a folder named `28''` (two apostrophes). `tauri-winres` escapes the icon path
   as `28\'\'`, which `RC.EXE` cannot parse, so `cargo build`/`tauri build` fail
   (proven in `docs/NATIVE_BUILD_BLOCKER.md`). With native builds broken, the app
   is run in **browser mode**, where — by design — the local LLM, native terminal,
   tool supervisor and Mica/Acrylic materials are all unavailable. This single
   blocker explains most of the "nothing works" experience.
2. **Terminal is not a real terminal.** `TerminalPage.tsx` is a passive
   tool-output console, not an interactive shell/PTY. Interactive tools (e.g. the
   SET menu) cannot run in it.
3. **Tool integration model does not fit GUI/interactive tools.** The lab is built
   around SARIF/Nmap-producing batch CLIs. GUI tools (Wireshark) and interactive
   menu CLIs (SET) do not fit that model, so they "can't be connected".
4. **The assistant is a cramped side panel.** The Ollama integration exists in
   Rust (`src-tauri/src/assistant/`) but the UI (`LocalAssistantChat.tsx`) is a
   ~420px box with no markdown, no code blocks, no multi-conversation, and it only
   chats — it cannot act.
5. **Themes/Acrylic don't work** because native window effects require the native
   build (see #1), and the current design system deliberately bans glass/gradient.

The goals are: a modern, multi-theme UI; a real interactive terminal; the
ability to launch lab tools like SET and Wireshark; a full ChatGPT/Claude-style
local LLM experience; and — most importantly — an **agentic assistant ("Jarvis")
that can actively drive the terminal, tools and lab** as a second operator.

## 2. Goals

- Unblock native builds so every native capability is testable and real.
- Replace the passive terminal with a **real interactive PTY terminal**.
- Add a **universal tool launcher** that can launch GUI, interactive-CLI and
  batch-CLI tools, routing each to the right surface, tracked by the lab.
- Rebuild the assistant into a **full-screen, agentic Jarvis**: rich chat plus an
  approval-gated agent loop that can drive the terminal, launch tools, and read
  lab/project context.
- Redesign the UI with a **multi-theme system** (acrylic-dark, hacker-green,
  clean-light, high-contrast) and make **native Mica/Acrylic** real.
- Refocus the app around **lab + tools + terminal + assistant**; keep the other
  modules but demote them to a secondary tier.

## 3. Non-Goals

- Code signing / distribution (deferred; needs a certificate).
- Cloud AI providers (explicitly out of scope; local-only).
- Jarvis Instagram (separate project).
- Deep per-tool custom panels (e.g. in-app tshark capture list) in the first
  release — the universal launcher ships first; custom panels come later.
- vLLM / multi-user serving (single-user desktop only).

## 4. Guiding Principles (retained from the current product)

These stay because they are the backbone of safe white-hat lab work and they
match the assistant's action model:

- **Honest runtime boundary.** Browser mode reports native actions as unavailable
  and never fakes success. This survives the redesign.
- **Authorization-first.** Target-bearing network/web tools still require an
  acknowledged engagement scope.
- **Every side-effect is visible and approvable.** The agent proposes; the human
  approves. No silent install/elevate/execute. No arbitrary unrestricted runner.
- **Local-first, no telemetry, secrets never in frontend storage.**
- **Accessibility (WCAG 2.2 AA) and full keyboard operation** remain targets.

## 5. Architecture Overview

The work is **phased**. Existing infrastructure is kept and built upon; the UI
layer is rewritten. Terminal state:

```
Phase 0  Unblock       →  Move working copy to an ASCII path; verify native build.
Phase 1  Core engine   →  PTY terminal, universal tool launcher, agentic Jarvis.
Phase 2  UI redesign   →  New shell/layout, multi-theme, native materials.
```

Each phase is independently verifiable and leaves the app in a working state.

### 5.1 Layers (unchanged foundation)

- **Rust core (`src-tauri/src`)** — supervisor, tool registry, assistant broker,
  consent, secure storage, validation. Extended, not replaced.
- **DesktopBridge** — typed IPC boundary between renderer and Rust. New commands
  are added here (PTY, agent tools) with matching browser-mode stubs.
- **React 19 UI (`src/`)** — rewritten shell, features, styles. Domain logic under
  `src/domain`, DB/migrations under `src/lib/db` are reused.

## 6. Phase 0 — Unblock Native Builds

- Relocate the working copy to an ASCII, apostrophe-free path (e.g.
  `C:\Dev\QutraLabs`). The move is the cleanest,
  permanent fix — junctions do not work (cargo canonicalises through them).
- After the move: `npm ci`, `cargo test --manifest-path src-tauri/Cargo.toml`,
  `npm run tauri dev` must succeed.
- **Exit criteria:** native dev build launches; `cargo test` passes from the new
  path; the packaged smoke script runs.

> Note: the native build fails when the project path contains an apostrophe.
> Phase 1 native work needs the repo at an ASCII path.

## 7. Phase 1 — Core Engine

### 7.1 Real PTY Terminal

**Rust:**
- Add a `terminal` module using the `portable-pty` crate (wezterm's PTY layer) to
  spawn a shell (PowerShell 7 `pwsh` preferred, fallback to `powershell`, and
  `bash` when present, e.g. WSL/Git Bash).
- Commands: `terminal_open(shell, cwd)` → session id; `terminal_write(id, bytes)`;
  `terminal_resize(id, cols, rows)`; `terminal_close(id)`. Output streams to the
  renderer as `terminal://data` events carrying `{ id, bytes }`.
- Sessions are supervised: bounded buffering, process-tree cleanup on close,
  cancellation, and an emergency "kill all sessions" control.

**Frontend:**
- Render with **xterm.js** (+ fit addon). A terminal surface supports input,
  resize, copy/paste, and search.
- **Multiple sessions as tabs** (the multi-tab-capable model was chosen).
  A tab may be a plain shell or a tool session (see 7.2).
- Browser mode: the terminal surface shows the honest "native runtime required"
  empty state instead of a fake shell.

### 7.2 Universal Tool Launcher

Extend the existing tool registry (`src/domain/tools/registry.ts`,
`src-tauri/src/tool_registry.rs`) with a **launch kind** per tool:

| Kind | Example | Launch behaviour | Tracking |
|------|---------|------------------|----------|
| `gui` | Wireshark | Spawn detached external process (opener/supervisor). | Lab records launch event + provenance. |
| `interactive-cli` | SET | Open a **new PTY terminal tab** running the tool's command. | Session tracked; transcript retainable as evidence. |
| `batch-cli` | nmap | Run via existing supervisor with args profile + parser + evidence. | Existing run/finding/evidence pipeline. |

- Registration keeps canonical executable identity, SHA-256, Authenticode state,
  change detection and trust renewal (existing).
- Target-bearing network/web tools still require an active authorization scope.
- One-click **Launch** picks the surface automatically from the kind.
- Custom deep panels (per-tool UIs) are explicitly deferred.

### 7.3 Agentic Jarvis Assistant

**Backend (extends `src-tauri/src/assistant/`):**
- Keep **Ollama** as the default engine (already integrated; has a native
  tool-calling API). Architect the broker with a **pluggable backend interface**
  so a llama.cpp / LM Studio OpenAI-compatible server can be added later for
  speed (speculative decoding / MTP). Default model recommendation: **Qwen3**
  (native tool calling) or another installed tool-capable model.
- Add an **agent loop**: send the conversation plus a JSON **tool schema**; when
  the model returns `tool_calls`, the broker pauses and emits an **approval
  request** to the UI; on approval it executes the tool, feeds the result back,
  and continues until the model returns a final answer.
- **Allowlisted agent tools only** (no arbitrary runner):
  - `terminal_run(session?, command)` — send a command to a terminal session
    (creates one if needed).
  - `launch_tool(toolId, args?)` — launch a registered lab tool.
  - `read_context(kind)` — read active project, registered files metadata, lab
    findings/evidence summaries (read-only).
- **Approval gate is mandatory** for every side-effecting tool
  (`terminal_run`, `launch_tool`). `read_context` is read-only and may be
  auto-approved by a user setting. Approvals show the exact command/args.
- Single-flight, cancellation, timeouts and audit logging from the existing
  broker are retained and extended to cover tool calls.

**Frontend (replaces `LocalAssistantChat.tsx` / `JarvisPage.tsx`):**
- **Full-screen chat**: markdown rendering, syntax-highlighted code blocks with a
  copy button, streaming, stop, regenerate.
- **Multiple saved conversations** (persisted locally, bounded), model picker,
  editable system prompt, temperature/context settings surfaced in the UI.
- **Inline approval cards** in the transcript for agent tool calls, showing the
  proposed action and Approve/Reject; results (terminal output, launch status)
  render inline and link to the relevant surface.
- Honest disclosure of what context is attached to each turn (retained from the
  current design).

## 8. Phase 2 — UI Redesign & Theme System

- **Shell/layout:** keep the workbench concept but rebuild it visually. The
  navigation is refocused into a **primary tier** (Assistant/Jarvis, Terminal,
  Security Lab, Tools) and a **secondary tier** (Overview, Projects, Files,
  GitHub, System) that is demoted/collapsible. No working feature is removed.
- **Assistant and Terminal become first-class full surfaces.**
- **Theme system** expands the existing token/ThemeStudio setup with switchable
  presets:
  - `acrylic-dark` — dark, Windows 11 acrylic/mica translucency, soft accents,
    ChatGPT/Claude-style roomy chat.
  - `hacker-green` — near-black, neon-green/amber monospace accents, "cyber lab".
  - `clean-light` — Linear/Vercel-style clean light + dark, minimal.
  - `high-contrast` — always opaque, accessibility.
- **Native Mica/Acrylic** via Tauri window effects (`windowEffects.ts`) — now
  functional because native builds work. CSS acrylic fallback in browser dev.
- Component pass: modern radii, soft accents, motion within the existing
  reduced-motion rules.

## 9. Documentation Changes

- Update `PRODUCT.md` and `DESIGN.md` to reflect the new direction: agentic
  assistant as a primary surface, real terminal, refocused navigation, expanded
  materials/themes.
- New ADRs:
  - PTY terminal (portable-pty + xterm.js, session model, cleanup).
  - Agentic tool-calling (allowlisted tools, approval gate, audit).
  - Theme/materials (multi-theme presets, native Mica/Acrylic, browser fallback).
- Keep `NATIVE_BUILD_BLOCKER.md`; add a note that Phase 0 resolved it by
  relocation.

## 10. Testing & Verification

Every phase must pass the existing gates before it is considered done:

- `npm run typecheck`, `npm test` (vitest), `npm run test:e2e` (playwright),
  `npm run build`.
- `cargo test` from the ASCII path.
- Packaged-app smoke test.
- New coverage:
  - PTY: session lifecycle, resize, process-tree cleanup, browser-mode stub.
  - Launcher: kind→surface routing, scope enforcement for target-bearing tools.
  - Agent: tool-schema round-trip, approval gate blocks unapproved side-effects,
    cancellation mid-tool-call, audit entries.
  - Browser/native honesty parity for all new surfaces.

## 11. Risks & Open Questions

- **Apostrophe in the project path** — the native build needs an ASCII path, so
  a checkout under such a path must be moved or re-cloned (see §6).
- **PTY on Windows** — `portable-pty`/ConPTY quirks with certain shells; verify
  `pwsh`, `powershell`, and `bash`/WSL behaviour.
- **Agent safety** — the approval gate and allowlist are the primary control;
  no code path may let the model reach an un-gated executor.
- **Interactive tools that expect a full TTY** (SET) — confirm they behave in the
  xterm.js/ConPTY session; fall back to launching in an external terminal if not.
- **Model availability** — the agent needs a tool-calling-capable model installed
  (Qwen3 / Llama 3.3); the UI must detect and guide when none is present.

## 12. Rollout

Phase 0 → Phase 1 (terminal → launcher → Jarvis) → Phase 2 (shell → themes →
component pass). Each phase merges only when its gates pass and the app remains
in a working, honest state in both browser and native runtimes.
