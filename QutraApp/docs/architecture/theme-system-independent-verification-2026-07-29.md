# Theme system independent verification (2026-07-29)

**Status:** Research and architecture review only. No product code was changed.  
**Product:** Qutra Labs (historical internal identifier: Qutra Labs).  
**Reviewed artifacts:** current theme runtime, first-paint script, CSS, preference
storage, accessibility tests, research and design spec.

## 1. Verdict

The three-axis product decision is sound:

1. **Pack** owns semantic color.
2. **Mode** owns light/dark selection.
3. **Material** owns window/chrome treatment.

Implementation is not ready to start from the earlier draft unchanged. The
following corrections are mandatory:

- Store user intent separately from runtime capability and the applied result.
- Do not silently turn a failed Mica request into full-window Acrylic.
- Treat Liquid Glass as a Qutra chrome treatment, not as native Apple material.
- Use a native Windows capability bridge; CSS media queries alone are
  insufficient for transparency policy.
- Split appearance-config import from custom-pack import.
- Replace the incomplete contrast test with a complete token and computed-style
  gate.
- Make first paint, scheduled mode, system setting changes, and async races part
  of the architecture rather than post-build polish.
- Pin, license, hash, and generate every imported upstream palette offline.

The corrected design below supersedes conflicting statements in the original
research, spec and `THEME_REFS.md`.

## 2. Evidence labels

Every architecture claim must use one of these labels during implementation
review:

| Label | Meaning |
| --- | --- |
| **FACT-OS** | Confirmed by Microsoft, Apple, Tauri, W3C, or another primary platform source |
| **FACT-CODE** | Confirmed in the current Qutra codebase |
| **DECISION** | Product or engineering choice, not an external fact |
| **INFERENCE** | Plausible explanation that is not directly proven |
| **EXPERIMENT** | Must be established on a packaged build and target hardware |

GitHub stars, screenshots, and community claims are discovery signals only.
They are not quality, security, compatibility, or performance evidence.

## 3. Independently verified findings

### 3.1 Operating-system materials

- **FACT-OS:** Mica is an opaque, wallpaper-informed backdrop for long-lived
  windows. It is designed as the base layer and should be applied once.
- **FACT-OS:** Acrylic is translucent and GPU-intensive. Microsoft recommends
  background Acrylic mainly for transient UI and warns against large desktop
  Acrylic surfaces and adjacent/layered Acrylic panes.
- **FACT-OS:** Tauri exposes `Mica` on Windows 11 and `Acrylic` on Windows
  10/11. Tauri explicitly warns that Acrylic can perform poorly while a window
  is resized or dragged.
- **DECISION:** Mica is the default native material. Acrylic is an explicit,
  user-selected experimental option, not an automatic fallback for Mica.
- **DECISION:** A failed or disallowed native effect resolves to solid. The
  persisted user preference remains unchanged so it can become active again
  when system capability returns.

### 3.2 WebView2 and CSS

- **FACT-OS:** WebView2's default background supports alpha `0` or `255`, not
  intermediate alpha. A transparent webview reveals host content.
- **FACT-OS:** WebView2 can show a white flicker before a background property is
  applied; the documented environment-variable path can prevent that initial
  flicker.
- **FACT-OS:** CSS `backdrop-filter` samples the web scene, not the native host
  window or desktop compositor surface.
- **FACT-CODE:** `tauri.conf.json` currently sets `transparent: true`.
- **FACT-CODE:** `src/styles/app.css` still applies `backdrop-filter: blur(8px)`
  to `.settings-pane-head`. The claim that all CSS glass is retired is
  therefore false until the wipe removes or explicitly justifies it.
- **DECISION:** Real Windows backdrop is native. CSS blur/refraction is permitted
  only inside the web scene and only on approved chrome selectors.

### 3.3 Accessibility

- **FACT-OS:** WCAG 2.2 AA requires `4.5:1` for normal text and `3:1` for large
  text. Non-text component boundaries and required visual states need `3:1`.
- **FACT-CODE:** The current primary-label test and `THEME_AUTHORING.md` use
  `3.5:1`. That value is not a WCAG threshold and is insufficient for the
  current compact button text.
