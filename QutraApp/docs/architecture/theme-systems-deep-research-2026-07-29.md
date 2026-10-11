# Theme systems deep research (2026-07-29)

**Status:** Research only — no implementation.  
**Product:** Qutra Labs / Qutra Labs (Tauri 2 + React + WebView2).  
**User intent:** When ordered, wipe existing theme surface completely; rebuild from the best Windows transparency + Liquid Glass + marketplace-class theme systems after research.

**Independent review:** This discovery document has been corrected by
[`theme-system-independent-verification-2026-07-29.md`](theme-system-independent-verification-2026-07-29.md).
Where wording differs, the independent verification and the reviewed design
spec are authoritative. In particular: packs never own material; Mica does not
silently fall back to full-window Acrylic; Liquid Glass is an inspired
chrome treatment; community repository popularity is not approval evidence.

---

## 0. What “theme” actually means (three different products)

People say “theme” for three incompatible layers. Mixing them causes bad UX and bad perf.

| Layer | What it is | Who owns it | Qutra Labs analog today |
| --- | --- | --- | --- |
| **A. OS window material** | Desktop compositor paints window chrome: Mica, Acrylic, blur, macOS vibrancy / Liquid Glass | OS DWM / AppKit | `tauri.conf` `transparent: true` + `syncWindowMaterial()` → `Effect.Mica` / `Acrylic` |
| **B. App semantic UI tokens** | Surfaces, ink, borders, primary, focus — whole shell | Our CSS `data-theme` / `data-mode` | `tokens.css` + `themes.css` + `src/lib/theme.ts` |
| **C. Editor / marketplace palette** | Workbench keys + syntax TextMate / JetBrains editor scheme | VS Code / IntelliJ plugins | Not really a product feature yet (code views are sparse) |

