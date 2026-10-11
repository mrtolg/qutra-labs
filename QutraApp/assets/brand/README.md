# Brand assets

## The mark

A **Q+L monogram**: a ring broken at 45°, with a tail that runs down into a
horizontal foot. The ring is the Q of Qutra; the tail and foot together are the
L of Labs. Adopted 2026-09 from the original artwork.

It comes in **two colours, and the mark takes the theme's identity colour**
(design decision, 2026-09-29): cyan in the `hud` pack's dark mode, red in
every other pack and every light mode, red and flat in high contrast. The exe
and Start-menu icon are cyan.

Everything here is generated from code in `scripts/build-q-icons.mjs` — edit
the geometry or colours there, not the output files.

Two rules make it sharp, and both are enforced by the script:

- **The ring is centred.** A Q is its ring. The foot is allowed to reach right;
  centring the bounding box instead pushes the ring off-centre.
- **Optical sizing.** One drawing does not survive every size. Strokes thicken
  as the icon shrinks so no line goes sub-pixel, and the neon is shed in steps:
  bright tube only at ≤ 24 px, a tight glow at 32–48 px, and the white-hot core
  and bloom only from 64 px, where they can be seen.

## Files

| File | What it is |
|---|---|
| `logo-master.svg`, `logo-master-cyan.svg` | The flat logo in its exact colours (red, cyan), transparent. Use for README, site, print |
| `logo-neon.svg` | App-icon master, full neon on the dark plate (≥ 64 px), cyan |
| `logo-neon-small.svg` | App-icon master, bright tube only (≤ 24 px), cyan |
| `logo-1024.png`, `logo-64.png` | Rendered app icon, cyan |
| `q-app-icon.ico` | Windows icon, cyan: 16 20 24 32 40 48 64 96 128 256 — including the 20/24/40 frames Windows uses at 125% and 150% scaling |
| `../../public/brand/q-mark.svg`, `q-mark-cyan.svg` | In-app mark (top bar), red and cyan. Vector; its neon glow is CSS |
| `../../public/favicon.png` | 64 px app icon, cyan |
| `../../src-tauri/icons/window-cyan.png`, `window-red.png` | 64 px runtime window icons. Compiled into the binary; `set_brand_window_icon` picks one by name |
| `alternates/q-red-2026-07.svg` | The previous red Q, kept for history |

## Rules for using it

- **Neon is for dark surfaces.** On light and high-contrast themes the in-app
  mark drops its glow.
- **The mark takes the theme's identity colour.** Cyan where the theme's
  identity is cyan (hud dark), red elsewhere. The red variant is brand colour,
  not the danger token; inside the UI, red still means danger.
- **Never scale a raster down to a small size.** Every Windows size is rendered
  at its own size. `public/favicon.png` was once a 64 px PNG shrunk to 16 in the
  titlebar — and was never committed, so the titlebar showed a black box.

## Regenerate

```bash
npm run brand:icons
```

Writes every file above, runs `tauri icon` for the macOS and mobile sets, then
overwrites every Windows size with a render made at that size. Pass
`--no-tauri` to skip the `tauri icon` step.

## Product name

User-facing: **Qutra Labs**. The assistant persona: **Jarvis**. Internal
identifiers stay `contextos` (see `docs/decisions/0011-product-name.md`).
