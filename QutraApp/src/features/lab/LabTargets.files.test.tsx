import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

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
import type { InvestigationFile } from "@/lib/investigationFiles";
import { createEngagement } from "@/services/appService";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { useUi } from "@/state/ui";
import { LabTargets } from "./LabTargets";

/* "Targets and files" lists an investigation's files and targets,
   and the selected one's card. Rust is mocked at `invoke`. */

const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const FOLDER = "C:\\Users\\me\\Documents\\Qutra Labs\\Home lab";

let engagementId = "";
const openPath = vi.fn(async () => ({ ok: true, simulated: false }));

function file(over: Partial<InvestigationFile>): InvestigationFile {
  return {
    id: "file_photo",
    engagementId,
    relPath: "files/photo.jpg",
    name: "photo.jpg",
    originalName: "photo.jpg",
    bytes: 5_033_165,
    sha256: SHA256,
    sha1: "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
    md5: "098f6bcd4621d373cade4e832627b4f6",
    kind: "jpeg",
    sample: false,
    source: "picked",
    addedAt: 1_759_300_000_000,
    missing: false,
    readOnly: true,
    ...over,
  };
}

const photo = () => file({});
const tool = () =>
  file({
    id: "file_tool",
    relPath: "files/tool.exe.sample",
    name: "tool.exe.sample",
    originalName: "tool.exe",
    bytes: 2048,
    sha256: "b".repeat(64),
    kind: "pe",
    sample: true,
    source: "dropped",
    addedAt: 1_759_300_100_000,
  });

function rust(
  folder: { path: string; exists: boolean } | null,
  files: InvestigationFile[],
  picked: unknown[] = [],
) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "engagement_folder_get") return folder;
    if (command === "investigation_files_list") return files;
    if (command === "investigation_files_pick") return picked;
    // A selected file's card shows its suggested analysis.
    if (command === "analysis_analyzers" || command === "analysis_list") return [];
    throw new Error(`unexpected ${command}`);
  });
}

function Where() {
  const { search } = useLocation();
  return <output data-testid="where">{search}</output>;
}

