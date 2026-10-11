# Qutra Labs — Design System

**Rev 2, 2026-09-28.** Replaces the July system. Approved against the
canvas in [`docs/design/canvas/`](docs/design/canvas) — open any `.dc.html` there in a
browser next to `hud.css` to see the source of truth. When this file and the canvas
disagree, the canvas wins and this file gets corrected.

Scene: an operator's console used for hours on a Windows machine. Calm, capable,
technical — a JARVIS-style HUD, not a toy and not a generic dashboard. Register:
**product** (design serves the task).

## Why rev 2 exists

The July system banned glow, gradients, decorative backgrounds, card grids and
expressive motion. It succeeded: the app became austere, and it proved
unusable — "dead", with "no reaction when I press a button". Two lessons, both kept:

- **Austerity was not the problem; austerity without identity was.** Identity here
  comes from one strong accent, a typographic signature and a faint texture — not
  from spraying effects. A plain, sharp-cornered lab screen can still have character;
  the July screens had none.
- **The July rules were right about frequency and accessibility, wrong about feedback.**
  Pressing a button is feedback, not decoration. Every accessibility rule survives.

## Colour

Tokens live in `src/styles/tokens.css` / `themes.css` as a theme pack named **`hud`**,
the default for dark mode. Express these values as tokens; never hard-code a hex in a
component.

| Role | Value | Use |
|---|---|---|
| Grounds | `#070b11` `#0b111a` `#0f1721` `#152130` `#1c2b3d` | Layered depth, darkest = window |
| Terminal | `#060a10` | PTY surface |
| Hairlines | cyan-tinted, 12% / 22% / 40% alpha | The default separator |
| Ink | `#e9f2f6` · `#aec2cf` · `#839aa9` | Body · secondary · muted — all ≥ 4.5:1 on grounds |
| **Accent** | **cyan `#37d6e0`**, `#74ecf3` text-safe | Brand, current selection, live state |
| Teal | `#33c3aa` | Secondary identity, progress gradients |
| Amber | `#f2b13c` | **Attention: blocks the user** (pending approvals, warnings) |
| Red | `#ff5f6e` | **Danger only.** Destructive actions, Critical findings. The brand mark's red variant is not this token (see Brand mark) |
| Green | `#46d08a` | Success, verified, exit 0 |
| Focus | `#8ab4ff` | Focus ring — deliberately blue, never confused with cyan "live" |

Rules:

- **The accent is never the danger colour.** In rev 1 the rose primary matched the
  Critical severity colour, so "New engagement" read as a destructive action.
- **Glow means running, nothing else** (the quiet HUD, 2026-10-10). A cyan glow
  marks something live or running right now: a running scan, a live session dot, the
  running-work panel. A pending Jarvis approval keeps its amber glow because it is a
  live request. Selected tabs, the step guide, hover states, primary buttons and panel
  backgrounds never glow; they are flat with hairlines. If glow appears on something
  static, it stops meaning anything.
- **State is never colour alone.** Chips carry an icon and a word (`✓ Verified`,
  `● Live`, `▲ 1 High`); dots sit beside a label.
- **One data-colour exception: GitHub's language colours** (a deliberate exception). They are data,
  not identity, and users recognise them from GitHub. They live in one constant,
  `GITHUB_LANGUAGE_COLORS` in `src/features/github/languageColors.ts`; the dot always
  sits beside the language name; high contrast paints it `--ink`. No other component
  hard-codes a hex (`languageColors.test.ts` checks every `.tsx`).

Light mode and high contrast: the existing high-contrast pack stays and must keep
working. A light HUD variant is **not designed yet** — do not invent one; until it is,
light mode keeps the current light pack.

## Typography

- **UI:** `Segoe UI Variable Text` → `Segoe UI` → `system-ui`. Display headings use
  `Segoe UI Variable Display`. Native Windows 11 feel.
- **Readouts in mono:** timers, commands, paths, hashes, ids, ports, counts —
  `Cascadia Mono` → `Consolas`. The mockup names JetBrains Mono first; the app may only
  use it **self-hosted** (OFL, fine for MIT), never from Google Fonts — the CSP forbids it.
