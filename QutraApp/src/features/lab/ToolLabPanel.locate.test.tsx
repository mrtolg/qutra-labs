import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type {
  NativeLocatedCandidate,
  NativeToolInstallation,
} from "@/lib/bridge/types";
import { useLabRuntime } from "@/state/labRuntime";
import { en } from "@/lib/i18n/en";
import { ToolLabPanel } from "./ToolLabPanel";

/**
 * Locate: the executable is picked in a native dialog, and the
 * renderer registers it by the opaque token Rust returned. It never sends a
 * path or a working directory, so it cannot swap the file the user reviewed.
 */

// Shaped like production: Rust's `cand-<uuid4>` token and a real install path.
const LOCATED: NativeLocatedCandidate = {
  token: "cand-3b1f07c2-9d4e-4a8b-b6f1-52e0c9a7d813",
  candidate: {
    canonicalPath: "\\\\?\\C:\\Program Files (x86)\\Nmap\\nmap.exe",
    fileName: "nmap.exe",
    sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
    sizeBytes: 2_977_792,
    version: "7.95.0.0",
    publisher: "Insecure.Com LLC",
    signatureState: "valid",
  },
  workingDir: "\\\\?\\C:\\Program Files (x86)\\Nmap",
};

function registered(): NativeToolInstallation {
  return {
    id: "tool-6c0d2f9a-1e7b-4c35-8a92-d4b1f03e7c58",
    displayName: "nmap",
    runner: "executable",
    canonicalPath: LOCATED.candidate.canonicalPath,
    sha256: LOCATED.candidate.sha256,
    sizeBytes: LOCATED.candidate.sizeBytes,
    version: LOCATED.candidate.version,
    publisher: LOCATED.candidate.publisher,
    signatureState: "valid",
    category: "local",
    riskTier: "low",
    docUrl: "",
    tags: [],
    workingDir: LOCATED.workingDir,
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1_790_800_000_000,
    updatedAt: 1_790_800_000_000,
    lastVerifiedAt: 1_790_800_000_000,
  };
}

let db: Database;

function mount(
  overrides: Partial<DesktopBridge["toolSupervisor"]>,
  installations: NativeToolInstallation[] = [],
) {
  db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true });
  setDbForTesting(db);
  const supervisor = {
    available: vi.fn().mockReturnValue(true),
    consentGranted: vi.fn().mockResolvedValue(true),
    requestGrant: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(undefined),
    locateCandidate: vi.fn().mockResolvedValue(LOCATED),
    register: vi.fn().mockResolvedValue(registered()),
    listInstallations: vi.fn().mockResolvedValue([]),
    reverify: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    emergencyStop: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
    listActiveRuns: vi.fn().mockResolvedValue([]),
    deleteArtifacts: vi.fn(),
    onEvent: vi.fn().mockResolvedValue(() => {}),
    launchDetached: vi.fn(),
    ...overrides,
  } as unknown as DesktopBridge["toolSupervisor"];
  setBridgeForTesting({
    mode: "tauri",
    toolSupervisor: supervisor,
    terminal: { available: () => true },
    openPath: vi.fn(),
  } as unknown as DesktopBridge);
  useLabRuntime.setState({
    available: true,
    ready: true,
    subscribed: true,
    installations,
    runs: [],
    logs: {},
    clearedLogs: {},
    selectedRunId: null,
    error: "",
  });
  render(
    <MemoryRouter initialEntries={["/lab"]}>
      <main>
        <ToolLabPanel targets={[]} />
      </main>
    </MemoryRouter>,
  );
  return supervisor;
}

/** The header button; the empty library repeats it. */
function addToolButton() {
  return screen.getAllByRole("button", { name: en["lab.tools.addTool"] })[0];
}

afterEach(() => {
  resetBridgeForTesting();
  vi.restoreAllMocks();
});

