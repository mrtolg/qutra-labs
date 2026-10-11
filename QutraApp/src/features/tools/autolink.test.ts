import { describe, expect, it, vi } from "vitest";
import { Database } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import type { NativeDetectedTool, NativeToolInstallation } from "@/lib/bridge/types";
import { autolinkDetected } from "./autolink";

const NMAP = "tool-6c0d2f9a-1e7b-4c35-8a92-d4b1f03e7c58";
const ZAP = "tool-f47e2b90-58c1-4d6a-a3e7-1c9d05b8f2aa";
const GHIDRA = "tool-0b8e61d4-3a2f-4f7c-9e15-7d2ac4b09e36";
const OLD = "tool-5a1c7e20-9b3d-4e8f-a6c2-0d4f81b7e953";
const HASH = "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471";

function installation(
  id: string,
  displayName: string,
  extra: Partial<NativeToolInstallation> = {},
): NativeToolInstallation {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `C:\\Tools\\${displayName}.exe`,
    sha256: HASH,
    sizeBytes: 10,
    version: "",
    publisher: "",
    signatureState: "valid",
    category: "network",
    riskTier: "low",
    docUrl: "",
    tags: [],
    workingDir: "C:\\Tools",
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
    ...extra,
  };
}

function found(catalogId: string, extra: Partial<NativeDetectedTool> = {}): NativeDetectedTool {
  const path = `C:\\Program Files\\${catalogId}\\${catalogId}.exe`;
  return {
    catalogId,
    source: "program_files",
    fileName: `${catalogId}.exe`,
    canonicalPath: path,
    registeredId: null,
    located: {
      token: `cand-${catalogId}`,
      workingDir: "C:\\Program Files",
      candidate: {
        canonicalPath: path,
        fileName: `${catalogId}.exe`,
        sha256: HASH,
        sizeBytes: 10,
        version: "",
        publisher: "",
        signatureState: "valid",
      },
    },
    ...extra,
  };
}

const labels = { profileName: (name: string) => `${name} default`, targetArgName: "Target" };

function setup(
  detected: NativeDetectedTool[],
  installations: NativeToolInstallation[] = [],
  bound: Array<[string, string]> = [],
) {
  const db = new Database(new MemoryStorageAdapter());
  for (const [catalogId, installationId] of bound) {
    db.collection("installationBindings").put({
      id: installationId,
      catalogId,
      installationId,
      confirmedAt: 5,
    });
  }
  const supervisor = {
    detectInstallations: vi.fn().mockResolvedValue(detected),
    register: vi.fn(async (request: { displayName: string }) =>
      installation(ZAP, request.displayName),
    ),
  };
  const run = () => autolinkDetected({ supervisor, db, installations, labels });
  return { db, supervisor, run };
}

const bindings = (db: Database) => db.collection("installationBindings").getAll();

describe("linking the programs found on this computer", () => {
  it("registers an unregistered find by its token, links it and makes its setting", async () => {
    const { db, supervisor, run } = setup([found("zap")]);

    const summary = await run();

    expect(supervisor.register).toHaveBeenCalledWith({
      candidateToken: "cand-zap",
      displayName: "OWASP ZAP",
      category: "web",
      riskTier: "low",
      docUrl: "https://www.zaproxy.org/download/",
      tags: [],
      confirmed: true,
    });
    expect(summary).toEqual({ registered: ["OWASP ZAP"], linked: [], failed: 0 });
    expect(bindings(db)).toEqual([
      expect.objectContaining({ catalogId: "zap", installationId: ZAP, source: "detected" }),
    ]);
    expect(db.collection("toolProfiles").getAll()).toEqual([
      expect.objectContaining({ installationId: ZAP, name: "OWASP ZAP default" }),
    ]);
  });

  it("links a registration that was never linked, without registering again", async () => {
    const { db, supervisor, run } = setup(
      [found("ghidra", { registeredId: GHIDRA, located: null })],
      [installation(GHIDRA, "Ghidra 12.1.2")],
    );

    const summary = await run();

    expect(supervisor.register).not.toHaveBeenCalled();
    expect(summary.linked).toEqual(["Ghidra"]);
    expect(bindings(db)).toEqual([
      expect.objectContaining({ catalogId: "ghidra", installationId: GHIDRA, source: "detected" }),
    ]);
  });

  it("does not look for a program already linked, and never replaces that link", async () => {
    const { db, supervisor, run } = setup(
      // Even if the scan returned it anyway.
      [found("nmap")],
      [installation(NMAP, "Nmap")],
      [["nmap", NMAP]],
    );

    const summary = await run();

    expect(supervisor.detectInstallations).toHaveBeenCalledWith(["nmap"]);
    expect(supervisor.register).not.toHaveBeenCalled();
    expect(summary).toEqual({ registered: [], linked: [], failed: 0 });
    expect(bindings(db)).toEqual([
      { id: NMAP, catalogId: "nmap", installationId: NMAP, confirmedAt: 5 },
    ]);
  });

  it("leaves a registration linked to a different program alone", async () => {
    const { db, run } = setup(
      [found("ghidra", { registeredId: GHIDRA, located: null })],
      [installation(GHIDRA, "Custom build")],
      [["imhex", GHIDRA]],
    );

    await run();

    expect(bindings(db)).toEqual([expect.objectContaining({ catalogId: "imhex" })]);
  });

  it("still looks for a program whose only link points at a file that is gone", async () => {
    const { db, supervisor, run } = setup(
      [found("burp")],
      [installation(OLD, "Burp fixture", { fileMissing: true })],
      [["burp", OLD]],
    );

    const summary = await run();

    expect(supervisor.detectInstallations).toHaveBeenCalledWith([]);
    expect(summary.registered).toEqual(["Burp Suite"]);
    // The old link stays as it was left; the new one makes the tile work.
    expect(bindings(db).map((b) => b.installationId).sort()).toEqual([OLD, ZAP].sort());
  });

  it("counts a find that cannot be registered and goes on with the rest", async () => {
    const { db, supervisor, run } = setup([found("zap"), found("jq")]);
    supervisor.register
      .mockRejectedValueOnce(new Error("candidate_changed"))
      .mockResolvedValueOnce(installation(ZAP, "jq"));

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(summary.registered).toEqual(["jq"]);
    expect(bindings(db)).toHaveLength(1);
  });

  it("ignores a find that is not a toolbox program", async () => {
    const { db, supervisor, run } = setup([found("cyberchef")]);

    await run();

    expect(supervisor.register).not.toHaveBeenCalled();
    expect(bindings(db)).toEqual([]);
  });

  it("does not link over a link made while the scan was running", async () => {
    const { db, supervisor, run } = setup([found("zap")], [installation(OLD, "ZAP mine")]);
    supervisor.detectInstallations.mockImplementation(async () => {
      db.collection("installationBindings").put({
        id: OLD,
        catalogId: "zap",
        installationId: OLD,
        confirmedAt: 9,
      });
      return [found("zap")];
    });

    await run();

    expect(supervisor.register).not.toHaveBeenCalled();
    expect(bindings(db)).toEqual([expect.objectContaining({ installationId: OLD })]);
  });
});
