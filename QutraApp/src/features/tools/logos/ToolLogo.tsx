import type { CSSProperties } from "react";
import { bundledLogo } from "./bundled";
import { useFetchedLogos } from "./fetchedLogos";
import "./toolLogo.css";

/** The letter tile: the program's first letter, OWASP aside. */
export function monogram(name: string): string {
  const word = name.split(/\s+/).find((w) => w.toUpperCase() !== "OWASP") ?? name;
  return word.charAt(0).toUpperCase();
}

/**
 * A tool's logo: the bundled official one for its catalog id, else the one
 * fetched for its installation, else its letter tile. Decorative: the name
 * always sits next to it, so it is hidden from screen readers.
 */
export function ToolLogo({
  name,
  catalogId,
  installationId,
  category,
  size = 32,
}: {
  name: string;
  /** A launcher catalog id or a Private Lab guide id. */
  catalogId?: string | null;
  installationId?: string | null;
  /** Tints the letter tile. */
  category?: string;
  size?: number;
}) {
  const fetched = useFetchedLogos((state) =>
    installationId ? state.byId[installationId] : undefined,
  );
  const bundled = bundledLogo(catalogId);
  const logo =
    bundled ??
    (fetched?.state === "found" && fetched.dataUrl
      ? { url: fetched.dataUrl, plate: fetched.plate ?? "none" }
      : undefined);
  const style = { "--logo-size": `${size}px` } as CSSProperties;
  if (!logo) {
    return (
      <span className="tlogo tlogo--letter" data-cat={category} style={style} aria-hidden>
        {monogram(name)}
      </span>
    );
  }
  return (
    <span className={`tlogo tlogo--plate-${logo.plate}`} style={style} aria-hidden>
      <img src={logo.url} alt="" width={size} height={size} draggable={false} decoding="async" />
    </span>
  );
}
