# Appearance reference policy (Qutra Labs)

**Reviewed:** 2026-07-29  
**Status:** Reference inventory · superseded conflicts resolved by
[independent verification](architecture/theme-system-independent-verification-2026-07-29.md).

**Runtime (P0+):** `appearance.ts` + `windowEffects.ts` + Theme Studio pack/mode/material.
Do **not** reintroduce silent Mica→Acrylic fallback or app-wide CSS glass.

## Architecture documents

- [Deep research](architecture/theme-systems-deep-research-2026-07-29.md)
- [Independent verification](architecture/theme-system-independent-verification-2026-07-29.md)
- [Reviewed design spec](specs/2026-07-31-theme-system-rebuild-design.md)

## Source hierarchy

### Tier S: primary platform and standards sources

| Area | Source | Authority |
| --- | --- | --- |
| Windows materials | [Microsoft Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica), [Microsoft Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic) | Material purpose, layering, fallback, accessibility, and performance guidance |
| Tauri effects | [Tauri window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) | Supported effect ids and platform/performance notes |
| Windows policy | [UISettings](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uisettings), [HighContrast](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.accessibilitysettings.highcontrast) | Transparency, animation, and High Contrast capability boundary |
| WebView2 | [DefaultBackgroundColor](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.defaultbackgroundcolor) | Transparent-host behavior, supported alpha, and first-frame flicker |
| Accessibility | [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Media Queries 5](https://drafts.csswg.org/mediaqueries-5/) | Contrast and user-preference requirements |
| Liquid Glass policy | [Apple HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials), [WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/) | Chrome/content scope, legibility, Regular/Clear behavior |
| Theme ecosystems | [VS Code theming](https://code.visualstudio.com/api/extension-capabilities/theming), [JetBrains theme structure](https://plugins.jetbrains.com/docs/intellij/theme-structure.html) | UI palette versus syntax/icon contract separation |

### Tier A: audited palette candidates

These may provide pinned source data for deterministic generation after license,
hash, maintenance, and attribution review:

- [Catppuccin palette](https://github.com/catppuccin/palette)
- [Catppuccin for VS Code](https://github.com/catppuccin/vscode)
- [GitHub VS Code themes](https://github.com/primer/github-vscode-theme)
- [Dracula](https://github.com/dracula/dracula-theme)
- [Nord](https://github.com/nordtheme/nord)
- [One Dark Pro](https://github.com/Binaryify/OneDark-Pro)

### Tier B: recipe references, not foundations

These are experiments to study only after license, security, maintenance,
WebView2, accessibility, and performance review:

- [acrylic-mica-css](https://github.com/yell0wsuit/acrylic-mica-css)
- [nikdelvin/liquid-glass](https://github.com/nikdelvin/liquid-glass)
- [GlassKit](https://github.com/JUNGHERZ/GlassKit)
- [Progressive-Acrylic](https://github.com/ysfemreAlbyrk/Progressive-Acrylic)

`window-vibrancy` belongs to a future macOS-specific investigation. Tauri's
built-in Windows effects remain the P0 path.

## Explicit non-use

- No community clone is required at runtime.
- No build-time or runtime network fetch.
- No CSS `backdrop-filter` presented as desktop wallpaper blur.
- No app-wide WebGL/refraction engine.
- No nested glass trees, transparent list rows, terminal buffers, editors, or
  long scrolling content.
- No volatile star count used as a quality decision.
- No retired `acrylicClear` or `liquidGlass` **theme id**. `liquidGlass` may
  remain only as a material preference that resolves to an honest effective
  backdrop and chrome treatment.

## Vendor acceptance record

Before any source enters `vendor/theme-refs/` or generated product CSS, record:

| Field | Required |
| --- | --- |
| Source URL | Yes |
| Release tag or commit SHA | Yes |
| Retrieved date | Yes |
| License and compatible use | Yes |
| SHA-256 of vendored input | Yes |
| Files copied or adapted | Yes |
| Deterministic generation command | Yes |
| Runtime dependency | Must be `no` unless separately approved |
| Security/accessibility/performance review | Yes |
| Third-party notice entry | Yes |

An empty `vendor/theme-refs/` directory is valid. Research links do not imply
that a repository was downloaded.
