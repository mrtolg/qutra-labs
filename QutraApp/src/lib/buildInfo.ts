/**
 * Which source this binary was built from. Stamped by `vite.config.ts` at
 * build time (`__QUTRA_BUILD__`). Every build reports APP_VERSION "0.1.0",
 * so without this nobody can tell whether the installed app matches the
 * current commit.
 */
export interface BuildInfo {
  /** Short commit hash, or "unknown" when git was not available. */
  commit: string;
  /** True when tracked files had uncommitted changes at build time. */
  dirty: boolean;
  /** ISO timestamp of the build, or "" when unknown. */
  builtAt: string;
}

declare const __QUTRA_BUILD__: BuildInfo | undefined;

export const BUILD_INFO: BuildInfo =
  typeof __QUTRA_BUILD__ !== "undefined"
    ? __QUTRA_BUILD__
    : { commit: "unknown", dirty: false, builtAt: "" };

/** `5c8fad1a2b3c-dirty · 2026-09-28` — a readout, not prose, so no locale. */
export function formatBuild(info: BuildInfo): string {
  const commit = info.dirty ? `${info.commit}-dirty` : info.commit;
  const day = info.builtAt.slice(0, 10);
  return day ? `${commit} · ${day}` : commit;
}