**Critical rule for Tauri on Windows:** Layer A is *not* CSS `backdrop-filter` of the desktop wallpaper. CSS blur only samples pixels *inside* the webview. With a transparent WebView2, CSS `backdrop-filter` often breaks or conflicts with native materials ([WebView2 #4945](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4945), [Tauri #15512](https://github.com/tauri-apps/tauri/issues/15512)). Qutra Labs already chose the right split for Windows theme: **OS material + translucent CSS tokens**, not fake glass on every card (`windowEffects.ts` comment: “No CSS backdrop-filter — OS materials only”).

---

## 1. Current Qutra Labs theme architecture (as of research date)

### 1.1 Runtime flow

```
prefs.theme / themeMode / schedule / highContrast
        │
        ▼
resolveTheme()  ──►  { themeId, mode }
        │
        ▼
<html data-theme data-mode>   (early: public/theme-init.js)
        │
        ├─► CSS: tokens.css base + themes.css overrides
        └─► if themeId === "windows": syncWindowMaterial(true)
                  └─► Tauri setEffects(Mica|Acrylic) + data-window-material
```

### 1.2 Active themes

| Id | Role | Notes |
| --- | --- | --- |
| `contextos` | Brand solid workbench | Default for System |
| `windows` | Current native Mica-then-Acrylic path | Does not currently detect or report the Windows transparency setting; corrected rebuild policy is specified separately |
| `highContrast` | A11y | Forces from prefs.highContrast |

**Retired decorative ids** (mapped → `contextos`): `acrylicClear`, `liquidGlass`, `carbonSignal`, `oceanPulse`, `solarEmber`, `forestTerminal`, `contextRose`. Earlier note in `docs/THEME_REFS.md` praised acrylic-mica-css + nikdelvin for those ids; they were later pulled because CSS glass on a busy workbench failed quality/perf. `vendor/theme-refs/` is currently empty (clones not present).

### 1.3 Authoring contract (good — keep concept after wipe)

From `THEME_AUTHORING.md`:

- Themes are **complete semantic token systems**, not accent swaps.
- Components use only `--primary`, `--surface`, `--ink`, … never hex.
- Contrast tests parse real CSS (WCAG AA ink/bg, primary-ink/primary).
- Theme Studio exports config JSON only (selection/schedule), not arbitrary colors.

This contract is compatible with marketplace-style *palettes* if you map external colors → semantic slots.

---

## 2. Layer A — Windows transparency (Fluent / Mica / Acrylic)

### 2.1 OS materials

| Effect | OS | Owner | Notes |
| --- | --- | --- | --- |
| **Mica** | Win11 | DWM `DWMSBT_MAINWINDOW` etc. | Best “Settings app” feel; wallpaper-tinted; cheapest ongoing |
| **Acrylic** | Win10/11 | DWM | Stronger blur tint; historically worse resize/drag cost |
| **Blur** | Older | DWM | Often broken / bad resize on Win11 22621+ |
| System gate | All | Settings → Transparency effects | Native material must resolve or degrade to an honest solid backdrop |

### 2.2 How apps apply it (Tauri)

Official / best-maintained paths:

1. **`@tauri-apps/api/window` `setEffects` / `clearEffects`** — what Qutra Labs uses today via `windowEffects.ts`.
2. **[`tauri-apps/window-vibrancy`](https://github.com/tauri-apps/window-vibrancy)** — future macOS-specific evaluation only. Tauri 2 already exposes the Windows effects used by this product; adding a Rust dependency for macOS Liquid Glass is outside the Windows-first rebuild.

**Capability policy:** detect Windows transparency, High Contrast, animation,
OS support, and native effect failure. A Mica request resolves to Mica or solid;
it never silently becomes Acrylic. Acrylic is explicit/experimental because
Tauri documents resize/drag performance problems. Persist requested material
separately from the effective backdrop and fallback reason.

### 2.3 CSS companions for Fluent look (not OS sampling)

| Source | Technique | Verdict for Qutra Labs |
| --- | --- | --- |
| Microsoft Fluent/WinUI guidance | Native material and semantic role guidance | Primary design reference |
| [yell0wsuit/acrylic-mica-css](https://github.com/yell0wsuit/acrylic-mica-css) | Pure CSS Fluent Acrylic/Mica *simulation* | Recipe reference only after license, maintenance, security, WebView2, and performance review; never desktop blur |
| [ysfemreAlbyrk/Progressive-Acrylic](https://github.com/ysfemreAlbyrk/Progressive-Acrylic) | Multi-layer blur/luminosity/noise | Experiment only; not an app dependency |
| [microsoft/fluentui](https://github.com/microsoft/fluentui) `@fluentui/react-components` | Full Fluent Design System | Token/naming reference; no wholesale component rewrite |
| WinUI 3 samples | Native XAML materials | Pattern reference only (not Web stack) |

**Performance direction:** Microsoft designs Mica for long-lived app backdrops;
Tauri warns about Acrylic resize/drag cost. CSS filters and WebGL require
project measurements rather than an assumed universal ranking. Never stack
native Mica and a full-tree CSS `backdrop-filter`.

---

## 3. Layer B — Liquid Glass & glassmorphism (Apple + web)

### 3.1 Real Apple Liquid Glass (native)

WWDC25 / iOS 26 / macOS Tahoe: a real-time meta-material (refraction, specular, Regular vs Clear variants, dimming rules). On Tauri:

- macOS 26+: `window-vibrancy` `apply_liquid_glass` is closest *window*-level port.
- WebView cannot run Apple’s private renderer; web “Liquid Glass” is always an approximation.

Apple rules worth stealing for UI policy (from WWDC “Meet Liquid Glass”):

- Prefer Regular glass for chrome that must stay legible everywhere.
- Clear glass only with dimming; don’t mix Regular+Clear casually.
- Glass is for **controls and nav**, not for dumping whole content panes into soup.

### 3.2 Web approximation repos (ranked for Qutra Labs)

| Source | Engine | App-wide chrome? | Perf | Recommendation |
| --- | --- | --- | --- | --- |
| Apple HIG / WWDC25 | Native Apple renderer | Policy reference | Native | Primary interaction and layering guidance; not portable rendering code |
| [nikdelvin/liquid-glass](https://github.com/nikdelvin/liquid-glass) | CSS + SVG `feDisplacementMap`, Safari fallback | Limited surfaces | GPU filters; clamp usage | Audited recipe reference only; packaged WebView2 probe required |
| [JUNGHERZ/GlassKit](https://github.com/JUNGHERZ/GlassKit) | Pure CSS components + tokens | Components | Must measure | Token/component crib after audit |
| [Tontoon7/liquidglass-tailwind](https://github.com/Tontoon7/liquidglass-tailwind) | Tailwind plugin | If on Tailwind | Must measure | Qutra Labs is not Tailwind-first; no dependency |
| [naughtyduk/liquidGL](https://github.com/naughtyduk/liquidGL) | WebGL offscreen snapshot refraction | **No** | Costly if many lenses | Out of P0-P3 |
| [huozhi/vaso](https://github.com/huozhi/vaso) | React glass components | Component | Must measure | Not a theme-system dependency |
| Older “glassmorphism generators” | `backdrop-filter: blur(N)` | Tempting | Nested blur can multiply paint work | Reject as sole strategy |

**W3C note:** Nested `backdrop-filter` / mix-blend can force repeated painting; nesting can approach exponential cost. Policy: glass on titlebar/sidebar/overlays only; solid scrolling content.

### 3.3 Why previous in-app `liquidGlass` / `acrylicClear` failed (inferred)

Busy workbench + translucent panels + dense text + WebView2 transparency quirks → contrast failures, muddy charts, scroll jank. Retirement to solid `contextos` was correct engineering; rebuild must treat glass as a **chrome treatment resolved from material preference**, not a “pretty palette swap”.

---

## 4. Layer C — Marketplace themes (VS Code + IntelliJ)

These teach **how high-quality theme ecosystems are structured**, not “paste a VS Code theme into React”.

### 4.1 VS Code theme architecture

A color theme extension ships JSON with approximately:

1. **`colors`** — workbench UI keys (`editor.background`, `sideBar.background`, `activityBar.*`, `tab.*`, …) → **maps cleanly** to our semantic tokens if we define a mapping table.
2. **`tokenColors`** — TextMate scope rules for syntax → only needed if Qutra Labs embeds a code editor (Monaco/CodeMirror/Shiki).
3. **`semanticTokenColors`** — language-service tokens → same.

Marketplace giants (install scale / community quality):

| Theme family | Why it matters | Fit for Qutra Labs UI tokens |
| --- | --- | --- |
| [GitHub Themes](https://github.com/primer/github-vscode-theme) | Most installed; Primer design language | Excellent sober workbench mapping |
| [One Dark Pro](https://github.com/Binaryify/OneDark-Pro) | Classic Atom One Dark; huge installs | Easy dark token crib |
| [Dracula](https://github.com/dracula/dracula-theme) | Cross-app org; disciplined palette | Great multi-surface consistency model |
| [Catppuccin](https://github.com/catppuccin/vscode) | Flavors (Latte/Frappé/Macchiato/Mocha); npm `@catppuccin/vscode` for Shiki | **Best open palette system** to generate many Qutra Labs themes from one schema |
| [Tokyo Night](https://github.com/enkia/tokyo-night-vscode-theme) | Modern night IDE look | Strong dark-only pack |
| [Nord](https://github.com/nordtheme/nord) | Scientific cool palette | Calm professional |

**How VS Code applies themes:** extension contributes `contributes.themes` → workbench ColorRegistry + TokenizationRegistry. Users can override via `workbench.colorCustomizations`. IDs are stable strings — our wipe/rebuild should similarly use stable theme ids + contribution metadata.

### 4.2 IntelliJ / JetBrains theme architecture

A theme is a **standalone plugin**:

- `*.theme.json` — UI overrides (`ui` map, named `colors`, optional icons, parent theme).
- Optional editor scheme `*.xml` (fonts/syntax).
- Registered via `themeProvider` in `plugin.xml`.
- Base: Light or Darcula; `themeMetadata` documents allowable keys.

Popular JetBrains marketplace patterns: Material Theme UI (full UI restyle), Catppuccin / Dracula ports, high-contrast variants. Lesson: **UI chrome colors ≠ editor scheme** — separate files, same plugin. Qutra Labs should keep **shell tokens** separate from any future **code highlighting** theme.

### 4.3 What we can/cannot port

| Portable | Not portable |
| --- | --- |
| Hex palettes → semantic CSS variables | TextMate scopes without an editor |
| Light/dark flavor pairs | Swing/laf IntelliJ controls |
| Accent override patterns (Catppuccin accentColor) | Marketplace extension sandbox itself |
| High-contrast sibling theme | Assuming VS Code blur = Windows Mica |

**Practical pipeline for “many quality themes”:**

```
External palette (Catppuccin / Nord / GitHub Primer / One Dark)
   → mapper.ts (palette → Qutra Labs semantic slots)
   → themes.css [data-theme="…"] blocks OR generated CSS
   → contrast.test.ts gate
```

Optional later: an offline, explicitly selected converter may map the `colors`
section of VS Code JSON into a quarantined Qutra pack candidate. Raw VS Code
JSON is never a directly activated runtime theme and still passes the complete
schema, security, and contrast gates.

---

## 5. Compatibility with Qutra Labs frontend

| Concern | Constraint | Design implication |
| --- | --- | --- |
| Stack | React + CSS vars, not Tailwind-first | Prefer token CSS over Tailwind glass plugins |
| Shell | Dense workbench (sidebar, tabs, inspector, bottom) | Glass only on chrome; solid editor surfaces |
| Scroll perf | Large lists/findings | No backdrop-filter on virtualized lists |
| A11y | Existing contrast tests + `highContrast` | Glass modes must degrade to solid under reduced transparency / HC |
| Brand | Qutra Labs / Qutra Labs | Marketplace palettes as optional packs; one brand theme remains |
| Native | Win + WebView2 | Prefer Tauri `setEffects`; detect OS transparency Off |
| Clean rebuild | Current themes are deleted completely | Redeclare registry, prefs schema, i18n theme.* keys, Theme Studio |

---

## 6. Recommended target repos (apply list)

### Tier S — authoritative foundations

| Priority | Repo / stack | Use for |
| :---: | --- | --- |
| S1 | Microsoft Mica/Acrylic/UISettings/High Contrast guidance + Tauri `Effect.Mica` / `Acrylic` | Real Windows material and policy |
| S2 | Keep Qutra Labs semantic-token contract (`THEME_AUTHORING`) after wipe | Architecture backbone |
| S3 | WCAG 2.2 + forced-colors/media-query standards | Accessibility contract |
| S4 | Apple HIG / WWDC25 | Liquid Glass interaction and scope policy only |

### Tier A — high value references

| Repo | Use for |
| --- | --- |
| [catppuccin/palette](https://github.com/catppuccin/palette) + [catppuccin/vscode](https://github.com/catppuccin/vscode) | Pinned, licensed source for one light and three dark official palettes |
| [microsoft/fluentui](https://github.com/microsoft/fluentui) (tokens only) | Naming + density + fluent color roles |
| [primer/github-vscode-theme](https://github.com/primer/github-vscode-theme) | Clean light+dark workbench mapping |
| [dracula/dracula-theme](https://github.com/dracula/dracula-theme) | Cross-app palette discipline |
| [Binaryify/OneDark-Pro](https://github.com/Binaryify/OneDark-Pro) | Familiar dark IDE palette |
| [nikdelvin/liquid-glass](https://github.com/nikdelvin/liquid-glass) | Controlled Liquid Glass chrome recipes + fallbacks |
| [JUNGHERZ/GlassKit](https://github.com/JUNGHERZ/GlassKit) | Lightweight glass component/token crib |
| [yell0wsuit/acrylic-mica-css](https://github.com/yell0wsuit/acrylic-mica-css) | CSS recipe reference after audit; never a desktop-material foundation |

### Tier B — specialty / do not use app-wide

| Repo | Allowed use |
| --- | --- |
| [naughtyduk/liquidGL](https://github.com/naughtyduk/liquidGL) | One optional hero lens (e.g. Welcome ornament) |
| [huozhi/vaso](https://github.com/huozhi/vaso) | Experiment widgets |
| Progressive-Acrylic | Accent overlays only |

### Explicit rejects for workbench

- Pure `backdrop-filter` everywhere
- Nested glass cards
- Shipping WebGL refraction on tab strips / virtual lists
- Adopting full Fluent React v9 as a rewrite of Qutra Labs components
- Claiming marketplace VS Code themes “just work” without a semantic mapper + contrast gate

---

## 7. Proposed rebuild architecture (when user says wipe)

```
┌─────────────────────────────────────────────────────────┐
│ Theme pack (JSON)                                        │
│  id, displayName, author, license, source               │
│  palettes.light/dark: complete semantic token sets      │
│  optional: editorTokens for future code views           │
└───────────────────────┬─────────────────────────────────┘
                        │ validate + contrast gate
                        ▼
┌─────────────────────────────────────────────────────────┐
│ Runtime                                                  │
│  resolveAppearance(prefs, capabilities)                  │
│    → requested material + effective backdrop + reason    │
│  apply versioned CSS data-attrs                          │
│  race-safe native effect controller per window          │
│  HC / reduced transparency / effect fail → solid         │
└─────────────────────────────────────────────────────────┘
```

**Minimal first ship after wipe (recommendation):**

1. Brand solid (`contextos`) + High Contrast.
2. Independent material controls: solid + native Mica; explicit experimental Acrylic.
3. One Liquid Glass-inspired *chrome treatment* (solid content; packaged WebView2 feature gate).
4. Catppuccin family: Latte light + selectable Frappe/Macchiato/Mocha dark, via a pinned mapper.
5. Separate appearance-config and secure custom-pack importers.

**Marketplace-like UX without a store:** Theme Studio lists packs; import JSON theme pack; export pack; no remote download required (local-first).

---

## 8. Performance policy (non-negotiable)

1. Prefer OS compositor for desktop glass.
2. Cap CSS blur radius; max N glassed surfaces visible (titlebar + sidebar + modal).
3. No glass on scrolling finding tables / terminal backbuffer.
4. Native/app reduced-transparency policy → solid;
   `prefers-reduced-transparency` is a supplementary browser signal.
5. Measure a packaged solid baseline against each material: cold start, scroll,
   resize/drag, transitions, CPU/GPU/memory, long tasks, and frame-time p95.
6. Contrast tests must pass for every pack × mode at correct WCAG thresholds,
   plus computed-style and native composite checks.
7. No white flash, transparent leak, or stale first frame.

---

## 9. Product decision (locked from chat)

**Rebuild shape:** Windows native Mica/Acrylic + chrome-only Liquid Glass + Catppuccin/marketplace palette packs via semantic mapper.

**Locked correction:** Liquid Glass is not a pack or mode. It is a stable
user-facing material preference that resolves internally into a native backdrop
plus a chrome treatment. Pack, mode, and material remain orthogonal.

Still open only at product level: whether optional P3 packs beyond Catppuccin
are worth shipping. Core architecture and fallback policy are no longer open.

---

## 10. Sources

Primary sources, accessed 2026-07-29:

- Qutra Labs: `src/lib/theme.ts`, `src/lib/windowEffects.ts`,
  `src/styles/themes.css`, `public/theme-init.js`, `src/app/AppShell.tsx`,
  preference storage, contrast tests, `THEME_AUTHORING.md`, and
  `THEME_REFS.md`
- [Tauri window effects API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Microsoft Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
- [Microsoft Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
- [Windows UISettings](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uisettings)
- [Windows High Contrast setting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.accessibilitysettings.highcontrast)
- [WebView2 DefaultBackgroundColor](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.defaultbackgroundcolor)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [Media Queries Level 5](https://drafts.csswg.org/mediaqueries-5/)
- [Apple HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- [VS Code theming](https://code.visualstudio.com/api/extension-capabilities/theming)
- [JetBrains theme structure](https://plugins.jetbrains.com/docs/intellij/theme-structure.html)

Community candidates are listed in Section 6 and are not approved dependencies
without source pinning, license, hash, security, compatibility, accessibility,
and performance review.
