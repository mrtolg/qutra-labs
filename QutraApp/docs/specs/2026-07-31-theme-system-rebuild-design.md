# Qutra Labs — Theme System Rebuild (FAZ 0–2) Design Spec

**Status:** approved · 2026-07-31
**Scope:** FAZ 0 (analysis, done) · FAZ 1 (semantic skeleton) · FAZ 2 (five themes, Appearance UI, theme packs)
**Out of scope:** FAZ 3 and beyond — see §12.

---

## 1. Problem

Two independent modules resolve appearance and both write the same
`documentElement` attributes:

| | `src/lib/theme.ts` | `src/lib/appearance.ts` |
|---|---|---|
| Identity | `ThemeId = contextos \| windows \| highContrast` | `PackId = contextos \| catppuccin \| highContrast` |
| Applies | `applyThemeAttributes` → `data-theme`, `data-mode` | `applyAppearanceAttributes` → those two + 5 more |
| Live? | No — `THEMES`, `resolveTheme`, `applyThemeAttributes`, `wantsNativeWindowMaterial` are referenced only by their own tests | Yes — `AppShell`, `ThemeStudio`, `OnboardingPage` |

Only `scheduleMode` is genuinely live in `theme.ts` (consumed by
`appearance.ts:6`). Meanwhile `styles/themes.css` still ships selectors for
`windows`, `contextRose` and `catppuccin`.

Three axis-coupling defects follow from this:

1. **Mica is modelled as a colour theme** (`ThemeId = "windows"`).
   `ThemeStudio.apply()` (`ThemeStudio.tsx:141–146`) derives
   `theme: "windows"` from a *material* choice, re-coupling the axes.
2. **High Contrast is modelled as a colour theme**, so enabling an
   accessibility preference destroys the user's colour choice.
3. **There is no accent, radius, motion or transparency axis at all.**

## 2. Goals

Four independent axes, one source of truth, no parallel legacy system:

1. **Colour theme** — five built-ins + imported packs
2. **Material intent** — `solid | mica | acrylic | glass`
3. **Accent** — `crimson | blue | violet | emerald | amber`
4. **Interface preferences** — density, radius, motion, transparency,
   blur intensity, high contrast, theme source

Non-goals: layout redesign, component restructuring, native material
implementation, any Rust change.

---

## 3. Architecture

```
src/design-system/
  contract.json                 ← THE declarative contract (§9)
  tokens/
    semantic.css                base contract + density/radius/motion/transparency layers
    themes/
      qutra-obsidian.css  graphite.css  midnight.css  oled-black.css  qutra-light.css
    accents.css                 accent axis → --primary* family
    materials.css               material axis → chrome treatment
    high-contrast.css           HC override layer (§5)
  appearance/
    types.ts        defaults.ts     registry.ts      resolve.ts
    migrate.ts      applyAppearance.ts               capabilities.ts
    materialAdapter.ts            provider.tsx       store.ts
  themePack/
    schema.ts       validate.ts     storage.ts
```

`resolve()` is a pure function: `(prefs, capabilities, osDark, now) → ResolvedAppearance`.
It calls no native API and touches no DOM. `applyAppearance()` is the only
code that writes root attributes.

### 3.1 Removal plan (controlled, not blind)

Nothing is deleted before its consumer map is produced and its behaviour
migrated. Each removal is its own reversible step with tests run in between.

| Artefact | Action |
|---|---|
| `lib/theme.ts` | `scheduleMode` migrates to `appearance/resolve.ts`; the rest is deleted once the consumer map proves only its own tests reference it |
| `lib/appearance.ts` | Replaced by `appearance/*`; deleted after `AppShell`, `OnboardingPage`, `ThemeStudio` are migrated |
| `lib/windowEffects.ts` | **Untouched** — see §6 |
| `styles/themes.css` | Replaced by `tokens/themes/*` |
| `styles/materials.css` | Replaced by `tokens/materials.css` |
| `features/settings/ThemeStudio.tsx` | Replaced by the Appearance panel (§8) |
| `syncWindowMaterial` | Deprecated export removed (only its own test calls it) |

A temporary compatibility wrapper is permitted **only** if a migration step
would otherwise leave the app non-building. It must be marked
`@deprecated`, must delegate to the new module (never duplicate logic), and
must be deleted within the same phase. **Old and new resolution must never
both be live at the end of a phase.**

---

## 4. Theme model

### 4.1 Intrinsic mode

Each theme declares its own mode. No synthetic light/dark variants.

