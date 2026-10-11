/* The launcher catalog (data contracts §6): one list composed from the two
   catalogs that exist, joined by an explicit crosswalk, never by name.

   - `domain/tools/registry.ts` — the 30 offline roadmap entries: built-ins,
     planned built-ins and external adapters.
   - `features/lab/toolCatalog.ts` — the 48 Private Lab guides: real tools,
     rule sets, services and threat concepts.

   The same id can mean different things in each (`cyberchef` is the built-in
   Transform workbench in one and the CyberChef web app in the other), so an
   entry joins another only when CROSSWALK says so.

   Static data here owns descriptions and what the product can honestly do
   with an item. The document store owns which installation the user said an
   item is (`installationBindings`). Rust owns the installation facts; every
   launch still resolves the installation id natively with a fresh hash. */

import type { InstallationBinding } from "@/domain/lab";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import {
  TOOL_CATALOG as GUIDES,
  matchesToolInstallation,
  type ToolCatalogEntry,
  type ToolInstallationIdentity,
} from "@/features/lab/toolCatalog";
import { TOOL_CATALOG as REGISTRY, type ToolEntry } from "./registry";

export type LaunchMode = "builtin" | "terminal" | "external_gui";

/** builtin: ships in the app. external: a user-installed program Qutra can
    hold an installation for. guide: study material with no executable.
    planned: a built-in that does not work yet. */
export type LauncherKind = "builtin" | "external" | "guide" | "planned";

export interface LauncherItem {
  catalogId: string;
  kind: LauncherKind;
  name: string;
  /** The offline registry entry, for its summary and panel. */
  registryId?: string;
  /** The Private Lab guide, for its localized purpose and telemetry. */
  guideId?: string;
  launchModes: LaunchMode[];
  /** Confirmed bindings to installations Rust still has. Empty until
      composed with bindings; see composeLauncher. */
  installationIds: string[];
}

export interface InstallationStatus {
  installationId: string;
  enabled: boolean;
  /** "last_verified" is a stored result, not a live check: launch re-hashes. */
  verification: "last_verified" | "changed" | "unknown";
  lastVerifiedAt: number | null;
}

/** Registry id -> guide id, for entries that are the same product. */
const CROSSWALK: Record<string, string> = {
  nmap: "nmap",
  zeek: "zeek",
  suricata: "suricata",
  zap: "zap",
  nikto: "nikto",
  nuclei: "nuclei",
  juiceshop: "juice-shop",
  semgrep: "semgrep",
  gitleaks: "gitleaks",
  trivy: "trivy",
  ghidra: "ghidra",
  volatility: "volatility",
};

/** A guide keeps its own id as catalog id unless a registry entry already
    uses it for something else. */
const GUIDE_CATALOG_IDS: Record<string, string> = {
  cyberchef: "cyberchef-web",
  sigma: "sigma-rules",
};

/** Guides with no program to run: rule sets, configurations, test libraries
    and the threat-concept families. */
const GUIDE_ONLY = new Set([
  "cyberchef",
  "sigma",
  "yara-rules",
  "sysmon-config",
  "atomic-red-team",
  "modsecurity",
  "post-exploitation-concepts",
  "credential-concepts",
  "stealer-concepts",
  "loader-concepts",
]);

/** How each external item can be opened, keyed by catalog id. Every external
    item is listed: a missing entry is a test failure, not a default. An empty
    list is a server or lab application Qutra can register but not start in a
    meaningful way; the Lab still runs it through a profile. */
const EXTERNAL_LAUNCH_MODES: Record<string, LaunchMode[]> = {
  // Registry adapters (joined with their guide where CROSSWALK says so).
  nmap: ["terminal"],
  tshark: ["terminal"],
  dns: ["terminal"],
  zeek: ["terminal"],
  suricata: ["terminal"],
  zap: ["external_gui"],
  burp: ["external_gui"],
  nikto: ["terminal"],
  nuclei: ["terminal"],
  juiceshop: [],
  semgrep: ["terminal"],
  gitleaks: ["terminal"],
  trivy: ["terminal"],
  ghidra: ["external_gui"],
  yara: ["terminal"],
  volatility: ["terminal"],
  // Guide-only programs.
  wireshark: ["external_gui"],
  imhex: ["external_gui"],
  "detect-it-easy": ["external_gui"],
  "pe-bear": ["external_gui"],
  dnspyex: ["external_gui"],
  ilspy: ["external_gui"],
  exiftool: ["terminal"],
  jq: ["terminal"],
  osquery: ["terminal"],
  syft: ["terminal"],
  grype: ["terminal"],
  trufflehog: ["terminal"],
  capa: ["terminal"],
  masscan: ["terminal"],
  amass: ["terminal"],
  responder: ["terminal"],
  hashcat: ["terminal"],
  john: ["terminal"],
  sqlmap: ["terminal"],
  metasploit: ["terminal"],
  webgoat: [],
  dvwa: [],
  caldera: [],
  wazuh: [],
  velociraptor: [],
  bloodhound: [],
};