- **FACT-CODE:** The current contrast parser reads flat CSS text and cannot
  reliably resolve `var()`, alpha compositing, imported/generated packs, or
  translucent dynamic backdrops.
- **FACT-OS:** `prefers-reduced-transparency` remains limited/experimental and
  cannot be the sole production capability signal.
- **FACT-OS:** `forced-colors` can remove shadows and background images and
  replace colors with system colors. Focus, selection, disabled, and boundary
  states must survive that transformation.
- **DECISION:** System High Contrast/forced colors is an override layer, not a
  decorative pack. It always wins over pack and material.

### 3.4 Current runtime defects relevant to the rebuild

| Id | Current fact | Required correction |
| --- | --- | --- |
| A01 | Desktop preferences live in SQLite, but `public/theme-init.js` reads only `contextos.v1.preferences` from `localStorage`. | Maintain a versioned, non-sensitive appearance mirror for pre-paint, then reconcile it with SQLite after boot. |
| A02 | Scheduled mode is evaluated on render and OS color-scheme changes only. | Set a timer for the next boundary and reschedule on wake, resume, time-zone/DST, and clock changes. |
| A03 | Theme Studio and AppShell can launch overlapping async `setEffects` calls. Cancellation only blocks one DOM update. | Use a monotonic request id or serialized controller; last request wins for native effect and DOM state. |
| A04 | `windowEffects` tests do not cover real Mica/Acrylic success and failure paths. | Mock Tauri imports and test every requested/effective/reason result. |
| A05 | A successful `setEffects` promise is treated as visual success. | Report API application separately; packaged visual smoke remains required. |
| A06 | `transparent: true` is permanent, including solid mode. | Test solid boot, cleared effects, window shadows, white flash, and no wallpaper leakage. |
| A07 | `highContrast` exists both as a theme and a preference flag. | Migrate to one explicit user preference plus a higher-priority system override. |
| A08 | Existing docs still name retired `acrylicClear` and `liquidGlass` theme ids as winners. | Rewrite references and add stale-reference gates. |

## 4. Locked runtime contract

### 4.1 Persisted intent

```ts
type PackId = "contextos" | "catppuccin" | string;
type ModePreference = "light" | "dark" | "system" | "schedule";
type MaterialPreference = "none" | "mica" | "acrylic" | "liquidGlass";

interface AppearancePreferencesV2 {
  schemaVersion: 2;
  packId: PackId;
  mode: ModePreference;
  material: MaterialPreference;
  schedule: {
    lightAt: string;
    darkAt: string;
    timeZone: "local";
  };
  reduceTransparency: boolean;
  catppuccinDarkFlavor?: "frappe" | "macchiato" | "mocha";
}
```

`material` is user intent. It must never be overwritten merely because a
system setting, remote session, power state, OS version, or effect failure
temporarily disables it.

### 4.2 Capability snapshot

The native boundary returns a serializable snapshot and emits changes:

```ts
interface AppearanceCapabilities {
  platform: "windows" | "macos" | "linux" | "browser";
  osVersion?: string;
  advancedEffectsEnabled: boolean;
  animationsEnabled: boolean;
  highContrast: boolean;
  forcedColors: boolean;
  reducedTransparency: boolean;
  powerSaver: boolean | "unknown";
  remoteSession: boolean | "unknown";
  micaSupported: boolean;
  acrylicSupported: boolean;
  liquidGlassProbe: "supported" | "unsupported" | "untested";
}
```

On Windows, `advancedEffectsEnabled` and `animationsEnabled` come from
`UISettings`; High Contrast comes from the native accessibility setting and is
cross-checked with `forced-colors`. Browser media queries remain supplemental.

### 4.3 Resolved and applied state

```ts
type NativeBackdrop = "none" | "mica" | "acrylic";
type ChromeTreatment = "solid" | "translucent" | "refractive";
type FallbackReason =
  | "none"
  | "browser-preview"
  | "unsupported-platform"
  | "unsupported-os"
  | "system-transparency-off"
  | "high-contrast"
  | "reduced-transparency"
  | "power-saver"
  | "remote-session"
  | "effect-failed"
  | "performance-policy";

interface ResolvedAppearance {
  packId: string;
  mode: "light" | "dark";
  requestedMaterial: MaterialPreference;
  effectiveNativeBackdrop: NativeBackdrop;
  chromeTreatment: ChromeTreatment;
  fallbackReason: FallbackReason;
}
```

