import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import type { NativeDetectedTool, NativeToolInstallation } from "@/lib/bridge/types";
import { registerDeferredCopy } from "@/lib/i18n";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { useLabRuntime } from "@/state/labRuntime";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { useUi } from "@/state/ui";
import { toolLogos } from "@/lib/toolLogos";
import { useFetchedLogos } from "./logos/fetchedLogos";
import { ToolLauncher } from "./ToolLauncher";

/* Araç kutusu (the toolbox). Every row does something: a
   ready program opens through the native identity check or runs in an
   investigation, a changed or disabled one is reviewed, a suggested
   registration is linked, and one that is not registered can be located or
   fetched from its download page. */

registerDeferredCopy("en", deferredEn);

const NMAP = "tool-6c0d2f9a-1e7b-4c35-8a92-d4b1f03e7c58";
const ZAP = "tool-f47e2b90-58c1-4d6a-a3e7-1c9d05b8f2aa";
const GHIDRA = "tool-0b8e61d4-3a2f-4f7c-9e15-7d2ac4b09e36";
const OWN = "tool-5a1c7e20-9b3d-4e8f-a6c2-0d4f81b7e953";

function installation(
  id: string,
  displayName: string,
  overrides: Partial<NativeToolInstallation> = {},
): NativeToolInstallation {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `\\\\?\\C:\\Program Files\\${displayName}\\${displayName.toLowerCase()}.exe`,
    sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
    sizeBytes: 2_977_792,
    version: "",
    publisher: "",
    signatureState: "valid",
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

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

/** The page owns the search, shared with the built-in tools. */
function Harness() {
  const [query, setQuery] = useState("");
  return <ToolLauncher query={query} onQueryChange={setQuery} />;
}

interface MountOptions {
  engagement?: { id: string; title: string };
  installations?: NativeToolInstallation[];
  bound?: Array<[catalogId: string, installationId: string]>;
  available?: boolean;
  ready?: boolean;
  launchDetached?: ReturnType<typeof vi.fn>;
  /** What the scan of the computer finds. */
  detected?: NativeDetectedTool[];
  /** The registrations a refresh reads, once the scan registered something. */
  refreshTo?: NativeToolInstallation[];
}

function mount({
  engagement,
  installations = [],
  bound = [],
  available = true,
  ready = true,
  launchDetached = vi.fn().mockResolvedValue({ ok: true }),
  detected = [],
  refreshTo,
}: MountOptions = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true });
  for (const [catalogId, installationId] of bound) {
    db.collection("installationBindings").put({
      id: installationId,
      catalogId,
      installationId,
      confirmedAt: 1_790_800_100_000,
    });
  }
  if (engagement) {
    db.collection("engagements").put({
      ...engagement,
      status: "active",
      createdAt: 1_790_800_000_000,
      updatedAt: 1_790_800_000_000,
    } as never);
  }
  setDbForTesting(db);
  const supervisor = {
    available: () => available,
    launchDetached,
    locateCandidate: vi.fn().mockResolvedValue(null),
    register: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    detectInstallations: vi.fn().mockResolvedValue(detected),
  };
  const openUrl = vi.fn().mockResolvedValue(undefined);
  setBridgeForTesting({
    mode: available ? "tauri" : "browser",
    toolSupervisor: supervisor,
    terminal: { available: () => available },
    openUrl,
  } as unknown as DesktopBridge);
  const refresh = vi.fn().mockImplementation(async () => {
    if (refreshTo) useLabRuntime.setState({ installations: refreshTo });
  });
  useLabRuntime.setState({
    available,
    ready,
    readFailed: false,
    subscribed: true,
    installations,
    runs: [],
    refresh,
    ensureSubscribed: vi.fn(),
  });
  render(
    <MemoryRouter initialEntries={["/tools"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Harness />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { supervisor, openUrl, refresh };
}

const tile = (name: string) => screen.getByRole("listitem", { name });
const spoken = { ignore: '[aria-hidden="true"] *, script, style' };

const realState = useLabRuntime.getState();

afterEach(() => {
  useLabRuntime.setState(realState, true);
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });
  useUi.setState({ toasts: [] });
  useFetchedLogos.setState({ byId: {}, pending: {} });
  setDbForTesting(null);
  resetBridgeForTesting();
  vi.restoreAllMocks();
});