function externalModes(catalogId: string): LaunchMode[] {
  const modes = EXTERNAL_LAUNCH_MODES[catalogId];
  if (!modes) throw new Error(`launcher: no launch modes declared for ${catalogId}`);
  return modes;
}

function fromRegistry(entry: ToolEntry): LauncherItem {
  const guideId = CROSSWALK[entry.id];
  // A joined item goes by the product's name ("Nmap"), not the registry's
  // feature title ("Nmap dashboard").
  const name = GUIDES.find((guide) => guide.id === guideId)?.name ?? entry.name;
  const base = { catalogId: entry.id, name, registryId: entry.id, installationIds: [] };
  if (entry.status === "builtin-working") {
    return { ...base, kind: "builtin", launchModes: ["builtin"] };
  }
  if (entry.status === "builtin-planned") {
    return { ...base, kind: "planned", launchModes: [] };
  }
  return { ...base, kind: "external", guideId, launchModes: externalModes(entry.id) };
}

function fromGuide(guide: ToolCatalogEntry): LauncherItem {
  const catalogId = GUIDE_CATALOG_IDS[guide.id] ?? guide.id;
  const base = { catalogId, name: guide.name, guideId: guide.id, installationIds: [] };
  if (guide.category === "threat_concepts" || GUIDE_ONLY.has(guide.id)) {
    return { ...base, kind: "guide", launchModes: [] };
  }
  return { ...base, kind: "external", launchModes: externalModes(catalogId) };
}

const joinedGuides = new Set(Object.values(CROSSWALK));

export const LAUNCHER_ITEMS: readonly LauncherItem[] = [
  ...REGISTRY.map(fromRegistry),
  ...GUIDES.filter((guide) => !joinedGuides.has(guide.id)).map(fromGuide),
];

const byId = new Map(LAUNCHER_ITEMS.map((item) => [item.catalogId, item]));

export function launcherItem(catalogId: string): LauncherItem | undefined {
  return byId.get(catalogId);
}

/** Only an external item can hold an installation. A binding to anything
    else would hand a built-in, a plan or a guide a binary to launch. */
export function canHoldInstallation(item: LauncherItem | undefined): boolean {
  return item?.kind === "external";
}

/** The items an installation can be bound to, by name. */
export function bindableLauncherItems(): LauncherItem[] {
  return LAUNCHER_ITEMS.filter(canHoldInstallation).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
}

/** The launcher with each item's confirmed installations. Installations are
    counted from Rust's records: a binding whose installation was removed
    natively is dropped, and nothing is matched by name. */
export function composeLauncher(
  bindings: readonly InstallationBinding[],
  installations: readonly NativeToolInstallation[],
): LauncherItem[] {
  const present = new Set(installations.map((installation) => installation.id));
  const bound = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!present.has(binding.installationId)) continue;
    if (!canHoldInstallation(byId.get(binding.catalogId))) continue;
    const ids = bound.get(binding.catalogId) ?? [];
    if (!ids.includes(binding.installationId)) ids.push(binding.installationId);
    bound.set(binding.catalogId, ids);
  }
  return LAUNCHER_ITEMS.map((item) => ({
    ...item,
    installationIds: bound.get(item.catalogId) ?? [],
  }));
}

/** Catalog items an installation might be, from its name, tags and docs URL.
    A suggestion for the user to confirm, never a binding. */
export function suggestCatalogIds(identity: ToolInstallationIdentity): string[] {
  return LAUNCHER_ITEMS.filter(canHoldInstallation)
    .filter((item) => {
      const guide = item.guideId ? GUIDES.find((entry) => entry.id === item.guideId) : undefined;
      const registry = item.registryId
        ? REGISTRY.find((entry) => entry.id === item.registryId)
        : undefined;
      const probes: Array<Pick<ToolCatalogEntry, "id" | "name" | "repository">> = [];
      if (guide) probes.push(guide);
      if (registry) probes.push({ id: registry.id, name: registry.executable ?? registry.name });
      return probes.some((probe) => matchesToolInstallation(probe, identity));
    })
    .map((item) => item.catalogId);
}

export function installationStatus(installation: NativeToolInstallation): InstallationStatus {
  const lastVerifiedAt = installation.lastVerifiedAt > 0 ? installation.lastVerifiedAt : null;
  return {
    installationId: installation.id,
    enabled: installation.enabled,
    verification: installation.changedSinceVerify
      ? "changed"
      : lastVerifiedAt === null
        ? "unknown"
        : "last_verified",
    lastVerifiedAt,
  };
}