| Theme | Mode | Character |
|---|---|---|
| `qutra-obsidian` | dark | Very dark neutral base, not pure black, faintly warm surfaces, controlled crimson. **Default.** |
| `graphite` | dark | Neutral graphite greys, technical, high legibility |
| `midnight` | dark | Deep navy base, cool surfaces |
| `oled-black` | dark | Near-true-black base, minimal glow, hierarchy preserved by tone not borders |
| `qutra-light` | light | Off-white neutral base, dark neutral ink |

`data-mode` is **derived** from the resolved theme's registry entry, never
chosen by the user. Existing CSS keyed on `[data-mode="dark"]` (18 selectors,
including the `tokens.css` dark base layer) keeps working unchanged.

### 4.2 `themeSource`

| Value | Resolved theme |
|---|---|
| `manual` | the selected `colorTheme` |
| `system` | OS dark → `lastDarkTheme` · OS light → `qutra-light` |
| `schedule` | dark window → `lastDarkTheme` · light window → `qutra-light` |

`lastDarkTheme: ColorThemeId` is a minimal type-safe field holding the most
recent *dark* theme the user selected. It is updated whenever a dark theme is
chosen and is never written by a light selection. Schedule reuses the existing
`themeScheduleLightAt` / `themeScheduleDarkAt` values and the existing
crossing-midnight semantics.

There is deliberately **no** `preferredLightTheme` selector: `qutra-light` is
the only built-in light theme. An imported light pack may be selected
manually; it does not become the automatic light target.

Imported packs declare their own intrinsic `mode`, and it is honoured
identically.

---

## 5. High Contrast

High Contrast is an **interface preference**, never a colour theme.

- It is a semantic-token override layer (`tokens/high-contrast.css`) applied
  on top of whatever theme is active, via `data-contrast="high"`.
- Turning it **on does not change the colour theme** and never forces light.
- Turning it **off** restores the previous colour theme, because the colour
  theme was never overwritten.

### Migration from the legacy High Contrast theme

- legacy `theme === "highContrast"` or `packId === "highContrast"`
  → set `highContrast: true`
- the colour theme is taken from any other recoverable legacy signal
  (`packId`, legacy `theme`); if the only signal is the High Contrast id
  itself, fall back to **`qutra-obsidian`** (not `qutra-light`)
- after migration, `packId` / legacy theme ids must **never** re-enable High
  Contrast on a later load — the boolean is the sole authority

---

## 6. Material

`MaterialAdapter` is the FAZ 3 seam:

```ts
interface MaterialAdapter {
  capabilities(): MaterialCapabilities;
  apply(intent: MaterialIntent): Promise<AppliedMaterial>;
}
```

This build ships `nullMaterialAdapter`: every non-solid intent reports
`supported: false` with reason `phase-3-pending`, and `apply()` is never
called.

**Behaviour locked for this build:**

- `solid` is real and resolves to solid.
- `mica`, `acrylic`, `glass` are **selectable and persisted as intent**.
- All of them resolve to `resolvedMaterial: "solid"` in this build.
- The controls are **not technically disabled**. They are selectable and
  carry an accessible `intent-only / not-applied` explanation:
  *"Tercihiniz kaydedildi. Native material adapter henüz uygulanmadığı için
  şu anda Solid olarak görüntüleniyor."*
- No fake preview, no simulated native success.
- Intent is never erased; the user can move back and forth freely between
  solid and the other intents.
- `acrylic` carries an *experimental* label.
- A failed `mica` never silently becomes `acrylic`. The only fallback is
  `mica → solid`.

`src/lib/windowEffects.ts` is **not modified** by this change: no behaviour
change, no new native effect, no Tauri capability change, no simulated
success. Its existing test stays. FAZ 3 will implement `MaterialAdapter` on
top of it.

---

## 7. Token contract

The existing vocabulary is authoritative (user decision). No synonyms are
created; the prompt's concepts map onto the shipped names.

| Concept | Token |
|---|---|
| background / foreground | `--bg` / `--ink` |
| surface / elevated / muted surface | `--surface` / `--surface-raised` / `--surface-sunken` |
| card / popover | existing surface contract (`--surface-raised`) — no new token |
| muted foreground | `--muted` / `--faint` |
| border / border-strong | `--border` / `--border-strong` |
| ring / focus | `--focus-ring` — **`--focus` must never exist** (`tokens.test.ts:81`) |
| primary / primary-foreground | `--primary` / `--primary-ink` |
| destructive / destructive-foreground | `--danger` / `--danger-ink` |
| selection | `--selection-bg` |

