import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import type { AuthorizationScope, ToolProfile } from "@/domain/lab";
import { ToolLabPanel } from "./ToolLabPanel";
import { Toasts } from "@/components/ui/Toasts";

/**
 * The Launch router. One Launch button on a tool profile routes by
 * the profile's `launchKind` — gui -> detached external process, interactive
 * -> a terminal tab, batch -> the existing supervised run path. These tests
 * exercise the real routing decision, not just that a mock exists.
 */

const INSTALLATION_ID = "installation-1";

function makeInstallation(): NativeToolInstallation {
  return {
    id: INSTALLATION_ID,
    displayName: "Test Tool",
    runner: "executable",
    canonicalPath: "C:\\Tools\\test-tool.exe",
    sha256: "a".repeat(64),
    sizeBytes: 2048,
    version: "1.0.0",
    publisher: "Acme",
    signatureState: "valid",
    category: "local",
    riskTier: "low",
    docUrl: "",
    tags: [],
    workingDir: "C:\\Tools",
    enabled: true,
    changedSinceVerify: false,
    createdAt: 1,
    updatedAt: 1,
    lastVerifiedAt: 1,
  };
}

function makeProfile(
  launchKind: ToolProfile["launchKind"],
  overrides: Partial<ToolProfile> = {},
): ToolProfile {
  return {
    id: "profile-1",
    installationId: INSTALLATION_ID,
    name: "Default profile",
    args: [
      {
        id: "arg-1",
        name: "Target",
        flag: "--target",
        type: "string",
        required: false,
        default: "",
        enumValues: [],
        repeatable: false,
        sensitive: false,
        help: "",
        order: 0,
      },
    ],
    values: { "arg-1": "example.com" },
    workingDir: "",
    allowedEnv: [],
    expectedOutputs: [],
    parser: "",
    timeoutSec: 300,
    concurrencyClass: "default",
    launchKind,
    requiresScope: false,
    favorite: false,
    demo: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function seedDb(profile: ToolProfile) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true });
  db.collection("toolProfiles").put(profile);
  setDbForTesting(db);
  return db;
}

