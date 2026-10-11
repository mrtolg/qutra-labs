import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { LocalAssistantChat } from "./LocalAssistantChat";
import { AGENT_CONSENT_EPOCH } from "@/domain/assistantConsent";

Element.prototype.scrollTo = vi.fn();

function seedDb(overrides: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(overrides);
  setDbForTesting(db);
  return db;
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
});

describe("Assistant Q1 / Q2 setup", () => {
  it("states the endpoint first and leaves prefs unchanged on Not now", async () => {
    seedDb();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    expect(screen.getByTestId("local-assistant-off")).toHaveTextContent(
      "127.0.0.1:11435",
    );
    await user.click(screen.getByTestId("assistant-setup-not-now"));
    expect(getDb().prefs.get().localAssistantEnabled).toBe(false);
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(false);
    expect(getDb().prefs.get().privateToolsEnabled).toBe(false);
  });

  it("shows the engine-identity paragraph once", () => {
    seedDb();
    render(<LocalAssistantChat />);

    expect(screen.getAllByText(/secret key made for each start/i)).toHaveLength(1);
  });

  it("explains tool proposals once even while a restore is waiting", () => {
    seedDb({ assistantAgentAwaitingConfirmation: true });
    render(<LocalAssistantChat />);

    expect(screen.getByTestId("assistant-restore-proposals")).toBeInTheDocument();
    expect(screen.getAllByText(/does not enable auto-approval of reads/i)).toHaveLength(1);
  });

  it("answer-only sets L and leaves G and P unchanged", async () => {
    seedDb();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await user.click(screen.getByTestId("assistant-enable-answer-only"));
    const prefs = getDb().prefs.get();
    expect(prefs.localAssistantEnabled).toBe(true);
    expect(prefs.assistantAgentToolsEnabled).toBe(false);
    expect(prefs.privateToolsEnabled).toBe(false);
    expect(screen.getByTestId("local-assistant-chat")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-permission-status")).toHaveTextContent(
      /fully supported/i,
    );
  });

  it("tool proposals set L and G, leave P, and then ask Private Lab", async () => {
    seedDb();
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: {
        available: () => true,
        requestGrant: vi.fn().mockResolvedValue(true),
      },
    } as unknown as DesktopBridge);
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    expect(
      screen.getByText(/does not enable auto-approval of reads/i),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("assistant-enable-tool-proposals"));

    const prefs = getDb().prefs.get();
    expect(prefs.localAssistantEnabled).toBe(true);
    expect(prefs.assistantAgentToolsEnabled).toBe(true);
    expect(prefs.privateToolsEnabled).toBe(false);
    expect(screen.getByTestId("assistant-setup-q2")).toBeInTheDocument();
  });

  it("declining Q2 keeps L and G and does not re-ask as a blocking prompt", async () => {
    seedDb();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await user.click(screen.getByTestId("assistant-enable-tool-proposals"));
    await user.click(screen.getByTestId("assistant-q2-decline"));

    const prefs = getDb().prefs.get();
    expect(prefs.localAssistantEnabled).toBe(true);
    expect(prefs.assistantAgentToolsEnabled).toBe(true);
    expect(prefs.privateToolsEnabled).toBe(false);
    expect(prefs.assistantPrivateLabPromptDismissed).toBe(true);
    expect(screen.queryByTestId("assistant-setup-q2")).toBeNull();
    expect(screen.getByTestId("assistant-permission-status")).toHaveTextContent(
      /Permission saved, Private Lab off/i,
    );
  });

  it("Q2 success writes P only after native acknowledgement", async () => {
    seedDb();
    const requestGrant = vi.fn().mockResolvedValue(true);
    setBridgeForTesting({
      mode: "tauri",
      toolSupervisor: { available: () => true, requestGrant },
    } as unknown as DesktopBridge);
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await user.click(screen.getByTestId("assistant-enable-tool-proposals"));
    await user.click(screen.getByTestId("assistant-enable-private-lab"));

    await waitFor(() => expect(requestGrant).toHaveBeenCalledWith("en"));
    await waitFor(() =>
      expect(getDb().prefs.get().privateToolsEnabled).toBe(true),
    );
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(true);
  });

  it("restore sets only G and discloses auto-approve when it was already on", async () => {
    seedDb({
      localAssistantEnabled: true,
      assistantAgentAwaitingConfirmation: true,
      assistantAutoApproveReads: true,
    });
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    expect(screen.getByTestId("assistant-restore-proposals")).toHaveTextContent(
      /auto-approve/i,
    );
    await user.click(screen.getByTestId("assistant-restore-tool-proposals"));
    const prefs = getDb().prefs.get();
    expect(prefs.assistantAgentToolsEnabled).toBe(true);
    expect(prefs.assistantAgentAwaitingConfirmation).toBe(false);
    expect(prefs.assistantAgentConsentEpoch).toBe(AGENT_CONSENT_EPOCH);
    expect(prefs.privateToolsEnabled).toBe(false);
  });

  it("switch to answer-only performs a real G=false transition", async () => {
    seedDb({
      localAssistantEnabled: true,
      assistantAgentToolsEnabled: true,
      assistantAgentConsentEpoch: AGENT_CONSENT_EPOCH,
    });
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await user.click(screen.getByTestId("assistant-switch-answer-only"));
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(false);
  });
});
