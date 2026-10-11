import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { getBridge, resetBridgeForTesting } from "@/lib/bridge";
import { WorkspaceSchema, type Preferences } from "@/domain/types";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { resetRuntime, run, seedRuntime } from "@/test/labFixtures";
import { TopBar } from "@/app/TopBar";
import { useRunCommand } from "@/app/useRunCommand";
import { PALETTE_TARGETS } from "@/app/commands";
import { ContextPanel } from "./ContextPanel";
import { useShortcuts } from "@/app/useShortcuts";

/* One right-hand context panel replaces the Inspector
   and the bottom panel. Ctrl+B or the top-bar toggle; four segments that never
   hide; pushes the surface on wide windows and overlays at 1100 px and below. */

const T = 1_759_300_000_000;

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

/** The app's one key handler (Ctrl+B among its bindings). */
function Shortcuts() {
  useShortcuts();
  return null;
}

function renderPanel(prefs: Partial<Preferences> = {}, width = 1440) {
  window.innerWidth = width;
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(prefs);
  setDbForTesting(db);
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TopBar />
              <Shortcuts />
              <main>
                <button type="button">In the surface</button>
              </main>
              <ContextPanel />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const panel = () => screen.queryByRole("complementary", { name: "Context" });
const toggle = () => screen.getByRole("button", { name: "Context panel" });
const ctrlB = () => fireEvent.keyDown(window, { key: "b", ctrlKey: true });
const where = () => screen.getByTestId("where").textContent;

function project(overrides: Record<string, unknown> = {}) {
  const ws = WorkspaceSchema.parse({
    id: "ws-1",
    name: "qutra-app",
    color: "#37d6e0",
    purpose: "Desktop app for local security work.",
    type: "software",
    status: "active",
    localPath: "C:\\src\\qutra-app",
    createdAt: T,
    updatedAt: T,
    lastActivityAt: T,
    ...overrides,
  });
  getDb().collection("workspaces").put(ws);
  return ws;
}

const toastKeys = () => useUi.getState().toasts.map((toast) => toast.messageKey);

beforeEach(() => {
  useUi.setState({ activeWorkspaceId: null, toasts: [] });
});

const realRefresh = useLabRuntime.getState().refresh;

afterEach(() => {
  resetRuntime();
  useLabRuntime.setState({ refresh: realRefresh });
  resetBridgeForTesting();
});

describe("Context panel", () => {
  it("is closed until asked for, and the toggle says so", () => {
    renderPanel();
    expect(panel()).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(toggle()).toHaveAttribute("aria-keyshortcuts", "Control+B");
  });

  it("Ctrl+B opens it on the last segment and closes it again", () => {
    renderPanel({ contextPanelSegment: "files" });
    act(() => ctrlB());
    expect(panel()).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    act(() => ctrlB());
    expect(panel()).toBeNull();
  });

  it("always shows the four segments", () => {
    renderPanel({ contextPanelOpen: true });
    expect(
      within(panel()!).getAllByRole("tab").map((tab) => tab.textContent),
    ).toEqual(["Project", "Files", "Repo", "Runs output"]);
  });

  it("remembers the segment you chose", async () => {
    renderPanel({ contextPanelOpen: true });
    await userEvent.click(screen.getByRole("tab", { name: "Repo" }));
    expect(getDb().prefs.get().contextPanelSegment).toBe("repo");
    expect(screen.getByRole("tabpanel", { name: "Repo" })).toBeInTheDocument();
  });

  it("lets the keyboard reach the segment body so a long one can scroll", async () => {
    renderPanel({ contextPanelOpen: true });
    await userEvent.click(screen.getByRole("tab", { name: "Repo" }));
    await userEvent.tab();
    expect(screen.getByRole("tabpanel", { name: "Repo" })).toHaveFocus();
  });

  it("Escape closes it and returns focus to where it was", async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(toggle());
    expect(panel()).not.toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(toggle()).toHaveFocus();
  });

  it("pushes the surface on a wide window", () => {
    renderPanel({ contextPanelOpen: true }, 1440);
    expect(panel()).toHaveAttribute("data-mode", "push");
    expect(screen.queryByTestId("context-backdrop")).toBeNull();
  });

  it("overlays at 1100 px and below and closes on a click outside", () => {
    renderPanel({ contextPanelOpen: true }, 1100);
    expect(panel()).toHaveAttribute("data-mode", "overlay");
    fireEvent.click(screen.getByTestId("context-backdrop"));
    expect(panel()).toBeNull();
  });

  it("switches form when the window is resized", () => {
    renderPanel({ contextPanelOpen: true }, 1440);
    act(() => {
      window.innerWidth = 1000;
      window.dispatchEvent(new Event("resize"));
    });
    expect(panel()).toHaveAttribute("data-mode", "overlay");
  });

  /* The overlay covers the surface, so keyboard focus must not
     sit behind it. The top bar stays visible and live; Escape from it closes
     the overlay like Escape inside it. */
  it("closes the overlay on Escape pressed in the top bar", async () => {
    renderPanel({}, 1100);
    const user = userEvent.setup();
    await user.click(toggle());
    expect(panel()).toHaveAttribute("data-mode", "overlay");
    toggle().focus();
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
  });

  it("leaves the push form open on Escape outside it", async () => {
    renderPanel({ contextPanelOpen: true }, 1440);
    screen.getByRole("button", { name: "In the surface" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(panel()).not.toBeNull();
  });

  it("brings focus inside when a resize turns it into an overlay", () => {
    renderPanel({ contextPanelOpen: true }, 1440);
    screen.getByRole("button", { name: "In the surface" }).focus();
    act(() => {
      window.innerWidth = 1000;
      window.dispatchEvent(new Event("resize"));
    });
    expect(panel()!.contains(document.activeElement)).toBe(true);
  });

  it("keeps its width within 320–480 px", () => {
    renderPanel({ contextPanelOpen: true, contextPanelWidth: 9999 });
    expect(panel()).toHaveStyle({ width: "480px" });
    const grip = screen.getByRole("separator", { name: "Resize context panel" });
    expect(grip).toHaveAttribute("aria-valuemin", "320");
    expect(grip).toHaveAttribute("aria-valuemax", "480");
  });
});

describe("Toggle context panel (palette action)", () => {
  it("opens and closes the panel like Ctrl+B", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const { result } = renderHook(() => useRunCommand(), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    });
    act(() => result.current("toggle-context-panel"));
    expect(getDb().prefs.get().contextPanelOpen).toBe(true);
    act(() => result.current("toggle-context-panel"));
    expect(getDb().prefs.get().contextPanelOpen).toBe(false);
  });

  it("is listed among the palette's actions", () => {
    expect(PALETTE_TARGETS.find((p) => p.action === "toggle-context-panel")?.group).toBe(
      "actions",
    );
  });
});

