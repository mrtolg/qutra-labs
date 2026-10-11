import { afterEach, describe, expect, it, vi } from "vitest";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { grantPrivateLab } from "./enablePrivateLab";

function seedDb(
  overrides: {
    privateToolsEnabled?: boolean;
    localAssistantEnabled?: boolean;
    assistantAgentToolsEnabled?: boolean;
  } = {},
) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(overrides);
  setDbForTesting(db);
  return db;
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
});

describe("grantPrivateLab", () => {
  it("writes P only after native acknowledgement, and changes neither L nor G", async () => {
    seedDb();
    const requestGrant = vi.fn().mockResolvedValue(true);
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: { available: () => true, requestGrant },
    } as unknown as DesktopBridge);

    await expect(grantPrivateLab()).resolves.toBe("granted");

    expect(requestGrant).toHaveBeenCalledWith("en");
    const prefs = getDb().prefs.get();
    expect(prefs.privateToolsEnabled).toBe(true);
    expect(prefs.localAssistantEnabled).toBe(false);
    expect(prefs.assistantAgentToolsEnabled).toBe(false);
  });

  it("does not enable the agent for a user who already had Private Lab on", async () => {
    seedDb({
      privateToolsEnabled: true,
      localAssistantEnabled: false,
      assistantAgentToolsEnabled: false,
    });
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        requestGrant: vi.fn().mockResolvedValue(true),
      },
    } as unknown as DesktopBridge);

    await grantPrivateLab();

    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(false);
    expect(getDb().prefs.get().localAssistantEnabled).toBe(false);
  });

  it("does not write P when native acknowledgement is unavailable", async () => {
    seedDb();
    const requestGrant = vi.fn().mockResolvedValue(false);
    setBridgeForTesting({
      mode: "browser",
      toolSupervisor: { available: () => false, requestGrant },
    } as unknown as DesktopBridge);

    await expect(grantPrivateLab()).resolves.toBe("unavailable");
    expect(requestGrant).not.toHaveBeenCalled();
    expect(getDb().prefs.get().privateToolsEnabled).toBe(false);
  });

  it("does not write P when native consent returns false", async () => {
    seedDb();
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        requestGrant: vi.fn().mockResolvedValue(false),
      },
    } as unknown as DesktopBridge);

    await expect(grantPrivateLab()).resolves.toBe("declined");
    expect(getDb().prefs.get().privateToolsEnabled).toBe(false);
  });

  it("reports pending, never enabled, when native consent throws", async () => {
    seedDb();
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        requestGrant: vi.fn().mockRejectedValue(new Error("disk")),
      },
    } as unknown as DesktopBridge);

    await expect(grantPrivateLab()).resolves.toBe("pending");
    expect(getDb().prefs.get().privateToolsEnabled).toBe(false);
  });
});