describe("ToolLabPanel Locate", () => {
  it("keeps the workbench inside the page's single main landmark", async () => {
    mount({}, [registered()]);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const workbench = await screen.findByRole("region", { name: "nmap 7.95.0.0" });
    expect(screen.getByRole("main")).toContainElement(workbench);
  });

  it("picks natively and registers by token, never by path or folder", async () => {
    const supervisor = mount({});
    const user = userEvent.setup();

    await user.click(addToolButton());
    expect(supervisor.locateCandidate).toHaveBeenCalledWith(
      en["lab.tools.locateTitle"],
      en["lab.tools.locateFilter"],
    );

    const dialog = await screen.findByRole("dialog");
    // The folder is decided natively and shown, not typed.
    expect(within(dialog).getByText(LOCATED.workingDir)).toBeInTheDocument();
    expect(
      within(dialog).queryByDisplayValue(LOCATED.workingDir),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: en["lab.tools.confirmRegister"] }),
    );
    await waitFor(() => expect(supervisor.register).toHaveBeenCalledTimes(1));
    expect(supervisor.register).toHaveBeenCalledWith({
      candidateToken: LOCATED.token,
      displayName: "nmap",
      category: "local",
      riskTier: "low",
      docUrl: "",
      tags: [],
      confirmed: true,
    });
  });

  it("asks for a fresh Locate when the reviewed file changed", async () => {
    mount({ register: vi.fn().mockRejectedValue("candidate_changed") });
    const user = userEvent.setup();

    await user.click(addToolButton());
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: en["lab.tools.confirmRegister"] }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      en["lab.tools.locateAgain"],
    );
  });

  it("does nothing when the native picker is cancelled", async () => {
    const supervisor = mount({ locateCandidate: vi.fn().mockResolvedValue(null) });
    const user = userEvent.setup();

    await user.click(addToolButton());
    await waitFor(() => expect(supervisor.locateCandidate).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(supervisor.register).not.toHaveBeenCalled();
  });
});

describe("ToolLabPanel catalog binding", () => {
  const catalogSelect = (scope: HTMLElement) =>
    within(scope).getByRole("combobox", { name: en["lab.tools.catalogEntry"] });

  it("binds the new installation to the catalog item the user kept", async () => {
    mount({});
    const user = userEvent.setup();

    await user.click(addToolButton());
    const dialog = await screen.findByRole("dialog");
    // Suggested from the file name, shown for the user to keep or change.
    expect(catalogSelect(dialog)).toHaveValue("nmap");
    await user.click(
      within(dialog).getByRole("button", { name: en["lab.tools.confirmRegister"] }),
    );

    await waitFor(() =>
      expect(db.collection("installationBindings").getAll()).toEqual([
        {
          id: registered().id,
          catalogId: "nmap",
          installationId: registered().id,
          confirmedAt: expect.any(Number),
        },
      ]),
    );
  });

  it("registers without a binding when the user says it is not in the catalog", async () => {
    const supervisor = mount({});
    const user = userEvent.setup();

    await user.click(addToolButton());
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(catalogSelect(dialog), "");
    await user.click(
      within(dialog).getByRole("button", { name: en["lab.tools.confirmRegister"] }),
    );

    await waitFor(() => expect(supervisor.register).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(db.collection("installationBindings").getAll()).toEqual([]);
  });

  /** Binding lives with the identity, folded until opened. */
  // The record and its binding live under Advanced settings.
  const openIdentity = async (user: ReturnType<typeof userEvent.setup>, detail: HTMLElement) =>
    user.click(
      within(detail).getByRole("button", {
        name: new RegExp(`^${en["lab.tools.advanced"]}`),
      }),
    );

  it("binds and unbinds an installation registered before bindings existed", async () => {
    mount({}, [registered()]);
    const user = userEvent.setup();
    const detail = await screen.findByRole("region", { name: "nmap 7.95.0.0" });
    await openIdentity(user, detail);

    // Nothing is inferred from the name "nmap".
    expect(catalogSelect(detail)).toHaveValue("");
    expect(db.collection("installationBindings").getAll()).toEqual([]);

    await user.selectOptions(catalogSelect(detail), "nmap");
    expect(db.collection("installationBindings").get(registered().id)).toMatchObject({
      catalogId: "nmap",
      installationId: registered().id,
    });

    await user.selectOptions(catalogSelect(detail), "");
    expect(db.collection("installationBindings").getAll()).toEqual([]);
  });

  it("drops the binding when the installation is removed", async () => {
    const supervisor = mount({ remove: vi.fn().mockResolvedValue(undefined) }, [registered()]);
    const user = userEvent.setup();
    const detail = await screen.findByRole("region", { name: "nmap 7.95.0.0" });
    await openIdentity(user, detail);
    await user.selectOptions(catalogSelect(detail), "nmap");

    await user.click(within(detail).getByRole("button", { name: en["action.remove"] }));

    await waitFor(() => expect(supervisor.remove).toHaveBeenCalledWith(registered().id));
    await waitFor(() => expect(db.collection("installationBindings").getAll()).toEqual([]));
  });
});