describe("Runs output segment", () => {
  it("says why it is empty and offers Runs", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    expect(screen.getByText("No run selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Runs" }));
    expect(where()).toBe("/lab?view=runs");
  });

  it("shows the selected run, stops it, and holds evidence until it ends", async () => {
    const live = run({
      engagementId: "eng-1",
      state: "running",
      argv: ["-sV", "192.168.56.101"],
      startedAt: T,
      stdoutTail: "Starting Nmap",
    });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([live], live.id));
    const cancel = vi
      .spyOn(getBridge().toolSupervisor, "cancel")
      .mockResolvedValue(undefined as never);

    const body = screen.getByRole("tabpanel", { name: "Runs output" });
    expect(within(body).getByText("Nmap")).toBeInTheDocument();
    expect(within(body).getByText("-sV 192.168.56.101")).toBeInTheDocument();
    expect(within(body).getByText("C:\\Tools\\Nmap\\nmap.exe")).toBeInTheDocument();
    expect(within(body).getByText("Starting Nmap")).toBeInTheDocument();

    const save = within(body).getByRole("button", { name: "Save output as evidence" });
    expect(save).toBeDisabled();
    expect(within(body).getByText("Available when the run ends")).toBeVisible();

    await userEvent.click(within(body).getByRole("button", { name: "Stop" }));
    expect(cancel).toHaveBeenCalledWith(live.id);

    await userEvent.click(within(body).getByRole("button", { name: "Go to run" }));
    expect(where()).toBe("/lab?e=eng-1&view=runs");
  });

  it("saves a finished run's output as evidence", async () => {
    const done = run({ engagementId: "eng-1", state: "succeeded", stdoutTail: "22/tcp open" });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([done], done.id));
    await userEvent.click(screen.getByRole("button", { name: "Save output as evidence" }));
    await vi.waitFor(() =>
      expect(getDb().collection("evidence").getAll()).toHaveLength(1),
    );
    expect(getDb().collection("evidence").getAll()[0]?.engagementId).toBe("eng-1");
  });

  it("lists problems and opens one's output", async () => {
    const failed = run({ state: "failed", commandPreview: "semgrep scan", terminationReason: "exit 2" });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([failed]));
    await userEvent.click(screen.getByRole("tab", { name: /Problems/ }));
    await userEvent.click(screen.getByRole("button", { name: /semgrep scan/ }));
    expect(useLabRuntime.getState().selectedRunId).toBe(failed.id);
    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the audit trail", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    getDb().collection("events").put({
      id: "e1",
      type: "permission_changed",
      at: T,
      label: "Private Lab enabled",
      detail: "",
      minutes: 0,
      demo: false,
    });
    await userEvent.click(screen.getByRole("tab", { name: "Audit" }));
    expect(screen.getByText("Private Lab enabled")).toBeInTheDocument();
  });

  it("copies the output and says so only once the copy succeeded", async () => {
    const done = run({ state: "succeeded", stdoutTail: "22/tcp open" });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([done], done.id));
    const copy = vi.spyOn(getBridge(), "writeClipboard").mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith("stdout: 22/tcp open");
    await vi.waitFor(() => expect(toastKeys()).toEqual(["panel.copied"]));
  });

  /* Every output action reports what actually happened. */
  it("says the copy failed when the clipboard refuses it", async () => {
    const done = run({ state: "succeeded", stdoutTail: "22/tcp open" });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([done], done.id));
    vi.spyOn(getBridge(), "writeClipboard").mockRejectedValue(new Error("denied"));
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(toastKeys()).toEqual(["ctx.runs.copyFailed"]));
  });

  it("says the copy failed when the clipboard reports no success", async () => {
    const done = run({ state: "succeeded", stdoutTail: "22/tcp open" });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([done], done.id));
    vi.spyOn(getBridge(), "writeClipboard").mockResolvedValue({ ok: false });
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(toastKeys()).toEqual(["ctx.runs.copyFailed"]));
  });

  it("says a refused stop failed and re-reads the runs", async () => {
    const live = run({ state: "running", startedAt: T });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([live], live.id));
    vi.spyOn(getBridge().toolSupervisor, "cancel").mockRejectedValue(new Error("not running"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    useLabRuntime.setState({ refresh });
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(toastKeys()).toEqual(["ctx.runs.stopFailed"]));
    expect(useUi.getState().toasts[0]?.params).toEqual({ tool: "Nmap" });
    expect(refresh).toHaveBeenCalled();
  });

  it("says an artifact could not be opened", async () => {
    const done = run({
      state: "succeeded",
      artifacts: [{ kind: "stdout", path: "C:\\runs\\a\\stdout.txt", sizeBytes: 12, truncated: false }],
    });
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "runs" });
    act(() => seedRuntime([done], done.id));
    vi.spyOn(getBridge(), "capabilities").mockReturnValue({
      ...getBridge().capabilities(),
      openPath: { available: true, simulated: false },
    } as never);
    vi.spyOn(getBridge(), "openPath").mockRejectedValue(new Error("gone"));
    await userEvent.click(screen.getByRole("button", { name: /stdout · 12 B/ }));
    await vi.waitFor(() => expect(toastKeys()).toEqual(["files.openFailed"]));
  });
});

