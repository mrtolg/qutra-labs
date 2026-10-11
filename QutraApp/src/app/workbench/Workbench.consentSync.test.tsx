import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, setDbForTesting, getDb } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { revokeNativeConsent, useConsentSync } from "./consentSync";
import { Workbench } from "./Workbench";

function seedDb(privateToolsEnabled: boolean) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled });
  setDbForTesting(db);
  return db;
}

function bridgeWith(
  supervisor: Partial<DesktopBridge["toolSupervisor"]>,
  available = true,
): DesktopBridge {
  return {
    mode: available ? "tauri" : "browser",
    terminal: {
      available: () => available,
      closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
      onData: vi.fn().mockResolvedValue(() => {}),
      listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
      onSession: vi.fn().mockResolvedValue(() => {}),
    },
    toolSupervisor: {
      available: () => available,
      consentGranted: vi.fn().mockResolvedValue(false),
      requestGrant: vi.fn().mockResolvedValue(false),
      revoke: vi.fn().mockResolvedValue(undefined),
      listInstallations: vi.fn().mockResolvedValue([]),
      listRuns: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn().mockResolvedValue(() => {}),
      ...supervisor,
    },
  } as unknown as DesktopBridge;
}

function renderWorkbench() {
  render(
    <MemoryRouter initialEntries={["/overview"]}>
      <Routes>
        <Route path="*" element={<Workbench />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  useConsentSync.getState().clear();
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
});

describe("Private Lab consent sync failures", () => {
  it("shows a failed native read with Retry, and Retry reads again", async () => {
    seedDb(true);
    const consentGranted = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc"))
      .mockResolvedValue(true);
    setBridgeForTesting(bridgeWith({ consentGranted }));

    renderWorkbench();

    const alert = await screen.findByTestId("consent-sync-error");
    expect(alert.getAttribute("role")).toBe("alert");
    fireEvent.click(screen.getByTestId("consent-sync-retry"));

    await waitFor(() => expect(screen.queryByTestId("consent-sync-error")).toBeNull());
    expect(consentGranted).toHaveBeenCalledTimes(2);
    expect(getDb().prefs.get().privateToolsEnabled).toBe(true);
  });

  it("shows a failed revoke, mirrors what native reports, and Retry revokes again", async () => {
    seedDb(false);
    const revoke = vi
      .fn()
      .mockRejectedValueOnce("consent_persist_failed")
      .mockResolvedValue(undefined);
    const consentGranted = vi
      .fn()
      // Workbench mount: native still granted while the preference is off.
      .mockResolvedValueOnce(true)
      // After the failed revoke: Rust denied in memory before it failed.
      .mockResolvedValue(false);
    setBridgeForTesting(bridgeWith({ consentGranted, revoke }));

    renderWorkbench();

    await screen.findByTestId("consent-sync-error");
    expect(getDb().prefs.get().privateToolsEnabled).toBe(false);

    fireEvent.click(screen.getByTestId("consent-sync-retry"));
    await waitFor(() => expect(screen.queryByTestId("consent-sync-error")).toBeNull());
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("turns the preference back on when native still reports granted after a failed revoke", async () => {
    seedDb(true);
    setBridgeForTesting(
      bridgeWith({
        consentGranted: vi.fn().mockResolvedValue(true),
        revoke: vi.fn().mockRejectedValue("ipc"),
      }),
    );

    await act(() => revokeNativeConsent());

    expect(getDb().prefs.get().privateToolsEnabled).toBe(true);
    expect(useConsentSync.getState().failure).toBe("revoke");
  });

  it("stays quiet in browser mode, where there is no native consent", async () => {
    seedDb(true);
    const revoke = vi.fn().mockRejectedValue(new Error("no native"));
    setBridgeForTesting(bridgeWith({ revoke }, false));

    renderWorkbench();
    await act(() => revokeNativeConsent());

    expect(revoke).not.toHaveBeenCalled();
    expect(getDb().prefs.get().privateToolsEnabled).toBe(false);
    expect(screen.queryByTestId("consent-sync-error")).toBeNull();
  });
});
