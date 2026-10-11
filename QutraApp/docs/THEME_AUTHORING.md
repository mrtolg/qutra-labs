# Authoring appearance (pack × mode × material)

> **DECISION:** Prefer this document over legacy ThemeId authoring.
> Runtime: `src/lib/appearance.ts`, `src/lib/windowEffects.ts`,
> `src/styles/themes.css`, `src/styles/materials.css`, `public/theme-init.js`.
> Contrast gate: WCAG AA **4.5:1** for normal text and primary labels
> (`src/lib/theme.contrast.test.ts`).

## Axes

1. **Pack** (`packId`) — semantic color: `contextos`, `catppuccin`, `highContrast`
2. **Mode** (`themeMode`) — `light` | `dark` | `system` | `schedule`
3. **Material** (`material`) — intent: `none` | `mica` | `acrylic` | `liquidGlass`

Material intent is never overwritten when the OS rejects an effect. Failed or
disallowed native materials resolve to solid; Acrylic is never a silent Mica
fallback.

Liquid Glass is chrome-only CSS (`data-chrome-treatment="refractive"`). It is
not Apple’s native material.

## Import split

- Appearance config: `app: "contextos-appearance"` (Theme Studio export)
- Custom pack: `app: "contextos-theme-pack"` (validated; install may be deferred)

Do not mix the two document types.

## Adding a color pack

1. Add `packId` to `PreferencesSchema` and `PACKS` in `appearance.ts`.
2. Add locale strings for `theme.<id>` / `.desc`.
3. Add `[data-theme="<id>"][data-mode="light|dark"]` token blocks.
4. Extend the contrast gate theme list.
5. Pin/license/hash upstream palettes offline before importing new sources.

## Evidence labels

Use FACT-OS / FACT-CODE / DECISION / INFERENCE / EXPERIMENT from the
independent verification doc when claiming OS behavior.
