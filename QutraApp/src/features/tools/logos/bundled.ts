import manifest from "@/assets/tool-logos/manifest.json";
import type { LogoPlate } from "@/lib/toolLogos";

/* The official logos bundled with the app (src/assets/tool-logos). The
   manifest names each logo's source and licence; a logo stands for every
   catalog id it lists (Wireshark's also stands for TShark). `?no-inline`
   keeps the PNGs as files next to the build, out of every JS chunk. */

export interface BundledLogo {
  url: string;
  plate: LogoPlate;
  source: string;
}

const files = import.meta.glob<string>("../../../assets/tool-logos/*.png", {
  eager: true,
  query: "?no-inline",
  import: "default",
});

const byId = new Map<string, BundledLogo>();
for (const entry of Object.values(manifest.logos)) {
  const url = files[`../../../assets/tool-logos/${entry.file}`];
  if (!url) continue;
  for (const id of entry.ids) {
    byId.set(id, { url, plate: entry.plate as LogoPlate, source: entry.source });
  }
}

/** The bundled logo for a launcher catalog id or a Private Lab guide id. */
export function bundledLogo(id: string | null | undefined): BundledLogo | undefined {
  return id ? byId.get(id) : undefined;
}