Required root attributes:

```text
data-pack
data-mode
data-requested-material
data-native-backdrop
data-chrome-treatment
data-contrast
data-reduce-motion
data-reduce-transparency
CSS color-scheme (synchronized with data-mode before first paint)
```

The Settings UI renders the same `ResolvedAppearance` object used by the native
effect controller. It must not infer capability with separate UI-only logic.

## 5. Material resolution policy

| Requested | Effective native backdrop | Chrome treatment | Failure policy |
| --- | --- | --- | --- |
| `none` | `none` | `solid` | Always available |
| `mica` | `mica` when allowed and supported | `translucent` | `none` + `solid`; never silently Acrylic |
| `acrylic` | `acrylic` when explicitly selected and allowed | `translucent` | `none` + `solid` |
| `liquidGlass` | `mica` when allowed, otherwise `none` | `refractive` only after WebView2 feature/visual probe; otherwise `solid` | No automatic Acrylic |

Global overrides are evaluated before the table:

1. System High Contrast or `forced-colors` -> native `none`, solid chrome.
2. System/app reduced transparency -> native `none`, solid chrome.
3. Unsupported platform/browser preview -> native `none`; preview may show
   static, clearly labelled chrome tokens but cannot claim native material.

`liquidGlass` is the stable preference/API id for compatibility. User-facing
copy must say **Liquid Glass-inspired chrome**. Internally it resolves into a
native backdrop and a separate chrome treatment because it is not one OS
material.

## 6. Pack model and Catppuccin

A pack is a complete semantic system, not one raw palette:

```ts
interface ThemePackManifestV1 {
  schemaVersion: 1;
  id: string;
  displayName: string;
  author: string;
  license: string;
  source?: string;
  palettes: {
    light: SemanticTokenSet;
    dark: SemanticTokenSet;
  };
}
```

Catppuccin has one light flavor (Latte) and three dark flavors (Frappe,
Macchiato, Mocha). Do not invent unofficial dark Latte or light Mocha colors.
Ship one `catppuccin` family:

- light mode uses Latte;
- dark mode uses the selected Frappe, Macchiato, or Mocha flavor;
- system/schedule changes mode without changing the stored dark-flavor choice.

The Theme Studio may present four flavor swatches, but the persisted model must
preserve the official light/dark relationship.

## 7. Semantic token contract

The manifest and generated CSS must cover at least:

- Canvas/content: background, base surface, raised, sunken, overlay, border,
  strong border, separator.
- Chrome: titlebar, sidebar, tab strip, inspector, bottom panel, modal, menu,
  tooltip, and their opaque fallbacks.
- Text: primary, secondary, muted, disabled, placeholder, inverse, link,
  visited link.
- Controls: default, hover, active, selected, disabled, checked, loading,
  focus ring.
- Status: success, warning, danger, info, each with foreground, background,
  and boundary.
- Selection and search: selection background/foreground, match, current match.
- Data: charts with non-color cues, git add/modify/delete/conflict, diff
  foreground/background, terminal ANSI 16-color set.
- Code/editor tokens remain a separate optional contract.

Chrome tokens and content tokens must be distinct. Material CSS may alter only
chrome roles and explicit shell backplates; it must not make tables, terminal
buffers, editors, or long scrolling content transparent.

## 8. Accessibility gates

All built-in and imported packs must pass:

- normal text: at least `4.5:1`;
- large text: at least `3:1`;
- required component boundaries, icons, focus, and state indicators: at least
  `3:1`;
- primary button labels: `4.5:1` at current compact sizes;
- translucent chrome: contrast against actual composite colors and worst-case
  representative light, dark, and high-frequency backdrops;
- focus remains visible and unobscured at keyboard navigation and zoom;
- no status, chart, diff, or selection meaning is conveyed by color alone;
- 200% text zoom, reflow, forced colors, reduced motion, and reduced
  transparency checks.

