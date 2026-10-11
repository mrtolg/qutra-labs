/* The tool launcher grid (data contracts §6).
   One tile per external program the launcher can open. A tile's status comes
   from the user's confirmed binding and Rust's installation record, never
   from a name, and a missing binding proves "Not registered", not "Not
   installed". Every actual launch still resolves the installation natively. */

import type { InstallationBinding } from "@/domain/lab";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { TOOL_CATALOG as GUIDES, type ToolCatalogEntry } from "@/features/lab/toolCatalog";
import { TOOL_CATALOG as REGISTRY } from "./registry";
import { composeLauncher, suggestCatalogIds, type LaunchMode } from "./launcher";

export type LauncherCategory = Exclude<ToolCatalogEntry["category"], "threat_concepts">;

/** Chip order: the four main categories first, then the rest of the guide taxonomy. */
export const LAUNCHER_CATEGORIES: readonly LauncherCategory[] = [
  "network",
  "web",
  "code",
  "dfir",
  "reverse",
  "detection",
  "password",
  "emulation",
];

export type OpenMode = Exclude<LaunchMode, "builtin">;

export type TileStatus =
  | { kind: "ready"; installation: NativeToolInstallation }
  | { kind: "changed"; installation: NativeToolInstallation }
  | { kind: "disabled"; installation: NativeToolInstallation }
  /** Linked, but the registered file is no longer on disk. */
  | { kind: "file_missing"; installation: NativeToolInstallation }
  | { kind: "not_registered" };

export interface LauncherTile {
  catalogId: string;
  /** The product's own name; not translated. */
  name: string;
  category: LauncherCategory;
  /** Purpose text: the registry's translated summary when there is one. */
  registryId?: string;
  /** Otherwise the Private Lab guide's purpose. */
  guideId?: string;
  modes: OpenMode[];
  status: TileStatus;
  /** For a tile that is not registered: installations Rust holds that no
      binding claims and whose name suggests this program. Linking one is the
      user's choice; nothing is linked by name. */
  candidates: NativeToolInstallation[];
  /** Where to get the program: the registry's install page or the guide's
      repository. Every tile has one, so no tile is a dead end. */
  downloadUrl: string;
}

/** Registry adapters with no guide go by a feature title ("Burp Suite
    organizer"); a tile names the program. */
const PRODUCT_NAMES: Record<string, string> = {
  tshark: "TShark",
  dns: "dig",
  burp: "Burp Suite",
  yara: "YARA",
};

const STATUS_ORDER: Record<TileStatus["kind"], number> = {
  ready: 0,
  changed: 1,
  disabled: 2,
  file_missing: 3,
  not_registered: 4,
};

function statusOf(installations: NativeToolInstallation[]): TileStatus {
  // A file that is gone cannot be run, so it never makes a tile ready, and
  // another link to a file that is still there wins over it.
  const present = installations.filter((i) => !i.fileMissing);
  const ready = present.find((i) => i.enabled && !i.changedSinceVerify);
  if (ready) return { kind: "ready", installation: ready };
  const missing = installations.find((i) => i.fileMissing);
  if (missing && present.length === 0) return { kind: "file_missing", installation: missing };
  const changed = present.find((i) => i.changedSinceVerify);
  if (changed) return { kind: "changed", installation: changed };
  const disabled = present[0];
  if (disabled) return { kind: "disabled", installation: disabled };
  return { kind: "not_registered" };
}

/** The guide taxonomy mapped onto the five native installation categories,
    which decide whether a profile asks for a scope (network and web do). */
const NATIVE_CATEGORY: Record<LauncherCategory, NativeToolInstallation["category"]> = {
  network: "network",
  web: "web",
  code: "code",
  dfir: "dfir",
  reverse: "dfir",
  detection: "network",
  password: "local",
  emulation: "network",
};

/** The category the register review starts with when the user locates a
    tile's program: the registry's own where it has one. The user can still
    change it in the review. */
export function registerCategoryFor(tile: LauncherTile): NativeToolInstallation["category"] {
  const registry = tile.registryId ? REGISTRY.find((r) => r.id === tile.registryId) : undefined;
  return registry?.category ?? NATIVE_CATEGORY[tile.category];
}

/** The launcher's tiles, ready ones first. */
export function launcherTiles(
  bindings: readonly InstallationBinding[],
  installations: readonly NativeToolInstallation[],
): LauncherTile[] {
  const byId = new Map(installations.map((i) => [i.id, i]));
  const claimed = new Set(bindings.map((b) => b.installationId));
  const suggested = new Map<string, NativeToolInstallation[]>();
  // A file that is gone is not offered as something to link to.
  for (const unbound of installations.filter((i) => !claimed.has(i.id) && !i.fileMissing)) {
    for (const catalogId of suggestCatalogIds(unbound)) {
      suggested.set(catalogId, [...(suggested.get(catalogId) ?? []), unbound]);
    }
  }
  const tiles: LauncherTile[] = [];
  for (const item of composeLauncher(bindings, installations)) {
    const modes = item.launchModes.filter((m): m is OpenMode => m !== "builtin");
    if (item.kind !== "external" || modes.length === 0) continue;
    const guide = item.guideId ? GUIDES.find((g) => g.id === item.guideId) : undefined;
    const registry = item.registryId ? REGISTRY.find((r) => r.id === item.registryId) : undefined;
    const category = (guide?.category ?? registry?.category) as LauncherCategory;
    const downloadUrl = registry?.installUrl ?? guide?.repository ?? "";
    const status = statusOf(item.installationIds.flatMap((id) => byId.get(id) ?? []));
    tiles.push({
      catalogId: item.catalogId,
      name: PRODUCT_NAMES[item.catalogId] ?? item.name,
      category,
      registryId: item.registryId,
      guideId: item.guideId,
      modes,
      status,
      candidates:
        status.kind === "not_registered" ? (suggested.get(item.catalogId) ?? []) : [],
      downloadUrl,
    });
  }
  return tiles.sort(
    (a, b) =>
      STATUS_ORDER[a.status.kind] - STATUS_ORDER[b.status.kind] ||
      a.name.localeCompare(b.name, "en"),
  );
}
