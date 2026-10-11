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
import { PrivacySection } from "./PrivacySection";

const exclusions = () => getDb().collection("exclusions").getAll();
const lastToast = () => useUi.getState().toasts.at(-1);

function event(id: string) {
  return { id, type: "app_activity", at: 1, label: id, detail: "", minutes: 0, demo: false } as const;
}

beforeEach(() => {
  invoke.mockReset();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useUi.setState({ toasts: [], liveMessage: "", settingsSection: "privacy" });
  setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("Privacy › the data map", () => {
  it("says what is recorded, where, what never leaves and what goes to the cloud", () => {
    getDb().prefs.set({ activityTrackingEnabled: true, aiProvider: "anthropic" });
    render(<PrivacySection />);
    const map = screen.getByRole("group", { name: "Where your data is and where it goes" });

    expect(within(map).getByRole("heading", { name: "What is recorded" })).toBeInTheDocument();
    expect(within(map).getByText("%APPDATA%\\app.contextos.desktop\\contextos.db")).toBeInTheDocument();
    expect(within(map).getByRole("heading", { name: "Never leaves this computer" })).toBeInTheDocument();
    expect(within(map).getByText("Qutra right now: Claude (Anthropic)")).toBeInTheDocument();
    expect(within(map).getByText("On")).toBeInTheDocument();
  });
});

describe("Privacy › exclusions", () => {
  it("adds a valid exclusion, lists it and confirms it", async () => {
    render(<PrivacySection />);
    expect(screen.getByText(/No exclusions yet/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Value"), "Acme Holding");
    await userEvent.click(screen.getByRole("button", { name: "Add exclusion" }));

    expect(exclusions()).toMatchObject([{ kind: "pattern", value: "Acme Holding" }]);
    const list = screen.getByRole("list", { name: "Your exclusions" });
    expect(within(list).getByText("Acme Holding")).toBeInTheDocument();
    expect(lastToast()?.message).toBe("Excluded: Acme Holding");
    expect(screen.getByLabelText("Value")).toHaveValue("");
  });

  it("explains a value it refuses and saves nothing", async () => {
    render(<PrivacySection />);
    await userEvent.click(screen.getByRole("radio", { name: "Domain" }));
    await userEvent.type(screen.getByLabelText("Value"), "https://corp.acme.local");
    await userEvent.click(screen.getByRole("button", { name: "Add exclusion" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Type only the domain, such as corp.acme.local, without https:// or /.",
    );
    expect(screen.getByLabelText("Value")).toHaveAttribute("aria-invalid", "true");
    expect(exclusions()).toEqual([]);
  });

  it("refuses a duplicate whatever its case", async () => {
    render(<PrivacySection />);
    await userEvent.type(screen.getByLabelText("Value"), "Acme Holding{Enter}");
    await userEvent.type(screen.getByLabelText("Value"), "ACME holding{Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent("This value is already excluded.");
    expect(exclusions()).toHaveLength(1);
  });

  it("fills the form from an example", async () => {
    render(<PrivacySection />);
    await userEvent.click(screen.getByRole("button", { name: /C:\\Clients\\Acme/ }));

    expect(screen.getByRole("radio", { name: "Folder path" })).toBeChecked();
    expect(screen.getByLabelText("Value")).toHaveValue("C:\\Clients\\Acme");
  });

  it("removes an exclusion with a way to undo it", async () => {
    getDb().collection("exclusions").put({
      id: "exc1",
      kind: "domain",
      value: "corp.acme.local",
      note: "",
      demo: false,
      createdAt: 5,
    });
    render(<PrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: "Remove: corp.acme.local" }));
    expect(exclusions()).toEqual([]);
    expect(lastToast()?.message).toBe("Exclusion removed: corp.acme.local");

    lastToast()?.onAction?.();
    await waitFor(() => expect(exclusions()).toHaveLength(1));
    const list = screen.getByRole("list", { name: "Your exclusions" });
    expect(within(list).getByText("corp.acme.local")).toBeInTheDocument();
  });

  it("shows how a text would leave, masked by Rust", async () => {
    setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
    invoke.mockResolvedValue({ text: "[masked exclusion] server", masked: 1 });
    render(<PrivacySection />);

    await userEvent.type(screen.getByLabelText("Try it"), "Acme Holding server");
    await userEvent.click(screen.getByRole("button", { name: "Mask it" }));

    expect(invoke).toHaveBeenCalledWith("ai_mask_preview", { text: "Acme Holding server" });
    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("This is how it would go · 1 values masked");
    expect(result).toHaveTextContent("[masked exclusion] server");
  });
});

describe("Privacy › stored data", () => {
  it("counts the records of each kind", () => {
    getDb().collection("events").bulkPut([event("e1"), event("e2"), event("e3")] as never);
    render(<PrivacySection />);

    const row = screen.getByRole("row", { name: /Activity log/ });
    expect(within(row).getByText("3")).toBeInTheDocument();
    const findings = screen.getByRole("row", { name: /Findings/ });
    expect(within(findings).getByText("0")).toBeInTheDocument();
    expect(within(findings).getByRole("button", { name: "Export: Findings" })).toBeDisabled();
    expect(within(findings).queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
  });

  it("asks before clearing, and clears only on yes", async () => {
    getDb().collection("events").bulkPut([event("e1"), event("e2")] as never);
    render(<PrivacySection />);
    const row = screen.getByRole("row", { name: /Activity log/ });

    await userEvent.click(within(row).getByRole("button", { name: "Clear: Activity log" }));
    let dialog = await screen.findByRole("dialog", { name: "Clear Activity log?" });
    expect(dialog).toHaveTextContent("2 records are permanently deleted from this computer.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(getDb().collection("events").getAll()).toHaveLength(2);

    await userEvent.click(within(row).getByRole("button", { name: "Clear: Activity log" }));
    dialog = await screen.findByRole("dialog", { name: "Clear Activity log?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(getDb().collection("events").getAll()).toHaveLength(0));
    expect(lastToast()?.message).toBe("Activity log cleared");
  });

  it("exports one kind as a file", async () => {
    getDb().collection("events").bulkPut([event("e1")] as never);
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<PrivacySection />);

    await userEvent.click(screen.getByRole("button", { name: "Export: Activity log" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(lastToast()?.message).toBe("Activity log exported");
    click.mockRestore();
  });
});
