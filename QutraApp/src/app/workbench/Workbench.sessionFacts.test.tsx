import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type { TerminalSessionEvent } from "@/lib/bridge/terminal";
import {
  emptyFacts,
  useTerminalSessionFacts,
} from "@/features/terminal/terminalSessionFacts";
import { Workbench } from "./Workbench";

const RUNTIME = "3d9a7e21-5b0c-4f68-a2e4-8c1f6b0d9e37";
const SESSION = "c6e0b4f2-1a9d-4e37-8b52-0d7f3a6c9e14";

function nativeBridge() {
  let listener: ((e: TerminalSessionEvent) => void) | null = null;
  const off = vi.fn();
  const bridge = {
    mode: "tauri",
    terminal: {
      available: () => true,
      closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
      listSessions: vi.fn().mockResolvedValue({ runtimeId: RUNTIME, revision: 1, sessions: [] }),
      onSession: vi.fn(async (l: (e: TerminalSessionEvent) => void) => {
        listener = l;
        return off;
      }),
    },
    toolSupervisor: {
      available: () => true,
      consentGranted: vi.fn().mockResolvedValue(false),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as DesktopBridge;
  return { bridge, off, emit: (e: TerminalSessionEvent) => listener?.(e) };
}

function renderWorkbench() {
  return render(
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
  useTerminalSessionFacts.setState(emptyFacts, true);
});

describe("Workbench terminal session facts", () => {
  it("mirrors Rust's session facts while mounted and lets go on unmount", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const native = nativeBridge();
    setBridgeForTesting(native.bridge);

    const view = renderWorkbench();
    await waitFor(() => expect(useTerminalSessionFacts.getState().runtimeId).toBe(RUNTIME));

    native.emit({
      runtimeId: RUNTIME,
      revision: 2,
      session: {
        runtimeId: RUNTIME,
        sessionId: SESSION,
        revision: 2,
        origin: "assistant",
        installationId: null,
        state: "exited",
        ioState: "closed",
        pid: 30_116,
        programName: "pwsh.exe",
        startedAt: 1_727_800_000_000,
        elapsedMs: 4_210,
        initialCwd: "C:\\Users\\Analyst",
        cwdSource: "spawn",
        exit: { code: 0, reason: "natural", endedAt: 1_727_800_004_210 },
      },
    });
    expect(useTerminalSessionFacts.getState().byId[SESSION]?.exit?.code).toBe(0);

    view.unmount();
    expect(native.off).toHaveBeenCalledTimes(1);
  });
});
