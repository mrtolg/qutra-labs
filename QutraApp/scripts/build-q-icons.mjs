/**
 * Qutra Labs brand + app icons, generated from code.
 *
 *   npm run brand:icons            # everything, including `tauri icon` for macOS/mobile
 *   node scripts/build-q-icons.mjs --no-tauri
 *
 * The mark is the Q+L monogram (2026-09): a ring broken at 45° with a
 * tail that runs down into a horizontal foot — the Q of Qutra and the L of Labs.
 * Geometry below was measured from the original 1920 px artwork and normalised
 * so the ring's outer radius is 1 and its centre is (0, 0).
 *
 * Two variants: the mark takes the theme's identity
 * colour. Cyan for the hud pack in dark mode, red for every other pack and
 * every light mode; high contrast is red and flat (the glow is CSS). The exe
 * and Start-menu icon are cyan; the window icon follows the theme at runtime
 * through the Rust command set_brand_window_icon, which only picks one of the
 * two bundled window-*.png files.
 *
 * Outputs
 *   assets/brand/logo-master.svg     the flat logo, red, in its exact colours
 *   assets/brand/logo-master-cyan.svg the flat logo, cyan
 *   assets/brand/logo-neon.svg       app-icon master, full neon (>= 64 px), cyan
 *   assets/brand/logo-neon-small.svg app-icon master, bright tube only (<= 24 px), cyan
 *   assets/brand/q-app-icon.ico      16 20 24 32 40 48 64 96 128 256, cyan
 *   public/brand/q-mark.svg          in-app mark (top bar), red; glow is CSS
 *   public/brand/q-mark-cyan.svg     in-app mark (top bar), cyan
 *   public/favicon.png               64 px icon, cyan
 *   src-tauri/icons/*                every Windows size, rendered at its own size, cyan
 *   src-tauri/icons/window-{cyan,red}.png  64 px runtime window icons
 *
 * Two rules make it sharp:
 *   - The ring is centred. A Q is its ring; the foot is allowed to reach right.
 *   - Optical sizing. One drawing does not survive every size: strokes thicken
 *     as the icon shrinks so no line goes sub-pixel, and the neon is shed in
 *     steps — bright tube only at <= 24 px, a tight glow at 32-48 px, and the
 *     white-hot core and bloom only from 64 px, where they can be seen.
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(root, "assets", "brand");
const icons = join(root, "src-tauri", "icons");
const pub = join(root, "public");

// ---- geometry (unit space: ring outer radius 1, centre 0,0)
const C = -0.014; //         tail centre line: y - x = C
const TOP = 0.322; //        tail's horizontal top edge
const FOOT_Y = 0.8395; //    foot's top edge
const FOOT_X = 1.159; //     foot's top-right corner
const CUT_A = -0.493; //     upper cut of the ring gap: y = x + CUT_A
const CUT_B = 0.466; //      lower cut of the ring gap: y = x + CUT_B

// Two palettes. `art` is the flat logo, sampled from the original artwork
// (red ring #600000 -> #FF0000, cyan ring #073A3D -> #37D6E0); the rest is
// the neon sign: tube gradient, flat tube at small sizes, glow, bloom, core.
const PALETTES = {
  red: {
    art: {
      ring: [["0", "#5a0000"], ["0.5", "#a60000"], ["1", "#ff0a0a"]],
      tail: [["0", "#b00000"], ["1", "#5e0000"]],
      foot: [["0", "#3e0000"], ["0.35", "#560000"], ["1", "#8c0000"]],
    },
    tube: ["#d40a0a", "#ff3b30"], flat: "#ff2a22", glowM: "#ff1f1f",
    bloom: "#ff1010", glowL: "#ff2a2a", core: "#ffe3e0",
  },
  cyan: {
    art: {
      ring: [["0", "#073a3d"], ["0.5", "#168a91"], ["1", "#37d6e0"]],
      tail: [["0", "#1a9aa2"], ["1", "#07383b"]],
      foot: [["0", "#04282a"], ["0.35", "#063639"], ["1", "#0f6a70"]],
    },
    tube: ["#12b4bf", "#5ee6ee"], flat: "#37d6e0", glowM: "#22c9d4",
    bloom: "#10bcc8", glowL: "#2ed2dc", core: "#e2fdff",
  },
};

const tier = (px) => (px <= 24 ? "S" : px <= 48 ? "M" : "L");

function geom(t) {
  const k = t === "S" ? { ring: 1.55, tail: 1.3, foot: 1.5 }
          : t === "M" ? { ring: 1.2, tail: 1.1, foot: 1.25 }
          : { ring: 1, tail: 1, foot: 1 };
  return { ring: 0.144 * k.ring, hw: (0.274 * k.tail) / 2, foot: 0.1295 * k.foot };
}

function shapes(t, idp, fills) {
  const { ring, hw, foot } = geom(t);
  const ri = 1 - ring;
  const tlx = TOP - C - hw, trx = TOP - C + hw;
  const blx = FOOT_Y - C - hw, brx = FOOT_Y - C + hw;
  const fy2 = FOOT_Y + foot;
  return `
    <path mask="url(#${idp}gap)" fill-rule="evenodd" fill="${fills.ring}"
      d="M1 0A1 1 0 1 0 -1 0A1 1 0 1 0 1 0Z M${ri} 0A${ri} ${ri} 0 1 1 ${-ri} 0A${ri} ${ri} 0 1 1 ${ri} 0Z"/>
    <polygon fill="${fills.tail}" points="${tlx},${TOP} ${trx},${TOP} ${brx},${FOOT_Y} ${blx},${FOOT_Y}"/>
    <polygon fill="${fills.foot}" points="${blx},${FOOT_Y} ${FOOT_X},${FOOT_Y} ${FOOT_X + foot},${fy2} ${blx + foot},${fy2}"/>`;
}

const gapMask = (idp) => `<mask id="${idp}gap" maskUnits="userSpaceOnUse" x="-3" y="-3" width="6" height="6">
    <rect x="-3" y="-3" width="6" height="6" fill="#fff"/>
    <polygon fill="#000" points="${-CUT_A / 2},${CUT_A / 2} 3,${3 + CUT_A} ${3 - CUT_B},3 ${-CUT_B / 2},${CUT_B / 2}"/></mask>`;

// the neon sign: optional bloom + glow behind the tube, white-hot core inside it
function neon(t, idp, pal) {
  const { ring, foot } = geom(t);
  const same = (c) => ({ ring: c, tail: c, foot: c });
  const cw = ring * 0.3;
  const yfc = FOOT_Y + foot / 2;
  // the core bends from the tail into the foot, the way a real tube is bent
  const core = `
    <circle mask="url(#${idp}gap)" cx="0" cy="0" r="${1 - ring / 2}" fill="none" stroke="${pal.core}" stroke-width="${cw}"/>
    <path d="M${TOP - C + cw * 0.2} ${TOP + cw * 0.6} L${yfc - C} ${yfc} L${FOOT_X + foot / 2 - cw} ${yfc}"
      fill="none" stroke="${pal.core}" stroke-width="${cw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // Filter regions reach past the blur on every side; one that started at the
  // ring's edge (-1) cut the bloom off in a visible square.
  const defs = `${gapMask(idp)}
    <linearGradient id="${idp}tube" gradientUnits="userSpaceOnUse" x1="-1" y1="0" x2="1.3" y2="0">
      <stop offset="0" stop-color="${pal.tube[0]}"/><stop offset="1" stop-color="${pal.tube[1]}"/></linearGradient>
    <filter id="${idp}bloom" x="-2" y="-2" width="4" height="4" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="0.14"/></filter>
    <filter id="${idp}glow" x="-2" y="-2" width="4" height="4" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="${t === "M" ? 0.05 : 0.042}"/></filter>
    <filter id="${idp}soft" x="-2" y="-2" width="4" height="4" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="0.008"/></filter>`;
  const tube = `url(#${idp}tube)`;
  let body = shapes(t, idp, same(pal.flat));
  if (t === "M") body = `<g filter="url(#${idp}glow)" opacity=".75">${shapes(t, idp, same(pal.glowM))}</g>${shapes(t, idp, same(tube))}`;
  if (t === "L") body = `
    <g filter="url(#${idp}bloom)" opacity=".5">${shapes(t, idp, same(pal.bloom))}</g>
    <g filter="url(#${idp}glow)" opacity=".95">${shapes(t, idp, same(pal.glowL))}</g>
    ${shapes(t, idp, same(tube))}
    <g filter="url(#${idp}soft)" opacity=".92">${core}</g>`;
  return { defs, body };
}

// app icon at `px`: dark rounded plate, ring centred, foot's tip sets the scale
function iconSvg(px, pal = PALETTES.cyan) {
  const t = tier(px);
  const pad = t === "S" ? 24 : t === "M" ? 48 : 64;
  const plate = 1024 - pad * 2;
  const rx = plate * (t === "S" ? 0.2 : 0.23);
  const right = FOOT_X + geom(t).foot;
  const margin = plate * (t === "S" ? 0.03 : t === "M" ? 0.06 : 0.08);
  const s = (plate / 2 - margin) / right;
  const dev = 1024 / px;
  const { defs, body } = neon(t, "i", pal);
  const edge = px >= 24
    ? `<rect x="${pad + dev / 2}" y="${pad + dev / 2}" width="${plate - dev}" height="${plate - dev}" rx="${rx - dev / 2}" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="${dev}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="pd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1f24"/><stop offset="1" stop-color="#0b0c0e"/></linearGradient>
    <clipPath id="pc"><rect x="${pad}" y="${pad}" width="${plate}" height="${plate}" rx="${rx}"/></clipPath>
  </defs>
  <rect x="${pad}" y="${pad}" width="${plate}" height="${plate}" rx="${rx}" fill="url(#pd)"/>
  <g clip-path="url(#pc)"><g transform="translate(512 512) scale(${s})"><defs>${defs}</defs>${body}</g></g>
  ${edge}
</svg>
`;
}

// the flat logo in its exact colours, transparent, ring centred
function logoSvg(pal) {
  const grad = (id, stops, x1, y1, x2, y2) =>
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops
      .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
  const { hw, foot } = geom("L");
  const defs = `${gapMask("l")}
    ${grad("lR", pal.art.ring, -1, 0, 1, 0)}
    ${grad("lT", pal.art.tail, TOP - C - hw, TOP, FOOT_Y - C + hw, FOOT_Y + foot)}
    ${grad("lF", pal.art.foot, FOOT_Y - C - hw, 0, FOOT_X + foot, 0)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-1.34 -1.34 2.68 2.68" role="img" aria-label="Qutra Labs">
  <defs>${defs}</defs>${shapes("L", "l", { ring: "url(#lR)", tail: "url(#lT)", foot: "url(#lF)" })}
</svg>
`;
}

// in-app mark: vector, so it is crisp at every display scale. Drawn at the
// small tier because it lives at ~18-20 CSS px; the neon glow is added in CSS.
function markSvg(pal) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.34 -1.34 2.68 2.68" width="20" height="20">
  <defs>${gapMask("m")}</defs>${shapes("S", "m", { ring: pal.flat, tail: pal.flat, foot: pal.flat })}
</svg>
`;
}

const render = (svg, px) =>
  new Resvg(svg, { fitTo: { mode: "width", value: px }, background: "rgba(0,0,0,0)" }).render().asPng();

function buildIco(frames) {
  const head = 6 + frames.length * 16;
  let off = head;
  const buf = Buffer.alloc(head + frames.reduce((n, f) => n + f.data.length, 0));
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(frames.length, 4);
  frames.forEach((f, i) => {
    const o = 6 + i * 16;
    buf[o] = f.px >= 256 ? 0 : f.px;
    buf[o + 1] = f.px >= 256 ? 0 : f.px;
    buf.writeUInt16LE(1, o + 4);
    buf.writeUInt16LE(32, o + 6);
    buf.writeUInt32LE(f.data.length, o + 8);
    buf.writeUInt32LE(off, o + 12);
    f.data.copy(buf, off);
    off += f.data.length;
  });
  return buf;
}

// ---- write
fs.mkdirSync(join(pub, "brand"), { recursive: true });
fs.writeFileSync(join(brand, "logo-master.svg"), logoSvg(PALETTES.red));
fs.writeFileSync(join(brand, "logo-master-cyan.svg"), logoSvg(PALETTES.cyan));
fs.writeFileSync(join(brand, "logo-neon.svg"), iconSvg(1024));
fs.writeFileSync(join(brand, "logo-neon-small.svg"), iconSvg(16));
fs.writeFileSync(join(pub, "brand", "q-mark.svg"), markSvg(PALETTES.red));
fs.writeFileSync(join(pub, "brand", "q-mark-cyan.svg"), markSvg(PALETTES.cyan));
const master = render(iconSvg(1024), 1024);
fs.writeFileSync(join(brand, "logo-1024.png"), master);

// macOS / mobile sets come from `tauri icon`; Windows sizes are overwritten
// below with renders made at their own size.
if (!process.argv.includes("--no-tauri")) {
  const r = spawnSync("npx", ["tauri", "icon", join(brand, "logo-1024.png"), "-o", icons], {
    cwd: root, stdio: "inherit", shell: true,
  });
  if (r.status !== 0) {
    console.error("tauri icon failed; Windows icons are still written below");
  }
}

const ICO = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const frames = ICO.map((px) => ({ px, data: render(iconSvg(px), px) }));
const ico = buildIco(frames);
fs.writeFileSync(join(brand, "q-app-icon.ico"), ico);
fs.writeFileSync(join(icons, "icon.ico"), ico);

const WINDOWS = {
  "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
  "StoreLogo.png": 50, "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310,
};
for (const [file, px] of Object.entries(WINDOWS)) {
  fs.writeFileSync(join(icons, file), render(iconSvg(px), px));
}
fs.writeFileSync(join(brand, "logo-64.png"), render(iconSvg(64), 64));
fs.writeFileSync(join(pub, "favicon.png"), render(iconSvg(64), 64));
// Runtime window icons, one per variant; Rust bundles both and picks by name.
for (const [name, pal] of Object.entries(PALETTES)) {
  fs.writeFileSync(join(icons, `window-${name}.png`), render(iconSvg(64, pal), 64));
}

console.log(`brand: logo-master{,-cyan}.svg, logo-neon*.svg, q-app-icon.ico (${ICO.join(" ")})`);
console.log(`public: brand/q-mark{,-cyan}.svg, favicon.png · src-tauri/icons: ${Object.keys(WINDOWS).length + 1} Windows files + window-{cyan,red}.png`);
