import { describe, expect, it } from "vitest";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import type { InstallationBinding } from "@/domain/lab";
import { TOOL_CATALOG as GUIDES } from "@/features/lab/toolCatalog";
import { TOOL_CATALOG as REGISTRY } from "./registry";
import {
  LAUNCHER_ITEMS,
  composeLauncher,
  installationStatus,
  launcherItem,
  suggestCatalogIds,
} from "./launcher";

// Ids shaped like Rust's: `tool-<uuid4>`.
const NMAP_INSTALL = "tool-6c0d2f9a-1e7b-4c35-8a92-d4b1f03e7c58";
const NMAP_SECOND = "tool-0b8e61d4-3a2f-4f7c-9e15-7d2ac4b09e36";
const IMHEX_INSTALL = "tool-f47e2b90-58c1-4d6a-a3e7-1c9d05b8f2aa";

function installation(
  id: string,
  displayName: string,
  overrides: Partial<NativeToolInstallation> = {},
): NativeToolInstallation {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `\\\\?\\C:\\Program Files\\${displayName}\\${displayName}.exe`,
    sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
    sizeBytes: 2_977_792,
    version: "",
    publisher: "",
    signatureState: "unsigned",
    category: "network",
    riskTier: "medium",
    docUrl: "",
    tags: [],
    workingDir: `\\\\?\\C:\\Program Files\\${displayName}`,
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1_790_800_000_000,
    updatedAt: 1_790_800_000_000,
    lastVerifiedAt: 1_790_800_000_000,
    ...overrides,
  };
}

function binding(catalogId: string, installationId: string): InstallationBinding {
  return {
    id: installationId,
    catalogId,
    installationId,
    confirmedAt: 1_790_800_100_000,
  };
}

describe("launcher crosswalk", () => {
  it("covers every entry of both catalogs exactly once, under unique ids", () => {
    const ids = LAUNCHER_ITEMS.map((item) => item.catalogId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of REGISTRY) {
      expect(
        LAUNCHER_ITEMS.filter((item) => item.registryId === entry.id),
        entry.id,
      ).toHaveLength(1);
    }
    for (const guide of GUIDES) {
      expect(
        LAUNCHER_ITEMS.filter((item) => item.guideId === guide.id),
        guide.id,
      ).toHaveLength(1);
    }
  });

  it("joins the same product and keeps different products apart", () => {
    expect(launcherItem("nmap")).toMatchObject({ registryId: "nmap", guideId: "nmap" });
    expect(launcherItem("juiceshop")).toMatchObject({ guideId: "juice-shop" });

    // `cyberchef` is the built-in Transform workbench in one catalog and a
    // reference to the CyberChef web app in the other.
    const workbench = launcherItem("cyberchef");
    expect(workbench?.kind).toBe("builtin");
    expect(workbench?.guideId).toBeUndefined();
    const reference = LAUNCHER_ITEMS.find((item) => item.guideId === "cyberchef");
    expect(reference?.catalogId).not.toBe("cyberchef");
    expect(reference?.registryId).toBeUndefined();

    // TShark is a terminal tool, Wireshark a GUI: two items, two modes.
    expect(launcherItem("tshark")?.launchModes).toEqual(["terminal"]);
    const wireshark = LAUNCHER_ITEMS.find((item) => item.guideId === "wireshark");
    expect(wireshark?.launchModes).toEqual(["external_gui"]);

    // A built-in never absorbs the real tool it stands beside (the metadata
    // inspector is not ExifTool), and a planned one stays planned.
    expect(launcherItem("metadata")?.kind).toBe("builtin");
    expect(launcherItem("sigma")?.kind).toBe("planned");
    for (const id of ["metadata", "sigma"]) {
      expect(launcherItem(id)?.guideId, id).toBeUndefined();
    }
  });

  it("promises only the launch modes each kind can honour", () => {
    for (const item of LAUNCHER_ITEMS) {
      if (item.kind === "builtin") expect(item.launchModes, item.catalogId).toEqual(["builtin"]);
      if (item.kind === "planned" || item.kind === "guide") {
        expect(item.launchModes, item.catalogId).toEqual([]);
      }
      if (item.kind === "external") {
        expect(item.launchModes, item.catalogId).not.toContain("builtin");
      }
    }
    // Threat concepts and rule sets have no executable at all.
    expect(LAUNCHER_ITEMS.find((item) => item.guideId === "credential-concepts")?.kind).toBe(
      "guide",
    );
    expect(LAUNCHER_ITEMS.find((item) => item.guideId === "yara-rules")?.kind).toBe("guide");
    // GUI-only tools never promise an embedded terminal.
    expect(launcherItem("ghidra")?.launchModes).toEqual(["external_gui"]);
    expect(launcherItem("burp")?.launchModes).toEqual(["external_gui"]);
  });
});

