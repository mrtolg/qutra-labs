import { describe, expect, it } from "vitest";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import type { InstallationBinding } from "@/domain/lab";
import { LAUNCHER_ITEMS } from "./launcher";
import { LAUNCHER_CATEGORIES, launcherTiles, registerCategoryFor } from "./launcherGrid";

// Ids shaped like Rust's: `tool-<uuid4>`.
const NMAP_INSTALL = "tool-6c0d2f9a-1e7b-4c35-8a92-d4b1f03e7c58";
const GHIDRA_INSTALL = "tool-0b8e61d4-3a2f-4f7c-9e15-7d2ac4b09e36";
const ZAP_INSTALL = "tool-f47e2b90-58c1-4d6a-a3e7-1c9d05b8f2aa";

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
  return { id: installationId, catalogId, installationId, confirmedAt: 1_790_800_100_000 };
}

const tile = (tiles: ReturnType<typeof launcherTiles>, id: string) =>
  tiles.find((t) => t.catalogId === id)!;

describe("launcher grid tiles", () => {
  it("shows every external program the launcher can open, once, and nothing else", () => {
    const tiles = launcherTiles([], []);
    const openable = LAUNCHER_ITEMS.filter(
      (item) => item.kind === "external" && item.launchModes.length > 0,
    ).map((item) => item.catalogId);

    expect(tiles.map((t) => t.catalogId).sort()).toEqual([...openable].sort());
    expect(tiles).toHaveLength(35);
    // Lab services the launcher cannot open, built-ins, plans and guides stay out.
    for (const absent of ["juiceshop", "webgoat", "cyberchef", "metadata", "sigma-rules"]) {
      expect(tile(tiles, absent)).toBeUndefined();
    }
  });

  it("gives every tile a category chip and a page to get the program from", () => {
    for (const t of launcherTiles([], [])) {
      expect(LAUNCHER_CATEGORIES).toContain(t.category);
      expect(t.downloadUrl).toMatch(/^https:\/\//);
    }
  });

  it("names programs, not the registry's feature titles", () => {
    const tiles = launcherTiles([], []);
    expect(tile(tiles, "burp").name).toBe("Burp Suite");
    expect(tile(tiles, "tshark").name).toBe("TShark");
    expect(tile(tiles, "nmap").name).toBe("Nmap");
  });

  it("files a program under its guide's category when it has one", () => {
    const tiles = launcherTiles([], []);
    expect(tile(tiles, "ghidra").category).toBe("reverse");
    expect(tile(tiles, "zeek").category).toBe("detection");
    expect(tile(tiles, "burp").category).toBe("web");
  });

  it("says Not registered without a confirmed binding, whatever is installed", () => {
    // An installation named like the tool is still not that tool until the
    // user confirms it: nothing is matched by name.
    const tiles = launcherTiles([], [installation(NMAP_INSTALL, "nmap")]);
    expect(tile(tiles, "nmap").status).toEqual({ kind: "not_registered" });
  });

  it("offers a registered installation with no binding to the tile its name suggests", () => {
    // Registered in the Lab before bindings existed: Rust has it, no
    // tile claims it. The tile proposes it; only the user's click links it.
    const ghidra = installation(GHIDRA_INSTALL, "Ghidra 12.1.2");
    const tiles = launcherTiles([], [ghidra]);
    expect(tile(tiles, "ghidra").status).toEqual({ kind: "not_registered" });
    expect(tile(tiles, "ghidra").candidates).toEqual([ghidra]);
    expect(tile(tiles, "nmap").candidates).toEqual([]);
  });

  it("does not propose an installation already bound elsewhere", () => {
    const ghidra = installation(GHIDRA_INSTALL, "Ghidra 12.1.2");
    const tiles = launcherTiles([binding("imhex", GHIDRA_INSTALL)], [ghidra]);
    expect(tile(tiles, "ghidra").candidates).toEqual([]);
  });

  it("is ready to open with a bound, enabled, unchanged installation", () => {
    const nmap = installation(NMAP_INSTALL, "Nmap");
    const tiles = launcherTiles([binding("nmap", NMAP_INSTALL)], [nmap]);
    expect(tile(tiles, "nmap").status).toEqual({ kind: "ready", installation: nmap });
    expect(tile(tiles, "nmap").modes).toEqual(["terminal"]);
  });

  it("says when the registered file changed or was disabled", () => {
    const ghidra = installation(GHIDRA_INSTALL, "Ghidra", { changedSinceVerify: true });
    const zap = installation(ZAP_INSTALL, "ZAP", { enabled: false });
    const tiles = launcherTiles(
      [binding("ghidra", GHIDRA_INSTALL), binding("zap", ZAP_INSTALL)],
      [ghidra, zap],
    );
    expect(tile(tiles, "ghidra").status).toEqual({ kind: "changed", installation: ghidra });
    expect(tile(tiles, "zap").status).toEqual({ kind: "disabled", installation: zap });
  });

  it("drops a binding to an installation Rust no longer has", () => {
    const tiles = launcherTiles([binding("nmap", NMAP_INSTALL)], []);
    expect(tile(tiles, "nmap").status).toEqual({ kind: "not_registered" });
  });

  it("starts a located program's review in the registry's category, else the guide's", () => {
    const tiles = launcherTiles([], []);
    expect(registerCategoryFor(tile(tiles, "ghidra"))).toBe("dfir"); // registry, not "reverse"
    expect(registerCategoryFor(tile(tiles, "zeek"))).toBe("network"); // registry
    expect(registerCategoryFor(tile(tiles, "imhex"))).toBe("dfir"); // guide: reverse
    expect(registerCategoryFor(tile(tiles, "hashcat"))).toBe("local"); // guide: password
    expect(registerCategoryFor(tile(tiles, "sqlmap"))).toBe("web");
  });

  it("puts programs ready to open first", () => {
    const tiles = launcherTiles(
      [binding("zap", ZAP_INSTALL)],
      [installation(ZAP_INSTALL, "ZAP")],
    );
    expect(tiles[0]!.catalogId).toBe("zap");
    expect(tiles.slice(1).every((t) => t.status.kind === "not_registered")).toBe(true);
  });
});