Static manifest tests validate token completeness and opaque pairs. A real
browser computed-style test validates CSS resolution. Packaged native visual
tests validate material composites; a string parser alone is not sufficient.

## 9. Import, persistence, and supply-chain policy

Two formats exist and must not be conflated:

1. `AppearanceConfigV2`: current selection, mode, material, and schedule.
2. `ThemePackManifestV1`: author metadata plus complete light/dark semantic
   token sets.

Pack import requirements:

- strict schema/version and a bounded file size;
- bounded ids, names, and metadata strings;
- v1 imported token values are opaque sRGB `#RRGGBB` only; alpha and material
  opacity remain product-owned;
- no arbitrary CSS, HTML, SVG, `url()`, `var()`, `calc()`, filters, scripts, or
  filesystem/network references;
- complete token set and contrast validation before activation;
- duplicate-id policy: cancel, replace after confirmation, or import with a new
  local id;
- quarantine/preview before activation;
- revalidate persisted custom packs after app/schema upgrades;
- remove, rename, export, and restore-default actions;
- imported data remains local and contains no secrets.

Built-in upstream assets:

- pin a release tag or commit SHA;
- record source URL, license, hash, and retrieval date;
- keep generated output deterministic and checked in;
- perform no runtime or build-time network fetch;
- maintain third-party notices;
- use community repos as audited references, not runtime dependencies by
  default.

## 10. First paint and lifecycle

The external classic pre-paint script is retained because the strict CSP blocks
inline script. It reads a minimal `qutra.appearance.v2` localStorage mirror that
contains no private product data. SQLite remains the authoritative preference
store.

Required synchronization:

1. every successful appearance preference write updates SQLite and the mirror;
2. startup script validates the mirror and applies deterministic safe defaults
   when invalid, including `color-scheme` before native controls paint;
3. after SQLite opens, runtime reconciles attributes and rewrites the mirror;
4. a parity test runs the same fixtures through pre-paint and runtime
   resolution;
5. packaged cold launch and reload have no white flash, transparent leak, or
   incorrect-theme frame;
6. CSP console remains error-free.

Schedule behavior:

- use local wall-clock time;
- validate `HH:mm`;
- define equal light/dark boundaries as invalid and fall back to defaults;
- schedule a timer to the next boundary;
- reschedule on resume/wake, time-zone or DST change, and system clock change.

Native effect behavior:

- one controller per Tauri window;
- idempotent application;
- serialized requests, or a generation-aware loop that reapplies the newest
  state after a stale native call completes; merely ignoring a stale promise
  result is insufficient because the native side effect already occurred;
- deduplicate identical requests and avoid effect calls on unrelated renders;
- capability changes immediately re-resolve without changing persisted intent;
- secondary windows receive the same resolved contract.

## 11. Theme Studio UX and localization

The appearance page uses four unframed sections rather than a grid of nested
cards:

1. pack family and flavor;
2. light/dark/system/schedule mode;
3. material preference and effective status;
4. local import/export and pack management.

Requirements:

- stable preview dimensions in light and dark, including text, controls,
  selection, status, chart, and terminal swatches;
- keyboard and screen-reader operation for every selector;
- compatibility and fallback reasons adjacent to the material control;
- CSS-only preview until Apply; no native effect on hover, focus, or arrow-key
  exploration;
- Apply, cancel/revert, restore default, import error, validation progress, and
  successful-save states;
- imported author/pack names remain authored text, while all product labels,
  fallback reasons, validation errors, and commands use typed i18n keys in
  every supported locale;
- logical CSS properties and text-fitting checks so long translations do not
  overlap controls;
- no raw ids such as `catppuccin-mocha` or `effect-failed` appear to users.

## 12. Liquid Glass-inspired chrome

Allowed:

- titlebar/window control strip;
- navigation sidebar shell;
- command palette and modal shell;
- optional compact inspector header.

Forbidden:

- findings/data tables;
- terminal backbuffer;
- editors and long scroll bodies;
- cards inside cards;
- every list row or tab body;
- nested blur/refraction trees.

Only a regular, legibility-first treatment is in scope. A clear/media-rich
variant is excluded because Qutra's workbench does not provide the controlled
media background Apple requires. SVG displacement is not accepted until
packaged WebView2 feature probing, screenshots, contrast, resize, drag, and
reduced-motion/transparency fallbacks pass.