- **The signature:** section and state labels are small uppercase with wide tracking
  (`11px / 600 / letter-spacing .10em`), e.g. `PENDING APPROVALS`, `SESSION ACTIVE`.
  Counters are zero-padded where they read as instruments (`03 / 09`).
- Scale 11 / 12 / 12.5 / 13 / 14 / 15.5 / 20 / 21 px. Body 13 px. No viewport-scaled type.

## Space, shape, texture

- 4 / 8 px spacing rhythm.
- Radii: controls 8 px, rail and switcher 9 px, panels 13 px, tool boxes 15 px, chips pill.
- **Borders structure the screen;** shadows only on floating layers and glows.
- **No texture or coloured light on the ground** (2026-10-10). The grid texture
  and the cyan/teal radial washes behind the window were removed: the ground is the flat
  `--bg`, and depth comes from the layered grounds and hairlines.
- Neutral gradients (surface to surface) are allowed on panels; a gradient tinted with
  the accent is not.

## Layout — three surfaces

Full spec: [`docs/design/shell-spec.md`](docs/design/shell-spec.md).

```
Titlebar 44 px · mark · QUTRA LABS · [Work][Assistant][Lab] · Search Ctrl K · ⚙
Rail 52 px (contextual to the surface) │ Surface │ Context panel
```

- The **segmented switcher** in the titlebar is the only cross-surface navigation
  besides `Ctrl+K`. There is no nine-item sidebar.
- The **rail** belongs to the current surface: open sessions in Work, conversations in
  Assistant, the engagement in Lab.
- **Home** is a live dashboard, never a greeting. Priority order: pending approvals →
  running sessions and tool runs → active engagement and scope → last runs → resume.
  Only sections with content render. Rich **and real** — no invented numbers.
- **Tabs belong to Work only** (terminal sessions and tool runs). Nielsen Norman: if tabs
  do not fit one row, simplify the design rather than improving the overflow menu.

## Components

- **Buttons** — `.btn` default, `--primary` (cyan gradient, dark ink), `--ghost`,
  `--danger`, `--sm`. Every button presses down on `:active` (see Motion).
- **Icon buttons** — 32 px, `aria-label` required.
- **Chips** — pill, icon + label, variants `live` / `ok` / `warn` / `danger` / `muted`.
- **Panels** — hairline border, 13 px radius; `--live` (cyan glow) only for running
  work, `--attn` an amber edge (no glow) for content that waits on the user. Corner ticks (`.ticks`) on at most
  the one or two priority panels per screen.
- **Tool launcher box** — two faces in one fixed frame. At rest: large logo, name,
  status chip, centred. On hover **or keyboard focus**: the large logo shrinks and rises
  as it fades, and the small logo, purpose line and actions rise in behind it. The frame
  never moves or reflows its neighbours. Actions: **Open in app** (embedded terminal) and
  **Admin CMD** (separate elevated window). Not-installed tools show an honest
  `Not installed` state with *Locate…*, never a fake launch.
- **Approval card** — `--attn` panel stating what Jarvis wants to do in words, then the
  exact command in mono, then scope / risk / identity chips, then Approve & run
  (primary) and Reject (danger). Never a bare id.
- **Tab close** is a real sibling `<button>`, not a `role="button"` span nested inside the
  tab button (the mockup nests it; the build must not).

Tool logos in the canvas are monogram placeholders. Real vendor logos are trademarks;
using them is a product decision and needs each vendor's terms.

## Motion

Rules, from Emil Kowalski's design-engineering standards and NN/g
response-time research:

- **Animate only `transform` and `opacity`.** Name every transitioned property —
  never `transition: all` or a bare duration, which animates layout by accident.
- **Buttons press:** `transform: scale(.97)` on `:active` (icon buttons `.95`),
  160 ms, `cubic-bezier(.23,1,.32,1)`. The feedback people feel most.
- **Durations:** press 100–160 ms · small popovers 125–200 ms · menus 150–250 ms ·
  dialogs 200–300 ms. Nothing in the UI over 300 ms.