describe("Project segment", () => {
  it("says there is no project yet and where to make one", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "project" });
    expect(screen.getByText("No project yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open projects" }));
    expect(where()).toBe("/workspaces");
  });

  it("shows the active project with its path and open tasks", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "project" });
    act(() => {
      project();
      project({ id: "ws-2", name: "notes", lastActivityAt: T - 1 });
      getDb().collection("tasks").put({
        id: "t1",
        title: "Keyboard test for Ctrl+B",
        workspaceId: "ws-1",
        status: "todo",
        createdAt: T,
        updatedAt: T,
      } as never);
    });
    const body = screen.getByRole("tabpanel", { name: "Project" });
    const picker = within(body).getByRole("combobox", { name: "Active project" });
    expect(picker).toHaveValue("ws-1");
    expect(within(body).getByText("C:\\src\\qutra-app")).toBeInTheDocument();
    expect(within(body).getByText("Keyboard test for Ctrl+B")).toBeInTheDocument();

    await userEvent.selectOptions(picker, "ws-2");
    expect(useUi.getState().activeWorkspaceId).toBe("ws-2");
  });

  it("starts a session and captures a snapshot for that project", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "project" });
    act(() => {
      project();
    });
    await userEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Files segment", () => {
  it("lists the paths linked to the active project and adds one", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "files" });
    act(() => {
      project();
      getDb().collection("resources").put({
        id: "r1",
        kind: "file",
        title: "DESIGN.md",
        target: "C:\\src\\qutra-app\\DESIGN.md",
        workspaceId: "ws-1",
        tags: [],
        demo: false,
        createdAt: T,
      });
      getDb().collection("resources").put({
        id: "r2",
        kind: "file",
        title: "other.md",
        target: "C:\\elsewhere\\other.md",
        workspaceId: "ws-other",
        tags: [],
        demo: false,
        createdAt: T,
      });
    });
    const body = screen.getByRole("tabpanel", { name: "Files" });
    expect(within(body).getByText("DESIGN.md")).toBeInTheDocument();
    expect(within(body).queryByText("other.md")).toBeNull();

    await userEvent.type(
      within(body).getByRole("textbox", { name: "Add path" }),
      "C:\\src\\qutra-app\\notes.md",
    );
    await userEvent.click(within(body).getByRole("button", { name: "Add" }));
    const added = getDb()
      .collection("resources")
      .getAll()
      .find((r) => r.target === "C:\\src\\qutra-app\\notes.md");
    expect(added?.workspaceId).toBe("ws-1");
  });

  it("filters by name or path", async () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "files" });
    act(() => {
      project();
      for (const [id, title] of [["r1", "DESIGN.md"], ["r2", "README.md"]]) {
        getDb().collection("resources").put({
          id: id!,
          kind: "file",
          title: title!,
          target: `C:\\src\\qutra-app\\${title}`,
          workspaceId: "ws-1",
          tags: [],
          demo: false,
          createdAt: T,
        });
      }
    });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search files" }), "read");
    expect(screen.queryByText("DESIGN.md")).toBeNull();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });
});

describe("Repo segment", () => {
  it("shows the project's Git summary and recent commits", () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "repo" });
    act(() => {
      project({
        git: {
          connected: true,
          branch: "main",
          dirtyFiles: 3,
          ahead: 1,
          behind: 0,
          lastCommits: [
            { hash: "9f3c2a1d", message: "Lab: views as a segmented control", author: "Samil", at: T },
          ],
        },
      });
    });
    const body = screen.getByRole("tabpanel", { name: "Repo" });
    expect(within(body).getByText("main")).toBeInTheDocument();
    expect(within(body).getByText("1 ahead · 0 behind")).toBeInTheDocument();
    expect(within(body).getByText("Lab: views as a segmented control")).toBeInTheDocument();
  });

  it("says when the project folder is not a Git repository", () => {
    renderPanel({ contextPanelOpen: true, contextPanelSegment: "repo" });
    act(() => {
      project();
    });
    expect(screen.getByText("No Git repository in this project")).toBeInTheDocument();
  });
});