## 13. Performance gate

Measure a packaged release build on the same Windows machine before and after
each material:

- 60-second scroll in a dense findings/tool list;
- window resize and drag;
- command palette open/close;
- tab and sidebar transitions;
- idle and active CPU/GPU/memory;
- long tasks and frame-time p95;
- cold-start first paint.

Initial release budget:

- no visible white flash or transparent content leak;
- no sustained animation/scroll below the solid baseline by more than 10%;
- no p95 frame time regression greater than 15%;
- no growing GPU/memory trend over the 60-second run;
- Acrylic is marked experimental or disabled if resize/drag visibly regresses;
- Remote Desktop, VM, battery saver, and disabled transparency resolve to an
  honest solid fallback.

These are project budgets, not platform facts. Record hardware, OS, WebView2,
GPU driver, power mode, and build hash with results.

## 14. Required verification matrix

| Area | Required cases |
| --- | --- |
| Resolution | every pack x light/dark/system/schedule x material x capability override |
| Migration | `windows`, all retired ids, unknown ids, repeated migration, downgrade/backup behavior |
| Native effects | Mica success/failure, explicit Acrylic success/failure, clear, race, multi-window |
| First paint | valid/invalid/missing mirror, SQLite disagreement, cold launch, reload, strict CSP |
| Schedule | before/at/after boundaries, overnight range, invalid/equal times, wake, DST/time-zone |
| Accessibility | WCAG pairs, alpha composites, forced colors, keyboard/focus, zoom, non-color cues |
| Imports | malformed, oversized, malicious CSS-like values, missing token, bad contrast, id collision |
| CSS scope | approved chrome only; no material selectors on content/terminal/list rows |
| Visual | all built-in packs in both modes, fallback states, first frame, 100/125/150/200% scale |
| UX/i18n | keyboard/screen reader, long translations, typed fallback/error keys, Apply/revert, no raw ids |
| Performance | solid baseline vs each material in packaged Windows build |
| Cleanup | no retired ids as active types/selectors/i18n; no stale docs; no unused dependencies |

## 15. Source hierarchy

Primary sources, accessed 2026-07-29:

- [Tauri window effects API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Microsoft Mica guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
- [Microsoft Win32 Mica implementation](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-mica-win32)
- [Microsoft Acrylic guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
- [Windows UISettings](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uisettings)
- [Windows AccessibilitySettings.HighContrast](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.accessibilitysettings.highcontrast)
- [WebView2 DefaultBackgroundColor](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.defaultbackgroundcolor)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [Media Queries Level 5](https://drafts.csswg.org/mediaqueries-5/)
- [MDN forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/forced-colors)
- [MDN prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency)
- [Apple HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple WWDC25 Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- [VS Code theming](https://code.visualstudio.com/api/extension-capabilities/theming)
- [JetBrains theme structure](https://plugins.jetbrains.com/docs/intellij/theme-structure.html)

Audited upstream candidates, not automatically approved dependencies:

- [Catppuccin palette](https://github.com/catppuccin/palette)
- [Catppuccin for VS Code](https://github.com/catppuccin/vscode)
- [Dracula](https://github.com/dracula/dracula-theme)
- [GitHub VS Code themes](https://github.com/primer/github-vscode-theme)
- [window-vibrancy](https://github.com/tauri-apps/window-vibrancy) for a future
  macOS-specific branch only
- [acrylic-mica-css](https://github.com/yell0wsuit/acrylic-mica-css),
  [nikdelvin/liquid-glass](https://github.com/nikdelvin/liquid-glass), and
  [GlassKit](https://github.com/JUNGHERZ/GlassKit) as recipe references pending
  license, maintenance, security, WebView2, and performance review

## 16. Preconditions for the rebuild

This document closes the research gaps; it does not itself change the product. Before
product-code changes:

1. the design spec must incorporate these locked decisions;
2. the implementation must include the complete gates above;
3. the current theme code must be inventoried without reverting unrelated changes;
4. failing migration/resolution/parity tests must exist before deletion.