function nativeBridge(overrides: Partial<DesktopBridge["toolSupervisor"]> = {}): {
  bridge: DesktopBridge;
  supervisor: DesktopBridge["toolSupervisor"];
} {
  const supervisor = {
    available: vi.fn().mockReturnValue(true),
    consentGranted: vi.fn().mockResolvedValue(true),
    requestGrant: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(undefined),
    locateCandidate: vi.fn(),
    register: vi.fn(),
    listInstallations: vi.fn().mockResolvedValue([makeInstallation()]),
    reverify: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    start: vi.fn().mockResolvedValue({ id: "run-1" }),
    cancel: vi.fn(),
    emergencyStop: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
    listActiveRuns: vi.fn().mockResolvedValue([]),
    deleteArtifacts: vi.fn(),
    onEvent: vi.fn().mockResolvedValue(() => {}),
    launchDetached: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as DesktopBridge["toolSupervisor"];

  const bridge = {
    mode: "tauri",
    toolSupervisor: supervisor,
    terminal: {
      available: () => true,
    },
    openPath: vi.fn(),
  } as unknown as DesktopBridge;

  return { bridge, supervisor };
}

function renderPanel(scope?: AuthorizationScope) {
  return render(
    <MemoryRouter initialEntries={["/lab"]}>
      {/* Toasts lives outside the swapped <Routes> subtree, matching
          AppShell (see src/app/AppShell.tsx), so it stays mounted across the
          /lab -> /terminal navigation the interactive route performs — the
          same reason the toast replaced the old panel-local notice. */}
      <Toasts />
      <Routes>
        <Route path="/lab" element={<ToolLabPanel targets={[]} scope={scope} />} />
        <Route
          path="/terminal"
          element={<div data-testid="terminal-route-marker">terminal</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function makeScope(overrides: Partial<AuthorizationScope> = {}): AuthorizationScope {
  return {
    id: "scope-1",
    engagementId: "engagement-1",
    ownerLabel: "",
    description: "",
    allowedTargets: ["example.com"],
    excludedTargets: [],
    authorizationRef: "",
    testerAck: true,
    notes: "",
    revision: 3,
    demo: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** The profile's one argument, typed as the target the scope judges. */
function targetArg(): ToolProfile["args"] {
  return [{ ...makeProfile("batch").args[0]!, type: "target" }];
}

/** Pre-seed the lab runtime store as already subscribed with one installation,
    so mount does not kick off a real native subscription (see labRuntime.ts
    `ensureSubscribed`, which no-ops once `subscribed` is true). */
function seedRuntime() {
  useLabRuntime.setState({
    available: true,
    ready: true,
    subscribed: true,
    installations: [makeInstallation()],
    runs: [],
    logs: {},
    clearedLogs: {},
    selectedRunId: null,
    error: "",
  });
}

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  useLabRuntime.setState({
    available: false,
    ready: false,
    subscribed: false,
    installations: [],
    runs: [],
    logs: {},
    clearedLogs: {},
    selectedRunId: null,
    error: "",
  });
  useTerminalTabs.setState({ tabs: [], activeId: null });
  // Toasts is a global zustand store, not scoped to a render tree: without
  // this reset, a success toast raised by one test (e.g. the gui-launched
  // case) would still be mounted -- and matched by a later test's
  // queryByText/findByText assertions -- for the 4s the store keeps it
  // around, well past the current test's lifetime.
  useUi.setState({ toasts: [], liveMessage: "" });
  vi.restoreAllMocks();
});

describe("ToolLabPanel Launch router", () => {
  it('launchKind "gui" opens the tool as a detached external process via supervisor.launchDetached', async () => {
    const profile = makeProfile("gui");
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(supervisor.launchDetached).toHaveBeenCalledWith(
        INSTALLATION_ID,
        ["--target", "example.com"],
      ),
    );
    // Batch's supervised path must not also fire.
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-route-marker")).toBeNull();
    // The success message is a global toast (not local panel state), since
    // the interactive route unmounts the panel before a local notice could
    // ever paint. Confirm it renders here too, for the route that doesn't
    // unmount.
    await screen.findByText("Opened Test Tool as an external app");
    // Let the launch's finally-block busy reset settle before the test tears
    // the tree down, so no state update lands outside of act().
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch" })).not.toBeDisabled(),
    );
  });

  it('launchKind "gui" shows the unavailable error and does not toast when launchDetached refuses with reason "browser_mode"', async () => {
    const profile = makeProfile("gui");
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge({
      launchDetached: vi.fn().mockResolvedValue({ ok: false, reason: "browser_mode" }),
    });
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(supervisor.launchDetached).toHaveBeenCalledWith(
        INSTALLATION_ID,
        ["--target", "example.com"],
      ),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This build cannot launch external tools.",
    );
    expect(screen.queryByText("Opened Test Tool as an external app")).toBeNull();
    expect(screen.queryByTestId("terminal-route-marker")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch" })).not.toBeDisabled(),
    );
  });

  it('launchKind "gui" renders a known refusal reason as translated text, never the raw Rust identifier', async () => {
    const profile = makeProfile("gui");
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge({
      launchDetached: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: "tool_identity_changed" }),
    });
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(supervisor.launchDetached).toHaveBeenCalledWith(
        INSTALLATION_ID,
        ["--target", "example.com"],
      ),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Test Tool's identity changed since it was last verified. Review and trust it before launching.",
    );
    // The raw Rust code must never reach the user as the visible message.
    expect(alert).not.toHaveTextContent("tool_identity_changed");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch" })).not.toBeDisabled(),
    );
  });

  it('launchKind "gui" falls back to a generic translated message for an unrecognized refusal reason, still visibly, never raw', async () => {
    const profile = makeProfile("gui");
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge({
      launchDetached: vi.fn().mockResolvedValue({
        ok: false,
        reason: "spawn_failed",
      }),
    });
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(supervisor.launchDetached).toHaveBeenCalledWith(
        INSTALLATION_ID,
        ["--target", "example.com"],
      ),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Couldn't launch Test Tool. Try again, or check its identity in the tool library.",
    );
    expect(alert).not.toHaveTextContent("spawn_failed");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch" })).not.toBeDisabled(),
    );
  });

  it('launchKind "interactive" opens a terminal tab for the tool and navigates to /terminal', async () => {
    const profile = makeProfile("interactive");
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);
    const openToolTab = vi.fn().mockReturnValue("tab-1");
    useTerminalTabs.setState({ openToolTab, tabs: [], activeId: null });
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Launch" }));

    // The interactive route must pass the installation id, never the
    // renderer-held `canonicalPath` or `workingDir` — both are resolved
    // server-side (terminal_open_tool -> resolve_launchable), the same
    // identity gate the batch and gui routes apply. A profile-level
    // `workingDir` override must not reach the bridge call.
    await waitFor(() =>
      expect(openToolTab).toHaveBeenCalledWith({
        installationId: INSTALLATION_ID,
        args: ["--target", "example.com"],
        title: "Test Tool",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("terminal-route-marker")).toBeInTheDocument(),
    );
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.launchDetached).not.toHaveBeenCalled();
    // The toast must survive the navigation to /terminal: the old
    // panel-local "notice" state was set immediately before navigating away,
    // so it unmounted with the panel before it could ever paint, making it
    // structurally untestable. Asserting the toast *after* the route-marker
    // assertion above proves it is still visible once the panel is gone —
    // asserting it before navigation would not prove that.
    //
    // This message is deliberately an in-progress claim, not a
    // completion claim. `openToolTab` only pushes a tab synchronously; the
    // PTY itself is created later when that tab mounts, so a toast that says
    // "Opened" here would be true before the launch is actually known to
    // have succeeded. Wording it as "Opening... " keeps the toast honest
    // regardless of whether the PTY creation that follows succeeds or fails.
    const notice = await screen.findByText("Opening Test Tool in a terminal tab…");
    // The kind must match the wording: "info", not "success" -- the launch
    // has not yet resolved to an outcome when this toast is raised.
    expect(notice.closest(".toast")).toHaveClass("toast--info");
  });

  // No further settle-wait is needed here: once the route swap lands, the
  // panel that owned the pending `finally { setBusy("") }` is unmounted, and
  // React discards that update rather than applying it outside act().

  it('launchKind "batch" runs the tool through the existing supervised path via supervisor.start', async () => {
    const profile = makeProfile("batch");
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(supervisor.start).toHaveBeenCalledWith(
        expect.objectContaining({
          installationId: INSTALLATION_ID,
          argv: ["--target", "example.com"],
        }),
      ),
    );
    expect(supervisor.launchDetached).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-route-marker")).toBeNull();
    // Let the run's own busy reset settle before teardown.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch" })).not.toBeDisabled(),
    );
  });

  it("never launches a scoped setting that has no target field, and offers to add one", async () => {
    const profile = makeProfile("gui", { requiresScope: true });
    const db = seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel(makeScope());

    const launch = await screen.findByRole("button", { name: "Launch" });
    expect(launch).toBeDisabled();
    expect(screen.getByText("Add a target field to run it inside the scope.")).toBeInTheDocument();
    await user.click(launch);
    expect(supervisor.launchDetached).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add a target field" }));
    await waitFor(() =>
      expect(db.collection("toolProfiles").get(profile.id)!.args.at(-1)).toMatchObject({
        name: "Target",
        type: "target",
        required: true,
      }),
    );
  });

  it("applies the scope gate before every launch: no scope means no launch", async () => {
    const profile = makeProfile("gui", { requiresScope: true, args: targetArg() });
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);

    // No `scope` prop: the engagement has none, so even a named target stays
    // blocked, and the card says why before anything is clicked.
    renderPanel();

    expect(await screen.findByRole("button", { name: "Launch" })).toBeDisabled();
    expect(screen.getByTestId("lab-tool-verdict")).toHaveTextContent("Blocked · no scope");
    expect(screen.getByText("The scope does not allow this target.")).toBeInTheDocument();
    expect(supervisor.launchDetached).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it("runs a target the scope allows, with the scope decision attached to the run", async () => {
    const profile = makeProfile("batch", { requiresScope: true, args: targetArg() });
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);
    const user = userEvent.setup();

    renderPanel(makeScope());

    expect(screen.getByTestId("lab-tool-verdict")).toHaveTextContent("Allowed · in scope");
    await user.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(supervisor.start).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: ["--target", "example.com"],
          requiresScope: true,
          scope: expect.objectContaining({
            scopeId: "scope-1",
            scopeRevision: 3,
            target: "example.com",
            allowed: true,
            reason: "allowed_in_scope",
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch" })).not.toBeDisabled(),
    );
  });

  it("refuses a target outside the scope and says so in words", async () => {
    const profile = makeProfile("gui", {
      requiresScope: true,
      args: targetArg(),
      values: { "arg-1": "elsewhere.example.org" },
    });
    seedDb(profile);
    seedRuntime();
    const { bridge, supervisor } = nativeBridge();
    setBridgeForTesting(bridge);

    renderPanel(makeScope());

    expect(await screen.findByRole("button", { name: "Launch" })).toBeDisabled();
    expect(screen.getByTestId("lab-tool-verdict")).toHaveTextContent("Blocked · out of scope");
    expect(screen.getByTestId("lab-tool-verdict")).not.toHaveTextContent("out_of_scope");
    expect(supervisor.launchDetached).not.toHaveBeenCalled();
  });
});