describe("Tool launcher", () => {
  it("counts registered programs from Rust's records", () => {
    mount({ installations: [installation(NMAP, "Nmap"), installation(ZAP, "ZAP")] });
    expect(screen.getByText("2 registered · identity checked at launch")).toBeInTheDocument();
  });

  it("opens a registered command-line program in a terminal tab", async () => {
    mount({ installations: [installation(NMAP, "Nmap")], bound: [["nmap", NMAP]] });
    const nmap = tile("Nmap");
    expect(within(nmap).getByText("Ready", spoken)).toBeInTheDocument();

    await userEvent.click(within(nmap).getByRole("button", { name: "Open in app" }));

    expect(useTerminalTabs.getState().tabs).toEqual([
      expect.objectContaining({
        title: "Nmap",
        spec: { kind: "tool", installationId: NMAP, args: [] },
      }),
    ]);
    expect(screen.getByTestId("where")).toHaveTextContent("/terminal");
  });

  it("opens a registered GUI program in its own window through the native launch", async () => {
    const { supervisor } = mount({
      installations: [installation(ZAP, "ZAP")],
      bound: [["zap", ZAP]],
    });

    await userEvent.click(within(tile("OWASP ZAP")).getByRole("button", { name: "Open" }));

    expect(supervisor.launchDetached).toHaveBeenCalledWith(ZAP, []);
    await waitFor(() =>
      expect(useUi.getState().toasts.map((t) => t.messageKey)).toEqual(["lab.tools.launchedGui"]),
    );
    expect(within(tile("OWASP ZAP")).queryByRole("button", { name: "Open in app" })).toBeNull();
  });

  it("says why a launch was refused and re-reads the registrations", async () => {
    const { refresh } = mount({
      installations: [installation(ZAP, "ZAP")],
      bound: [["zap", ZAP]],
      launchDetached: vi.fn().mockResolvedValue({ ok: false, reason: "tool_identity_changed" }),
    });

    await userEvent.click(within(tile("OWASP ZAP")).getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "OWASP ZAP's identity changed since it was last verified.",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("sends a changed program to the Lab for review instead of launching it", () => {
    mount({
      installations: [installation(GHIDRA, "Ghidra", { changedSinceVerify: true })],
      bound: [["ghidra", GHIDRA]],
    });
    const ghidra = tile("Ghidra");

    expect(within(ghidra).getByText("Needs a look", spoken)).toBeInTheDocument();
    expect(
      within(ghidra).getByText("The file changed since it was checked. Review it before use."),
    ).toBeInTheDocument();
    expect(within(ghidra).queryByRole("button", { name: "Open" })).toBeNull();
    expect(
      within(ghidra).getByRole("link", { name: "Review in Registered tools" }),
    ).toHaveAttribute("href", `/tools?view=registered&tool=${GHIDRA}`);
  });

  it("offers Locate and the download page for a program that is not registered", async () => {
    const { supervisor, openUrl } = mount();
    const burp = tile("Burp Suite");

    expect(within(burp).getByText("Not registered", spoken)).toBeInTheDocument();
    await userEvent.click(within(burp).getByRole("button", { name: "Download page" }));
    expect(openUrl).toHaveBeenCalledWith("https://portswigger.net/burp/communitydownload");

    await userEvent.click(within(burp).getByRole("button", { name: "Locate…" }));
    expect(supervisor.locateCandidate).toHaveBeenCalled();
  });

  it("links a registration made before bindings existed, on the user's click", async () => {
    mount({ installations: [installation(GHIDRA, "Ghidra 12.1.2")] });
    const ghidra = tile("Ghidra");

    expect(within(ghidra).getByText("Not linked", spoken)).toBeInTheDocument();
    expect(within(ghidra).queryByRole("button", { name: "Download page" })).toBeNull();
    await userEvent.click(within(ghidra).getByRole("button", { name: "Link Ghidra 12.1.2" }));

    expect(getDb().collection("installationBindings").getAll()).toEqual([
      expect.objectContaining({ installationId: GHIDRA, catalogId: "ghidra" }),
    ]);
    expect(await within(tile("Ghidra")).findByText("Ready", spoken)).toBeInTheDocument();
  });

  it("looks for the programs when the toolbox opens, skipping those already linked", async () => {
    const { supervisor } = mount({
      installations: [installation(NMAP, "Nmap")],
      bound: [["nmap", NMAP]],
    });
    await waitFor(() => expect(supervisor.detectInstallations).toHaveBeenCalledTimes(1));
    const skipped = supervisor.detectInstallations.mock.calls[0]![0] as string[];
    expect(skipped).toEqual(["nmap"]);
  });

  it("registers and links a program the scan found, with the same register call as a picked file", async () => {
    const zap = installation(ZAP, "ZAP");
    const { supervisor } = mount({
      refreshTo: [zap],
      detected: [
        {
          catalogId: "zap",
          source: "program_files",
          fileName: "ZAP.exe",
          canonicalPath: "C:\\Program Files\\ZAP\\Zed Attack Proxy\\ZAP.exe",
          registeredId: null,
          located: {
            token: "cand-1",
            workingDir: "C:\\Program Files\\ZAP",
            candidate: {
              canonicalPath: "C:\\Program Files\\ZAP\\Zed Attack Proxy\\ZAP.exe",
              fileName: "ZAP.exe",
              sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
              sizeBytes: 1,
              version: "",
              publisher: "",
              signatureState: "valid",
            },
          },
        },
      ],
    });
    supervisor.register.mockResolvedValue(zap);

    // The program moves from the waiting list to the ready one: ask again.
    await waitFor(() =>
      expect(within(tile("OWASP ZAP")).getByText("Ready", spoken)).toBeInTheDocument(),
    );
    expect(supervisor.register).toHaveBeenCalledWith(
      expect.objectContaining({ candidateToken: "cand-1", confirmed: true, category: "web" }),
    );
    expect(getDb().collection("installationBindings").getAll()).toEqual([
      expect.objectContaining({ catalogId: "zap", installationId: ZAP, source: "detected" }),
    ]);
    expect(useUi.getState().toasts.map((t) => t.messageKey)).toContain("launcher.autolinked");
  });

  it("scans again on request and says when nothing is new", async () => {
    const { supervisor } = mount();
    await waitFor(() => expect(supervisor.detectInstallations).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Scan again" }));

    await waitFor(() => expect(supervisor.detectInstallations).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useUi.getState().toasts.map((t) => t.messageKey)).toContain("launcher.rescanNothing"),
    );
  });

  it("shows a link whose file is gone as Not found, not ready, with Locate again and Remove", async () => {
    const { supervisor } = mount({
      installations: [installation(NMAP, "Burp fixture", { fileMissing: true })],
      bound: [["burp", NMAP]],
    });
    const burp = tile("Burp Suite");

    expect(within(burp).getByText("Not found", spoken)).toBeInTheDocument();
    expect(within(burp).queryByRole("button", { name: "Open" })).toBeNull();
    expect(within(burp).getByRole("button", { name: "Locate again…" })).toBeInTheDocument();
    const legend = screen.getByRole("group", { name: "Filter by status" });
    expect(within(legend).getByRole("button", { name: /^Ready\s*0$/ })).toBeInTheDocument();
    expect(within(legend).getByRole("button", { name: /^Needs a look\s*1$/ })).toBeInTheDocument();

    await userEvent.click(within(burp).getByRole("button", { name: "Remove the link" }));

    expect(supervisor.remove).toHaveBeenCalledWith(NMAP);
    expect(getDb().collection("installationBindings").getAll()).toEqual([]);
  });

  it("locating a gone program again starts the picker for that program", async () => {
    const { supervisor } = mount({
      installations: [installation(NMAP, "Burp fixture", { fileMissing: true })],
      bound: [["burp", NMAP]],
    });

    await userEvent.click(
      within(tile("Burp Suite")).getByRole("button", { name: "Locate again…" }),
    );

    expect(supervisor.locateCandidate).toHaveBeenCalled();
  });

  it("explains running elevated as a manual step with the registered file", async () => {
    mount({ installations: [installation(NMAP, "Nmap")], bound: [["nmap", NMAP]] });

    await userEvent.click(within(tile("Nmap")).getByRole("button", { name: "Admin instructions" }));

    const dialog = await screen.findByRole("dialog", { name: "Run Nmap as administrator" });
    expect(within(dialog).getByText('"C:\\Program Files\\Nmap\\nmap.exe"')).toBeInTheDocument();
    expect(
      within(dialog).getByText("Qutra Labs does not start, record or check a run you start this way."),
    ).toBeInTheDocument();
  });

  it("narrows the grid by category and by a filter that has a visible label", async () => {
    mount();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Web" }));
    const names = screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-labelledby"));
    expect(names).toContain("tool-tile-zap");
    expect(names).not.toContain("tool-tile-nmap");

    await user.click(screen.getByRole("button", { name: /^All · 35$/ }));
    await user.type(screen.getByLabelText("Filter tools"), "ghid");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(tile("Ghidra")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Filter tools"), "zzz");
    expect(screen.getByText("No tool matches “ghidzzz”.")).toBeInTheDocument();
  });

  it("in the browser build offers download pages only, and says why", () => {
    mount({ available: false });
    expect(screen.getByTestId("launcher-browser-notice")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Locate…" })).toBeNull();
    expect(within(tile("Nmap")).getByRole("button", { name: "Download page" })).toBeInTheDocument();
  });

  it("does not claim Not registered before the first read of the registrations", () => {
    mount({ ready: false });
    expect(within(tile("Nmap")).getByText("Checking…", spoken)).toBeInTheDocument();
    expect(screen.queryByText("Not registered")).toBeNull();
    expect(screen.queryByRole("button", { name: "Locate…" })).toBeNull();
  });

  it("shows how much of the kit is ready and filters the lists by it", async () => {
    mount({
      installations: [installation(NMAP, "Nmap"), installation(GHIDRA, "Ghidra 12.1.2")],
      bound: [["nmap", NMAP]],
    });
    const legend = screen.getByRole("group", { name: "Filter by status" });
    expect(within(legend).getByRole("button", { name: /^Ready\s*1$/ })).toBeInTheDocument();
    expect(within(legend).getByRole("button", { name: /^Not linked\s*1$/ })).toBeInTheDocument();

    await userEvent.click(within(legend).getByRole("button", { name: /^Ready/ }));
    expect(screen.getAllByTestId("tool-tile")).toHaveLength(1);
    expect(tile("Nmap")).toBeInTheDocument();
    expect(within(legend).getByRole("button", { name: /^Ready/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("links every unambiguous suggestion in one confirmed step", async () => {
    mount({
      installations: [installation(GHIDRA, "Ghidra 12.1.2"), installation(NMAP, "Nmap 7.95")],
    });

    await userEvent.click(screen.getByRole("button", { name: "Link 2 suggested" }));
    const dialog = await screen.findByRole("dialog", { name: "Link suggested registrations" });
    expect(within(dialog).getByText("Ghidra 12.1.2")).toBeInTheDocument();
    expect(getDb().collection("installationBindings").getAll()).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Link 2" }));
    expect(
      getDb()
        .collection("installationBindings")
        .getAll()
        .map((b) => b.catalogId)
        .sort(),
    ).toEqual(["ghidra", "nmap"]);
    expect(await within(tile("Nmap")).findByText("Ready", spoken)).toBeInTheDocument();
  });

  it("runs a ready program in the investigation worked on last", () => {
    mount({
      engagement: { id: "eng-1", title: "Acme web test" },
      installations: [installation(NMAP, "Nmap")],
      bound: [["nmap", NMAP]],
    });
    const run = within(tile("Nmap")).getByRole("link", { name: "Run in investigation" });
    expect(run).toHaveAttribute("href", `/tools?view=registered&e=eng-1&tool=${NMAP}`);
    expect(run).toHaveAttribute(
      "title",
      "Opens Registered tools with this program selected, for “Acme web test”.",
    );
  });

  it("opens a program's guide in place, with the way on to the Catalog", async () => {
    mount();
    await userEvent.click(within(tile("Nmap")).getByRole("button", { name: "Guide" }));
    const dialog = await screen.findByRole("dialog", { name: "Nmap guide" });
    expect(within(dialog).getByRole("link", { name: "Open in Catalog" })).toHaveAttribute(
      "href",
      "/tools?view=catalog&tool=nmap",
    );
    expect(within(dialog).getByRole("button", { name: "Official page" })).toBeInTheDocument();
  });

  it("shows the bundled official logo and keeps the letter tile where there is none", () => {
    mount();
    expect(tile("Nmap").querySelector("img")?.getAttribute("src")).toMatch(/nmap\.png/);
    expect(tile("TShark").querySelector("img")?.getAttribute("src")).toMatch(/wireshark\.png/);
    const masscan = tile("Masscan");
    expect(masscan.querySelector("img")).toBeNull();
    expect(masscan.querySelector(".tlogo--letter")).toHaveTextContent("M");
  });

  it("keeps the user's own programs apart and fetches their logos only when asked", async () => {
    const list = vi.spyOn(toolLogos, "list").mockResolvedValue([]);
    const fetch = vi.spyOn(toolLogos, "fetch").mockResolvedValue({
      installationId: OWN,
      state: "found",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      source: "https://acme.example.org/favicon.ico",
      plate: "none",
    });
    mount({
      installations: [
        installation(OWN, "Acme Scanner", { docUrl: "https://acme.example.org/docs" }),
      ],
    });
    await waitFor(() => expect(list).toHaveBeenCalledWith([OWN]));
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("Your other registered programs"));
    const own = screen.getByRole("listitem", { name: "Acme Scanner" });
    expect(own.querySelector(".tlogo--letter")).toHaveTextContent("A");
    expect(screen.getByText(/acme\.example\.org/)).toBeInTheDocument();

    act(() => {
      getDb().prefs.set({ toolLogoFetch: false });
    });
    expect(screen.queryByRole("button", { name: "Find logos (1)" })).toBeNull();
    act(() => {
      getDb().prefs.set({ toolLogoFetch: true });
    });

    await userEvent.click(screen.getByRole("button", { name: "Find logos (1)" }));
    expect(fetch).toHaveBeenCalledWith(OWN);
    await waitFor(() =>
      expect(own.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/),
    );
  });
});
