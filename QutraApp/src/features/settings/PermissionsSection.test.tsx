import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { useUi } from "@/state/ui";
import { EngagementSchema } from "@/domain/lab";
import { PermissionsSection } from "./PermissionsSection";

/* Settings › Permissions reads Private Lab's state from Rust (mocked at
   `invoke` and at the bridge's supervisor), saves the Jarvis switches as
   preferences, asks before the risky changes and confirms every change. */

const GRANTED_AT = Date.UTC(2026, 9, 9, 12, 30);

function nativeLab(initial: { granted: boolean; activeRuns?: number; grant?: boolean }) {
  const state = { granted: initial.granted };
  const supervisor = {
    available: () => true,
    consentGranted: vi.fn(async () => state.granted),
    requestGrant: vi.fn(async () => {
      if (initial.grant === false) return false;
      state.granted = true;
      return true;
    }),
    revoke: vi.fn(async () => {
      state.granted = false;
    }),
    listActiveRuns: vi.fn(async () =>
      Array.from({ length: initial.activeRuns ?? 0 }, (_, i) => ({ id: `run${i}` })),
    ),
  };
  invoke.mockImplementation(async (command: string) => {
    if (command === "private_tools_consent_status") {
      return { granted: state.granted, grantedAt: state.granted ? GRANTED_AT : null };
    }
    throw new Error(`unexpected ${command}`);
  });
  setBridgeForTesting({ mode: "tauri", toolSupervisor: supervisor } as unknown as DesktopBridge);
  return supervisor;
}

const row = (name: string) => {
  const title = screen.getByRole("heading", { name });
  return title.closest(".perm-row") as HTMLElement;
};
const lastToast = () => useUi.getState().toasts.at(-1);