describe("composeLauncher", () => {
  it("lists only confirmed bindings to installations that exist natively", () => {
    const installs = [
      installation(NMAP_INSTALL, "nmap"),
      installation(NMAP_SECOND, "nmap-7.94"),
    ];
    const items = composeLauncher(
      [
        binding("nmap", NMAP_INSTALL),
        binding("nmap", NMAP_SECOND),
        // Registered once, since removed natively: not counted.
        binding("nmap", "tool-2e9d7a13-6b40-4f85-b1c2-8a3e5f07d964"),
      ],
      installs,
    );
    expect(items.find((item) => item.catalogId === "nmap")?.installationIds).toEqual([
      NMAP_INSTALL,
      NMAP_SECOND,
    ]);
  });

  it("never matches by name: an unbound installation stays unbound", () => {
    const items = composeLauncher([], [installation(NMAP_INSTALL, "nmap")]);
    expect(items.every((item) => item.installationIds.length === 0)).toBe(true);
  });

  it("ignores a binding that would give a built-in, planned or guide item a binary", () => {
    const installs = [installation(IMHEX_INSTALL, "imhex")];
    const guideId = LAUNCHER_ITEMS.find((item) => item.guideId === "loader-concepts")!.catalogId;
    const items = composeLauncher(
      [
        binding("cyberchef", IMHEX_INSTALL),
        binding("keyviz", IMHEX_INSTALL),
        binding(guideId, IMHEX_INSTALL),
      ],
      installs,
    );
    for (const id of ["cyberchef", "keyviz", guideId]) {
      expect(items.find((item) => item.catalogId === id)?.installationIds, id).toEqual([]);
    }
  });
});

describe("suggestCatalogIds", () => {
  it("suggests from the name but never binds", () => {
    expect(suggestCatalogIds(installation(NMAP_INSTALL, "nmap"))).toContain("nmap");
    expect(suggestCatalogIds(installation(IMHEX_INSTALL, "imhex"))).toEqual([
      LAUNCHER_ITEMS.find((item) => item.guideId === "imhex")!.catalogId,
    ]);
  });

  it("offers only items that can hold an installation", () => {
    const suggestions = suggestCatalogIds(installation(NMAP_INSTALL, "cyberchef"));
    for (const id of suggestions) expect(launcherItem(id)?.kind).toBe("external");
  });
});

describe("installationStatus", () => {
  it("reports a stored check as last verified, never as a live one", () => {
    expect(installationStatus(installation(NMAP_INSTALL, "nmap"))).toEqual({
      installationId: NMAP_INSTALL,
      enabled: true,
      verification: "last_verified",
      lastVerifiedAt: 1_790_800_000_000,
    });
  });

  it("reports a changed binary and an unknown check honestly", () => {
    expect(
      installationStatus(
        installation(NMAP_INSTALL, "nmap", { changedSinceVerify: true, enabled: false }),
      ),
    ).toMatchObject({ enabled: false, verification: "changed" });
    expect(
      installationStatus(installation(NMAP_INSTALL, "nmap", { lastVerifiedAt: 0 })),
    ).toEqual({
      installationId: NMAP_INSTALL,
      enabled: true,
      verification: "unknown",
      lastVerifiedAt: null,
    });
  });
});