describe("ToolLabPanel run card", () => {
  it("fills a setting's arguments in on the card and shows the exact command", async () => {
    const profile = makeProfile("batch");
    seedDb(profile);
    seedRuntime();
    setBridgeForTesting(nativeBridge().bridge);
    const user = userEvent.setup();

    renderPanel();

    const field = await screen.findByLabelText(/^Target/);
    expect(field).toHaveValue("example.com");
    await user.clear(field);
    await user.type(field, "10.0.0.5");
    expect(screen.getByText('"Test Tool" --target 10.0.0.5')).toBeInTheDocument();
    expect(
      screen.getByText("Runs in the background; its output is kept with this investigation's runs."),
    ).toBeInTheDocument();
  });

  it("says why a value is refused in words, not in codes", async () => {
    const profile = makeProfile("batch", {
      args: [{ ...makeProfile("batch").args[0]!, name: "Ports", type: "port_range" }],
      values: { "arg-1": "80,99999" },
    });
    seedDb(profile);
    seedRuntime();
    setBridgeForTesting(nativeBridge().bridge);

    renderPanel();

    expect(await screen.findByText("Ports: ports go up to 65535.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(screen.getByText("Fix the fields listed above.")).toBeInTheDocument();
  });

  it("names an empty required field in the hint instead of listing it as a mistake", async () => {
    seedDb(
      makeProfile("batch", {
        args: [{ ...makeProfile("batch").args[0]!, name: "Message", required: true }],
        values: {},
      }),
    );
    seedRuntime();
    setBridgeForTesting(nativeBridge().bridge);

    renderPanel();

    expect(await screen.findByText("Fill in: Message.")).toBeInTheDocument();
    expect(screen.queryByText("Message is required.")).toBeNull();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("keeps identity and the argument editor folded until asked for", async () => {
    seedDb(makeProfile("batch"));
    seedRuntime();
    setBridgeForTesting(nativeBridge().bridge);
    const user = userEvent.setup();

    renderPanel();

    await screen.findByRole("button", { name: "Launch" });
    expect(screen.queryByRole("button", { name: "Add argument" })).toBeNull();
    expect(screen.queryByText("a".repeat(64))).toBeNull();

    // One fold holds the record and the argument editor.
    await user.click(screen.getByRole("button", { name: /^Advanced settings/ }));
    expect(screen.getByRole("button", { name: "Add argument" })).toBeInTheDocument();
    // Argument types read as words.
    expect(screen.getByRole("option", { name: "Ports" })).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("C:\\Tools\\test-tool.exe")).toBeInTheDocument();
    expect(screen.getByText("Signed, valid")).toBeInTheDocument();
  });

  it("offers a default setting to a tool that has none, with a target field when it must stay in scope", async () => {
    const db = new Database(new MemoryStorageAdapter());
    db.prefs.set({ privateToolsEnabled: true });
    setDbForTesting(db);
    useLabRuntime.setState({
      available: true,
      ready: true,
      subscribed: true,
      installations: [{ ...makeInstallation(), category: "network" }],
      runs: [],
      logs: {},
      clearedLogs: {},
      selectedRunId: null,
      error: "",
    });
    setBridgeForTesting(nativeBridge().bridge);
    const user = userEvent.setup();

    renderPanel(makeScope());

    expect(await screen.findByText(/This tool has no run setting yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Create a default setting" }));

    expect(db.collection("toolProfiles").getAll()).toEqual([
      expect.objectContaining({
        name: "Test Tool default",
        requiresScope: true,
        args: [expect.objectContaining({ name: "Target", type: "target", flag: "", required: true })],
      }),
    ]);
    expect(await screen.findByLabelText(/^Target/)).toBeInTheDocument();
    expect(screen.getByText("Pick a target to run it against.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("finds a tool among many and shows each one's state in words", async () => {
    seedDb(makeProfile("batch"));
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...makeInstallation(),
      id: `installation-${i + 1}`,
      displayName: i === 3 ? "Nmap" : `Tool ${i + 1}`,
      riskTier: "medium" as const,
      enabled: i !== 5,
    }));
    useLabRuntime.setState({
      available: true,
      ready: true,
      subscribed: true,
      installations: many,
      runs: [],
      logs: {},
      clearedLogs: {},
      selectedRunId: null,
      error: "",
    });
    setBridgeForTesting(nativeBridge().bridge);
    const user = userEvent.setup();

    renderPanel();

    const list = await screen.findByRole("complementary", { name: "Registered tools" });
    expect(within(list).getAllByRole("button")).toHaveLength(8);
    expect(
      within(list).getByRole("button", { name: /Tool 6.*Disabled/ }),
    ).toBeInTheDocument();
    expect(within(list).queryByText(/medium|network/)).toBeNull();

    await user.type(within(list).getByLabelText("Find a tool"), "nmap");
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    await user.click(within(list).getByRole("button", { name: /Nmap/ }));
    // The heading carries the version beside the name.
    expect(await screen.findByRole("heading", { level: 3, name: /^Nmap/ })).toBeInTheDocument();
  });

  it("opens a tool whose file changed with the reason in view and the run blocked", async () => {
    seedDb(makeProfile("batch"));
    useLabRuntime.setState({
      available: true,
      ready: true,
      subscribed: true,
      installations: [
        { ...makeInstallation(), canonicalPath: "\\\\?\\C:\\Tools\\test-tool.exe", changedSinceVerify: true },
      ],
      runs: [],
      logs: {},
      clearedLogs: {},
      selectedRunId: null,
      error: "",
    });
    setBridgeForTesting(nativeBridge().bridge);

    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByRole("button", { name: "Launch" })).toBeDisabled();
    expect(
      screen.getByText(
        "The file changed since it was checked. Check it again or trust the new file under Status.",
      ),
    ).toBeInTheDocument();
    // The state and its fix come before the run, without opening anything.
    expect(screen.getByTestId("wb-status")).toHaveTextContent("File changed");
    expect(screen.getByRole("button", { name: /Trust the new file/ })).toBeInTheDocument();
    // The record, with the verbatim prefix gone from the path, is under Advanced.
    await user.click(screen.getByRole("button", { name: /^Advanced settings/ }));
    expect(screen.getByText("C:\\Tools\\test-tool.exe")).toBeInTheDocument();
  });
});