- **Easing:** enter/exit `ease-out`; moving/morphing `ease-in-out`; colour `ease`.
  Never `ease-in`. Never start from `scale(0)` — use `.9`+ with opacity.
- **`display` does not animate.** To reveal, keep the element laid out and fade/translate
  it (see the tool box).

Frequency decides whether something animates at all:

| How often | Motion |
|---|---|
| Hundreds of times a day — surface switcher, rail, tabs, palette, terminal output | **None.** Instant. |
| Tens of times a day | Opacity only, ≤ 150 ms, or none |
| Occasionally — dialogs, menus, tool box reveal | Standard |
| Rare — first launch, finishing an engagement | Delight allowed |

**Nothing loops except what blocks the user.** The amber pending-approval dot pulses;
live cyan dots hold a steady glow; the terminal caret blinks. Six simultaneous pulses
on a screen that stays open for hours is noise.

**Reduced motion** (`prefers-reduced-motion` and the in-app setting): keep opacity and
colour transitions, drop all movement and every loop.

## Accessibility

WCAG 2.2 AA. Unchanged from rev 1 and not negotiable:

- Full keyboard operation — `Ctrl+K` palette, `Ctrl+1/2/3` surfaces, `Ctrl+,` settings,
  arrows in menus and palette. Anything that opens on hover also opens on focus.
- 2 px `#8ab4ff` outline on `:focus-visible`, offset 2 px. Focus returns to its origin
  when a dialog closes.
- Text ≥ 4.5:1 on its surface (3:1 at 24 px+). Glow and darkness do not excuse contrast.
- `aria-live` for async results; labelled icon buttons; real `<button>`, `<a>`,
  `<input>` + `<label>` — never click handlers on `div`s.
- Pointer targets ≥ 24 px, icon controls ≥ 32 px.
- The skip link moves focus without touching the router's hash.

## Data visualisation

Kept from rev 1: single-series thin bars in one hue, direct labels, recessive grid,
`role="img"` with a table alternative, no dual axes, no invented scores. Progress bars
are 3 px hairlines with a teal-to-cyan fill.

## Brand mark

The **Q+L monogram** — see [`assets/brand/README.md`](assets/brand/README.md).
It replaces the cyan hexagon drawn in the canvas titlebar.

- **The mark takes the theme's identity colour** (design decision). The `hud` pack in dark
  mode shows the **cyan Q**; every other pack and every light mode shows the **red
  Q**; high contrast shows the red Q flat. Both come from the original artwork
  (cyan ring `#073A3D → #37D6E0`, red ring `#600000 → #FF0000`), generated by
  `scripts/build-q-icons.mjs`, the single source.
- In the top bar both variants are vectors (`public/brand/q-mark.svg`,
  `q-mark-cyan.svg`); `app.css` shows the one the theme owns, with a static CSS neon
  glow in the variant's own colour on dark themes and none on light and high contrast.
- It **ignites once** on first paint — two soft dips over ~0.5 s, opacity only.
  App launch is a rare moment, so delight is allowed; it never loops, and reduced
  motion shows it lit immediately.
- The brand red is **not the danger token.** Danger keeps `--danger`; the mark's red
  lives only in the brand files.
- **The window and taskbar icon follow the theme at runtime**: the renderer names a
  variant, the Rust command `set_brand_window_icon` picks one of the two icons
  compiled into the binary (`src-tauri/icons/window-*.png`). The renderer never
  supplies an image or a path.
- The **exe and Start-menu icon are cyan**: the same mark as a neon sign on a dark
  rounded plate, ring centred, optically sized per pixel size.

## Naming

| Name | Where |
|---|---|
| **Qutra Labs** | The product. Titlebar, installer, README |
| **Jarvis** | The assistant, as a persona inside the product ("Jarvis wants to:") |
| `contextos` | Internal id only — package name, app data, db. Never user-visible |

`src/lib/i18n/naming.test.ts` guards the Qutra Labs / `contextos` split; extend it so
"Jarvis" appears only as the assistant's name and never replaces the product name.
