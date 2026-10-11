import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";

/* Logos for registered tools with no bundled logo (Rust `tool_logos.rs`).
   The page names installations only; Rust reads each one's documentation
   address, decides where a logo may come from, fetches it once over HTTPS and
   keeps a 64 px PNG in the app's data folder. */

/** The backdrop a logo needs: `light` for dark ink on transparency, `dark`
    for light ink, `none` for an opaque square. */
export type LogoPlate = "none" | "light" | "dark";

export interface FetchedToolLogo {
  installationId: string;
  /** `unknown`: never tried. `none`: tried, nothing usable (letter tile). */
  state: "found" | "none" | "unknown";
  /** A `data:image/png` URL when found. */
  dataUrl: string | null;
  source: string | null;
  plate: LogoPlate | null;
}

export const toolLogos = {
  /** The browser build has no app data folder and fetches nothing. */
  available: (): boolean => getBridge().mode === "tauri",
  /** Recorded outcomes only; never touches the network. */
  list: (ids: string[]): Promise<FetchedToolLogo[]> =>
    invoke<FetchedToolLogo[]>("tool_logos_list", { ids }),
  /** One attempt per installation; a recorded outcome comes back as is. */
  fetch: (id: string): Promise<FetchedToolLogo> =>
    invoke<FetchedToolLogo>("tool_logo_fetch", { id }),
};