function renderTargets(search = "") {
  const db = getDb();
  const engagement = db.collection("engagements").get(engagementId)!;
  const scope = db.collection("authorizationScopes").get(engagement.scopeId!)!;
  const targets = db
    .collection("targets")
    .getAll()
    .filter((tg) => tg.engagementId === engagementId);
  return render(
    <MemoryRouter initialEntries={[`/lab?e=${engagementId}&view=targets${search}`]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LabTargets engagement={engagement} scope={scope} targets={targets} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const item = () =>
  new URLSearchParams(screen.getByTestId("where").textContent ?? "").get("item");

beforeEach(() => {
  invoke.mockReset();
  openPath.mockClear();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  engagementId = createEngagement("Home lab");
  getDb().collection("targets").put({
    id: "tg-1",
    engagementId,
    raw: "127.0.0.1",
    normalized: "127.0.0.1",
    kind: "ip",
    scopeState: "in_scope",
    notes: "",
    demo: false,
    createdAt: 1,
    updatedAt: 1,
  });
  useInvestigationFiles.setState({ byEngagement: {}, loadState: {}, dropTarget: null, dragOver: false });
  useUi.setState({ toasts: [] });
  setBridgeForTesting({ mode: "tauri", openPath } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("targets and files", () => {
  it("lists the files and targets, and a selected file shows its card", async () => {
    rust({ path: FOLDER, exists: true }, [photo(), tool()]);
    renderTargets();

    const files = await screen.findByRole("region", { name: /^Files/ });
    expect(within(files).getAllByRole("listitem")).toHaveLength(2);
    expect(within(files).getByText("2")).toBeInTheDocument();
    const targets = screen.getByRole("region", { name: /^Targets/ });
    expect(within(targets).getAllByText("127.0.0.1").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "File" })).not.toBeInTheDocument();

    await userEvent.click(within(files).getByRole("button", { name: /photo\.jpg/ }));

    const detail = screen.getByRole("region", { name: "File" });
    expect(within(detail).getByText("photo.jpg")).toBeInTheDocument();
    const card = within(detail).getByTestId("lab-file-card");
    expect(within(card).getByText("JPEG image")).toBeInTheDocument();
    expect(within(card).getByText("4.8 MB")).toBeInTheDocument();
    expect(within(card).getByText(SHA256)).toBeInTheDocument();
    expect(within(card).getByText("files\\photo.jpg")).toBeInTheDocument();
    expect(within(card).getByText("This is a read-only copy. Your original file was not changed.")).toBeInTheDocument();
    expect(within(card).queryByText(/\.sample/)).not.toBeInTheDocument();
    expect(item()).toBe("file:file_photo");
  });

  it("says a program was stored as a sample and names the file it came from", async () => {
    rust({ path: FOLDER, exists: true }, [photo(), tool()]);
    renderTargets("&item=file:file_tool");

    const detail = await screen.findByRole("region", { name: "File" });
    expect(within(detail).getByText("tool.exe.sample")).toBeInTheDocument();
    const card = within(detail).getByTestId("lab-file-card");
    expect(within(card).getByText("Windows program (PE)")).toBeInTheDocument();
    expect(within(card).getByText("tool.exe")).toBeInTheDocument();
    expect(within(card).getByText(/its name ends in \.sample/)).toBeInTheDocument();
  });

  it("copies a hash and opens the files folder", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    rust({ path: FOLDER, exists: true }, [photo()]);
    renderTargets("&item=file:file_photo");

    const card = await screen.findByTestId("lab-file-card");
    await userEvent.click(within(card).getByRole("button", { name: "Copy SHA-256" }));
    expect(writeText).toHaveBeenCalledWith(SHA256);
    expect(useUi.getState().toasts.map((toast) => toast.messageKey)).toContain("lab.files.copied");

    await userEvent.click(within(card).getByRole("button", { name: "Open the files folder" }));
    expect(openPath).toHaveBeenCalledWith(`${FOLDER}\\files`);
  });

  it("adds files from the picker and shows the one it copied", async () => {
    const added = file({ id: "file_new", name: "capture.pcap", relPath: "files/capture.pcap", kind: "pcap" });
    rust({ path: FOLDER, exists: true }, [], [{ outcome: "added", file: added }]);
    renderTargets();

    await userEvent.click(await screen.findByRole("button", { name: "Add files" }));

    expect(invoke).toHaveBeenCalledWith("investigation_files_pick", {
      engagementId,
      title: "Add files to the investigation",
    });
    const detail = await screen.findByRole("region", { name: "File" });
    expect(within(detail).getByText("capture.pcap")).toBeInTheDocument();
    expect(item()).toBe("file:file_new");
    expect(useUi.getState().toasts.map((toast) => toast.messageKey)).toContain("lab.files.added");
  });

  it("says when a copy has gone from the folder", async () => {
    rust({ path: FOLDER, exists: true }, [file({ missing: true, readOnly: false })]);
    renderTargets("&item=file:file_photo");

    const files = await screen.findByRole("region", { name: /^Files/ });
    expect(within(files).getByText(/missing/)).toBeInTheDocument();
    const card = within(screen.getByRole("region", { name: "File" })).getByTestId("lab-file-card");
    expect(
      within(card).getByText(
        "This copy is no longer in the investigation's folder. Add the file again to bring it back.",
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByText(/read-only copy/)).not.toBeInTheDocument();
  });

  it("shows a direction mark in the original name instead of obeying it", async () => {
    const mark = String.fromCharCode(0x202e);
    rust({ path: FOLDER, exists: true }, [
      file({ name: "invoice gnp.exe.sample", originalName: `invoice${mark}gnp.exe`, kind: "pe", sample: true }),
    ]);
    renderTargets("&item=file:file_photo");

    const card = await screen.findByTestId("lab-file-card");
    expect(within(card).getByText("invoice⟨U+202E⟩gnp.exe")).toBeInTheDocument();
  });

  it("keeps the user where they went while a large pick copies", async () => {
    let finish!: (outcomes: unknown[]) => void;
    const added = file({ id: "file_big", name: "capture.pcap", relPath: "files/capture.pcap", kind: "pcap" });
    invoke.mockImplementation(async (command: string) => {
      if (command === "engagement_folder_get") return { path: FOLDER, exists: true };
      if (command === "investigation_files_list") return [];
      if (command === "investigation_files_pick")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (command === "analysis_analyzers" || command === "analysis_list") return [];
      throw new Error(`unexpected ${command}`);
    });
    const view = renderTargets();

    const add = await screen.findByRole("button", { name: "Add files" });
    await userEvent.click(add);
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveFocus();
    view.unmount();
    await act(async () => finish([{ outcome: "added", file: added }]));

    // The user is elsewhere by now, so the toast names where the file went.
    const toast = useUi.getState().toasts.find((entry) => entry.messageKey === "lab.files.addedTo");
    expect(toast?.actionKey).toBe("lab.files.show");
    expect(toast?.params).toMatchObject({ count: 1 });
  });

  it("asks for the investigation's folder before files can be added", async () => {
    rust(null, []);
    renderTargets();

    expect(
      await screen.findByText("Files are copied into the investigation's folder. Create it first."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add files" })).not.toBeInTheDocument();
  });

  it("says adding files needs the desktop app in the browser build", () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    renderTargets();

    expect(screen.getByText("Adding files works in the desktop app.")).toBeInTheDocument();
    expect(screen.getByLabelText("Add target", { selector: "input" })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("starts a file investigation on its first step: adding the file", async () => {
    rust({ path: FOLDER, exists: true }, []);
    renderTargets("&add=file");

    expect(await screen.findByText("First step: add the file you want to examine.")).toBeInTheDocument();
    const add = await screen.findByRole("button", { name: "Add files" });
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("drops the first step once the investigation has a file", async () => {
    rust({ path: FOLDER, exists: true }, [photo()]);
    renderTargets("&add=file");

    await screen.findByRole("button", { name: /photo\.jpg/ });
    expect(screen.queryByText("First step: add the file you want to examine.")).not.toBeInTheDocument();
  });
});