### 7.1 Decorative accent → secondary

`--accent` is defined but never consumed → **deleted**.
`--accent-text` / `--accent-soft` are consumed at 9 call sites (links,
neutral badges, `sev-low`) and genuinely mean *secondary emphasis*. They are
renamed, with no alias layer left behind:

- `--accent-text` → `--secondary`
- `--accent-soft` → `--secondary-soft`

This satisfies the required `secondary` concept without inventing a synonym.
`--secondary-ink` is added **only if** a secondary fill turns out to need its
own label colour; that is confirmed against `.btn--secondary` during
implementation.

### 7.2 New tokens (exact list)

| Token | Reason |
|---|---|
| `--overlay` | absorbs the hard-coded scrims at `app.css:270`, `components.css:522` |
| `--success-ink` `--warning-ink` `--danger-ink` `--info-ink` | status label colours; absorbs `#fff` at `lab.css:159` |
| `--secondary-ink` | conditional — only if a secondary fill needs a label colour |
| `--input` `--input-ink` `--input-placeholder` | input surface, text and placeholder are contrast-tested separately |
| `--terminal-bg` `--terminal-ink` `--terminal-muted` `--terminal-red` `--terminal-yellow` `--terminal-green` `--terminal-blue` | terminal surface is currently untokenised |
| `--code-bg` `--code-ink` | code blocks |
| `--blur-strength` | blur intensity axis |

Naming follows the repository's `-ink` convention, not `-foreground`.
Tooltip / selected-state contrast is asserted against whichever tokens the
shipped components already consume; dedicated tokens are added only if a
component genuinely uses a distinct surface.

### 7.3 Accent axis

The accent axis drives the **`--primary*` family** and `--selection-bg`:
`--primary`, `--primary-hover`, `--primary-active`, `--primary-ink`,
`--primary-soft`, `--primary-soft-strong`.

`--danger` and `--danger-ink` are **completely independent** of the accent
choice, in every theme and every accent.

### 7.4 Root attributes

Applied set: `data-theme`, `data-mode`, `data-material`, `data-accent`,
`data-density`, `data-radius`, `data-motion`, `data-transparency`,
`data-contrast`, plus `style.colorScheme`.

Legacy attributes and their CSS consumers are migrated, then removed:

| Legacy attribute | CSS uses | Replaced by |
|---|---|---|
| `data-window-material` | 15 | `data-material` |
| `data-reduce-motion` | 10 | `data-motion` |
| `data-chrome-treatment` | 8 | `data-material` |
| `data-native-backdrop` | 3 | `data-material` |
| `data-pack` | 2 | `data-theme` |
| `data-reduce-transparency` | 1 | `data-transparency` |

`data-level` (4 uses) is unrelated to theming and is left alone.

---

## 8. Appearance UI

`Settings › Appearance` replaces `ThemeStudio`. Sections: **Theme**,
**Window Material**, **Accent**, **Interface**, **Theme Packs**.

Each theme card carries a real preview representing base, surface, elevated,
text, muted text, accent and destructive — not a row of random swatches —
plus name, short description, dark/light label, selection state and keyboard
operability (radiogroup semantics).

Theme, accent and density apply immediately. Draft form state, persisted
preference and material intent stay distinct. If persistence fails the user
gets an honest error; the UI never shows a selection as saved when the write
did not land.

Theme Packs section: import, export current appearance, export selected
pack, imported list, remove imported, reset defaults. Built-ins cannot be
removed. Appearance config and theme-pack schemas stay separate documents.

---

## 9. Prepaint / runtime parity — **P0 acceptance criterion**

`public/theme-init.js` and the TypeScript runtime must **not** contain two
independent decision trees.

`src/design-system/contract.json` is the single declarative contract holding:
defaults, valid enum values, intrinsic theme modes, migration mappings,
root attribute names, and the storage key.

- The TS runtime imports it directly.
- `scripts/generate-theme-init.mjs` generates `public/theme-init.js` from it.
  The generated file is committed to the repo (CSP requires a classic
  `script-src 'self'` file, so it cannot import modules at runtime).
- A **drift test** regenerates the file in memory and fails if the committed
  file differs.
- A **behavioural parity test** runs a fixture matrix (defaults, every legacy
  shape, corrupt state, every themeSource, HC on/off) through both the TS
  resolver and the generated prepaint logic in jsdom, and asserts identical
  root attributes.

