# Qutra Labs — Shell Specification

This replaces the nine-destination workbench. It does **not** replace any feature.
Read this before editing anything under `src/app/`.

## 0. The one law

> **A capability is not a destination.**

There are three places a user can *be*. Everything else is reached from where they already are — by palette, by panel, or inline. When you are tempted to add a fourth rail item, you are adding a destination; the answer is a palette command.

## 1. Regions

Today: five competing regions. Target: three.

```
┌─ Titlebar (40px) ─────────────────────────────────────────────┐
│ ◧ Qutra Labs   [Work] [Assistant] [Lab]        ⌘K   ⚙   ◨    │
├──────┬──────────────────────────────────────────┬────────────┤
│      │                                          │            │
│ Rail │            Surface                       │  Context   │
│ 52px │            (the work)                    │  360px     │
│      │                                          │ collapsible│
└──────┴──────────────────────────────────────────┴────────────┘
```

| Region | Rule |
|---|---|
| **Titlebar** | Surface switcher lives here as a segmented control — three items, always visible, never truncating. Palette trigger, settings, context-panel toggle. |
| **Rail** (52px) | Icon-only, **contextual to the active surface**. In Work: the open sessions. In Lab: the engagement. In Assistant: the conversations. It is never a list of nine modules. |
| **Surface** | Where work happens. Owns its own tab strip when it needs one (Work does; Lab and Assistant do not). |
| **Context panel** (360px) | One panel, segmented. Replaces both `Inspector` and `BottomPanel`. Below 1100px it overlays instead of pushing. |

Deleted as regions: the nine-item `ContextSidebar`, the cross-surface `WorkspaceTabs`, the separate `BottomPanel`, the Lab's second sidebar. Their **behaviour** moves; their **capabilities** do not disappear.

## 2. The three surfaces

### 2.1 Work — the default landing surface

Terminal sessions and tool runs, as tabs, in one place. This is the app's centre of gravity and it should open here.

- A tab is a PTY session, a supervised tool run, or a GUI-tool launch record.
- The tab strip belongs to this surface only. It never contains "Settings" or "GitHub".
- Stop-all stays reachable without opening a menu.
- Browser mode shows the honest unavailable state once, in the surface, not per tab.

### 2.2 Assistant — full-screen Jarvis

The spec's §7.3 frontend, finally built.

- Markdown with syntax-highlighted code blocks and copy.
- Streaming, stop, regenerate.
- Approval cards inline in the transcript, showing the exact action — never a bare UUID. (A past review caught exactly that bug because every test fixture used a prettier id than production.)
- Saved conversations in the rail.
- Model picker showing each model's real capabilities from `/api/show`, including "no tool support" with an explanation.

### 2.3 Lab — engagement work

The eight Lab views (`overview`, `scope`, `methodology`, `guides`, `runs`, `findings`, `evidence`, `tools`) become a **segmented control inside the surface**. They were never top-level product modules; `PRODUCT.md` already says so. Stop rendering them as a sidebar.

## 3. Where the other six capabilities go

Nothing here loses function. Each one loses only its claim to a rail slot.

| Capability | New home |
|---|---|
| **Overview** | Becomes Home — reached by the Qutra mark in the titlebar and by `Ctrl+K`. Renders live state (see §5). |
| **Projects** | Context panel segment "Project", plus palette. The active project is shown in the titlebar and scopes the other surfaces. |
| **Files** | Context panel segment "Files", scoped to the active project. Palette for global search. |
| **Tools** | Registration and verification: palette command opening a focused dialog. Launching: from Work, from Lab, and from the assistant's approval cards. Launch is the common path and belongs where work is. |
| **GitHub** | Context panel segment "Repo" when the active project has a remote. Palette otherwise. |
| **System / Settings** | Full-window modal over the current surface, sectioned, searchable, opened by `Ctrl+,` and by the gear. Never a navigation destination — you do not "go to settings", you adjust and return. |

## 4. The palette is the navigation

`Ctrl+K` is not a search box bolted on. In the new shell it is the primary way to reach anything not currently on screen. It must cover:

- every route, including the six demoted ones,
- all eight Lab views,
- every Settings section, by name,
- every registered tool, with Launch as the default action,
- actions, not just places: "New terminal", "Stop all", "New engagement", "Start local AI lab".

If something is reachable only by mouse, it is a bug.

## 5. Home is a dashboard, never a greeting

Delete "Good evening". Home renders, in this priority order, showing only sections that have content:

1. **Pending approvals** — they block the user. Top, always.
2. **Running** — live PTY sessions and in-flight tool runs, with stop.
3. **Active engagement** — scope state, target count, unresolved findings.
4. **Recent runs** — last five, with outcome and a link into Lab.
5. **Resume** — last project, last session, last conversation.

Genuinely empty state offers the two or three actions that create something. It does not narrate.

## 6. Keyboard model

| Key | Action |
|---|---|
| `Ctrl+K` | Palette |
| `Ctrl+1/2/3` | Work / Assistant / Lab |
| `Ctrl+,` | Settings modal |
| `Ctrl+B` | Toggle context panel |
| `Ctrl+Shift+Space` | Quick capture (existing) |
| `Ctrl+T` / `Ctrl+W` | New / close tab, **within Work only** |

Full keyboard operability and visible focus are retained targets — this is going to be a product. Focus returns to its origin when the Settings modal or any dialog closes.

## 7. What must not change

These are load-bearing and a shell rewrite is exactly where they get broken by accident.

1. **Honest runtime boundary.** Browser mode reports native actions as unavailable and never fakes success. No new surface may simulate a native result.
2. **The approval gate.** The model proposes; the human approves; Rust enforces. No new UI path may reach an executor without passing the gate.
3. **Tool identity.** The renderer never names an executable path or working directory on any launch route. It passes an installation id; Rust resolves it through `resolve_launchable` with a live SHA-256 re-hash. A new Launch button in a new place must use the same call.
4. **Secrets stay out of the renderer.** GitHub tokens live behind the Rust broker. Do not "simplify" that back into the frontend.
5. **Six locales.** Every new string goes into all six locale files. The naming split (internal id `contextos`, product name "Qutra Labs") is guarded by a test — do not "fix" it.
6. **Accessibility.** WCAG 2.2 AA is a product target, not an aspiration. New components ship with their focus, keyboard and screen-reader behaviour, and the axe suite stays green.

## 8. Migration order

Do these as separate commits with the gate green between each. Do not attempt the whole shell in one change.

1. Titlebar surface switcher, routing to the three surfaces. Old sidebar still present.
2. Palette coverage to 100% — every route, Lab view, Settings section, tool. **Before** anything is demoted, so nothing becomes unreachable.
3. Lab sub-nav to a segmented control inside the Lab surface.
4. `Inspector` + `BottomPanel` merged into the one context panel.
5. `WorkspaceTabs` scoped to Work only.
6. `ContextSidebar` replaced by the contextual rail.
7. Home rebuilt as the dashboard.
8. Dead CSS, dead components and dead tests removed — **last**, once nothing references them.

Step 2 before step 6 is the rule that prevents the classic shell-rewrite failure: demoting a destination before the palette can reach it, and silently orphaning a feature.