beforeEach(() => {
  invoke.mockReset();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useUi.setState({ toasts: [], liveMessage: "", settingsSection: "permissions" });
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("Permissions › Private Lab", () => {
  it("shows the state Rust reports and since when, not the stored mirror", async () => {
    nativeLab({ granted: true });
    // The mirror says off; Rust says on. The page shows Rust.
    getDb().prefs.set({ privateToolsEnabled: false });
    render(<PermissionsSection />);

    const lab = row("Private Lab tools");
    expect(await within(lab).findByText("On")).toBeInTheDocument();
    expect(within(lab).getByText(/^On since /)).toBeInTheDocument();
    expect(within(lab).getByRole("checkbox", { name: "Private Lab tools" })).toBeChecked();
    expect(lab).toHaveTextContent("If you turn it off: running scans stop at once");
  });

  it("asks before turning it off, naming the scans that will stop", async () => {
    const supervisor = nativeLab({ granted: true, activeRuns: 2 });
    render(<PermissionsSection />);
    const lab = row("Private Lab tools");
    const toggle = within(lab).getByRole("checkbox", { name: "Private Lab tools" });
    await waitFor(() => expect(toggle).toBeChecked());

    await userEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "Turn off Private Lab?" });
    expect(dialog).toHaveTextContent("2 scans are running right now.");
    expect(supervisor.revoke).not.toHaveBeenCalled();
    expect(toggle).toBeChecked();

    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off Private Lab" }));

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(supervisor.revoke).toHaveBeenCalledTimes(1);
    const done = "Private Lab is off. Running scans were stopped and the terminal closed.";
    expect(within(lab).getByText(done)).toBeInTheDocument();
    expect(lastToast()?.message).toBe(done);
    expect(useUi.getState().liveMessage).toBe(done);
    expect(lab).toHaveAttribute("data-flash", "true");
    expect(getDb().prefs.get().permissionChangedAt.privateLab).toBeGreaterThan(0);
  });

  it("keeps it on when the question is cancelled", async () => {
    const supervisor = nativeLab({ granted: true });
    render(<PermissionsSection />);
    const toggle = within(row("Private Lab tools")).getByRole("checkbox", {
      name: "Private Lab tools",
    });
    await waitFor(() => expect(toggle).toBeChecked());

    await userEvent.click(toggle);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(supervisor.revoke).not.toHaveBeenCalled();
    expect(toggle).toBeChecked();
  });

  it("turns on through the Windows confirmation and says so", async () => {
    const supervisor = nativeLab({ granted: false });
    render(<PermissionsSection />);
    const lab = row("Private Lab tools");
    const toggle = within(lab).getByRole("checkbox", { name: "Private Lab tools" });
    await within(lab).findByText("Off");

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(supervisor.requestGrant).toHaveBeenCalledTimes(1);
    expect(
      within(lab).getByText("Private Lab is on. Tools and the terminal can run."),
    ).toBeInTheDocument();
  });

  it("stays off and says why when the Windows confirmation is cancelled", async () => {
    nativeLab({ granted: false, grant: false });
    render(<PermissionsSection />);
    const lab = row("Private Lab tools");
    await within(lab).findByText("Off");

    await userEvent.click(within(lab).getByRole("checkbox", { name: "Private Lab tools" }));

    await waitFor(() => expect(lastToast()?.messageKey).toBe("perm2.privateLab.declined"));
    expect(within(lab).getByRole("checkbox", { name: "Private Lab tools" })).not.toBeChecked();
  });

  it("is not available in the browser build", async () => {
    setBridgeForTesting({
      mode: "browser",
      toolSupervisor: { available: () => false },
    } as unknown as DesktopBridge);
    render(<PermissionsSection />);
    const lab = row("Private Lab tools");

    expect(await within(lab).findByText("Not available")).toBeInTheDocument();
    expect(within(lab).getByRole("checkbox", { name: "Private Lab tools" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("Permissions › Jarvis", () => {
  beforeEach(() => {
    nativeLab({ granted: true });
  });

  it("turns the local model on at once and records when", async () => {
    render(<PermissionsSection />);
    const local = row("Jarvis on the local model");
    const toggle = within(local).getByRole("checkbox", { name: "Jarvis on the local model" });
    expect(within(local).getByText("No date recorded for the last change")).toBeInTheDocument();

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(getDb().prefs.get().localAssistantEnabled).toBe(true);
    expect(within(local).getByText(/^On since /)).toBeInTheDocument();
    expect(
      within(local).getByText("Jarvis can now answer with the local model."),
    ).toBeInTheDocument();
  });

  it("asks before letting Jarvis propose actions, and turns it off plainly", async () => {
    getDb().prefs.set({ localAssistantEnabled: true });
    render(<PermissionsSection />);
    const proposals = row("Jarvis may propose actions");
    const toggle = within(proposals).getByRole("checkbox", { name: "Jarvis may propose actions" });

    await userEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "Let Jarvis propose actions?" });
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Allow proposals" }));
    await waitFor(() => expect(toggle).toBeChecked());
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(true);

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getDb().prefs.get().assistantAgentToolsEnabled).toBe(false);
  });

  it("says when saved proposals are not active", async () => {
    getDb().prefs.set({ localAssistantEnabled: false, assistantAgentToolsEnabled: true });
    render(<PermissionsSection />);
    const proposals = row("Jarvis may propose actions");

    expect(
      within(proposals).getByText(
        "Tool proposals are saved but inactive because the local assistant is off.",
      ),
    ).toBeInTheDocument();
    expect(within(proposals).getByText("On, not active")).toBeInTheDocument();
  });

  it("keeps reading without asking off until proposals are on, then asks first", async () => {
    render(<PermissionsSection />);
    const reads = row("Read context without asking");
    const toggle = within(reads).getByRole("checkbox", { name: "Read context without asking" });
    expect(toggle).toBeDisabled();
    expect(
      within(reads).getByText("Turn on “Jarvis may propose actions” first."),
    ).toBeInTheDocument();

    getDb().prefs.set({ localAssistantEnabled: true, assistantAgentToolsEnabled: true });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "Read context without asking?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Read without asking" }));

    await waitFor(() => expect(toggle).toBeChecked());
    expect(getDb().prefs.get().assistantAutoApproveReads).toBe(true);
  });
});

describe("Permissions › Cloud", () => {
  it("counts the investigations allowed to go to the cloud and links to manage them", async () => {
    nativeLab({ granted: false });
    getDb()
      .collection("engagements")
      .put(
        EngagementSchema.parse({
          id: "e1",
          title: "Home Lab",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          cloudConsent: { provider: "anthropic", host: "api.anthropic.com", grantedAt: GRANTED_AT },
        }),
      );
    render(<PermissionsSection />);
    const cloud = row("Investigation summaries to the cloud");

    expect(within(cloud).getByText("Allowed for 1")).toBeInTheDocument();
    await userEvent.click(within(cloud).getByRole("button", { name: "Manage in AI providers" }));
    expect(useUi.getState().settingsSection).toBe("ai");
  });
});