Prepaint must never throw; on any error it applies the default appearance
(Qutra Obsidian / dark), not a light fallback.

---

## 10. Migration

Legacy → new mapping:

| Legacy | New |
|---|---|
| `contextos`, `contextRose`, retired glass ids | `qutra-obsidian` |
| `catppuccin` | `qutra-obsidian` |
| `windows` | `qutra-obsidian` + `materialIntent: mica` |
| `highContrast` theme/pack | `highContrast: true` (colour theme per §5) |
| `material: liquidGlass` | `materialIntent: glass` |
| `themeMode: schedule` + times | `themeSource: schedule`, times preserved |
| `reduceMotion: true` | `motion: reduced` |
| `reduceTransparency: true` | `transparency: disabled` |

Requirements:

- **Idempotent** — migrating an already-migrated state changes nothing.
- New schema fields take precedence when legacy and new fields coexist.
- An invalid or removed imported theme id falls back safely; the active
  imported theme being deleted falls back to `qutra-obsidian`.
- The user's dark theme preference is preserved wherever recoverable.
- Corrupt or unparseable state never crashes — it resolves to defaults.
- Migration tests use **real legacy fixtures**, not synthetic ideal shapes.

---

## 11. Theme packs

JSON only. Validated with zod before anything is applied.

Rejected outright: JavaScript, HTML, CSS, arbitrary keys, `url()`,
`@import`, `expression`, `data:` URLs, remote assets, executable values,
prototype-polluting keys (`__proto__`, `constructor`, `prototype`).

Enforced: token-name whitelist derived from the semantic contract, strict
colour-format validation, maximum file size, maximum string length,
`schemaVersion` check, id normalisation, built-in id collision rejection,
duplicate imported id handling.

Import shows a preview first; cancelling changes no state; an invalid pack is
never applied and leaves state untouched. Imported packs are removable;
built-ins are not. Storage lives under its own `contextos.v1.*` key, separate
from preferences.

First release imports a **local JSON file only** — no GitHub/URL import, no
network layer. The validator/registry split leaves room for a remote source
later without writing one now.

No new Tauri command or capability is added if the existing frontend file
picker is sufficient. Browser-mode import is never presented as native
success.

---

## 12. Out of scope

Workbench redesign · navigation changes · Overview redesign · Qutra Chat ·
assistant drawer · tool calling · Qutra Live · voice/STT/TTS/wake word ·
global overlay · native Mica/Acrylic · Rust backend changes · Security Lab ·
GitHub · Terminal features · README screenshot golden updates.

---

## 13. Test strategy

Existing safety nets are **extended, never weakened**:
`styles/tokens.test.ts` (undefined-`var()` hunt, `--focus` prohibition) also
scans `design-system/`; `theme.contrast.test.ts` keeps parsing the real
shipped CSS rather than a duplicated palette.

Required unit coverage: registry completeness · duplicate ids · intrinsic
mode · manual/system/schedule resolution · `lastDarkTheme` preservation ·
migration (idempotent, real fixtures) · invalid persisted state · material
intent vs resolved separation · accent/destructive independence ·
prepaint/runtime parity · root attribute parity · High Contrast on/off ·
theme-pack validation (invalid token, invalid colour, unknown key, missing
field, bad `schemaVersion`, oversized file, built-in collision, import
success, import failure without mutation, remove imported, active-imported
removal fallback, export/import round-trip) · reset defaults.

**Contrast matrix** — all five themes, and not limited to body text:
body text · muted text · primary label · destructive label ·
success/warning/info labels · input text · placeholder · selected state ·
tooltip · focus ring. Normal text ≥ 4.5:1; large text / permitted
exceptions ≥ 3:1.

E2E (reusing `e2e/helpers.ts` and the existing Playwright config): navigate
to Appearance → set Graphite → Blue → Compact → reload → assert all three
persisted → select Qutra Light → assert core text visible → reset defaults →
assert Qutra Obsidian + Crimson + Comfortable. Screenshots may be captured
but are never on their own treated as proof.

---

## 14. Acceptance gates

**FAZ 1:** typecheck · lint · unit tests · build all green; app boots on
Qutra Obsidian + solid; no visible theme flash; existing main flows
reachable; old and new resolution provably not both live.

**FAZ 2:** five themes present and readable in solid; Appearance screen
working; four axes independent; persistence across reload; theme-pack
validator working with import/export tests; contrast matrix passing; E2E
switch + reload + reset passing; typecheck, lint, unit, build green; user
changes preserved; FAZ 3 not entered.
